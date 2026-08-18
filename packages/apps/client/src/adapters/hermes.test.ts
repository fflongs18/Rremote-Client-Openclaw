import { describe, expect, it } from "vitest";
import { HermesAdapter, type FetchLike } from "./hermes.js";
import { RuntimeRegistry } from "../runtime/registry.js";

const encoder = new TextEncoder();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(): { response: Response; push: (chunk: string) => void; close: () => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
  });
  return {
    response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    push(chunk) { controller?.enqueue(encoder.encode(chunk)); },
    close() { controller?.close(); },
  };
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function createFetch(
  eventStream: Response,
  status: Record<string, unknown> = { run_id: "run_test", status: "running" },
): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/capabilities")) {
      return jsonResponse({ features: { run_submission: true, run_events_sse: true, run_stop: true } });
    }
    if (url.endsWith("/v1/runs") && init?.method === "POST") {
      return jsonResponse({ run_id: "run_test", status: "started" }, 202);
    }
    if (url.endsWith("/v1/runs/run_test/events")) return eventStream;
    if (url.endsWith("/v1/runs/run_test/stop")) return jsonResponse({ run_id: "run_test", status: "stopping" });
    if (url.endsWith("/v1/runs/run_test")) return jsonResponse(status);
    throw new Error(`Unexpected request ${url}`);
  };
  return { fetch, calls };
}

describe("HermesAdapter", () => {
  it("is discoverable and reports Runs API readiness", async () => {
    const eventStream = streamResponse();
    const { fetch, calls } = createFetch(eventStream.response);
    const adapter = new HermesAdapter({ baseUrl: "http://hermes.test/", apiKey: "secret", fetch });
    const [description] = await new RuntimeRegistry().register(adapter).describeHealth();

    expect(description).toEqual(expect.objectContaining({
      id: "hermes",
      label: "Hermes",
      ready: true,
      capabilities: ["chat", "stream", "cancel", "tools"],
    }));
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("remains discoverable with a useful detail when Hermes is offline", async () => {
    const adapter = new HermesAdapter({
      baseUrl: "http://hermes.test",
      fetch: async () => { throw new Error("connection refused"); },
    });
    const [description] = await new RuntimeRegistry().register(adapter).describeHealth();

    expect(description).toMatchObject({ id: "hermes", ready: false, detail: "connection refused" });
  });

  it("forwards split SSE deltas immediately and emits one completion", async () => {
    const eventStream = streamResponse();
    const { fetch, calls } = createFetch(eventStream.response);
    const adapter = new HermesAdapter({
      baseUrl: "http://hermes.test",
      apiKey: "secret",
      model: "gpt-test",
      provider: "provider-test",
      fetch,
    });
    const iterator = adapter.run({ message: "hello", sessionKey: "session-1" })[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ event: "started", runId: "run_test" });
    const firstEvent = iterator.next();
    eventStream.push(`data: {"event":"message.delta","delta":"Hel`);
    eventStream.push(`lo","timestamp":1000}\n\n`);
    expect(await firstEvent).toMatchObject({
      value: { event: "output", data: { text: "Hello" }, timestamp: 1_000_000 },
      done: false,
    });

    eventStream.push(sse({ event: "run.completed", output: "Hello", usage: { total_tokens: 2 } }));
    expect(await iterator.next()).toMatchObject({
      value: { event: "completed", runId: "run_test", data: { usage: { total_tokens: 2 } } },
      done: false,
    });
    expect((await iterator.next()).done).toBe(true);

    const submit = calls.find((call) => call.url.endsWith("/v1/runs"));
    expect(JSON.parse(String(submit?.init?.body))).toEqual({
      input: "hello",
      session_id: "session-1",
      model: "gpt-test",
      provider: "provider-test",
    });
    expect(new Headers(submit?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("maps tool lifecycle and failed terminal events", async () => {
    const eventStream = streamResponse();
    const { fetch } = createFetch(eventStream.response);
    const adapter = new HermesAdapter({ baseUrl: "http://hermes.test", fetch });
    const iterator = adapter.run({ message: "use a tool", sessionKey: "session-2" })[Symbol.asyncIterator]();

    await iterator.next();
    const toolStarted = iterator.next();
    eventStream.push(sse({ event: "tool.started", tool: "terminal", preview: "running command" }));
    expect(await toolStarted).toMatchObject({ value: { event: "tool_use", data: { tool: "terminal" } } });

    const toolCompleted = iterator.next();
    eventStream.push(sse({ event: "tool.completed", tool: "terminal", duration: 0.4, error: false }));
    expect(await toolCompleted).toMatchObject({ value: { event: "tool_result", data: { duration: 0.4, error: false } } });

    const failed = iterator.next();
    eventStream.push(sse({ event: "run.failed", error: "provider rejected request" }));
    expect(await failed).toMatchObject({ value: { event: "failed", data: { text: "provider rejected request" } } });
  });

  it("calls the stop endpoint and maps run cancellation", async () => {
    const eventStream = streamResponse();
    const { fetch, calls } = createFetch(eventStream.response);
    const adapter = new HermesAdapter({ baseUrl: "http://hermes.test", fetch });
    const iterator = adapter.run({ message: "long task", sessionKey: "session-3" })[Symbol.asyncIterator]();

    await iterator.next();
    const pending = iterator.next();
    await adapter.cancel({ sessionKey: "session-3" });
    expect(calls.at(-1)?.url).toBe("http://hermes.test/v1/runs/run_test/stop");
    eventStream.push(sse({ event: "run.cancelled" }));
    expect(await pending).toMatchObject({ value: { event: "cancelled", runId: "run_test" } });
  });

  it("polls the terminal status if the SSE connection closes early", async () => {
    const eventStream = streamResponse();
    const { fetch } = createFetch(eventStream.response, {
      run_id: "run_test",
      status: "completed",
      output: "result from status",
    });
    const adapter = new HermesAdapter({ baseUrl: "http://hermes.test", fetch });
    const iterator = adapter.run({ message: "hello", sessionKey: "session-4" })[Symbol.asyncIterator]();

    await iterator.next();
    const terminal = iterator.next();
    eventStream.close();
    expect(await terminal).toMatchObject({
      value: { event: "completed", data: { text: "result from status" } },
      done: false,
    });
  });
});
