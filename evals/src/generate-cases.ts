/**
 * Builds the frozen eval cases (#10): plays each SAN sequence in evals/cases/sequences.json,
 * analyses the last move with real Stockfish (config/tutor.json engine settings) and runs
 * detect() with the config thresholds and the repertoire. A key-moment sequence becomes a case
 * only when detect() returns the intended kind; a hint sequence needs the player to move.
 * Everything else is reported and skipped (and an older <id>.json removed). Writes evals/cases/<id>.json.
 *
 *   pnpm --filter @chess-tutor/evals generate-cases [--only <id glob>]
 *
 * No network: the explorer is not used.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { detect, scoreToCp, type Analysis, type Color, type KeyMomentThresholds, type Repertoire } from "@chess-tutor/chess-core";
import { Chess } from "chess.js";
import { CASES_DIR, loadRepertoire, loadSettings } from "./config.ts";
import type { EvalCase } from "./types.ts";

export interface Sequence {
  id: string;
  kind: EvalCase["kind"];
  playerColor: Color;
  san: string[];
  source: string;
}

export interface Analyzer {
  analyze(fen: string, opts: { depth: number; movetimeMs: number; multiPv: number }): Promise<Analysis>;
}

export type GenerateOutcome = { ok: true; case: EvalCase } | { ok: false; id: string; problem: string };

export async function generateCase(
  s: Sequence,
  deps: { engine: Analyzer; settings: { depth: number; movetimeMs: number; multiPv: number }; thresholds: KeyMomentThresholds; repertoire: Repertoire },
): Promise<GenerateOutcome> {
  const chess = new Chess();
  const uci: string[] = [];
  for (const san of s.san) {
    try {
      const m = chess.move(san);
      uci.push(m.from + m.to + (m.promotion ?? ""));
    } catch {
      return { ok: false, id: s.id, problem: `illegal move ${san} after ${uci.length} plies` };
    }
  }
  const fen = chess.fen();
  const analyze = (f: string) => deps.engine.analyze(f, deps.settings);
  const bestOf = (a: Analysis, f: string) => {
    const top = a.lines[0];
    const mover = new Chess(f).turn();
    return { uci: top?.moves[0] ?? a.bestMove, cp: top ? scoreToCp(top.score, mover, mover) : 0 };
  };

  if (s.kind === "hint") {
    if (chess.turn() !== s.playerColor) return { ok: false, id: s.id, problem: "hint position has the opponent to move" };
    const a = await analyze(fen);
    const best = bestOf(a, fen);
    return {
      ok: true,
      case: { id: s.id, kind: "hint", playerColor: s.playerColor, history: uci, fen, moment: null, attemptFen: fen, engineBest: best.uci, engineBestCp: best.cp, source: s.source },
    };
  }

  chess.undo();
  const fenBefore = chess.fen();
  const before = await analyze(fenBefore);
  const after = await analyze(fen);
  const moment = detect({
    playerColor: s.playerColor,
    fenBefore,
    move: uci[uci.length - 1]!,
    history: uci.slice(0, -1),
    before,
    after,
    repertoire: deps.repertoire,
    thresholds: deps.thresholds,
  });
  if (!moment) return { ok: false, id: s.id, problem: `no key moment (wanted ${s.kind})` };
  if (moment.kind !== s.kind) return { ok: false, id: s.id, problem: `detected ${moment.kind} (${JSON.stringify(moment)}), wanted ${s.kind}` };
  const attemptBefore = moment.kind === "player_blunder" || moment.kind === "missed_win";
  const attemptFen = attemptBefore ? fenBefore : fen;
  const best = attemptBefore ? bestOf(before, fenBefore) : bestOf(after, fen);
  return {
    ok: true,
    case: { id: s.id, kind: moment.kind, playerColor: s.playerColor, history: uci, fen, moment, attemptFen, engineBest: best.uci, engineBestCp: best.cp, source: s.source },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { only: { type: "string" } } });
  const { createEngineFromEnv } = await import("@chess-tutor/engine");
  const settings = loadSettings();
  const repertoire = loadRepertoire();
  const engine = createEngineFromEnv(settings.engineThreads !== undefined ? { threads: settings.engineThreads } : {});
  const all = JSON.parse(readFileSync(join(CASES_DIR, "sequences.json"), "utf8")) as Sequence[];
  const only = values.only ? new RegExp(`^${values.only.replace(/\*/g, ".*")}$`) : null;
  const sequences = all.filter((s) => !only || only.test(s.id));
  const counts: Record<string, number> = {};
  const failed: string[] = [];
  try {
    for (const s of sequences) {
      const out = await generateCase(s, {
        engine,
        settings: { depth: settings.tutor.engine.depth, movetimeMs: settings.tutor.engine.movetimeCapMs, multiPv: settings.tutor.engine.multiPv },
        thresholds: settings.thresholds,
        repertoire,
      });
      if (out.ok) {
        writeFileSync(join(CASES_DIR, `${out.case.id}.json`), JSON.stringify(out.case, null, 2) + "\n");
        counts[out.case.kind] = (counts[out.case.kind] ?? 0) + 1;
        console.log(`ok   ${s.id}: ${out.case.kind}${out.case.moment ? " " + JSON.stringify(out.case.moment) : ""}, best ${out.case.engineBest} (${out.case.engineBestCp} cp)`);
      } else {
        failed.push(`${out.id}: ${out.problem}`);
        // A case left from an earlier generation would no longer match its sequence.
        const stale = join(CASES_DIR, `${out.id}.json`);
        if (existsSync(stale)) rmSync(stale);
        console.log(`SKIP ${out.id}: ${out.problem}`);
      }
    }
  } finally {
    await engine.quit();
  }
  console.log(`\nCases written: ${JSON.stringify(counts)}`);
  console.log(`Skipped ${failed.length}:${failed.map((f) => `\n  ${f}`).join("")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
