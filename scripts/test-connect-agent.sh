#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
INSTALL_DIR="$TEST_ROOT/app"
CONFIG_PATH="$TEST_ROOT/config/device.json"
trap 'rm -rf "$TEST_ROOT"' EXIT

run() {
  "$ROOT/connect-agent.sh" --mode "$1" --test-mode --install-dir "$INSTALL_DIR" --config-path "$CONFIG_PATH" "${@:2}"
}
assert_json() {
  node -e 'const v=JSON.parse(process.argv[1]);if(!v.ok)process.exit(1)' "$1"
}

check="$(run check)"; assert_json "$check"
if run install >/dev/null 2>&1; then echo 'Install without pairing details unexpectedly succeeded' >&2; exit 1; fi
install="$(run install --hub-url https://hub.test.example --pairing-code ONE-TIME-CODE --device-name 'Bootstrap Test')"; assert_json "$install"
[[ -f "$CONFIG_PATH" && -f "$INSTALL_DIR/autostart.test.json" ]]
node -e 'const f=require(process.argv[1]);if(f.openClaw.url!=="ws://127.0.0.1:18789"||f.hermes.url!=="http://127.0.0.1:8642")process.exit(1)' "$CONFIG_PATH"
verify="$(run verify)"; assert_json "$verify"
repair="$(run repair)"; assert_json "$repair"
keep="$(run uninstall --keep-identity)"; assert_json "$keep"; [[ -f "$CONFIG_PATH" ]]
remove="$(run uninstall)"; assert_json "$remove"; [[ ! -f "$CONFIG_PATH" ]]
printf '{"ok":true,"tests":7,"platform":"unix"}\n'
