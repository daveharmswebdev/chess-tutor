// Client-side legality from GameView.fen, used only to decide which clicks/drops to send and
// which targets to highlight. The server stays the authority on every move (FR-10).
import type { Color } from "@chess-tutor/chess-core";
import { Chess, type Move, type Square } from "chess.js";

const SQUARE = /^[a-h][1-8]$/;

function load(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

function movesFrom(fen: string, from: string): Move[] {
  if (!SQUARE.test(from)) return [];
  const chess = load(fen);
  if (!chess) return [];
  return chess.moves({ square: from as Square, verbose: true });
}

/** Legal destination squares for the piece on `from` (side to move only), sorted. */
export function legalTargets(fen: string, from: string): string[] {
  return [...new Set(movesFrom(fen, from).map((m) => m.to as string))].sort();
}

/** UCI for a legal from/to pair, or null if illegal. Promotions become queens. */
export function moveToUci(fen: string, from: string, to: string): string | null {
  const candidates = movesFrom(fen, from).filter((m) => m.to === to);
  if (candidates.length === 0) return null;
  const move = candidates.find((m) => !m.promotion || m.promotion === "q") ?? candidates[0]!;
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

/** FEN after playing `uci`, or null if the move is illegal in `fen`. */
export function fenAfter(fen: string, uci: string): string | null {
  const chess = load(fen);
  if (!chess) return null;
  try {
    const promotion = uci.slice(4, 5);
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(promotion ? { promotion } : {}) });
    return chess.fen();
  } catch {
    return null;
  }
}

/** True if `square` holds a piece of `color`. */
export function isOwnPiece(fen: string, square: string, color: Color): boolean {
  if (!SQUARE.test(square)) return false;
  const piece = load(fen)?.get(square as Square);
  return piece !== undefined && piece !== null && piece.color === color;
}

/** Side to move in a FEN. */
export function sideToMove(fen: string): Color {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}
