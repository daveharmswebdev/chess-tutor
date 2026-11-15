import { randomUUID } from "node:crypto";
import { Chess, type Move } from "chess.js";
import {
  detect,
  type Analysis,
  type Color,
  type GameEndReason,
  type GameEvent,
  type GameResult,
  type GameStatus,
  type GameView,
  type KeyMomentThresholds,
  type MoveView,
  type SparringBot,
  type TutorNote,
} from "@chess-tutor/chess-core";
import type { TutorEngine, TutorOutcome, TutorRequest, TutorSession } from "@chess-tutor/tutor";
import {
  AUTH_REASON,
  bestMoveOf,
  buildReveal,
  cleanArrows,
  failureMessage,
  moveLoss,
  NOT_CONFIGURED_REASON,
  samePosition,
  type CoachingDeps,
  type HeldQuestion,
  type TutorKind,
  type TutorQuestion,
  type TutorReveal,
  type TutorStatus,
} from "./coaching.ts";
import { loadAttemptToleranceCp, loadKeyMomentThresholds } from "./config.ts";
import { outcomeOf } from "./outcome.ts";
import { toPgn } from "./pgn.ts";
import type { GameStore, StoredGame } from "./store.ts";

/** An error with the HTTP status the contract gives it (400, 404, 409, 503). */
export class GameError extends Error {
  override name = "GameError";
  readonly statusCode: 400 | 404 | 409 | 503;
  constructor(statusCode: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** The pino-style subset of a logger the manager uses (Fastify's app.log fits). */
export interface GameLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const SILENT_LOG: GameLog = { info() {}, warn() {}, error() {} };

export type GameListener = (event: GameEvent) => void;

export interface GameManagerOptions {
  bot: SparringBot;
  store: GameStore;
  /** Key-moment detection and the tutor (#7). Without it, coaching is off and nothing is analysed. */
  coaching?: CoachingDeps;
  newId?: () => string;
  now?: () => Date;
  log?: GameLog;
}

export interface GameManager {
  /** Abandons (and saves) any game still playing, then starts a new one. */
  create(playerColor: Color): GameView;
  /**
   * Any game ever created: from memory, or rebuilt from the store (finished, abandoned).
   * Undefined only when the store has no such game; a store read error is thrown (a 500).
   */
  view(id: string): GameView | undefined;
  play(id: string, uci: string): GameView;
  takeback(id: string): GameView;
  /** Restarts the bot on the current position after a bot failure (#23). */
  botRetry(id: string): GameView;
  resign(id: string): GameView;
  /** Asks the tutor for a hint on the current position (FR-12); the reply arrives as events. */
  hint(id: string): void;
  /** "Show me": the held answer of the open question, with no Claude call. Closes the question. */
  reveal(id: string): TutorReveal;
  /**
   * Shutdown (#47): aborts tutor asks and stops saving, so the store keeps every game as it
   * was last acknowledged (still "playing", a pending ask still pending) for the next start.
   * Games are not abandoned. Bot moves and tutor replies that arrive later are dropped.
   */
  close(): void;
  /** Throws GameError 404 for an unknown game. Returns the unsubscribe function. */
  subscribe(id: string, listener: GameListener): () => void;
  /**
   * Resolves once the bot's current search and the server's own analysis work (key-moment
   * detection, attempt grading) for this game have been handled. Does not wait for the tutor.
   */
  idle(id: string): Promise<void>;
}

interface Game {
  id: string;
  playerColor: Color;
  chess: Chess;
  moves: MoveView[];
  /** Parallel to moves: a unique id per played move, so a detection for a taken-back move is dropped. */
  moveIds: number[];
  /** Parallel to moves: the FEN before each move (for the one-takeback reachability rule). */
  fensBefore: string[];
  status: GameStatus;
  result: GameResult;
  endReason: GameEndReason | null;
  botThinking: boolean;
  /** Bumped on every change, so a bot search for an older state is discarded. */
  version: number;
  pending: Promise<void> | null;
  createdAt: Date;
  listeners: Set<GameListener>;
  // Coaching (#7).
  /** Analyses by FEN, shared by detection and grading (the previous position is usually here). */
  analyses: Map<string, Promise<Analysis>>;
  /** Detections run one after another, in move order. */
  detecting: Promise<void>;
  /** Detection and grading in flight (for idle()). */
  work: Set<Promise<void>>;
  session: TutorSession | null;
  /** The tutor request in flight; a newer one replaces it (and aborts it). Saved, so a restart re-asks. */
  ask: { token: number; kind: TutorKind; attemptFen: string; request: TutorRequest; controller: AbortController } | null;
  /** At most one open question per game; the reveal stays here until "Show me" or a wrong try. */
  question: HeldQuestion | null;
  /**
   * The question whose reveal was shown by "Show me" while its position is still on the board,
   * kept for GameView.tutor (#47) until the next player move, takeback, tutor ask or the end of
   * the game. It is no longer open: no second "Show me", no grading. `source` (from #53) is the
   * held question, for its note. A wrong try does not set this: its question becomes a note.
   */
  shown: { question: TutorQuestion; reveal: TutorReveal; source?: HeldQuestion } | null;
  /** Closed questions kept on the move they were about, in the order they closed (#53, FR-25). */
  notes: TutorNote[];
  /** The last row written for this game (without updatedAt), so unchanged saves are skipped. */
  lastSaved: string | null;
  /**
   * Rebuilt from a damaged row (a saved move that is not legal): served read-only, never saved
   * and never resumed, so the row stays as it was for inspection (review 065).
   */
  readOnly: boolean;
  /** The engine wrapper this game's session uses for tool calls (NFR-3). */
  tutorEngine: TutorEngine | null;
}

const LESSON_KINDS: ReadonlySet<TutorKind> = new Set(["player_blunder", "missed_win"]);

function abortError(): Error {
  const err = new Error("the tutor ask was aborted");
  err.name = "AbortError";
  return err;
}

/** `p`, or a rejection with AbortError as soon as `signal` aborts. */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const MAX_CACHED_ANALYSES = 64;

function copyQuestion(q: TutorQuestion): TutorQuestion {
  return { ...q, arrows: q.arrows.map((a) => ({ ...a })) };
}

function copyReveal(r: TutorReveal): TutorReveal {
  return { ...r, move: r.move ? { ...r.move } : null, arrows: r.arrows.map((a) => ({ ...a })) };
}

function toUci(move: Move): string {
  return move.from + move.to + (move.promotion ?? "");
}

/** Plays a UCI move with chess.js as the authority, or returns null if it is not legal. */
function tryUci(chess: Chess, uci: string): Move | null {
  if (!UCI_RE.test(uci)) return null;
  let move: Move;
  try {
    move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci.length === 5 ? { promotion: uci[4] } : {}),
    });
  } catch {
    return null;
  }
  if (toUci(move) !== uci) {
    // chess.js ignores a promotion letter on a non-promoting move ("e2e4q"), and a
    // promotion without a letter would not be a full UCI move either.
    chess.undo();
    return null;
  }
  return move;
}

interface MovePlayed {
  fenBefore: string;
  fenAfter: string;
  uci: string;
  /** UCI moves before this one, from the start position. */
  history: string[];
  moveId: number;
}

/**
 * What the store's `state` column holds for a game (schema v2, #47: NFR-14). With the row's
 * own columns (colour, status, result, endReason, createdAt) it rebuilds the Game exactly:
 * the board is replayed from `moves` through chess.js (FR-10), the bot is asked again if it
 * is its turn, and a pending tutor ask is started again from `tutor.ask.request`. The held
 * reveal (and best move) is stored here too; it reaches the browser only once shown or once the
 * question becomes a note (architecture §3.5). `notes` (#53) is absent in older rows: loaded as [].
 */
interface LiveState {
  v: 1;
  moves: { uci: string; by: "player" | "bot" }[];
  /** Whether the bot was searching at the save (informational: on load the bot is asked whenever it is its turn). */
  botThinking: boolean;
  tutor: {
    ask: { kind: TutorKind; attemptFen: string; request: TutorRequest } | null;
    question: HeldQuestion | null;
    shown: { question: TutorQuestion; reveal: TutorReveal; source?: HeldQuestion } | null;
  };
  /** Tutor notes (#53). Absent in rows saved before #53: loaded as []. */
  notes?: TutorNote[];
}

function liveStateOf(g: Game): LiveState {
  return {
    v: 1,
    moves: g.moves.map((m) => ({ uci: m.uci, by: m.by })),
    botThinking: g.botThinking,
    tutor: {
      ask: g.ask ? { kind: g.ask.kind, attemptFen: g.ask.attemptFen, request: g.ask.request } : null,
      question: g.question,
      shown: g.shown,
    },
    notes: g.notes,
  };
}

function copyNote(n: TutorNote): TutorNote {
  return {
    ...n,
    bestMove: n.bestMove ? { ...n.bestMove } : null,
    attempt: n.attempt ? { ...n.attempt, move: { ...n.attempt.move } } : null,
  };
}

/** The saved notes that still sit on a move of the game (or after its last move). */
function savedNotes(state: LiveState | null, moves: number): TutorNote[] {
  const notes = state && Array.isArray(state.notes) ? state.notes : [];
  return notes.filter((n) => n && typeof n === "object" && Number.isInteger(n.ply) && n.ply >= 0 && n.ply <= moves).map(copyNote);
}

/** The saved state, or null for a schema v1 row (or one that cannot be read). */
function parseLiveState(row: StoredGame): LiveState | null {
  if (row.state === null) return null;
  try {
    const parsed = JSON.parse(row.state) as LiveState | null;
    return parsed && parsed.v === 1 && Array.isArray(parsed.moves) ? parsed : null;
  } catch {
    return null;
  }
}

/** The moves of a PGN (schema v1 rows), with `by` from the player's colour. */
function movesFromPgn(pgn: string, playerColor: Color): { uci: string; by: "player" | "bot" }[] {
  const chess = new Chess();
  chess.loadPgn(pgn);
  return chess.history({ verbose: true }).map((m) => ({ uci: toUci(m), by: m.color === playerColor ? "player" : "bot" }));
}

/**
 * Game state, the bot, and coaching (#6, #7).
 *
 * Coaching (FR-6 to FR-12, NFR-9): after every move (the player's and the bot's) the server
 * analyses the new position, keeps the previous one's analysis, and runs the key-moment
 * detector. Only a key moment or a Hint calls the tutor (FR-7).
 *
 * Shared engine (NFR-3): the bot, this analysis and the tutor's tool calls use one Stockfish
 * with a FIFO queue. The server's analysis waits until the bot's search in flight has settled.
 * Each session gets a per-game TutorEngine wrapper that submits at most one tutor search at a
 * time, waits for the game's bot search (pending or in flight) before each submission, and
 * rejects its waiting calls (AbortError) when the ask they belong to is aborted. So at most one
 * tutor search (<= movetimeCapMs) can be ahead of the bot.
 *
 * Questions: at most one per game, open or in flight. Reachability rule: a question (or an ask
 * in flight) may exist only while its attemptFen is the current position, or, for
 * player_blunder and missed_win, the position before the player's last move (one takeback
 * away). Any change of position that breaks this (a player move, a takeback past it) closes the
 * question or aborts the ask, and the next "state" shows thinking false. A key moment whose
 * attemptFen is already unreachable is not coached, and a reply that arrives for an
 * unreachable attemptFen, or after the game ended, is dropped (with a "state"). The end of a
 * game (resign, checkmate, draw, abandon) aborts the ask and closes the question.
 *
 * Priority: a Hint replaces anything. A key moment of the player's move replaces an older
 * question. A key moment of the bot's move (punish_opponent, opponent_left_book) is skipped
 * while a player_blunder or missed_win is in flight or open, so the player's own lesson is
 * kept (FR-7 still holds: one ask). A late reply for a replaced ask is dropped. The reply's
 * reveal and revealMove stay here until "Show me" or a wrong try (architecture §3.5).
 *
 * Attempts: the player's next move closes the open question. When it is played from the
 * question's attemptFen (directly for punish_opponent, opponent_left_book and hints; after a
 * takeback for player_blunder and missed_win), the engine grades it: correct when its loss
 * against the best move is at most attemptToleranceCp; "tutor_attempt" is sent, and on a wrong
 * try also "tutor_reveal", then a "state" carrying the try's note. A move from any other
 * position (the player moved on without taking back) closes the question with no grading. A
 * graded move is not itself coached again as a key moment (its reveal already explains it); the
 * bot's reply still is.
 *
 * Notes (#53: FR-25, FR-8, FR-10): a question that closes because its position is left becomes
 * a TutorNote on the move played from attemptFen: when the try is graded (attempt filled), when
 * the player moves on (attempt null; also for a question shown by "Show me"), at the end of the
 * game, and when a new ask replaces it. The note releases the held reveal and the engine's best
 * move for attemptFen (from the analysis grading uses, checked legal; kept on HeldQuestion until
 * then). A wrong try no longer keeps its question in GameView.tutor: only the note has it. A
 * takeback drops the notes on the moves it removes and never reopens a closed question.
 *
 * Takebacks keep a reachable question (that is how the player gets back to attemptFen).
 * Detection and grading for a taken-back move are dropped. Coaching turned off (no key, no prompt, an "auth" outcome) skips analysis
 * entirely; the game works the same.
 */
export function createGameManager(opts: GameManagerOptions): GameManager {
  const { bot, store, coaching } = opts;
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? SILENT_LOG;
  const games = new Map<string, Game>();
  /** Set by close() (shutdown): nothing more is saved, late results are dropped. */
  let closed = false;

  const thresholds: KeyMomentThresholds | null = coaching ? (coaching.thresholds ?? loadKeyMomentThresholds()) : null;
  const toleranceCp = coaching ? (coaching.attemptToleranceCp ?? loadAttemptToleranceCp()) : 0;
  const repertoire = coaching?.repertoire ?? null;
  /** Process-wide: set when coaching is off, or turned off by an "auth" outcome. */
  let offReason: string | null = !coaching
    ? NOT_CONFIGURED_REASON
    : coaching.tutor
      ? null
      : (coaching.offReason ?? NOT_CONFIGURED_REASON);
  let nextMoveId = 0;
  let nextAskToken = 0;

  const coachingOn = () => offReason === null && !!coaching?.tutor;

  function tutorStatus(g: Game): TutorStatus {
    return {
      available: coachingOn(),
      reason: offReason,
      thinking: g.ask !== null,
      question: g.question ? copyQuestion(g.question.view) : g.shown ? copyQuestion(g.shown.question) : null,
      // Only a reveal already shown (#47); a held one stays on the server (architecture §3.5).
      reveal: !g.question && g.shown ? copyReveal(g.shown.reveal) : null,
    };
  }

  function viewOf(g: Game): GameView {
    return {
      id: g.id,
      playerColor: g.playerColor,
      fen: g.chess.fen(),
      moves: g.moves.map((m) => ({ ...m })),
      status: g.status,
      result: g.result,
      endReason: g.endReason,
      botThinking: g.botThinking,
      tutor: tutorStatus(g),
      notes: g.notes.map(copyNote),
    };
  }

  /**
   * Sends an event to the game's subscribers. Every event but "tutor_progress" announces a
   * change, so the game is saved first (#47: saved before it is acknowledged).
   */
  function emit(g: Game, event: GameEvent): void {
    if (event.type !== "tutor_progress") save(g);
    for (const listener of [...g.listeners]) {
      try {
        listener(event);
      } catch (err) {
        log.error({ gameId: g.id, err }, "game event listener failed");
      }
    }
  }

  /**
   * A game from memory, else rebuilt from the store (#47). A "playing" game found only in the
   * store (not loaded at startup) joins the live games and resumes; a finished or abandoned
   * one is rebuilt for this call only.
   */
  function lookup(id: string): Game | undefined {
    const live = games.get(id);
    if (live || closed) return live;
    let row: StoredGame | undefined;
    try {
      row = store.get(id);
    } catch (err) {
      // Not a 404: the web treats that as "game not found" for good (review 068). This
      // reaches the error handler as a 500 ApiError.
      log.error({ gameId: id, err }, "could not read game from the store");
      throw err;
    }
    if (!row) return undefined;
    const { game, ask } = hydrate(row);
    if (game.status === "playing" && !game.readOnly) {
      games.set(game.id, game);
      resume(game, ask);
    }
    return game;
  }

  function find(id: string): Game {
    const g = lookup(id);
    if (!g) throw new GameError(404, `no game with id "${id}"`);
    return g;
  }

  function newGameRecord(id: string, playerColor: Color, createdAt: Date): Game {
    return {
      id,
      playerColor,
      chess: new Chess(),
      moves: [],
      moveIds: [],
      fensBefore: [],
      tutorEngine: null,
      status: "playing",
      result: "*",
      endReason: null,
      botThinking: false,
      version: 0,
      pending: null,
      createdAt,
      listeners: new Set(),
      analyses: new Map(),
      detecting: Promise.resolve(),
      work: new Set(),
      session: null,
      ask: null,
      question: null,
      shown: null,
      notes: [],
      lastSaved: null,
      readOnly: false,
    };
  }

  /**
   * Rebuilds a Game from its row (#47). The moves are replayed through chess.js; a move that is
   * not legal (a damaged row) ends the replay there, logged. Returns the saved tutor ask too,
   * for resume() to start again.
   */
  function hydrate(row: StoredGame): { game: Game; ask: LiveState["tutor"]["ask"] } {
    const createdAt = new Date(row.createdAt);
    const g = newGameRecord(row.id, row.playerColor, Number.isNaN(createdAt.getTime()) ? now() : createdAt);
    const state = parseLiveState(row);
    let moves: LiveState["moves"];
    try {
      moves = state ? state.moves : movesFromPgn(row.pgn, row.playerColor);
    } catch (err) {
      log.error({ gameId: row.id, err }, "saved game: could not read its moves; served read-only, row left as it is");
      moves = [];
      g.readOnly = true;
    }
    for (const m of moves) {
      const fenBefore = g.chess.fen();
      const move = tryUci(g.chess, m.uci);
      if (!move) {
        log.error(
          { gameId: row.id, uci: m.uci, fen: fenBefore },
          "saved game: illegal move, replay stopped; served read-only, row left as it is",
        );
        g.readOnly = true;
        break;
      }
      g.moves.push({ uci: toUci(move), san: move.san, by: m.by });
      g.moveIds.push(++nextMoveId);
      g.fensBefore.push(fenBefore);
    }
    g.status = row.status;
    g.result = row.result;
    g.endReason = row.endReason;
    g.notes = savedNotes(state, g.moves.length);
    if (g.readOnly) return { game: g, ask: null };
    if (row.status === "playing" && state) {
      g.question = state.tutor.question;
      g.shown = state.tutor.shown;
    }
    return { game: g, ask: row.status === "playing" ? (state?.tutor.ask ?? null) : null };
  }

  /**
   * After a restart (#47): asks the bot again if it is its turn, then starts a pending tutor ask
   * again (same request) if it can still be coached. The bot goes first, so the tutor's tool
   * calls wait for it as usual (NFR-3).
   */
  function resume(g: Game, ask: LiveState["tutor"]["ask"]): void {
    enforceReachable(g);
    if (g.chess.turn() !== g.playerColor) startBot(g);
    // A best move not yet known at the save is looked up again (#53).
    if (coaching) {
      if (g.question) fillBestMove(g, g.question);
      if (g.shown?.source) fillBestMove(g, g.shown.source);
    }
    if (ask) {
      if (coachingOn() && reachable(g, ask.kind, ask.attemptFen)) {
        log.info({ gameId: g.id, kind: ask.kind }, "tutor ask started again after a restart");
        startAsk(g, ask.kind, ask.request, ask.attemptFen);
      } else {
        log.info({ gameId: g.id, kind: ask.kind }, "tutor ask not started again: coaching is off or its position is gone");
      }
    }
    save(g);
    log.info({ gameId: g.id, moves: g.moves.length, botThinking: g.botThinking, tutorThinking: g.ask !== null }, "game restored");
  }

  function requirePlaying(g: Game): void {
    if (g.readOnly) throw new GameError(409, `game ${g.id} could not be restored from its saved moves`);
    if (g.status !== "playing") throw new GameError(409, `game ${g.id} is ${g.status}`);
  }

  /**
   * Writes the game (synchronously) unless nothing changed since the last write. After
   * close() nothing is written, so the store keeps the last acknowledged state.
   */
  function save(g: Game, opts: { required?: boolean } = {}): void {
    if (closed || g.readOnly) return;
    try {
      const row = {
        id: g.id,
        playerColor: g.playerColor,
        status: g.status,
        result: g.result,
        endReason: g.endReason,
        pgn: toPgn(viewOf(g), g.createdAt),
        createdAt: g.createdAt.toISOString(),
        state: JSON.stringify(liveStateOf(g)),
      };
      const key = JSON.stringify(row);
      if (key === g.lastSaved) return;
      store.save({ ...row, updatedAt: now().toISOString() });
      g.lastSaved = key;
    } catch (err) {
      log.error({ gameId: g.id, err }, "could not save game");
      if (opts.required) throw err;
    }
  }

  /** Ends the game and saves it; the caller emits game_over (after bot_move, if any). */
  function end(g: Game, status: "finished" | "abandoned", result: GameResult, endReason: GameEndReason): void {
    g.status = status;
    g.result = result;
    g.endReason = endReason;
    g.botThinking = false;
    g.version++;
    // A finished game has no attempt to make: abort the ask, close the question (as a note, #53).
    cancelAsk(g);
    closeAsNotes(g, "the game ended");
    save(g);
    log.info({ gameId: g.id, status, result, endReason }, "game over");
  }

  /** Applies the rule-based outcome if the position ends the game. Returns true if it did. */
  function checkOutcome(g: Game): boolean {
    const outcome = outcomeOf(g.chess);
    if (!outcome) return false;
    end(g, "finished", outcome.result, outcome.endReason);
    return true;
  }

  function cancelAsk(g: Game): void {
    if (!g.ask) return;
    g.ask.controller.abort();
    g.ask = null;
  }

  function abandon(g: Game): void {
    cancelAsk(g);
    end(g, "abandoned", "*", "abandoned");
    emit(g, { type: "game_over", game: viewOf(g) });
  }

  /**
   * After a bot failure: "state" (botThinking false, so the board unlocks) and then
   * "error". The order matters: the web reducer clears its message on state.
   */
  function botFailed(g: Game, message: string): void {
    g.botThinking = false;
    g.version++;
    emit(g, { type: "state", game: viewOf(g) });
    emit(g, { type: "error", message });
  }

  // ---------------------------------------------------------------------------------------
  // Coaching

  // Tutor notes (#53: FR-25, FR-8, FR-10). A question becomes a note only once its position is
  // left (or the game ends, or a new ask replaces it); until then its reveal and best move stay here.

  /**
   * Moves played before the latest occurrence of `attemptFen` on the board: moves.length when it
   * is the current position, else the index of the move played from it. Null if it is gone.
   */
  function plyOf(g: Game, attemptFen: string): number | null {
    if (samePosition(g.chess.fen(), attemptFen)) return g.moves.length;
    for (let i = g.fensBefore.length - 1; i >= 0; i--) if (samePosition(g.fensBefore[i]!, attemptFen)) return i;
    return null;
  }

  /** Records a note for `q` unless it has one already. The caller saves before announcing it. */
  function addNote(
    g: Game,
    q: HeldQuestion,
    ply: number | null,
    attempt: TutorNote["attempt"],
    bestMove: MoveView | null = q.bestMove ?? null,
  ): void {
    if (ply === null) {
      log.info({ gameId: g.id, questionId: q.view.id }, "tutor note not kept: its position is no longer on the board");
      return;
    }
    if (g.notes.some((n) => n.questionId === q.view.id)) return;
    g.notes.push({
      questionId: q.view.id,
      kind: q.view.kind,
      ply,
      message: q.view.message,
      reveal: q.reveal,
      bestMove: bestMove ? { ...bestMove } : null,
      attempt: attempt ? { ...attempt, move: { ...attempt.move } } : null,
    });
    log.info({ gameId: g.id, questionId: q.view.id, ply, graded: attempt !== null }, "tutor note");
  }

  /** The shown question as a HeldQuestion (rows saved before #53 have no source). */
  function shownSource(shown: NonNullable<Game["shown"]>): HeldQuestion {
    return (
      shown.source ?? {
        view: shown.question,
        reveal: shown.reveal.text,
        revealMove: shown.reveal.move?.uci ?? null,
        bestMove: null,
      }
    );
  }

  /** Closes the open and the shown question into notes on their positions (end of game, new ask). */
  function closeAsNotes(g: Game, why: string): void {
    if (g.question) {
      log.info({ gameId: g.id, questionId: g.question.view.id }, `tutor question closed: ${why}`);
      addNote(g, g.question, plyOf(g, g.question.view.attemptFen), null);
    }
    if (g.shown) {
      const q = shownSource(g.shown);
      addNote(g, q, plyOf(g, q.view.attemptFen), null);
    }
    g.question = null;
    g.shown = null;
  }

  /**
   * Fills the question's best move from the server's analysis of attemptFen (the one grading
   * uses), normally already cached by detection. Kept on the server until the note (FR-8).
   */
  function fillBestMove(g: Game, q: HeldQuestion): void {
    if (q.bestMove !== undefined) return;
    const fen = q.view.attemptFen;
    const p = afterBot(g)
      .then(() => analysisOf(g, fen))
      .then(
        (a) => {
          if (q.bestMove === undefined) q.bestMove = bestMoveOf(fen, a);
        },
        (err: unknown) => {
          log.warn({ gameId: g.id, questionId: q.view.id, err }, "no best move for the tutor question: analysis failed");
          if (q.bestMove === undefined) q.bestMove = null;
        },
      )
      .then(() => {
        if (g.question === q || g.shown?.source === q) save(g);
      });
    track(g, p);
  }

  function track(g: Game, p: Promise<void>): void {
    g.work.add(p);
    void p.finally(() => g.work.delete(p));
  }

  function analysisOf(g: Game, fen: string): Promise<Analysis> {
    const cached = g.analyses.get(fen);
    if (cached) return cached;
    const p = coaching!.analyzer.analyze(fen);
    g.analyses.set(fen, p);
    p.catch(() => {
      if (g.analyses.get(fen) === p) g.analyses.delete(fen);
    });
    if (g.analyses.size > MAX_CACHED_ANALYSES) {
      const oldest = g.analyses.keys().next().value;
      if (oldest !== undefined) g.analyses.delete(oldest);
    }
    return p;
  }

  /** True while the move is still on the board (not taken back). */
  function stillPlayed(g: Game, m: MovePlayed): boolean {
    return g.moveIds[m.history.length] === m.moveId;
  }

  /** Records a move for coaching. Call after the move is on the board and the bot has started. */
  function recordMove(g: Game, fenBefore: string, uci: string): MovePlayed {
    const moveId = ++nextMoveId;
    g.moveIds.push(moveId);
    g.fensBefore.push(fenBefore);
    return {
      fenBefore,
      fenAfter: g.chess.fen(),
      uci,
      history: g.moves.slice(0, -1).map((m) => m.uci),
      moveId,
    };
  }

  /**
   * The reachability rule (see the header): attemptFen is the current position, or, for the
   * player's own lessons, the position before the player's last move (one takeback away).
   */
  function reachable(g: Game, kind: TutorKind, attemptFen: string): boolean {
    if (g.status !== "playing") return false;
    if (samePosition(g.chess.fen(), attemptFen)) return true;
    if (!LESSON_KINDS.has(kind)) return false;
    const last = g.moves.findLastIndex((m) => m.by === "player");
    return last !== -1 && samePosition(g.fensBefore[last]!, attemptFen);
  }

  /**
   * After the position changed: aborts an ask and closes a question whose attemptFen can no
   * longer be reached. The caller's next "state" (or bot_move) then shows it.
   */
  function enforceReachable(g: Game): void {
    if (g.ask && !reachable(g, g.ask.kind, g.ask.attemptFen)) {
      log.info({ gameId: g.id, kind: g.ask.kind }, "tutor ask aborted: its position can no longer be reached");
      cancelAsk(g);
    }
    if (g.question && !reachable(g, g.question.view.kind, g.question.view.attemptFen)) {
      log.info({ gameId: g.id, questionId: g.question.view.id }, "tutor question closed: its position can no longer be reached");
      g.question = null;
    }
  }

  /**
   * The TutorEngine a game's session uses for tool calls (NFR-3). At most one tutor search is
   * submitted to the shared engine at a time; before each submission it waits for the game's
   * bot search (pending or in flight); calls still waiting reject with AbortError when the ask
   * they were made for is aborted. So at most one tutor search can be ahead of the bot.
   */
  function tutorEngineFor(g: Game): TutorEngine {
    const base: TutorEngine = coaching!.engine ?? { analyze: (fen) => coaching!.analyzer.analyze(fen) };
    let turn: Promise<void> = Promise.resolve();
    return {
      analyze(fen, opts) {
        const signal = g.ask?.controller.signal;
        const prev = turn;
        let done!: () => void;
        turn = new Promise<void>((r) => (done = r));
        const run = (async () => {
          await unlessAborted(prev, signal);
          while (g.pending) await unlessAborted(afterBot(g), signal);
          if (signal?.aborted) throw abortError();
          return base.analyze(fen, opts);
        })();
        // The next call's turn starts when this one has settled and so has the one before it,
        // so an aborted waiter never lets two searches through at once.
        void run.then(
          () => prev.then(done),
          () => prev.then(done),
        );
        return run;
      },
    };
  }

  /**
   * Resolves once the bot's search in flight (if any) has settled. The engine is one shared
   * process with a FIFO queue, and the bot reaches it only after its explorer lookup, so the
   * server's analysis waits for the bot instead of racing it into the queue (NFR-3).
   */
  function afterBot(g: Game): Promise<void> {
    const pending = g.pending;
    return pending ? pending.catch(() => {}) : Promise.resolve();
  }

  function scheduleDetection(g: Game, m: MovePlayed, opts: { ask: boolean }): void {
    if (closed || !coachingOn()) return;
    const botTurn = afterBot(g);
    const p = g.detecting
      .then(() => botTurn)
      .then(() => detectAndAsk(g, m, opts.ask))
      .catch((err: unknown) => log.warn({ gameId: g.id, uci: m.uci, err }, "key-moment detection failed"));
    g.detecting = p;
    track(g, p);
  }

  async function detectAndAsk(g: Game, m: MovePlayed, ask: boolean): Promise<void> {
    if (!stillPlayed(g, m)) return;
    const [before, after] = await Promise.all([analysisOf(g, m.fenBefore), analysisOf(g, m.fenAfter)]);
    if (!stillPlayed(g, m)) {
      log.info({ gameId: g.id, uci: m.uci }, "key-moment detection dropped: the move was taken back");
      return;
    }
    const moment = detect({
      playerColor: g.playerColor,
      fenBefore: m.fenBefore,
      move: m.uci,
      history: m.history,
      before,
      after,
      repertoire,
      thresholds: thresholds!,
    });
    log.info({ gameId: g.id, uci: m.uci, keyMoment: moment?.kind ?? null }, "key-moment detection");
    if (!moment || !ask) return; // FR-7: a quiet move never reaches the tutor
    if (closed || g.status !== "playing" || !coachingOn()) return; // closed: shutting down (review 065)
    const attemptFen = LESSON_KINDS.has(moment.kind) ? m.fenBefore : m.fenAfter;
    if (!reachable(g, moment.kind, attemptFen)) {
      log.info({ gameId: g.id, uci: m.uci, keyMoment: moment.kind }, "key moment not coached: its position can no longer be reached");
      return;
    }
    // The player's own lesson outranks the bot's key moment (review 028).
    const current = g.ask?.kind ?? g.question?.view.kind;
    if (!LESSON_KINDS.has(moment.kind) && current !== undefined && LESSON_KINDS.has(current)) {
      log.info({ gameId: g.id, uci: m.uci, keyMoment: moment.kind, kept: current }, "key moment not coached: the player's lesson is kept");
      return;
    }
    startAsk(g, moment.kind, {
      kind: "key_moment",
      moment,
      fen: m.fenAfter,
      attemptFen,
      history: [...m.history, m.uci],
    }, attemptFen);
  }

  function startAsk(g: Game, kind: TutorKind, request: TutorRequest, attemptFen: string): void {
    // After close() nothing would abort a new ask (review 065); the next start re-runs saved asks.
    if (closed) {
      log.info({ gameId: g.id, kind }, "tutor ask not started: the server is shutting down");
      return;
    }
    cancelAsk(g);
    // A replaced question whose position is still on the board becomes a note (#53).
    const notesBefore = g.notes.length;
    closeAsNotes(g, "replaced by a new ask");
    const token = ++nextAskToken;
    const controller = new AbortController();
    g.ask = { token, kind, attemptFen, request, controller };
    log.info({ gameId: g.id, kind }, "tutor asked");
    // tutor_thinking at once; the session sends the first progress label itself (NFR-1).
    emit(g, { type: "tutor_thinking", kind });
    // Notes reach the client only inside a GameView.
    if (g.notes.length !== notesBefore) emit(g, { type: "state", game: viewOf(g) });

    const onProgress = (p: { label: string }) => {
      if (g.ask?.token === token) emit(g, { type: "tutor_progress", label: String(p.label) });
    };
    let outcome: Promise<TutorOutcome>;
    try {
      g.tutorEngine ??= tutorEngineFor(g);
      g.session ??= coaching!.tutor!.createSession({ id: g.id, playerColor: g.playerColor, engine: g.tutorEngine });
      outcome = Promise.resolve(g.session.ask(request, onProgress, controller.signal));
    } catch (err) {
      outcome = Promise.reject(err);
    }
    void outcome
      .catch((err: unknown): TutorOutcome => {
        // ask() must not throw; treat it like an unreachable API.
        log.warn({ gameId: g.id, err }, "tutor ask threw");
        const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        return { ok: false, reason: "api_unavailable", message: String(err), usage, ms: 0 };
      })
      .then((o) => finishAsk(g, token, kind, attemptFen, o));
  }

  function finishAsk(g: Game, token: number, kind: TutorKind, attemptFen: string, outcome: TutorOutcome): void {
    const meta = { gameId: g.id, kind, ok: outcome.ok, ms: outcome.ms, usage: outcome.usage };
    if (g.ask?.token !== token) {
      log.info(meta, "tutor reply dropped: the question was replaced");
      return;
    }
    g.ask = null;
    if (!reachable(g, kind, attemptFen)) {
      // Normally aborted already when the position changed; this is the last line of defence.
      log.info(meta, "tutor reply dropped: its position can no longer be reached");
      emit(g, { type: "state", game: viewOf(g) });
      return;
    }
    if (outcome.ok) {
      const { reply } = outcome;
      g.question = {
        view: {
          id: randomUUID(),
          kind,
          message: reply.message,
          arrows: cleanArrows(reply.arrows),
          attemptFen,
          canReveal: reply.reveal !== null || reply.revealMove !== null,
        },
        reveal: reply.reveal,
        revealMove: reply.revealMove,
      };
      fillBestMove(g, g.question);
      log.info({ ...meta, questionId: g.question.view.id }, "tutor reply");
      emit(g, { type: "tutor_reply", question: { ...g.question.view, arrows: g.question.view.arrows.map((a) => ({ ...a })) } });
      return;
    }
    log.warn({ ...meta, reason: outcome.reason, detail: outcome.message }, "tutor failed");
    emit(g, { type: "tutor_failed", message: failureMessage(outcome.reason) });
    if (outcome.reason === "auth" && offReason === null) {
      // NFR-9: a missing or rejected key turns coaching off for the process; games go on.
      offReason = AUTH_REASON;
      for (const other of games.values()) {
        if (!other.ask) continue;
        cancelAsk(other);
        if (other !== g) save(other);
      }
      log.error({ gameId: g.id }, "coaching turned off: the API key was rejected");
      emit(g, { type: "state", game: viewOf(g) });
    }
  }

  function gradeAttempt(g: Game, q: HeldQuestion, m: MovePlayed, move: MoveView): void {
    const botTurn = afterBot(g);
    const ply = m.history.length;
    /** The try closed the question: it becomes a note on the try (#53), announced in a "state". */
    const ungraded = (why: string, bestMove?: MoveView | null) => {
      if (closed || !stillPlayed(g, m)) return;
      log.warn({ gameId: g.id, questionId: q.view.id, uci: m.uci }, `attempt not graded: ${why}`);
      addNote(g, q, ply, null, bestMove ?? q.bestMove ?? null);
      emit(g, { type: "state", game: viewOf(g) });
    };
    const p = (async () => {
      await botTurn;
      const [before, after] = await Promise.all([analysisOf(g, m.fenBefore), analysisOf(g, m.fenAfter)]);
      if (closed) return;
      if (!stillPlayed(g, m)) {
        log.info({ gameId: g.id, questionId: q.view.id, uci: m.uci }, "attempt not graded: the move was taken back");
        return;
      }
      // The best move from the analysis the try is graded against (FR-10).
      const bestMove = bestMoveOf(m.fenBefore, before);
      const cpLoss = moveLoss(m.fenBefore, m.uci, before, after);
      if (cpLoss === null) {
        ungraded("no evaluation", bestMove);
        return;
      }
      const correct = cpLoss <= toleranceCp;
      log.info({ gameId: g.id, questionId: q.view.id, uci: m.uci, cpLoss, correct }, "attempt graded");
      const reveal = correct ? null : buildReveal(q);
      // The question is closed by the try: its content now lives in the note, not in
      // GameView.tutor (FR-24, FR-8 as amended by A6).
      addNote(g, q, ply, { move: { ...move }, correct, cpLoss }, bestMove);
      emit(g, { type: "tutor_attempt", questionId: q.view.id, move: { ...move }, correct, cpLoss });
      if (reveal) emit(g, { type: "tutor_reveal", reveal });
      emit(g, { type: "state", game: viewOf(g) });
    })().catch((err: unknown) => {
      log.warn({ gameId: g.id, err }, "attempt grading failed");
      ungraded("grading failed");
    });
    track(g, p);
  }

  // ---------------------------------------------------------------------------------------

  function startBot(g: Game): void {
    g.botThinking = true;
    const version = g.version;
    const fen = g.chess.fen();
    const t0 = performance.now();
    const stale = () => closed || g.version !== version || g.status !== "playing";

    const pending: Promise<void> = bot.chooseMove(fen).then(
      (botMove) => {
        const ms = Math.round(performance.now() - t0);
        if (stale()) {
          log.info({ gameId: g.id, uci: botMove.uci, ms }, "bot move discarded: game changed while it was thinking");
          return;
        }
        // FR-10: the bot's move is checked by chess.js like the player's.
        const move = tryUci(g.chess, botMove.uci);
        if (!move) {
          g.botThinking = false;
          log.error({ gameId: g.id, uci: botMove.uci, fen }, "bot returned an illegal move");
          botFailed(g, `The bot returned an illegal move (${botMove.uci}).`);
          return;
        }
        g.moves.push({ uci: toUci(move), san: move.san, by: "bot" });
        const played = recordMove(g, fen, toUci(move));
        g.botThinking = false;
        g.version++;
        log.info(
          { gameId: g.id, ms, source: botMove.source, uci: toUci(move), san: move.san },
          "bot move",
        );
        enforceReachable(g);
        const over = checkOutcome(g);
        emit(g, { type: "bot_move", move: { ...g.moves.at(-1)! }, game: viewOf(g) });
        if (over) emit(g, { type: "game_over", game: viewOf(g) });
        scheduleDetection(g, played, { ask: true });
      },
      (err: unknown) => {
        if (stale()) return;
        g.botThinking = false;
        log.error({ gameId: g.id, fen, err }, "bot failed to choose a move");
        botFailed(g, `The bot could not choose a move: ${err instanceof Error ? err.message : String(err)}`);
      },
    ).finally(() => {
      if (g.pending === pending) g.pending = null;
    });
    g.pending = pending;
  }

  // Startup (#47, NFR-14): every game still "playing" comes back from the store and resumes.
  let restored: StoredGame[] = [];
  try {
    restored = store.listPlaying();
  } catch (err) {
    log.error({ err }, "could not load games in progress from the store");
  }
  for (const row of restored) {
    try {
      const { game, ask } = hydrate(row);
      if (game.status !== "playing" || game.readOnly) continue; // a damaged row stays as it is
      games.set(game.id, game);
      resume(game, ask);
    } catch (err) {
      log.error({ gameId: row.id, err }, "could not restore a saved game");
    }
  }

  return {
    create(playerColor) {
      const g = newGameRecord(newId(), playerColor, now());
      // In the store before anything else changes (#47). If that fails, nothing has: the
      // reply is 500 and the old game stays playing, with no event (reviews 065, 068).
      save(g, { required: true });
      for (const other of games.values()) if (other.status === "playing") abandon(other);
      games.set(g.id, g);
      log.info({ gameId: g.id, playerColor }, "new game");
      if (playerColor === "b") {
        startBot(g);
        save(g); // botThinking (informational: on load the bot is asked whenever it is its turn)
      }
      return viewOf(g);
    },

    view(id) {
      const g = lookup(id);
      return g ? viewOf(g) : undefined;
    },

    play(id, uci) {
      const g = find(id);
      requirePlaying(g);
      if (g.botThinking) throw new GameError(409, "the bot is thinking");
      if (g.chess.turn() !== g.playerColor) throw new GameError(409, "it is not the player's turn");
      const fenBefore = g.chess.fen();
      const move = tryUci(g.chess, uci);
      if (!move) throw new GameError(400, `illegal move "${uci}" in position ${fenBefore}`);
      g.moves.push({ uci: toUci(move), san: move.san, by: "player" });
      const played = recordMove(g, fenBefore, toUci(move));
      g.version++;
      // The player's next move closes the open question; from attemptFen it is an attempt.
      const attempt = g.question && samePosition(g.question.view.attemptFen, fenBefore) ? g.question : null;
      if (attempt) {
        // Graded below; its note is made when the grade is known.
        g.question = null;
      }
      // Moved on (a question not tried, or one shown by "Show me"): a note now, attempt null (#53).
      closeAsNotes(g, "the player moved on");
      enforceReachable(g); // e.g. a Hint for the position just left: aborted, thinking false
      if (checkOutcome(g)) {
        emit(g, { type: "game_over", game: viewOf(g) });
      } else {
        startBot(g); // the bot's search is pending before any coaching search (NFR-3)
        emit(g, { type: "state", game: viewOf(g) });
      }
      if (attempt) gradeAttempt(g, attempt, played, { ...g.moves.at(-1)! });
      scheduleDetection(g, played, { ask: !attempt });
      return viewOf(g);
    },

    takeback(id) {
      const g = find(id);
      requirePlaying(g);
      if (g.botThinking) throw new GameError(409, "the bot is thinking");
      const lastPlayer = g.moves.findLastIndex((m) => m.by === "player");
      if (lastPlayer === -1) throw new GameError(409, "the player has no move to take back");
      while (g.moves.length > lastPlayer) {
        g.chess.undo();
        g.moves.pop();
        g.moveIds.pop();
        g.fensBefore.pop();
      }
      g.version++;
      g.shown = null;
      // The moves the notes sat on are gone (#53); a closed question is never reopened.
      g.notes = g.notes.filter((n) => n.ply < g.moves.length);
      enforceReachable(g); // a takeback past attemptFen closes the question
      emit(g, { type: "state", game: viewOf(g) });
      return viewOf(g);
    },

    botRetry(id) {
      const g = find(id);
      requirePlaying(g);
      if (g.botThinking) throw new GameError(409, "the bot is thinking");
      if (g.chess.turn() === g.playerColor) throw new GameError(409, "it is the player's turn");
      log.info({ gameId: g.id, fen: g.chess.fen() }, "bot retry");
      // Through startBot, so a retried search is discarded if the game changes meanwhile.
      g.version++;
      startBot(g);
      emit(g, { type: "state", game: viewOf(g) });
      return viewOf(g);
    },

    resign(id) {
      const g = find(id);
      requirePlaying(g);
      end(g, "finished", g.playerColor === "w" ? "0-1" : "1-0", "resigned");
      emit(g, { type: "game_over", game: viewOf(g) });
      return viewOf(g);
    },

    hint(id) {
      const g = find(id);
      if (!coachingOn()) throw new GameError(503, offReason ?? NOT_CONFIGURED_REASON);
      requirePlaying(g);
      if (g.ask) throw new GameError(409, "the tutor is already working");
      if (g.botThinking || g.chess.turn() !== g.playerColor) throw new GameError(409, "it is not the player's turn");
      const fen = g.chess.fen();
      startAsk(g, "hint", { kind: "hint", fen, history: g.moves.map((m) => m.uci) }, fen);
    },

    reveal(id) {
      const g = find(id);
      const q = g.question;
      if (!q) throw new GameError(409, "there is no open tutor question");
      g.question = null;
      const reveal = buildReveal(q);
      // Shown now: GameView.tutor carries it (#47) until the position moves on.
      g.shown = { question: copyQuestion(q.view), reveal: copyReveal(reveal), source: q };
      log.info({ gameId: g.id, questionId: q.view.id, move: reveal.move?.uci ?? null }, "tutor reveal");
      emit(g, { type: "tutor_reveal", reveal });
      return reveal;
    },

    close() {
      if (closed) return;
      closed = true;
      // In memory only: the store keeps each pending ask, so the next start asks again.
      for (const g of games.values()) cancelAsk(g);
      log.info({ games: [...games.values()].filter((g) => g.status === "playing").length }, "game manager closed; games in progress stay saved");
    },

    subscribe(id, listener) {
      const g = find(id);
      g.listeners.add(listener);
      return () => {
        g.listeners.delete(listener);
      };
    },

    async idle(id) {
      const g = games.get(id);
      while (g && (g.pending || g.work.size > 0)) {
        if (g.pending) await g.pending;
        await Promise.all([...g.work]);
      }
    },
  };
}
