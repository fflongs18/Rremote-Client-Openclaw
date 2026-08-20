import fs from "node:fs";
const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("release.json"));
for (const platform of ["windows-x64", "windows-arm64", "macos-x64", "macos-arm64"]) {
  if (!manifest.platforms[platform]) throw new Error(`release.json is missing ${platform}`);
}
for (const file of ["install.ps1", "install.sh", "installer/install.ps1", "installer/install-macos.sh"]) {
  const text = read(file);
  if (/npm\s+(install|ci)|\btsc\b/.test(text)) throw new Error(`${file} builds dependencies on the target machine`);
}
if (read("install.sh").includes(",,")) throw new Error("install.sh contains Bash 4 lowercase expansion");
const windowsBootstrap = read("install.ps1");
if (!windowsBootstrap.includes("ngrok-skip-browser-warning")) throw new Error("install.ps1 does not bypass the ngrok interstitial");
if (!windowsBootstrap.includes("ERR_NGROK_")) throw new Error("install.ps1 does not reject ngrok error pages");
for (const stage of ["5q2j5Zyo6I635Y+W5a6J5YWo5a6J6KOF6YWN572u", "5q2j5Zyo6I635Y+W54mI5pys5riF5Y2V", "5q2j5Zyo5LiL6L29IFdpbmRvd3Mg5a6J6KOF5YyF", "5q2j5Zyo5qCh6aqM5a6J6KOF5YyF", "5q2j5Zyo6Kej5Y6L5bm25a6J6KOFIFJlbW90ZS1PQw==", "5q2j5Zyo6L+e5o6l5Li75o6n5bm25ZCv5YqoIEFnZW50"]) {
  if (!windowsBootstrap.includes(stage)) throw new Error(`install.ps1 is missing encoded progress stage: ${stage}`);
}
const windowsInstaller = read("installer/install.ps1");
for (const behavior of ["Find-OrCreateHermesApiKey", "Remote-OC-Hermes-Gateway", "Test-ReusableIdentity", "Stop-InstalledClient", "identity = if ($reuseIdentity)", "existing.hermes.apiKey"]) {
  if (!windowsInstaller.includes(behavior)) throw new Error(`installer/install.ps1 is missing Windows parity behavior: ${behavior}`);
}
const bff = read("packages/apps/bff/src/index.ts");
if (bff.includes("hermesApiKey: process.env.HERMES_API_KEY")) throw new Error("Enrollment exchange still sends the controller Hermes API key");
const sidecar = (name) => read(`artifacts/${name}`).trim().split(/\s+/)[0];
if (manifest.platforms["windows-x64"].sha256 !== sidecar("RemoteOpenClaw-0.1.0-win-x64.zip.sha256")) {
  throw new Error("release.json windows-x64 sha256 does not match artifacts sidecar");
}
if (manifest.platforms["windows-arm64"].sha256 !== sidecar("RemoteOpenClaw-0.1.0-win-arm64.zip.sha256")) {
  throw new Error("release.json windows-arm64 sha256 does not match artifacts sidecar");
}
if (!read("installer/install-macos.sh").includes("c?.hermes?.apiKey")) {
  throw new Error("macOS installer does not reuse the existing device.json Hermes key");
}
console.log(JSON.stringify({ ok: true, tests: 12, platforms: Object.keys(manifest.platforms) }));
