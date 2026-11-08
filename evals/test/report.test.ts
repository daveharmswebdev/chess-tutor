import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareRuns, computeMetrics, percentile } from "../src/report.ts";
import type { CaseRow } from "../src/types.ts";

const dir = (name: string) => fileURLToPath(new URL(`./fixtures/runs/${name}`, import.meta.url));

describe("compareRuns", () => {
  // Two run directories made from the real bake-off replies (Opus 5.5 / Sonnet 5.5, medium).
  const { json, markdown } = compareRuns([dir("opus-medium"), dir("sonnet-medium")]);

  it("puts the runs side by side with the NFR-6, NFR-7, latency and cost metrics", () => {
    expect(json.runs.map((r) => `${r.model} ${r.effort}`)).toEqual(["claude-opus-5-5 medium", "claude-sonnet-5-5 medium"]);
    expect(markdown).toMatch(/\| Metric \| claude-opus-5-5 medium \| claude-sonnet-5-5 medium \|/);
    expect(markdown).toMatch(/\| NFR-6 move legality \(replies\) \| 100% \| 100% \|/);
    expect(markdown).toMatch(/\| NFR-7 no give-away \(target >= 90%\) \| 50% \| 100% \|/);
    expect(markdown).toMatch(/\| Arrows well formed \| 100% \| 75% \|/);
    expect(markdown).toMatch(/Latency p50 \/ p95 \| 10\.3 s \/ 11\.2 s \| 7\.1 s \/ 9\.1 s/);
    expect(markdown).toMatch(/Cost per game \(10 asks\) \| \$0\.302 \| \$0\.175/);
  });

  it("has a row per case with each run's result", () => {
    const hint = json.cases.find((c) => c.caseId === "london-hint-bd3")!;
    expect(hint.results).toEqual(["ok, give-away", "ok, arrows"]);
    const blunder = json.cases.find((c) => c.caseId === "london-qh5")!;
    expect(blunder.results).toEqual(["ok", "ok"]);
    expect(markdown).toMatch(/\| london-qd6 \| punish_opponent \| ok, give-away \| ok \|/);
    expect(markdown).toMatch(/needs an LLM judge/);
  });
});

describe("computeMetrics", () => {
  const row = (over: Partial<CaseRow>): CaseRow => ({
    id: "x", caseId: "x", kind: "hint", ok: true, reason: null, nfr6Moves: true, nfr6Evals: true, nfr7: true, arrowsOk: true,
    revealOk: true, schemaOk: true, pointsAtAnswer: false, toolCalls: 1, retries: 0, retryReasons: [], ms: 1000, firstRoundMs: 500, costUsd: 0.02, problems: [], ...over,
  });

  it("grades only replies, counts failure reasons, and prices a game as 10 asks", () => {
    const m = computeMetrics([
      row({}),
      row({ nfr7: false }),
      row({ ok: false, reason: "unsupported_claim", nfr6Moves: null, nfr6Evals: null, nfr7: null, costUsd: 0.04 }),
    ]);
    expect(m.okRate).toBeCloseTo(2 / 3);
    expect(m.graded).toBe(2);
    expect(m.noGiveAwayPct).toBe(0.5);
    expect(m.failureReasons).toEqual({ unsupported_claim: 1 });
    expect(m.costPerCaseUsd).toBeCloseTo(0.08 / 3);
    expect(m.costPerGameUsd).toBeCloseTo(0.8 / 3);
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });
});
