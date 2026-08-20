import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface EnrollmentSession {
  id: string;
  token: string;
  nodeName: string;
  pairingCode: string;
  expiresAt: number;
  usedAt?: number;
  nodeId?: string;
}

const sessions = new Map<string, EnrollmentSession>();
const TTL_MS = 10 * 60 * 1000;

function statePath(): string | null {
  const configured = process.env.REMOTE_OC_ENROLLMENT_STATE_PATH?.trim();
  return configured || null;
}

function save(): void {
  const output = statePath();
  if (!output) return;
  const directory = path.dirname(output);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...sessions.values()]), "utf8");
  fs.renameSync(temporary, output);
}

function restore(): void {
  const input = statePath();
  if (!input || !fs.existsSync(input)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(input, "utf8")) as EnrollmentSession[];
    for (const session of saved) {
      if (typeof session?.token === "string" && typeof session.expiresAt === "number" && session.expiresAt > Date.now()) sessions.set(session.token, session);
    }
  } catch {
    // A corrupted short-lived enrollment cache must not prevent the controller from starting.
  }
}

function purge(): void {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) { sessions.delete(token); changed = true; }
  }
  if (changed) save();
}

restore();

export function createEnrollment(nodeName: string, pairingCode: string, expiresAt?: number): EnrollmentSession {
  purge();
  const token = crypto.randomBytes(32).toString("base64url");
  const session: EnrollmentSession = {
    id: crypto.randomUUID(),
    token,
    nodeName,
    pairingCode,
    expiresAt: expiresAt ?? Date.now() + TTL_MS,
  };
  sessions.set(token, session);
  save();
  return session;
}

export function getEnrollment(token: string): EnrollmentSession | null {
  purge();
  const session = sessions.get(token);
  return session && session.expiresAt > Date.now() ? session : null;
}

export function consumeEnrollment(token: string): EnrollmentSession | null {
  const session = getEnrollment(token);
  if (!session) return null;
  session.usedAt ??= Date.now();
  save();
  return session;
}

export function enrollmentBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  const configured = process.env.REMOTE_OC_CONTROL_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host") || "127.0.0.1:8788"}`;
}
