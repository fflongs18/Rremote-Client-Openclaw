import "dotenv/config";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { REMOTE_CLIENT_PREFIX, type AgentPushMessage } from "@remote-oc/protocol";

const clientId = process.env.REMOTE_CLIENT_ID || `remote-oc-${os.hostname().toLowerCase()}`;
const hubUrl = process.env.JIANMU_HTTP_URL || "http://127.0.0.1:3179";
const token = process.env.JIANMU_AUTH_TOKEN || "";
const controlId = process.env.WEB_CONTROL_ID || "web-control";
const text = process.argv.slice(2).join(" ").trim();

if (!clientId.startsWith(REMOTE_CLIENT_PREFIX)) throw new Error(`REMOTE_CLIENT_ID must start with ${REMOTE_CLIENT_PREFIX}`);
if (!text) throw new Error("Usage: npm run push -- \"message to the control panel\"");

const push: AgentPushMessage = {
  version: 1,
  type: "agent-push",
  messageId: `push_${Date.now()}_${randomUUID().slice(0, 8)}`,
  from: clientId,
  to: controlId,
  ...(process.env.PUSH_SESSION_KEY ? { sessionKey: process.env.PUSH_SESSION_KEY } : {}),
  ...(process.env.PUSH_TITLE ? { title: process.env.PUSH_TITLE } : {}),
  text,
  level: (process.env.PUSH_LEVEL as AgentPushMessage["level"]) || "info",
  timestamp: Date.now(),
};

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (token) headers.Authorization = `Bearer ${token}`;
const response = await fetch(`${hubUrl}/send`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    from: clientId,
    to: controlId,
    content: JSON.stringify(push),
    topic: "agent-push",
    contentType: "agent-push",
  }),
});
const body = await response.text();
if (!response.ok) throw new Error(`Jianmu ${response.status}: ${body}`);
console.log(`Push sent from ${clientId}: ${text}`);
