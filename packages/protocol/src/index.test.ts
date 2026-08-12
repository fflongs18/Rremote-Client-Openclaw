import { describe, expect, it } from "vitest";
import { isCancelCommand, isRemoteTaskEvent, statusForEvent } from "./index.js";

describe("remote protocol", () => {
  it("validates task events", () => {
    expect(isRemoteTaskEvent({ version: 1, taskId: "task-1", sequence: 1, event: "output", timestamp: 1 })).toBe(true);
    expect(isRemoteTaskEvent({ version: 1, taskId: "task-1", sequence: 1, event: "unknown", timestamp: 1 })).toBe(false);
  });

  it("maps progress and terminal statuses", () => {
    expect(statusForEvent("accepted")).toBe("started");
    expect(statusForEvent("turn_done")).toBe("in_progress");
    expect(statusForEvent("completed")).toBe("completed");
  });

  it("validates cancel commands", () => {
    expect(isCancelCommand({ version: 1, command: "cancel", taskId: "task-1" })).toBe(true);
  });
});
