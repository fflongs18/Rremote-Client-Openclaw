import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeviceConfig } from "./device-config.js";

const originalConfig = process.env.REMOTE_CLIENT_CONFIG;

afterEach(() => {
  if (originalConfig === undefined) delete process.env.REMOTE_CLIENT_CONFIG;
  else process.env.REMOTE_CLIENT_CONFIG = originalConfig;
});

describe("device config migration", () => {
  it("adds default Hermes settings to legacy OpenClaw-only identities", () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-oc-device-"));
    const path = join(directory, "device.json");
    process.env.REMOTE_CLIENT_CONFIG = path;
    writeFileSync(path, JSON.stringify({
      version: 1,
      nodeId: "remote-oc-test",
      nodeToken: "node-token",
      nodeName: "Test",
      hubWsUrl: "wss://hub.test",
      hubHttpUrl: "https://hub.test",
      openClaw: { url: "ws://127.0.0.1:18789", token: null },
    }));
    try {
      expect(loadDeviceConfig()?.hermes).toEqual({
        url: "http://127.0.0.1:8642",
        apiKey: null,
        model: null,
        provider: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
