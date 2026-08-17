import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  REMOTE_CLIENT_PREFIX,
  type RemoteTaskEvent,
  type AgentPushMessage,
  type RuntimeDescriptor,
  isAgentPushMessage,
  isRemoteTaskEvent,
  parseJson,
  statusForEvent,
} from "@remote-oc/protocol";
import { JianmuClient } from "./jianmu.js";
import { shouldUpdateStatus } from "./status.js";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "../../../../.env") });

const host = process.env.BFF_HOST || "127.0.0.1";
const port = Number(process.env.BFF_PORT || 8787);
const taskAcceptTimeoutMs = Math.max(1_000, Number(process.env.TASK_ACCEPT_TIMEOUT_MS) || 15_000);
const taskIdleTimeoutMs = Math.max(taskAcceptTimeoutMs, Number(process.env.TASK_IDLE_TIMEOUT_MS) || 120_000);
const controlId = process.env.WEB_CONTROL_ID || "web-control";
const jianmu = new JianmuClient(
  process.env.JIANMU_HTTP_URL || "http://127.0.0.1:3179",
  process.env.JIANMU_HUB_URL || "ws://127.0.0.1:3179",
  process.env.JIANMU_AUTH_TOKEN || "",
  controlId,
);

const app = express();
app.use(express.json({ limit: "1mb" }));

const subscribers = new Map<string, Set<express.Response>>();
const pushSubscribers = new Set<express.Response>();
const recentPushes: AgentPushMessage[] = [];
const lastSequence = new Map<string, number>();
const taskStatus = new Map<string, string>();
const taskTimers = new Map<string, NodeJS.Timeout>();
const localTaskEvents = new Map<string, RemoteTaskEvent[]>();
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function publish(event: RemoteTaskEvent): void {
  const clients = subscribers.get(event.taskId);
  if (!clients) return;
  const packet = `id: ${event.sequence}\nevent: task-event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) response.write(packet);
}

function rememberLocalEvent(event: RemoteTaskEvent): void {
  localTaskEvents.set(event.taskId, [...(localTaskEvents.get(event.taskId) || []), event]);
  if (localTaskEvents.size > 500) {
    const oldestTaskId = localTaskEvents.keys().next().value;
    if (oldestTaskId) localTaskEvents.delete(oldestTaskId);
  }
}

function mergeTaskEvents(taskId: string, events: RemoteTaskEvent[]): RemoteTaskEvent[] {
  const bySequence = new Map(events.map((event) => [event.sequence, event]));
  for (const event of localTaskEvents.get(taskId) || []) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

function clearTaskTimer(taskId: string): void {
  const timer = taskTimers.get(taskId);
  if (timer) clearTimeout(timer);
  taskTimers.delete(taskId);
}

function scheduleTaskTimer(taskId: string, phase: "accept" | "idle"): void {
  clearTaskTimer(taskId);
  const delay = phase === "accept" ? taskAcceptTimeoutMs : taskIdleTimeoutMs;
  const timer = setTimeout(() => void failTimedOutTask(taskId, phase), delay);
  timer.unref();
  taskTimers.set(taskId, timer);
}

async function handleTaskEvent(event: RemoteTaskEvent): Promise<void> {
  if (terminalStatuses.has(taskStatus.get(event.taskId) || "")) return;
  const previous = lastSequence.get(event.taskId) ?? 0;
  if (event.sequence <= previous) return;
  lastSequence.set(event.taskId, event.sequence);
  clearTaskTimer(event.taskId);
  publish(event);

  const status = statusForEvent(event.event);
  if (!status || !shouldUpdateStatus(taskStatus.get(event.taskId), status)) {
    scheduleTaskTimer(event.taskId, "idle");
    return;
  }
  taskStatus.set(event.taskId, status);
  if (!terminalStatuses.has(status)) scheduleTaskTimer(event.taskId, "idle");
  try {
    await jianmu.updateTask(event.taskId, status);
  } catch (error) {
    console.error("Failed to update Jianmu task", error);
  }
}

async function failTimedOutTask(taskId: string, phase: "accept" | "idle"): Promise<void> {
  if (terminalStatuses.has(taskStatus.get(taskId) || "")) return;
  const seconds = Math.round((phase === "accept" ? taskAcceptTimeoutMs : taskIdleTimeoutMs) / 1_000);
  const text = phase === "accept"
    ? `远端节点已连接，但未在 ${seconds} 秒内确认接收任务。请检查 Remote Client 版本和 Runtime 状态。`
    : `远端任务在 ${seconds} 秒内没有返回进度，主控已停止等待。`;
  const event: RemoteTaskEvent = {
    version: 1,
    taskId,
    sequence: (lastSequence.get(taskId) ?? 0) + 1,
    event: "failed",
    data: { text, reason: `${phase}_timeout` },
    timestamp: Date.now(),
  };
  rememberLocalEvent(event);
  await handleTaskEvent(event);
  try {
    const task = await jianmu.task(taskId);
    await jianmu.send(task.to, { version: 1, command: "cancel", taskId });
  } catch (error) {
    console.warn(`Failed to cancel timed out task ${taskId}`, error);
  }
}

function publishPush(push: AgentPushMessage): void {
  recentPushes.push(push);
  if (recentPushes.length > 100) recentPushes.shift();
  const packet = `event: agent-push\ndata: ${JSON.stringify(push)}\n\n`;
  for (const response of pushSubscribers) response.write(packet);
}

jianmu.on("taskEvent", (event: RemoteTaskEvent) => void handleTaskEvent(event));

jianmu.on("clientError", (error) => console.error("Jianmu WebSocket error", error));
jianmu.on("agentPush", (push: AgentPushMessage) => publishPush(push));
jianmu.start();

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/clients", async (_req, res, next) => {
  try {
    const clients = (await jianmu.sessions())
      .filter((session) => session.name.startsWith(REMOTE_CLIENT_PREFIX))
      .map((session) => ({
        id: session.name,
        name: session.label || session.name,
        runtime: session.runtime || "node",
        runtimes: session.runtimes || [],
        connectedAt: session.connectedAt || null,
        online: true,
      }));
    res.json(clients);
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks", async (req, res, next) => {
  try {
    const { clientId, message, runtime, agentId, sessionKey, metadata } = req.body ?? {};
    if (typeof clientId !== "string" || !clientId.startsWith(REMOTE_CLIENT_PREFIX)) {
      res.status(400).json({ error: `clientId must start with ${REMOTE_CLIENT_PREFIX}` });
      return;
    }
    if (typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const runtimeId = typeof runtime === "string" && runtime.trim() ? runtime.trim().toLowerCase() : "openclaw";
    const target = (await jianmu.sessions()).find((session) => session.name === clientId);
    if (!target) {
      res.status(409).json({ error: "远端 Agent 当前不在线" });
      return;
    }
    const runtimeInfo = (target.runtimes as RuntimeDescriptor[] | undefined)?.find((item) => item.id === runtimeId);
    if (target.runtimes?.length && !runtimeInfo) {
      res.status(400).json({ error: `远端 Agent 不支持 Runtime: ${runtimeId}` });
      return;
    }
    if (runtimeInfo?.ready === false) {
      res.status(503).json({ error: `${runtimeInfo.label} 尚未就绪${runtimeInfo.detail ? `：${runtimeInfo.detail}` : ""}` });
      return;
    }
    const result = await jianmu.createTask({
      to: clientId,
      message: message.trim(),
      runtime: runtimeId,
      agentId: typeof agentId === "string" && agentId.trim() ? agentId.trim() : undefined,
      sessionKey: typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : undefined,
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : undefined,
    });
    taskStatus.set(result.taskId, "pending");
    scheduleTaskTimer(result.taskId, "accept");
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId", async (req, res, next) => {
  try {
    const task = await jianmu.task(req.params.taskId);
    const messages = await jianmu.messages(req.params.taskId);
    const events = mergeTaskEvents(req.params.taskId, messages
      .map((message) => parseJson<RemoteTaskEvent>(message.content))
      .filter(isRemoteTaskEvent)
      .sort((a, b) => a.sequence - b.sequence));
    res.json({ task, events });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tasks/:taskId/cancel", async (req, res, next) => {
  try {
    const task = await jianmu.task(req.params.taskId);
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      res.status(409).json({ error: `task is already ${task.status}` });
      return;
    }
    const result = await jianmu.send(task.to, {
      version: 1,
      command: "cancel",
      taskId: task.id,
    });
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/events", async (req, res) => {
  const taskId = req.params.taskId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("retry: 1500\n\n");
  const set = subscribers.get(taskId) ?? new Set<express.Response>();
  set.add(res);
  subscribers.set(taskId, set);
  try {
    const history = await jianmu.messages(taskId);
    const events = mergeTaskEvents(taskId, history
      .map((message) => parseJson<RemoteTaskEvent>(message.content))
      .filter(isRemoteTaskEvent)
      .sort((a, b) => a.sequence - b.sequence));
    for (const event of events) {
      res.write(`id: ${event.sequence}\nevent: task-event\ndata: ${JSON.stringify(event)}\n\n`);
    }
  } catch (error) {
    console.error("Failed to replay task event history", error);
  }
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) subscribers.delete(taskId);
  });
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("retry: 1500\n\n");
  for (const push of recentPushes) res.write(`event: agent-push\ndata: ${JSON.stringify(push)}\n\n`);
  pushSubscribers.add(res);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    pushSubscribers.delete(res);
  });
});

const webDist = resolve(here, "../../web/dist");
app.use(express.static(webDist));
app.get("/{*path}", (_req, res, next) => {
  res.sendFile(resolve(webDist, "index.html"), (error) => error && next(error));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(502).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});

app.listen(port, host, () => {
  console.log(`OpenClaw Remote Control: http://${host}:${port}`);
});

function shutdown(): void {
  for (const timer of taskTimers.values()) clearTimeout(timer);
  taskTimers.clear();
  jianmu.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
