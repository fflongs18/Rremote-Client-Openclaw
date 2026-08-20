#!/usr/bin/env bash
set -euo pipefail

HUB_URL=""
PAIRING_CODE=""
DEVICE_NAME="$(hostname)"
PACKAGE_ROOT="${PACKAGE_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
INSTALL_DIR="${HOME}/.local/share/remote-openclaw"
CONFIG_PATH="${HOME}/.remote-oc/device.json"
OPENCLAW_URL="ws://127.0.0.1:18789"
HERMES_URL="http://127.0.0.1:8642"
DEFAULT_RUNTIME="openclaw"
OPENCLAW_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
HERMES_API_KEY="${HERMES_API_KEY:-}"
HERMES_MODEL="${HERMES_MODEL:-}"
HERMES_PROVIDER="${HERMES_PROVIDER:-}"
HERMES_EXECUTABLE="hermes"
HERMES_WORKING_DIRECTORY=""
NO_AUTOSTART=0
REQUIRE_HERMES=0
START_HERMES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-url) HUB_URL="$2"; shift 2 ;;
    --pairing-code) PAIRING_CODE="$2"; shift 2 ;;
    --device-name) DEVICE_NAME="$2"; shift 2 ;;
    --package-root) PACKAGE_ROOT="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --config-path) CONFIG_PATH="$2"; shift 2 ;;
    --openclaw-url) OPENCLAW_URL="$2"; shift 2 ;;
    --openclaw-token) OPENCLAW_TOKEN="$2"; shift 2 ;;
    --hermes-url) HERMES_URL="$2"; shift 2 ;;
    --hermes-api-key) HERMES_API_KEY="$2"; shift 2 ;;
    --hermes-model) HERMES_MODEL="$2"; shift 2 ;;
    --hermes-provider) HERMES_PROVIDER="$2"; shift 2 ;;
    --hermes-executable) HERMES_EXECUTABLE="$2"; shift 2 ;;
    --hermes-working-directory) HERMES_WORKING_DIRECTORY="$2"; shift 2 ;;
    --default-runtime) DEFAULT_RUNTIME="$2"; shift 2 ;;
    --require-hermes) REQUIRE_HERMES=1; shift ;;
    --start-hermes) START_HERMES=1; shift ;;
    --no-autostart) NO_AUTOSTART=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() {
  echo "{\"ok\":false,\"stage\":\"failed\",\"error\":\"$1\"}"
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail 'install-macos.sh must run on macOS'
[[ -n "$HUB_URL" && -n "$PAIRING_CODE" ]] || fail 'Hub URL and one-time pairing code are required'
NODE_PATH="$PACKAGE_ROOT/runtime/node"
APP_ROOT="$PACKAGE_ROOT/app"
[[ -x "$NODE_PATH" ]] || fail 'Release is missing runtime/node'
[[ -f "$APP_ROOT/client/dist/pair.js" ]] || fail 'Release is missing the built client'
[[ -f "$APP_ROOT/node_modules/@remote-oc/protocol/package.json" ]] || fail 'Release is missing @remote-oc/protocol'
"$NODE_PATH" --input-type=module --eval 'import fs from "node:fs";import path from "node:path";import crypto from "node:crypto";const root=process.argv[1],raw=fs.readFileSync(path.join(root,"manifest.json"),"utf8").replace(/^\uFEFF/,""),m=JSON.parse(raw);for(const f of m.files){const p=path.join(root,f.path),h=crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");if(h!==f.sha256)throw new Error(`Release checksum mismatch: ${f.path}`)}' "$PACKAGE_ROOT" || fail 'Release manifest validation failed'

test_hermes() {
  local auth=()
  [[ -z "$HERMES_API_KEY" ]] || auth=(-H "Authorization: Bearer $HERMES_API_KEY")
  curl -fsS --max-time 5 "${auth[@]}" "${HERMES_URL%/}/v1/capabilities" | "$NODE_PATH" --input-type=module --eval 'let s="";for await(const c of process.stdin)s+=c;const f=JSON.parse(s).features||{};if(!(f.run_submission===true&&f.run_events_sse===true&&f.run_stop===true))process.exit(1)'
}
if [[ "$REQUIRE_HERMES" -eq 1 || "$START_HERMES" -eq 1 ]]; then
  [[ ${#HERMES_API_KEY} -ge 16 ]] || fail 'Hermes API key must contain at least 16 characters'
  if ! test_hermes && [[ "$START_HERMES" -eq 1 ]]; then
    command -v "$HERMES_EXECUTABLE" >/dev/null 2>&1 || fail 'Hermes executable was not found'
    HERMES_PORT="$($NODE_PATH --input-type=module --eval 'console.log(new URL(process.argv[1]).port||8642)' "$HERMES_URL")"
    if [[ -n "$HERMES_WORKING_DIRECTORY" ]]; then cd "$HERMES_WORKING_DIRECTORY"; fi
    API_SERVER_ENABLED=true API_SERVER_HOST=127.0.0.1 API_SERVER_PORT="$HERMES_PORT" API_SERVER_KEY="$HERMES_API_KEY" nohup "$HERMES_EXECUTABLE" gateway >/dev/null 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do test_hermes && break; sleep 1; done
  fi
  test_hermes || fail 'Hermes Runs API is not ready'
fi

mkdir -p "$INSTALL_DIR" "$(dirname "$CONFIG_PATH")"
rm -rf "$INSTALL_DIR/app" "$INSTALL_DIR/runtime"
cp -R "$APP_ROOT" "$INSTALL_DIR/app"
cp -R "$PACKAGE_ROOT/runtime" "$INSTALL_DIR/runtime"
cp "$PACKAGE_ROOT/uninstall-macos.sh" "$INSTALL_DIR/uninstall-macos.sh"
chmod 700 "$INSTALL_DIR/uninstall-macos.sh"
INSTALLED_NODE="$INSTALL_DIR/runtime/node"
INSTALLED_APP="$INSTALL_DIR/app"
export REMOTE_CLIENT_CONFIG="$CONFIG_PATH"
export REMOTE_OC_PAIRING_CODE="$PAIRING_CODE"
export OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_TOKEN"
export HERMES_API_KEY="$HERMES_API_KEY"
export HERMES_MODEL="$HERMES_MODEL"
export HERMES_PROVIDER="$HERMES_PROVIDER"
REUSE_IDENTITY=0
if [[ -f "$CONFIG_PATH" ]] && "$INSTALLED_NODE" --input-type=module --eval 'import fs from "node:fs";const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),hub=process.argv[2].replace(/\/$/,"");process.exit(c.nodeName===process.argv[3]&&c.hubHttpUrl===hub?0:1)' "$CONFIG_PATH" "$HUB_URL" "$DEVICE_NAME"; then
  REUSE_IDENTITY=1
fi
if [[ "$REUSE_IDENTITY" -eq 0 ]]; then
  (cd "$INSTALLED_APP" && "$INSTALLED_NODE" "$INSTALLED_APP/client/dist/pair.js" --hub-url "$HUB_URL" --name "$DEVICE_NAME" --gateway-url "$OPENCLAW_URL" --hermes-url "$HERMES_URL") || fail 'Pairing failed'
fi
chmod 600 "$CONFIG_PATH" 2>/dev/null || true

# Public controllers terminate Agent WebSockets at /ws. Repair identities created by
# older installers that paired successfully before this path was included.
"$INSTALLED_NODE" --input-type=module --eval 'import fs from "node:fs";const p=process.argv[1],hub=process.argv[2],raw=JSON.parse(fs.readFileSync(p,"utf8"));const base=new URL(hub);base.protocol=base.protocol==="https:"?"wss:":"ws:";base.pathname="/ws";base.search="";base.hash="";raw.hubWsUrl=base.toString().replace(/\/$/,"");fs.writeFileSync(p,`${JSON.stringify(raw,null,2)}\n`,{mode:0o600});' "$CONFIG_PATH" "$HUB_URL" || fail 'Unable to configure Hub WebSocket endpoint'

LAUNCHER="$INSTALL_DIR/run-client.sh"
printf '#!/usr/bin/env bash\nexport REMOTE_CLIENT_CONFIG=%q\nexport AGENT_RUNTIME=%q\nexec %q %q\n' "$CONFIG_PATH" "$DEFAULT_RUNTIME" "$INSTALLED_NODE" "$INSTALLED_APP/client/dist/index.js" > "$LAUNCHER"
chmod 700 "$LAUNCHER"
AUTOSTART=none
if [[ "$NO_AUTOSTART" -eq 0 ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.remote-oc.client.plist"
  mkdir -p "$(dirname "$PLIST")"
  XML_LAUNCHER="$(printf '%s' "$LAUNCHER" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>com.remote-oc.client</string><key>ProgramArguments</key><array><string>$XML_LAUNCHER</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl load -w "$PLIST" >/dev/null 2>&1; then
    AUTOSTART=launchd
  else
    rm -f "$PLIST"
    fail 'launchd registration failed'
  fi
fi
if [[ "$NO_AUTOSTART" -eq 0 ]]; then
  REMOTE_CLIENT_CONFIG="$CONFIG_PATH" "$INSTALLED_NODE" "$INSTALLED_APP/client/dist/verify-install.js" --mode online --timeout-ms 30000 || fail 'Hub did not report the installed device online'
fi
printf '{"ok":true,"stage":"complete","installDir":"%s","configPath":"%s","autostart":"%s"}\n' "$INSTALL_DIR" "$CONFIG_PATH" "$AUTOSTART"
