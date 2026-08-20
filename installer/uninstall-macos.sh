#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${HOME}/.local/share/remote-openclaw"
CONFIG_PATH="${HOME}/.remote-oc/device.json"
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --config-path) CONFIG_PATH="$2"; shift 2 ;;
    --keep-identity) KEEP=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
PLIST="$HOME/Library/LaunchAgents/com.remote-oc.client.plist"
HERMES_PLIST="$HOME/Library/LaunchAgents/com.remote-oc.hermes-gateway.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl unload -w "$PLIST" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)" "$HERMES_PLIST" >/dev/null 2>&1 || true
launchctl unload -w "$HERMES_PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
rm -f "$HERMES_PLIST"
rm -rf "$INSTALL_DIR"
[[ "$KEEP" -eq 1 ]] || rm -f "$CONFIG_PATH"
printf '{"ok":true,"removed":"%s","identityKept":%s}\n' "$INSTALL_DIR" "$([[ "$KEEP" -eq 1 ]] && echo true || echo false)"
