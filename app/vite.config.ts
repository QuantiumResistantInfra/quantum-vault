import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// @solana/web3.js + spl-token need Node's Buffer/global/process in the browser.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ include: ["buffer"], globals: { Buffer: true, global: true, process: true } }),
  ],
});
