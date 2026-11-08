import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_MOMENTS_PER_GAME, NEEDS_JUDGE, type CaseResult, type CaseRow, type RunMetrics, type RunSummary } from "./types.ts";

/** The NFR-7 target: at least 90% of replies keep the answer back. */
export const NFR7_TARGET = 0.9;

export function toRow(r: CaseResult): CaseRow {
  const g = r.grades;
  const problems = g
    ? [
        ...g.schema.problems,
        ...g.moves.illegal.map((m) => `illegal move "${m}"`),
        ...g.evals.quotes.filter((q) => q.problem).map((q) => `${q.problem} evaluation "${q.raw}"`),
        ...g.giveAway.problems,
        ...g.arrows.problems,
        ...g.reveal.problems,
      ]
    : [r.failureMessage ?? r.reason ?? "failed"];
  return {
    id: r.id,
    caseId: r.caseId,
    kind: r.kind,
    ok: r.ok,
    reason: r.reason,
    nfr6Moves: g ? g.nfr6Moves : null,
    nfr6Evals: g ? g.nfr6Evals : null,
    nfr7: g ? g.nfr7 : null,
    arrowsOk: g ? g.arrows.pass : null,
    revealOk: g ? g.reveal.pass : null,
    schemaOk: g ? g.schema.pass : null,
    pointsAtAnswer: g ? g.pointsAtAnswer : null,
    toolCalls: r.toolCalls,
    retries: r.retries,
    retryReasons: r.retryReasons ?? [],
    ms: r.ms,
    firstRoundMs: r.firstRoundMs,
    costUsd: r.costUsd,
    problems,
  };
}

function countReasons(rows: CaseRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) for (const reason of r.retryReasons ?? []) out[reason] = (out[reason] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

const share = (rows: CaseRow[], f: (r: CaseRow) => boolean | null): number | null =>
  rows.length === 0 ? null : rows.filter((r) => f(r) === true).length / rows.length;

export function computeMetrics(rows: CaseRow[]): RunMetrics {
  const graded = rows.filter((r) => r.ok);
  const failureReasons: Record<string, number> = {};
  for (const r of rows) if (!r.ok) failureReasons[r.reason ?? "unknown"] = (failureReasons[r.reason ?? "unknown"] ?? 0) + 1;
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  const perCase = rows.length ? total / rows.length : null;
  const firsts = rows.map((r) => r.firstRoundMs).filter((x): x is number => x !== null);
  return {
    cases: rows.length,
    okRate: share(rows, (r) => r.ok),
    failureReasons,
    graded: graded.length,
    moveLegalPct: share(graded, (r) => r.nfr6Moves),
    evalMatchPct: share(graded, (r) => r.nfr6Evals),
    noGiveAwayPct: share(graded, (r) => r.nfr7),
    pointsAtAnswerPct: share(graded, (r) => r.pointsAtAnswer),
    arrowsOkPct: share(graded, (r) => r.arrowsOk),
    revealOkPct: share(graded, (r) => r.revealOk),
    schemaOkPct: share(graded, (r) => r.schemaOk),
    toolCallsMean: rows.length ? rows.reduce((s, r) => s + r.toolCalls, 0) / rows.length : null,
    retriesTotal: rows.reduce((s, r) => s + r.retries, 0),
    retryReasons: countReasons(rows),
    latencyP50Ms: percentile(rows.map((r) => r.ms), 0.5),
    latencyP95Ms: percentile(rows.map((r) => r.ms), 0.95),
    firstRoundP50Ms: percentile(firsts, 0.5),
    firstRoundP95Ms: percentile(firsts, 0.95),
    costPerCaseUsd: perCase,
    costPerGameUsd: perCase === null ? null : perCase * KEY_MOMENTS_PER_GAME,
    totalCostUsd: total,
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
const sec = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const usd = (x: number | null, digits = 4) => (x === null ? "n/a" : `$${x.toFixed(digits)}`);
const reasons = (m: RunMetrics) =>
  Object.keys(m.failureReasons).length === 0 ? "none" : Object.entries(m.failureReasons).map(([k, v]) => `${k} ${v}`).join(", ");

/** Metric rows: label, how to read it, value per run. */
const METRIC_ROWS: [string, (m: RunMetrics) => string][] = [
  ["Cases asked", (m) => String(m.cases)],
  ["OK rate (tutor returned a reply)", (m) => pct(m.okRate)],
  ["Failure reasons", reasons],
  ["NFR-6 move legality (replies)", (m) => pct(m.moveLegalPct)],
  ["NFR-6 eval match (replies)", (m) => pct(m.evalMatchPct)],
  [`NFR-7 no give-away (target >= ${NFR7_TARGET * 100}%)`, (m) => pct(m.noGiveAwayPct)],
  ["Points at the answer square (information, not NFR-7)", (m) => pct(m.pointsAtAnswerPct ?? null)],
  ["Arrows well formed", (m) => pct(m.arrowsOkPct)],
  ["Reveal move best or within tolerance", (m) => pct(m.revealOkPct)],
  ["Schema and kind", (m) => pct(m.schemaOkPct)],
  ["Tool calls per case (mean)", (m) => (m.toolCallsMean === null ? "n/a" : m.toolCallsMean.toFixed(1))],
  ["Correction retries (total)", (m) => String(m.retriesTotal)],
  ["Correction retries by reason", (m) => byReason(m.retryReasons)],
  ["Latency p50 / p95", (m) => `${sec(m.latencyP50Ms)} / ${sec(m.latencyP95Ms)}`],
  ["First API round p50 / p95", (m) => `${sec(m.firstRoundP50Ms)} / ${sec(m.firstRoundP95Ms)}`],
  ["Cost per case", (m) => usd(m.costPerCaseUsd)],
  [`Cost per game (${KEY_MOMENTS_PER_GAME} asks)`, (m) => usd(m.costPerGameUsd, 3)],
  ["Total cost", (m) => usd(m.totalCostUsd, 3)],
];

const byReason = (r: Record<string, number> | undefined) =>
  !r || Object.keys(r).length === 0 ? "none" : Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ");

const mark = (b: boolean | null) => (b === null ? "-" : b ? "pass" : "FAIL");

function cell(r: CaseRow | undefined): string {
  if (!r) return "not run";
  if (!r.ok) return `FAIL ${r.reason}`;
  const bad = [r.nfr6Moves ? null : "moves", r.nfr6Evals ? null : "evals", r.nfr7 ? null : "give-away", r.arrowsOk ? null : "arrows", r.revealOk ? null : "reveal", r.schemaOk ? null : "schema"].filter(Boolean);
  return bad.length ? `ok, ${bad.join(", ")}` : "ok";
}

const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderRunReport(s: RunSummary): string {
  const m = s.metrics;
  const lines = [
    `# Tutor eval: ${s.model}, effort ${s.effort}`,
    "",
    `Prompt ${s.promptFile} (sha256 ${s.promptSha256.slice(0, 12)}). Started ${s.startedAt}, finished ${s.finishedAt}.`,
    `Spent ${usd(s.spentUsd, 3)} of the ${usd(s.maxUsd, 2)} cap.${s.stoppedByBudget ? ` Stopped by the budget: ${s.skipped.length} cases not started.` : ""}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...METRIC_ROWS.map(([label, f]) => `| ${label} | ${f(m)} |`),
    "",
    m.noGiveAwayPct !== null && m.noGiveAwayPct < NFR7_TARGET ? `NFR-7 is below its ${NFR7_TARGET * 100}% target.\n` : "",
    "## Cases",
    "",
    "| Case | Kind | Result | Moves | Evals | NFR-7 | Points at answer | Arrows | Reveal | Tools | Retries | Time | Cost | Problems |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...s.rows.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.ok ? "ok" : `FAIL ${r.reason}`} | ${mark(r.nfr6Moves)} | ${mark(r.nfr6Evals)} | ${mark(r.nfr7)} | ${r.pointsAtAnswer === null ? "-" : r.pointsAtAnswer ? "yes" : "no"} | ${mark(r.arrowsOk)} | ${mark(r.revealOk)} | ${r.toolCalls} | ${r.retries ? `${r.retries} (${(r.retryReasons ?? []).join(", ")})` : "0"} | ${sec(r.ms)} | ${usd(r.costUsd)} | ${escape(r.problems.join("; "))} |`,
    ),
    "",
    needsJudge(),
  ];
  return lines.join("\n") + "\n";
}

function needsJudge(): string {
  return ["## Not graded here (needs an LLM judge)", "", ...NEEDS_JUDGE.map((n) => `- ${n}`)].join("\n");
}

export interface CompareResult {
  runs: { dir: string; model: string; effort: string; promptFile: string; metrics: RunMetrics }[];
  cases: { caseId: string; kind: string; results: string[] }[];
}

/** Reads summary.json from each run directory and lines the runs up side by side. */
export function compareRuns(dirs: string[]): { json: CompareResult; markdown: string } {
  const summaries = dirs.map((dir) => ({ dir, s: JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as RunSummary }));
  const ids: string[] = [];
  const kinds = new Map<string, string>();
  for (const { s } of summaries) {
    for (const r of s.rows) {
      if (!kinds.has(r.id)) ids.push(r.id);
      kinds.set(r.id, r.kind);
    }
  }
  ids.sort();
  const json: CompareResult = {
    runs: summaries.map(({ dir, s }) => ({ dir, model: s.model, effort: s.effort, promptFile: s.promptFile, metrics: s.metrics })),
    cases: ids.map((id) => ({ caseId: id, kind: kinds.get(id)!, results: summaries.map(({ s }) => cell(s.rows.find((r) => r.id === id))) })),
  };
  const heads = summaries.map(({ s }) => `${s.model} ${s.effort}`);
  const sep = `| --- |${heads.map(() => " --- |").join("")}`;
  const md = [
    "# Tutor eval comparison",
    "",
    ...summaries.map(({ dir, s }, i) => `${i + 1}. ${heads[i]}, prompt ${s.promptFile}: ${dir}`),
    "",
    `| Metric | ${heads.join(" | ")} |`,
    sep,
    ...METRIC_ROWS.map(([label, f]) => `| ${label} | ${summaries.map(({ s }) => f(s.metrics)).join(" | ")} |`),
    "",
    "## Cases",
    "",
    `| Case | Kind | ${heads.join(" | ")} |`,
    `| --- | --- |${heads.map(() => " --- |").join("")}`,
    ...json.cases.map((c) => `| ${c.caseId} | ${c.kind} | ${c.results.join(" | ")} |`),
    "",
    needsJudge(),
  ];
  return { json, markdown: md.join("\n") + "\n" };
}
