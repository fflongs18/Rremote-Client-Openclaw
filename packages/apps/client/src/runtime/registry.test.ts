import { describe, expect, it } from "vitest";
import { RuntimeRegistry } from "./registry.js";
import type { AgentRuntime } from "./types.js";

function fakeRuntime(id: string): AgentRuntime {
  return {
    id,
    label: id,
    capabilities: ["chat"],
    async connect() {},
    async disconnect() {},
    async *run() {},
    async cancel() {},
    async health() { return { ok: true, connected: true }; },
  };
}

describe("RuntimeRegistry", () => {
  it("registers and resolves runtimes case-insensitively", () => {
    const registry = new RuntimeRegistry().register(fakeRuntime("OpenClaw"));
    expect(registry.require("openclaw").id).toBe("OpenClaw");
  });

  it("reports unsupported runtimes with available ids", () => {
    const registry = new RuntimeRegistry().register(fakeRuntime("openclaw"));
    expect(() => registry.require("hermes")).toThrow("available: openclaw");
  });

  it("reports runtime readiness without adapter-specific types", async () => {
    const registry = new RuntimeRegistry().register(fakeRuntime("openclaw"));
    const descriptions = await registry.describeHealth();
    expect(descriptions).toEqual([expect.objectContaining({
      id: "openclaw",
      label: "openclaw",
      capabilities: ["chat"],
      ready: true,
    })]);
    expect(descriptions[0].checkedAt).toEqual(expect.any(Number));
  });
});
