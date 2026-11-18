import { Chess, type Square } from "chess.js";
import type { Color, ExchangeCapture, ExchangePiece, ExchangeResult, PieceType } from "./types.ts";

/**
 * Static exchange on one square (#44: FR-21, FR-10, FR-23). Pure and deterministic: no engine.
 *
 * Out of scope: en passant (a pawn that could take en passant is not counted, because the
 * captured pawn is not on the square itself), pins, checks, mates and threats elsewhere.
 */

const VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** Capture order: cheapest first, king last. Knight before bishop at equal value. */
const ORDER: Record<PieceType, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const PROMOTION_GAIN = VALUE.q - VALUE.p;

export const EXCHANGE_CAVEAT =
  "This is only a count of the captures on this one square. It does not look at pins, checks, " +
  "mates or threats elsewhere on the board, so a capture that wins here can still be a mistake. " +
  "Check the move with the engine before trusting it.";

const other = (c: Color): Color => (c === "w" ? "b" : "w");

function byCaptureOrder(a: ExchangePiece, b: ExchangePiece): number {
  return ORDER[a.piece] - ORDER[b.piece] || (a.square < b.square ? -1 : a.square > b.square ? 1 : 0);
}

/**
 * The pieces of `color` that bear on `square`, in capture order. Each step takes the cheapest
 * piece that attacks now, then lifts it off the board so a friendly piece behind it is found
 * (an x-ray). Enemy pieces are never lifted, so an x-ray through an enemy piece does not count.
 */
function bearing(fen: string, square: Square, color: Color): ExchangePiece[] {
  const board = new Chess(fen);
  const direct = new Set(board.attackers(square, color));
  const out: ExchangePiece[] = [];
  for (;;) {
    const now: ExchangePiece[] = board.attackers(square, color).map((sq) => {
      const p = board.get(sq)!;
      return { square: sq, piece: p.type, color, value: VALUE[p.type], xray: !direct.has(sq) };
    });
    if (now.length === 0) return out;
    now.sort(byCaptureOrder);
    const next = now[0]!;
    out.push(next);
    board.remove(next.square as Square);
  }
}

export function exchangeOnSquare(fen: string, square: string): ExchangeResult {
  if (!/^[a-h][1-8]$/.test(square)) {
    throw new Error(`invalid square "${square}": expected a file a-h and a rank 1-8, e.g. "e4"`);
  }
  let board: Chess;
  try {
    board = new Chess(fen);
  } catch (err) {
    throw new Error(`invalid FEN "${fen}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const sq = square as Square;
  const fenNorm = board.fen();
  const on = board.get(sq);
  const occupant = on ? { piece: on.type, color: on.color } : null;
  const attackingSide: Color = occupant ? other(occupant.color) : board.turn();
  const attackerToMove = board.turn() === attackingSide;

  const attackers = bearing(fenNorm, sq, attackingSide);
  const defenders = bearing(fenNorm, sq, other(attackingSide));

  const sequence: ExchangeCapture[] = [];
  // Nothing to capture on an empty square, and a king is never captured.
  if (occupant && occupant.piece !== "k") {
    const lists: Record<Color, ExchangePiece[]> = {
      [attackingSide]: attackers,
      [other(attackingSide)]: defenders,
    } as Record<Color, ExchangePiece[]>;
    const used: Record<Color, number> = { w: 0, b: 0 };
    const lastRank = square[1] === "8" ? "w" : square[1] === "1" ? "b" : null;
    let onSquare: PieceType = occupant.piece;
    let side = attackingSide;
    // The real board as the exchange goes on: each capturing piece leaves its square.
    const real = new Chess(fenNorm);
    for (let n = 1; ; n++) {
      const by = lists[side][used[side]];
      if (!by) break;
      if (by.piece === "k") {
        // The king captures only when the other side then no longer attacks the square.
        real.remove(by.square as Square);
        const stillAttacked = real.attackers(sq, other(side)).length > 0;
        real.put({ type: "k", color: side }, by.square as Square);
        if (stillAttacked) break;
      }
      const promotion = by.piece === "p" && lastRank === side;
      sequence.push({ n, by, captured: onSquare, promotion });
      real.remove(by.square as Square);
      used[side]++;
      onSquare = promotion ? "q" : by.piece;
      side = other(side);
    }
  }

  // Material won by each capture, for the side making it.
  const gains = sequence.map((c) => VALUE[c.captured] + (c.promotion ? PROMOTION_GAIN : 0));
  const fullResult = gains.reduce((sum, g, i) => sum + (i % 2 === 0 ? g : -g), 0);
  // best[i]: what the side making capture i nets from here on if it may stop (0) or capture.
  const best = new Array<number>(gains.length + 1).fill(0);
  for (let i = gains.length - 1; i >= 0; i--) best[i] = Math.max(0, gains[i]! - best[i + 1]!);
  // Follow the choices; on an even outcome the side stops (capturing gains nothing).
  let bestLength = 0;
  while (bestLength < gains.length && gains[bestLength]! - best[bestLength + 1]! > 0) bestLength++;

  return {
    square,
    occupant,
    attackingSide,
    attackerToMove,
    attackers,
    defenders,
    sequence,
    fullResult,
    result: best[0]!,
    bestLength,
    caveat: EXCHANGE_CAVEAT,
  };
}
