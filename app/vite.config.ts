import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @solana/web3.js expects a Node-style `Buffer`/`global` in the browser.
export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
});
