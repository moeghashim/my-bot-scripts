# work-app-clones: blue "Work" copies of desktop AI apps

Blue copies of the desktop AI apps live in `/Applications` so work and personal
accounts run side-by-side, each with its own Dock icon. **Blue means work.** The
untouched stock app stays the personal/default profile:

| Work (blue clone)    | Personal (stock app) |
| -------------------- | -------------------- |
| `Claude Work.app`    | `Claude.app`         |
| `ChatGPT Work.app`   | `ChatGPT.app`        |
| `Grok Bot Work.app`  | `Grok Bot.app`       |

They're built by [`Rebuild-Work-Apps.command`](Rebuild-Work-Apps.command), which
lives here and is symlinked to the Desktop for double-click access. A stock app
that isn't installed is skipped and named in the summary line.

## How it works

For each app, the script:

1. **Clones** the stock app with `cp -Rc` (APFS copy-on-write, so it's fast and
   nearly free on disk). Root-owned unreadable files are skipped — the app
   can't read them anyway.
2. **Swaps in a launcher**: the real binary is renamed (`Claude` →
   `ClaudeMain`) and replaced by a tiny bash script that execs it with profile
   isolation. See [Profile isolation](#profile-isolation) below.
3. **Recolors the icon** to the work blue (`#1b91e3`, the `BLUE` constant) so the
   Dock icons are distinguishable, using inline JXA (JavaScript for Automation)
   + Core Image. The PNG is rendered back to a full `.icns` via `sips` +
   `iconutil`. The target filename comes from `CFBundleIconFile`, since it isn't
   the same everywhere — Claude and ChatGPT ship `electron.icns`, Grok Bot ships
   `icon.icns`. Two different treatments, because the sources differ:
   - Claude's orange starburst → **hue rotation** (`recolor.js`). Rotation alone
     preserves the drop shadow, the speckle texture and the cream starburst; an
     earlier gamma step darkened all three and left the starburst with a dirty
     blue-grey cast.
   - ChatGPT's knot and Grok Bot's ghost are grayscale, so rotation does nothing
     — they go through a **luminance ramp** (`ramp.js`), two stops, running
     opposite ways because the marks are opposite. ChatGPT is a dark knot on a
     light field: dark → white, light → blue. Grok Bot is a light ghost on a
     near-black tile: dark → blue, light → white. Either way the field ends up
     blue and the mark white, which is what makes the three read as a set.

     Grok Bot's eyes sit at 0.13 luminance and its tile at 0.19, so both land on
     the blue. That's what the original does too, and they're far enough apart
     to read — it isn't the collapse the third stop exists for.

   `ramp.js` also supports a third stop, which nothing uses today. It's there
   for dark icons, where two stops can't work: landing a saturated blue on a
   near-black background forces that blue to the dark end of the ramp, leaving
   nothing darker for the outlines. They collapse into the background and the
   icon goes flat. A third stop pinned at the icon's own background luminance
   puts the blue *there*, so everything below it stays genuinely darker.

   Two Core Image details worth not rediscovering: filters run in **linear**
   space, so `ramp.js` converts its sRGB stops on the way in; and it works on an
   **unpremultiplied** image, otherwise the soft drop shadow is dragged toward
   black by its own alpha before the ramp sees it. A `CIColorCube` is the
   tempting way to write this and the wrong one — its grid is uniform in linear
   space, so the entire sRGB range below 0.20 collapses into a single cell,
   which is exactly where a dark icon lives.
4. **Patches Info.plist**: display name gets " Work", bundle id gets a `.work`
   suffix (so macOS treats it as a distinct app — separate Dock entry, separate
   saved state), `CFBundleIconName` is deleted (forces the `.icns` over
   Assets.car), and Sparkle auto-updates are disabled. `app-update.yml` is
   deleted too, which is what electron-updater reads.
5. **Ad-hoc re-signs** the bundle (`codesign --force --deep --sign -`) since
   the contents changed, then **clears `com.apple.quarantine`** from the clone.
   `cp -Rc` copies that xattr over from the stock app, and an ad-hoc signature
   plus a quarantine flag is exactly what makes Gatekeeper refuse to launch with
   *"Apple could not verify … is free of malware"*. The flag records where the
   **stock** app was downloaded from; it carries no meaning for a bundle built
   locally from an app that's already installed and trusted. Nothing about
   Gatekeeper is changed system-wide — only this bundle's provenance xattr.

No `.command` launchers and no personal-side clones are generated — the stock
apps already are the personal profile, and the blue `.app` bundles are reachable
from the Dock and Spotlight on their own.

## Profile isolation

All three are pinned with Electron's `--user-data-dir`, at
`~/Library/Application Support/{Claude,ChatGPT,Grok Bot}-Work`. Two of them need
a second variable on top, because the agent state doesn't live in the Chromium
profile:

- **ChatGPT** exports `CODEX_HOME="$PROFILE/codex"`.
- **Grok Bot** exports `SAND_DATA_ROOT="$PROFILE/sand-data"`. The flag alone
  isn't enough: the app resolves that root with an *empty* argv, so
  `--user-data-dir` is invisible to it and it falls back to `~/.grokbot` —
  shared with the personal app, and where the local-exec daemon and its
  credential live. `SAND_DATA_ROOT` is the highest-precedence override and pins
  it to the same path the flag-aware code paths compute.

Verifying by hand, after a rebuild:

```sh
codesign --verify --deep --strict "/Applications/ChatGPT Work.app"
```

## Maintenance

The clones are **frozen snapshots** — auto-update is disabled and they don't
track the stock apps. After a stock app updates itself, re-run the script
(double-click `~/Desktop/Rebuild-Work-Apps.command` or run it from here). It
kills any running work instance, deletes the old clone, and rebuilds from the
current stock app. Profile data lives outside the bundles, so rebuilding never
touches logins or history.
