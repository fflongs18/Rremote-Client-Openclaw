#!/usr/bin/env bash
set -euo pipefail

MODE="check"
HUB_URL="${REMOTE_OC_HUB_URL:-}"
PAIRING_CODE="${REMOTE_OC_PAIRING_CODE:-}"
DEVICE_NAME="$(hostname)"
SOURCE_URL="${REMOTE_OC_SOURCE_URL:-}"
SOURCE_ROOT=""
INSTALL_DIR="${HOME}/.local/share/remote-openclaw"
CONFIG_PATH="${HOME}/.remote-oc/device.json"
OPENCLAW_URL="ws://127.0.0.1:18789"
OPENCLAW_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
HERMES_URL="http://127.0.0.1:8642"
HERMES_API_KEY="${HERMES_API_KEY:-}"
HERMES_MODEL="${HERMES_MODEL:-}"
HERMES_PROVIDER="${HERMES_PROVIDER:-}"
NO_AUTOSTART=0
KEEP_IDENTITY=0
SKIP_RUNTIME_PROBE=0
TEST_MODE=0
STEPS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2,,}"; shift 2 ;;
    --hub-url) HUB_URL="$2"; shift 2 ;;
    --pairing-code) PAIRING_CODE="$2"; shift 2 ;;
    --device-name) DEVICE_NAME="$2"; shift 2 ;;
    --source-url) SOURCE_URL="$2"; shift 2 ;;
    --source-root) SOURCE_ROOT="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --config-path) CONFIG_PATH="$2"; shift 2 ;;
    --openclaw-url) OPENCLAW_URL="$2"; shift 2 ;;
    --openclaw-token) OPENCLAW_TOKEN="$2"; shift 2 ;;
    --hermes-url) HERMES_URL="$2"; shift 2 ;;
    --hermes-api-key) HERMES_API_KEY="$2"; shift 2 ;;
    --hermes-model) HERMES_MODEL="$2"; shift 2 ;;
    --hermes-provider) HERMES_PROVIDER="$2"; shift 2 ;;
    --no-autostart) NO_AUTOSTART=1; shift ;;
    --keep-identity) KEEP_IDENTITY=1; shift ;;
    --skip-runtime-probe) SKIP_RUNTIME_PROBE=1; shift ;;
    --test-mode) TEST_MODE=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in check|install|verify|repair|uninstall) ;; *) echo 'Mode must be check, install, verify, repair, or uninstall' >&2; exit 2 ;; esac

step() { STEPS+=("$1"); }
json_result() {
  local ok="$1" stage="$2" error="${3:-}" runtime_openclaw="${4:-unknown}" runtime_hermes="${5:-unknown}"
  RESULT_OK="$ok" RESULT_STAGE="$stage" RESULT_ERROR="$error" RESULT_MODE="$MODE" RESULT_INSTALL="$INSTALL_DIR" RESULT_CONFIG="$CONFIG_PATH" RESULT_OPENCLAW="$runtime_openclaw" RESULT_HERMES="$runtime_hermes" RESULT_STEPS="$(IFS=,; echo "${STEPS[*]}")" \
    node -e 'const e=process.env; console.log(JSON.stringify({ok:e.RESULT_OK==="true",mode:e.RESULT_MODE,stage:e.RESULT_STAGE,steps:e.RESULT_STEPS?e.RESULT_STEPS.split(","):[],installDir:e.RESULT_INSTALL,configPath:e.RESULT_CONFIG,runtimes:{openclaw:e.RESULT_OPENCLAW,hermes:e.RESULT_HERMES},...(e.RESULT_ERROR?{error:e.RESULT_ERROR}:{})}))'
}
fail() { json_result false failed "$1"; exit 1; }
trap 'fail "bootstrap failed at line $LINENO"' ERR

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" -ge 22 ]]; then step node-ready; return; fi
  fi
  command -v curl >/dev/null 2>&1 || { echo 'curl is required to bootstrap Node.js' >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo 'tar is required to bootstrap Node.js' >&2; exit 1; }
  local os arch pattern runtime checksum_file archive expected actual extracted
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in linux|darwin) ;; *) echo "Unsupported operating system for portable Node.js: $os" >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo 'Unsupported CPU architecture' >&2; exit 1 ;; esac
  pattern="-${os}-${arch}.tar.gz"
  runtime="$INSTALL_DIR/runtime"
  mkdir -p "$runtime"
  checksum_file="$runtime/SHASUMS256.txt"
  curl -fsSL 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -o "$checksum_file"
  archive="$(awk -v p="$pattern" '$2 ~ p"$" {print $2; exit}' "$checksum_file")"
  [[ -n "$archive" ]] || { echo 'Unable to resolve a Node.js 22 archive' >&2; exit 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$archive" -o "$runtime/$archive"
  expected="$(awk -v f="$archive" '$2==f {print $1}' "$checksum_file")"
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$runtime/$archive" | awk '{print $1}')"; else actual="$(shasum -a 256 "$runtime/$archive" | awk '{print $1}')"; fi
  [[ "$expected" == "$actual" ]] || { echo 'Portable Node.js checksum mismatch' >&2; exit 1; }
  tar -xzf "$runtime/$archive" -C "$runtime"
  extracted="$runtime/${archive%.tar.gz}"
  export PATH="$extracted/bin:$PATH"
  rm -f "$runtime/$archive" "$checksum_file"
  step node-installed
}
tcp_probe() {
  local url="$1"
  node -e 'const net=require("net"),u=new URL(process.argv[1]),p=Number(u.port)||(u.protocol==="wss:"?443:80),s=net.connect(p,u.hostname);s.setTimeout(1200);s.on("connect",()=>{s.end();process.exit(0)});s.on("timeout",()=>process.exit(1));s.on("error",()=>process.exit(1))' "$url" >/dev/null 2>&1
}
runtime_state() {
  if [[ "$TEST_MODE" -eq 1 ]]; then RUNTIME_OPENCLAW=ready; RUNTIME_HERMES=ready; return; fi
  if tcp_probe "$OPENCLAW_URL"; then RUNTIME_OPENCLAW=ready; else RUNTIME_OPENCLAW=unavailable; fi
  local headers=()
  [[ -n "$HERMES_API_KEY" ]] && headers=(-H "Authorization: Bearer $HERMES_API_KEY")
  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 3 "${headers[@]}" "${HERMES_URL%/}/v1/capabilities" >/dev/null; then RUNTIME_HERMES=ready; else RUNTIME_HERMES=unavailable; fi
}
resolve_source() {
  if [[ -n "$SOURCE_ROOT" ]]; then (cd "$SOURCE_ROOT" && pwd); return; fi
  local local_root
  local_root="$(cd "$(dirname "$0")" && pwd)"
  if [[ -f "$local_root/package.json" ]]; then echo "$local_root"; return; fi
  [[ -n "$SOURCE_URL" ]] || fail 'SourceUrl is required when the bootstrap script is not inside the Remote Client repository'
  command -v curl >/dev/null 2>&1 || fail 'curl is required to download Remote Client source'
  command -v unzip >/dev/null 2>&1 || fail 'unzip is required to unpack Remote Client source'
  local temp archive package
  temp="$(mktemp -d)"; archive="$temp/source.zip"
  curl -fsSL "$SOURCE_URL" -o "$archive"
  unzip -q "$archive" -d "$temp"
  package="$(find "$temp" -name package.json -not -path '*/node_modules/*' -print -quit)"
  [[ -n "$package" ]] || fail 'Downloaded source does not contain package.json'
  step source-downloaded
  dirname "$package"
}
copy_source() {
  local from="$1"
  mkdir -p "$INSTALL_DIR"
  if [[ "$(cd "$from" && pwd)" != "$(cd "$INSTALL_DIR" && pwd)" ]]; then
    (cd "$from" && tar --exclude=.git --exclude=node_modules --exclude=.tmp --exclude=artifacts -cf - .) | (cd "$INSTALL_DIR" && tar -xf -)
    step source-installed
  fi
}
build_client() {
  (cd "$INSTALL_DIR" && npm install --ignore-scripts --no-audit --no-fund && npm run build -w @remote-oc/protocol && npm run build -w @remote-oc/client)
  step client-built
}
write_test_config() {
  mkdir -p "$(dirname "$CONFIG_PATH")"
  CONFIG_PATH_ENV="$CONFIG_PATH" HUB_URL_ENV="$HUB_URL" DEVICE_NAME_ENV="$DEVICE_NAME" OPENCLAW_URL_ENV="$OPENCLAW_URL" HERMES_URL_ENV="$HERMES_URL" node - <<'NODE'
const fs=require('fs'),e=process.env;
fs.writeFileSync(e.CONFIG_PATH_ENV,JSON.stringify({version:1,nodeId:'remote-oc-test-node',nodeToken:'test-node-token',nodeName:e.DEVICE_NAME_ENV,hubWsUrl:e.HUB_URL_ENV.replace(/^http/,'ws'),hubHttpUrl:e.HUB_URL_ENV,openClaw:{url:e.OPENCLAW_URL_ENV,token:null},hermes:{url:e.HERMES_URL_ENV,apiKey:null,model:null,provider:null},createdAt:Date.now()},null,2)+'\n',{mode:0o600});
NODE
  step paired
}
pair_device() {
  if [[ -f "$CONFIG_PATH" && -z "$PAIRING_CODE" ]]; then step identity-reused; return; fi
  [[ -n "$HUB_URL" && -n "$PAIRING_CODE" ]] || fail 'HubUrl and one-time PairingCode are required for first installation'
  if [[ "$TEST_MODE" -eq 1 ]]; then write_test_config; return; fi
  if [[ "$HUB_URL" == http://* ]]; then export REMOTE_OC_ALLOW_INSECURE=1; fi
  REMOTE_CLIENT_CONFIG="$CONFIG_PATH" REMOTE_OC_PAIRING_CODE="$PAIRING_CODE" OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_TOKEN" HERMES_API_KEY="$HERMES_API_KEY" HERMES_MODEL="$HERMES_MODEL" HERMES_PROVIDER="$HERMES_PROVIDER" \
    node "$INSTALL_DIR/packages/apps/client/dist/pair.js" --hub-url "$HUB_URL" --name "$DEVICE_NAME" --gateway-url "$OPENCLAW_URL" --hermes-url "$HERMES_URL"
  step paired
}
install_autostart() {
  mkdir -p "$INSTALL_DIR"
  local launcher="$INSTALL_DIR/run-client.sh"
  printf '#!/usr/bin/env bash\nexport REMOTE_CLIENT_CONFIG=%q\nexec %q %q\n' "$CONFIG_PATH" "$(command -v node)" "$INSTALL_DIR/packages/apps/client/dist/index.js" > "$launcher"
  chmod 700 "$launcher"
  if [[ "$TEST_MODE" -eq 1 ]]; then printf '{"launcher":"%s"}\n' "$launcher" > "$INSTALL_DIR/autostart.test.json"
  elif [[ "$(uname -s)" == Darwin ]]; then
    local plist="$HOME/Library/LaunchAgents/com.remote-oc.client.plist"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.remote-oc.client</string><key>ProgramArguments</key><array><string>$launcher</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  elif command -v systemctl >/dev/null 2>&1; then
    local unit_dir="$HOME/.config/systemd/user" unit="$HOME/.config/systemd/user/remote-oc-client.service"
    mkdir -p "$unit_dir"
    printf '[Unit]\nDescription=OpenClaw/Hermes Remote Client\nAfter=network-online.target\n[Service]\nExecStart=%s\nRestart=always\nRestartSec=2\n[Install]\nWantedBy=default.target\n' "$launcher" > "$unit"
    systemctl --user daemon-reload
    systemctl --user enable --now remote-oc-client.service
  else
    fail 'Neither launchd nor systemd user services are available; rerun with --no-autostart'
  fi
  step autostart-installed
}
verify_install() {
  [[ -f "$CONFIG_PATH" ]] || fail 'Device config is missing; install and pair first'
  runtime_state
  if [[ "$SKIP_RUNTIME_PROBE" -eq 0 && "$RUNTIME_OPENCLAW" == unavailable && "$RUNTIME_HERMES" == unavailable ]]; then fail 'Neither OpenClaw nor Hermes is reachable'; fi
  if [[ "$TEST_MODE" -eq 0 ]]; then REMOTE_CLIENT_CONFIG="$CONFIG_PATH" node "$INSTALL_DIR/packages/apps/client/dist/verify-install.js" --mode wss; fi
  step verified
}
uninstall_client() {
  if [[ "$TEST_MODE" -eq 1 ]]; then rm -f "$INSTALL_DIR/autostart.test.json"
  elif [[ "$(uname -s)" == Darwin ]]; then
    local plist="$HOME/Library/LaunchAgents/com.remote-oc.client.plist"
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true; rm -f "$plist"
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now remote-oc-client.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/remote-oc-client.service"; systemctl --user daemon-reload || true
  fi
  step autostart-removed
  if [[ "$KEEP_IDENTITY" -eq 0 ]]; then rm -f "$CONFIG_PATH"; step identity-removed; fi
}

if [[ "$MODE" == uninstall ]]; then uninstall_client; json_result true complete; exit 0; fi
if [[ "$TEST_MODE" -eq 0 ]]; then ensure_node; else step node-ready; fi
runtime_state
if [[ "$MODE" == check ]]; then json_result true complete '' "$RUNTIME_OPENCLAW" "$RUNTIME_HERMES"; exit 0; fi
if [[ "$MODE" == install || "$MODE" == repair ]]; then
  if [[ "$TEST_MODE" -eq 1 ]]; then mkdir -p "$INSTALL_DIR"; step client-built; else source_path="$(resolve_source)"; copy_source "$source_path"; build_client; fi
  pair_device
  [[ "$NO_AUTOSTART" -eq 1 ]] || install_autostart
fi
verify_install
json_result true complete '' "$RUNTIME_OPENCLAW" "$RUNTIME_HERMES"
