---
name: msg-graph
description: >-
  Use this when the user says /msg-graph or wants to see how many messages
  they've sent their Grok Bots: a GitHub-style heatmap, weekday rhythm, weekly
  bars, and a ranking by bot. It refreshes the counts on the bot's computer and
  opens the viewer on the user's Mac.
---
# /msg-graph

Two machines are involved:
- **The bot's computer (the box)** has the message index. The export runs there.
- **The user's Mac** runs the viewer, a static page served on `localhost:47821`.

The code lives in the public repo https://github.com/wustep/my-bot-scripts, folder `msg-graph/`.

## Steps
1. **Export on the bot's computer.** If `/workspace/my-bot-scripts` is missing, clone the repo there. Then run:
   `python3 /workspace/my-bot-scripts/msg-graph/export_grokbot_messages.py`
   It writes `/workspace/my-bot-scripts/msg-graph/data/messages.json` (use `--out` for another path) and prints `total=… days=… mode=… unchanged=0|1`. It reads `/home/box/agent-data/search-index.db` by default (`--db` to override) and keeps a cache next to the output, so later runs are fast.
2. **Copy to the Mac.** If the export printed `unchanged=1` and the Mac already has the data, skip this step. Otherwise:
   - The first time, ask the user where to keep the repo on their Mac (default `~/Projects/my-bot-scripts`) and clone it there.
   - Copy the JSON from the box to `<repo on Mac>/msg-graph/data/messages.json` with the tool that copies a file to the user's computer. If the tool drops it somewhere else (such as `~`), move it into place.
   - Make sure `<repo on Mac>/msg-graph/data/index.json` exists and lists the file: `["messages.json"]`.
3. **Start the viewer on the Mac** in the background, reusing it if it's already running:
   `lsof -ti tcp:47821 >/dev/null || (cd <repo on Mac>/msg-graph && nohup python3 -m http.server 47821 --bind 127.0.0.1 >/tmp/msg-graph.log 2>&1 &)`
4. **Open it:** `open http://localhost:47821`
5. **Report** that it's open, with the total from the export and today's count (the last day in `messages.json`).
6. **To stop it:** `lsof -ti tcp:47821 | xargs kill`

## Notes
- Only human-written messages are counted. Bot-to-bot messages are dropped, and near-duplicates within 10 minutes count once.
- Days use `MSG_GRAPH_TZ` (default `America/Los_Angeles`). Set it to the user's time zone when running the export.
- Exported data stays local: everything in `data/` except `sample.json` is gitignored. Never commit it.
- Optional: avatars go in `<repo on Mac>/msg-graph/avatars/<name-slug>.png`, and group chats can be marked in `<repo on Mac>/msg-graph/data/config.json` (copy `config.example.json`).
