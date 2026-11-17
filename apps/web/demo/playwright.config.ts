// Guided demo video (#59: FR-27, FR-28). Not part of pnpm test, test:e2e or CI: it costs one or
// two tutor calls. It starts no servers; it runs against DEMO_BASE_URL (default: a local stack).
//
// Local stack, in two terminals from the repo root (ANTHROPIC_API_KEY in .env or the shell):
//   pnpm dev                      # apps/server on 3001 and vite on 5173
//   pnpm demo                     # or: DEMO_BASE_URL=https://... DEMO_TOKEN=... pnpm demo
// The video is copied to apps/web/demo-output/demo.webm (gitignored, apps/web/.gitignore).
import { defineConfig, devices } from "@playwright/test";

export const DEFAULT_DEMO_BASE_URL = "http://localhost:5173";

export default defineConfig({
  testDir: ".",
  testMatch: "*.demo.ts",
  outputDir: "../test-results/demo",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env["DEMO_BASE_URL"] || DEFAULT_DEMO_BASE_URL,
    viewport: { width: 1280, height: 720 },
    video: { mode: "on", size: { width: 1280, height: 720 } },
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } }],
});
