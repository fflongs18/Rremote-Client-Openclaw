import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const action = process.argv[2] === "stop" ? "stop" : "start";
const rest = process.argv.slice(3);
const windows = process.platform === "win32";
const file = action === "stop"
  ? (windows ? "stop-public-stack.ps1" : "stop-public-stack.sh")
  : (windows ? "start-public-stack.ps1" : "start-public-stack.sh");
const command = windows ? "powershell" : "bash";
const args = windows
  ? ["-ExecutionPolicy", "Bypass", "-File", resolve(root, file), ...rest]
  : [resolve(root, file), ...rest];
const result = spawnSync(command, args, {
  stdio: "inherit",
  cwd: root,
  env: process.env,
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
