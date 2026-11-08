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
} from "@chess-tutor/chess-core";
import type { TutorOutcome, TutorRequest, TutorSession } from "@chess-tutor/tutor";
import {
  AUTH_REASON,
  buildReveal,
  cleanArrows,
  failureMessage,
  FIRST_PROGRESS_LABEL,
  moveLoss,
  NOT_CONFIGURED_REASON,
  samePosition,
  type CoachingDeps,
  type HeldQuestion,
  type TutorKind,
  type TutorReveal,
  type TutorStatus,
} from "./coaching.ts";
import { loadAttemptToleranceCp, loadKeyMomentThresholds } from "./config.ts";
import { outcomeOf } from "./outcome.ts";
import { toPgn } from "./pgn.ts";
import type { GameStore } from "./store.ts";

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
  /** Marks every game still playing as abandoned and saves it (shutdown). */
  abandonAll(): void;
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
  /** The tutor request in flight; a newer one replaces it (and aborts it). */
  ask: { token: number; kind: TutorKind; controller: AbortController } | null;
  /** At most one open question per game; the reveal stays here until "Show me" or a wrong try. */
  question: HeldQuestion | null;
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const MAX_CACHED_ANALYSES = 64;

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
 * Game state, the bot, and coaching (#6, #7).
 *
 * Coaching (FR-6 to FR-12, NFR-9): after every move (the player's and the bot's) the server
 * analyses the new position, keeps the previous one's analysis, and runs the key-moment
 * detector. Only a key moment or a Hint calls the tutor (FR-7). The bot search is queued on
 * the shared engine before the analysis, so the bot never waits for coaching (NFR-3).
 *
 * Questions: at most one per game. A new key moment or Hint replaces it, aborting an ask in
 * flight; a late reply for a replaced ask is dropped. The reply's reveal and revealMove stay
 * here until "Show me" or a wrong try (architecture §3.5).
 *
 * Attempts: the player's next move closes the open question. When it is played from the
 * question's attemptFen (directly for punish_opponent, opponent_left_book and hints; after a
 * takeback for player_blunder and missed_win), the engine grades it: correct when its loss
 * against the best move is at most attemptToleranceCp; "tutor_attempt" is sent, and on a wrong
 * try also "tutor_reveal". A move from any other position (the player moved on without taking
 * back) closes the question silently. A graded move is not itself coached again as a key
 * moment (its reveal already explains it); the bot's reply still is.
 *
 * Takebacks keep the open question (that is how the player gets back to attemptFen).
 * Detection for a taken-back move is dropped, as is a key moment older than the player's
 * latest turn. Coaching turned off (no key, no prompt, an "auth" outcome) skips analysis
 * entirely; the game works the same.
 */
export function createGameManager(opts: GameManagerOptions): GameManager {
  const { bot, store, coaching } = opts;
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? SILENT_LOG;
  const games = new Map<string, Game>();

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
      question: g.question ? { ...g.question.view, arrows: g.question.view.arrows.map((a) => ({ ...a })) } : null,
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
    };
  }

  function emit(g: Game, event: GameEvent): void {
    for (const listener of [...g.listeners]) {
      try {
        listener(event);
      } catch (err) {
        log.error({ gameId: g.id, err }, "game event listener failed");
      }
    }
  }

  function find(id: string): Game {
    const g = games.get(id);
    if (!g) throw new GameError(404, `no game with id "${id}"`);
    return g;
  }

  function requirePlaying(g: Game): void {
    if (g.status !== "playing") throw new GameError(409, `game ${g.id} is ${g.status}`);
  }

  function save(g: Game): void {
    try {
      store.save({
        id: g.id,
        playerColor: g.playerColor,
        status: g.status,
        result: g.result,
        endReason: g.endReason,
        pgn: toPgn(viewOf(g), g.createdAt),
        createdAt: g.createdAt.toISOString(),
        updatedAt: now().toISOString(),
      });
    } catch (err) {
      log.error({ gameId: g.id, err }, "could not save game");
    }
  }

  /** Ends the game and saves it; the caller emits game_over (after bot_move, if any). */
  function end(g: Game, status: "finished" | "abandoned", result: GameResult, endReason: GameEndReason): void {
    g.status = status;
    g.result = result;
    g.endReason = endReason;
    g.botThinking = false;
    g.version++;
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
    return {
      fenBefore,
      fenAfter: g.chess.fen(),
      uci,
      history: g.moves.slice(0, -1).map((m) => m.uci),
      moveId,
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
    if (!coachingOn()) return;
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
    if (g.status !== "playing" || !coachingOn()) return;
    if (g.moves.length - m.history.length > 2) {
      log.info({ gameId: g.id, uci: m.uci }, "key moment not coached: the player has moved on");
      return;
    }
    const attemptFen = moment.kind === "player_blunder" || moment.kind === "missed_win" ? m.fenBefore : m.fenAfter;
    startAsk(g, moment.kind, {
      kind: "key_moment",
      moment,
      fen: m.fenAfter,
      attemptFen,
      history: [...m.history, m.uci],
    }, attemptFen);
  }

  function startAsk(g: Game, kind: TutorKind, request: TutorRequest, attemptFen: string): void {
    cancelAsk(g);
    if (g.question) log.info({ gameId: g.id, questionId: g.question.view.id }, "tutor question replaced");
    g.question = null;
    const token = ++nextAskToken;
    const controller = new AbortController();
    g.ask = { token, kind, controller };
    log.info({ gameId: g.id, kind }, "tutor asked");
    emit(g, { type: "tutor_thinking", kind });
    emit(g, { type: "tutor_progress", label: FIRST_PROGRESS_LABEL }); // NFR-1: first progress at once

    const onProgress = (p: { label: string }) => {
      if (g.ask?.token === token) emit(g, { type: "tutor_progress", label: String(p.label) });
    };
    let outcome: Promise<TutorOutcome>;
    try {
      g.session ??= coaching!.tutor!.createSession({ id: g.id, playerColor: g.playerColor });
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
      log.info({ ...meta, questionId: g.question.view.id }, "tutor reply");
      emit(g, { type: "tutor_reply", question: { ...g.question.view, arrows: g.question.view.arrows.map((a) => ({ ...a })) } });
      return;
    }
    log.warn({ ...meta, reason: outcome.reason, detail: outcome.message }, "tutor failed");
    emit(g, { type: "tutor_failed", message: failureMessage(outcome.reason) });
    if (outcome.reason === "auth" && offReason === null) {
      // NFR-9: a missing or rejected key turns coaching off for the process; games go on.
      offReason = AUTH_REASON;
      for (const other of games.values()) cancelAsk(other);
      log.error({ gameId: g.id }, "coaching turned off: the API key was rejected");
      emit(g, { type: "state", game: viewOf(g) });
    }
  }

  function gradeAttempt(g: Game, q: HeldQuestion, m: MovePlayed, move: MoveView): void {
    const botTurn = afterBot(g);
    const p = (async () => {
      await botTurn;
      const [before, after] = await Promise.all([analysisOf(g, m.fenBefore), analysisOf(g, m.fenAfter)]);
      const cpLoss = moveLoss(m.fenBefore, m.uci, before, after);
      if (cpLoss === null) {
        log.warn({ gameId: g.id, questionId: q.view.id, uci: m.uci }, "attempt not graded: no evaluation");
        return;
      }
      const correct = cpLoss <= toleranceCp;
      log.info({ gameId: g.id, questionId: q.view.id, uci: m.uci, cpLoss, correct }, "attempt graded");
      emit(g, { type: "tutor_attempt", questionId: q.view.id, move: { ...move }, correct, cpLoss });
      if (!correct) emit(g, { type: "tutor_reveal", reveal: buildReveal(q) });
    })().catch((err: unknown) => log.warn({ gameId: g.id, err }, "attempt grading failed"));
    track(g, p);
  }

  // ---------------------------------------------------------------------------------------

  function startBot(g: Game): void {
    g.botThinking = true;
    const version = g.version;
    const fen = g.chess.fen();
    const t0 = performance.now();
    const stale = () => g.version !== version || g.status !== "playing";

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

  return {
    create(playerColor) {
      for (const g of games.values()) if (g.status === "playing") abandon(g);
      const g: Game = {
        id: newId(),
        playerColor,
        chess: new Chess(),
        moves: [],
        moveIds: [],
        status: "playing",
        result: "*",
        endReason: null,
        botThinking: false,
        version: 0,
        pending: null,
        createdAt: now(),
        listeners: new Set(),
        analyses: new Map(),
        detecting: Promise.resolve(),
        work: new Set(),
        session: null,
        ask: null,
        question: null,
      };
      games.set(g.id, g);
      log.info({ gameId: g.id, playerColor }, "new game");
      if (playerColor === "b") startBot(g);
      return viewOf(g);
    },

    view(id) {
      const g = games.get(id);
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
      if (g.question && !attempt) log.info({ gameId: g.id, questionId: g.question.view.id }, "tutor question closed: the player moved on");
      g.question = null;
      if (checkOutcome(g)) {
        emit(g, { type: "game_over", game: viewOf(g) });
      } else {
        startBot(g); // first in the engine queue: the bot never waits for coaching (NFR-3)
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
      }
      g.version++;
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
      log.info({ gameId: g.id, questionId: q.view.id, move: reveal.move?.uci ?? null }, "tutor reveal");
      emit(g, { type: "tutor_reveal", reveal });
      return reveal;
    },

    abandonAll() {
      for (const g of games.values()) {
        if (g.status === "playing") abandon(g);
        else cancelAsk(g);
      }
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
