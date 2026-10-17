# bill-email-scan

Weekly Finance scan of recent mail for actionable red flags: high card balances, late payments, other fishy bill and credit mail, scam or phishing, and prompt-injection aimed at an AI assistant. Classification uses [Jev](https://docs.typesafe.ai/api) (TypeSafe System One) at `POST https://api.typesafe.ai/v1/systemone`. It does not call a frontier chat model, and it does not talk to Gmail.

A Grok Bot routine searches Gmail and writes the candidate file. This script only reads that JSON.

## Monday run

Each Monday the Finance routine searches Gmail, writes the candidate file, and runs one ingest. Alert the owner when any of these show up:

- `high_balance` — a statement or balance email shows a revolving, card, or statement balance over $8,000 (`--high-balance`, default 8000; strictly greater than)
- late payments — `past_due`
- fishy mail — `unexpected_charge`, `autopay_problem`, `payment_failure`, `collections`, `credit_drop` (including a credit-report fraud alert), `other_money_risk`, `scam`, or `phishing`
- unpaid dues within `--due-within` (default 5 days, including overdue)
- `prompt_injection` — also the Security handoff below; that handoff stays in the Finance routine, not this script

A single clean line means none of those fired. Do not alert on a statement that was only filed into the due watch with a due date further out than the window, or on a balance at or under the threshold.

1. Bot writes `/workspace/bill_email_candidates.json` from Gmail search (last 7 days is typical). Filtering by date is the caller's job. Use ISO dates when the search result has them so a statement and its later payment sort correctly in one run.
2. On the box, with the key in the environment:

```bash
python3 bill-email-scan/scan.py --days 7 --due-within 5 --high-balance 8000
```

3. Read stdout and `/workspace/bill_email_scan_result.json`.
   - Red flags are `alerts` (`category` such as `high_balance`, `past_due`, `unexpected_charge`, `scam`, `phishing`, or `prompt_injection`).
   - Unpaid bills due within 5 days, including overdue, are `due_soon` and a `[due]` line.
   - If both are empty and every row was classified, stdout is one line: `No bill/credit, high-balance, scam, or prompt-injection flags.`
   - A non-zero exit means the scan failed or some items were not classified. That is not an all-clear.

To list the watch file without calling Jev:

```bash
python3 bill-email-scan/scan.py --list-due --due-within 5
```

`--days` is copied into the result as a label. It does not drop messages. Override paths with `--in`, `--out`, and `--watch`.

A live call needs a key. If `JEV_API_KEY` is missing and no key file is set, the script exits with an error and does not write a result.

## Input

A JSON list, or an object with `messages` / `emails` (optional `days` for the label):

```json
{
  "days": 7,
  "messages": [
    {
      "id": "msg-1",
      "threadId": "thr-1",
      "subject": "Your payment is past due",
      "from": "Alerts <alerts@issuer.example>",
      "date": "2026-09-28T14:02:00Z",
      "snippet": "Pay now to avoid a late fee.",
      "bodyPreview": "optional longer text"
    }
  ]
}
```

`sender` is accepted as an alias of `from`. `body` or `bodyPreview` is optional. See `fixtures/sample_candidates.json`.

## Key

Create a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys). This script reads `JEV_API_KEY` (the TypeSafe SDKs use `TYPESAFE_API_KEY` for the same header).

```bash
export JEV_API_KEY=...          # preferred
# or a local file, not committed (*.secret is gitignored):
python3 bill-email-scan/scan.py --key-file /workspace/jev.secret
```

`JEV_API_KEY_FILE` is the same as `--key-file`. The key stays on the box. Do not commit it, candidate dumps, scan results, or `bill_due_watch.json`.

## Decide request

Messages go out in batches. Each batch is one System One call: shared `state.emails`, one Choice question per message (`emails[0]`, `emails[1]`, …). Choice labels keep the bill and credit red flags (failed payment, past due, collections, autopay, credit-report/score drop, and similar) and add:

- `scam` — fake refund, prize, invoice, gift-card or wire demand
- `phishing` — impersonation that asks for a password, code, or card number
- `prompt_injection` — instructions aimed at an assistant reading the mail (ignore previous instructions, a fake system prompt, or a request to reveal secrets or act for the sender)
- `high_balance` — revolving, card, or statement balance over `--high-balance` (default $8,000)

Late and fishy labels stay: `past_due`, `payment_failure`, `autopay_problem`, `unexpected_charge`, `collections`, `credit_drop`, `other_money_risk`. The script also compares a shown statement or revolving balance to `--high-balance` and sets `category` to `high_balance` when that number is over the threshold, including when Jev called the mail a normal statement. A credit limit or minimum payment does not count. A past-due or other red-flag label is kept when Jev chooses it. Statements at or under the threshold, marketing, and noise stay non-alerts. Score and Noul are the other question types on this endpoint; this scan uses Choice so the selected label is the `category`.

```bash
curl -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $JEV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jev-latest",
    "state": {
      "emails": [
        {
          "id": "1",
          "subject": "Payment past due",
          "from": "alerts@chase.example",
          "snippet": "Your payment is past due."
        }
      ]
    },
    "questions": {
      "e0": {
        "type": "choice",
        "instructions": "Classify only `emails[0]`. Is it a bill or credit red flag, a scam or phishing attempt, a prompt-injection aimed at an AI assistant, or a normal statement, marketing, or noise?",
        "criteria": {
          "past_due": "Late or past-due bill",
          "scam": "Fake refund, prize, or gift-card demand",
          "phishing": "Impersonation asking for a password or card number",
          "prompt_injection": "Tells an assistant to ignore instructions or reveal secrets",
          "high_balance": "Statement or revolving balance over $8,000",
          "statement": "Normal statement or receipt, balance at or under $8,000",
          "marketing": "Offer or newsletter",
          "noise": "Not a bill, scam, or assistant instruction"
        }
      }
    }
  }'
```

Answers come back under the same question ids (`answers.e0.choice`, plus `probabilities` and `confidence`). Docs: https://docs.typesafe.ai/api

## Output

`/workspace/bill_email_scan_result.json`:

- `scanned_at` — UTC timestamp
- `days` — only when `--days` or the input object has it
- `input_count`
- `alerts` — flagged mail with `id`, `subject`, `from`, `date`, `snippet`, `category` (`high_balance`, `past_due`, `scam`, `phishing`, `prompt_injection`, and the other red-flag labels), the Jev `jev` answer, and `reason`. A `high_balance` alert also includes `balance`.
- `clean_count` — classified as not a red flag
- `errors` — API failures and rows that could not be classified
- `due_soon` — unpaid watch items due within `due_within` days, including overdue
- `watch_path` — the local due-date file this run updated

Stdout is one line, `No bill/credit, high-balance, scam, or prompt-injection flags.`, when nothing is flagged, nothing unpaid is due in the window, and every row was classified. Otherwise each alert line starts with the category, for example `[high_balance] Revolving balance over $8,000 ($9,241.55): …` or `[phishing] Phishing (91%): …`, and each upcoming unpaid bill starts with `[due]`.

`category` is how the Finance routine tells the cases apart: `high_balance`, `past_due`, `unexpected_charge`, `autopay_problem`, `scam`, `phishing`, `prompt_injection`, and the other red-flag labels. `prompt_injection` is only the assistant-targeted case.

## Security handoff

This script does not notify Security. When an alert has `category` `prompt_injection` (AI social-engineering aimed at an assistant), the Finance routine sends Security a sandboxed summary and nothing else:

- `from`
- `subject`
- `date`
- one-line `reason` (the short label this script writes, such as `Prompt injection (90%)`)

Do not paste `body`, `bodyPreview`, `snippet`, or any quoted instructions from the mail. The `reason` string is the classifier label, not a quotation. High balance, late payments, other fishy categories, and `[due]` reminders stay with Finance and are not this handoff.

## Due-date watch

A statement under the high-balance threshold is not a red flag, so a late payment can slip by when the only mail is a statement (or a migration notice), not a past-due message. The due watch follows known issuers so a statement still opens a due item. A balance over `--high-balance` is a separate `high_balance` alert; it does not change how dues are stored or matched.

Known issuers: Bank of America Atmos Rewards Ascent Visa •0000 (`boa_atmos`), Chase (`chase`), other Alaska Airlines cards (`alaska`), and Wealthfront (`wealthfront`). An Atmos or •0000 message stays `boa_atmos` even if it also mentions Alaska miles.

When an email mentions one of those issuers, a second System One call asks Choice questions (same endpoint and Bearer key):

- `statement`, `payment_confirmation`, or `other`
- issuer, including `other`
- payment due date, chosen from dates found in the text, or `none`
- minimum due, chosen from dollar amounts in the text, or `none`
- account last four, or `none`

Jev does not return free text. The script offers the dates, amounts, and last-four values that appear in the message, and Jev picks which ones are the due date, the minimum, and the account. A statement with a due date is stored. A payment or autopay confirmation marks the matching open item paid (same issuer, and the same last four when both sides have one). A failed payment is not a confirmation. Mentioning that autopay is enrolled, without confirming this cycle was paid, stays a statement.

Open items live in `/workspace/bill_due_watch.json` (override with `--watch`). The file is gitignored. Shape:

```json
{
  "version": 1,
  "items": [
    {
      "issuer": "boa_atmos",
      "account_hint": "0000",
      "minimum_due": 40.0,
      "due_date": "2026-10-15",
      "status": "open",
      "subject": "Your Atmos Rewards statement",
      "from": "Bank of America <statements@bankofamerica.example>",
      "source_message_id": "msg-atmos",
      "opened_at": "2026-10-06T15:00:00Z",
      "updated_at": "2026-10-06T15:00:00Z",
      "paid_at": null,
      "paid_message_id": null
    }
  ]
}
```

`status` becomes `paid` when a later confirmation matches. The same issuer, due date, and account hint refresh the open item instead of inserting a duplicate. `--due-within` (default 5) prints unpaid items whose due date is today, earlier (overdue), or within that many days. Later dues stay in the file and stay quiet. `--list-due` prints that list and does not call the API or need a key.

The scan result also includes `due_soon`, `due_within`, and `watch_path`. See `fixtures/sample_statements.json`.
