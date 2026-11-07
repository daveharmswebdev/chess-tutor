import { randomUUID } from "node:crypto";
import { Chess, type Move } from "chess.js";
import type {
  Color,
  GameEndReason,
  GameEvent,
  GameResult,
  GameStatus,
  GameView,
  MoveView,
  SparringBot,
} from "@chess-tutor/chess-core";
import { outcomeOf } from "./outcome.ts";
import { toPgn } from "./pgn.ts";
import type { GameStore } from "./store.ts";

/** An error with the HTTP status the contract gives it (400, 404, 409). */
export class GameError extends Error {
  override name = "GameError";
  readonly statusCode: 400 | 404 | 409;
  constructor(statusCode: 400 | 404 | 409, message: string) {
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
  /** Marks every game still playing as abandoned and saves it (shutdown). */
  abandonAll(): void;
  /** Throws GameError 404 for an unknown game. Returns the unsubscribe function. */
  subscribe(id: string, listener: GameListener): () => void;
  /** Resolves once the bot's current search (if any) for this game has been handled. */
  idle(id: string): Promise<void>;
}

interface Game {
  id: string;
  playerColor: Color;
  chess: Chess;
  moves: MoveView[];
  status: GameStatus;
  result: GameResult;
  endReason: GameEndReason | null;
  botThinking: boolean;
  /** Bumped on every change, so a bot search for an older state is discarded. */
  version: number;
  pending: Promise<void> | null;
  createdAt: Date;
  listeners: Set<GameListener>;
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

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

export function createGameManager(opts: GameManagerOptions): GameManager {
  const { bot, store } = opts;
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? SILENT_LOG;
  const games = new Map<string, Game>();

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

  function abandon(g: Game): void {
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
        g.botThinking = false;
        g.version++;
        log.info(
          { gameId: g.id, ms, source: botMove.source, uci: toUci(move), san: move.san },
          "bot move",
        );
        const over = checkOutcome(g);
        emit(g, { type: "bot_move", move: { ...g.moves.at(-1)! }, game: viewOf(g) });
        if (over) emit(g, { type: "game_over", game: viewOf(g) });
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
        status: "playing",
        result: "*",
        endReason: null,
        botThinking: false,
        version: 0,
        pending: null,
        createdAt: now(),
        listeners: new Set(),
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
      const move = tryUci(g.chess, uci);
      if (!move) throw new GameError(400, `illegal move "${uci}" in position ${g.chess.fen()}`);
      g.moves.push({ uci: toUci(move), san: move.san, by: "player" });
      g.version++;
      if (checkOutcome(g)) {
        emit(g, { type: "game_over", game: viewOf(g) });
      } else {
        startBot(g);
        emit(g, { type: "state", game: viewOf(g) });
      }
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

    abandonAll() {
      for (const g of games.values()) if (g.status === "playing") abandon(g);
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
      while (g?.pending) await g.pending;
    },
  };
}
