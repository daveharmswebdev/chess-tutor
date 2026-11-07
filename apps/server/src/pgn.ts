import { Chess } from "chess.js";
import type { GameView } from "@chess-tutor/chess-core";

export const PLAYER_NAME = "Player";
export const BOT_NAME = "Sparring bot";

function pgnDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

/**
 * PGN of a game (FR-5): Seven Tag Roster plus Termination (the endReason).
 * Moves are replayed through chess.js, so the movetext is always legal.
 * Tutor comments (#7) will be added here as {...} comments after the moves they explain.
 */
export function toPgn(game: GameView, date: Date): string {
  const chess = new Chess();
  for (const m of game.moves) {
    chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), ...(m.uci.length === 5 ? { promotion: m.uci[4] } : {}) });
  }
  const playerWhite = game.playerColor === "w";
  chess.setHeader("Event", "Sparring game");
  chess.setHeader("Site", "Chess Tutor");
  chess.setHeader("Date", pgnDate(date));
  chess.setHeader("Round", "-");
  chess.setHeader("White", playerWhite ? PLAYER_NAME : BOT_NAME);
  chess.setHeader("Black", playerWhite ? BOT_NAME : PLAYER_NAME);
  chess.setHeader("Result", game.result);
  if (game.endReason !== null) chess.setHeader("Termination", game.endReason);
  return chess.pgn() + "\n";
}
