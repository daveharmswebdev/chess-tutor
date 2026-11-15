// Game survival on the browser side (#47: NFR-14, NFR-9, FR-4, IR-5): the game's address is
// /games/<id>, a refresh rebuilds the page from GET + SSE, an unreachable server shows
// "Reconnecting…" and retries with backoff, and only a 404 offers a new game.
import type { GameView } from "@chess-tutor/chess-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError, type ApiClient } from "../src/api.ts";
import { createGameController, reconnectDelay, type EventSourceLike, type Timers } from "../src/controller.ts";
import { ConnectionNotice } from "../src/ConnectionNotice.tsx";
import {
  canResign,
  canTakeback,
  gameReducer,
  initialGameState,
  isPlayersTurn,
  statusText,
  type GameAction,
  type GameState,
} from "../src/game-state.ts";
import { gamePath, gameIdFromPath } from "../src/routing.ts";
import { AFTER_D4_D5_FEN, AFTER_D4_FEN, D4, D5, question, reveal, tutorStatus, view } from "./fixtures.ts";

class FakeEventSource implements EventSourceLike {
  readyState = 1;
  closed = false;
  readonly listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown): void {
    const ev = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

/** Timers run only when the test says so. */
class FakeTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  readonly scheduled: number[] = [];
  setTimeout(fn: () => void, ms: number): number {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    this.scheduled.push(ms);
    return id;
  }
  clearTimeout(id: unknown): void {
    this.pending.delete(id as number);
  }
  /** Runs every timer due now; returns the delays fired. */
  async fire(): Promise<number[]> {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, t] of due) t.fn();
    await flush();
    return due.map(([, t]) => t.ms);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const unexpected = async (): Promise<never> => {
  throw new Error("unexpected call");
};

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    newGame: unexpected,
    getGame: unexpected,
    playMove: unexpected,
    takeback: unexpected,
    resign: unexpected,
    botRetry: unexpected,
    tutorHint: unexpected,
    tutorReveal: unexpected,
    eventsUrl: (id) => `/api/games/${id}/events`,
    ...overrides,
  };
}

function harness(api: ApiClient) {
  let state: GameState = initialGameState;
  const sources: FakeEventSource[] = [];
  const pushed: string[] = [];
  const timers = new FakeTimers();
  const controller = createGameController({
    api,
    openEvents: (url) => {
      const s = new FakeEventSource(url);
      sources.push(s);
      return s;
    },
    dispatch: (a: GameAction) => {
      state = gameReducer(state, a);
    },
    getState: () => state,
    timers,
    pushPath: (path) => pushed.push(path),
  });
  return { controller, sources, pushed, timers, state: () => state, last: () => sources.at(-1)! };
}

/** Answers getGame from a script: each entry is a view, an error, or a status to throw. */
function scriptedGet(script: Array<GameView | number>): { api: Partial<ApiClient>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    api: {
      getGame: async (id) => {
        calls.push(id);
        const next = script.shift();
        if (next === undefined) throw new Error("no more scripted replies");
        if (typeof next === "number") {
          throw new ApiRequestError(next, next === 0 ? "Cannot reach the game server." : `Server error (${next}).`);
        }
        return next;
      },
    },
  };
}

const afterD5 = (overrides: Partial<GameView> = {}) => view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5], ...overrides });

describe("routing", () => {
  it("maps a game id to /games/<id> and back", () => {
    expect(gamePath("abc-123")).toBe("/games/abc-123");
    expect(gameIdFromPath("/games/abc-123")).toBe("abc-123");
    expect(gameIdFromPath("/games/abc-123/")).toBe("abc-123");
    expect(gameIdFromPath(gamePath("a b"))).toBe("a b");
    expect(gameIdFromPath("/")).toBeNull();
    expect(gameIdFromPath("/games/")).toBeNull();
    expect(gameIdFromPath("/other")).toBeNull();
    expect(gameIdFromPath("/games/a/b")).toBeNull();
  });
});

describe("new game and history", () => {
  it("pushes /games/<id> when a game starts", async () => {
    const h = harness(fakeApi({ newGame: async () => view({ id: "g7" }) }));
    await h.controller.newGame("w");
    expect(h.pushed).toEqual(["/games/g7"]);
  });

  it("does not push when the new game fails", async () => {
    const h = harness(fakeApi({ newGame: async () => Promise.reject(new ApiRequestError(0, "Cannot reach the game server.")) }));
    await h.controller.newGame("w");
    expect(h.pushed).toEqual([]);
  });

  it("back to / closes the game and its stream; forward reopens it from GET", async () => {
    const get = scriptedGet([afterD5({ id: "g7" })]);
    const h = harness(fakeApi({ newGame: async () => view({ id: "g7" }), ...get.api }));
    await h.controller.newGame("w");
    const first = h.last();
    await h.controller.navigate("/");
    expect(first.closed).toBe(true);
    expect(h.state().game).toBeNull();
    expect(statusText(h.state())).toBe("Choose a color and start a new game.");
    await h.controller.navigate("/games/g7");
    expect(get.calls).toEqual(["g7"]);
    expect(h.state().game?.moves).toEqual([D4, D5]);
    expect(h.last()).not.toBe(first);
    expect(h.last().url).toBe("/api/games/g7/events");
    expect(h.pushed).toEqual(["/games/g7"]); // navigation from popstate does not push again
  });

  it("navigating to the game already shown does nothing", async () => {
    const get = scriptedGet([]);
    const h = harness(fakeApi({ newGame: async () => view({ id: "g7" }), ...get.api }));
    await h.controller.newGame("w");
    await h.controller.navigate("/games/g7");
    expect(get.calls).toEqual([]);
    expect(h.sources).toHaveLength(1);
  });
});

describe("refresh rebuilds the page from GET /api/games/:id", () => {
  it("loads board, moves and status, then opens the SSE stream", async () => {
    const get = scriptedGet([afterD5()]);
    const h = harness(fakeApi(get.api));
    const opening = h.controller.navigate("/games/g1");
    expect(statusText(h.state())).toBe("Loading the game…");
    expect(isPlayersTurn(h.state())).toBe(false);
    await opening;
    expect(get.calls).toEqual(["g1"]);
    expect(h.state().game?.fen).toBe(AFTER_D4_D5_FEN);
    expect(h.state().game?.moves).toEqual([D4, D5]);
    expect(statusText(h.state())).toBe("Your move.");
    expect(h.sources.map((s) => s.url)).toEqual(["/api/games/g1/events"]);
    // The first "state" on the stream is the truth.
    h.last().emit("state", { type: "state", game: afterD5({ botThinking: true }) });
    expect(h.state().game?.botThinking).toBe(true);
  });

  it("rebuilds the tutor panel's open question", async () => {
    const q = question();
    const h = harness(fakeApi(scriptedGet([afterD5({ tutor: tutorStatus({ question: q }) })]).api));
    await h.controller.navigate("/games/g1");
    expect(h.state().tutor.question).toEqual(q);
    expect(h.state().tutor.open).toBe(true);
    expect(h.state().tutor.reveal).toBeNull();
  });

  it("rebuilds a reveal already shown (tutor.reveal)", async () => {
    const q = question();
    const r = reveal();
    const h = harness(fakeApi(scriptedGet([afterD5({ tutor: tutorStatus({ question: q, reveal: r }) })]).api));
    await h.controller.navigate("/games/g1");
    expect(h.state().tutor.question).toEqual(q);
    expect(h.state().tutor.reveal).toEqual(r);
  });

  it("ignores a reveal for another question, and reveal null", async () => {
    const h = harness(
      fakeApi(scriptedGet([afterD5({ tutor: tutorStatus({ question: question(), reveal: reveal({ questionId: "other" }) }) })]).api),
    );
    await h.controller.navigate("/games/g1");
    expect(h.state().tutor.reveal).toBeNull();
    const h2 = harness(fakeApi(scriptedGet([afterD5({ tutor: tutorStatus({ question: question(), reveal: null }) })]).api));
    await h2.controller.navigate("/games/g1");
    expect(h2.state().tutor.reveal).toBeNull();
  });

  it("a reveal arriving in a later state event (another tab pressed Show me) is shown", async () => {
    const q = question();
    const h = harness(fakeApi(scriptedGet([afterD5({ tutor: tutorStatus({ question: q }) })]).api));
    await h.controller.navigate("/games/g1");
    h.last().emit("state", { type: "state", game: afterD5({ tutor: tutorStatus({ question: q, reveal: reveal() }) }) });
    expect(h.state().tutor.reveal).toEqual(reveal());
  });

  it("loads a finished game too", async () => {
    const over = afterD5({ status: "finished", result: "0-1", endReason: "resigned" });
    const h = harness(fakeApi(scriptedGet([over]).api));
    await h.controller.navigate("/games/g1");
    expect(statusText(h.state())).toBe("You resigned. The bot wins (0-1).");
  });
});

describe("only a 404 means game not found", () => {
  it("GET 404 shows Game not found and opens no stream", async () => {
    const h = harness(fakeApi(scriptedGet([404]).api));
    await h.controller.navigate("/games/nope");
    expect(h.state().notFound).toBe(true);
    expect(h.state().reconnecting).toBe(false);
    expect(h.state().game).toBeNull();
    expect(h.sources).toHaveLength(0);
    expect(h.timers.pending.size).toBe(0);
    expect(statusText(h.state())).toBe("Game not found.");
  });

  it("a 404 from a move shows Game not found", async () => {
    const h = harness(fakeApi({ ...scriptedGet([afterD5()]).api, playMove: async () => Promise.reject(new ApiRequestError(404, "x")) }));
    await h.controller.navigate("/games/g1");
    await h.controller.play("c1", "f4");
    expect(h.state().notFound).toBe(true);
    expect(h.last().closed).toBe(true);
  });

  it("a 404 from takeback shows Game not found", async () => {
    const h = harness(fakeApi({ ...scriptedGet([afterD5()]).api, takeback: async () => Promise.reject(new ApiRequestError(404, "x")) }));
    await h.controller.navigate("/games/g1");
    await h.controller.takeback();
    expect(h.state().notFound).toBe(true);
  });

  it("starting a new game clears Game not found", async () => {
    const h = harness(fakeApi({ ...scriptedGet([404]).api, newGame: async () => view({ id: "g2" }) }));
    await h.controller.navigate("/games/nope");
    await h.controller.newGame("w");
    expect(h.state().notFound).toBe(false);
    expect(h.state().game?.id).toBe("g2");
    expect(h.pushed).toEqual(["/games/g2"]);
  });

  it("renders Game not found with a New game action, and nothing while connected", () => {
    const calls: string[] = [];
    const onNewGame = () => void calls.push("new");
    const notFound = renderToStaticMarkup(
      createElement(ConnectionNotice, { state: { ...initialGameState, notFound: true }, onNewGame }),
    );
    expect(notFound).toContain('data-testid="game-not-found"');
    expect(notFound).toContain("Game not found.");
    expect(notFound).toContain('data-testid="not-found-new-game"');
    const ok = renderToStaticMarkup(createElement(ConnectionNotice, { state: initialGameState, onNewGame }));
    expect(ok).toBe("");
  });

  it("renders Reconnecting… without a New game action", () => {
    const out = renderToStaticMarkup(
      createElement(ConnectionNotice, { state: { ...initialGameState, reconnecting: true }, onNewGame: () => {} }),
    );
    expect(out).toContain('data-testid="reconnecting"');
    expect(out).toContain("Reconnecting…");
    expect(out).not.toContain("not-found-new-game");
    expect(out).not.toContain("Game not found");
  });
});

describe("reconnecting", () => {
  it("backoff: 0.5 s doubling to a 10 s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  });

  it("a 502 on load shows Reconnecting, retries with backoff, then recovers", async () => {
    const get = scriptedGet([502, 0, 502, afterD5()]);
    const h = harness(fakeApi(get.api));
    await h.controller.navigate("/games/g1");
    expect(h.state().reconnecting).toBe(true);
    expect(h.state().notFound).toBe(false);
    expect(h.state().error).toBeNull();
    expect(h.sources).toHaveLength(0);
    expect(await h.timers.fire()).toEqual([500]);
    expect(h.state().reconnecting).toBe(true);
    expect(await h.timers.fire()).toEqual([1000]);
    expect(h.state().reconnecting).toBe(true);
    expect(await h.timers.fire()).toEqual([2000]);
    expect(get.calls).toEqual(["g1", "g1", "g1", "g1"]);
    expect(h.state().reconnecting).toBe(false);
    expect(h.state().game?.moves).toEqual([D4, D5]);
    expect(h.sources.map((s) => s.url)).toEqual(["/api/games/g1/events"]);
    expect(h.timers.pending.size).toBe(0);
  });

  it("the board is not playable and actions are off while reconnecting", async () => {
    const h = harness(fakeApi({ ...scriptedGet([afterD5(), 502]).api, playMove: unexpected }));
    await h.controller.navigate("/games/g1");
    expect(isPlayersTurn(h.state())).toBe(true);
    h.last().emit("error");
    expect(h.state().reconnecting).toBe(true);
    expect(isPlayersTurn(h.state())).toBe(false);
    expect(canTakeback(h.state())).toBe(false);
    expect(canResign(h.state())).toBe(false);
    expect(await h.controller.play("c1", "f4")).toBe(false); // blocked, no request sent
    expect(h.state().game?.moves).toEqual([D4, D5]); // the board stays visible
  });

  it("an EventSource drop closes it, GETs the game and opens a new stream", async () => {
    const fresh = afterD5({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true });
    const get = scriptedGet([afterD5(), fresh]);
    const h = harness(fakeApi(get.api));
    await h.controller.navigate("/games/g1");
    const first = h.last();
    first.readyState = 0; // the browser would retry on its own; we take over
    first.emit("error");
    expect(first.closed).toBe(true);
    expect(h.state().reconnecting).toBe(true);
    expect(h.state().error).toBeNull();
    // Events from the dead stream are ignored.
    first.emit("state", { type: "state", game: view() });
    expect(h.state().game?.moves).toEqual([D4, D5]);
    expect(await h.timers.fire()).toEqual([500]);
    expect(get.calls).toEqual(["g1", "g1"]);
    expect(h.state().reconnecting).toBe(false);
    expect(h.state().game?.moves).toEqual([D4]); // fresh GameView, not the old one
    expect(h.sources).toHaveLength(2);
    expect(h.last()).not.toBe(first);
    h.last().emit("state", { type: "state", game: afterD5() });
    expect(h.state().game?.moves).toEqual([D4, D5]);
  });

  it("a stream that drops again keeps backing off until a state event arrives", async () => {
    const get = scriptedGet([afterD5(), afterD5(), afterD5(), afterD5()]);
    const h = harness(fakeApi(get.api));
    await h.controller.navigate("/games/g1");
    h.last().emit("error");
    expect(await h.timers.fire()).toEqual([500]);
    h.last().emit("error"); // GET worked, but the stream failed before any event
    expect(await h.timers.fire()).toEqual([1000]);
    h.last().emit("state", { type: "state", game: afterD5() }); // live: backoff resets
    h.last().emit("error");
    expect(await h.timers.fire()).toEqual([500]);
  });

  it("a 404 while reconnecting stops retrying and offers a new game", async () => {
    const h = harness(fakeApi(scriptedGet([afterD5(), 502, 404]).api));
    await h.controller.navigate("/games/g1");
    h.last().emit("error");
    await h.timers.fire();
    expect(h.state().reconnecting).toBe(true);
    await h.timers.fire();
    expect(h.state().reconnecting).toBe(false);
    expect(h.state().notFound).toBe(true);
    expect(h.timers.pending.size).toBe(0);
  });

  it("a move that fails with a network error or 5xx is not lost silently", async () => {
    for (const status of [0, 502]) {
      const h = harness(
        fakeApi({ ...scriptedGet([afterD5(), afterD5()]).api, playMove: async () => Promise.reject(new ApiRequestError(status, "x")) }),
      );
      await h.controller.navigate("/games/g1");
      expect(await h.controller.play("c1", "f4")).toBe(false);
      expect(h.state().pendingFen).toBeNull(); // snapped back
      expect(h.state().error).toBe("Your move was not sent: the game server is unreachable. Play it again once reconnected.");
      expect(h.state().reconnecting).toBe(true);
      expect(h.state().notFound).toBe(false);
      await h.timers.fire();
      expect(h.state().reconnecting).toBe(false);
      expect(isPlayersTurn(h.state())).toBe(true);
    }
  });

  it("a takeback that fails with a 5xx starts reconnecting, not game not found", async () => {
    const h = harness(fakeApi({ ...scriptedGet([afterD5()]).api, takeback: async () => Promise.reject(new ApiRequestError(503, "x")) }));
    await h.controller.navigate("/games/g1");
    await h.controller.takeback();
    expect(h.state().reconnecting).toBe(true);
    expect(h.state().notFound).toBe(false);
  });

  it("a 503 from Hint is a tutor notice, not a reconnect (coaching unavailable)", async () => {
    const h = harness(
      fakeApi({ ...scriptedGet([afterD5()]).api, tutorHint: async () => Promise.reject(new ApiRequestError(503, "Coaching is off.")) }),
    );
    await h.controller.navigate("/games/g1");
    await h.controller.hint();
    expect(h.state().tutor.notice).toBe("Coaching is off.");
    expect(h.state().reconnecting).toBe(false);
  });

  it("a GET reply for a game the user left is ignored", async () => {
    let resolve: (g: GameView) => void = () => {};
    const h = harness(fakeApi({ getGame: () => new Promise<GameView>((r) => (resolve = r)) }));
    const opening = h.controller.navigate("/games/g1");
    await h.controller.navigate("/");
    resolve(afterD5());
    await opening;
    expect(h.state().game).toBeNull();
    expect(h.sources).toHaveLength(0);
  });

  it("leaving the game while reconnecting cancels the retry", async () => {
    const h = harness(fakeApi(scriptedGet([502]).api));
    await h.controller.navigate("/games/g1");
    expect(h.timers.pending.size).toBe(1);
    await h.controller.navigate("/");
    expect(h.timers.pending.size).toBe(0);
    expect(h.state().reconnecting).toBe(false);
  });

  it("dispose cancels the retry and closes the stream", async () => {
    const h = harness(fakeApi(scriptedGet([afterD5()]).api));
    await h.controller.navigate("/games/g1");
    h.last().emit("error");
    expect(h.timers.pending.size).toBe(1);
    h.controller.dispose();
    expect(h.timers.pending.size).toBe(0);
  });

  it("after dispose, navigating to the same game opens it again (React StrictMode remount)", async () => {
    const get = scriptedGet([afterD5(), afterD5()]);
    const h = harness(fakeApi(get.api));
    await h.controller.navigate("/games/g1");
    h.controller.dispose();
    await h.controller.navigate("/games/g1");
    expect(get.calls).toEqual(["g1", "g1"]);
    expect(h.last().closed).toBe(false);
  });
});
