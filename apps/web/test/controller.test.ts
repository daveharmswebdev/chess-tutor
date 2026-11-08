import type { GameView } from "@chess-tutor/chess-core";
import { describe, expect, it } from "vitest";
import { ApiRequestError, type ApiClient } from "../src/api.ts";
import { createGameController, type EventSourceLike } from "../src/controller.ts";
import {
  boardFen,
  canHint,
  canRetryBot,
  canReveal,
  gameReducer,
  initialGameState,
  isPlayersTurn,
  tutorStatusOf,
  type GameAction,
  type GameState,
} from "../src/game-state.ts";
import { AFTER_D4_D5_FEN, AFTER_D4_FEN, BF4, D4, D5, START_FEN, question, reveal, tutorStatus, view } from "./fixtures.ts";

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
  emitRaw(type: string, data: string): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const unexpected = async (): Promise<GameView> => {
    throw new Error("unexpected call");
  };
  return {
    newGame: unexpected,
    getGame: unexpected,
    playMove: unexpected,
    takeback: unexpected,
    resign: unexpected,
    botRetry: unexpected,
    tutorHint: async () => {
      throw new Error("unexpected call");
    },
    tutorReveal: async () => {
      throw new Error("unexpected call");
    },
    eventsUrl: (id) => `/api/games/${id}/events`,
    ...overrides,
  };
}

function harness(api: ApiClient) {
  let state: GameState = initialGameState;
  const actions: GameAction[] = [];
  const sources: FakeEventSource[] = [];
  const controller = createGameController({
    api,
    openEvents: (url) => {
      const s = new FakeEventSource(url);
      sources.push(s);
      return s;
    },
    dispatch: (a) => {
      actions.push(a);
      state = gameReducer(state, a);
    },
    getState: () => state,
  });
  return { controller, actions, sources, state: () => state };
}

describe("game controller", () => {
  it("starts a game and subscribes to its events", async () => {
    const h = harness(fakeApi({ newGame: async () => view({ playerColor: "b", botThinking: true }) }));
    await h.controller.newGame("b");
    expect(h.state().game?.playerColor).toBe("b");
    expect(h.sources.map((s) => s.url)).toEqual(["/api/games/g1/events"]);
  });

  it("closes the old event stream when a new game starts, and on dispose", async () => {
    let n = 0;
    const h = harness(fakeApi({ newGame: async () => view({ id: `g${++n}` }) }));
    await h.controller.newGame("w");
    await h.controller.newGame("w");
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.sources[1]?.closed).toBe(false);
    h.controller.dispose();
    expect(h.sources[1]?.closed).toBe(true);
  });

  it("feeds state, bot_move, game_over and error events into the reducer", async () => {
    const h = harness(fakeApi({ newGame: async () => view() }));
    await h.controller.newGame("w");
    const es = h.sources[0]!;
    es.emit("state", { type: "state", game: view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true }) });
    expect(h.state().game?.moves).toEqual([D4]);
    es.emit("bot_move", { type: "bot_move", move: D5, game: view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }) });
    expect(h.state().game?.moves).toEqual([D4, D5]);
    es.emit("error", { type: "error", message: "engine timed out" });
    expect(h.state().error).toBe("engine timed out");
    es.emit("game_over", { type: "game_over", game: view({ status: "finished", result: "0-1", endReason: "resigned" }) });
    expect(h.state().game?.status).toBe("finished");
  });

  it("treats a data-less error (connection drop) as a reconnect, not a game error", async () => {
    const h = harness(fakeApi({ newGame: async () => view() }));
    await h.controller.newGame("w");
    const es = h.sources[0]!;
    es.readyState = 0; // CONNECTING: the browser reconnects and the server resends "state"
    es.emit("error");
    expect(h.state().error).toBeNull();
    es.readyState = 2; // CLOSED: gave up
    es.emit("error");
    expect(h.state().error).toBe("Lost the connection to the game server.");
  });

  it("ignores malformed event data", async () => {
    const h = harness(fakeApi({ newGame: async () => view() }));
    await h.controller.newGame("w");
    h.sources[0]!.emitRaw("state", "{not json");
    expect(h.state().game?.moves).toEqual([]);
    expect(h.state().error).toBeNull();
  });

  it("plays a legal move: optimistic position, then the server's view", async () => {
    const sent: string[] = [];
    const h = harness(
      fakeApi({
        newGame: async () => view(),
        playMove: async (_id, uci) => {
          sent.push(uci);
          expect(boardFen(h.state())).toBe(AFTER_D4_FEN); // optimistic while in flight
          return view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true });
        },
      }),
    );
    await h.controller.newGame("w");
    expect(await h.controller.play("d2", "d4")).toBe(true);
    expect(sent).toEqual(["d2d4"]);
    expect(h.state().game?.botThinking).toBe(true);
  });

  it("does not send a move the client already knows is illegal, or when it is not the player's turn", async () => {
    const h = harness(fakeApi({ newGame: async () => view({ botThinking: true }) }));
    await h.controller.newGame("w");
    expect(await h.controller.play("d2", "d4")).toBe(false); // bot thinking
    h.sources[0]!.emit("state", { type: "state", game: view() });
    expect(await h.controller.play("d2", "d5")).toBe(false); // illegal
  });

  it("snaps back after the server rejects a move with 400", async () => {
    const h = harness(
      fakeApi({
        newGame: async () => view(),
        playMove: async () => {
          throw new ApiRequestError(400, "That move was not accepted: illegal");
        },
      }),
    );
    await h.controller.newGame("w");
    expect(await h.controller.play("d2", "d4")).toBe(false);
    expect(boardFen(h.state())).toBe(START_FEN);
    expect(h.state().error).toBe("That move was not accepted: illegal");
  });

  it("takes back and resigns through the API", async () => {
    const h = harness(
      fakeApi({
        newGame: async () => view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }),
        takeback: async () => view(),
        resign: async () => view({ status: "finished", result: "0-1", endReason: "resigned" }),
      }),
    );
    await h.controller.newGame("w");
    await h.controller.takeback();
    expect(h.state().game?.moves).toEqual([]);
    await h.controller.resign();
    expect(h.state().game?.endReason).toBe("resigned");
  });

  it("shows a 409 from takeback as an error and keeps the game", async () => {
    const h = harness(
      fakeApi({
        newGame: async () => view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }),
        takeback: async () => {
          throw new ApiRequestError(409, "Not possible right now: bot is thinking");
        },
      }),
    );
    await h.controller.newGame("w");
    await h.controller.takeback();
    expect(h.state().error).toBe("Not possible right now: bot is thinking");
    expect(h.state().game?.moves).toEqual([D4, D5]);
    expect(h.state().busy).toBe(false);
  });

  it("moves by clicking source then target square", async () => {
    const sent: string[] = [];
    const h = harness(
      fakeApi({
        newGame: async () => view(),
        playMove: async (_id, uci) => {
          sent.push(uci);
          return view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true });
        },
      }),
    );
    await h.controller.newGame("w");
    await h.controller.clickSquare("d2");
    expect(h.state().selected).toBe("d2");
    await h.controller.clickSquare("d4");
    expect(sent).toEqual(["d2d4"]);
    expect(h.state().selected).toBeNull();
  });

  it("click selection: own piece selects, another own piece reselects, empty or illegal clears", async () => {
    const h = harness(fakeApi({ newGame: async () => view() }));
    await h.controller.newGame("w");
    await h.controller.clickSquare("e5"); // empty, nothing selected
    expect(h.state().selected).toBeNull();
    await h.controller.clickSquare("d7"); // opponent's piece
    expect(h.state().selected).toBeNull();
    await h.controller.clickSquare("d2");
    await h.controller.clickSquare("g1");
    expect(h.state().selected).toBe("g1");
    await h.controller.clickSquare("g1"); // same square toggles off
    expect(h.state().selected).toBeNull();
    await h.controller.clickSquare("d2");
    await h.controller.clickSquare("d5"); // not a legal target
    expect(h.state().selected).toBeNull();
  });

  it("ignores clicks while the board is locked", async () => {
    const h = harness(fakeApi({ newGame: async () => view({ botThinking: true }) }));
    await h.controller.newGame("w");
    await h.controller.clickSquare("d2");
    expect(h.state().selected).toBeNull();
  });

  it("reports a failed new-game request", async () => {
    const h = harness(
      fakeApi({
        newGame: async () => {
          throw new ApiRequestError(0, "Cannot reach the game server.");
        },
      }),
    );
    await h.controller.newGame("w");
    expect(h.state().error).toBe("Cannot reach the game server.");
    expect(h.sources).toEqual([]);
  });

  it("retries the bot after a failure and shows the bot thinking; the move then arrives over SSE (#23)", async () => {
    const retried: string[] = [];
    const h = harness(
      fakeApi({
        newGame: async () => view({ playerColor: "b", botThinking: true }),
        botRetry: async (id) => {
          retried.push(id);
          return view({ playerColor: "b", botThinking: true });
        },
      }),
    );
    await h.controller.newGame("b");
    const es = h.sources[0]!;
    es.emit("state", { type: "state", game: view({ playerColor: "b" }) });
    es.emit("error", { type: "error", message: "engine crashed" });
    expect(h.state().error).toBe("engine crashed");

    await h.controller.retryBot();
    expect(retried).toEqual(["g1"]);
    expect(h.actions.at(-1)).toEqual({ type: "request_succeeded", game: view({ playerColor: "b", botThinking: true }) });
    expect(h.state().game?.botThinking).toBe(true);
    expect(h.state().error).toBeNull();

    const e4 = { uci: "e2e4", san: "e4", by: "bot" as const };
    es.emit("bot_move", { type: "bot_move", move: e4, game: view({ playerColor: "b", fen: AFTER_D4_FEN, moves: [e4] }) });
    expect(h.state().game?.moves).toEqual([e4]);
  });

  it("does not call bot-retry when no retry is needed, and shows a 409 as an error", async () => {
    let calls = 0;
    const h = harness(
      fakeApi({
        newGame: async () => view(),
        botRetry: async () => {
          calls++;
          throw new ApiRequestError(409, "Not possible right now: not the bot's turn");
        },
      }),
    );
    await h.controller.newGame("w");
    await h.controller.retryBot(); // player's turn: no request
    expect(calls).toBe(0);
    h.sources[0]!.emit("state", { type: "state", game: view({ fen: AFTER_D4_FEN, moves: [D4] }) });
    await h.controller.retryBot();
    expect(calls).toBe(1);
    expect(h.state().error).toBe("Not possible right now: not the bot's turn");
    expect(h.state().busy).toBe(false);
  });

  describe("SSE events that overtake the HTTP reply win (#23)", () => {
    const blackFresh = view({ playerColor: "b" });
    const blackThinking = view({ playerColor: "b", botThinking: true });
    const e4 = { uci: "e2e4", san: "e4", by: "bot" as const };
    const afterE4 = view({ playerColor: "b", fen: AFTER_D4_FEN.replace("3P4/8/PPP1PPPP", "4P3/8/PPPP1PPP"), moves: [e4] });

    async function failedBlackGame(botRetry: ApiClient["botRetry"]) {
      const h = harness(fakeApi({ newGame: async () => blackThinking, botRetry }));
      await h.controller.newGame("b");
      const es = h.sources[0]!;
      es.emit("state", { type: "state", game: blackFresh });
      es.emit("error", { type: "error", message: "engine crashed" });
      return { h, es };
    }

    it("(a) retry: state{botThinking:false} and error before the reply leave Retry available", async () => {
      let es: FakeEventSource | undefined;
      const { h, es: source } = await failedBlackGame(async () => {
        es!.emit("state", { type: "state", game: blackFresh });
        es!.emit("error", { type: "error", message: "engine crashed again" });
        return blackThinking;
      });
      es = source;
      await h.controller.retryBot();
      expect(h.state().game?.botThinking).toBe(false);
      expect(h.state().error).toBe("engine crashed again");
      expect(h.state().busy).toBe(false);
      expect(canRetryBot(h.state())).toBe(true);
    });

    it("(b) retry: a bot_move before the reply keeps the bot's move", async () => {
      let es: FakeEventSource | undefined;
      const { h, es: source } = await failedBlackGame(async () => {
        es!.emit("bot_move", { type: "bot_move", move: e4, game: afterE4 });
        return blackThinking;
      });
      es = source;
      await h.controller.retryBot();
      expect(h.state().game).toEqual(afterE4);
      expect(h.state().error).toBeNull();
      expect(isPlayersTurn(h.state())).toBe(true);
    });

    it("(c) player move: state and error before the reply do not leave the board stuck", async () => {
      let es: FakeEventSource | undefined;
      const h = harness(
        fakeApi({
          newGame: async () => view(),
          playMove: async () => {
            es!.emit("state", { type: "state", game: view({ fen: AFTER_D4_FEN, moves: [D4] }) });
            es!.emit("error", { type: "error", message: "engine crashed" });
            return view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true });
          },
        }),
      );
      await h.controller.newGame("w");
      es = h.sources[0]!;
      expect(await h.controller.play("d2", "d4")).toBe(true);
      expect(h.state().game?.botThinking).toBe(false);
      expect(h.state().game?.moves).toEqual([D4]);
      expect(h.state().error).toBe("engine crashed");
      expect(h.state().pendingFen).toBeNull();
      expect(canRetryBot(h.state())).toBe(true);
    });

    it("takeback and resign: an SSE event before the reply wins too", async () => {
      let es: FakeEventSource | undefined;
      const over = view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5], status: "finished", result: "0-1", endReason: "resigned" });
      const h = harness(
        fakeApi({
          newGame: async () => view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }),
          takeback: async () => {
            es!.emit("state", { type: "state", game: view({ moves: [] }) });
            return view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }); // deliberately stale
          },
          resign: async () => {
            es!.emit("game_over", { type: "game_over", game: over });
            return view();
          },
        }),
      );
      await h.controller.newGame("w");
      es = h.sources[0]!;
      await h.controller.takeback();
      expect(h.state().game?.moves).toEqual([]);
      expect(h.state().busy).toBe(false);
      await h.controller.resign();
      expect(h.state().game).toEqual(over);
    });

    it("(d) HTTP then SSE still works for moves, takeback, resign and retry", async () => {
      const h = harness(
        fakeApi({
          newGame: async () => view(),
          playMove: async () => view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true }),
          takeback: async () => view(),
          resign: async () => view({ status: "finished", result: "0-1", endReason: "resigned" }),
          botRetry: async () => view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true }),
        }),
      );
      await h.controller.newGame("w");
      const es = h.sources[0]!;
      expect(await h.controller.play("d2", "d4")).toBe(true);
      expect(h.state().game?.botThinking).toBe(true);
      es.emit("state", { type: "state", game: view({ fen: AFTER_D4_FEN, moves: [D4] }) });
      es.emit("error", { type: "error", message: "engine crashed" });
      expect(canRetryBot(h.state())).toBe(true);

      await h.controller.retryBot();
      expect(h.state().game?.botThinking).toBe(true);
      expect(h.state().error).toBeNull();
      es.emit("bot_move", { type: "bot_move", move: D5, game: view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }) });
      expect(h.state().game?.moves).toEqual([D4, D5]);

      await h.controller.takeback();
      expect(h.state().game?.moves).toEqual([]);
      await h.controller.resign();
      expect(h.state().game?.endReason).toBe("resigned");
    });
  });
});

describe("game controller: tutor (#7: FR-8, FR-11, FR-12, NFR-1, NFR-9)", () => {
  const afterD5 = (overrides: Parameters<typeof view>[0] = {}) => view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5], ...overrides });

  it("feeds every tutor_* event into the reducer", async () => {
    const h = harness(fakeApi({ newGame: async () => afterD5() }));
    await h.controller.newGame("w");
    const es = h.sources[0]!;
    es.emit("tutor_thinking", { type: "tutor_thinking", kind: "opponent_left_book" });
    expect(tutorStatusOf(h.state()).thinking).toBe(true);
    es.emit("tutor_progress", { type: "tutor_progress", label: "Checking Bf4…" });
    expect(h.state().tutor.progress).toBe("Checking Bf4…");
    es.emit("tutor_reply", { type: "tutor_reply", question: question() });
    expect(h.state().tutor.question?.id).toBe("q1");
    es.emit("tutor_reveal", { type: "tutor_reveal", reveal: reveal() });
    expect(h.state().tutor.reveal).toEqual(reveal());
    es.emit("tutor_attempt", { type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 0 });
    expect(h.state().tutor.attempt?.correct).toBe(true);
    es.emit("tutor_failed", { type: "tutor_failed", message: "The tutor could not answer." });
    expect(h.state().tutor.failed).toBe("The tutor could not answer.");
  });

  it("ignores malformed tutor events", async () => {
    const h = harness(fakeApi({ newGame: async () => afterD5() }));
    await h.controller.newGame("w");
    const es = h.sources[0]!;
    es.emit("tutor_reply", { type: "tutor_reply" });
    es.emit("tutor_progress", { type: "tutor_progress", label: 3 });
    es.emit("tutor_attempt", { type: "tutor_attempt", questionId: "q1" });
    es.emitRaw("tutor_reveal", "{nope");
    expect(h.state().tutor).toEqual(initialGameState.tutor);
  });

  it("asks for a hint when allowed; the reply then arrives over SSE", async () => {
    const hinted: string[] = [];
    const h = harness(fakeApi({ newGame: async () => afterD5(), tutorHint: async (id) => void hinted.push(id) }));
    await h.controller.newGame("w");
    expect(canHint(h.state())).toBe(true);
    await h.controller.hint();
    expect(hinted).toEqual(["g1"]);
    expect(h.state().tutor.notice).toBeNull();
    h.sources[0]!.emit("tutor_thinking", { type: "tutor_thinking", kind: "hint" });
    h.sources[0]!.emit("tutor_reply", { type: "tutor_reply", question: question({ kind: "hint", canReveal: false }) });
    expect(h.state().tutor.question?.kind).toBe("hint");
  });

  it("the hint's SSE events may arrive before its 202: still no notice, question shown", async () => {
    let es: FakeEventSource | undefined;
    const h = harness(
      fakeApi({
        newGame: async () => afterD5(),
        tutorHint: async () => {
          es!.emit("tutor_thinking", { type: "tutor_thinking", kind: "hint" });
          es!.emit("tutor_reply", { type: "tutor_reply", question: question({ kind: "hint" }) });
        },
      }),
    );
    await h.controller.newGame("w");
    es = h.sources[0]!;
    await h.controller.hint();
    expect(h.state().tutor.question?.kind).toBe("hint");
    expect(tutorStatusOf(h.state()).thinking).toBe(false);
    expect(h.state().tutor.notice).toBeNull();
  });

  it("does not ask for a hint when it is not allowed", async () => {
    let calls = 0;
    const tutorHint = async () => void calls++;
    for (const game of [
      afterD5({ tutor: tutorStatus({ available: false, reason: "Coaching is off: no API key is set." }) }),
      afterD5({ tutor: tutorStatus({ thinking: true }) }),
      view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true }),
    ]) {
      const h = harness(fakeApi({ newGame: async () => game, tutorHint }));
      await h.controller.newGame("w");
      await h.controller.hint();
    }
    expect(calls).toBe(0);
  });

  it("shows 409 and 503 from Hint as a short notice, without throwing or touching the game", async () => {
    for (const [status, message] of [
      [409, "Not possible right now: the tutor is busy"],
      [503, "Coaching is not available right now."],
    ] as const) {
      const h = harness(
        fakeApi({
          newGame: async () => afterD5(),
          tutorHint: async () => {
            throw new ApiRequestError(status, message);
          },
        }),
      );
      await h.controller.newGame("w");
      await expect(h.controller.hint()).resolves.toBeUndefined();
      expect(h.state().tutor.notice).toBe(message);
      expect(h.state().error).toBeNull();
      expect(h.state().busy).toBe(false);
      expect(h.state().game?.moves).toEqual([D4, D5]);
    }
  });

  it("Show me: shows the reveal from the 200 reply", async () => {
    const h = harness(fakeApi({ newGame: async () => afterD5({ tutor: tutorStatus({ question: question() }) }), tutorReveal: async () => reveal() }));
    await h.controller.newGame("w");
    expect(canReveal(h.state())).toBe(true);
    await h.controller.reveal();
    expect(h.state().tutor.reveal).toEqual(reveal());
    expect(canReveal(h.state())).toBe(false);
  });

  it("Show me: the tutor_reveal event before the 200 reply gives the same state", async () => {
    let es: FakeEventSource | undefined;
    const h = harness(
      fakeApi({
        newGame: async () => afterD5({ tutor: tutorStatus({ question: question() }) }),
        tutorReveal: async () => {
          es!.emit("tutor_reveal", { type: "tutor_reveal", reveal: reveal() });
          return reveal();
        },
      }),
    );
    await h.controller.newGame("w");
    es = h.sources[0]!;
    await h.controller.reveal();
    expect(h.state().tutor.reveal).toEqual(reveal());
  });

  it("Show me: no request without an open question; a 409 shows a notice", async () => {
    let calls = 0;
    const none = harness(fakeApi({ newGame: async () => afterD5(), tutorReveal: async () => (calls++, reveal()) }));
    await none.controller.newGame("w");
    await none.controller.reveal();
    expect(calls).toBe(0);

    const h = harness(
      fakeApi({
        newGame: async () => afterD5({ tutor: tutorStatus({ question: question() }) }),
        tutorReveal: async () => {
          throw new ApiRequestError(409, "Not possible right now: no open question");
        },
      }),
    );
    await h.controller.newGame("w");
    await expect(h.controller.reveal()).resolves.toBeUndefined();
    expect(h.state().tutor.notice).toBe("Not possible right now: no open question");
    expect(h.state().tutor.reveal).toBeNull();
  });
});
