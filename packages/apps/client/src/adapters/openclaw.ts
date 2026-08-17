import { OpenClawClient } from "openclaw-node";
import { eventFromChunk } from "../events.js";
import { normalizeChatStream } from "../stream.js";
import type { AgentRuntime, RuntimeCancelInput, RuntimeEvent, RuntimeHealth, RuntimeRunInput } from "../runtime/types.js";

export interface OpenClawAdapterOptions {
  url: string;
  token?: string;
  clientId?: string;
  deviceIdentityPath?: string;
}

export class OpenClawAdapter implements AgentRuntime {
  readonly id = "openclaw";
  readonly label = "OpenClaw";
  readonly capabilities = ["chat", "stream", "cancel", "push", "tools"] as const;

  private readonly client: OpenClawClient;
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(options: OpenClawAdapterOptions) {
    this.client = new OpenClawClient({
      url: options.url,
      token: options.token,
      autoReconnect: true,
      clientId: options.clientId || "gateway-client",
      deviceIdentityPath: options.deviceIdentityPath,
    });
    this.client.on("disconnected", () => { this.connected = false; });
    this.client.on("error", (error) => console.error("OpenClaw runtime error", error));
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this.client.connect()
        .then(() => { this.connected = true; })
        .finally(() => { this.connecting = null; });
    }
    await this.connecting;
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.connected = false;
  }

  async *run(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    await this.connect();
    const stream = normalizeChatStream(this.client.chat(input.message, {
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      clientMessageId: input.clientMessageId,
    }));
    for await (const chunk of stream) {
      const event = eventFromChunk(chunk, { taskId: "runtime", sequence: 0, sessionKey: input.sessionKey });
      if (!event) continue;
      yield {
        event: event.event,
        runId: event.runId,
        sessionKey: event.sessionKey,
        data: event.data,
        timestamp: event.timestamp,
      };
    }
  }

  async cancel(input: RuntimeCancelInput): Promise<void> {
    await this.client.chatAbort(input.sessionKey, input.runId);
  }

  async health(): Promise<RuntimeHealth> {
    return { ok: this.connected, connected: this.connected };
  }
}
