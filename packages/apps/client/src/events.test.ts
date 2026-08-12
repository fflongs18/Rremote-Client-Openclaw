import { describe, expect, it } from "vitest";
import { eventFromChunk, eventNameForChunk } from "./events.js";

describe("OpenClaw event mapping", () => {
  it("does not treat done as task completion", () => {
    expect(eventNameForChunk({ type: "done", text: "", runId: "run-1" })).toBe("turn_done");
  });

  it("maps streamed text with correlation fields", () => {
    const event = eventFromChunk(
      { type: "text", text: "hello", runId: "run-1" },
      { taskId: "task-1", sequence: 4, sessionKey: "session-1" },
    );
    expect(event).toMatchObject({
      taskId: "task-1",
      sequence: 4,
      event: "output",
      runId: "run-1",
      sessionKey: "session-1",
      data: { text: "hello" },
    });
  });

  it("does not attach full final text on done/agent_end", () => {
    const done = eventFromChunk(
      { type: "done", text: "full answer", runId: "run-1" },
      { taskId: "task-1", sequence: 5, sessionKey: "session-1" },
    );
    expect(done?.event).toBe("turn_done");
    expect(done?.data).toBeUndefined();

    const ended = eventFromChunk(
      { type: "agent_end", text: "full answer", runId: "run-1" },
      { taskId: "task-1", sequence: 6, sessionKey: "session-1" },
    );
    expect(ended?.event).toBe("completed");
    expect(ended?.data).toBeUndefined();
  });
});
