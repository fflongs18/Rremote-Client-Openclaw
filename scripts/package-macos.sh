#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="${1:-$(uname -m)}"
case "$ARCH" in arm64|aarch64) ARCH=arm64 ;; x64|x86_64|amd64) ARCH=x64 ;; *) echo "Unsupported architecture: $ARCH" >&2; exit 2 ;; esac
OUTPUT="${2:-$ROOT/artifacts}"
TEMP_ROOT="$(mktemp -d)"; trap 'rm -rf "$TEMP_ROOT"' EXIT
STAGE="$TEMP_ROOT/RemoteOpenClaw-$VERSION-mac-$ARCH"; APP="$STAGE/app"
mkdir -p "$APP/client" "$APP/protocol" "$STAGE/runtime" "$OUTPUT"
(cd "$ROOT" && npm run build -w @remote-oc/protocol && npm run build -w @remote-oc/client)
cp -R "$ROOT/packages/apps/client/dist" "$APP/client/dist"
cp -R "$ROOT/packages/protocol/dist" "$APP/protocol/dist"
node - "$APP" "$VERSION" <<'NODE'
const fs=require('fs'),app=process.argv[2],version=process.argv[3];
fs.writeFileSync(`${app}/protocol/package.json`,JSON.stringify({name:'@remote-oc/protocol',version,type:'module',main:'dist/index.js',exports:{'.':'./dist/index.js'}},null,2));
fs.writeFileSync(`${app}/package.json`,JSON.stringify({private:true,type:'module',dependencies:{'@remote-oc/protocol':'file:./protocol',dotenv:'^17.2.0','openclaw-node':'0.14.0',ws:'^8.18.0'}},null,2));
NODE
(cd "$APP" && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
rm -rf "$APP/node_modules/@remote-oc/protocol"; mkdir -p "$APP/node_modules/@remote-oc"; cp -R "$APP/protocol" "$APP/node_modules/@remote-oc/protocol"
CHECKSUMS="$TEMP_ROOT/SHASUMS256.txt"; curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$CHECKSUMS"
ARCHIVE="$(awk -v p="-darwin-$ARCH.tar.gz" '$2 ~ p"$" {print $2; exit}' "$CHECKSUMS")"; [[ -n "$ARCHIVE" ]]
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$ARCHIVE" -o "$TEMP_ROOT/$ARCHIVE"
EXPECTED="$(awk -v f="$ARCHIVE" '$2==f {print $1}' "$CHECKSUMS")"; ACTUAL="$(shasum -a 256 "$TEMP_ROOT/$ARCHIVE" | awk '{print $1}')"; [[ "$EXPECTED" == "$ACTUAL" ]]
tar -xzf "$TEMP_ROOT/$ARCHIVE" -C "$TEMP_ROOT"; cp "$TEMP_ROOT/${ARCHIVE%.tar.gz}/bin/node" "$STAGE/runtime/node"; chmod 755 "$STAGE/runtime/node"
cp "$ROOT/installer/install-macos.sh" "$STAGE/install-macos.sh"; cp "$ROOT/installer/uninstall-macos.sh" "$STAGE/uninstall-macos.sh"; chmod 755 "$STAGE/"*.sh
node - "$STAGE" "$VERSION" "$ARCH" <<'NODE'
const crypto=require('crypto'),fs=require('fs'),path=require('path'),[stage,version,arch]=process.argv.slice(2);
const files=[];function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name),s=fs.statSync(p);if(s.isDirectory())walk(p);else files.push({path:path.relative(stage,p).split(path.sep).join('/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),size:s.size});}}walk(stage);
fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify({packageVersion:version,platform:'macos',architecture:arch,createdAt:new Date().toISOString(),files},null,2));
NODE
[[ -x "$STAGE/runtime/node" && -f "$STAGE/app/node_modules/@remote-oc/protocol/package.json" ]]
(cd "$STAGE/app" && "$STAGE/runtime/node" --input-type=module --eval "import('@remote-oc/protocol')")
PACKAGE="$OUTPUT/RemoteOpenClaw-$VERSION-mac-$ARCH.tar.gz"; tar -czf "$PACKAGE" -C "$STAGE" .
SHA="$(shasum -a 256 "$PACKAGE" | awk '{print $1}')"; printf '%s  %s\n' "$SHA" "$(basename "$PACKAGE")" > "$PACKAGE.sha256"
printf '{"ok":true,"package":"%s","sha256":"%s","platform":"macos-%s"}\n' "$PACKAGE" "$SHA" "$ARCH"
