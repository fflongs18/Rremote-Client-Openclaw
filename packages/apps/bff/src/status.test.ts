import { describe, expect, it } from "vitest";
import { shouldUpdateStatus } from "./status.js";

describe("task status transitions", () => {
  it("does not regress a terminal task", () => {
    expect(shouldUpdateStatus("completed", "in_progress")).toBe(false);
    expect(shouldUpdateStatus("failed", "started")).toBe(false);
  });

  it("allows normal transitions", () => {
    expect(shouldUpdateStatus("started", "in_progress")).toBe(true);
    expect(shouldUpdateStatus("in_progress", "completed")).toBe(true);
  });
});
