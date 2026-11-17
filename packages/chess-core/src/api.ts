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
 *        While the game stays in that bot-failed state (playing, botThinking false, the bot's turn),
 *        every later "state" (e.g. after a try is graded) is followed by the same "error" again (#53).
 *   Ordering (#23): an HTTP reply can arrive after SSE events caused by the same request (a bot
 *        that fails or answers within microtasks). SSE is the newer source: once a client has
 *        received any SSE event for the game after it sent a request, it keeps its SSE-derived
 *        game state and ignores the GameView in that request's HTTP reply.
 *        Every request that changes a game is followed by SSE (state, bot_move, error or game_over;
 *        resign sends game_over), so a client that ignores a reply still catches up.
 *
 * Finished and abandoned games are saved as PGN (FR-5). The bot replies within 2 s (NFR-3).
 *
 * Game survival (#47: NFR-14, FR-5, IR-7, NFR-9). A game outlives a server restart and a page refresh.
 *   Saving: every change to a game (a move by either side, a takeback, a tutor reply, reveal or
 *        attempt, the end of the game) is written to SQLite before the HTTP reply or SSE event that
 *        announces it. A restart therefore loses at most a request that was never acknowledged.
 *   Restart: on startup the server loads every game still "playing" and serves it as before; it no
 *        longer abandons live games on shutdown. If the bot was due to move, it is asked again; if
 *        the tutor was mid-reply (tutor.thinking), the ask is started again from the saved request,
 *        with the usual SSE ("tutor_thinking", then "tutor_reply" or "tutor_failed").
 *   GET /api/games/:id returns the GameView of any saved game (playing, finished or abandoned), from
 *        memory or the database; 404 only when no game with that id was ever created.
 *   Web address: a game lives at /games/<id> (the SPA fallback serves it). Opening or refreshing that
 *        address rebuilds the page from GET /api/games/:id plus the SSE stream; "/" starts or offers a
 *        new game. The browser keeps no copy of the moves.
 *   Unreachable server: a network error, a 5xx or a dropped event stream is not "game not found".
 *        The web shows "Reconnecting…" and retries with backoff (GET, then a new EventSource); only a
 *        404 from GET /api/games/:id offers a new game.
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
 * on the server until "Show me", a wrong try, or the question closing as a note (architecture §3.5).
 *
 * Tutor notes (#53: FR-25, FR-8 as amended by A6, FR-5, NFR-14, FR-10). When a question closes because
 * the position it was about is left, it becomes a TutorNote in GameView.notes:
 *   Created: on the player's move that leaves the question's attemptFen (a graded try, or a move from
 *        another position after the player moved on), and at the end of the game (finished, resigned
 *        or abandoned) for a question still open or shown. Never while its position is still on the
 *        board: until then its reveal and best move stay on the server (FR-8).
 *   Replaced: a new tutor ask (e.g. Hint after a player_blunder takeback) that replaces a question whose
 *        attemptFen is the current position does not release it. The server keeps it as a pending note
 *        (saved, not in GameView) and releases it, attempt null, by the same rules: the move that leaves
 *        that position, or the end of the game. A takeback past its position drops it.
 *   Content: the question text, the reveal text and the engine's best move for the note's position
 *        (released now even if never asked for), and the graded try if there was one.
 *   Takebacks: a takeback removes every note with ply >= the new moves.length (the move it sat on
 *        is gone); it does not reopen the question. A takeback back to attemptFen before the question closed
 *        keeps the open question as before (the player_blunder retry). A question shown by "Show me"
 *        (TutorStatus.question with reveal set) also survives a takeback that lands exactly on its
 *        attemptFen, and becomes a note when that position is left; any other takeback drops it.
 *   Grading in flight: an acknowledged try whose grading has not finished is saved with the game and
 *        graded again after a restart (NFR-14), so its note is not lost. A note's bestMove is filled in
 *        if the engine's analysis arrives after the note was made.
 *   Saving: notes are saved with the game before the reply or event that carries them (NFR-14), come
 *        back after a restart, and are written into the saved PGN as `{...}` comments after the move
 *        they sit on (FR-5). They reach the client only inside GameView ("state", the HTTP replies,
 *        "bot_move", "game_over"); there is no separate event.
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
  /**
   * Closed tutor questions kept on the move they were about, in the order they closed (#53, FR-25).
   * The server always sends it from #53 on (optional only for older servers).
   */
  notes?: TutorNote[];
}

/** A closed tutor question, kept on a move (#53, FR-25). Shown in the move list (#54). */
export interface TutorNote {
  questionId: string;
  kind: TutorKind;
  /**
   * Moves played before the note's position (the question's attemptFen): the note sits on
   * moves[ply], the move played from that position. ply === moves.length only when no move was
   * played from it yet (the game ended there, or a new ask replaced it); then it sits after the last move.
   */
  ply: number;
  /** The question as it was shown (TutorQuestion.message). */
  message: string;
  /** The full answer, or null when the tutor gave none beyond the question. */
  reveal: string | null;
  /**
   * The engine's best move in the note's position, from the analysis used for grading (Stockfish,
   * checked legal; FR-10), or null when the engine had no evaluation. Never from the model.
   */
  bestMove: MoveView | null;
  /** The graded try (same values as "tutor_attempt"), or null when the move was not a try. */
  attempt: { move: MoveView; correct: boolean; cpLoss: number } | null;
}

export interface TutorStatus {
  /** False when coaching is off for this game; the game itself still works (NFR-9). */
  available: boolean;
  /** Plain-language reason when not available, e.g. "Coaching is off: no API key is set." */
  reason: string | null;
  /** True while the tutor is working on a key moment or a hint. */
  thinking: boolean;
  /**
   * The open question, or the one whose reveal was just shown (then `reveal` is set and the question
   * is closed: "Show me" is 409 and the next move is not graded as an attempt). A shown question
   * stays here until the next player move, a takeback (except one landing on its attemptFen, #53),
   * a new tutor ask or the end of the game (#47).
   */
  question: TutorQuestion | null;
  /**
   * The reveal already shown for `question` ("Show me" or a wrong try), so a refreshed page can show it
   * again (#47). Null while the reveal is still held on the server or nothing was shown; the server
   * always sends it from #47 on (optional only for older servers).
   */
  reveal?: TutorReveal | null;
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

/**
 * GET /ops/daily-stats?date=YYYY-MM-DD (FR-29, #60). A contract with the chess-tutor-dashboard
 * repo: bump `version` on any breaking change (removed or renamed field, changed meaning).
 *
 * - Auth: header `authorization: Bearer <OPS_STATS_TOKEN>` (IR-10). OPS_STATS_TOKEN unset or blank:
 *   the route is off and answers 404. Missing or wrong token: 401. Compare in constant time.
 * - `date` is a UTC day; omitted means yesterday (UTC). Malformed or in the future: 400.
 * - Counts only (NFR-15): no game ids, no PGN/FEN, no chat or tutor text, no log lines.
 * - Comes from SQLite (IR-7), so it survives restarts and redeploys: games started from the games
 *   table (created_at, source); everything else from the stored usage ledger (one row per tutor
 *   ask and per bot failure: when, game source, kind, ok/failure category, ms, token usage, model).
 */
export interface DailyStats {
  version: 1;
  /** The UTC day counted, YYYY-MM-DD. */
  date: string;
  /** ISO timestamp when this answer was computed. */
  generatedAt: string;
  /** Real use (games with source "player"). */
  player: UsageCounts;
  /** The daily demo's games (source "demo", FR-28), kept apart from real use. */
  demo: UsageCounts;
}

export interface UsageCounts {
  gamesStarted: number;
  /**
   * Tutor asks (key moments and hints) that ended with a validated reply, including one the
   * page never showed because the player moved on first (it was produced and paid for).
   */
  tutorReplies: number;
  /** Latency of those replies in ms (nearest-rank percentiles); null when there were none. */
  tutorLatencyMs: { p50: number | null; p95: number | null };
  /**
   * Failures by category, zero counts left out. Keys: the tutor failure reasons
   * ("invalid_reply", "unsupported_claim", "tool_rounds_exceeded", "refusal", "max_tokens",
   * "rate_limited", "api_unavailable", ...) and "bot_failed" (the bot could not choose a move).
   * An ask the server cancelled itself (the player moved on, the question was replaced, the game
   * ended, shutdown) is not an error: it is stored with reason "cancelled", left out of `errors`,
   * and its tokens still count in `claude`.
   */
  errors: Record<string, number>;
  /** Summed over every Claude request that day, failed asks included (NFR-5). */
  claude: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    /** Priced from config/models.json pricingPerMTok for the model that served each ask; USD, 4 decimals. */
    spendUsd: number;
  };
}
