import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server on 5173; /api goes to apps/server (PORT, default 3001), SSE included.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${process.env["SERVER_PORT"] ?? "3001"}`, changeOrigin: false } },
  },
});
