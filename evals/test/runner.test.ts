import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TutorConfig } from "@chess-tutor/tutor";
import { describe, expect, it } from "vitest";
import { runEval, type RunOptions } from "../src/runner.ts";
import type { CaseResult, RunSummary } from "../src/types.ts";
import { fakeClient, fakeEngine, fakeExplorer, hintCase } from "./fakes.ts";

const CONFIG: TutorConfig = {
  model: "claude-opus-5-5",
  effort: "medium",
  maxToolRounds: 4,
  engine: { depth: 10, movetimeCapMs: 100, multiPv: 1 },
  explorer: { ratings: [1200], speeds: ["blitz"] },
};

const CASES = [
  hintCase("hint-1", ["d2d4"]),
  hintCase("hint-2", ["d2d4", "d7d5"]),
  hintCase("hint-3", ["d2d4", "d7d5", "c1f4"]),
  hintCase("hint-4", ["d2d4", "g8f6"]),
  hintCase("hint-5", ["d2d4", "g8f6", "c1f4"]),
  hintCase("hint-6", ["e2e4"]),
];

function options(over: Partial<RunOptions> & Pick<RunOptions, "client">): RunOptions {
  return {
    cases: CASES.slice(0, 2),
    config: CONFIG,
    engine: fakeEngine(),
    explorer: fakeExplorer,
    repertoire: null,
    systemPrompt: "SYSTEM",
    promptFile: "tutor-system.v1.md",
    price: { input: 4, output: 20, cacheRead: 0.2 },
    toleranceCp: 50,
    maxUsd: 10,
    concurrency: 2,
    repeat: 1,
    outDir: mkdtempSync(join(tmpdir(), "evals-run-")),
    log: () => {},
    ...over,
  };
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

describe("runEval", () => {
  it("asks the tutor for every case and writes per-case JSON, summary.json and report.md", async () => {
    const { client } = fakeClient();
    const opts = options({ client });
    const summary = await runEval(opts);
    expect(summary.metrics.cases).toBe(2);
    expect(summary.metrics.okRate).toBe(1);
    expect(existsSync(join(opts.outDir, "summary.json"))).toBe(true);
    expect(readFileSync(join(opts.outDir, "report.md"), "utf8")).toMatch(/NFR-7/);
    const files = readdirSync(join(opts.outDir, "cases")).sort();
    expect(files).toEqual(["hint-1.json", "hint-2.json"]);
    const one = readJson<CaseResult>(join(opts.outDir, "cases", "hint-1.json"));
    expect(one.ok).toBe(true);
    expect(one.rounds).toHaveLength(2);
    expect(one.rounds[0]!.toolUses[0]!.name).toBe("analyze_position");
    expect(one.rounds[0]!.toolResults[0]!.content).toMatch(/eval_cp/);
    expect(one.toolCalls).toBe(1);
    // 2 requests x (1000 input x $4 + 500 output x $20) per MTok
    expect(one.costUsd).toBeCloseTo(0.028, 6);
    expect(one.grades?.nfr6Moves).toBe(true);
    expect(one.firstRoundMs).not.toBeNull();
  });

  it("stops starting new cases once the summed cost reaches --max-usd", async () => {
    const { client, stats } = fakeClient();
    const opts = options({ client, cases: CASES.slice(0, 5), concurrency: 1, maxUsd: 0.05 });
    const summary = await runEval(opts);
    expect(summary.stoppedByBudget).toBe(true);
    expect(summary.metrics.cases).toBe(2);
    expect(summary.skipped).toEqual(["hint-3", "hint-4", "hint-5"]);
    expect(stats.requests).toBe(4);
    expect(summary.spentUsd).toBeCloseTo(0.056, 6);
    expect(readdirSync(join(opts.outDir, "cases"))).toHaveLength(2);
  });

  it("runs at most --concurrency cases at a time", async () => {
    const { client, stats } = fakeClient({ delayMs: 15 });
    await runEval(options({ client, cases: CASES, concurrency: 2 }));
    expect(stats.maxActive).toBe(2);
    const one = fakeClient({ delayMs: 5 });
    await runEval(options({ client: one.client, cases: CASES.slice(0, 3), concurrency: 1 }));
    expect(one.stats.maxActive).toBe(1);
  });

  it("records a failing ask instead of throwing, and goes on with the other cases", async () => {
    const { client } = fakeClient({ failFen: CASES[0]!.fen });
    const opts = options({ client });
    const summary: RunSummary = await runEval(opts);
    const failed = readJson<CaseResult>(join(opts.outDir, "cases", "hint-1.json"));
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe("api_unavailable");
    expect(failed.grades).toBeNull();
    expect(summary.metrics.failureReasons).toEqual({ api_unavailable: 1 });
    expect(summary.metrics.okRate).toBe(0.5);
  });

  it("repeats each case --repeat times", async () => {
    const { client } = fakeClient();
    const opts = options({ client, cases: CASES.slice(0, 1), repeat: 2 });
    const summary = await runEval(opts);
    expect(summary.rows.map((r) => r.id)).toEqual(["hint-1#1", "hint-1#2"]);
  });
});
