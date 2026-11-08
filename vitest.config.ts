import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "evals/test/**/*.test.ts", ".claude/hooks/test/**/*.test.ts"],
  },
});
