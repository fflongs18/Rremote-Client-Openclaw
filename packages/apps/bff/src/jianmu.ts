import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  type JianmuMessage,
  type RemoteTaskEvent,
  type AgentPushMessage,
  isAgentPushMessage,
  isRemoteTaskEvent,
  parseJson,
} from "@remote-oc/protocol";

export interface JianmuTask {
  id: string;
  from: string;
  to: string;
  title: string;
  description: string;
  status: string;
  payload?: unknown;
  ts: number;
  updated_at: number;
  completed_at?: number | null;
}

export interface JianmuSession {
  name: string;
  connectedAt?: number;
  runtime?: string;
  label?: string;
  [key: string]: unknown;
}

export class JianmuClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    readonly httpUrl: string,
    readonly wsUrl: string,
    readonly token: string,
    readonly sessionName: string,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    const url = new URL(this.wsUrl);
    url.searchParams.set("name", this.sessionName);
    if (this.token) url.searchParams.set("token", this.token);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.sendRaw({
        type: "register",
        name: this.sessionName,
        pid: process.pid,
        cwd: process.cwd(),
        runtime: "node",
        label: "OpenClaw Web Control",
      });
      this.emit("connection", true);
    });

    ws.on("message", (raw) => {
      const message = parseJson<JianmuMessage>(raw.toString());
      if (!message) return;
      if (message.type === "ping") {
        this.sendRaw({ type: "pong" });
        return;
      }
      if (message.type !== "message" || typeof message.content !== "string") return;
      const event = parseJson<RemoteTaskEvent>(message.content);
      if (isRemoteTaskEvent(event)) this.emit("taskEvent", event, message);
      const push = parseJson<AgentPushMessage>(message.content);
      if (isAgentPushMessage(push)) this.emit("agentPush", push, message);
    });

    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", (error) => this.emit("clientError", error));
  }

  private scheduleReconnect(): void {
    this.emit("connection", false);
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  private sendRaw(message: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("Jianmu WebSocket is not connected");
    this.ws.send(JSON.stringify(message));
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.httpUrl}${path}`, { ...init, headers });
    const body = await response.text();
    if (!response.ok) throw new Error(`Jianmu ${response.status}: ${body}`);
    return (body ? JSON.parse(body) : null) as T;
  }

  sessions(): Promise<JianmuSession[]> {
    return this.request<JianmuSession[]>("/sessions");
  }

  createTask(input: {
    to: string;
    message: string;
    agentId?: string;
    sessionKey?: string;
  }): Promise<{ ok: true; taskId: string; online: boolean; buffered: boolean }> {
    return this.request("/task", {
      method: "POST",
      body: JSON.stringify({
        from: this.sessionName,
        to: input.to,
        title: "OpenClaw chat",
        description: input.message,
        payload: {
          message: input.message,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
        },
      }),
    });
  }

  task(taskId: string): Promise<JianmuTask> {
    return this.request<JianmuTask>(`/tasks/${encodeURIComponent(taskId)}`);
  }

  updateTask(taskId: string, status: string): Promise<unknown> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  send(to: string, content: unknown, topic = "remote-control", contentType = "control"): Promise<unknown> {
    return this.request("/send", {
      method: "POST",
      body: JSON.stringify({
        from: this.sessionName,
        to,
        content: JSON.stringify(content),
        topic,
        contentType,
      }),
    });
  }

  messages(taskId: string): Promise<JianmuMessage[]> {
    return this.request<JianmuMessage[]>(`/messages?limit=500&to=${encodeURIComponent(this.sessionName)}`)
      .then((messages) => messages.filter((message) => {
        const event = parseJson<RemoteTaskEvent>(message.content);
        return isRemoteTaskEvent(event) && event.taskId === taskId;
      }));
  }
}
