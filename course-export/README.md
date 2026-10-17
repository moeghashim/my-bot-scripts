# Arc course export

Export Arc-logged-in course pages to HTML on a Mac (AppleScript + JS injection).

Useful for keeping personal offline copies of courses you have access to, e.g. under `~/Documents/courses/`. Respect each course's terms; don't redistribute exports.

## Files

| File | Role |
|------|------|
| `arc_course_export.py` | Higher-level Arc tab find / navigate / export helpers |
| `save_one.sh` | Export one URL from an open Arc tab matching `HOST` |
| `batch_export.sh` | Loop a URL list through `save_one.sh` + write manifest/README |
| `build_index.py` | Rebuild `manifest.jsonl` + index markdown from exported HTML comments |

## Usage (Mac)

```bash
# One page (Arc must have a tab whose URL contains HOST)
./save_one.sh 'course.example.com' 'https://course.example.com/lesson/1' ~/Documents/courses/foo/001-lesson-1.html

# Batch
./batch_export.sh 'course.example.com' ~/Documents/courses/foo urls.txt

# Rebuild index after exports
python3 build_index.py ~/Documents/courses/foo 'Course title'
```

Requires Arc + `osascript`. macOS only.
