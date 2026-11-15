import { defineConfig } from "vitest/config";

// Test files that run a real Stockfish search. They time the engine (NFR-2/NFR-3 latency
// guards), so they must not compete with each other or with the rest of the suite for CPU
// (#37: the bot-latency test failed by a few ms on a 2-CPU CI runner). They run in their
// own project, one file at a time, after every other file has finished.
const realEngine = [
  "packages/engine/test/wasm.integration.test.ts",
  "apps/server/test/wasm-bot.integration.test.ts",
  "apps/server/test/deploy.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "evals/test/**/*.test.ts", ".claude/hooks/test/**/*.test.ts"],
          exclude: ["**/node_modules/**", ...realEngine],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "real-engine",
          include: realEngine,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
