#!/bin/bash
# Builds the Family Hub app for Samsung (Tizen) TVs and, optionally, installs it.
#
#   ./build.sh                     stage build/stage/ (enough to preview in a browser)
#   ./build.sh --package           also sign it into build/FamilyHub.wgt (needs Tizen Studio)
#   ./build.sh --install [IP …]    package, then install and start it on each TV
#                                  (default: every TV in TIZEN_TVS)
#   ./build.sh --duid IP           print a TV's unique id (DUID), for the certificate
#
# Settings come from tizen.env, outside the repo:
#   ${FAMILY_HUB_TIZEN_ENV:-~/.config/family-hub/tizen.env}
# See README.md. The hub URL and service token are baked into the package, so keep
# build/ private (it's gitignored).
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${FAMILY_HUB_TIZEN_ENV:-$HOME/.config/family-hub/tizen.env}"
# shellcheck disable=SC1090
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"
: "${HUB_URL:=}" "${HUB_VIEW:=family}" "${CF_ACCESS_CLIENT_ID:=}" "${CF_ACCESS_CLIENT_SECRET:=}"
: "${TIZEN_TVS:=}" "${TIZEN_PROFILE:=family-hub}" "${TIZEN_PACKAGE:=FamHubTV01}"
: "${TIZEN_STUDIO:=$HOME/tizen-studio}"
TIZEN="$TIZEN_STUDIO/tools/ide/bin/tizen"
SDB="$TIZEN_STUDIO/tools/sdb"
VERSION="$(node -p 'require("../../package.json").version' 2>/dev/null || echo 1.0.0)"

json_string() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }

need_tizen() {
  if [[ ! -x "$TIZEN" || ! -x "$SDB" ]]; then
    echo "Tizen Studio's command-line tools aren't at $TIZEN_STUDIO. See README.md, step 2." >&2
    exit 1
  fi
}

connect() {  # connect sdb to a TV and print its device serial
  local ip="$1"
  "$SDB" connect "$ip:26101" >/dev/null
  "$SDB" devices | awk -v ip="$ip" 'index($1, ip) == 1 { print $1; exit }'
}

stage() {
  rm -rf build/stage && mkdir -p build/stage
  cp src/* build/stage/
  sed -e "s/__PACKAGE__/$TIZEN_PACKAGE/g" -e "s/__VERSION__/$VERSION/" src/config.xml > build/stage/config.xml
  {
    printf 'window.FAMILY_HUB = {\n'
    printf '  hubUrl: %s,\n' "$(json_string "$HUB_URL")"
    printf '  view: %s,\n' "$(json_string "$HUB_VIEW")"
    printf '  clientId: %s,\n' "$(json_string "$CF_ACCESS_CLIENT_ID")"
    printf '  clientSecret: %s\n' "$(json_string "$CF_ACCESS_CLIENT_SECRET")"
    printf '};\n'
  } > build/stage/config.js
  [[ -z "$HUB_URL" ]] && echo "Warning: HUB_URL is empty in $ENV_FILE; the app will say no hub is set up." >&2
  echo "Staged build/stage/ (Family Hub $VERSION, package $TIZEN_PACKAGE)"
}

package() {
  need_tizen
  rm -f build/*.wgt
  # The tizen tool resolves relative paths from its own folder, so pass absolute ones.
  local out
  if ! out="$("$TIZEN" package -t wgt -s "$TIZEN_PROFILE" -o "$PWD/build" -- "$PWD/build/stage" 2>&1)"; then
    echo "$out" >&2; exit 1
  fi
  local wgt; wgt="$(ls build/*.wgt 2>/dev/null | head -1)"
  if [[ -z "$wgt" ]]; then echo "$out" >&2; echo "Signing produced no package. Is the \"$TIZEN_PROFILE\" certificate profile set up?" >&2; exit 1; fi
  [[ "$wgt" != build/FamilyHub.wgt ]] && mv "$wgt" build/FamilyHub.wgt
  echo "Signed build/FamilyHub.wgt with certificate profile \"$TIZEN_PROFILE\""
}

install_on() {
  local ip="$1" serial
  serial="$(connect "$ip")"
  if [[ -z "$serial" ]]; then
    echo "✗ $ip: couldn't connect. Is Developer Mode on with this computer's IP as the host, and was the TV restarted?" >&2
    return 1
  fi
  local out
  if ! out="$("$TIZEN" install -n "$PWD/build/FamilyHub.wgt" -s "$serial" 2>&1)" || grep -qiE "fail|error" <<< "$out"; then
    echo "✗ $ip: install failed:" >&2; echo "$out" | tail -5 >&2; return 1
  fi
  "$TIZEN" run -p "$TIZEN_PACKAGE.FamilyHub" -s "$serial" >/dev/null 2>&1 || true
  echo "✓ $ip: installed and started"
}

case "${1:-}" in
  --duid)
    need_tizen
    serial="$(connect "${2:?Usage: ./build.sh --duid <TV IP>}")"
    [[ -z "$serial" ]] && { echo "Couldn't connect to ${2}." >&2; exit 1; }
    "$SDB" -s "$serial" shell 0 getduid
    ;;
  --package) stage; package ;;
  --install)
    shift
    tvs=("$@"); [[ ${#tvs[@]} -eq 0 ]] && read -r -a tvs <<< "$TIZEN_TVS"
    [[ ${#tvs[@]} -eq 0 ]] && { echo "Name the TVs: ./build.sh --install <IP> …, or set TIZEN_TVS in $ENV_FILE" >&2; exit 1; }
    stage; package
    failed=0
    for ip in "${tvs[@]}"; do install_on "$ip" || failed=1; done
    exit $failed
    ;;
  "") stage ;;
  *) echo "Unknown option $1. See the top of build.sh." >&2; exit 1 ;;
esac
