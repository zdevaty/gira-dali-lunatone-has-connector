#!/usr/bin/env sh
# Update the DALI Bridge app, from the Terminal app:
#
#     sh /addons/dali_bridge/update.sh
#
# Three steps, and the middle one is the trap. `ha apps rebuild` rebuilds the
# image from whatever source is on disk, but the Supervisor's picture of the app
# -- its version, whether it has an ingress panel, what options it takes -- comes
# from a store index that only `ha store reload` refreshes. Skip it and you get a
# container running new code while Home Assistant still describes the old
# manifest, with no error anywhere to say so.

set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
SLUG="local_dali_bridge"

echo "==> pulling into $DIR"
git -C "$DIR" pull --ff-only

WANTED="$(sed -n 's/^version: *"\(.*\)"/\1/p' "$DIR/config.yaml")"
echo "==> config.yaml declares $WANTED"

echo "==> refreshing the Supervisor's store index"
ha store reload

echo "==> updating $SLUG"
ha apps update "$SLUG" || ha apps rebuild "$SLUG"

echo "==> installed now:"
ha apps info "$SLUG" | grep -iE '^version|^state' || true
echo
echo "If the version above is not $WANTED, the store index is still stale."
echo "Uninstall and reinstall from the App store; /data and your options survive it."
