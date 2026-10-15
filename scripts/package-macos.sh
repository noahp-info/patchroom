#!/usr/bin/env bash
# Build, sign, verify, smoke-test and package Patchroom for macOS (docs/SPEC.md section 11).
#
# Signing:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: ..."  sign for distribution
#   (unset)                                                  ad-hoc sign, for local testing only
# Both use the hardened runtime and src-tauri/Entitlements.plist.
#
# Notarization runs only when credentials are set, either:
#   APPLE_API_KEY_PATH + APPLE_API_KEY + APPLE_API_ISSUER    (App Store Connect API key), or
#   APPLE_ID + APPLE_PASSWORD (app-specific) + APPLE_TEAM_ID
#
# Usage: scripts/package-macos.sh [out-dir]     (default /Users/$USER/Downloads)
# Output: <out-dir>/Patchroom-<version>-<sha>.dmg
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$HOME/Downloads}"
APP="${CARGO_TARGET_DIR:-$ROOT/target}/release/bundle/macos/Patchroom.app"
ENT="$ROOT/src-tauri/Entitlements.plist"
IDENTITY="${APPLE_SIGNING_IDENTITY:--}"

cd "$ROOT"
VERSION="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' src-tauri/tauri.conf.json)"
SHA="$(git rev-parse --short HEAD)"
DMG="$OUT_DIR/Patchroom-$VERSION-$SHA.dmg"

echo "== build"
pnpm tauri build --bundles app

# Tauri signs the main binary; sign every nested binary (sidecars first), then the bundle, so
# the hardened runtime and entitlements cover all of it. Never --deep for distribution signing.
echo "== sign ($([ "$IDENTITY" = "-" ] && echo ad-hoc || echo "$IDENTITY"))"
TS=()
[ "$IDENTITY" != "-" ] && TS=(--timestamp)
while IFS= read -r bin; do
  codesign --force --options runtime ${TS[@]+"${TS[@]}"} -s "$IDENTITY" "$bin"
done < <(find "$APP/Contents/MacOS" -type f -perm -u+x ! -name patchroom)
codesign --force --options runtime ${TS[@]+"${TS[@]}"} --entitlements "$ENT" -s "$IDENTITY" "$APP"

echo "== verify"
codesign --verify --deep --strict "$APP"
# Read into variables first: with pipefail, grep -q closing the pipe early fails the pipeline.
ENTS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null)"
INFO="$(codesign -dv "$APP" 2>&1)"
grep -q automation.apple-events <<<"$ENTS" || { echo "verify: entitlements missing"; exit 1; }
grep -q 'flags=.*runtime' <<<"$INFO" || { echo "verify: hardened runtime missing"; exit 1; }
echo "signature, hardened runtime and entitlements ok"

echo "== smoke"
DATA="$(mktemp -d /tmp/pr-smoke.XXXX)"
PATCHROOM_DATA_DIR="$DATA" "$APP/Contents/MacOS/patchroom" >/dev/null 2>&1 &
PID=$!
sleep 6
# lsof exits 1 when it finds nothing, which is the result we want.
LSOF="$(lsof -nP -a -p "$PID" -iTCP -sTCP:LISTEN 2>/dev/null || true)"
LISTEN="$(grep -c LISTEN <<<"$LSOF" || true)"
SOCK="$(find "$DATA" -name '*.sock' | wc -l | tr -d ' ')"
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
[ "$LISTEN" = 0 ] || { echo "smoke: $LISTEN network listener(s)"; exit 1; }
[ "$SOCK" -ge 1 ] || { echo "smoke: no bridge socket"; exit 1; }
echo "launched, bridge socket up, no network listeners"

echo "== dmg"
mkdir -p "$OUT_DIR"
rm -f "$DMG"
hdiutil create -quiet -volname Patchroom -srcfolder "$APP" -ov -format UDZO "$DMG"
[ "$IDENTITY" != "-" ] && codesign --force --timestamp -s "$IDENTITY" "$DMG"

if [ -n "${APPLE_API_KEY_PATH:-}" ] || [ -n "${APPLE_ID:-}" ]; then
  echo "== notarize"
  if [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    xcrun notarytool submit "$DMG" --wait \
      --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
  else
    xcrun notarytool submit "$DMG" --wait \
      --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
  fi
  xcrun stapler staple "$DMG"
  spctl -a -t open --context context:primary-signature -v "$DMG"
else
  echo "== notarize: skipped (no credentials set)"
fi
echo "$DMG"
