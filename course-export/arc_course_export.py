#!/usr/bin/env python3
"""Export Arc-logged-in course pages to HTML via AppleScript JS injection."""
import json, os, re, subprocess, sys, time, urllib.parse, html as htmlmod
from pathlib import Path

def osa(script: str) -> str:
    r = subprocess.run(['osascript'], input=script, text=True, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f'osascript failed: {r.stderr.strip() or r.stdout.strip()}')
    return (r.stdout or '').rstrip('\n')

def find_tab_meta(host: str) -> str:
    return osa(f'''
tell application "Arc"
  activate
  set theTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "{host}" then
        set theTab to t
        exit repeat
      end if
    end repeat
    if theTab is not missing value then exit repeat
  end repeat
  if theTab is missing value then return "NOT_FOUND"
  select theTab
  delay 0.8
  set js to "JSON.stringify({{title:document.title,url:location.href,htmlLen:document.documentElement.outerHTML.length,bodyTextLen:(document.body&&document.body.innerText||'').length}})"
  return execute theTab javascript js
end tell
''')

def navigate(host: str, url: str) -> str:
    # Escape quotes in URL for AppleScript
    u = url.replace('\\', '\\\\').replace('"', '\\"')
    return osa(f'''
tell application "Arc"
  set theTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "{host}" then
        set theTab to t
        exit repeat
      end if
    end repeat
    if theTab is not missing value then exit repeat
  end repeat
  if theTab is missing value then return "NOT_FOUND"
  set URL of theTab to "{u}"
  select theTab
  delay 2.5
  set n to 0
  repeat while (loading of theTab is true) and n < 20
    delay 0.5
    set n to n + 1
  end repeat
  delay 1.2
  return URL of theTab
end tell
''')

EXTRACT_JS = r'''(function(){function abs(h){try{return new URL(h,location.href).href}catch(e){return null}} var as=Array.from(document.querySelectorAll('a[href]')); var links=[]; var seen={}; for(var i=0;i<as.length;i++){var href=abs(as[i].getAttribute('href')); if(!href) continue; if(href.indexOf(location.origin)!==0) continue; href=href.split('#')[0]; if(seen[href]) continue; seen[href]=1; var t=(as[i].innerText||as[i].textContent||'').trim().replace(/\s+/g,' ').slice(0,160); links.push({href:href,text:t});} var html=document.documentElement.outerHTML; return JSON.stringify({title:document.title,url:location.href,html:html,bodyText:(document.body&&document.body.innerText||'').slice(0,500),bodyTextLen:(document.body&&document.body.innerText||'').length,links:links});})();'''

def extract(host: str) -> str:
    # Pass JS via AppleScript string; escape for AppleScript
    js = EXTRACT_JS.replace('\\', '\\\\').replace('"', '\\"')
    return osa(f'''
tell application "Arc"
  set theTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "{host}" then
        set theTab to t
        exit repeat
      end if
    end repeat
    if theTab is not missing value then exit repeat
  end repeat
  if theTab is missing value then return "NOT_FOUND"
  set js to "{js}"
  return execute theTab javascript js
end tell
''')

def slugify(url: str) -> str:
    path = urllib.parse.urlparse(url).path.strip('/') or 'index'
    s = re.sub(r'[^a-zA-Z0-9._-]+', '-', path).strip('-').lower()
    return (s[:120] or 'page')

def should_enqueue(href: str, host: str) -> bool:
    if not href or host not in href:
        return False
    href = href.split('#')[0]
    low = href.lower()
    skip_ext = ('.png','.jpg','.jpeg','.gif','.svg','.webp','.css','.js','.woff','.woff2','.pdf','.zip','.mp4')
    if any(low.endswith(e) for e in skip_ext):
        return False
    for x in ('/login','/signin','/signup','/logout','/account','/billing','/settings','/api/'):
        if x in low:
            return False
    return True

def write_index(outdir: Path, rows: list):
    parts = [
        '<!doctype html><meta charset=utf-8><title>Course export index</title>',
        '<style>body{font:14px/1.4 system-ui;max-width:960px;margin:2rem auto;padding:0 1rem} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left} a{color:#06c}</style>',
        '<h1>Course export index</h1>',
        f'<p>{len(rows)} pages</p>',
        '<table><tr><th>#</th><th>Title</th><th>File</th><th>URL</th><th>Body chars</th></tr>',
    ]
    for r in rows:
        parts.append(
            f"<tr><td>{r['n']}</td><td>{htmlmod.escape(r.get('title') or '')}</td>"
            f"<td><a href='{htmlmod.escape(r['file'])}'>{htmlmod.escape(r['file'])}</a></td>"
            f"<td><a href='{htmlmod.escape(r.get('url') or '')}'>{htmlmod.escape(r.get('url') or '')}</a></td>"
            f"<td>{r.get('bodyTextLen')}</td></tr>"
        )
    parts.append('</table>')
    (outdir / 'index.html').write_text('\n'.join(parts), encoding='utf-8')

def main():
    if len(sys.argv) < 3:
        print('Usage: arc_course_export.py <host-substring> <outdir> [max_pages]', file=sys.stderr)
        sys.exit(2)
    host = sys.argv[1]
    outdir = Path(sys.argv[2]).expanduser()
    max_pages = int(sys.argv[3]) if len(sys.argv) > 3 else 80
    outdir.mkdir(parents=True, exist_ok=True)
    manifest = outdir / 'manifest.jsonl'
    readme = outdir / 'README.md'
    queue_path = outdir / '.queue.txt'
    seen_path = outdir / '.seen.txt'
    manifest.write_text('', encoding='utf-8')

    meta = find_tab_meta(host)
    if meta == 'NOT_FOUND':
        print(f'ERROR: no Arc tab for {host}', file=sys.stderr)
        sys.exit(1)
    print('Seed meta:', meta)
    parsed = json.loads(meta)
    if isinstance(parsed, str):
        parsed = json.loads(parsed)
    seed = parsed['url']
    queue = [seed]
    seen = {seed}
    rows = []
    readme.write_text(
        f'# Course export: {host}\n\nExported: {time.strftime("%Y-%m-%d %H:%M:%S %Z")}\n\n'
        '| # | Title | File | URL |\n|---|-------|------|-----|\n',
        encoding='utf-8',
    )

    count = 0
    while queue and count < max_pages:
        url = queue.pop(0)
        print(f'[{count+1}] Navigating: {url}')
        try:
            nav = navigate(host, url)
        except Exception as e:
            print('  navigate error:', e, file=sys.stderr)
            continue
        if nav == 'NOT_FOUND':
            print('  tab lost', file=sys.stderr)
            continue
        try:
            raw = extract(host)
        except Exception as e:
            print('  extract error:', e, file=sys.stderr)
            # retry once after delay
            time.sleep(2)
            try:
                raw = extract(host)
            except Exception as e2:
                print('  extract retry failed:', e2, file=sys.stderr)
                continue
        if not raw or raw == 'NOT_FOUND':
            print('  empty extract', file=sys.stderr)
            continue
        try:
            data = json.loads(raw)
            if isinstance(data, str):
                data = json.loads(data)
        except Exception as e:
            print('  JSON parse fail', e, file=sys.stderr)
            (outdir / f'{count+1:03d}-raw.txt').write_text(raw[:20000], encoding='utf-8')
            continue
        count += 1
        title = data.get('title') or 'untitled'
        page_url = data.get('url') or url
        page_html = data.get('html') or ''
        fname = f'{count:03d}-{slugify(page_url)}.html'
        meta_comment = f'<!-- exported-from: {page_url} | title: {title} | bodyTextLen: {data.get("bodyTextLen")} -->\n'
        (outdir / fname).write_text(meta_comment + page_html, encoding='utf-8')
        row = {
            'n': count,
            'title': title,
            'url': page_url,
            'file': fname,
            'htmlLen': len(page_html),
            'bodyTextLen': data.get('bodyTextLen'),
            'linkCount': len(data.get('links') or []),
        }
        rows.append(row)
        with manifest.open('a', encoding='utf-8') as mf:
            mf.write(json.dumps(row, ensure_ascii=False) + '\n')
        with readme.open('a', encoding='utf-8') as im:
            im.write(f"| {count} | {title.replace('|', '\\|')} | `{fname}` | {page_url} |\n")
        print(f"  saved {fname} title={title!r} body={data.get('bodyTextLen')} links={len(data.get('links') or [])}")
        added = 0
        for link in data.get('links') or []:
            href = (link.get('href') or '').split('#')[0]
            if not should_enqueue(href, host):
                continue
            if href in seen:
                continue
            seen.add(href)
            queue.append(href)
            added += 1
        queue_path.write_text('\n'.join(queue) + ('\n' if queue else ''), encoding='utf-8')
        seen_path.write_text('\n'.join(sorted(seen)) + '\n', encoding='utf-8')
        print(f'  enqueued +{added}; queue={len(queue)} seen={len(seen)}')

    write_index(outdir, rows)
    print(f'DONE pages={count} outdir={outdir}')

if __name__ == '__main__':
    main()
