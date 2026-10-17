#!/bin/bash
set -euo pipefail
HOST="${1:?host}"
URL="${2:?url}"
OUTFILE="${3:?outfile}"
TMP="$(mktemp)"
osascript > "$TMP" <<APPLESCRIPT
tell application "Arc"
  set theTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "$HOST" then
        set theTab to t
        exit repeat
      end if
    end repeat
    if theTab is not missing value then exit repeat
  end repeat
  if theTab is missing value then return "NOT_FOUND"
  set URL of theTab to "$URL"
  select theTab
  delay 2.8
  set n to 0
  repeat while (loading of theTab is true) and n < 20
    delay 0.4
    set n to n + 1
  end repeat
  delay 1.0
  return execute theTab javascript "JSON.stringify({title:document.title,url:location.href,bodyTextLen:(document.body&&document.body.innerText||'').length,html:document.documentElement.outerHTML})"
end tell
APPLESCRIPT
if grep -qx 'NOT_FOUND' "$TMP"; then
  echo "NOT_FOUND tab for $HOST" >&2
  rm -f "$TMP"
  exit 1
fi
/usr/bin/python3 - "$TMP" "$OUTFILE" <<'PY'
import json,sys
raw=open(sys.argv[1],encoding='utf-8').read().strip()
d=json.loads(raw)
if isinstance(d,str):
  d=json.loads(d)
meta=f"<!-- {d['url']} | {d['title']} | body={d['bodyTextLen']} -->\n"
open(sys.argv[2],'w',encoding='utf-8').write(meta+d['html'])
print(f"{d['title']}\tbody={d['bodyTextLen']}\thtml={len(d['html'])}")
PY
rm -f "$TMP"
