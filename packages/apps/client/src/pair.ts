import os from "node:os";
import { pathToFileURL } from "node:url";
import { deriveHubUrls, saveDeviceConfig, type DeviceConfig } from "./device-config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface PairOptions {
  code: string;
  name: string;
  hubUrl: string;
  gatewayUrl?: string;
  gatewayToken?: string | null;
  hermesUrl?: string;
  hermesApiKey?: string | null;
  hermesModel?: string | null;
  hermesProvider?: string | null;
}

export async function pairDevice(options: PairOptions): Promise<DeviceConfig> {
  const requested = deriveHubUrls(options.hubUrl);
  const response = await fetch(`${requested.hubHttpUrl}/pairing-sessions/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: options.code.trim(), nodeName: options.name, platform: process.platform, clientVersion: "0.1.0" }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${body}`);
  const result = JSON.parse(body) as Record<string, unknown>;
  if (typeof result.nodeId !== "string" || typeof result.nodeToken !== "string") throw new Error("Pairing response did not contain a device identity");
  const returnedHttp = typeof result.hubHttpUrl === "string" && result.hubHttpUrl ? deriveHubUrls(result.hubHttpUrl) : requested;
  const config: DeviceConfig = {
    version: 1,
    nodeId: result.nodeId,
    nodeToken: result.nodeToken,
    nodeName: typeof result.nodeName === "string" ? result.nodeName : options.name,
    hubHttpUrl: returnedHttp.hubHttpUrl,
    hubWsUrl: typeof result.hubWsUrl === "string" && result.hubWsUrl.startsWith("wss://") ? result.hubWsUrl.replace(/\/$/, "") : returnedHttp.hubWsUrl,
    openClaw: { url: options.gatewayUrl || "ws://127.0.0.1:18789", token: options.gatewayToken || null },
    hermes: {
      url: options.hermesUrl || "http://127.0.0.1:8642",
      apiKey: options.hermesApiKey || null,
      model: options.hermesModel || null,
      provider: options.hermesProvider || null,
    },
    createdAt: Date.now(),
  };
  saveDeviceConfig(config);
  return config;
}

async function main(): Promise<void> {
  const code = arg("--code") || process.env.REMOTE_OC_PAIRING_CODE;
  const hubUrl = arg("--hub-url") || process.env.JIANMU_PUBLIC_HTTP_URL || process.env.JIANMU_HTTP_URL;
  if (!code || !hubUrl) throw new Error("Usage: pair --hub-url https://hub.example.com --code ABC123 --name \"Office PC\"");
  const config = await pairDevice({
    code,
    hubUrl,
    name: arg("--name") || os.hostname(),
    gatewayUrl: arg("--gateway-url") || process.env.OPENCLAW_GATEWAY_URL,
    gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
    hermesUrl: arg("--hermes-url") || process.env.HERMES_API_URL,
    hermesApiKey: process.env.HERMES_API_KEY,
    hermesModel: process.env.HERMES_MODEL,
    hermesProvider: process.env.HERMES_PROVIDER,
  });
  console.log(JSON.stringify({ ok: true, nodeId: config.nodeId, nodeName: config.nodeName, hubHttpUrl: config.hubHttpUrl }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
