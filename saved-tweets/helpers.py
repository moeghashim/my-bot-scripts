import json, re, urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = Path(__file__).resolve().parent

def page_id_from_url(url: str) -> str:
    clean = url.replace('-', '')
    m = re.search(r'([0-9a-f]{32})', clean)
    return m.group(1) if m else None

def parse_status_url(tweet_url: str):
    if not tweet_url:
        return None, None, False
    u = tweet_url.strip().rstrip('/')
    if re.search(r'(?:x|twitter)\.com/home/?$', u):
        return None, None, False
    m = re.search(r'(?:x|twitter)\.com/i/web/status/(\d+)', u)
    if m:
        return 'i', m.group(1), True
    m = re.search(r'(?:x|twitter)\.com/([^/]+)/status/(\d+)', u)
    if m:
        handle = m.group(1)
        if handle == 'home':
            return None, None, False
        return handle, m.group(2), True
    return None, None, False

def fetch_tweet(handle, status_id):
    ua = 'Mozilla/5.0'
    if handle == 'i':
        urls = [
            f'https://api.fxtwitter.com/i/status/{status_id}',
            f'https://api.vxtwitter.com/i/status/{status_id}',
            f'https://api.fxtwitter.com/status/{status_id}',
            f'https://api.vxtwitter.com/status/{status_id}',
        ]
    else:
        urls = [
            f'https://api.fxtwitter.com/{handle}/status/{status_id}',
            f'https://api.vxtwitter.com/{handle}/status/{status_id}',
        ]
    last_err = None
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': ua})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            if data.get('code') == 200 and data.get('tweet'):
                return data, None
            if data.get('text') or data.get('tweet'):
                if 'tweet' not in data and data.get('text'):
                    photos, all_m = [], []
                    for m in data.get('media_extended') or []:
                        if m.get('type') == 'image':
                            photos.append({'url': m.get('url')})
                            all_m.append({'type': 'photo', 'url': m.get('url')})
                        elif m.get('type') in ('video', 'gif'):
                            all_m.append({
                                'type': 'video',
                                'thumbnail_url': m.get('thumbnail_url'),
                                'url': m.get('url'),
                                'variants': [{'url': m.get('url'), 'content_type': 'video/mp4', 'bitrate': 1}],
                            })
                    if not photos and data.get('mediaURLs'):
                        for u in data['mediaURLs']:
                            photos.append({'url': u})
                            all_m.append({'type': 'photo', 'url': u})
                    return {
                        'code': 200,
                        'tweet': {
                            'url': data.get('tweetURL') or data.get('url'),
                            'id': str(data.get('tweetID') or status_id),
                            'text': data.get('text') or '',
                            'author': {'screen_name': data.get('user_screen_name') or handle},
                            'media': {'photos': photos, 'all': all_m},
                        }
                    }, None
                return data, None
            last_err = data.get('message') or 'not found'
        except Exception as e:
            last_err = str(e)
            continue
    return None, last_err

def text_to_blockquote(text: str) -> str:
    """Notion multi-line quote: single > line with <br> separators (no raw newlines mid-quote)."""
    if text is None or text == '':
        text = '(tweet text unavailable)'
    # Normalize newlines, escape nothing special — content is plain inside quote
    parts = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    # Preserve empty lines as empty <br> segments
    joined = '<br>'.join(parts)
    return f'> {joined}'

def escape_handle_md(handle: str) -> str:
    """Escape underscores so markdown does not italicize handles like _R4V3N5_."""
    return (handle or '').replace('_', r'\_')

def build_markdown(handle, status_id, tweet_url, tweet_data):
    """
    Shiori-compatible format (live tweet embed REQUIRED):
    Author: [@handle](https://x.com/handle)  # escape _ in display text

    <embed src="https://x.com/handle/status/ID">

    > tweet text with <br> for newlines

    ![](photo_url)
    <video src="video_url">
    """
    if tweet_data and tweet_data.get('tweet'):
        t = tweet_data['tweet']
        author = (t.get('author') or {}).get('screen_name') or handle
        if author == 'i':
            author = (t.get('author') or {}).get('screen_name') or 'unknown'
        embed_url = t.get('url') or f'https://x.com/{author}/status/{status_id}'
        # Ensure bare URL — never a markdown link
        if embed_url.startswith('[') or '](' in str(embed_url):
            embed_url = f'https://x.com/{author}/status/{status_id}'
        text = t.get('text')
        bq = text_to_blockquote(text)

        media_lines = []
        media = t.get('media') or {}
        photos = list(media.get('photos') or [])
        seen_img = set()
        seen_vid = set()

        for p in photos:
            url = p.get('url') or p.get('original_url') or ''
            if url and url not in seen_img:
                media_lines.append(f'![]({url})')
                seen_img.add(url)

        for item in (media.get('all') or []):
            typ = (item.get('type') or '').lower()
            if typ in ('video', 'gif') or item.get('duration_ms') or item.get('variants'):
                # thumbnail as image if available
                thumb = item.get('thumbnail_url') or ''
                if thumb and thumb not in seen_img:
                    media_lines.append(f'![]({thumb})')
                    seen_img.add(thumb)
                vurl = None
                variants = item.get('variants') or []
                mp4s = [v for v in variants if 'mp4' in (v.get('content_type') or '') or '.mp4' in (v.get('url') or '')]
                if mp4s:
                    mp4s.sort(key=lambda v: v.get('bitrate') or 0, reverse=True)
                    vurl = mp4s[0].get('url')
                vurl = vurl or item.get('url')
                if vurl and vurl not in seen_vid:
                    media_lines.append(f'<video src="{vurl}">')
                    seen_vid.add(vurl)
            elif typ == 'photo':
                url = item.get('url') or ''
                if url and url not in seen_img:
                    media_lines.append(f'![]({url})')
                    seen_img.add(url)

        parts = [
            f'Author: [@{escape_handle_md(author)}](https://x.com/{author})',
            '',
            f'<embed src="{embed_url}">',
            '',
            bq,
        ]
        if media_lines:
            parts.append('')
            parts.extend(media_lines)
        return '\n'.join(parts), author

    author = handle if handle and handle != 'i' else 'unknown'
    embed_url = tweet_url if tweet_url and '/status/' in tweet_url else (
        f'https://x.com/{author}/status/{status_id}' if status_id else (tweet_url or '')
    )
    md = (
        f'Author: [@{escape_handle_md(author)}](https://x.com/{author})\n\n'
        f'<embed src="{embed_url}">\n\n'
        f'> (tweet text unavailable)'
    )
    return md, author

def fetch_batch(items, workers=15):
    results = {}
    def one(it):
        data, err = fetch_tweet(it['handle'], it['status_id'])
        md, author = build_markdown(it['handle'], it['status_id'], it['tweet_url'], data)
        return it['page_id'], {
            'markdown': md,
            'author': author,
            'fetch_ok': data is not None,
            'error': err,
            'tweet_url': it['tweet_url'],
            'notion_url': it.get('notion_url'),
        }
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(one, it) for it in items]
        for f in as_completed(futs):
            pid, res = f.result()
            results[pid] = res
            (BASE / 'contents' / f'{pid}.md').write_text(res['markdown'], encoding='utf-8')
    return results
