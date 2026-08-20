import dotenv from "dotenv";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
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
import { ingestHubPushes, rememberPush } from "./pushes.js";
import { shouldUpdateStatus } from "./status.js";
import { createEnrollment, consumeEnrollment, enrollmentBaseUrl, getEnrollment, isControlUiHost } from "./enrollment.js";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "../../../../.env") });

const host = process.env.BFF_HOST || "127.0.0.1";
const port = Number(process.env.BFF_PORT || 8788);
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
const repoRoot = resolve(here, "../../../..");
const publicPaths = /^(\/api\/health$|\/api\/enroll\/|\/enroll\/|\/release\/|\/assets\/|\/health$|\/pairing-sessions\/exchange$|\/nodes(?:\/|$)|\/tasks(?:\/|$)|\/send$)/;
app.use((req, res, next) => {
  if (isControlUiHost(req.hostname) || publicPaths.test(req.path)) { next(); return; }
  res.status(404).send("Not found");
});

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

function writeSseHeaders(res: express.Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

function publishPush(push: AgentPushMessage): void {
  if (!rememberPush(recentPushes, push)) return;
  console.log(`[agent-push] ${push.from} ${push.title || push.text.slice(0, 40)} ${push.messageId}`);
  const packet = `event: agent-push\ndata: ${JSON.stringify(push)}\n\n`;
  for (const response of pushSubscribers) response.write(packet);
}

async function hydrateRecentPushes(): Promise<void> {
  try {
    ingestHubPushes(recentPushes, await jianmu.inbox(200));
  } catch (error) {
    console.error("Failed to load agent-push history", error);
  }
}

jianmu.on("taskEvent", (event: RemoteTaskEvent) => void handleTaskEvent(event));

jianmu.on("clientError", (error) => console.error("Jianmu WebSocket error", error));
jianmu.on("agentPush", (push: AgentPushMessage) => publishPush(push));
jianmu.on("connection", (online: boolean) => {
  if (online) void hydrateRecentPushes();
});
jianmu.start();
void hydrateRecentPushes();

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/release/install.ps1", (_req, res) => { res.type("text/plain"); res.sendFile(resolve(repoRoot, "install.ps1")); });
app.get("/release/install.sh", (_req, res) => { res.type("text/x-shellscript"); res.sendFile(resolve(repoRoot, "install.sh")); });
app.get("/release/release.json", (_req, res) => { res.type("application/json"); res.sendFile(resolve(repoRoot, "release.json")); });
app.get("/release/artifacts/:file", (req, res) => {
  if (!/^RemoteOpenClaw-[A-Za-z0-9._-]+\.(zip|tar\.gz)(\.sha256)?$/.test(req.params.file)) {
    res.status(404).send("Release artifact not found");
    return;
  }
  res.sendFile(resolve(repoRoot, "artifacts", req.params.file));
});

app.post("/api/pairing", async (req, res, next) => {
  try {
    const nodeName = typeof req.body?.nodeName === "string" && req.body.nodeName.trim() ? req.body.nodeName.trim() : "Remote Client";
    const pairing = await jianmu.createPairingSession(nodeName);
    const enrollment = createEnrollment(nodeName, pairing.code, pairing.expiresAt);
    const base = enrollmentBaseUrl(req);
    const installUrl = `${base}/enroll/${enrollment.token}`;
    res.status(201).json({ id: enrollment.id, deviceName: nodeName, expiresAt: enrollment.expiresAt, installUrl, windowsInstallUrl: `${base}/api/enroll/${enrollment.token}/windows`, macInstallUrl: `${base}/api/enroll/${enrollment.token}/macos` });
  } catch (error) { next(error); }
});

app.get("/api/enroll/:token", (req, res) => {
  const session = getEnrollment(req.params.token);
  if (!session) { res.status(404).json({ error: "安装链接已失效或不存在" }); return; }
  res.json({ id: session.id, deviceName: session.nodeName, expiresAt: session.expiresAt, used: Boolean(session.usedAt), windowsInstallUrl: `${enrollmentBaseUrl(req)}/api/enroll/${session.token}/windows`, macInstallUrl: `${enrollmentBaseUrl(req)}/api/enroll/${session.token}/macos` });
});

app.get("/api/enroll/:token/:platform", (req, res) => {
  const session = getEnrollment(req.params.token);
  if (!session) { res.status(404).send("安装链接已失效或不存在"); return; }
  if (req.params.platform !== "windows" && req.params.platform !== "macos") { res.status(404).send("不支持的安装平台"); return; }
  const base = process.env.REMOTE_OC_RELEASE_BASE_URL?.trim();
  if (!base) { res.status(503).send("发布下载地址尚未配置"); return; }
  const root = `${base.replace(/\/$/, "")}/install.${req.params.platform === "macos" ? "sh" : "ps1"}`;
  const enrollUrl = `${enrollmentBaseUrl(req)}/api/enroll/${session.token}/exchange`;
  res.setHeader("Content-Type", req.params.platform === "macos" ? "text/x-shellscript" : "text/plain");
  res.setHeader("Content-Disposition", `attachment; filename=\"Remote-OC-${req.params.platform === "macos" ? "Mac" : "Windows"}-Installer.${req.params.platform === "macos" ? "command" : "ps1"}\"`);
  if (req.params.platform === "macos") {
    res.send(`#!/usr/bin/env bash\nset -euo pipefail\nprintf '\\n[Remote-OC] 正在准备安装器...\\n'\ntmp=$(mktemp)\ntrap 'rm -f "$tmp"' EXIT\ncurl --http1.1 --retry 3 --retry-delay 2 --retry-all-errors --fail --show-error --location --connect-timeout 15 --max-time 300 --progress-bar '${root}' -o "$tmp"\nexec bash "$tmp" --enroll-url '${enrollUrl}'\n`);
  } else {
    res.send(`$ErrorActionPreference = 'Stop'
$tmp = Join-Path $env:TEMP 'remote-oc-install.ps1'
$headers = @{ 'ngrok-skip-browser-warning' = '1' }
$downloadUri = '${root}'
if ($downloadUri -match 'ngrok') { $downloadUri += '?ngrok-skip-browser-warning=1' }
$exitCode = 1
try {
  $message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5q2j5Zyo5YeG5aSH5a6J6KOF5ZmoLi4u'))
  Write-Host "\n[Remote-OC] $message"
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try { Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $downloadUri -OutFile $tmp; break }
    catch {
      $status = $null
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
      if (($status -ge 400 -and $status -lt 500) -or $attempt -eq 4) { throw }
      Start-Sleep -Seconds 2
    }
  }
  $content = Get-Content -LiteralPath $tmp -Raw
  if (-not $content -or $content -match '(?im)^\\s*ERR_NGROK_\\d+\\s*$|^\\s*You are about to visit') { throw 'ngrok returned an interstitial page instead of the Remote-OC installer' }
  $tokens = $null; $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($tmp, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) { throw "Downloaded Remote-OC installer is not valid PowerShell: $($parseErrors[0].Message)" }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp -EnrollUrl '${enrollUrl}'
  $exitCode = $LASTEXITCODE
} catch {
  Write-Error $_
  $exitCode = 1
} finally {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
exit $exitCode
`);
  }
});

app.post("/api/enroll/:token/exchange", async (req, res, next) => {
  try {
    const session = consumeEnrollment(req.params.token);
    if (!session) { res.status(410).json({ error: "安装链接已失效或不存在" }); return; }
    const manifestUrl = process.env.REMOTE_OC_RELEASE_BASE_URL ? `${process.env.REMOTE_OC_RELEASE_BASE_URL.replace(/\/$/, "")}/release.json` : "";
    const hubUrl = process.env.JIANMU_PUBLIC_HTTP_URL || process.env.JIANMU_HTTP_URL || "http://127.0.0.1:3179";
    res.json({ hubUrl, pairingCode: session.pairingCode, deviceName: session.nodeName, manifestUrl, defaultRuntime: process.env.DEFAULT_RUNTIME || "openclaw", openClawUrl: process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789", hermesUrl: process.env.HERMES_API_URL || "http://127.0.0.1:8642", requireHermes: process.env.REQUIRE_HERMES === "1", startHermes: process.env.START_HERMES === "1" });
  } catch (error) { next(error); }
});

app.get("/api/enroll/:token/status", async (req, res, next) => {
  try {
    const session = getEnrollment(req.params.token);
    if (!session) { res.status(404).json({ status: "expired" }); return; }
    if (!session.usedAt) { res.json({ status: "ready", deviceName: session.nodeName, expiresAt: session.expiresAt }); return; }
    const clients = await jianmu.sessions();
    const connected = clients.some((client) => client.label === session.nodeName || client.name === session.nodeName);
    res.json({ status: connected ? "connected" : "installing", deviceName: session.nodeName, expiresAt: session.expiresAt });
  } catch (error) { next(error); }
});

const hubProxyPaths = /^\/(health|pairing-sessions\/exchange|nodes(?:\/|$)|tasks(?:\/|$)|send$)/;
app.use(async (req, res, next) => {
  if (!hubProxyPaths.test(req.path)) { next(); return; }
  try {
    const headers = new Headers();
    if (req.headers.authorization) headers.set("Authorization", req.headers.authorization);
    if (req.headers["content-type"]) headers.set("Content-Type", String(req.headers["content-type"]));
    const method = req.method.toUpperCase();
    const upstream = await fetch(`${process.env.JIANMU_HTTP_URL || "http://127.0.0.1:3179"}${req.originalUrl}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
    });
    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) { next(error); }
});

app.get("/api/nodes", async (_req, res, next) => {
  try { res.json(await jianmu.nodes()); } catch (error) { next(error); }
});

app.post("/api/nodes/:nodeId/revoke", async (req, res, next) => {
  try { res.json(await jianmu.revokeNode(req.params.nodeId)); } catch (error) { next(error); }
});

app.post("/api/nodes/:nodeId/rename", async (req, res, next) => {
  try {
    if (typeof req.body?.nodeName !== "string" || !req.body.nodeName.trim()) { res.status(400).json({ error: "nodeName is required" }); return; }
    res.json(await jianmu.renameNode(req.params.nodeId, req.body.nodeName.trim()));
  } catch (error) { next(error); }
});

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

app.get("/api/pushes", async (_req, res, next) => {
  try {
    await hydrateRecentPushes();
    res.json([...recentPushes].reverse());
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/:taskId/events", async (req, res) => {
  const taskId = req.params.taskId;
  writeSseHeaders(res);
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
  writeSseHeaders(res);
  res.flushHeaders();
  res.write("retry: 1500\n\n");
  let closed = false;
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    pushSubscribers.delete(res);
  });
  void hydrateRecentPushes().then(() => {
    if (closed || res.writableEnded) return;
    for (const push of recentPushes) res.write(`event: agent-push\ndata: ${JSON.stringify(push)}\n\n`);
    pushSubscribers.add(res);
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

const server = app.listen(port, host, () => {
  console.log(`OpenClaw Remote Control: http://${host}:${port}`);
});
const proxyWss = new WebSocketServer({ noServer: true });
function closeProxyPeer(peer: WebSocket, code: number, reason: Buffer): void {
  if (peer.readyState !== WebSocket.OPEN && peer.readyState !== WebSocket.CONNECTING) return;
  if (code >= 1000 && code <= 4999 && code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015) {
    peer.close(code, reason.toString().slice(0, 123));
  } else {
    peer.terminate();
  }
}
server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/ws")) { socket.destroy(); return; }
  proxyWss.handleUpgrade(request, socket, head, (downstream) => {
    const upstreamBase = process.env.JIANMU_HUB_URL || "ws://127.0.0.1:3179";
    const upstream = new WebSocket(`${upstreamBase.replace(/\/$/, "")}${request.url}`);
    const pending: WebSocket.RawData[] = [];
    downstream.on("message", (data) => upstream.readyState === WebSocket.OPEN ? upstream.send(data) : pending.push(data));
    upstream.on("open", () => { for (const data of pending) upstream.send(data); });
    upstream.on("message", (data) => { if (downstream.readyState === WebSocket.OPEN) downstream.send(data); });
    upstream.on("close", (code, reason) => closeProxyPeer(downstream, code, reason));
    downstream.on("close", (code, reason) => closeProxyPeer(upstream, code, reason));
    upstream.on("error", () => downstream.close(1011, "Hub connection failed"));
    downstream.on("error", () => upstream.close());
  });
});

function shutdown(): void {
  for (const timer of taskTimers.values()) clearTimeout(timer);
  taskTimers.clear();
  jianmu.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
