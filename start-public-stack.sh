#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HUB_PATH="${HUB_PATH:-$(cd "$ROOT/.." && pwd)/xihe-jianmu-ipc}"
PUBLIC_HTTP_URL="${PUBLIC_HTTP_URL:-}"
DOMAIN="${DOMAIN:-}"
HUB_PORT="${HUB_PORT:-${IPC_PORT:-3179}}"
BFF_PORT="${BFF_PORT:-}"
STATE_DIR="${STATE_DIR:-$HOME/.remote-oc/public-stack}"
SKIP_NGROK="${SKIP_NGROK:-0}"
DEFAULT_DOMAIN="carpenter-tyke-similarly.ngrok-free.dev"
DEFAULT_BFF_PORT="8788"

dotenv_get() {
  local key="$1" file="$ROOT/.env"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '
    $0 ~ /^[[:space:]]*#/ { next }
    $1 == k {
      v = substr($0, index($0, "=") + 1)
      gsub(/\r/, "", v)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^["'\'']|["'\'']$/, "", v)
      print v
    }
  ' "$file" | tail -n 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-path) HUB_PATH="$2"; shift 2 ;;
    --public-http-url) PUBLIC_HTTP_URL="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --hub-port) HUB_PORT="$2"; shift 2 ;;
    --bff-port) BFF_PORT="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --skip-ngrok) SKIP_NGROK=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$BFF_PORT" ]]; then
  BFF_PORT="$(dotenv_get BFF_PORT || true)"
fi
BFF_PORT="${BFF_PORT:-$DEFAULT_BFF_PORT}"

state_path="$STATE_DIR/state.json"
secret_path="$STATE_DIR/auth-token.txt"
log_dir="$STATE_DIR/logs"
hub_pid=""
ngrok_pid=""
app_pid=""

die() { echo "$1" >&2; exit 1; }

port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq ":${port}$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    bash -c "echo >/dev/tcp/127.0.0.1/$port" >/dev/null 2>&1
  fi
}

wait_port_free() {
  local port="$1" seconds="${2:-12}"
  local deadline=$(( $(date +%s) + seconds ))
  while (( $(date +%s) < deadline )); do
    port_listening "$port" || return 0
    sleep 0.3
  done
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || true)"
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print $0}')"
  fi
  die "Port $port is already in use${pids:+ by $pids}. Run: ss -ltnp | grep $port  then kill the PID, or npm run stop:public"
}

wait_json() {
  local url="$1" seconds="$2"
  shift 2
  local deadline=$(( $(date +%s) + seconds ))
  local last=""
  while (( $(date +%s) < deadline )); do
    if last="$(curl -fsS --max-time 5 "$@" "$url" 2>&1)"; then
      return 0
    fi
    sleep 0.5
  done
  echo "Timed out waiting for $url${last:+ ($last)}" >&2
  return 1
}

stop_tree() {
  local pid="$1"
  [[ -n "${pid:-}" && "$pid" != "0" ]] || return 0
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  local child
  while read -r child; do
    [[ -n "$child" ]] && stop_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill -TERM "$pid" 2>/dev/null || true
  sleep 0.2
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
}

cleanup_failed() {
  local code=$?
  if (( code != 0 )); then
    stop_tree "${app_pid:-}"
    stop_tree "${ngrok_pid:-}"
    stop_tree "${hub_pid:-}"
  fi
}
trap cleanup_failed EXIT

detect_lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  [[ -n "$ip" ]] || die "Unable to detect a LAN IP. Set PUBLIC_HTTP_URL=http://YOUR_IP:${HUB_PORT}"
  printf '%s' "$ip"
}

find_ngrok() {
  command -v ngrok 2>/dev/null || true
}

auth_token() {
  if [[ -f "$secret_path" ]]; then
    local existing
    existing="$(tr -d '\r\n' < "$secret_path")"
    if (( ${#existing} < 32 )); then
      die "Persistent Hub auth token is invalid: $secret_path. Restore the original token or remove this file to rebind all clients."
    fi
    printf '%s' "$existing"
    return
  fi
  local generated
  generated="$(openssl rand -base64 32 | tr -d '\n')"
  umask 077
  printf '%s' "$generated" > "$secret_path"
  chmod 600 "$secret_path"
  printf '%s' "$generated"
}

[[ -f "$HUB_PATH/hub.mjs" ]] || die "Hub not found: $HUB_PATH (set HUB_PATH to the xihe-jianmu-ipc directory)"
[[ -f "$ROOT/package.json" ]] || die "Remote Client project not found: $ROOT"
command -v node >/dev/null 2>&1 || die 'node is required'
command -v npm >/dev/null 2>&1 || die 'npm is required'
command -v curl >/dev/null 2>&1 || die 'curl is required'
command -v openssl >/dev/null 2>&1 || die 'openssl is required'

mkdir -p "$STATE_DIR" "$log_dir"
echo 'Stopping existing public stack if present...'
bash "$ROOT/stop-public-stack.sh" --state-dir "$STATE_DIR" --hub-port "$HUB_PORT" --bff-port "$BFF_PORT"

token="$(auth_token)"
ngrok="$(find_ngrok)"
use_ip_mode=0
if [[ "$SKIP_NGROK" == "1" || "$PUBLIC_HTTP_URL" == http://* ]]; then
  use_ip_mode=1
elif [[ -z "$ngrok" ]]; then
  echo 'ngrok is not installed; starting in LAN/IP mode.'
  use_ip_mode=1
fi

hub_bind="127.0.0.1"
bff_host="127.0.0.1"
if [[ "$use_ip_mode" -eq 1 ]]; then
  hub_bind="0.0.0.0"
  bff_host="0.0.0.0"
  if [[ -z "$PUBLIC_HTTP_URL" ]]; then
    PUBLIC_HTTP_URL="http://$(detect_lan_ip):$HUB_PORT"
  fi
elif [[ -z "$PUBLIC_HTTP_URL" ]]; then
  if [[ -n "$DOMAIN" ]]; then PUBLIC_HTTP_URL="https://$DOMAIN"; else PUBLIC_HTTP_URL="https://$DEFAULT_DOMAIN"; fi
fi

parsed="$(node -e '
const raw = process.argv[1];
const allowHttp = process.argv[2] === "1";
try {
  const url = new URL(raw);
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname);
  const httpOk = url.protocol === "http:" && (allowHttp || ipv4);
  if ((url.protocol !== "https:" && !httpOk) || !url.hostname || url.pathname !== "/") {
    console.error("PublicHttpUrl must be https://host or http://IP:port");
    process.exit(1);
  }
  const publicHttp = url.origin.replace(/\/$/, "");
  const publicWs = publicHttp.replace(/^http/, "ws");
  process.stdout.write([publicHttp, publicWs, url.hostname].join("\n"));
} catch {
  console.error("PublicHttpUrl must be a valid URL, for example https://hub.example.com or http://192.168.1.10:3179");
  process.exit(1);
}
' "$PUBLIC_HTTP_URL" "$use_ip_mode")"
public_http="$(printf '%s\n' "$parsed" | sed -n '1p')"
public_ws="$(printf '%s\n' "$parsed" | sed -n '2p')"
ngrok_url="$(printf '%s\n' "$parsed" | sed -n '3p')"
db_path="$STATE_DIR/hub.db"

wait_port_free "$HUB_PORT"
wait_port_free "$BFF_PORT"

echo 'Building web UI...'
(
  cd "$ROOT"
  npm run build -w @remote-oc/protocol
  npm run build -w @remote-oc/web
)

export IPC_PORT="$HUB_PORT"
export IPC_HUB_BIND="$hub_bind"
export IPC_AUTH_TOKEN="$token"
export IPC_DB_PATH="$db_path"
export JIANMU_PUBLIC_HTTP_URL="$public_http"
export JIANMU_PUBLIC_WS_URL="$public_ws"

(
  cd "$HUB_PATH"
  nohup node hub.mjs >>"$log_dir/hub.out.log" 2>>"$log_dir/hub.err.log" &
  echo $!
) >"$log_dir/hub.pid"
hub_pid="$(tr -d '[:space:]' < "$log_dir/hub.pid")"
wait_json "http://127.0.0.1:$HUB_PORT/health" 30 -H "Authorization: Bearer $token" || die "Hub did not become ready on port $HUB_PORT"

if [[ "$use_ip_mode" -eq 0 ]]; then
  nohup "$ngrok" http --url="$ngrok_url" "$HUB_PORT" >>"$log_dir/ngrok.out.log" 2>>"$log_dir/ngrok.err.log" &
  ngrok_pid=$!
  wait_json "$public_http/health" 45 -H "Authorization: Bearer $token" -H "ngrok-skip-browser-warning: 1" || die "Public tunnel did not become ready at $public_http"
elif ! wait_json "$public_http/health" 8 -H "Authorization: Bearer $token"; then
  echo "Warning: Hub is listening locally. If remote agents cannot connect, open firewall TCP $HUB_PORT for $public_http"
fi

export JIANMU_HTTP_URL="http://127.0.0.1:$HUB_PORT"
export JIANMU_HUB_URL="ws://127.0.0.1:$HUB_PORT"
export JIANMU_AUTH_TOKEN="$token"
export BFF_PORT="$BFF_PORT"
export BFF_HOST="$bff_host"
(
  cd "$ROOT"
  nohup npm run dev:bff >>"$log_dir/app.out.log" 2>>"$log_dir/app.err.log" &
  echo $!
) >"$log_dir/app.pid"
app_pid="$(tr -d '[:space:]' < "$log_dir/app.pid")"
wait_json "http://127.0.0.1:$BFF_PORT/api/health" 45 || die "BFF did not become ready on port $BFF_PORT"

HUB_PID="$hub_pid" NGROK_PID="${ngrok_pid:-}" APP_PID="$app_pid" HUB_PORT="$HUB_PORT" BFF_PORT="$BFF_PORT" PUBLIC_HTTP="$public_http" PUBLIC_WS="$public_ws" LOG_DIR="$log_dir" \
  node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({
    startedAt: new Date().toISOString(),
    hubPid: Number(process.env.HUB_PID),
    ngrokPid: process.env.NGROK_PID ? Number(process.env.NGROK_PID) : null,
    appPid: Number(process.env.APP_PID),
    hubPort: Number(process.env.HUB_PORT),
    bffPort: Number(process.env.BFF_PORT),
    publicHttpUrl: process.env.PUBLIC_HTTP,
    publicWsUrl: process.env.PUBLIC_WS,
    logDir: process.env.LOG_DIR
  }, null, 2) + "\n")' "$state_path"

trap - EXIT
echo 'Public stack is ready.'
echo "Web/BFF: http://127.0.0.1:$BFF_PORT"
if [[ "$use_ip_mode" -eq 1 ]]; then
  lan_host="${public_http#http://}"
  lan_host="${lan_host%:*}"
  echo "Web/BFF LAN: http://$lan_host:$BFF_PORT"
  echo "Hub HTTP: $public_http"
  echo "Hub WS:   $public_ws"
else
  echo "Public HTTP: $public_http"
  echo "Public WSS:  $public_ws"
fi
echo "Logs: $log_dir"
