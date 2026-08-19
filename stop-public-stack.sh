#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${STATE_DIR:-$HOME/.remote-oc/public-stack}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

state_path="$STATE_DIR/state.json"
if [[ ! -f "$state_path" ]]; then
  echo 'Public stack is not running.'
  exit 0
fi

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

read_pid() {
  node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(s[process.argv[2]]||""))' "$state_path" "$1"
}

stop_tree "$(read_pid appPid)"
stop_tree "$(read_pid ngrokPid)"
stop_tree "$(read_pid hubPid)"
rm -f "$state_path"
echo 'Public stack stopped.'
