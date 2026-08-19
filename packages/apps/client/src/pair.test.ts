import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairDevice } from "./pair.js";

const originalConfig = process.env.REMOTE_CLIENT_CONFIG;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalConfig === undefined) delete process.env.REMOTE_CLIENT_CONFIG;
  else process.env.REMOTE_CLIENT_CONFIG = originalConfig;
});

describe("unattended device pairing", () => {
  it("exchanges a one-time code and persists both runtime configurations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-oc-pair-"));
    const path = join(directory, "device.json");
    process.env.REMOTE_CLIENT_CONFIG = path;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ code: "ONE-TIME", nodeName: "Test PC" });
      return new Response(JSON.stringify({
        nodeId: "remote-oc-test-pc",
        nodeToken: "node-specific-token",
        nodeName: "Test PC",
        hubHttpUrl: "https://hub.test",
        hubWsUrl: "wss://hub.test",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const config = await pairDevice({
        code: "ONE-TIME",
        name: "Test PC",
        hubUrl: "https://hub.test",
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "openclaw-secret",
        hermesUrl: "http://127.0.0.1:8642",
        hermesApiKey: "hermes-secret",
      });
      expect(config.nodeId).toBe("remote-oc-test-pc");
      expect(config.hermes.apiKey).toBe("hermes-secret");
      const persisted = readFileSync(path, "utf8");
      expect(persisted).toContain("node-specific-token");
      expect(persisted).not.toContain("ONE-TIME");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
