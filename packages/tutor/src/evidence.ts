import type { Color, ExchangeResult, Score } from "@chess-tutor/chess-core";
import { boardOf, playUci, uciOf, type MovePair } from "./chess-util.ts";
import type { EvalEntry } from "./schema.ts";

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
 * - plan moves (#41): (position, UCI) pairs of the repertoire's usual setup after the game left
 *   book. They back a plan mention, never a move to play now and never revealMove.
 * - history moves: (position, UCI) pairs of the game so far. They let the tutor mention a
 *   move already played, but never back a move in the current (focus) position.
 * - scores (#26): engine scores from tool results, signed and White-relative as the engine
 *   gives them (centipawns, or mate in N with positive = White mates). They back the reply's
 *   `evals` entries, exactly.
 * - deltas: centipawn changes, not standings (evaluate_move's cp_loss, the key moment's cpLoss
 *   and gainCp). They never back an evals entry or a signed number; an unsigned size quoted in
 *   prose may match one (FR-10 A2, "That cost you 1.6 pawns").
 * - exchanges (#44): exchange_on_square results, keyed by position and square. They back a
 *   count of attackers or defenders on that square and the exchange's outcome there
 *   (exchange-claims.ts), never a move: the capture sequence is not move evidence.
 */
export class Evidence {
  private readonly positions = new Map<string, string>(); // key -> full FEN
  private readonly focus = new Set<string>();
  private readonly backed = new Set<string>();
  private readonly plan = new Set<string>();
  private readonly history = new Set<string>();
  private readonly historyPlies: { fen: string; uci: string }[] = [];
  private readonly cps = new Set<number>();
  private readonly mates = new Set<number>();
  private readonly deltas = new Set<number>();
  private readonly exchanges = new Map<string, ExchangeResult>(); // positionKey|square -> result

  /** An exchange_on_square result (#44) for `fen` and its square. The same position and square keep one result. */
  addExchange(fen: string, result: ExchangeResult): void {
    this.addPosition(fen);
    this.exchanges.set(`${positionKey(fen)}|${result.square}`, result);
  }

  /** This turn's exchange_on_square results for `square`, in any position. */
  exchangesOn(square: string): ExchangeResult[] {
    return [...this.exchanges.values()].filter((r) => r.square === square);
  }

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
    const pair = this.play(fen, [uci], this.history)[0];
    if (pair) this.historyPlies.push({ fen: boardOf(fen)!.fen(), uci: pair.uci });
  }

  /**
   * The game's move at move number `moveNumber` for `color` ("3.Bf4" is 3 / w, "3...Bg7" is
   * 3 / b), read from the move counters of the history positions. Null when there is none.
   */
  historyPly(moveNumber: number, color: Color): { fen: string; uci: string } | null {
    return (
      this.historyPlies.find((p) => {
        const parts = p.fen.split(" ");
        return parts[1] === color && Number(parts[5]) === moveNumber;
      }) ?? null
    );
  }

  /**
   * A plan move (#41, review 096): get_repertoire_context's usual_setup, the repertoire's moves,
   * not engine-checked. Plays `uci` in `fen` and records it as plan evidence there. It never backs
   * a move (backsMove): a move mention may use it outside a "now" clause (checkClaims), but
   * revealMove may not. Null when illegal.
   */
  addPlanMove(fen: string, uci: string): MovePair | null {
    return this.play(fen, [uci], this.plan)[0] ?? null;
  }

  backsMove(fen: string, uci: string): boolean {
    return this.backed.has(`${positionKey(fen)}|${uci}`);
  }

  backsPlan(fen: string, uci: string): boolean {
    return this.plan.has(`${positionKey(fen)}|${uci}`);
  }

  inHistory(fen: string, uci: string): boolean {
    return this.history.has(`${positionKey(fen)}|${uci}`);
  }

  positionList(): string[] {
    return [...this.positions.values()];
  }

  /** An engine score, White-relative as the engine gives it (chess-core Score). */
  addScore(score: Score): void {
    if (!Number.isFinite(score.value)) return;
    (score.kind === "mate" ? this.mates : this.cps).add(score.value + 0); // + 0 turns -0 into 0
  }

  /** A centipawn change (a move's loss or gain), not a standing: it backs no evals entry (see backsChange). */
  addDelta(cp: number): void {
    if (Number.isFinite(cp)) this.deltas.add(Math.abs(cp));
  }

  isDelta(cp: number): boolean {
    return this.deltas.has(Math.abs(cp));
  }

  /** Whether an unsigned size quoted in prose is a change of this turn, within `tolerance` (FR-10 A2). */
  backsChange(cp: number, tolerance: number): boolean {
    return [...this.deltas].some((d) => Math.abs(d - Math.abs(cp)) <= tolerance + 1e-9);
  }

  /**
   * An `evals` entry is backed when, converted to White's point of view, it is exactly an engine
   * score of the same kind from this turn (#26): {black, cp 150} needs a score of -150, and
   * {black, mate 3} needs mate -3 (Black mates in 3). No tolerance: the tutor copies the number.
   */
  backsEntry(entry: EvalEntry): boolean {
    const sign = entry.side === "white" ? 1 : -1;
    if (entry.cp !== null) return this.cps.has(sign * entry.cp + 0);
    if (entry.mate !== null) return this.mates.has(sign * entry.mate + 0);
    return false;
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
