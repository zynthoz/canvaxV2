#!/usr/bin/env bash
# Builds ready-to-install packages for every browser:
#   dist/canvax-chrome.zip   → Chrome / Edge / Brave / Opera / Arc ("Load unpacked" after unzipping)
#   dist/canvax-firefox.zip  → Firefox (about:debugging → "Load Temporary Add-on", or sign it for AMO)
#
# Usage: ./scripts/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/extension"
BUILD="$ROOT/build"
DIST="$ROOT/dist"

# ── Safety: never ship a hardcoded API key ─────────────────────────────────
if grep -qE '^const HARDCODED_KEY = "[^"]+"' "$SRC/background.js"; then
  echo "✗ HARDCODED_KEY in extension/background.js is not empty — refusing to build." >&2
  echo "  Clear it (const HARDCODED_KEY = \"\";) and try again." >&2
  exit 1
fi

VERSION="$(jq -r .version "$SRC/manifest.json")"
FF_VERSION="$(jq -r .version "$SRC/manifest.firefox.json")"
if [[ "$VERSION" != "$FF_VERSION" ]]; then
  echo "✗ Version mismatch: manifest.json=$VERSION, manifest.firefox.json=$FF_VERSION" >&2
  exit 1
fi

rm -rf "$BUILD" "$DIST"
mkdir -p "$BUILD/chrome" "$BUILD/firefox" "$DIST"

# Files shipped to users (everything except the alternate manifest).
FILES=(background.js overlay.js overlay.css icons)

for b in chrome firefox; do
  for f in "${FILES[@]}"; do cp -r "$SRC/$f" "$BUILD/$b/"; done
done
cp "$SRC/manifest.json"         "$BUILD/chrome/manifest.json"
cp "$SRC/manifest.firefox.json" "$BUILD/firefox/manifest.json"

# Flat archives (manifest.json at the root) so "Extract All" gives a folder you can load directly.
for b in chrome firefox; do
  (cd "$BUILD/$b" && zip -qr -X "$DIST/canvax-$b.zip" .)
done

echo "✓ Canvax v$VERSION"
ls -lh "$DIST" | tail -n +2 | awk '{print "  " $NF "  (" $5 ")"}'
