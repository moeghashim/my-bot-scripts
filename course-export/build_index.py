#!/usr/bin/env python3
import json, re, html, time, sys
from pathlib import Path

def main():
    outdir = Path(sys.argv[1]).expanduser()
    title = sys.argv[2] if len(sys.argv) > 2 else outdir.name
    rows = []
    for p in sorted(outdir.glob("*.html")):
        if p.name == "index.html":
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")[:800]
        m = re.match(r"<!--\s*(.*?)\s*\|\s*(.*?)\s*\|\s*body=(\d+)\s*-->", text)
        if not m:
            continue
        url, page_title, body = m.group(1), m.group(2), int(m.group(3))
        try:
            n = int(p.name.split("-", 1)[0])
        except ValueError:
            continue
        rows.append({
            "n": n,
            "title": page_title,
            "url": url,
            "file": p.name,
            "bodyTextLen": body,
            "htmlLen": p.stat().st_size,
        })
    rows.sort(key=lambda r: r["n"])
    (outdir / "manifest.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    md = [
        "# " + title + " export",
        "",
        "Exported: " + time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "",
        str(len(rows)) + " pages",
        "",
        "| # | Title | File | URL | Body |",
        "|---|-------|------|-----|------|",
    ]
    for r in rows:
        safe = r["title"].replace("|", "\\|")
        md.append("| %d | %s | `%s` | %s | %d |" % (r["n"], safe, r["file"], r["url"], r["bodyTextLen"]))
    (outdir / "README.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    parts = [
        "<!doctype html><meta charset=utf-8><title>%s export</title>" % html.escape(title),
        "<style>body{font:14px/1.4 system-ui;max-width:960px;margin:2rem auto;padding:0 1rem} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left} a{color:#06c}</style>",
        "<h1>%s</h1>" % html.escape(title),
        "<p>%d pages</p>" % len(rows),
        "<table><tr><th>#</th><th>Title</th><th>File</th><th>URL</th><th>Body</th></tr>",
    ]
    for r in rows:
        parts.append(
            "<tr><td>%d</td><td>%s</td><td><a href='%s'>%s</a></td><td><a href='%s'>%s</a></td><td>%d</td></tr>"
            % (
                r["n"],
                html.escape(r["title"]),
                html.escape(r["file"]),
                html.escape(r["file"]),
                html.escape(r["url"]),
                html.escape(r["url"]),
                r["bodyTextLen"],
            )
        )
    parts.append("</table>")
    (outdir / "index.html").write_text("\n".join(parts), encoding="utf-8")
    print("%s: %d pages" % (outdir, len(rows)))
    for r in rows:
        if r["bodyTextLen"] < 1500:
            print("  THIN %d %s body=%d %s" % (r["n"], r["title"], r["bodyTextLen"], r["url"]))

if __name__ == "__main__":
    main()
