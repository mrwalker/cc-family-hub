#!/bin/bash
# Builds the Family Hub Roku channel and, optionally, sideloads it.
#
#   ./build.sh                 build build/family-hub-roku.zip
#   ./build.sh --install       build it and install it on the Roku (developer mode)
#   ./build.sh --screenshot F  save a screenshot of the running channel to F (a .jpg)
#
# Settings come from roku.env, outside the repo:
#   ${FAMILY_HUB_ROKU_ENV:-~/.config/family-hub/roku.env}
# See README.md for its contents. The hub URL and service token are baked into
# the package, so keep the zip private.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${FAMILY_HUB_ROKU_ENV:-$HOME/.config/family-hub/roku.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi
: "${HUB_URL:=}" "${HUB_VIEW:=family}" "${CF_ACCESS_CLIENT_ID:=}" "${CF_ACCESS_CLIENT_SECRET:=}"
: "${ROKU_HOST:=}" "${ROKU_DEV_PASSWORD:=}"

json_string() {  # minimal JSON string escaping
  local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"
}

need_roku() {
  if [[ -z "$ROKU_HOST" || -z "$ROKU_DEV_PASSWORD" ]]; then
    echo "Set ROKU_HOST and ROKU_DEV_PASSWORD in $ENV_FILE" >&2
    exit 1
  fi
}

screenshot() {
  need_roku
  local out="$1" page img
  page="$(curl -sS --digest -u "rokudev:$ROKU_DEV_PASSWORD" \
    --form-string mysubmit=Screenshot --form-string passwd= --form-string archive= \
    "http://$ROKU_HOST/plugin_inspect")"
  img="$(printf '%s' "$page" | grep -oE 'pkgs/dev\.(jpg|png)\?time=[0-9]+' | head -1)"
  if [[ -z "$img" ]]; then echo "The Roku didn't return a screenshot (is the channel running?)" >&2; exit 1; fi
  curl -sS --digest -u "rokudev:$ROKU_DEV_PASSWORD" -o "$out" "http://$ROKU_HOST/$img"
  echo "Saved $out"
}

if [[ "${1:-}" == "--screenshot" ]]; then
  screenshot "${2:-roku-screenshot.jpg}"
  exit 0
fi

if [[ -z "$HUB_URL" ]]; then
  echo "Warning: HUB_URL isn't set in $ENV_FILE; the channel will say no hub is set up." >&2
fi

VERSION="$(sed -nE 's/^ *"version": *"([^"]+)".*/\1/p' ../../package.json | head -1)"
IFS=. read -r MAJOR MINOR PATCH <<<"${VERSION:-0.0.0}"

STAGE=build/stage
ZIP=build/family-hub-roku.zip
rm -rf build && mkdir -p "$STAGE"
cp -R source components images "$STAGE/"
sed -e "s/__MAJOR__/$MAJOR/" -e "s/__MINOR__/$MINOR/" -e "s/__PATCH__/$PATCH/" manifest > "$STAGE/manifest"
{
  printf '{"url":%s,' "$(json_string "${HUB_URL%/}")"
  printf '"view":%s,' "$(json_string "$HUB_VIEW")"
  printf '"clientId":%s,' "$(json_string "$CF_ACCESS_CLIENT_ID")"
  printf '"clientSecret":%s}\n' "$(json_string "$CF_ACCESS_CLIENT_SECRET")"
} > "$STAGE/config.json"
(cd "$STAGE" && zip -qr "../$(basename "$ZIP")" .)
echo "Built $ZIP ($VERSION)"

if [[ "${1:-}" == "--install" ]]; then
  need_roku
  result="$(curl -sS --digest -u "rokudev:$ROKU_DEV_PASSWORD" \
    --form-string mysubmit=Install -F "archive=@$ZIP" \
    "http://$ROKU_HOST/plugin_install")"
  msg="$(printf '%s' "$result" | grep -oE '(Install Success|Identical to previous version|Install Failure[^<"]*|Application Received[^<"]*)' | head -1)"
  echo "Roku: ${msg:-$(printf '%s' "$result" | head -c 300)}"
  # Identical packages aren't reinstalled; relaunch so changes in roku.env still show.
  curl -sS -X POST "http://$ROKU_HOST:8060/launch/dev" >/dev/null || true
fi
