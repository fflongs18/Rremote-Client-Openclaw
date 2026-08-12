import type { ChatChunk } from "openclaw-node";
import type { RemoteTaskEvent, TaskEventName } from "@remote-oc/protocol";

export interface EventContext {
  taskId: string;
  sequence: number;
  sessionKey?: string;
}

export function eventNameForChunk(chunk: ChatChunk): TaskEventName | null {
  switch (chunk.type) {
    case "userMessagePersisted":
      return "accepted";
    case "agent_start":
      return "started";
    case "text":
      return "output";
    case "tool_use":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    case "done":
      return "turn_done";
    case "agent_end":
      return "completed";
    case "error":
      return "failed";
  }
}

export function eventFromChunk(chunk: ChatChunk, context: EventContext): RemoteTaskEvent | null {
  const event = eventNameForChunk(chunk);
  if (!event) return null;
  const text = "text" in chunk ? chunk.text : undefined;
  return {
    version: 1,
    taskId: context.taskId,
    sequence: context.sequence,
    event,
    runId: chunk.runId,
    sessionKey: chunk.type === "userMessagePersisted" ? chunk.sessionKey : context.sessionKey,
    ...(text ? { data: { text } } : {}),
    timestamp: Date.now(),
  };
}
