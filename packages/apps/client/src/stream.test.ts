import type { ChatChunk } from "openclaw-node";
import { describe, expect, it } from "vitest";
import { ChatStreamNormalizer } from "./stream.js";

const text = (value: string, runId = "run-1"): ChatChunk => ({ type: "text", text: value, runId });

describe("ChatStreamNormalizer", () => {
  it("drops repeated multi-character deltas inside the replay window", () => {
    const normalizer = new ChatStreamNormalizer({ windowMs: 1_000 });
    expect(normalizer.accept(text("same block"), 100)).toBe(true);
    expect(normalizer.accept(text("same block"), 200)).toBe(false);
  });

  it("drops interleaved replays from the same run", () => {
    const normalizer = new ChatStreamNormalizer({ windowMs: 1_000 });
    expect(normalizer.accept(text("first block"), 100)).toBe(true);
    expect(normalizer.accept(text("next block"), 150)).toBe(true);
    expect(normalizer.accept(text("first block"), 200)).toBe(false);
  });

  it("preserves single-character repetition and different runs", () => {
    const normalizer = new ChatStreamNormalizer({ windowMs: 1_000 });
    expect(normalizer.accept(text("哈"), 100)).toBe(true);
    expect(normalizer.accept(text("哈"), 110)).toBe(true);
    expect(normalizer.accept(text("same block"), 120)).toBe(true);
    expect(normalizer.accept(text("same block", "run-2"), 130)).toBe(true);
  });

  it("allows text again after the window or a lifecycle boundary", () => {
    const normalizer = new ChatStreamNormalizer({ windowMs: 1_000 });
    expect(normalizer.accept(text("repeat later"), 100)).toBe(true);
    expect(normalizer.accept(text("repeat later"), 1_101)).toBe(true);
    expect(normalizer.accept({ type: "done", text: "", runId: "run-1" }, 1_200)).toBe(true);
    expect(normalizer.accept(text("repeat later"), 1_201)).toBe(true);
  });
});
