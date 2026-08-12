import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Anchor + the MetaDAO SDK expect Buffer/process to exist as globals.
export default defineConfig({
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, process: true } })],
  define: { "process.env.ANCHOR_BROWSER": "true" },
  server: { port: 5173 },
});
