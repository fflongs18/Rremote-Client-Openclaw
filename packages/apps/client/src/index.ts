import dotenv from "dotenv";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  REMOTE_CLIENT_PREFIX,
  type JianmuMessage,
  type RemoteTaskEvent,
  type RemoteTaskPayload,
  isCancelCommand,
  parseJson,
} from "@remote-oc/protocol";
import { HermesAdapter } from "./adapters/hermes.js";
import { OpenClawAdapter } from "./adapters/openclaw.js";
import { RuntimeRegistry } from "./runtime/registry.js";
import { loadDeviceConfig } from "./device-config.js";

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env") });

interface JianmuTask {
  id: string;
  to: string;
  status: string;
  description: string;
  payload?: RemoteTaskPayload;
}

interface ActiveTask {
  taskId: string;
  runtimeId: string;
  sessionKey: string;
  runId?: string;
  sequence: number;
  terminal: boolean;
  cancelled: boolean;
}

const deviceConfig = loadDeviceConfig();
const clientId = process.env.REMOTE_CLIENT_ID || deviceConfig?.nodeId || `remote-oc-${os.hostname().toLowerCase()}`;
if (!clientId.startsWith(REMOTE_CLIENT_PREFIX) || clientId.startsWith("openclaw")) {
  throw new Error(`REMOTE_CLIENT_ID must start with ${REMOTE_CLIENT_PREFIX} and must not start with openclaw`);
}

const hubWsUrl = process.env.JIANMU_PUBLIC_WS_URL || process.env.JIANMU_HUB_URL || deviceConfig?.hubWsUrl || "ws://127.0.0.1:3179";
const hubHttpUrl = process.env.JIANMU_PUBLIC_HTTP_URL || process.env.JIANMU_HTTP_URL || deviceConfig?.hubHttpUrl || hubWsUrl.replace(/^ws/, "http");
const hubToken = process.env.JIANMU_AUTH_TOKEN || deviceConfig?.nodeToken || "";
const controlId = process.env.WEB_CONTROL_ID || "web-control";
const defaultRuntimeId = (process.env.AGENT_RUNTIME || "openclaw").trim().toLowerCase();
const healthIntervalMs = Math.max(5_000, Number(process.env.RUNTIME_HEALTH_INTERVAL_MS) || 15_000);
const runtimeConnectTimeoutMs = Math.max(1_000, Number(process.env.RUNTIME_CONNECT_TIMEOUT_MS) || 5_000);
const runtimes = new RuntimeRegistry()
  .register(new OpenClawAdapter({
    url: process.env.OPENCLAW_GATEWAY_URL || deviceConfig?.openClaw.url || "ws://127.0.0.1:18789",
    token: process.env.OPENCLAW_GATEWAY_TOKEN || deviceConfig?.openClaw.token || undefined,
    clientId: process.env.OPENCLAW_GATEWAY_CLIENT_ID || "gateway-client",
    // openclaw-node defaults to $HOME, which is unset on native Windows.
    deviceIdentityPath: process.env.OPENCLAW_DEVICE_IDENTITY_PATH
      || resolve(os.homedir(), ".openclaw", "device-identity.json"),
  }))
  .register(new HermesAdapter({
    baseUrl: process.env.HERMES_API_URL || "http://127.0.0.1:8642",
    apiKey: process.env.HERMES_API_KEY || undefined,
    model: process.env.HERMES_MODEL || undefined,
    provider: process.env.HERMES_PROVIDER || undefined,
    requestTimeoutMs: Number(process.env.HERMES_REQUEST_TIMEOUT_MS) || 60_000,
  }));
runtimes.require(defaultRuntimeId);

let socket: WebSocket | null = null;
let stopping = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let healthTimer: NodeJS.Timeout | null = null;
let healthRefreshInFlight = false;
const active = new Map<string, ActiveTask>();
const seen = new Set<string>();


function messageId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function send(message: Record<string, unknown>): void {
  if (socket?.readyState !== WebSocket.OPEN) throw new Error("Jianmu WebSocket is not connected");
  socket.send(JSON.stringify(message));
}

function sendEvent(event: RemoteTaskEvent): void {
  send({
    id: messageId("msg"),
    type: "message",
    from: clientId,
    to: controlId,
    content: JSON.stringify(event),
    contentType: "remote-task-event",
    topic: "remote-control",
    ts: Date.now(),
  });
}

function emit(activeTask: ActiveTask, event: RemoteTaskEvent["event"], data?: { text?: string }): void {
  activeTask.sequence += 1;
  sendEvent({
    version: 1,
    taskId: activeTask.taskId,
    sequence: activeTask.sequence,
    event,
    runtime: activeTask.runtimeId,
    runId: activeTask.runId,
    sessionKey: activeTask.sessionKey,
    ...(data ? { data } : {}),
    timestamp: Date.now(),
  });
}

async function registerClient(): Promise<void> {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const runtimeDescriptions = await runtimes.describeHealth();
  if (socket?.readyState !== WebSocket.OPEN) return;
  send({
    type: "register",
    name: clientId,
    pid: process.pid,
    cwd: process.cwd(),
    runtime: "remote-agent-host",
    nodeId: clientId,
    label: deviceConfig?.nodeName || process.env.REMOTE_CLIENT_LABEL || os.hostname(),
    platform: process.platform,
    clientVersion: process.env.npm_package_version || "0.2.0",
    runtimes: runtimeDescriptions,
  });
}

async function refreshRuntimeHealth(): Promise<void> {
  if (healthRefreshInFlight) return;
  healthRefreshInFlight = true;
  try {
    await registerClient();
    await Promise.allSettled(runtimes.all().map(async (runtime) => {
      const health = await runtime.health();
      if (health.connected) return;
      await Promise.race([
        runtime.connect(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Runtime connection timed out")), runtimeConnectTimeoutMs)),
      ]);
    }));
    await registerClient();
  } finally {
    healthRefreshInFlight = false;
  }
}

async function hubRequest<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (hubToken) headers.Authorization = `Bearer ${hubToken}`;
  const response = await fetch(`${hubHttpUrl}${path}`, { headers });
  const body = await response.text();
  if (!response.ok) throw new Error(`Jianmu ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function executeTask(taskId: string): Promise<void> {
  if (seen.has(taskId)) return;
  seen.add(taskId);

  let running: ActiveTask | null = null;
  try {
    const task = await hubRequest<JianmuTask>(`/tasks/${encodeURIComponent(taskId)}`);
    if (task.to !== clientId || ["completed", "failed", "cancelled"].includes(task.status)) return;
    const payload = task.payload;
    const message = payload?.message || task.description;
    if (!message?.trim()) throw new Error("Task has no message");

    const runtimeId = payload?.runtime?.trim().toLowerCase() || defaultRuntimeId;
    const runtime = runtimes.require(runtimeId);
    const sessionKey = payload?.sessionKey || `remote:${clientId}:${runtimeId}:${taskId}`;
    running = { taskId, runtimeId, sessionKey, sequence: 0, terminal: false, cancelled: false };
    active.set(taskId, running);
    emit(running, "accepted");

    const stream = runtime.run({
      message,
      sessionKey,
      agentId: payload?.agentId,
      clientMessageId: payload?.clientMessageId || taskId,
      metadata: payload?.metadata,
    });

    for await (const runtimeEvent of stream) {
      if (running.cancelled) break;
      running.runId = runtimeEvent.runId;
      const event: RemoteTaskEvent = {
        version: 1,
        taskId,
        sequence: ++running.sequence,
        event: runtimeEvent.event,
        runtime: runtimeId,
        runId: runtimeEvent.runId,
        sessionKey: runtimeEvent.sessionKey || sessionKey,
        data: runtimeEvent.data,
        timestamp: runtimeEvent.timestamp,
      };
      if (["completed", "failed", "cancelled"].includes(event.event)) running.terminal = true;
      sendEvent(event);
      if (running.terminal) break;
    }

    if (!running.cancelled && !running.terminal) {
      emit(running, "completed");
      running.terminal = true;
    }
  } catch (error) {
    console.error(`Task ${taskId} failed`, error);
    if (!running) running = { taskId, runtimeId: defaultRuntimeId, sessionKey: "", sequence: 0, terminal: false, cancelled: false };
    if (!running.cancelled && !running.terminal) {
      emit(running, "failed", { text: error instanceof Error ? error.message : String(error) });
      running.terminal = true;
    }
  } finally {
    active.delete(taskId);
    void registerClient().catch((error) => console.warn("Failed to refresh runtime health", error));
  }
}

async function cancelTask(taskId: string): Promise<void> {
  const running = active.get(taskId);
  if (!running || running.terminal) return;
  running.cancelled = true;
  try {
    await runtimes.require(running.runtimeId).cancel({ sessionKey: running.sessionKey, runId: running.runId });
    emit(running, "cancelled");
    running.terminal = true;
  } catch (error) {
    emit(running, "failed", { text: `Cancel failed: ${error instanceof Error ? error.message : String(error)}` });
    running.terminal = true;
  }
}

function onMessage(raw: WebSocket.RawData): void {
  const message = parseJson<JianmuMessage>(raw.toString());
  if (!message) return;
  if (message.type === "ping") {
    send({ type: "pong" });
    return;
  }
  if (message.type !== "message" || message.to !== clientId || typeof message.content !== "string") return;

  const content = parseJson<unknown>(message.content);
  if (isCancelCommand(content)) {
    void cancelTask(content.taskId);
    return;
  }
  if (message.topic !== "task" || message.contentType !== "task") return;
  const taskStub = content as { taskId?: unknown } | null;
  if (typeof taskStub?.taskId === "string") void executeTask(taskStub.taskId);
}

function connectHub(): void {
  const url = new URL(hubWsUrl);
  url.searchParams.set("name", clientId);
  if (hubToken) url.searchParams.set("token", hubToken);
  socket = new WebSocket(url);
  socket.on("open", () => {
    console.log(`Connected to Jianmu as ${clientId}`);
    void refreshRuntimeHealth().catch((error) => console.warn("Failed to refresh runtime health", error));
  });
  socket.on("message", onMessage);
  socket.on("error", (error) => console.error("Jianmu WebSocket error", error));
  socket.on("close", (code, reason) => {
    console.warn(`Jianmu disconnected (${code} ${reason.toString()})`);
    if (code === 1008 || code === 4001 || /unauthorized|revoked/i.test(reason.toString())) {
      stopping = true;
      console.error("Device token is invalid or revoked. Run the pairing command again.");
      return;
    }
    if (!stopping && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectHub();
      }, 1500);
    }
  });
}

connectHub();
void refreshRuntimeHealth()
  .then(() => console.log(`Checked ${defaultRuntimeId} runtime`))
  .catch((error) => console.warn(`${defaultRuntimeId} runtime health check failed`, error));
healthTimer = setInterval(() => {
  void refreshRuntimeHealth().catch((error) => console.warn("Failed to refresh runtime health", error));
}, healthIntervalMs);

async function shutdown(): Promise<void> {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (healthTimer) clearInterval(healthTimer);
  socket?.close();
  await Promise.allSettled(runtimes.all().map((runtime) => runtime.disconnect()));
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
