#!/bin/bash
# Builds "Family Hub.app" (a menu bar app) into app/macos/build/.
#
#   ./build-app.sh             build it
#   ./build-app.sh --install   build it, copy it to ~/Applications, and open it
#
# Needs the Xcode command line tools (xcode-select --install). Set BUNDLE_ID to
# change the app's identifier (it keys its settings and Keychain access).
set -euo pipefail
cd "$(dirname "$0")"

BUNDLE_ID="${BUNDLE_ID:-io.github.cc-family-hub.menu}"
VERSION="$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' ../../package.json | head -1)"
APP="build/Family Hub.app"

ARCHS=(--arch arm64 --arch x86_64)
swift build -c release "${ARCHS[@]}"
BIN="$(swift build -c release "${ARCHS[@]}" --show-bin-path)/FamilyHubMenu"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Family Hub"
sed -e "s/__BUNDLE_ID__/$BUNDLE_ID/" -e "s/__VERSION__/${VERSION:-0.0.0}/" Info.plist > "$APP/Contents/Info.plist"
# Ad-hoc signature: enough to run on the Mac that built it.
codesign --force --sign - "$APP"
echo "Built $APP ($BUNDLE_ID $VERSION)"

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  osascript -e 'tell application id "'"$BUNDLE_ID"'" to quit' >/dev/null 2>&1 || true
  rm -rf "$HOME/Applications/Family Hub.app"
  ditto "$APP" "$HOME/Applications/Family Hub.app"
  open "$HOME/Applications/Family Hub.app"
  echo "Installed to ~/Applications/Family Hub.app"
fi
