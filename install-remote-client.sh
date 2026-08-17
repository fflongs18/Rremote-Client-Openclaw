#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null; then echo 'Node.js 22+ is required' >&2; exit 1; fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 22 ]; then echo 'Node.js 22+ is required' >&2; exit 1; fi
cd "$ROOT"
npm install
npm run build
echo 'Run: npm run pair -- --code ABC123 --name "Your device"'
