#!/usr/bin/env bash
# Assemble the add-on directory and copy it to the Pi.
#
# The Supervisor builds with the add-on directory as the Docker context, so the
# manifest and the source have to end up side by side. This keeps the repo tidy
# and does the flattening at deploy time instead.
#
#   ./deploy/push.sh root@homeassistant.local
#
# Then in Home Assistant: Settings → Add-ons → Add-on Store → ⋮ Check for
# updates → Local add-ons → DALI Bridge. After a change, bump `version` in
# addon/config.yaml, run this again, and click Update.

set -euo pipefail

HOST="${1:?usage: push.sh user@host [remote-path]}"
DEST="${2:-/addons/dali_bridge}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -r "$ROOT/addon/." "$STAGE/"
cp "$ROOT/index.js" "$ROOT/package.json" "$STAGE/"
cp -r "$ROOT/lib" "$STAGE/lib"

# Belt and braces. The token lives in the environment, never in the tree, and
# this is the last point at which a mistake would leave the machine.
if grep -rlE 'eyJ[A-Za-z0-9_-]{20,}' "$STAGE" >/dev/null 2>&1; then
  echo "refusing to push: something token-shaped is in the payload" >&2
  exit 1
fi

echo "pushing $(du -sh "$STAGE" | cut -f1) to $HOST:$DEST"
rsync -az --delete "$STAGE/" "$HOST:$DEST/"
echo "done. In Home Assistant: Add-on Store -> Check for updates."
