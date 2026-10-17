#!/bin/bash
# Rebuilds "Claude Work.app", "ChatGPT Work.app" and "Grok Bot Work.app".
#
# APFS-clone the current stock app, swap in a navy-recolored icon, embed a
# launcher that pins the clone to its work profile, and ad-hoc re-sign. Navy
# means work; the untouched stock app stays the personal/default profile.
# These are frozen clones and don't auto-update -- rerun this script after a
# stock app updates itself.

# SC2016: the launcher bodies below are single-quoted on purpose -- $DIR, $HOME
# and $@ have to survive into the generated script, not expand while building it.
# shellcheck disable=SC2016
set -e
PB=/usr/libexec/PlistBuddy
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Renders an app's actual displayed icon (Assets.car or icns) to a 1024px PNG.
cat > "$WORK/geticon.js" <<'JXA'
ObjC.import("AppKit");
function run(argv) {
  const [appPath, outPath] = argv;
  const icon = $.NSWorkspace.sharedWorkspace.iconForFile(appPath);
  const rect = $.NSMakeRect(0, 0, 1024, 1024);
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(1024, 1024));
  img.lockFocus;
  icon.drawInRectFromRectOperationFraction(rect, $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
  img.unlockFocus;
  const bm = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  bm.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary)
    .writeToFileAtomically(outPath, true);
  return "ok";
}
JXA

# Hue-rotate + darken (for colored icons like Claude's orange), preserving alpha.
# args: <in> <out> <hueDeg> <saturation> <gamma>
cat > "$WORK/recolor.js" <<'JXA'
ObjC.import("AppKit");
ObjC.import("QuartzCore");
function run(argv) {
  const [inPath, outPath, hueDeg, sat, gamma] = argv;
  const original = $.CIImage.imageWithContentsOfURL($.NSURL.fileURLWithPath(inPath));
  let img = original;
  const hue = $.CIFilter.filterWithName("CIHueAdjust");
  hue.setValueForKey(img, "inputImage");
  hue.setValueForKey(parseFloat(hueDeg) * Math.PI / 180, "inputAngle");
  img = hue.valueForKey("outputImage");
  const cc = $.CIFilter.filterWithName("CIColorControls");
  cc.setValueForKey(img, "inputImage");
  cc.setValueForKey(parseFloat(sat), "inputSaturation");
  cc.setValueForKey(0.0, "inputBrightness");
  cc.setValueForKey(1.0, "inputContrast");
  img = cc.valueForKey("outputImage");
  const ga = $.CIFilter.filterWithName("CIGammaAdjust");
  ga.setValueForKey(img, "inputImage");
  ga.setValueForKey(parseFloat(gamma), "inputPower");
  img = ga.valueForKey("outputImage");
  const comp = $.CIFilter.filterWithName("CISourceInCompositing");
  comp.setValueForKey(img, "inputImage");
  comp.setValueForKey(original, "inputBackgroundImage");
  img = comp.valueForKey("outputImage").imageByCroppingToRect(original.extent);
  const rep = $.NSBitmapImageRep.alloc.initWithCIImage(img);
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary)
     .writeToFileAtomically(outPath, true);
  return "ok";
}
JXA

# Luminance ramp for grayscale icons (ChatGPT's knot).
# args: <in> <out> <knee|-> <c0> <c1> <c2>   colours "r,g,b", sRGB 0..1
#   knee "-" and no c2: straight two-stop lerp, luminance 0 -> c0, 1 -> c1.
#   otherwise three stops: 0 -> c0, knee -> c1, 1 -> c2.
#
# Only the two-stop form is used today. Three stops are kept for dark icons,
# where two can't work: landing a saturated colour on the background forces it
# to the dark end of the ramp, leaving nothing darker for the outlines -- they
# collapse into the background and the icon goes flat. A knee at the
# background's own luminance pins the colour there and keeps everything below
# it genuinely darker.
cat > "$WORK/ramp.js" <<'JXA'
ObjC.import("AppKit");
ObjC.import("QuartzCore");
function run(argv) {
  const inPath = argv[0], outPath = argv[1];
  // Core Image's working space is linear; the stops are written as the sRGB
  // values you'd read off the icon, so convert them on the way in.
  const lin = function (v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const col = function (s) { return s.split(",").map(parseFloat).map(lin); };
  const twoStop = argv[2] === "-";
  const knee = twoStop ? 0 : lin(parseFloat(argv[2]));
  const c0 = col(argv[3]), c1 = col(argv[4]), c2 = twoStop ? null : col(argv[5]);

  const vec = function (a, b, c, d) { return $.CIVector.vectorWithXYZW(a, b, c, d); };
  function matrix(img, mul, bias, alpha) {   // per-channel scale + bias, forced alpha
    const f = $.CIFilter.filterWithName("CIColorMatrix");
    f.setValueForKey(img, "inputImage");
    f.setValueForKey(vec(mul[0], 0, 0, 0), "inputRVector");
    f.setValueForKey(vec(0, mul[1], 0, 0), "inputGVector");
    f.setValueForKey(vec(0, 0, mul[2], 0), "inputBVector");
    f.setValueForKey(vec(0, 0, 0, 0), "inputAVector");
    f.setValueForKey(vec(bias[0], bias[1], bias[2], alpha), "inputBiasVector");
    return f.valueForKey("outputImage");
  }
  function clamp01(img) {
    const f = $.CIFilter.filterWithName("CIColorClamp");
    f.setValueForKey(img, "inputImage");
    f.setValueForKey(vec(0, 0, 0, 0), "inputMinComponents");
    f.setValueForKey(vec(1, 1, 1, 1), "inputMaxComponents");
    return f.valueForKey("outputImage");
  }
  function param(img, lo, hi) {   // clamp((L - lo) / (hi - lo)), in all channels
    const m = 1 / (hi - lo), b = -lo * m;
    return clamp01(matrix(img, [m, m, m], [b, b, b], 1));
  }
  function lerp(t, a, b) {
    return matrix(t, [b[0] - a[0], b[1] - a[1], b[2] - a[2]], a, 1);
  }

  const original = $.CIImage.imageWithContentsOfURL($.NSURL.fileURLWithPath(inPath));
  // Unpremultiplied, so the soft drop shadow's colour isn't dragged toward
  // black by its own alpha before the ramp sees it.
  const base = original.imageByUnpremultiplyingAlpha;

  let img;
  if (twoStop) {
    img = lerp(param(base, 0, 1), c0, c1);
  } else {
    const lower = lerp(param(base, 0, knee), c0, c1);
    const upper = lerp(param(base, knee, 1), c1, c2);
    // The mask carries the upper segment's own parameter, so the halves meet
    // exactly at the knee, where both evaluate to c1. White-at-alpha-t keeps it
    // valid premultiplied data.
    const t = param(base, knee, 1);
    const mf = $.CIFilter.filterWithName("CIColorMatrix");
    mf.setValueForKey(t, "inputImage");
    mf.setValueForKey(vec(1, 0, 0, 0), "inputRVector");
    mf.setValueForKey(vec(1, 0, 0, 0), "inputGVector");
    mf.setValueForKey(vec(1, 0, 0, 0), "inputBVector");
    mf.setValueForKey(vec(1, 0, 0, 0), "inputAVector");
    mf.setValueForKey(vec(0, 0, 0, 0), "inputBiasVector");
    const blend = $.CIFilter.filterWithName("CIBlendWithMask");
    blend.setValueForKey(upper, "inputImage");
    blend.setValueForKey(lower, "inputBackgroundImage");
    blend.setValueForKey(mf.valueForKey("outputImage"), "inputMaskImage");
    img = blend.valueForKey("outputImage");
  }

  // Restore the icon's own alpha: source colour, background alpha.
  const comp = $.CIFilter.filterWithName("CISourceInCompositing");
  comp.setValueForKey(img, "inputImage");
  comp.setValueForKey(original, "inputBackgroundImage");
  img = comp.valueForKey("outputImage").imageByCroppingToRect(original.extent);
  const rep = $.NSBitmapImageRep.alloc.initWithCIImage(img);
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary)
     .writeToFileAtomically(outPath, true);
  return "ok";
}
JXA

icns_from_png() {  # <1024px png> <output icns>
  local png="$1" out="$2"
  rm -rf "$WORK/i.iconset"; mkdir "$WORK/i.iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$png" --out "$WORK/i.iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$png" --out "$WORK/i.iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$WORK/i.iconset" -o "$out"
}

build() {  # <source app> <dup app> <exec name> <display name> <navy png> <launcher body>
  local src="$1" dup="$2" exe="$3" disp="$4" navypng="$5" launcher="$6"
  echo "Building $dup ..."
  pkill -f "$dup/Contents/MacOS" 2>/dev/null && sleep 3 || true
  rm -rf "$dup"
  cp -Rc "$src" "$dup" 2>/dev/null || true   # root-owned 600 files can't copy; app can't read them anyway
  mv "$dup/Contents/MacOS/$exe" "$dup/Contents/MacOS/${exe}Main"
  printf '%s\n' "$launcher" > "$dup/Contents/MacOS/$exe"
  chmod +x "$dup/Contents/MacOS/$exe"
  local plist="$dup/Contents/Info.plist"
  # Which .icns the bundle actually loads isn't the same everywhere -- Claude and
  # ChatGPT ship electron.icns, Grok Bot ships icon.icns. CFBundleIconFile names it.
  local icns; icns=$($PB -c 'Print :CFBundleIconFile' "$plist" 2>/dev/null || echo electron.icns)
  [[ "$icns" == *.icns ]] || icns="$icns.icns"
  icns_from_png "$navypng" "$dup/Contents/Resources/$icns"
  $PB -c "Set :CFBundleDisplayName $disp" "$plist" 2>/dev/null || $PB -c "Add :CFBundleDisplayName string $disp" "$plist"
  $PB -c 'Delete :CFBundleIconName' "$plist" 2>/dev/null || true
  local oldid; oldid=$($PB -c 'Print :CFBundleIdentifier' "$plist")
  [[ "$oldid" == *.work ]] || $PB -c "Set :CFBundleIdentifier ${oldid}.work" "$plist"
  $PB -c 'Set :SUEnableAutomaticChecks false' "$plist" 2>/dev/null || $PB -c 'Add :SUEnableAutomaticChecks bool false' "$plist" 2>/dev/null || true
  rm -f "$dup/Contents/Resources/app-update.yml"   # electron-updater feed; without it the clone stays frozen
  codesign --force --deep --sign - "$dup"
  # cp -Rc carries the stock app's com.apple.quarantine xattr into the clone.
  # Paired with an ad-hoc signature (no notarization ticket), that's what makes
  # Gatekeeper throw "Apple could not verify ... is free of malware". The flag
  # records where the *stock* app was downloaded from; it says nothing about a
  # bundle we just built locally out of an app already installed and trusted.
  xattr -dr com.apple.quarantine "$dup"
  echo "  done."
}

# The work blue: #1b91e3, sampled off Claude's hue-rotated starburst so all
# three icons land on the same colour. sRGB, since that's what ramp.js takes.
BLUE="0.106,0.569,0.890"

missing=()

# Claude: orange starburst icon -> navy (hue rotate + darken)
if [ -d "/Applications/Claude.app" ]; then
  sips -s format png -Z 1024 "/Applications/Claude.app/Contents/Resources/electron.icns" --out "$WORK/claude-base.png" >/dev/null
  # Hue only, no gamma: darkening the whole image was crushing the drop shadow
  # and leaving the cream starburst with a dirty blue-grey cast.
  osascript -l JavaScript "$WORK/recolor.js" "$WORK/claude-base.png" "$WORK/claude-navy.png" 220 1.15 1.0 >/dev/null
  build "/Applications/Claude.app" "/Applications/Claude Work.app" "Claude" "Claude Work" "$WORK/claude-navy.png" \
'#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/ClaudeMain" --user-data-dir="$HOME/Library/Application Support/Claude-Work" "$@"'
else
  missing+=("Claude.app")
fi

# ChatGPT: real displayed icon (black knot on white, via Assets.car) -> white knot on navy
if [ -d "/Applications/ChatGPT.app" ]; then
  osascript -l JavaScript "$WORK/geticon.js" "/Applications/ChatGPT.app" "$WORK/chatgpt-base.png" >/dev/null
  # Two stops are enough here: the knot is dark on a light field, so there's no
  # dark background detail to preserve. Dark -> white, light -> blue.
  osascript -l JavaScript "$WORK/ramp.js" "$WORK/chatgpt-base.png" "$WORK/chatgpt-navy.png" \
    - "1,1,1" "$BLUE" >/dev/null
  build "/Applications/ChatGPT.app" "/Applications/ChatGPT Work.app" "ChatGPT" "ChatGPT Work" "$WORK/chatgpt-navy.png" \
'#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$HOME/Library/Application Support/ChatGPT-Work"
mkdir -p "$PROFILE/codex"
export CODEX_HOME="$PROFILE/codex"
exec "$DIR/ChatGPTMain" --user-data-dir="$PROFILE" "$@"'
else
  missing+=("ChatGPT.app")
fi

# Grok Bot: light ghost on a near-black tile -> white ghost on navy.
# Grayscale like ChatGPT's knot, so hue rotation is a no-op and it takes the
# ramp; two stops the other way round, since here it's the *field* that's dark.
# The eyes sit at 0.13 and the tile at 0.19, so both land on the blue -- which
# is what the original does too, and they're far enough apart to read.
if [ -d "/Applications/Grok Bot.app" ]; then
  sips -s format png -Z 1024 "/Applications/Grok Bot.app/Contents/Resources/icon.icns" --out "$WORK/grok-base.png" >/dev/null
  osascript -l JavaScript "$WORK/ramp.js" "$WORK/grok-base.png" "$WORK/grok-navy.png" \
    - "$BLUE" "1,1,1" >/dev/null
  build "/Applications/Grok Bot.app" "/Applications/Grok Bot Work.app" "Grok Bot" "Grok Bot Work" "$WORK/grok-navy.png" \
'#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$HOME/Library/Application Support/Grok Bot-Work"
mkdir -p "$PROFILE/sand-data"
# --user-data-dir alone leaves the agent state behind: the app resolves its root
# with an empty argv, so the flag is invisible there and it falls back to
# ~/.grokbot. SAND_DATA_ROOT is the highest-precedence override and pins it to
# the same place the flag-aware paths compute.
export SAND_DATA_ROOT="$PROFILE/sand-data"
exec "$DIR/Grok BotMain" --user-data-dir="$PROFILE" "$@"'
else
  missing+=("Grok Bot.app")
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "Skipped -- stock app not installed: ${missing[*]}"
fi
echo "All work apps rebuilt."
