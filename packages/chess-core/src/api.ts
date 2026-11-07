import type { Color } from "./types.ts";

/**
 * HTTP + SSE contract between apps/server and apps/web (#6: FR-1, FR-4, FR-5, IR-5).
 * Coordinator-owned: change it only on main, before the spokes that depend on it.
 *
 * Endpoints (JSON bodies, all under /api; errors are `ApiError` with the status shown):
 *   POST /api/games                 NewGameRequest -> 201 GameView
 *        If the player is Black, botThinking is true and the bot's first move arrives over SSE.
 *        Creating a game while another is still "playing" marks the old one "abandoned" (and saves it).
 *   GET  /api/games/:id             -> 200 GameView | 404
 *   POST /api/games/:id/moves       PlayMoveRequest -> 200 GameView with the player's move applied
 *        (botThinking true unless the game just ended). 400 illegal or malformed move;
 *        409 not the player's turn, bot thinking, or game not "playing"; 404 unknown game.
 *   POST /api/games/:id/takeback    -> 200 GameView, back at the player's previous turn
 *        (removes the bot's reply, if any, and the player's last move). 409 while the bot is
 *        thinking, when the game is not "playing", or when the player has no move to undo.
 *   POST /api/games/:id/bot-retry   -> 200 GameView with botThinking true; the bot's move then
 *        arrives over SSE as usual (#23). For recovering after a bot failure: 409 while the bot is
 *        thinking, when the game is not "playing", or when it is the player's turn; 404 unknown game.
 *        The web shows a "Retry bot move" action whenever the game is "playing", botThinking is
 *        false and it is the bot's turn (that state only arises after a bot failure).
 *   POST /api/games/:id/resign      -> 200 GameView, status "finished", endReason "resigned".
 *   GET  /api/games/:id/events      -> text/event-stream. Each message is `event: <GameEvent.type>`
 *        plus `data: <GameEvent as JSON>`. The first message on every connection is "state".
 *        The server also sends "state" after each player move and takeback, and "game_over" to an
 *        abandoned game's subscribers. When the bot fails, the server sends "state" (botThinking
 *        false) immediately before "error", so a client that clears its error on "state" still shows it.
 *
 * Finished and abandoned games are saved as PGN (FR-5). The bot replies within 2 s (NFR-3).
 */

export type GameStatus = "playing" | "finished" | "abandoned";
export type GameResult = "1-0" | "0-1" | "1/2-1/2" | "*";
export type GameEndReason =
  | "checkmate"
  | "stalemate"
  | "threefold_repetition"
  | "insufficient_material"
  | "fifty_moves"
  | "resigned"
  | "abandoned";

export interface MoveView {
  uci: string;
  san: string;
  by: "player" | "bot";
}

export interface GameView {
  id: string;
  playerColor: Color;
  /** FEN of the current position. */
  fen: string;
  /** Every move from the start position, in order. */
  moves: MoveView[];
  status: GameStatus;
  /** "*" while playing or when abandoned. */
  result: GameResult;
  endReason: GameEndReason | null;
  /** True while the server is choosing the bot's reply; the board accepts no player move then. */
  botThinking: boolean;
}

export interface NewGameRequest {
  playerColor: Color;
}

export interface PlayMoveRequest {
  /** UCI, e.g. "e2e4", "e7e8q"; castling as king two squares ("e1g1"). */
  uci: string;
}

export type GameEvent =
  | { type: "state"; game: GameView }
  | { type: "bot_move"; move: MoveView; game: GameView }
  | { type: "game_over"; game: GameView }
  | { type: "error"; message: string };

export interface ApiError {
  error: string;
}
