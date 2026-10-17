# capture-digest

Picks ~5 saved items (from a Notion "Saved" reading list export) for a periodic digest (short/medium/long mix, URL liveness checks).

Reads `DIGEST_IN` (default `/workspace/saved_candidates.json`, a JSON list of rows with `Name`, `Type`, `link`, `Date Added`, …) and writes `DIGEST_OUT` (default `/workspace/digest_pick.json`).

```bash
python3 pick_digest.py
```

Meant to be run by a scheduled bot routine.
