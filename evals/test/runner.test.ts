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

  it("records the reason of every correction retry the session sends (NFR-8)", async () => {
    const { client } = fakeClient({ giveAwayFirst: true });
    const opts = options({ client, cases: CASES.slice(0, 1) });
    const summary = await runEval(opts);
    const one = readJson<CaseResult>(join(opts.outDir, "cases", "hint-1.json"));
    expect(one.ok).toBe(true);
    expect(one.retries).toBe(1);
    expect(one.retryReasons).toEqual(["give_away"]);
    const corrected = one.rounds.find((r) => r.correction !== null)!;
    expect(corrected.correction).toMatch(/gives the answer away/);
    expect(summary.metrics.retryReasons).toEqual({ give_away: 1 });
    expect(readFileSync(join(opts.outDir, "report.md"), "utf8")).toMatch(/give_away 1/);
  });

  /** A session whose ask makes one billed API round (through the recording client), then fails. */
  const billedThenFails =
    (end: "throw" | "zero_usage"): NonNullable<RunOptions["createSession"]> =>
    (deps) => ({
      async ask(request) {
        await deps.client.messages
          .stream({ model: deps.config.model, max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: `<hint_request>\n${JSON.stringify(request)}` }] }] })
          .finalMessage();
        if (end === "throw") throw new Error("boom after a billed round");
        const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        return { ok: false, reason: "api_unavailable", message: "lost the usage", usage, ms: 1 };
      },
    });

  it("counts the recorded rounds of a throwing ask toward --max-usd, at concurrency 2 (NFR-4)", async () => {
    const { client, stats } = fakeClient({ delayMs: 15 });
    // Each case: one round of 1000 input + 500 output tokens = $0.014.
    const opts = options({ client, cases: CASES.slice(0, 4), concurrency: 2, maxUsd: 0.01, createSession: billedThenFails("throw") });
    const summary = await runEval(opts);
    expect(stats.maxActive).toBe(2);
    expect(summary.rows.map((r) => r.id)).toEqual(["hint-1", "hint-2"]);
    expect(summary.skipped).toEqual(["hint-3", "hint-4"]);
    expect(summary.stoppedByBudget).toBe(true);
    expect(summary.spentUsd).toBeCloseTo(0.028, 6);
    const one = readJson<CaseResult>(join(opts.outDir, "cases", "hint-1.json"));
    expect(one.reason).toBe("threw");
    expect(one.usage).toMatchObject({ requests: 1, inputTokens: 1000, outputTokens: 500 });
    expect(one.costUsd).toBeCloseTo(0.014, 6);
  });

  it("counts the recorded rounds when a failed outcome reports less usage than was billed", async () => {
    const { client } = fakeClient({ delayMs: 5 });
    const opts = options({ client, cases: CASES.slice(0, 3), concurrency: 2, maxUsd: 0.01, createSession: billedThenFails("zero_usage") });
    const summary = await runEval(opts);
    expect(summary.skipped).toEqual(["hint-3"]);
    expect(summary.spentUsd).toBeCloseTo(0.028, 6);
  });

  it("repeats each case --repeat times", async () => {
    const { client } = fakeClient();
    const opts = options({ client, cases: CASES.slice(0, 1), repeat: 2 });
    const summary = await runEval(opts);
    expect(summary.rows.map((r) => r.id)).toEqual(["hint-1#1", "hint-1#2"]);
  });
});
