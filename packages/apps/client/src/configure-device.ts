import { pathToFileURL } from "node:url";
import { loadDeviceConfig, saveDeviceConfig } from "./device-config.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const config = loadDeviceConfig();
  if (!config) throw new Error("Device config is missing or invalid");
  const gatewayUrl = arg("--gateway-url");
  if (gatewayUrl && !/^wss?:\/\//.test(gatewayUrl)) throw new Error("Gateway URL must use ws:// or wss://");
  config.openClaw = {
    url: gatewayUrl || config.openClaw.url,
    token: process.env.OPENCLAW_GATEWAY_TOKEN || config.openClaw.token || null,
  };
  saveDeviceConfig(config);
  console.log(JSON.stringify({ ok: true, nodeId: config.nodeId, gatewayUrl: config.openClaw.url }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
