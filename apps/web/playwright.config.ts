// End-to-end tests against the real apps/server (engine-only bot, in-memory DB) and vite.
// E2E_API_COMMAND overrides the server command (e.g. a fake API server for local checks).
import { defineConfig, devices } from "@playwright/test";

const API_PORT = 3101;
const WEB_PORT = 5174;
const ci = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: process.env["E2E_API_COMMAND"] ?? "pnpm --filter @chess-tutor/server start",
      port: API_PORT,
      // No Claude key: e2e never calls the API, and the tutor panel shows why coaching is off (NFR-9).
      env: { PORT: String(API_PORT), DB_PATH: ":memory:", LICHESS_TOKEN: "", ANTHROPIC_API_KEY: "" },
      reuseExistingServer: !ci,
      timeout: 60_000,
      stdout: "pipe",
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { SERVER_PORT: String(API_PORT) },
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
  ],
});
