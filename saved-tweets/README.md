# Saved Tweets rewrite (Notion API)

Rewrites Saved Tweet page bodies to a consistent format using the **Notion public API** (not MCP markdown `<embed>`):

1. **paragraph** — `Author: @handle` with `@handle` linked to `https://x.com/handle`
2. **embed** — native embed block with the status URL
3. **quote** — full tweet text
4. **images** — image blocks (external `pbs.twimg` by default; optional `--host-images`)
5. **videos** — Notion-hosted via `/v1/file_uploads` `mode=external_url` from FxTwitter mp4 when possible; else external video block

## Auth

```bash
export NOTION_API_TOKEN=...            # or NOTION_ENV_FILE=/path/to/.env containing it
```

Never print or commit the token.

## Usage

```bash
python3 rewrite_tweets_ntn.py --only PAGEID          # smoke
python3 rewrite_tweets_ntn.py                        # full (host videos, external images)
python3 rewrite_tweets_ntn.py --limit 10 --offset 0
python3 rewrite_tweets_ntn.py --no-host-videos
python3 rewrite_tweets_ntn.py --host-images
```

Progress: `progress_ntn.json` (gitignored). To leave pages untouched (e.g. a hand-made reference page), set `SAVED_TWEETS_SKIP_PAGES` to comma-separated page ids.

## Inputs

- `candidates.json` — `{page_id, tweet_url, handle, status_id, notion_url}` (local, gitignored)
- `helpers.py` — `fetch_tweet`, `parse_status_url`
