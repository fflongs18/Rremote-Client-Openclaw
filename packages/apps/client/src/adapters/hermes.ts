import type {
  AgentRuntime,
  RuntimeCancelInput,
  RuntimeEvent,
  RuntimeHealth,
  RuntimeRunInput,
} from "../runtime/types.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HermesAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  provider?: string;
  fetch?: FetchLike;
  requestTimeoutMs?: number;
}

interface HermesCapabilities {
  features?: {
    run_submission?: boolean;
    run_events_sse?: boolean;
    run_stop?: boolean;
  };
}

interface HermesRunResponse {
  run_id?: string;
  status?: string;
}

interface HermesRunEvent {
  event?: string;
  run_id?: string;
  status?: string;
  timestamp?: number;
  delta?: unknown;
  output?: unknown;
  error?: unknown;
  message?: unknown;
  tool?: unknown;
  preview?: unknown;
  summary?: unknown;
  output_tail?: unknown;
  duration?: unknown;
  usage?: unknown;
  [key: string]: unknown;
}

interface SseMessage {
  event?: string;
  data: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  return value < 10_000_000_000 ? Math.round(value * 1_000) : Math.round(value);
}

function responseError(status: number, body: string): Error {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown };
    if (typeof parsed.detail === "string") detail = parsed.detail;
    if (typeof parsed.error === "string") detail = parsed.error;
    if (parsed.error && typeof parsed.error === "object") {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === "string") detail = message;
    }
  } catch {
    // Preserve the response body when Hermes did not return JSON.
  }
  return new Error(`Hermes ${status}${detail ? `: ${detail}` : ""}`);
}

function parseSseFrame(frame: string): SseMessage | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    let value = separator === -1 ? "" : rawLine.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

export async function* parseHermesSse(stream: ReadableStream<Uint8Array>): AsyncIterable<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const message = parseSseFrame(frame);
        if (message) yield message;
      }
      if (done) break;
    }
    const trailing = parseSseFrame(buffer);
    if (trailing) yield trailing;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response may already have been closed or aborted.
    }
    reader.releaseLock();
  }
}

function terminalEvent(event: HermesRunEvent, runId: string, sessionKey: string, sawOutput: boolean): RuntimeEvent | null {
  const timestamp = eventTimestamp(event.timestamp);
  switch (event.event) {
    case "run.completed": {
      const text = sawOutput ? undefined : stringValue(event.output);
      const data = text || event.usage
        ? { ...(text ? { text } : {}), ...(event.usage ? { usage: event.usage } : {}) }
        : undefined;
      return { event: "completed", runId, sessionKey, ...(data ? { data } : {}), timestamp };
    }
    case "run.failed":
      return {
        event: "failed",
        runId,
        sessionKey,
        data: { text: stringValue(event.error) || stringValue(event.message) || "Hermes run failed" },
        timestamp,
      };
    case "run.cancelled":
      return { event: "cancelled", runId, sessionKey, timestamp };
    default:
      return null;
  }
}

function runtimeEventFromHermes(
  event: HermesRunEvent,
  runId: string,
  sessionKey: string,
  sawOutput: boolean,
): RuntimeEvent | null {
  const terminal = terminalEvent(event, runId, sessionKey, sawOutput);
  if (terminal) return terminal;

  const timestamp = eventTimestamp(event.timestamp);
  switch (event.event) {
    case "message.delta": {
      const text = stringValue(event.delta);
      return text ? { event: "output", runId, sessionKey, data: { text }, timestamp } : null;
    }
    case "tool.started": {
      const tool = stringValue(event.tool) || "Hermes tool";
      return {
        event: "tool_use",
        runId,
        sessionKey,
        data: { text: stringValue(event.preview) || tool, tool },
        timestamp,
      };
    }
    case "subagent.start":
      return {
        event: "tool_use",
        runId,
        sessionKey,
        data: { text: stringValue(event.preview) || "Hermes subagent started", tool: "delegate_task", native: event },
        timestamp,
      };
    case "tool.completed": {
      const tool = stringValue(event.tool) || "Hermes tool";
      return {
        event: "tool_result",
        runId,
        sessionKey,
        data: {
          text: stringValue(event.preview) || `${tool} completed`,
          tool,
          ...(typeof event.duration === "number" ? { duration: event.duration } : {}),
          ...(typeof event.error === "boolean" ? { error: event.error } : {}),
        },
        timestamp,
      };
    }
    case "subagent.complete":
      return {
        event: "tool_result",
        runId,
        sessionKey,
        data: {
          text: stringValue(event.preview) || stringValue(event.summary) || stringValue(event.output_tail) || "Hermes subagent completed",
          tool: "delegate_task",
          native: event,
        },
        timestamp,
      };
    case "approval.request":
      return {
        event: "tool_use",
        runId,
        sessionKey,
        data: { text: stringValue(event.preview) || "Hermes is waiting for approval", tool: "approval", approval: event },
        timestamp,
      };
    default:
      return null;
  }
}

export class HermesAdapter implements AgentRuntime {
  readonly id = "hermes";
  readonly label = "Hermes";
  readonly capabilities = ["chat", "stream", "cancel", "tools"] as const;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model?: string;
  private readonly provider?: string;
  private readonly fetch: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly activeRuns = new Map<string, string>();
  private readonly activeStreams = new Map<string, AbortController>();
  private connected = false;
  private connecting: Promise<void> | null = null;

  constructor(options: HermesAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || undefined;
    this.provider = options.provider?.trim() || undefined;
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs || 10_000);
  }

  private headers(init?: HeadersInit): Headers {
    const headers = new Headers(init);
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    return headers;
  }

  private async fetchWithTimeout(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    timer.unref?.();
    const abort = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new Error(`Hermes request timed out after ${this.requestTimeoutMs}ms: ${path}`);
      throw error;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = this.headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await this.fetchWithTimeout(path, { ...init, headers });
    const body = await response.text();
    if (!response.ok) throw responseError(response.status, body);
    if (!body) return undefined as T;
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`Hermes returned invalid JSON from ${path}`);
    }
  }

  private async probe(): Promise<void> {
    const capabilities = await this.requestJson<HermesCapabilities>("/v1/capabilities");
    const features = capabilities?.features;
    if (!features?.run_submission || !features.run_events_sse || !features.run_stop) {
      throw new Error("Hermes API server does not expose the required Runs API capabilities");
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this.probe()
        .then(() => { this.connected = true; })
        .finally(() => { this.connecting = null; });
    }
    await this.connecting;
  }

  async disconnect(): Promise<void> {
    for (const controller of this.activeStreams.values()) controller.abort();
    this.activeStreams.clear();
    this.activeRuns.clear();
    this.connected = false;
  }

  async *run(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    await this.connect();
    const created = await this.requestJson<HermesRunResponse>("/v1/runs", {
      method: "POST",
      body: JSON.stringify({
        input: input.message,
        session_id: input.sessionKey,
        ...(this.model ? { model: this.model } : {}),
        ...(this.provider ? { provider: this.provider } : {}),
      }),
    });
    const runId = created?.run_id;
    if (!runId) throw new Error("Hermes did not return a run_id");

    this.activeRuns.set(input.sessionKey, runId);
    yield { event: "started", runId, sessionKey: input.sessionKey, timestamp: Date.now() };

    const controller = new AbortController();
    this.activeStreams.set(runId, controller);
    let sawOutput = false;
    let terminal = false;
    try {
      const response = await this.fetchWithTimeout(`/v1/runs/${encodeURIComponent(runId)}/events`, {
        headers: this.headers({ Accept: "text/event-stream" }),
        signal: controller.signal,
      });
      if (!response.ok) throw responseError(response.status, await response.text());
      if (!response.body) throw new Error("Hermes returned an empty event stream");

      for await (const message of parseHermesSse(response.body)) {
        if (message.data === "[DONE]") continue;
        let nativeEvent: HermesRunEvent;
        try {
          nativeEvent = JSON.parse(message.data) as HermesRunEvent;
        } catch {
          throw new Error("Hermes emitted invalid JSON in the event stream");
        }
        if (!nativeEvent.event && message.event) nativeEvent.event = message.event;
        const event = runtimeEventFromHermes(nativeEvent, runId, input.sessionKey, sawOutput);
        if (!event) continue;
        if (event.event === "output") sawOutput = true;
        if (["completed", "failed", "cancelled"].includes(event.event)) terminal = true;
        yield event;
        if (terminal) break;
      }

      if (!terminal) {
        const status = await this.requestJson<HermesRunEvent>(`/v1/runs/${encodeURIComponent(runId)}`);
        const nativeStatus = status.status ? { ...status, event: `run.${status.status}` } : status;
        const event = terminalEvent(nativeStatus, runId, input.sessionKey, sawOutput);
        if (event) yield event;
        else {
          yield {
            event: "failed",
            runId,
            sessionKey: input.sessionKey,
            data: { text: `Hermes event stream ended before a terminal status (${status.status || "unknown"})` },
            timestamp: Date.now(),
          };
        }
      }
    } finally {
      this.activeStreams.delete(runId);
      if (this.activeRuns.get(input.sessionKey) === runId) this.activeRuns.delete(input.sessionKey);
    }
  }

  async cancel(input: RuntimeCancelInput): Promise<void> {
    const runId = input.runId || this.activeRuns.get(input.sessionKey);
    if (!runId) throw new Error(`No active Hermes run for session ${input.sessionKey}`);
    await this.requestJson(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  }

  async health(): Promise<RuntimeHealth> {
    try {
      await this.probe();
      this.connected = true;
      return { ok: true, connected: true };
    } catch (error) {
      this.connected = false;
      return { ok: false, connected: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
