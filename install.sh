#!/usr/bin/env bash
set -euo pipefail

MANIFEST_URL="${REMOTE_OC_RELEASE_MANIFEST_URL:-}"
ENROLL_URL=""
MANIFEST_PATH=""
HUB_URL=""
PAIRING_CODE=""
DEVICE_NAME="$(hostname)"
NO_AUTOSTART=0
INSTALL_DIR="${HOME}/.local/share/remote-openclaw"
CONFIG_PATH="${HOME}/.remote-oc/device.json"
OPENCLAW_URL="ws://127.0.0.1:18789"
HERMES_URL="http://127.0.0.1:8642"
HERMES_API_KEY="${HERMES_API_KEY:-}"
HERMES_MODEL="${HERMES_MODEL:-}"
HERMES_PROVIDER="${HERMES_PROVIDER:-}"
HERMES_EXECUTABLE="hermes"
HERMES_WORKING_DIRECTORY=""
DEFAULT_RUNTIME="openclaw"
REQUIRE_HERMES=0
START_HERMES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url) MANIFEST_URL="$2"; shift 2 ;;
    --manifest-path) MANIFEST_PATH="$2"; shift 2 ;;
    --enroll-url) ENROLL_URL="$2"; shift 2 ;;
    --hub-url) HUB_URL="$2"; shift 2 ;;
    --pairing-code) PAIRING_CODE="$2"; shift 2 ;;
    --device-name) DEVICE_NAME="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --config-path) CONFIG_PATH="$2"; shift 2 ;;
    --openclaw-url) OPENCLAW_URL="$2"; shift 2 ;;
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
fail() { echo "install failed: $1" >&2; exit 1; }
say() { printf '\n[Remote-OC] %s\n' "$1" >&2; }
download() {
  local url="$1" output="$2" label="${3:-下载}"
  say "$label"
  curl --http1.1 --retry 3 --retry-delay 2 --retry-all-errors --fail --show-error --location --connect-timeout 15 --max-time 300 --progress-bar "$url" -o "$output" || fail "download failed: $url"
}
if [[ -n "$ENROLL_URL" ]]; then
  command -v plutil >/dev/null 2>&1 || fail 'macOS plutil is required'
  enrollment_file="$(mktemp)"
  trap 'rm -f "${enrollment_file:-}"; if [[ -n "${TEMP_ROOT:-}" ]]; then rm -rf "$TEMP_ROOT"; fi' EXIT
  say '正在获取安全安装配置'
  curl --http1.1 --retry 3 --retry-delay 2 --fail --show-error --location --connect-timeout 15 --max-time 60 -X POST -H 'Content-Type: application/json' "$ENROLL_URL" -o "$enrollment_file" || fail 'unable to obtain installation configuration'
  json_value() { plutil -extract "$1" raw -o - "$enrollment_file" 2>/dev/null || true; }
  HUB_URL="$(json_value hubUrl)"; PAIRING_CODE="$(json_value pairingCode)"; DEVICE_NAME="$(json_value deviceName)"; MANIFEST_URL="$(json_value manifestUrl)"; OPENCLAW_URL="$(json_value openClawUrl)"; HERMES_URL="$(json_value hermesUrl)"; DEFAULT_RUNTIME="$(json_value defaultRuntime)"
  enrolled_hermes_key="$(json_value hermesApiKey)"
  [[ -n "$enrolled_hermes_key" ]] && HERMES_API_KEY="$enrolled_hermes_key"
  [[ "$(json_value requireHermes)" == "true" ]] && REQUIRE_HERMES=1
  [[ "$(json_value startHermes)" == "true" ]] && START_HERMES=1
fi
SCRIPT_ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "$MANIFEST_URL" && -z "$MANIFEST_PATH" && -f "$SCRIPT_ROOT/release.json" ]]; then MANIFEST_PATH="$SCRIPT_ROOT/release.json"; fi
[[ "$(uname -s)" == "Darwin" ]] || fail 'use install.ps1 on Windows'
[[ -n "$MANIFEST_URL" || -n "$MANIFEST_PATH" ]] || fail 'manifest URL or path is required'
[[ -n "$HUB_URL" && -n "$PAIRING_CODE" ]] || fail 'Hub URL and pairing code or enroll URL are required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'
command -v plutil >/dev/null 2>&1 || fail 'plutil is required'

case "$(uname -m)" in
  arm64) PLATFORM="macos-arm64" ;;
  x86_64) PLATFORM="macos-x64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac
TEMP_ROOT="$(mktemp -d)"
trap 'rm -f "${enrollment_file:-}"; if [[ -n "${TEMP_ROOT:-}" ]]; then rm -rf "$TEMP_ROOT"; fi' EXIT
if [[ -n "$MANIFEST_PATH" ]]; then cp "$MANIFEST_PATH" "$TEMP_ROOT/release.json"; else download "$MANIFEST_URL" "$TEMP_ROOT/release.json" '正在获取版本清单'; fi
PACKAGE_URL="$(plutil -extract "platforms.$PLATFORM.url" raw -o - "$TEMP_ROOT/release.json" 2>/dev/null || true)"
EXPECTED_SHA="$(plutil -extract "platforms.$PLATFORM.sha256" raw -o - "$TEMP_ROOT/release.json" 2>/dev/null || true)"
[[ -n "$PACKAGE_URL" && ${#EXPECTED_SHA} -eq 64 ]] || fail "release manifest has no usable $PLATFORM package"
if [[ "$PACKAGE_URL" != /* && "$PACKAGE_URL" != https://* ]]; then
  if [[ -n "$MANIFEST_PATH" ]]; then PACKAGE_URL="$(cd "$(dirname "$MANIFEST_PATH")" && pwd)/$PACKAGE_URL"; else PACKAGE_URL="${MANIFEST_URL%/*}/$PACKAGE_URL"; fi
fi
if [[ -f "$PACKAGE_URL" ]]; then cp "$PACKAGE_URL" "$TEMP_ROOT/package.tar.gz"; elif [[ "$PACKAGE_URL" == https://* ]]; then download "$PACKAGE_URL" "$TEMP_ROOT/package.tar.gz" '正在下载 macOS 安装包'; else fail 'package URL must use HTTPS'; fi
say '正在校验安装包'
ACTUAL_SHA="$(shasum -a 256 "$TEMP_ROOT/package.tar.gz" | awk '{print $1}')"
ACTUAL_SHA="$(printf '%s' "$ACTUAL_SHA" | tr '[:upper:]' '[:lower:]')"
EXPECTED_SHA="$(printf '%s' "$EXPECTED_SHA" | tr '[:upper:]' '[:lower:]')"
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || fail 'release SHA-256 mismatch'
mkdir -p "$TEMP_ROOT/release"
say '正在解压并安装 Remote-OC'
tar -xzf "$TEMP_ROOT/package.tar.gz" -C "$TEMP_ROOT/release"
chmod 755 "$TEMP_ROOT/release/runtime/node" "$TEMP_ROOT/release/install-macos.sh" "$TEMP_ROOT/release/uninstall-macos.sh"
ARGS=(--package-root "$TEMP_ROOT/release" --hub-url "$HUB_URL" --pairing-code "$PAIRING_CODE" --device-name "$DEVICE_NAME" --install-dir "$INSTALL_DIR" --config-path "$CONFIG_PATH" --openclaw-url "$OPENCLAW_URL" --hermes-url "$HERMES_URL" --hermes-api-key "$HERMES_API_KEY" --hermes-model "$HERMES_MODEL" --hermes-provider "$HERMES_PROVIDER" --hermes-executable "$HERMES_EXECUTABLE" --hermes-working-directory "$HERMES_WORKING_DIRECTORY" --default-runtime "$DEFAULT_RUNTIME")
[[ "$NO_AUTOSTART" -eq 0 ]] || ARGS+=(--no-autostart)
[[ "$REQUIRE_HERMES" -eq 0 ]] || ARGS+=(--require-hermes)
[[ "$START_HERMES" -eq 0 ]] || ARGS+=(--start-hermes)
say '正在连接主控并启动 Agent'
exec "$TEMP_ROOT/release/install-macos.sh" "${ARGS[@]}"
