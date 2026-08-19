import {
  type AgentPushMessage,
  type JianmuMessage,
  isAgentPushMessage,
  parseJson,
} from "@remote-oc/protocol";

export const MAX_RECENT_PUSHES = 100;

export function agentPushFromHubMessage(message: JianmuMessage | null | undefined): AgentPushMessage | null {
  if (!message || typeof message.content !== "string") return null;
  const push = parseJson<AgentPushMessage>(message.content);
  return isAgentPushMessage(push) ? push : null;
}

export function rememberPush(
  recent: AgentPushMessage[],
  push: AgentPushMessage,
  limit = MAX_RECENT_PUSHES,
): boolean {
  if (recent.some((item) => item.messageId === push.messageId)) return false;
  recent.push(push);
  recent.sort((a, b) => a.timestamp - b.timestamp);
  while (recent.length > limit) recent.shift();
  return true;
}

export function ingestHubPushes(
  recent: AgentPushMessage[],
  messages: JianmuMessage[],
  limit = MAX_RECENT_PUSHES,
): AgentPushMessage[] {
  for (const message of messages) {
    const push = agentPushFromHubMessage(message);
    if (push) rememberPush(recent, push, limit);
  }
  return recent;
}
