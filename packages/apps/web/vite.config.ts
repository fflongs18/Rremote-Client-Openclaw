import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const bffHost = env.BFF_HOST || "127.0.0.1";
  const bffPort = env.BFF_PORT || "8788";
  const webBase = (env.WEB_BASE || "/").endsWith("/") ? (env.WEB_BASE || "/") : `${env.WEB_BASE}/`;
  const apiProxy = webBase === "/"
    ? { "/api": `http://${bffHost}:${bffPort}` }
    : {
        [`${webBase}api`]: {
          target: `http://${bffHost}:${bffPort}`,
          rewrite: (path: string) => path.replace(new RegExp(`^${webBase.replace(/\/$/, "")}`), "") || "/",
        },
      };

  return {
    plugins: [react()],
    envDir: repoRoot,
    base: webBase,
    server: {
      proxy: apiProxy,
    },
  };
});
