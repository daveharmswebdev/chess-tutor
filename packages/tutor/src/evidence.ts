import type { Score } from "@chess-tutor/chess-core";
import { boardOf, playUci, uciOf, type MovePair } from "./chess-util.ts";

/** A position without its move counters: placement, side to move, castling, en passant. */
export function positionKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

/**
 * What the tutor was shown in one ask() (FR-10). Built fresh per request; tools add to it.
 *
 * - positions: every position the tutor may talk about (the request positions, the game's
 *   history, every position reached in a tool line).
 * - backed moves: (position, UCI) pairs from tool results and the key-moment data. A move is
 *   backed only in the position it is played from, so "O-O" in White's history never backs
 *   Black's O-O, and an engine line's third ply is backed only after its first two.
 * - history moves: (position, UCI) pairs of the game so far. They let the tutor mention a
 *   move already played, but never back a move in the current (focus) position.
 * - scores: absolute centipawn values and mate distances from tool results and the key moment,
 *   for checking quoted evaluations.
 */
export class Evidence {
  private readonly positions = new Map<string, string>(); // key -> full FEN
  private readonly focus = new Set<string>();
  private readonly backed = new Set<string>();
  private readonly history = new Set<string>();
  private readonly cps: number[] = [];
  private readonly mates = new Set<number>();

  addPosition(fen: string): void {
    const board = boardOf(fen);
    if (board) this.positions.set(positionKey(fen), board.fen());
  }

  /** A position the player is about to move in (request fen / attemptFen). */
  addFocus(fen: string): void {
    this.addPosition(fen);
    if (boardOf(fen)) this.focus.add(positionKey(fen));
  }

  isFocus(fen: string): boolean {
    return this.focus.has(positionKey(fen));
  }

  /** Plays `uci` in `fen` and backs it there. Null when illegal. */
  addMove(fen: string, uci: string): MovePair | null {
    return this.addLine(fen, [uci])[0] ?? null;
  }

  /** Plays a UCI line from `fen`, backing each ply in the position it is played from. Stops at an illegal move. */
  addLine(fen: string, line: string[]): MovePair[] {
    return this.play(fen, line, this.backed);
  }

  /** A move of the game, backed for mentions of what was played (not for the focus position). */
  addHistoryMove(fen: string, uci: string): void {
    this.play(fen, [uci], this.history);
  }

  backsMove(fen: string, uci: string): boolean {
    return this.backed.has(`${positionKey(fen)}|${uci}`);
  }

  inHistory(fen: string, uci: string): boolean {
    return this.history.has(`${positionKey(fen)}|${uci}`);
  }

  positionList(): string[] {
    return [...this.positions.values()];
  }

  addScore(score: Score): void {
    if (score.kind === "mate") this.addMate(score.value);
    else this.addCp(score.value);
  }

  addCp(cp: number): void {
    if (Number.isFinite(cp)) this.cps.push(Math.abs(cp));
  }

  addMate(n: number): void {
    if (Number.isFinite(n)) this.mates.add(Math.abs(n));
  }

  /**
   * A quoted evaluation is backed when it is within EVAL_TOLERANCE_CP of a backed score in
   * absolute value (either side's point of view), or, for mate in N, when N matches exactly.
   */
  backsEval(quote: { cp: number } | { mate: number }): boolean {
    if ("mate" in quote) return this.mates.has(Math.abs(quote.mate));
    const q = Math.abs(quote.cp);
    return this.cps.some((s) => Math.abs(s - q) <= EVAL_TOLERANCE_CP + 1e-9);
  }

  private play(fen: string, line: string[], into: Set<string>): MovePair[] {
    const chess = boardOf(fen);
    if (!chess) return [];
    this.addPosition(chess.fen());
    const pairs: MovePair[] = [];
    for (const uci of line) {
      const from = chess.fen();
      const move = playUci(chess, uci);
      if (!move) break;
      const pair = { san: move.san, uci: uciOf(move) };
      pairs.push(pair);
      into.add(`${positionKey(from)}|${pair.uci}`);
      this.addPosition(chess.fen());
    }
    return pairs;
  }
}

/** 0.3 pawns: engine scores drift between depths, and the tutor rounds. */
export const EVAL_TOLERANCE_CP = 30;
