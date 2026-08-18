import { pathToFileURL } from "node:url";
import { HermesAdapter } from "./adapters/hermes.js";

export async function runHermesSmoke(message: string): Promise<void> {
  const adapter = new HermesAdapter({
    baseUrl: process.env.HERMES_API_URL || "http://127.0.0.1:8642",
    apiKey: process.env.HERMES_API_KEY || undefined,
    model: process.env.HERMES_MODEL || undefined,
    provider: process.env.HERMES_PROVIDER || undefined,
    requestTimeoutMs: Number(process.env.HERMES_REQUEST_TIMEOUT_MS) || 60_000,
  });
  try {
    const health = await adapter.health();
    if (!health.ok || !health.connected) throw new Error(health.detail || "Hermes is not ready");
    console.log(JSON.stringify({ event: "discovered", runtime: adapter.id, ready: true }));

    let terminal = false;
    for await (const event of adapter.run({
      message,
      sessionKey: `remote-oc-smoke-${Date.now()}`,
      clientMessageId: `smoke-${Date.now()}`,
    })) {
      console.log(JSON.stringify(event));
      if (["completed", "failed", "cancelled"].includes(event.event)) {
        terminal = true;
        if (event.event !== "completed") throw new Error(event.data?.text || `Hermes run ${event.event}`);
      }
    }
    if (!terminal) throw new Error("Hermes stream ended without a terminal event");
  } finally {
    await adapter.disconnect();
  }
}

async function main(): Promise<void> {
  const message = process.argv.slice(2).join(" ").trim() || "Reply with exactly: HERMES_OK";
  await runHermesSmoke(message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
