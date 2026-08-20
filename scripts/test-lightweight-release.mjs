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
console.log(JSON.stringify({ ok: true, tests: 6, platforms: Object.keys(manifest.platforms) }));
