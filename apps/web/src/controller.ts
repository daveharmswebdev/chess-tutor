// Side effects for the board UI: API calls and the SSE subscription, feeding the reducer.
// Plain TS with injected API and EventSource so it is testable without a DOM. FR-1, FR-4, IR-5.
// Survival (#47: NFR-14, NFR-9): a game lives at /games/<id>. `navigate` opens the game in a
// path from GET /api/games/:id plus a new event stream. A network error, a 5xx or a dropped
// stream is not "game not found": the state shows "Reconnecting…" and the controller retries
// with backoff (GET, then a new EventSource). Only a 404 means the game is gone.
import type { Color, GameEvent, GameView } from "@chess-tutor/chess-core";
import { ApiRequestError, type ApiClient } from "./api.ts";
import { fenAfter, isOwnPiece, moveToUci } from "./chess-rules.ts";
import { gameIdFromPath, gamePath } from "./routing.ts";
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
  /** For the reconnect backoff; defaults to the global timers. */
  timers?: Timers;
  /** history.pushState for a new game's address; defaults to doing nothing. */
  pushPath?: (path: string) => void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

/** Delay before reconnect attempt `attempt` (0-based): 0.5 s doubling to a 10 s cap. */
export function reconnectDelay(attempt: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
}

const MOVE_NOT_SENT = "Your move was not sent: the game server is unreachable. Play it again once reconnected.";
const REQUEST_NOT_SENT = "That did not reach the game server. Try again once reconnected.";

export interface GameController {
  /** Starts a game and pushes its address, /games/<id>. */
  newGame(color: Color): Promise<void>;
  /** Shows what a pathname addresses: /games/<id> opens that game, anything else the new-game page. */
  navigate(pathname: string): Promise<void>;
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

function statusOf(e: unknown): number | null {
  return e instanceof ApiRequestError ? e.status : null;
}

/** A failure that means the server could not be reached or is restarting (not "game not found"). */
function isUnreachable(e: unknown): boolean {
  const status = statusOf(e);
  return status === 0 || (status !== null && status >= 500);
}

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
  const timers = deps.timers ?? defaultTimers;
  let source: EventSourceLike | null = null;
  /** The game this controller shows (from a new game or the address); null on "/". */
  let currentId: string | null = null;
  /** Bumped whenever the shown game changes, so late replies for an old one are dropped. */
  let generation = 0;
  let retryTimer: unknown = null;
  let attempt = 0;

  function closeSource(): void {
    source?.close();
    source = null;
  }

  function cancelRetry(): void {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }

  /** Forgets the shown game: no stream, no retry, late replies ignored. */
  function leave(): void {
    generation++;
    cancelRetry();
    closeSource();
    currentId = null;
    attempt = 0;
  }

  function showNotFound(): void {
    generation++;
    cancelRetry();
    closeSource();
    attempt = 0;
    dispatch({ type: "game_not_found" });
  }

  /** Shows "Reconnecting…" and schedules the next GET + EventSource with backoff. */
  function startReconnecting(): void {
    const id = currentId;
    if (id === null) return;
    closeSource();
    dispatch({ type: "reconnecting", message: null });
    if (retryTimer !== null) return;
    const gen = generation;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (gen === generation) void load(id, gen, "reconnect");
    }, reconnectDelay(attempt++));
  }

  /** GET the game, show it, then open its stream. Only a 404 means not found. */
  async function load(id: string, gen: number, mode: "open" | "reconnect"): Promise<void> {
    let game: GameView;
    try {
      game = await api.getGame(id);
    } catch (e) {
      if (gen !== generation) return;
      if (statusOf(e) === 404) showNotFound();
      else startReconnecting();
      return;
    }
    if (gen !== generation) return;
    dispatch(mode === "open" ? { type: "game_started", game } : { type: "reconnected", game });
    subscribe(id);
  }

  /**
   * After a failed request for game `id`: a 404 shows "Game not found", an unreachable server
   * starts reconnecting (after `report` has shown what was lost). Returns true when handled.
   */
  function handleLostServer(id: string, e: unknown, report: () => void, unreachable = isUnreachable(e)): boolean {
    if (currentId !== id) return false;
    if (statusOf(e) === 404) {
      showNotFound();
      return true;
    }
    if (!unreachable) return false;
    report();
    startReconnecting();
    return true;
  }

  function subscribe(gameId: string): void {
    closeSource();
    const es = deps.openEvents(api.eventsUrl(gameId));
    source = es;
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        if (source !== es) return;
        if (type === "error" && ev.data === undefined) {
          // Connection error, not a server "error" event: the stream dropped or never opened
          // (a 502 during a deploy closes it for good). Take over from the browser's own retry:
          // GET the game, then open a new stream, so the state comes from the fresh view (#47).
          startReconnecting();
          return;
        }
        const event = parseEvent(ev.data);
        if (!event) return;
        attempt = 0; // the stream is live: the next drop starts the backoff again
        dispatch({ type: "server_event", event });
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
      const report = () => dispatch({ type: "move_rejected", message: MOVE_NOT_SENT });
      if (!handleLostServer(game.id, e, report)) dispatch({ type: "move_rejected", message: messageOf(e) });
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
      const report = () => dispatch({ type: "request_failed", message: REQUEST_NOT_SENT });
      if (!handleLostServer(game.id, e, report)) dispatch({ type: "request_failed", message: messageOf(e) });
    }
  }

  /** Hint and Show me: a 503 means coaching is unavailable (a notice), not a lost server. */
  function tutorFailed(id: string, e: unknown): void {
    const status = statusOf(e);
    const unreachable = status === 0 || (status !== null && status >= 500 && status !== 503);
    const notice = () => {
      if (getState().game?.id === id) dispatch({ type: "tutor_notice", message: messageOf(e) });
    };
    if (!handleLostServer(id, e, notice, unreachable)) notice();
  }

  return {
    async newGame(color) {
      leave();
      const gen = generation;
      dispatch({ type: "request_started" });
      try {
        const game = await api.newGame(color);
        if (gen !== generation) return; // the player navigated away meanwhile
        currentId = game.id;
        dispatch({ type: "game_started", game });
        deps.pushPath?.(gamePath(game.id));
        subscribe(game.id);
      } catch (e) {
        if (gen === generation) dispatch({ type: "request_failed", message: messageOf(e) });
      }
    },

    async navigate(pathname) {
      const id = gameIdFromPath(pathname);
      if (id === null) {
        const s = getState();
        if (currentId !== null || s.game !== null || s.notFound || s.loading || s.reconnecting) {
          leave();
          dispatch({ type: "game_closed" });
        }
        return;
      }
      if (id === currentId) return;
      leave();
      currentId = id;
      dispatch({ type: "game_opening" });
      await load(id, generation, "open");
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
        tutorFailed(id, e);
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
        tutorFailed(id, e);
      }
    },

    dispose() {
      leave();
    },
  };
}
