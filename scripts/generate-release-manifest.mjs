import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const baseUrl = (process.argv[2] || "").replace(/\/$/, "");
if (baseUrl && !baseUrl.startsWith("https://")) throw new Error("Release base URL must use HTTPS");
const artifacts = path.join(root, "artifacts");
const names = {
  "windows-x64": `RemoteOpenClaw-${version}-win-x64.zip`,
  "windows-arm64": `RemoteOpenClaw-${version}-win-arm64.zip`,
  "macos-x64": `RemoteOpenClaw-${version}-mac-x64.tar.gz`,
  "macos-arm64": `RemoteOpenClaw-${version}-mac-arm64.tar.gz`,
};
const platforms = {};
for (const [platform, name] of Object.entries(names)) {
  const file = path.join(artifacts, name);
  if (!fs.existsSync(file)) throw new Error(`Missing release artifact: ${name}`);
  platforms[platform] = {
    url: baseUrl ? `${baseUrl}/artifacts/${name}` : `artifacts/${name}`,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  };
}
const output = path.join(root, "release.json");
fs.writeFileSync(output, `${JSON.stringify({ version, platforms }, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, output, version, platforms: Object.keys(platforms) }));
