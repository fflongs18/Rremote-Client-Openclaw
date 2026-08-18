import os from "node:os";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { loadDeviceConfig, type DeviceConfig } from "./device-config.js";
import { HermesAdapter } from "./adapters/hermes.js";
import { OpenClawAdapter } from "./adapters/openclaw.js";
import type { AgentRuntime } from "./runtime/types.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds))]);
}

export async function probeHubWss(config: DeviceConfig, timeoutMs = 10_000): Promise<void> {
  await withTimeout(new Promise<void>((resolve, reject) => {
    const url = new URL(config.hubWsUrl);
    url.searchParams.set("name", config.nodeId);
    url.searchParams.set("token", config.nodeToken);
    const socket = new WebSocket(url);
    let completed = false;
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true;
      socket.close();
      error ? reject(error) : resolve();
    };
    socket.once("open", () => socket.send(JSON.stringify({
      type: "register", name: config.nodeId, nodeId: config.nodeId, label: config.nodeName,
      runtime: "remote-agent-host", platform: process.platform, clientVersion: "0.1.0",
      runtimes: [
        { id: "openclaw", label: "OpenClaw", ready: false, capabilities: ["chat", "stream", "cancel", "tools"], checkedAt: Date.now() },
        { id: "hermes", label: "Hermes", ready: false, capabilities: ["chat", "stream", "cancel", "tools"], checkedAt: Date.now() },
      ],
    })));
    socket.on("message", (raw) => {
      try { if ((JSON.parse(raw.toString()) as { type?: string }).type === "registered") finish(); } catch { /* ignore unrelated frames */ }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", (code, reason) => { if (!completed) finish(new Error(`WSS closed (${code}): ${reason.toString()}`)); });
  }), timeoutMs, "WSS verification");
}

export async function probeGateway(config: DeviceConfig, timeoutMs = 8_000): Promise<void> {
  const runtimeId = (process.env.AGENT_RUNTIME || "openclaw").trim().toLowerCase();
  let adapter: AgentRuntime;
  if (runtimeId === "hermes") {
    adapter = new HermesAdapter({
      baseUrl: process.env.HERMES_API_URL || "http://127.0.0.1:8642",
      apiKey: process.env.HERMES_API_KEY || undefined,
      model: process.env.HERMES_MODEL || undefined,
      provider: process.env.HERMES_PROVIDER || undefined,
      requestTimeoutMs: Math.min(timeoutMs, Number(process.env.HERMES_REQUEST_TIMEOUT_MS) || 10_000),
    });
  } else if (runtimeId === "openclaw") {
    adapter = new OpenClawAdapter({
      url: process.env.OPENCLAW_GATEWAY_URL || config.openClaw.url,
      token: process.env.OPENCLAW_GATEWAY_TOKEN || config.openClaw.token || undefined,
      clientId: "remote-oc-installer-probe",
    });
  } else {
    throw new Error(`Unsupported AGENT_RUNTIME for gateway verification: ${runtimeId}`);
  }
  try { await withTimeout(adapter.connect(), timeoutMs, `${adapter.label} Gateway verification`); }
  finally { await adapter.disconnect().catch(() => undefined); }
}

export async function waitForNodeOnline(config: DeviceConfig, timeoutMs = 30_000): Promise<{ online: boolean; runtimes?: unknown[] }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "node did not become online";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${config.hubHttpUrl}/nodes/${encodeURIComponent(config.nodeId)}`, { headers: { Authorization: `Bearer ${config.nodeToken}` } });
      if (response.status === 401 || response.status === 403) throw new Error("Node Token is invalid or revoked; rebind this device");
      if (response.ok) {
        const node = await response.json() as { online?: boolean; runtimes?: unknown[] };
        if (node.online) return { online: true, runtimes: node.runtimes };
      } else lastError = `Hub returned HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(lastError);
}

async function main(): Promise<void> {
  const config = loadDeviceConfig();
  if (!config) throw new Error("Device config is missing or invalid; pair this device first");
  const mode = arg("--mode") || "all";
  if (mode === "wss" || mode === "all") await probeHubWss(config);
  if (mode === "gateway" || mode === "all") await probeGateway(config);
  if (mode === "online" || mode === "all") await waitForNodeOnline(config, Number(arg("--timeout-ms")) || 30_000);
  console.log(JSON.stringify({ ok: true, mode, nodeId: config.nodeId, host: os.hostname() }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
