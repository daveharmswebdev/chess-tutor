import { Chess, type Move } from "chess.js";

/**
 * Plays a UCI move on `chess` and returns the chess.js move (with SAN).
 * Throws an Error naming the move and position when it is not legal.
 */
export function playUci(chess: Chess, uci: string): Move {
  const fen = chess.fen();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    throw new Error(`illegal move "${uci}": not UCI notation (position ${fen})`);
  }
  try {
    return chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci.length === 5 ? { promotion: uci.slice(4) } : {}),
    });
  } catch {
    throw new Error(`illegal move "${uci}" in position ${fen}`);
  }
}

/** SAN of a UCI move in the given position, without changing anything. */
export function sanOf(fen: string, uci: string): string {
  return playUci(new Chess(fen), uci).san;
}

export function toUci(move: Move): string {
  return move.from + move.to + (move.promotion ?? "");
}
