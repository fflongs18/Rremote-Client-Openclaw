import type { RuntimeDescriptor } from "@remote-oc/protocol";
import type { AgentRuntime } from "./types.js";

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): this {
    const id = runtime.id.trim().toLowerCase();
    if (!id) throw new Error("Runtime id is required");
    if (this.runtimes.has(id)) throw new Error(`Runtime ${id} is already registered`);
    this.runtimes.set(id, runtime);
    return this;
  }

  get(id: string): AgentRuntime | undefined {
    return this.runtimes.get(id.trim().toLowerCase());
  }

  require(id: string): AgentRuntime {
    const runtime = this.get(id);
    if (!runtime) throw new Error(`Unsupported runtime ${id}; available: ${this.ids().join(", ")}`);
    return runtime;
  }

  ids(): string[] {
    return [...this.runtimes.keys()];
  }

  all(): AgentRuntime[] {
    return [...this.runtimes.values()];
  }

  describe(): RuntimeDescriptor[] {
    return this.all().map((runtime) => ({
      id: runtime.id,
      label: runtime.label,
      capabilities: [...runtime.capabilities],
    }));
  }

  async describeHealth(): Promise<RuntimeDescriptor[]> {
    return Promise.all(this.all().map(async (runtime) => {
      try {
        const health = await runtime.health();
        return {
          id: runtime.id,
          label: runtime.label,
          capabilities: [...runtime.capabilities],
          ready: health.ok && health.connected,
          ...(health.detail ? { detail: health.detail } : {}),
          checkedAt: Date.now(),
        };
      } catch (error) {
        return {
          id: runtime.id,
          label: runtime.label,
          capabilities: [...runtime.capabilities],
          ready: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now(),
        };
      }
    }));
  }
}
