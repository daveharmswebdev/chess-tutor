import type { Chess } from "chess.js";
import type { GameEndReason, GameResult } from "@chess-tutor/chess-core";

export interface Outcome {
  result: Exclude<GameResult, "*">;
  endReason: Extract<
    GameEndReason,
    "checkmate" | "stalemate" | "threefold_repetition" | "insufficient_material" | "fifty_moves"
  >;
}

/** How the position ends the game by rule (FR-4), or null if play goes on. chess.js decides. */
export function outcomeOf(chess: Chess): Outcome | null {
  if (chess.isCheckmate()) {
    // The side to move is mated.
    return { result: chess.turn() === "w" ? "0-1" : "1-0", endReason: "checkmate" };
  }
  if (chess.isStalemate()) return { result: "1/2-1/2", endReason: "stalemate" };
  if (chess.isInsufficientMaterial()) return { result: "1/2-1/2", endReason: "insufficient_material" };
  if (chess.isThreefoldRepetition()) return { result: "1/2-1/2", endReason: "threefold_repetition" };
  if (chess.isDrawByFiftyMoves()) return { result: "1/2-1/2", endReason: "fifty_moves" };
  return null;
}
