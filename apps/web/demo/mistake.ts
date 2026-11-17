// Mistake picker for the guided demo (#59: FR-27, FR-10). Stockfish chooses the mistake from the
// actual position: every legal White move is played on a copy of the board and the position after
// it is analysed. The pick is the move with the smallest loss against the best move that is still
// >= minLossCp (about 2 pawns: a clear key moment, but something to teach), never a move that lets
// Black force mate, and never one after which White stays above maxPlayedCp (the server's
// stillWinningCp: the tutor would stay quiet). Never hard-coded, never chosen by Claude.
import { Chess } from "chess.js";
import { MATE_CP, scoreToCp } from "@chess-tutor/chess-core";
import type { AnalyzeOptions, Engine } from "@chess-tutor/engine";

/** Loss against the best move that counts as a demo mistake (config/tutor.json blunderCp is 150). */
export const DEFAULT_MIN_LOSS_CP = 200;
/** White must not stay above this after the mistake (config/tutor.json stillWinningCp). */
export const DEFAULT_MAX_PLAYED_CP = 500;
export const DEFAULT_ANALYZE: AnalyzeOptions = { depth: 14, movetimeMs: 300 };

export interface MistakeOptions {
  minLossCp?: number;
  maxPlayedCp?: number;
  analyze?: AnalyzeOptions;
  /** Leave out king moves: a king walk loses for slow reasons that are hard to show in one video. */
  skipKingMoves?: boolean;
}

/** A legal White move and the engine's eval of the position after it (centipawns, White's view). */
export interface MoveEval {
  uci: string;
  san: string;
  from: string;
  to: string;
  /** chess.js piece letter: p, n, b, r, q, k. */
  piece: string;
  cp: number;
  /** Black has a forced mate after this move. */
  matedAgainst: boolean;
}

export interface Mistake {
  uci: string;
  san: string;
  from: string;
  to: string;
  bestCp: number;
  playedCp: number;
  lossCp: number;
}

/** Analyses the position after every legal White move, one search at a time. */
export async function evaluateMoves(
  engine: Pick<Engine, "analyze">,
  fen: string,
  analyze: AnalyzeOptions = DEFAULT_ANALYZE,
): Promise<MoveEval[]> {
  const chess = new Chess(fen);
  if (chess.turn() !== "w") throw new Error(`pickMistake needs White to move, got ${fen}`);
  const out: MoveEval[] = [];
  for (const m of chess.moves({ verbose: true })) {
    const base = { uci: m.from + m.to + (m.promotion ?? ""), san: m.san, from: m.from, to: m.to, piece: m.piece };
    // A terminal position gets no line from Stockfish (mate 0 comes without a pv), so chess.js
    // scores it: White's checkmate is the best move there is (never a mistake), a draw is 0.
    const after = new Chess(m.after);
    if (after.isCheckmate()) {
      out.push({ ...base, cp: MATE_CP, matedAgainst: false });
      continue;
    }
    if (after.isDraw() || after.isStalemate()) {
      out.push({ ...base, cp: 0, matedAgainst: false });
      continue;
    }
    const analysis = await engine.analyze(m.after, analyze);
    const line = analysis.lines[0];
    if (!line) throw new Error(`engine returned no line for ${m.after}`);
    // Black is to move in the analysed position; the score is White's (engine contract).
    const cp = scoreToCp(line.score, "w", "b");
    out.push({ ...base, cp, matedAgainst: line.score.kind === "mate" && cp < 0 });
  }
  return out;
}

/** The qualifying move with the smallest loss, or null when none qualifies. */
export function chooseMistake(evals: readonly MoveEval[], opts: MistakeOptions = {}): Mistake | null {
  if (evals.length === 0) return null;
  const minLoss = opts.minLossCp ?? DEFAULT_MIN_LOSS_CP;
  const maxPlayed = opts.maxPlayedCp ?? DEFAULT_MAX_PLAYED_CP;
  const bestCp = Math.max(...evals.map((e) => e.cp));
  let pick: Mistake | null = null;
  for (const e of evals) {
    if (e.matedAgainst || e.cp > maxPlayed || (opts.skipKingMoves && e.piece === "k")) continue;
    const lossCp = bestCp - e.cp;
    if (lossCp < minLoss) continue;
    if (pick === null || lossCp < pick.lossCp) {
      pick = { uci: e.uci, san: e.san, from: e.from, to: e.to, bestCp, playedCp: e.cp, lossCp };
    }
  }
  return pick;
}

export async function pickMistake(engine: Pick<Engine, "analyze">, fen: string, opts: MistakeOptions = {}): Promise<Mistake | null> {
  return chooseMistake(await evaluateMoves(engine, fen, opts.analyze), opts);
}
