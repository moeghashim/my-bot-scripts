# msg-graph

Local viewer for how many messages you send to your Grok Bot assistants. It shows a daily heatmap, a weekday rhythm, weekly bars stacked by bot, and a ranked list. Click a bot (in the list or the legend) to filter everything to it. Headline stats: total, avg/day, avg/week, busiest day, current streak.

Single `index.html`, React + htm from a CDN, no build step.

```bash
cd msg-graph
python3 -m http.server 47821   # then open http://localhost:47821
```

Copy `config.example.json` to `config.json` (gitignored) to mark group chats and channels.

Opening `index.html` via `file://` also works, but the browser blocks auto-loading `data/index.json` and `config.json` there, so drop the JSON files on the page by hand.

## Controls

- **Account:** Personal, Work, any other account found in loaded files, and All. All sums every account; bots with the same name are merged into one row with account badges (P/W). Untick *Merge same-name bots* to keep them apart.
- **Kind:** All, Bots, or Groups (group chats plus channels). Groups and channels get a rounded tile, a glyph, and a badge.
- **Load:** pick files, or drop them anywhere. A later file for the same account overrides earlier ones date by date.
- The light/dark toggle defaults to the system setting.

## Data

`data/index.json` lists the files to auto-load, e.g. `["personal.json", "work.json"]`.

```json
{"account": "personal", "generatedAt": "…", "timezone": "America/Los_Angeles",
 "bots": {"<id>": {"name": "Coder"}, "<id2>": {"name": "team-chat", "kind": "group"}},
 "days": [{"date": "2026-08-12", "byBot": {"Coder": 8, "team-chat": 2}}]}
```

`kind` is optional (`bot` | `group` | `channel`; the default is `bot`). Optional `members: [names]` renders a group as stacked member avatars.

`config.json` holds kind overrides for known groups, keyed by bot id (or exact name). They take precedence over the JSON.

`data/sample-work.json` is **fake** data for testing. Every other `data/*.json` is gitignored and stays local.

## Avatars

Put `avatars/<name-slug>.png` (or `.jpg`/`.webp`) here, e.g. `avatars/coder.png` or `avatars/team-chat.png`. The slug is the name lowercased, with non-alphanumerics replaced by `-`. Anything without a file gets a colored initial (bots) or a glyph tile (groups and channels). `avatars/` is gitignored.

## Exporting

`export_grokbot_messages.py` (stdlib only, opens SQLite read-only) builds an account file from a Grok Bot box's `search-index.db`. It counts human-authored user messages only:
- bot-to-bot messages are dropped
- iMessage relays are attributed to "iMessage relay" (kind `channel`)
- near-duplicates within 10 minutes are deduped
- days are in `MSG_GRAPH_TZ` (default America/Los_Angeles)

The same script runs unchanged on another account's box:

```bash
python3 export_grokbot_messages.py --account personal --out data/personal.json
python3 export_grokbot_messages.py --account work --out data/work.json [--db /path/to/search-index.db]
```

It emits `kind` from `config.json` overrides (`--config`, default: next to the script), then from explicit `profile.json` fields (`kind`/`type`, `isGroup`, `members`/`participants`). Otherwise it leaves `kind` out.
