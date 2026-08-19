import { describe, expect, it } from "vitest";
import { agentPushFromHubMessage, ingestHubPushes, rememberPush } from "./pushes.js";
import type { AgentPushMessage, JianmuMessage } from "@remote-oc/protocol";

function push(overrides: Partial<AgentPushMessage> = {}): AgentPushMessage {
  return {
    version: 1,
    type: "agent-push",
    messageId: "push_1",
    from: "remote-oc-macbook",
    to: "web-control",
    text: "hello",
    timestamp: 100,
    ...overrides,
  };
}

describe("agent-push history", () => {
  it("parses Hub inbox rows whose content is an agent-push payload", () => {
    const message: JianmuMessage = {
      type: "message",
      topic: "agent-push",
      content: JSON.stringify(push({ title: "量子位资讯" })),
    };
    expect(agentPushFromHubMessage(message)?.title).toBe("量子位资讯");
  });

  it("ignores task events in the same inbox", () => {
    const message: JianmuMessage = {
      type: "message",
      topic: "remote-control",
      content: JSON.stringify({ version: 1, taskId: "t1", sequence: 1, event: "accepted", timestamp: 1 }),
    };
    expect(agentPushFromHubMessage(message)).toBeNull();
  });

  it("keeps newest pushes and deduplicates by messageId", () => {
    const recent: AgentPushMessage[] = [];
    rememberPush(recent, push({ messageId: "a", timestamp: 1 }), 2);
    rememberPush(recent, push({ messageId: "a", timestamp: 1 }), 2);
    rememberPush(recent, push({ messageId: "b", timestamp: 2 }), 2);
    rememberPush(recent, push({ messageId: "c", timestamp: 3 }), 2);
    expect(recent.map((item) => item.messageId)).toEqual(["b", "c"]);
  });

  it("loads a mixed Hub inbox into recent pushes", () => {
    const recent: AgentPushMessage[] = [];
    ingestHubPushes(recent, [
      { type: "message", content: JSON.stringify(push({ messageId: "older", timestamp: 1 })) },
      { type: "message", content: JSON.stringify({ version: 1, taskId: "t1", sequence: 1, event: "output", timestamp: 2 }) },
      { type: "message", content: JSON.stringify(push({ messageId: "newer", timestamp: 3, text: "later" })) },
    ]);
    expect(recent.map((item) => item.messageId)).toEqual(["older", "newer"]);
  });
});
