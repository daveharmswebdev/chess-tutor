import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTutorSession, type TutorConfig, type TutorFailureReason } from "@chess-tutor/tutor";
import { describe, expect, it } from "vitest";
import { computeMetrics, exitDecision, noReplyWarning } from "../src/report.ts";
import { runEval, type RunOptions } from "../src/runner.ts";
import type { EvalCase } from "../src/types.ts";
import { fakeClient, fakeEngine, fakeExplorer, hintCase } from "./fakes.ts";

/** #90 (NFR-10): a run where no case reached Claude never passes, with or without --gate. */

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
];

type Script = "ok" | "threw" | TutorFailureReason;

/** Each case ends as scripted: "ok" runs the real session on the fake client, a reason fails at once. */
function scripted(cases: EvalCase[], script: Script[]): NonNullable<RunOptions["createSession"]> {
  const byFen = new Map(cases.map((c, i) => [c.fen, script[i]!]));
  return (deps, ctx) => {
    const real = createTutorSession(deps, ctx);
    return {
      async ask(request, onProgress, signal) {
        const end = byFen.get(request.fen)!;
        if (end === "ok") return real.ask(request, onProgress, signal);
        if (end === "threw") throw new Error("boom");
        const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        return { ok: false, reason: end, message: `scripted ${end}`, usage, ms: 1 };
      },
    };
  };
}

async function run(script: Script[], over: Partial<RunOptions> = {}) {
  const cases = CASES.slice(0, script.length);
  const { client } = fakeClient();
  const outDir = mkdtempSync(join(tmpdir(), "evals-noreply-"));
  const summary = await runEval({
    cases,
    config: CONFIG,
    client,
    engine: fakeEngine(),
    explorer: fakeExplorer,
    repertoire: null,
    systemPrompt: "SYSTEM",
    promptFile: "tutor-system.v1.md",
    price: { input: 4, output: 20, cacheRead: 0.2 },
    toleranceCp: 50,
    maxUsd: 10,
    concurrency: 1,
    repeat: 1,
    outDir,
    log: () => {},
    createSession: scripted(cases, script),
    ...over,
  });
  return { summary, report: readFileSync(join(outDir, "report.md"), "utf8") };
}

describe("a run where no case reached Claude (#90)", () => {
  it("every case api_unavailable: exit 1 without --gate, warning first in report.md and in the lines", async () => {
    const { summary, report } = await run(["api_unavailable", "api_unavailable", "api_unavailable"]);
    const d = exitDecision(summary, false);
    expect(d.exitCode).toBe(1);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatch(/No case reached Claude/);
    expect(d.lines[0]).toMatch(/api_unavailable \(3 of 3 cases\)/);
    const firstParagraph = report.split("\n\n")[0]!;
    expect(firstParagraph).toBe(d.lines[0]);
    expect(report.indexOf("# Tutor eval")).toBeGreaterThan(0);
  });

  it("with --gate also exits 1 and still prints the warning", async () => {
    const { summary } = await run(["api_unavailable", "api_unavailable"]);
    const d = exitDecision(summary, true);
    expect(d.exitCode).toBe(1);
    expect(d.lines[0]).toMatch(/No case reached Claude/);
    expect(d.lines.slice(1).every((l) => l.startsWith("gate: "))).toBe(true);
  });

  it("a mix of rate_limited, auth and threw with no ok case: exit 1, names the most common reason", async () => {
    const { summary, report } = await run(["rate_limited", "auth", "threw", "rate_limited"]);
    const d = exitDecision(summary, false);
    expect(d.exitCode).toBe(1);
    expect(d.lines[0]).toMatch(/rate_limited \(2 of 4 cases\)/);
    expect(report.startsWith(d.lines[0]!)).toBe(true);
  });

  it("zero cases started (all stopped by the budget): exit 1", async () => {
    const { summary, report } = await run(["ok", "ok"], { maxUsd: 0 });
    expect(summary.metrics.cases).toBe(0);
    expect(summary.skipped).toHaveLength(2);
    const d = exitDecision(summary, false);
    expect(d.exitCode).toBe(1);
    expect(d.lines[0]).toMatch(/No case reached Claude/);
    expect(d.lines[0]).toMatch(/2 not started/);
    expect(report.startsWith(d.lines[0]!)).toBe(true);
  });

  it("one ok case and the rest api_unavailable: exit 0 without --gate, no warning", async () => {
    const { summary, report } = await run(["api_unavailable", "ok", "api_unavailable"]);
    expect(exitDecision(summary, false)).toEqual({ exitCode: 0, lines: [] });
    expect(noReplyWarning(summary.metrics, summary.skipped.length)).toBeNull();
    expect(report.startsWith("# Tutor eval")).toBe(true);
    expect(report).not.toMatch(/No case reached Claude/);
  });

  it("one invalid_reply case and the rest api_unavailable: exit 0 (it reached Claude)", async () => {
    const { summary, report } = await run(["api_unavailable", "invalid_reply", "api_unavailable"]);
    expect(exitDecision(summary, false)).toEqual({ exitCode: 0, lines: [] });
    expect(report.startsWith("# Tutor eval")).toBe(true);
  });

  it("every reason that came from the model counts as reaching Claude", () => {
    for (const reason of ["invalid_reply", "unsupported_claim", "tool_rounds_exceeded", "refusal", "max_tokens"]) {
      const m = { ...computeMetrics([]), cases: 1, okRate: 0, failureReasons: { [reason]: 1 } };
      expect(noReplyWarning(m, 0)).toBeNull();
    }
  });

  it("with --gate, a run that reached Claude keeps the gate decision unchanged", async () => {
    const { summary } = await run(["ok", "ok"]);
    expect(exitDecision(summary, true)).toEqual({ exitCode: 0, lines: [] });
    const { summary: half } = await run(["ok", "api_unavailable"]);
    const d = exitDecision(half, true);
    expect(d.exitCode).toBe(1);
    expect(d.lines).toEqual([expect.stringMatching(/^gate: graded 50% of cases/)]);
  });
});
