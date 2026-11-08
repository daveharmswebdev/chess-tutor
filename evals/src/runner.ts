import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MATE_CP, scoreToCp, type Repertoire } from "@chess-tutor/chess-core";
import {
  createTutorSession,
  type TutorClient,
  type TutorConfig,
  type TutorEngine,
  type TutorExplorer,
  type TutorOutcome,
  type TutorRequest,
} from "@chess-tutor/tutor";
import { costUsd, PLAYER_PROFILE, sha256, type Price } from "./config.ts";
import { gradeReply } from "./graders.ts";
import { gradeInputFor, retriesOf } from "./regrade.ts";
import { board, playUci } from "./notation.ts";
import { recordingClient } from "./recorder.ts";
import { computeMetrics, renderRunReport, toRow } from "./report.ts";
import type { CaseResult, EvalCase, RecordedRound, RunSummary } from "./types.ts";

export interface RunOptions {
  cases: EvalCase[];
  /** Model and effort to measure are set here (from --model / --effort). */
  config: TutorConfig;
  client: TutorClient;
  engine: TutorEngine;
  explorer: TutorExplorer;
  repertoire: Repertoire | null;
  systemPrompt: string;
  promptFile: string;
  price: Price;
  toleranceCp: number;
  /** Stop starting new cases once the summed cost reaches this. */
  maxUsd: number;
  concurrency: number;
  repeat: number;
  outDir: string;
  log?: (line: string) => void;
}

/** The request the server would send for this case. */
export function requestFor(c: EvalCase): TutorRequest {
  if (c.kind === "hint" || c.moment === null) return { kind: "hint", fen: c.fen, history: c.history };
  return { kind: "key_moment", moment: c.moment, fen: c.fen, attemptFen: c.attemptFen, history: c.history };
}

/**
 * Runs every case (x repeat) through a fresh real tutor session (same tool loop, tools, prompt
 * and claims check as the server), at most `concurrency` at a time, and grades each reply.
 * Before starting a case it checks the spend: once the summed cost of finished cases reaches
 * maxUsd, no new case starts (cases already running finish, so a run can end slightly above).
 */
export async function runEval(opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const startedAt = new Date().toISOString();
  mkdirSync(join(opts.outDir, "cases"), { recursive: true });

  const jobs: { c: EvalCase; repeat: number; id: string }[] = [];
  for (const c of opts.cases) {
    for (let r = 1; r <= opts.repeat; r++) jobs.push({ c, repeat: r, id: opts.repeat > 1 ? `${c.id}#${r}` : c.id });
  }

  const results: CaseResult[] = new Array(jobs.length);
  const skipped: string[] = [];
  let spent = 0;
  let next = 0;
  let stoppedByBudget = false;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i]!;
      if (spent >= opts.maxUsd) {
        stoppedByBudget = true;
        skipped.push(job.id);
        continue;
      }
      const result = await runCase(job.c, job.id, job.repeat, opts);
      spent += result.costUsd;
      results[i] = result;
      writeFileSync(join(opts.outDir, "cases", `${fileName(job.id)}.json`), JSON.stringify(result, null, 2) + "\n");
      const flags = result.grades
        ? [result.grades.nfr6Moves ? "" : "moves", result.grades.nfr6Evals ? "" : "evals", result.grades.nfr7 ? "" : "give-away"].filter(Boolean).join(",")
        : "";
      log(
        `${job.id} | ${result.ok ? "ok" : `FAIL ${result.reason}`}${flags ? ` | ${flags}` : ""} | ${(result.ms / 1000).toFixed(1)} s | $${result.costUsd.toFixed(4)} | total $${spent.toFixed(4)}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, jobs.length)) }, worker));

  const done = results.filter((r): r is CaseResult => r !== undefined);
  const rows = done.map(toRow);
  const summary: RunSummary = {
    model: opts.config.model,
    effort: opts.config.effort,
    promptFile: opts.promptFile,
    promptSha256: sha256(opts.systemPrompt),
    startedAt,
    finishedAt: new Date().toISOString(),
    maxUsd: opts.maxUsd,
    spentUsd: spent,
    stoppedByBudget,
    skipped,
    metrics: computeMetrics(rows),
    rows,
  };
  writeFileSync(join(opts.outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(opts.outDir, "report.md"), renderRunReport(summary));
  return summary;
}

function fileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function runCase(c: EvalCase, id: string, repeat: number, opts: RunOptions): Promise<CaseResult> {
  const rounds: RecordedRound[] = [];
  const progress: string[] = [];
  const session = createTutorSession(
    {
      client: recordingClient(opts.client, rounds),
      engine: opts.engine,
      explorer: opts.explorer,
      repertoire: opts.repertoire,
      config: opts.config,
      systemPrompt: opts.systemPrompt,
    },
    { playerColor: c.playerColor, playerProfile: PLAYER_PROFILE },
  );
  const started = performance.now();
  let outcome: TutorOutcome | { ok: false; reason: "threw"; message: string; usage: TutorOutcome["usage"]; ms: number };
  try {
    outcome = await session.ask(requestFor(c), (p) => progress.push(p.label));
  } catch (err) {
    // ask() is documented never to throw; record it if it does.
    const usage = { requests: rounds.length, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    outcome = { ok: false, reason: "threw", message: String(err), usage, ms: Math.round(performance.now() - started) };
  }

  const reply = outcome.ok ? outcome.reply : null;
  let revealCpLoss: number | null = null;
  if (reply?.revealMove && reply.revealMove !== c.engineBest) revealCpLoss = await cpLoss(c, reply.revealMove, opts);

  const input = gradeInputFor({ reply, rounds, revealCpLoss }, c, opts.toleranceCp);
  const grades = input ? gradeReply(input) : null;
  return {
    id,
    caseId: c.id,
    repeat,
    kind: c.kind,
    model: opts.config.model,
    effort: opts.config.effort,
    ok: outcome.ok,
    reason: outcome.ok ? null : outcome.reason,
    failureMessage: outcome.ok ? null : outcome.message,
    reply,
    ms: outcome.ms,
    firstRoundMs: rounds[0]?.ms ?? null,
    toolCalls: rounds.reduce((n, r) => n + r.toolUses.length, 0),
    ...retriesOf(rounds),
    usage: outcome.usage,
    costUsd: costUsd(outcome.usage, opts.price),
    revealCpLoss,
    progress,
    rounds,
    grades,
  };
}

/** Loss of `uci` against the case's engine best, from the attempt side's view (engine at config depth). */
async function cpLoss(c: EvalCase, uci: string, opts: RunOptions): Promise<number | null> {
  const attempt = c.kind === "hint" ? c.fen : c.attemptFen;
  const played = playUci(attempt, uci);
  if (!played) return null;
  const mover = played.move.color;
  const after = board(played.fen)!;
  let cp: number;
  try {
    const analysis = await opts.engine.analyze(played.fen, {
      depth: opts.config.engine.depth,
      movetimeMs: opts.config.engine.movetimeCapMs,
      multiPv: 1,
    });
    const top = analysis.lines[0];
    if (top) cp = scoreToCp(top.score, mover, after.turn());
    else cp = after.isCheckmate() ? MATE_CP : 0;
  } catch {
    return null;
  }
  return Math.max(0, c.engineBestCp - cp);
}
