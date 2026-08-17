import type { TaskEventName } from "@remote-oc/protocol";

export type RuntimeCapability = "chat" | "stream" | "cancel" | "push" | "tools" | "artifacts";

export interface RuntimeRunInput {
  message: string;
  sessionKey: string;
  agentId?: string;
  clientMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeEvent {
  event: TaskEventName;
  runId?: string;
  sessionKey?: string;
  data?: { text?: string; [key: string]: unknown };
  timestamp: number;
}

export interface RuntimeCancelInput {
  sessionKey: string;
  runId?: string;
}

export interface RuntimeHealth {
  ok: boolean;
  connected: boolean;
  detail?: string;
}

export interface AgentRuntime {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly RuntimeCapability[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  run(input: RuntimeRunInput): AsyncIterable<RuntimeEvent>;
  cancel(input: RuntimeCancelInput): Promise<void>;
  health(): Promise<RuntimeHealth>;
}
