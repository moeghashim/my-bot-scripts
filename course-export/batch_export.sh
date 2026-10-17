#!/bin/bash
set -euo pipefail
HOST="${1:?host}"
OUTDIR="${2:?outdir}"
URLS="${3:?urls file}"
SAVE="$(dirname "$0")/save_one.sh"
mkdir -p "$OUTDIR"
MANIFEST="$OUTDIR/manifest.jsonl"
README="$OUTDIR/README.md"
: > "$MANIFEST"
{
  echo "# Course export: $HOST"
  echo
  echo "Exported: $(date)"
  echo
  echo "| # | Title | File | URL | Body |"
  echo "|---|-------|------|-----|------|"
} > "$README"
n=0
while IFS= read -r URL; do
  [ -z "$URL" ] && continue
  n=$((n+1))
  slug=$(/usr/bin/python3 -c 'import re,sys,urllib.parse; p=urllib.parse.urlparse(sys.argv[1]).path.strip("/") or "index"; print(re.sub(r"[^a-zA-Z0-9._-]+","-",p).strip("-").lower()[:120])' "$URL")
  fname=$(printf '%03d-%s.html' "$n" "$slug")
  echo "[$n] $URL -> $fname"
  if ! "$SAVE" "$HOST" "$URL" "$OUTDIR/$fname"; then
    echo "  FAIL $URL" | tee -a "$OUTDIR/failures.txt"
    continue
  fi
  # append manifest/readme from file comment + size
  /usr/bin/python3 - "$OUTDIR/$fname" "$MANIFEST" "$README" "$n" "$URL" "$fname" <<'PY'
import json,sys,re,os
path,manifest,readme,n,url,fname=sys.argv[1:7]
text=open(path,encoding='utf-8',errors='ignore').read(500)
m=re.match(r'<!--\s*(.*?)\s*\|\s*(.*?)\s*\|\s*body=(\d+)\s*-->', text)
title=m.group(2) if m else 'unknown'
body=int(m.group(3)) if m else -1
size=os.path.getsize(path)
row={"n":int(n),"title":title,"url":url,"file":fname,"bodyTextLen":body,"htmlLen":size}
open(manifest,"a",encoding="utf-8").write(json.dumps(row,ensure_ascii=False)+"\n")
open(readme,"a",encoding="utf-8").write(f"| {n} | {title.replace('|','\\|')} | `{fname}` | {url} | {body} |\n")
print("  ok", title, body)
PY
done < "$URLS"

/usr/bin/python3 - "$OUTDIR" <<'PY'
import json,os,sys,html
outdir=sys.argv[1]
rows=[]
man=os.path.join(outdir,'manifest.jsonl')
if os.path.exists(man):
  for line in open(man,encoding='utf-8'):
    if line.strip(): rows.append(json.loads(line))
parts=['<!doctype html><meta charset=utf-8><title>Course export index</title>',
'<style>body{font:14px/1.4 system-ui;max-width:960px;margin:2rem auto;padding:0 1rem} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left} a{color:#06c}</style>',
'<h1>Course export index</h1>', f'<p>{len(rows)} pages</p>',
'<table><tr><th>#</th><th>Title</th><th>File</th><th>URL</th><th>Body</th></tr>']
for r in rows:
  parts.append(f"<tr><td>{r['n']}</td><td>{html.escape(r.get('title') or '')}</td><td><a href='{html.escape(r['file'])}'>{html.escape(r['file'])}</a></td><td><a href='{html.escape(r.get('url') or '')}'>{html.escape(r.get('url') or '')}</a></td><td>{r.get('bodyTextLen')}</td></tr>")
parts.append('</table>')
open(os.path.join(outdir,'index.html'),'w',encoding='utf-8').write('\n'.join(parts))
print('index.html', len(rows))
PY
echo "DONE $n pages -> $OUTDIR"
