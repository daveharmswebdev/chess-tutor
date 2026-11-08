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
 *   Ordering (#23): an HTTP reply can arrive after SSE events caused by the same request (a bot
 *        that fails or answers within microtasks). SSE is the newer source: once a client has
 *        received any SSE event for the game after it sent a request, it keeps its SSE-derived
 *        game state and ignores the GameView in that request's HTTP reply.
 *        Every request that changes a game is followed by SSE (state, bot_move, error or game_over;
 *        resign sends game_over), so a client that ignores a reply still catches up.
 *
 * Finished and abandoned games are saved as PGN (FR-5). The bot replies within 2 s (NFR-3).
 *
 * Tutor (#7: FR-7 to FR-12, NFR-1, NFR-8, NFR-9). The server runs the key-moment detector after
 * every move (the player's and the bot's), and calls the tutor only at a key moment or on Hint.
 * At most one tutor question is open per game; a new key moment or Hint replaces it.
 *   POST /api/games/:id/tutor/hint  -> 202 {} ; the reply arrives over SSE (FR-12).
 *        409 while the tutor is already working, when the game is not "playing", or when it is
 *        not the player's turn; 503 when the tutor is unavailable (TutorStatus.available false).
 *   POST /api/games/:id/tutor/reveal -> 200 TutorReveal for the open question ("Show me"), with
 *        no Claude call; 409 when there is no open question. Also sent as "tutor_reveal" over SSE.
 *   Trying again: while a question is open, the player's next move played from the question's
 *        attemptFen (after a takeback, for the player's own mistakes) is graded by the engine,
 *        not by Claude: correct when its centipawn loss against the best move is at most
 *        config tutor.attemptToleranceCp. The server sends "tutor_attempt", and on a wrong try
 *        also "tutor_reveal". Either way the question then closes.
 *   SSE order at a key moment: "tutor_thinking" within 200 ms of detection, then any number of
 *        "tutor_progress" (the first within 1 s), then exactly one of "tutor_reply" or
 *        "tutor_failed". The game never waits for the tutor: the bot replies as usual.
 *   GameView.tutor tells the client whether coaching is available and why not (NFR-9), e.g. no
 *        ANTHROPIC_API_KEY, or the API is down. The first "state" on every connection carries it.
 * Only `message` and `arrows` reach the browser before a reveal; the reveal text and move stay
 * on the server until "Show me" or a wrong try (architecture §3.5).
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
  tutor: TutorStatus;
}

export interface TutorStatus {
  /** False when coaching is off for this game; the game itself still works (NFR-9). */
  available: boolean;
  /** Plain-language reason when not available, e.g. "Coaching is off: no API key is set." */
  reason: string | null;
  /** True while the tutor is working on a key moment or a hint. */
  thinking: boolean;
  /** The open question, if any. */
  question: TutorQuestion | null;
}

export type TutorKind = "opponent_left_book" | "player_blunder" | "missed_win" | "punish_opponent" | "hint";

export interface TutorArrow {
  /** Squares, e.g. "e2", "e4". */
  from: string;
  to: string;
}

/** What the browser sees of a tutor reply before any reveal (FR-8, FR-11). */
export interface TutorQuestion {
  id: string;
  kind: TutorKind;
  /** The Socratic question or explanation shown now. */
  message: string;
  /** At most 3. */
  arrows: TutorArrow[];
  /** FEN where the player's next move counts as an attempt at this question. */
  attemptFen: string;
  /** True when a reveal is held on the server ("Show me" is enabled). */
  canReveal: boolean;
}

export interface TutorReveal {
  questionId: string;
  /** The full answer. */
  text: string;
  /** The answer move, checked legal in attemptFen, or null. */
  move: MoveView | null;
  arrows: TutorArrow[];
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
  | { type: "error"; message: string }
  | { type: "tutor_thinking"; kind: TutorKind }
  /** e.g. "Tutor is looking at the position…", "Checking Nf3…" (from tool calls). */
  | { type: "tutor_progress"; label: string }
  | { type: "tutor_reply"; question: TutorQuestion }
  /** NFR-8 failure path ended, or the API failed: show `message`, never unvalidated output. */
  | { type: "tutor_failed"; message: string }
  | { type: "tutor_reveal"; reveal: TutorReveal }
  | { type: "tutor_attempt"; questionId: string; move: MoveView; correct: boolean; cpLoss: number };

export interface ApiError {
  error: string;
}
