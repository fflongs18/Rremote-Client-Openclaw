import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumeEnrollment, createEnrollment, getEnrollment } from "./enrollment.js";

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
