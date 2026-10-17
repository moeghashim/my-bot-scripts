# msg-graph

Local viewer for how many messages you send to your Grok Bot assistants. It shows a daily heatmap, a weekday rhythm, weekly bars stacked by bot, and a ranked list. Click a bot (in the list or the legend) to filter everything to it. Headline stats: total, avg/day, avg/week, busiest day, current streak.

Single `index.html`, React + htm from a CDN, no build step.

## Set this up with your Grok Bot

*For a bot reading this on the user's behalf.*

1. Read [`SKILL.md`](SKILL.md) in this folder and save it, as-is, as a new skill named `msg-graph` with your skill tool, so the user can run `/msg-graph`.
2. Then run it once. The skill does the rest:
   - The export runs on **your own computer (the box)**, where the message index lives (`/home/box/agent-data/search-index.db`).
   - The viewer runs on **the user's Mac**. You copy the exported JSON there and serve the page on `http://localhost:47821`.
3. The first time, ask the user where to clone this repo on their Mac (default `~/Projects/my-bot-scripts`).

## Run it by hand

```bash
cd msg-graph
python3 export_grokbot_messages.py          # on the box; writes data/messages.json
echo '["messages.json"]' > data/index.json
python3 -m http.server 47821 --bind 127.0.0.1   # then open http://localhost:47821
```

To try the viewer without exporting anything, serve the folder and click **Load fake sample**, or put `["sample.json"]` in `data/index.json`.

Copy `config.example.json` to `data/config.json` (gitignored) to mark group chats and channels.

You can also open `index.html` via `file://`, but the browser blocks auto-loading `data/index.json` and `data/config.json` there, so drop the JSON files on the page by hand.

## Controls

- **Kind:** All, Bots, or Groups (group chats plus channels). Groups and channels get a rounded tile, a glyph, and a badge.
- **Load:** pick files, or drop them anywhere. Multiple files are merged date by date; a later file overrides earlier ones for the same dates.
- The light/dark toggle defaults to the system setting.

## Data

`data/index.json` lists the files to auto-load, e.g. `["messages.json"]`.

```json
{"generatedAt": "…", "timezone": "America/Los_Angeles",
 "bots": {"<id>": {"name": "Coder"}, "<id2>": {"name": "team-chat", "kind": "group"}},
 "days": [{"date": "2026-08-12", "byBot": {"Coder": 8, "team-chat": 2}}]}
```

`kind` is optional (`bot` | `group` | `channel`; the default is `bot`). Optional `members: [names]` renders a group as stacked member avatars.

`data/config.json` holds kind overrides for known groups, keyed by bot id (or exact name). The viewer applies them on top of the JSON.

`data/sample.json` is **fake** data for testing. Every other `data/*.json` is gitignored and stays local.

## Avatars

Put `avatars/<name-slug>.png` (or `.jpg`/`.webp`) here, e.g. `avatars/coder.png` or `avatars/team-chat.png`. The slug is the name lowercased, with non-alphanumerics replaced by `-`. Anything without a file gets a colored initial (bots) or a glyph tile (groups and channels). Everything in `avatars/` except `.gitkeep` is gitignored.

## Exporting

`export_grokbot_messages.py` (stdlib only, opens SQLite read-only) builds the data file from a Grok Bot box's `search-index.db`. It counts human-authored user messages only:
- bot-to-bot messages are dropped
- iMessage relays are attributed to "iMessage relay" (kind `channel`)
- near-duplicates within 10 minutes are deduped
- days are in `MSG_GRAPH_TZ` (default America/Los_Angeles)

```bash
python3 export_grokbot_messages.py [--out data/messages.json] [--db /home/box/agent-data/search-index.db] [--full]
```

Past days are cached in `<out>.cache.json`, so reruns only rescan today. It prints `unchanged=1` when the counts match the existing output, so a caller can skip copying it again. `--full` ignores the cache.
