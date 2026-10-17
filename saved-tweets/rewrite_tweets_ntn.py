#!/usr/bin/env python3
"""Rewrite Saved Tweet Notion pages to a standard tweet format via Notion public API.

Format per page:
  1. paragraph: Author: @handle (linked to https://x.com/handle)
  2. embed block with status URL
  3. quote block with full tweet text
  4. photos as image blocks (external by default; --host-images optional)
  5. videos: Notion-hosted via /v1/file_uploads mode=external_url when possible;
     else external video block

Never prints NOTION_API_TOKEN.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from helpers import fetch_tweet, parse_status_url  # noqa: E402

CANDIDATES = ROOT / "candidates.json"
PROGRESS = ROOT / "progress_ntn.json"
# Page ids to leave untouched (e.g. a hand-made reference page), comma-separated, from env.
SKIP_PAGES = {p.replace("-", "").lower() for p in os.environ.get("SAVED_TWEETS_SKIP_PAGES", "").split(",") if p.strip()}
NOTION_VERSION = "2022-06-28"
API = "https://api.notion.com/v1"
RATE_SLEEP = 0.35
SAVE_EVERY = 5
RICH_TEXT_MAX = 2000


def norm_id(pid: str) -> str:
    return (pid or "").replace("-", "").lower()


def dashed_id(pid: str) -> str:
    s = norm_id(pid)
    if len(s) != 32:
        return pid
    return f"{s[0:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:32]}"


def load_token() -> str:
    tok = os.environ.get("NOTION_API_TOKEN") or ""
    if not tok:
        env_file = os.environ.get("NOTION_ENV_FILE")  # optional .env holding NOTION_API_TOKEN
        env_path = Path(env_file) if env_file else None
        if env_path and env_path.exists():
            for line in env_path.read_text().splitlines():
                line = line.strip()
                if line.startswith("NOTION_API_TOKEN=") and not line.startswith("#"):
                    tok = line.split("=", 1)[1].strip().strip('"').strip("'")
                    os.environ["NOTION_API_TOKEN"] = tok
                    break
    if not tok:
        raise SystemExit("NOTION_API_TOKEN not set")
    return tok


def api_request(method: str, path: str, body: dict | None = None, token: str | None = None,
                version: str = NOTION_VERSION, retries: int = 5):
    token = token or load_token()
    url = path if path.startswith("http") else f"{API}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": version,
        "Content-Type": "application/json",
    }
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                return json.loads(raw.decode("utf-8")) if raw else {}
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            if e.code == 429:
                wait = min(30, 2 ** attempt)
                try:
                    wait = float(e.headers.get("Retry-After") or wait)
                except Exception:
                    pass
                time.sleep(wait)
                last_err = f"429 {err_body[:200]}"
                continue
            if e.code in (500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                last_err = f"{e.code} {err_body[:200]}"
                continue
            raise RuntimeError(f"HTTP {e.code}: {err_body[:500]}") from None
        except Exception as e:
            last_err = str(e)
            if attempt < retries - 1:
                time.sleep(1.0 * (attempt + 1))
                continue
            raise
    raise RuntimeError(last_err or "request failed")


def load_progress() -> dict:
    if PROGRESS.exists():
        try:
            return json.loads(PROGRESS.read_text())
        except Exception:
            pass
    return {
        "ok": [],
        "fail": [],
        "skip": [],
        "by_id": {},
        "counts": {"ok": 0, "fail": 0, "skip": 0},
        "samples": [],
        "updated_at": None,
    }


def save_progress(prog: dict) -> None:
    prog["counts"] = {
        "ok": len(prog.get("ok") or []),
        "fail": len(prog.get("fail") or []),
        "skip": len(prog.get("skip") or []),
    }
    prog["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # Keep by_id lean
    PROGRESS.write_text(json.dumps(prog, indent=2))


def list_children(page_id: str) -> list:
    results = []
    cursor = None
    pid = dashed_id(page_id)
    while True:
        q = f"/blocks/{pid}/children?page_size=100"
        if cursor:
            q += f"&start_cursor={cursor}"
        data = api_request("GET", q)
        results.extend(data.get("results") or [])
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
        time.sleep(0.05)
    return results


def delete_all_children(page_id: str) -> int:
    kids = list_children(page_id)
    n = 0
    for b in kids:
        bid = b["id"]
        try:
            api_request("DELETE", f"/blocks/{bid}")
            n += 1
            time.sleep(0.05)
        except Exception as e:
            # archived already etc.
            if "archived" not in str(e).lower():
                raise
    return n


def utf16_len(s: str) -> int:
    """Notion rich_text limits count UTF-16 code units (surrogate pairs)."""
    return sum(2 if ord(c) > 0xFFFF else 1 for c in s)


def rt_chunks(text: str) -> list:
    """Split into rich_text objects respecting Notion's 2000 UTF-16 unit limit."""
    text = text if text is not None else ""
    if text == "":
        text = "(tweet text unavailable)"
    chunks = []
    buf = []
    units = 0
    limit = RICH_TEXT_MAX  # 2000
    for ch in text:
        cu = 2 if ord(ch) > 0xFFFF else 1
        if units + cu > limit and buf:
            chunks.append({"type": "text", "text": {"content": "".join(buf)}})
            buf = []
            units = 0
        buf.append(ch)
        units += cu
    if buf:
        chunks.append({"type": "text", "text": {"content": "".join(buf)}})
    return chunks


def author_block(handle: str) -> dict:
    handle = handle or "unknown"
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": [
                {"type": "text", "text": {"content": "Author: "}},
                {
                    "type": "text",
                    "text": {
                        "content": f"@{handle}",
                        "link": {"url": f"https://x.com/{handle}"},
                    },
                },
            ]
        },
    }


def embed_block(url: str) -> dict:
    return {"object": "block", "type": "embed", "embed": {"url": url}}


def quote_block(text: str) -> dict:
    return {
        "object": "block",
        "type": "quote",
        "quote": {"rich_text": rt_chunks(text)},
    }


def image_external(url: str) -> dict:
    return {
        "object": "block",
        "type": "image",
        "image": {"type": "external", "external": {"url": url}},
    }


def video_external(url: str) -> dict:
    return {
        "object": "block",
        "type": "video",
        "video": {"type": "external", "external": {"url": url}},
    }


def video_file_upload(upload_id: str) -> dict:
    return {
        "object": "block",
        "type": "video",
        "video": {
            "type": "file_upload",
            "file_upload": {"id": upload_id},
        },
    }


def image_file_upload(upload_id: str) -> dict:
    return {
        "object": "block",
        "type": "image",
        "image": {
            "type": "file_upload",
            "file_upload": {"id": upload_id},
        },
    }


def host_external_url(file_url: str, filename: str, poll_s: float = 45.0) -> str | None:
    """Create file upload via external_url mode; poll until uploaded. Return id or None."""
    try:
        created = api_request("POST", "/file_uploads", {
            "mode": "external_url",
            "external_url": file_url,
            "filename": filename,
        })
    except Exception as e:
        print(f"  file_upload create failed: {e}")
        return None
    uid = created.get("id")
    status = created.get("status")
    if status == "uploaded":
        return uid
    deadline = time.time() + poll_s
    while time.time() < deadline:
        time.sleep(1.0)
        try:
            info = api_request("GET", f"/file_uploads/{uid}")
        except Exception as e:
            print(f"  file_upload poll failed: {e}")
            return None
        status = info.get("status")
        if status == "uploaded":
            return uid
        if status in ("failed", "expired"):
            print(f"  file_upload status={status} result={info.get('file_import_result')}")
            return None
    print(f"  file_upload poll timeout status={status}")
    return None


def best_mp4(item: dict) -> str | None:
    variants = item.get("variants") or []
    mp4s = [
        v for v in variants
        if "mp4" in (v.get("content_type") or "") or ".mp4" in (v.get("url") or "")
    ]
    if mp4s:
        mp4s.sort(key=lambda v: v.get("bitrate") or 0, reverse=True)
        return mp4s[0].get("url")
    # formats list (fxtwitter)
    formats = item.get("formats") or []
    mp4s = [f for f in formats if "mp4" in (f.get("content_type") or f.get("type") or "") or ".mp4" in (f.get("url") or "")]
    if mp4s:
        mp4s.sort(key=lambda v: v.get("bitrate") or 0, reverse=True)
        return mp4s[0].get("url")
    url = item.get("url") or ""
    if ".mp4" in url or (item.get("format") or "").startswith("video"):
        return url
    return url or None


def extract_media(tweet: dict) -> tuple[list[str], list[str]]:
    """Return (photo_urls, video_urls) de-duped."""
    photos: list[str] = []
    videos: list[str] = []
    seen_p, seen_v = set(), set()
    media = tweet.get("media") or {}

    for p in media.get("photos") or []:
        url = p.get("url") or p.get("original_url") or ""
        if url and url not in seen_p:
            photos.append(url)
            seen_p.add(url)

    for item in media.get("all") or []:
        typ = (item.get("type") or "").lower()
        if typ in ("video", "gif") or item.get("variants") or item.get("duration") or item.get("duration_ms"):
            # prefer not duplicating thumbnail as photo if we also have video;
            # but the reference sample had only video (no thumb image). Include thumb only if no photos yet? 
            # Spec: photos as image blocks; videos as video. Include thumbs as images when present.
            thumb = item.get("thumbnail_url") or ""
            if thumb and thumb not in seen_p:
                photos.append(thumb)
                seen_p.add(thumb)
            vurl = best_mp4(item)
            if vurl and vurl not in seen_v:
                videos.append(vurl)
                seen_v.add(vurl)
        elif typ == "photo":
            url = item.get("url") or ""
            if url and url not in seen_p:
                photos.append(url)
                seen_p.add(url)

    return photos, videos


def append_children(page_id: str, children: list) -> None:
    """Append in batches of <=100."""
    pid = dashed_id(page_id)
    for i in range(0, len(children), 100):
        batch = children[i:i + 100]
        api_request("PATCH", f"/blocks/{pid}/children", {"children": batch})
        time.sleep(RATE_SLEEP)


def rewrite_one(cand: dict, host_videos: bool, host_images: bool) -> dict:
    page_id = cand["page_id"]
    nid = norm_id(page_id)
    handle = cand.get("handle") or "unknown"
    status_id = cand.get("status_id")
    tweet_url = cand.get("tweet_url") or ""

    if nid in SKIP_PAGES:
        return {"status": "skip", "reason": "reference_sample", "page_id": page_id,
                "notion_url": cand.get("notion_url")}

    if not status_id:
        h, sid, ok = parse_status_url(tweet_url)
        if ok:
            handle, status_id = h, sid
        else:
            return {"status": "fail", "reason": "no_status_id", "page_id": page_id}

    data, err = fetch_tweet(handle, status_id)
    tweet = (data or {}).get("tweet") if data else None
    if not tweet:
        # Still rewrite with unavailable text + embed
        author = handle if handle and handle != "i" else "unknown"
        embed_url = tweet_url if "/status/" in (tweet_url or "") else f"https://x.com/{author}/status/{status_id}"
        text = "(tweet text unavailable)"
        photos, videos = [], []
        fetch_note = err or "fetch_failed"
    else:
        author = (tweet.get("author") or {}).get("screen_name") or handle
        if author == "i":
            author = (tweet.get("author") or {}).get("screen_name") or "unknown"
        embed_url = tweet.get("url") or f"https://x.com/{author}/status/{status_id}"
        text = tweet.get("text") or "(tweet text unavailable)"
        photos, videos = extract_media(tweet)
        fetch_note = None

    # Build blocks
    children = [
        author_block(author),
        embed_block(embed_url),
        quote_block(text),
    ]

    hosted_vids = 0
    external_vids = 0
    for i, vurl in enumerate(videos):
        upload_id = None
        if host_videos:
            fname = f"{status_id}_{i}.mp4"
            upload_id = host_external_url(vurl, fname)
        if upload_id:
            children.append(video_file_upload(upload_id))
            hosted_vids += 1
        else:
            children.append(video_external(vurl))
            external_vids += 1

    hosted_imgs = 0
    for i, purl in enumerate(photos):
        # Skip thumb that duplicates a video we already have? keep as the reference sample had no thumb;
        # include photos. If photo URL equals a video thumb already listed — fine.
        if host_images:
            ext = ".jpg"
            if ".png" in purl:
                ext = ".png"
            elif ".webp" in purl:
                ext = ".webp"
            upload_id = host_external_url(purl, f"{status_id}_img_{i}{ext}")
            if upload_id:
                children.append(image_file_upload(upload_id))
                hosted_imgs += 1
                continue
        children.append(image_external(purl))

    # Mutate page
    deleted = delete_all_children(page_id)
    time.sleep(RATE_SLEEP)
    append_children(page_id, children)

    return {
        "status": "ok",
        "page_id": page_id,
        "notion_url": cand.get("notion_url") or f"https://app.notion.com/{nid}",
        "author": author,
        "embed_url": embed_url,
        "deleted": deleted,
        "blocks": len(children),
        "photos": len(photos),
        "videos": len(videos),
        "hosted_videos": hosted_vids,
        "external_videos": external_vids,
        "hosted_images": hosted_imgs,
        "fetch_note": fetch_note,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--only", type=str, default="")
    ap.add_argument("--no-host-videos", action="store_true")
    ap.add_argument("--host-images", action="store_true")
    ap.add_argument("--force", action="store_true", help="re-process even if already ok in progress")
    args = ap.parse_args()

    load_token()  # validate early; never print
    candidates = json.loads(CANDIDATES.read_text())
    prog = load_progress()
    done_ok = {norm_id(x) for x in prog.get("ok") or []}
    done_skip = {norm_id(x) for x in prog.get("skip") or []}

    host_videos = not args.no_host_videos
    host_images = args.host_images

    items = candidates
    if args.only:
        only = norm_id(args.only)
        items = [c for c in candidates if norm_id(c["page_id"]) == only]
        if not items:
            raise SystemExit(f"--only page not found: {args.only}")
    else:
        if args.offset:
            items = items[args.offset:]
        if args.limit and args.limit > 0:
            items = items[: args.limit]

    print(f"candidates_selected={len(items)} host_videos={host_videos} host_images={host_images}")

    processed = 0
    for cand in items:
        nid = norm_id(cand["page_id"])
        if nid in SKIP_PAGES:
            if nid not in done_skip:
                prog.setdefault("skip", []).append(nid)
                prog.setdefault("by_id", {})[nid] = {"status": "skip", "reason": "reference_sample"}
                save_progress(prog)
            print(f"SKIP reference {nid}")
            continue
        if not args.force and nid in done_ok:
            print(f"SKIP already_ok {nid}")
            continue

        print(f"REWRITE {nid} @{cand.get('handle')} {cand.get('status_id')}")
        try:
            res = rewrite_one(cand, host_videos=host_videos, host_images=host_images)
        except Exception as e:
            res = {
                "status": "fail",
                "page_id": cand["page_id"],
                "notion_url": cand.get("notion_url"),
                "reason": str(e)[:400],
            }
            print(f"  FAIL {res['reason']}")

        status = res.get("status")
        if status == "ok":
            if nid not in done_ok:
                prog.setdefault("ok", []).append(nid)
                done_ok.add(nid)
            # remove from fail if present
            prog["fail"] = [x for x in prog.get("fail") or [] if norm_id(x) != nid]
            if len(prog.get("samples") or []) < 10:
                prog.setdefault("samples", []).append(res.get("notion_url"))
            print(f"  OK blocks={res.get('blocks')} vids={res.get('videos')} hosted_v={res.get('hosted_videos')} photos={res.get('photos')}")
        elif status == "skip":
            if nid not in done_skip:
                prog.setdefault("skip", []).append(nid)
                done_skip.add(nid)
            print(f"  SKIP {res.get('reason')}")
        else:
            if nid not in {norm_id(x) for x in prog.get("fail") or []}:
                prog.setdefault("fail", []).append(nid)
            print(f"  FAIL {res.get('reason')}")

        prog.setdefault("by_id", {})[nid] = {k: v for k, v in res.items() if k != "page_id"}
        processed += 1
        if processed % SAVE_EVERY == 0:
            save_progress(prog)
        time.sleep(RATE_SLEEP)

    save_progress(prog)
    print(json.dumps({
        "ok": len(prog.get("ok") or []),
        "fail": len(prog.get("fail") or []),
        "skip": len(prog.get("skip") or []),
        "processed_this_run": processed,
        "samples": (prog.get("samples") or [])[:3],
    }))


if __name__ == "__main__":
    main()
