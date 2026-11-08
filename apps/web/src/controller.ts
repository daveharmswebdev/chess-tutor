// Side effects for the board UI: API calls and the SSE subscription, feeding the reducer.
// Plain TS with injected API and EventSource so it is testable without a DOM. FR-1, FR-4, IR-5.
import type { Color, GameEvent, GameView } from "@chess-tutor/chess-core";
import { ApiRequestError, type ApiClient } from "./api.ts";
import { fenAfter, isOwnPiece, moveToUci } from "./chess-rules.ts";
import {
  boardFen,
  canHint,
  canResign,
  canRetryBot,
  canReveal,
  canTakeback,
  isPlayersTurn,
  type GameAction,
  type GameState,
} from "./game-state.ts";

/** The part of the browser EventSource the controller uses. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  close(): void;
}

export interface GameControllerDeps {
  api: ApiClient;
  openEvents: (url: string) => EventSourceLike;
  dispatch: (action: GameAction) => void;
  getState: () => GameState;
}

export interface GameController {
  newGame(color: Color): Promise<void>;
  /** Plays from -> to if legal and it is the player's turn. Resolves true if the server accepted it. */
  play(from: string, to: string): Promise<boolean>;
  /** Click-to-move: select a piece, then click a target. */
  clickSquare(square: string): Promise<void>;
  takeback(): Promise<void>;
  resign(): Promise<void>;
  /** After a bot failure: ask the server to retry; the bot's move then arrives over SSE (#23). */
  retryBot(): Promise<void>;
  /** POST /tutor/hint when canHint; the reply arrives over SSE. 409/503 become a tutor notice (FR-12). */
  hint(): Promise<void>;
  /** "Show me": POST /tutor/reveal when canReveal; a 409 becomes a tutor notice (FR-11). */
  reveal(): Promise<void>;
  dispose(): void;
}

const EVENT_TYPES = [
  "state",
  "bot_move",
  "game_over",
  "error",
  "tutor_thinking",
  "tutor_progress",
  "tutor_reply",
  "tutor_failed",
  "tutor_reveal",
  "tutor_attempt",
] as const satisfies ReadonlyArray<GameEvent["type"]>;
const CLOSED = 2;

function messageOf(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return "Something went wrong talking to the game server.";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";

/** Checks the fields each event type needs before it reaches the reducer. */
function wellFormed(e: Record<string, unknown>): boolean {
  switch (e["type"]) {
    case "state":
    case "bot_move":
    case "game_over":
      return isObject(e["game"]);
    case "error":
    case "tutor_failed":
      return isString(e["message"]);
    case "tutor_thinking":
      return isString(e["kind"]);
    case "tutor_progress":
      return isString(e["label"]);
    case "tutor_reply": {
      const q = e["question"];
      return isObject(q) && isString(q["id"]) && isString(q["message"]) && Array.isArray(q["arrows"]);
    }
    case "tutor_reveal": {
      const r = e["reveal"];
      return isObject(r) && isString(r["questionId"]) && isString(r["text"]) && Array.isArray(r["arrows"]);
    }
    case "tutor_attempt": {
      const m = e["move"];
      return (
        isString(e["questionId"]) &&
        isObject(m) &&
        isString(m["san"]) &&
        typeof e["correct"] === "boolean" &&
        typeof e["cpLoss"] === "number"
      );
    }
    default:
      return false;
  }
}

function parseEvent(data: unknown): GameEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return isObject(parsed) && wellFormed(parsed) ? (parsed as unknown as GameEvent) : null;
  } catch {
    return null;
  }
}

export function createGameController(deps: GameControllerDeps): GameController {
  const { api, dispatch, getState } = deps;
  let source: EventSourceLike | null = null;

  function closeSource(): void {
    source?.close();
    source = null;
  }

  function subscribe(gameId: string): void {
    closeSource();
    const es = deps.openEvents(api.eventsUrl(gameId));
    source = es;
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        if (source !== es) return;
        if (type === "error" && ev.data === undefined) {
          // Connection error, not a server "error" event. The browser reconnects on its own
          // (and the server resends "state"); only report it once it has given up.
          if (es.readyState === CLOSED) {
            dispatch({ type: "connection_lost", message: "Lost the connection to the game server." });
          }
          return;
        }
        const event = parseEvent(ev.data);
        if (event) dispatch({ type: "server_event", event });
      });
    }
  }

  async function play(from: string, to: string): Promise<boolean> {
    const state = getState();
    const game = state.game;
    if (!game || !isPlayersTurn(state)) return false;
    const fen = boardFen(state);
    const uci = moveToUci(fen, from, to);
    if (!uci) {
      dispatch({ type: "select", square: null });
      return false;
    }
    dispatch({ type: "move_attempted", uci, fen: fenAfter(fen, uci) ?? fen });
    try {
      dispatch({ type: "move_accepted", game: await api.playMove(game.id, uci) });
      return true;
    } catch (e) {
      dispatch({ type: "move_rejected", message: messageOf(e) });
      return false;
    }
  }

  async function simpleRequest(run: (id: string) => Promise<GameView>): Promise<void> {
    const game = getState().game;
    if (!game) return;
    dispatch({ type: "request_started" });
    try {
      dispatch({ type: "request_succeeded", game: await run(game.id) });
    } catch (e) {
      dispatch({ type: "request_failed", message: messageOf(e) });
    }
  }

  return {
    async newGame(color) {
      closeSource();
      dispatch({ type: "request_started" });
      try {
        const game = await api.newGame(color);
        dispatch({ type: "game_started", game });
        subscribe(game.id);
      } catch (e) {
        dispatch({ type: "request_failed", message: messageOf(e) });
      }
    },

    play,

    async clickSquare(square) {
      const state = getState();
      const game = state.game;
      if (!game || !isPlayersTurn(state)) return;
      const fen = boardFen(state);
      const selected = state.selected;
      if (selected === square) {
        dispatch({ type: "select", square: null });
        return;
      }
      if (isOwnPiece(fen, square, game.playerColor)) {
        dispatch({ type: "select", square });
        return;
      }
      if (selected) {
        dispatch({ type: "select", square: null });
        await play(selected, square);
      }
    },

    async takeback() {
      if (!canTakeback(getState())) return;
      await simpleRequest((id) => api.takeback(id));
    },

    async resign() {
      if (!canResign(getState())) return;
      await simpleRequest((id) => api.resign(id));
    },

    async retryBot() {
      if (!canRetryBot(getState())) return;
      await simpleRequest((id) => api.botRetry(id));
    },

    async hint() {
      const state = getState();
      if (!state.game || !canHint(state)) return;
      const id = state.game.id;
      dispatch({ type: "tutor_notice", message: null });
      try {
        await api.tutorHint(id);
      } catch (e) {
        if (getState().game?.id === id) dispatch({ type: "tutor_notice", message: messageOf(e) });
      }
    },

    async reveal() {
      const state = getState();
      if (!state.game || !canReveal(state)) return;
      const id = state.game.id;
      dispatch({ type: "tutor_notice", message: null });
      try {
        const reveal = await api.tutorReveal(id);
        if (getState().game?.id === id) dispatch({ type: "tutor_reveal_received", reveal });
      } catch (e) {
        if (getState().game?.id === id) dispatch({ type: "tutor_notice", message: messageOf(e) });
      }
    },

    dispose() {
      closeSource();
    },
  };
}
