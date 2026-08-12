import "dotenv/config";
import os from "node:os";
import WebSocket from "ws";
import { OpenClawClient } from "openclaw-node";
import {
  REMOTE_CLIENT_PREFIX,
  type JianmuMessage,
  type RemoteTaskEvent,
  type RemoteTaskPayload,
  isCancelCommand,
  parseJson,
} from "@remote-oc/protocol";
import { eventFromChunk } from "./events.js";

interface JianmuTask {
  id: string;
  to: string;
  status: string;
  description: string;
  payload?: RemoteTaskPayload;
}

interface ActiveTask {
  taskId: string;
  sessionKey: string;
  runId?: string;
  sequence: number;
  terminal: boolean;
  cancelled: boolean;
}

const clientId = process.env.REMOTE_CLIENT_ID || `remote-oc-${os.hostname().toLowerCase()}`;
if (!clientId.startsWith(REMOTE_CLIENT_PREFIX) || clientId.startsWith("openclaw")) {
  throw new Error(`REMOTE_CLIENT_ID must start with ${REMOTE_CLIENT_PREFIX} and must not start with openclaw`);
}

const hubWsUrl = process.env.JIANMU_HUB_URL || "ws://127.0.0.1:3179";
const hubHttpUrl = process.env.JIANMU_HTTP_URL || hubWsUrl.replace(/^ws/, "http");
const hubToken = process.env.JIANMU_AUTH_TOKEN || "";
const controlId = process.env.WEB_CONTROL_ID || "web-control";
const gateway = new OpenClawClient({
  url: process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789",
  token: process.env.OPENCLAW_GATEWAY_TOKEN || undefined,
  autoReconnect: true,
  clientId: clientId,
});

let socket: WebSocket | null = null;
let stopping = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let gatewayConnected = false;
const active = new Map<string, ActiveTask>();
const seen = new Set<string>();

async function connectGateway(): Promise<void> {
  if (gatewayConnected) return;
  await gateway.connect();
  gatewayConnected = true;
  console.log("Connected to OpenClaw Gateway");
}

gateway.on("disconnected", () => {
  gatewayConnected = false;
  console.warn("OpenClaw Gateway disconnected");
});
gateway.on("error", (error) => console.error("OpenClaw Gateway error", error));

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
    runId: activeTask.runId,
    sessionKey: activeTask.sessionKey,
    ...(data ? { data } : {}),
    timestamp: Date.now(),
  });
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

    const sessionKey = payload?.sessionKey || `remote:${clientId}:${taskId}`;
    running = { taskId, sessionKey, sequence: 0, terminal: false, cancelled: false };
    active.set(taskId, running);

    await connectGateway();
    const stream = gateway.chat(message, {
      sessionKey,
      agentId: payload?.agentId,
      clientMessageId: payload?.clientMessageId || taskId,
    });

    for await (const chunk of stream) {
      if (running.cancelled) break;
      running.runId = chunk.runId;
      const event = eventFromChunk(chunk, {
        taskId,
        sequence: ++running.sequence,
        sessionKey,
      });
      if (!event) continue;
      if (event.event === "completed" || event.event === "failed") running.terminal = true;
      sendEvent(event);
      if (running.terminal) break;
    }

    if (!running.cancelled && !running.terminal) {
      emit(running, "completed");
      running.terminal = true;
    }
  } catch (error) {
    console.error(`Task ${taskId} failed`, error);
    if (!running) running = { taskId, sessionKey: "", sequence: 0, terminal: false, cancelled: false };
    if (!running.cancelled && !running.terminal) {
      emit(running, "failed", { text: error instanceof Error ? error.message : String(error) });
      running.terminal = true;
    }
  } finally {
    active.delete(taskId);
  }
}

async function cancelTask(taskId: string): Promise<void> {
  const running = active.get(taskId);
  if (!running || running.terminal) return;
  running.cancelled = true;
  try {
    await gateway.chatAbort(running.sessionKey, running.runId);
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
    send({
      type: "register",
      name: clientId,
      pid: process.pid,
      cwd: process.cwd(),
      runtime: "openclaw-node",
      label: process.env.REMOTE_CLIENT_LABEL || os.hostname(),
    });
  });
  socket.on("message", onMessage);
  socket.on("error", (error) => console.error("Jianmu WebSocket error", error));
  socket.on("close", (code, reason) => {
    console.warn(`Jianmu disconnected (${code} ${reason.toString()})`);
    if (!stopping && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectHub();
      }, 1500);
    }
  });
}

connectHub();
void connectGateway().catch((error) => console.warn("OpenClaw Gateway not ready; will retry on task", error));

async function shutdown(): Promise<void> {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  await gateway.disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
