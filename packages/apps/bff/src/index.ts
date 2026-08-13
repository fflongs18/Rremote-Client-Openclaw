import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  REMOTE_CLIENT_PREFIX,
  type RemoteTaskEvent,
  type AgentPushMessage,
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

function publish(event: RemoteTaskEvent): void {
  const clients = subscribers.get(event.taskId);
  if (!clients) return;
  const packet = `id: ${event.sequence}\nevent: task-event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) response.write(packet);
}

function publishPush(push: AgentPushMessage): void {
  recentPushes.push(push);
  if (recentPushes.length > 100) recentPushes.shift();
  const packet = `event: agent-push\ndata: ${JSON.stringify(push)}\n\n`;
  for (const response of pushSubscribers) response.write(packet);
}

jianmu.on("taskEvent", async (event: RemoteTaskEvent) => {
  const previous = lastSequence.get(event.taskId) ?? 0;
  if (event.sequence <= previous) return;
  lastSequence.set(event.taskId, event.sequence);
  publish(event);

  const status = statusForEvent(event.event);
  if (!status) return;
  if (!shouldUpdateStatus(taskStatus.get(event.taskId), status)) return;
  taskStatus.set(event.taskId, status);
  try {
    await jianmu.updateTask(event.taskId, status);
  } catch (error) {
    console.error("Failed to update Jianmu task", error);
  }
});

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
    const { clientId, message, agentId, sessionKey } = req.body ?? {};
    if (typeof clientId !== "string" || !clientId.startsWith(REMOTE_CLIENT_PREFIX)) {
      res.status(400).json({ error: `clientId must start with ${REMOTE_CLIENT_PREFIX}` });
      return;
    }
    if (typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const result = await jianmu.createTask({
      to: clientId,
      message: message.trim(),
      agentId: typeof agentId === "string" && agentId.trim() ? agentId.trim() : undefined,
      sessionKey: typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : undefined,
    });
    taskStatus.set(result.taskId, "pending");
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId", async (req, res, next) => {
  try {
    const task = await jianmu.task(req.params.taskId);
    const messages = await jianmu.messages(req.params.taskId);
    const events = messages
      .map((message) => parseJson<RemoteTaskEvent>(message.content))
      .filter(isRemoteTaskEvent)
      .sort((a, b) => a.sequence - b.sequence);
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
    const events = history
      .map((message) => parseJson<RemoteTaskEvent>(message.content))
      .filter(isRemoteTaskEvent)
      .sort((a, b) => a.sequence - b.sequence);
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
  jianmu.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
