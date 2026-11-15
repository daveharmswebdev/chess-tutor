// Captured pieces and the material count, from a FEN alone (#42, FR-20, FR-4). This is a plain
// piece count (pawn 1, knight/bishop 3, rook 5, queen 9), never an engine evaluation (FR-10).
import type { Color } from "@chess-tutor/chess-core";

export type CapturablePiece = "p" | "n" | "b" | "r" | "q";

/** Display order: pawn, knight, bishop, rook, queen. */
export const PIECE_ORDER: readonly CapturablePiece[] = ["p", "n", "b", "r", "q"];

const VALUE: Record<CapturablePiece, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START_COUNT: Record<CapturablePiece, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };

export interface SideMaterial {
  /** The opponent's pieces this side has captured, grouped by type, in PIECE_ORDER. */
  captured: Array<{ type: CapturablePiece; count: number }>;
  /** Sum of this side's piece values on the board (a promoted pawn counts as its new piece). */
  points: number;
  /** points minus the opponent's points when ahead, otherwise 0. */
  lead: number;
}

export type Material = Record<Color, SideMaterial>;

type Counts = Record<CapturablePiece, number>;

function countPieces(fen: string): Record<Color, Counts> {
  const counts: Record<Color, Counts> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };
  const placement = fen.split(" ")[0] ?? "";
  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (!(lower in VALUE)) continue;
    counts[ch === lower ? "b" : "w"][lower as CapturablePiece] += 1;
  }
  return counts;
}

/** The pieces a colour has lost: its starting set minus what is on the board, a promoted piece
 * (beyond its starting count) standing in for the pawn it came from. */
function lost(own: Counts): Counts {
  let promoted = 0;
  const out: Counts = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const t of PIECE_ORDER) {
    if (t === "p") continue;
    promoted += Math.max(0, own[t] - START_COUNT[t]);
    out[t] = Math.max(0, START_COUNT[t] - own[t]);
  }
  out.p = Math.max(0, START_COUNT.p - own.p - promoted);
  return out;
}

function points(own: Counts): number {
  return PIECE_ORDER.reduce((sum, t) => sum + own[t] * VALUE[t], 0);
}

export function materialFromFen(fen: string): Material {
  const counts = countPieces(fen);
  const side = (me: Color, them: Color): SideMaterial => {
    const theirLosses = lost(counts[them]);
    const mine = points(counts[me]);
    const theirs = points(counts[them]);
    return {
      captured: PIECE_ORDER.filter((t) => theirLosses[t] > 0).map((t) => ({ type: t, count: theirLosses[t] })),
      points: mine,
      lead: Math.max(0, mine - theirs),
    };
  };
  return { w: side("w", "b"), b: side("b", "w") };
}
