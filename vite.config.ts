import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(({ mode }) => {
  // Empty prefix so RPC_URL is read too. This runs in the dev server, never in the
  // bundle — the value stays server-side exactly like the Cloudflare secret does.
  const env = loadEnv(mode, process.cwd(), "");
  const upstream = env.RPC_URL;

  return {
    // Anchor and the MetaDAO SDK expect Buffer/process as globals.
    plugins: [react(), nodePolyfills({ globals: { Buffer: true, process: true } })],
    server: {
      // Let the harness assign a port (PORT) so two dev servers can coexist.
      port: Number(process.env.PORT) || 5173,
      proxy: upstream
        ? {
            // Mirrors functions/api/rpc.ts so the client code is identical in dev
            // and in production.
            "/api/rpc": {
              target: upstream,
              changeOrigin: true,
              secure: true,
              rewrite: () => new URL(upstream).pathname + new URL(upstream).search,
            },
          }
        : undefined,
    },
  };
});
