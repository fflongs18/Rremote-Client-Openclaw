import type { ChatChunk } from "openclaw-node";

export interface StreamNormalizerOptions {
  windowMs?: number;
  maxEntries?: number;
}

interface SeenChunk {
  key: string;
  timestamp: number;
}

export class ChatStreamNormalizer {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly recent: SeenChunk[] = [];

  constructor(options: StreamNormalizerOptions = {}) {
    this.windowMs = options.windowMs ?? 1_000;
    this.maxEntries = options.maxEntries ?? 64;
  }

  accept(chunk: ChatChunk, now = Date.now()): boolean {
    if (chunk.type !== "text") {
      if (["done", "agent_start", "agent_end", "error"].includes(chunk.type)) this.recent.length = 0;
      return true;
    }

    // A single character may be intentional (for example "哈哈" streamed one
    // character at a time), so only suppress replayed multi-character deltas.
    if (Array.from(chunk.text).length <= 1) return true;

    const cutoff = now - this.windowMs;
    while (this.recent.length && this.recent[0].timestamp < cutoff) this.recent.shift();
    const key = `${chunk.runId}\u0000${chunk.text}`;
    if (this.recent.some((item) => item.key === key)) return false;

    this.recent.push({ key, timestamp: now });
    if (this.recent.length > this.maxEntries) this.recent.shift();
    return true;
  }
}

export async function* normalizeChatStream(
  stream: AsyncIterable<ChatChunk>,
  options?: StreamNormalizerOptions,
): AsyncGenerator<ChatChunk> {
  const normalizer = new ChatStreamNormalizer(options);
  for await (const chunk of stream) {
    if (normalizer.accept(chunk)) yield chunk;
  }
}
