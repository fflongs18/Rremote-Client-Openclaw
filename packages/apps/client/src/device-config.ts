import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DeviceConfig {
  version: 1;
  nodeId: string;
  nodeToken: string;
  nodeName: string;
  hubWsUrl: string;
  hubHttpUrl: string;
  openClaw: {
    url: string;
    token: string | null;
  };
  hermes: {
    url: string;
    apiKey: string | null;
    model: string | null;
    provider: string | null;
  };
  createdAt?: number;
}

export function deviceConfigPath(): string {
  return process.env.REMOTE_CLIENT_CONFIG || join(homedir(), ".remote-oc", "device.json");
}

function normalizeConfig(value: unknown): DeviceConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (![raw.nodeId, raw.nodeToken, raw.nodeName, raw.hubWsUrl, raw.hubHttpUrl].every((item) => typeof item === "string" && item.length > 0)) return null;
  const openClaw = raw.openClaw && typeof raw.openClaw === "object" ? raw.openClaw as Record<string, unknown> : {};
  const hermes = raw.hermes && typeof raw.hermes === "object" ? raw.hermes as Record<string, unknown> : {};
  return {
    version: 1,
    nodeId: String(raw.nodeId),
    nodeToken: String(raw.nodeToken),
    nodeName: String(raw.nodeName),
    hubWsUrl: String(raw.hubWsUrl),
    hubHttpUrl: String(raw.hubHttpUrl),
    openClaw: {
      url: typeof openClaw.url === "string" && openClaw.url ? openClaw.url : "ws://127.0.0.1:18789",
      token: typeof openClaw.token === "string" && openClaw.token ? openClaw.token : null,
    },
    hermes: {
      url: typeof hermes.url === "string" && hermes.url ? hermes.url : "http://127.0.0.1:8642",
      apiKey: typeof hermes.apiKey === "string" && hermes.apiKey ? hermes.apiKey : null,
      model: typeof hermes.model === "string" && hermes.model ? hermes.model : null,
      provider: typeof hermes.provider === "string" && hermes.provider ? hermes.provider : null,
    },
    ...(typeof raw.createdAt === "number" ? { createdAt: raw.createdAt } : {}),
  };
}

export function loadDeviceConfig(): DeviceConfig | null {
  const path = deviceConfigPath();
  if (!existsSync(path)) return null;
  try { return normalizeConfig(JSON.parse(readFileSync(path, "utf8"))); } catch { return null; }
}

function restrictWindowsAcl(path: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!user) throw new Error("Cannot determine current Windows user for device config ACL");
  execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${user}:(R,W)`, "SYSTEM:(F)"], { stdio: "ignore" });
}

export function saveDeviceConfig(config: DeviceConfig): void {
  const path = deviceConfigPath();
  const directory = dirname(path);
  const temporary = join(directory, `.device-${process.pid}-${Date.now()}.tmp`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    restrictWindowsAcl(temporary);
    renameSync(temporary, path);
    restrictWindowsAcl(path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isIpv4Address(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

export function deriveHubUrls(input: string): { hubHttpUrl: string; hubWsUrl: string } {
  const raw = input.trim().replace(/\/$/, "");
  const url = new URL(raw);
  const allowHttp = process.env.REMOTE_OC_ALLOW_INSECURE === "1" || isIpv4Address(url.hostname);
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("Hub URL must use HTTPS, or HTTP with an IP address / REMOTE_OC_ALLOW_INSECURE=1");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Hub URL must not contain credentials, query, or fragment");
  return { hubHttpUrl: url.toString().replace(/\/$/, ""), hubWsUrl: url.toString().replace(/^http/, "ws").replace(/\/$/, "") };
}
