export const REMOTE_CLIENT_PREFIX = "remote-oc-";

export const taskEventNames = [
  "accepted",
  "started",
  "output",
  "tool_use",
  "tool_result",
  "turn_done",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskEventName = (typeof taskEventNames)[number];
export type TaskStatus =
  | "pending"
  | "started"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface RuntimeDescriptor {
  id: string;
  label: string;
  capabilities: string[];
  ready?: boolean;
  detail?: string;
  checkedAt?: number;
}

export interface RemoteTaskPayload {
  message: string;
  runtime?: string;
  agentId?: string;
  sessionKey?: string;
  clientMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteTaskEvent {
  version: 1;
  taskId: string;
  sequence: number;
  event: TaskEventName;
  runId?: string;
  runtime?: string;
  sessionKey?: string;
  data?: { text?: string; [key: string]: unknown };
  timestamp: number;
}

export type PushLevel = "info" | "success" | "warning" | "error";

export interface AgentPushMessage {
  version: 1;
  type: "agent-push";
  messageId: string;
  from: string;
  to: string;
  sessionKey?: string;
  title?: string;
  text: string;
  level?: PushLevel;
  timestamp: number;
  artifact?: {
    name: string;
    url: string;
    mime?: string;
    size?: number;
    expiresAt?: number;
  };
}

export interface CancelCommand {
  version: 1;
  command: "cancel";
  taskId: string;
}

export interface JianmuMessage {
  id?: string;
  type: string;
  from?: string;
  to?: string;
  content?: string;
  contentType?: string;
  topic?: string | null;
  ts?: number;
  [key: string]: unknown;
}

export function isRemoteTaskEvent(value: unknown): value is RemoteTaskEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RemoteTaskEvent>;
  return (
    event.version === 1 &&
    typeof event.taskId === "string" &&
    Number.isInteger(event.sequence) &&
    typeof event.event === "string" &&
    taskEventNames.includes(event.event as TaskEventName) &&
    typeof event.timestamp === "number"
  );
}

export function isAgentPushMessage(value: unknown): value is AgentPushMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<AgentPushMessage>;
  return (
    message.version === 1 && message.type === "agent-push" &&
    typeof message.messageId === "string" && typeof message.from === "string" &&
    typeof message.to === "string" && typeof message.text === "string" &&
    typeof message.timestamp === "number"
  );
}

export function isCancelCommand(value: unknown): value is CancelCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<CancelCommand>;
  return command.version === 1 && command.command === "cancel" && typeof command.taskId === "string";
}

export function statusForEvent(event: TaskEventName): TaskStatus | null {
  switch (event) {
    case "accepted":
      return "started";
    case "started":
    case "output":
    case "tool_use":
    case "tool_result":
    case "turn_done":
      return "in_progress";
    case "completed":
    case "failed":
    case "cancelled":
      return event;
  }
}

export function parseJson<T>(value: string | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
