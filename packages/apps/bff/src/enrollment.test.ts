import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumeEnrollment, createEnrollment, getEnrollment, isControlUiHost } from "./enrollment.js";

const statePath = path.join(os.tmpdir(), "remote-oc-enrollment-test.json");
afterEach(() => fs.rmSync(statePath, { force: true }));

describe("enrollment sessions", () => {
  it("creates a short-lived token and allows an idempotent retry", () => {
    const session = createEnrollment("Office Mac", "PAIRING-CODE", Date.now() + 60_000);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(getEnrollment(session.token)?.nodeName).toBe("Office Mac");
    expect(consumeEnrollment(session.token)?.pairingCode).toBe("PAIRING-CODE");
    expect(consumeEnrollment(session.token)?.pairingCode).toBe("PAIRING-CODE");
    expect(getEnrollment(session.token)?.usedAt).toBeTypeOf("number");
  });

  it("persists newly created sessions when a state path is configured", () => {
    process.env.REMOTE_OC_ENROLLMENT_STATE_PATH = statePath;
    const session = createEnrollment("Persisted", "CODE", Date.now() + 60_000);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toContainEqual(expect.objectContaining({ token: session.token }));
    delete process.env.REMOTE_OC_ENROLLMENT_STATE_PATH;
  });

  it("rejects expired tokens", () => {
    const session = createEnrollment("Expired", "CODE", Date.now() - 1);
    expect(getEnrollment(session.token)).toBeNull();
    expect(consumeEnrollment(session.token)).toBeNull();
  });
});

describe("control UI hosts", () => {
  const previous = {
    control: process.env.REMOTE_OC_CONTROL_URL,
    publicHttp: process.env.JIANMU_PUBLIC_HTTP_URL,
    extra: process.env.REMOTE_OC_UI_HOSTS,
  };
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      const name = key === "control" ? "REMOTE_OC_CONTROL_URL" : key === "publicHttp" ? "JIANMU_PUBLIC_HTTP_URL" : "REMOTE_OC_UI_HOSTS";
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("allows localhost even without a public controller URL", () => {
    delete process.env.REMOTE_OC_CONTROL_URL;
    delete process.env.JIANMU_PUBLIC_HTTP_URL;
    delete process.env.REMOTE_OC_UI_HOSTS;
    expect(isControlUiHost("127.0.0.1")).toBe(true);
    expect(isControlUiHost("juyuanagi.com")).toBe(false);
  });

  it("allows the configured public controller hostname", () => {
    process.env.REMOTE_OC_CONTROL_URL = "https://juyuanagi.com:6058/";
    delete process.env.JIANMU_PUBLIC_HTTP_URL;
    delete process.env.REMOTE_OC_UI_HOSTS;
    expect(isControlUiHost("juyuanagi.com")).toBe(true);
    expect(isControlUiHost("other.example")).toBe(false);
  });
});
