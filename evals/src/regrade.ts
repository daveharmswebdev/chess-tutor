import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCases } from "./cases.ts";
import { CASES_DIR } from "./config.ts";
import { gradeReply, type GradeInput } from "./graders.ts";
import { computeMetrics, renderRunReport, toRow } from "./report.ts";
import type { CaseResult, EvalCase, RecordedRound, RunSummary } from "./types.ts";

/** The grader input for a recorded result and its case; null when the ask returned no reply. */
export function gradeInputFor(r: Pick<CaseResult, "reply" | "rounds" | "revealCpLoss">, c: EvalCase, toleranceCp: number): GradeInput | null {
  if (!r.reply) return null;
  return {
    kind: c.kind,
    playerColor: c.playerColor,
    history: c.history,
    fen: c.fen,
    attemptFen: c.attemptFen,
    moment: c.moment,
    engineBest: c.engineBest,
    reply: r.reply,
    toolResults: r.rounds.flatMap((x) => x.toolResults),
    revealCpLoss: r.revealCpLoss,
    toleranceCp,
  };
}

const BUCKETS: [string, RegExp][] = [
  ["give_away", /gives the answer away/],
  ["illegal_move", /not legal in any position/],
  ["unbacked_move", /does not appear in this turn's tool results|is not backed by this turn's tool results/],
  ["unbacked_eval", /quotes the evaluation/],
  ["reveal_move", /revealMove "/],
  ["invalid_reply", /not valid JSON|did not match the schema|kind must be|must go from one square/],
];

/**
 * The reasons in one correction turn (a turn can carry several problems). Sorted; "other" when
 * nothing known matches. Texts come from packages/tutor claims.ts and schema.ts.
 */
export function classifyCorrection(text: string): string[] {
  const hits = BUCKETS.filter(([, re]) => re.test(text)).map(([name]) => name);
  return hits.length ? hits.sort() : ["other"];
}

/** Retries from the recorded corrections; recordings from before round 2 have none, so fall back to end_turn rounds. */
export function retriesOf(rounds: RecordedRound[]): { retries: number; retryReasons: string[] } {
  const corrections = rounds.map((r) => r.correction).filter((c): c is string => typeof c === "string");
  if (corrections.length > 0) return { retries: corrections.length, retryReasons: corrections.flatMap(classifyCorrection) };
  if (rounds.some((r) => "correction" in r)) return { retries: 0, retryReasons: [] };
  const endTurns = rounds.filter((r) => r.stopReason === "end_turn").length;
  const retries = Math.max(0, endTurns - 1);
  return { retries, retryReasons: Array.from({ length: retries }, () => "unrecorded") };
}

export function regradeResult(r: CaseResult, c: EvalCase, toleranceCp: number): CaseResult {
  const input = gradeInputFor(r, c, toleranceCp);
  return { ...r, ...retriesOf(r.rounds), grades: input ? gradeReply(input) : null };
}

/**
 * Re-grades a run directory offline from its per-case files (no API, no engine): rewrites each
 * cases/<id>.json, summary.json (run settings kept) and report.md with the current graders.
 */
export function regradeDir(dir: string, opts: { casesDir?: string; toleranceCp?: number } = {}): RunSummary {
  const cases = new Map(loadCases(opts.casesDir ?? CASES_DIR).map((c) => [c.id, c]));
  const tol = opts.toleranceCp ?? 50;
  const files = readdirSync(join(dir, "cases")).filter((f) => f.endsWith(".json")).sort();
  const results: CaseResult[] = [];
  for (const f of files) {
    const path = join(dir, "cases", f);
    const r = JSON.parse(readFileSync(path, "utf8")) as CaseResult;
    const c = cases.get(r.caseId);
    if (!c) throw new Error(`${f}: case ${r.caseId} is not in ${opts.casesDir ?? CASES_DIR}`);
    const graded = regradeResult(r, c, tol);
    writeFileSync(path, JSON.stringify(graded, null, 2) + "\n");
    results.push(graded);
  }
  const old: Partial<RunSummary> = existsSync(join(dir, "summary.json")) ? (JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as RunSummary) : {};
  const rows = results.map(toRow);
  const now = new Date().toISOString();
  const summary: RunSummary = {
    model: old.model ?? results[0]?.model ?? "unknown",
    effort: old.effort ?? results[0]?.effort ?? "unknown",
    promptFile: old.promptFile ?? "unknown",
    promptSha256: old.promptSha256 ?? "",
    startedAt: old.startedAt ?? now,
    finishedAt: old.finishedAt ?? now,
    maxUsd: old.maxUsd ?? 0,
    spentUsd: old.spentUsd ?? results.reduce((s, r) => s + r.costUsd, 0),
    stoppedByBudget: old.stoppedByBudget ?? false,
    skipped: old.skipped ?? [],
    metrics: computeMetrics(rows),
    rows,
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(dir, "report.md"), renderRunReport(summary));
  return summary;
}
