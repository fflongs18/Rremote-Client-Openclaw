import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const bffHost = env.BFF_HOST || "127.0.0.1";
  const bffPort = env.BFF_PORT || "8787";

  return {
    plugins: [react()],
    envDir: repoRoot,
    server: {
      proxy: {
        "/api": `http://${bffHost}:${bffPort}`,
      },
    },
  };
});
