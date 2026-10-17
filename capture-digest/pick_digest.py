#!/usr/bin/env python3
import json, os, random, ssl, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

SHORT = {"Post", "List", "Website", "Person", "Company", "Store", "Channel", "Viz", "Portfolio", "Application"}
MEDIUM = {"Article", "Blog", "Talk", "Video", "Podcast Episode", "Document", "Service", "Project"}
LONG = {"Book", "Course", "Podcast", "Framework"}

# Prefer older captures: weight by age. Exclude workplace/facebook private, fb.workplace
EXCLUDE_HOST_FRAGMENTS = ("fb.workplace.com", "workplace.com")

def form_of(types):
    if not types:
        return "medium"
    tset = set(types)
    if tset & LONG:
        return "long"
    if tset & SHORT and not (tset & MEDIUM):
        return "short"
    if tset & MEDIUM:
        return "medium"
    if tset & SHORT:
        return "short"
    return "medium"

def ok_url(url, timeout=6):
    if not url or not url.startswith("http"):
        return False
    if any(x in url for x in EXCLUDE_HOST_FRAGMENTS):
        return False
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Mozilla/5.0 CaptureDigest/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return 200 <= r.status < 400
    except urllib.error.HTTPError as e:
        # Some sites block HEAD; try GET lightly
        if e.code in (403, 405, 501):
            try:
                req2 = urllib.request.Request(url, method="GET", headers={"User-Agent": "Mozilla/5.0 CaptureDigest/1.0"})
                with urllib.request.urlopen(req2, timeout=timeout, context=ctx) as r2:
                    return 200 <= r2.status < 400
            except Exception:
                return False
        return False
    except Exception:
        try:
            req2 = urllib.request.Request(url, method="GET", headers={"User-Agent": "Mozilla/5.0 CaptureDigest/1.0"})
            with urllib.request.urlopen(req2, timeout=timeout, context=ctx) as r2:
                return 200 <= r2.status < 400
        except Exception:
            return False

def valid_mix(picked):
    forms = [p["form"] for p in picked]
    if len(picked) != 5:
        return False
    if forms.count("long") > 2:
        return False
    if forms.count("short") > 4:
        return False
    # Require at least some variety: not all short, not all long
    if forms.count("short") == 5 or forms.count("long") == 5:
        return False
    return True

def main():
    candidates = json.loads(Path(os.environ.get("DIGEST_IN", "/workspace/saved_candidates.json")).read_text())
    for c in candidates:
        types = c.get("Type") or []
        if isinstance(types, str):
            try:
                types = json.loads(types)
            except Exception:
                types = [types] if types else []
        c["types"] = types
        c["form"] = form_of(types)
        # skip private workplace
        link = c.get("link") or ""
        c["skip"] = any(x in link for x in EXCLUDE_HOST_FRAGMENTS)

    pool = [c for c in candidates if not c["skip"] and c.get("link")]
    random.seed()
    random.shuffle(pool)

    # Prefer older: sort half by Date Added ascending then interleave with shuffle
    older = sorted(pool, key=lambda x: x.get("Date Added") or "")[: max(40, len(pool)//2)]
    random.shuffle(older)
    # Working pool: older-first shuffle bias
    working = older + [c for c in pool if c not in older]
    random.shuffle(working)

    checked_ok = []
    checked_bad = []
    need = 12  # pre-check extra for replacements
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(ok_url, c["link"]): c for c in working[:40]}
        for fut in as_completed(futs):
            c = futs[fut]
            try:
                good = fut.result()
            except Exception:
                good = False
            if good:
                checked_ok.append(c)
            else:
                checked_bad.append(c)
            if len(checked_ok) >= need:
                break

    # If not enough, check more
    if len(checked_ok) < need:
        rest = [c for c in working if c not in checked_ok and c not in checked_bad]
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = {ex.submit(ok_url, c["link"]): c for c in rest[:40]}
            for fut in as_completed(futs):
                c = futs[fut]
                if fut.result():
                    checked_ok.append(c)
                if len(checked_ok) >= need:
                    break

    by_form = {"short": [], "medium": [], "long": []}
    for c in checked_ok:
        by_form[c["form"]].append(c)

    # Build valid mix: target 1 long, 2 medium, 2 short if possible
    targets = [
        (1, 2, 2),
        (2, 2, 1),
        (1, 3, 1),
        (0, 3, 2),
        (2, 1, 2),
        (0, 2, 3),
        (1, 1, 3),
    ]
    random.shuffle(targets)
    picked = None
    for n_long, n_med, n_short in targets:
        if (len(by_form["long"]) >= n_long and len(by_form["medium"]) >= n_med and len(by_form["short"]) >= n_short):
            picked = (
                random.sample(by_form["long"], n_long)
                + random.sample(by_form["medium"], n_med)
                + random.sample(by_form["short"], n_short)
            )
            random.shuffle(picked)
            break
    if not picked:
        # fallback: take first 5 ok that satisfy constraints by greedy
        picked = []
        for c in checked_ok:
            trial = picked + [c]
            forms = [x["form"] for x in trial]
            if forms.count("long") > 2 or forms.count("short") > 4:
                continue
            picked.append(c)
            if len(picked) == 5:
                break

    out = {
        "picked": [
            {
                "Name": c["Name"],
                "url": c["url"],
                "link": c["link"],
                "form": c["form"],
                "Type": c.get("Type"),
                "Subjects": c.get("Subjects"),
                "Date Added": c.get("Date Added"),
            }
            for c in (picked or [])
        ],
        "checked_ok": len(checked_ok),
        "checked_bad": len(checked_bad),
        "pool": len(pool),
    }
    Path(os.environ.get("DIGEST_OUT", "/workspace/digest_pick.json")).write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))

if __name__ == "__main__":
    main()
