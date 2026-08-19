#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${STATE_DIR:-$HOME/.remote-oc/public-stack}"
HUB_PORT="${HUB_PORT:-${IPC_PORT:-3179}}"
BFF_PORT="${BFF_PORT:-8788}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --hub-port) HUB_PORT="$2"; shift 2 ;;
    --bff-port) BFF_PORT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

state_path="$STATE_DIR/state.json"
stopped=0

stop_tree() {
  local pid="$1"
  [[ -n "${pid:-}" && "$pid" != "null" && "$pid" != "0" ]] || return 0
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  local child
  while read -r child; do
    [[ -n "$child" ]] && stop_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill -TERM "$pid" 2>/dev/null || true
  sleep 0.2
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
}

pids_on_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$port" 2>/dev/null | tr -s '[:space:]' '\n' || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {
      while (match($0, /pid=[0-9]+/)) {
        print substr($0, RSTART+4, RLENGTH-4)
        $0 = substr($0, RSTART+RLENGTH)
      }
    }'
  fi
}

read_pid() {
  node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(s[process.argv[2]]||""))' "$state_path" "$1"
}

if [[ -f "$state_path" ]]; then
  stop_tree "$(read_pid appPid)"
  stop_tree "$(read_pid ngrokPid)"
  stop_tree "$(read_pid hubPid)"
  rm -f "$state_path"
  stopped=1
fi

for port in "$HUB_PORT" "$BFF_PORT"; do
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    echo "Stopping leftover process on port $port (PID $pid)"
    stop_tree "$pid"
    stopped=1
  done < <(pids_on_port "$port" | awk 'NF && !seen[$0]++')
done

if (( stopped )); then
  echo 'Public stack stopped.'
else
  echo 'Public stack is not running.'
fi
