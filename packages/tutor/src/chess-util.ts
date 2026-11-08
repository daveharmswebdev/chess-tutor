import type { Color } from "@chess-tutor/chess-core";
import { Chess, type Move } from "chess.js";

/** A move in both notations, the shape every tool result and request uses. */
export interface MovePair {
  san: string;
  uci: string;
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export function isUci(move: string): boolean {
  return UCI_RE.test(move);
}

/** A chess.js board for `fen`, or null when the FEN is invalid. */
export function boardOf(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

export function uciOf(move: Move): string {
  return move.from + move.to + (move.promotion ?? "");
}

/** Plays a UCI move on `chess`; returns null (board unchanged) when illegal. */
export function playUci(chess: Chess, uci: string): Move | null {
  if (!isUci(uci)) return null;
  try {
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length === 5 ? { promotion: uci[4] } : {}) });
    if (uciOf(move) !== uci) {
      chess.undo(); // chess.js ignores a promotion letter on a non-promotion
      return null;
    }
    return move;
  } catch {
    return null;
  }
}

/** Plays a SAN move (lenient: extra check marks, 0-0, missing "=") on `chess`; null when illegal. */
export function playSan(chess: Chess, san: string): Move | null {
  try {
    return chess.move(normalizeSan(san), { strict: false });
  } catch {
    return null;
  }
}

/** Resolves a move written as UCI or SAN in `fen`, without changing anything. */
export function parseMove(fen: string, move: string): MovePair | null {
  const chess = boardOf(fen);
  if (!chess) return null;
  const played = (isUci(move) ? playUci(chess, move) : null) ?? playSan(chess, move);
  return played ? { san: played.san, uci: uciOf(played) } : null;
}

/** SAN without check marks or annotations, castling with letters, promotion with "=". */
export function normalizeSan(san: string): string {
  let s = san.trim().replace(/[+#!?]+$/, "");
  if (/^0-0(-0)?$/.test(s)) s = s.replace(/0/g, "O");
  s = s.replace(/^([a-h](?:x[a-h])?[18])([QRBN])$/, "$1=$2");
  return s;
}

export function sideToMove(fen: string): Color {
  return fen.split(" ")[1] === "b" ? "b" : "w";
}

export function colorName(color: Color): "white" | "black" {
  return color === "w" ? "white" : "black";
}

/** FENs equal as positions: placement, side, castling, en passant (clocks ignored). */
export function samePosition(a: string, b: string): boolean {
  return a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");
}

/** Every position of a UCI history from the start: index i is the position after i moves. Stops at an illegal move. */
export function historyPositions(history: string[]): { fens: string[]; moves: MovePair[] } {
  const chess = new Chess();
  const fens = [chess.fen()];
  const moves: MovePair[] = [];
  for (const uci of history) {
    const move = playUci(chess, uci);
    if (!move) break;
    moves.push({ san: move.san, uci });
    fens.push(chess.fen());
  }
  return { fens, moves };
}
