// The graded try as a short pop-up near the board (#52: FR-24, FR-8, FR-10). The result leaves
// the tutor panel; the pop-up closes after about 5 s or at the player's next move, and a wrong try
// names the best move only from the server's tutor_reveal (never made up).
import type { GameEvent, GameView } from "@chess-tutor/chess-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../src/api.ts";
import { createGameController, TRY_RESULT_MS, type EventSourceLike, type Timers } from "../src/controller.ts";
import {
  gameReducer,
  initialGameState,
  tryResultText,
  type GameAction,
  type GameState,
} from "../src/game-state.ts";
import { TryToast } from "../src/TryToast.tsx";
import { TutorPanel } from "../src/TutorPanel.tsx";
import { AFTER_D4_D5_FEN, BF4, D4, D5, NF3, question, reveal, tutorStatus, view } from "./fixtures.ts";

const AFTER_NF3_FEN = "rnbqkbnr/ppp1pppp/8/3p4/3P4/5N2/PPP1PPPP/RNBQKB1R b KQkq - 1 2";
const AFTER_BF4_FEN = "rnbqkbnr/ppp1pppp/8/3p4/3P1B2/8/PPP1PPPP/RN1QKBNR b KQkq - 1 2";

const ev = (event: GameEvent): GameAction => ({ type: "server_event", event });
const run = (s: GameState, ...actions: GameAction[]) => actions.reduce(gameReducer, s);
const afterD5 = (overrides: Partial<GameView> = {}) =>
  view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5], tutor: tutorStatus({ question: question() }), ...overrides });
const started = (game: GameView = afterD5()) => gameReducer(initialGameState, { type: "game_started", game });

const tryNf3: GameAction = { type: "move_attempted", uci: "g1f3", fen: AFTER_NF3_FEN };
const tryBf4: GameAction = { type: "move_attempted", uci: "c1f4", fen: AFTER_BF4_FEN };
const acceptedNf3: GameAction = {
  type: "move_accepted",
  game: view({ fen: AFTER_NF3_FEN, moves: [D4, D5, NF3], botThinking: true }),
};
const acceptedBf4: GameAction = {
  type: "move_accepted",
  game: view({ fen: AFTER_BF4_FEN, moves: [D4, D5, BF4], botThinking: true }),
};
const goodBf4 = (cpLoss: number) => ev({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss });
const badNf3 = ev({ type: "tutor_attempt", questionId: "q1", move: NF3, correct: false, cpLoss: 85 });
const revealBf4 = ev({ type: "tutor_reveal", reveal: reveal() });

function toast(state: GameState): string {
  return renderToStaticMarkup(createElement(TryToast, { result: state.tryResult }));
}
function panel(state: GameState): string {
  return renderToStaticMarkup(createElement(TutorPanel, { state, controller: { hint: async () => {}, reveal: async () => {} } }));
}

describe("try result pop-up: text (FR-24, FR-10)", () => {
  it("a correct try with cpLoss 0 is the best move", () => {
    const s = run(started(), tryBf4, acceptedBf4, goodBf4(0));
    expect(tryResultText(s.tryResult!)).toBe("Bf4, correct. The best move");
  });

  it("a correct try with cpLoss 10 is 0.1 off, in pawns with one decimal", () => {
    const s = run(started(), tryBf4, acceptedBf4, goodBf4(10));
    expect(tryResultText(s.tryResult!)).toBe("Bf4, correct. Only 0.1 off the best move");
    expect(tryResultText({ ...s.tryResult!, cpLoss: 25 })).toBe("Bf4, correct. Only 0.3 off the best move");
  });

  it("a tiny loss that rounds to 0.0 is not called the best move", () => {
    const s = run(started(), tryBf4, acceptedBf4, goodBf4(3));
    expect(tryResultText(s.tryResult!)).toBe("Bf4, correct. Less than 0.1 off the best move");
  });
});

describe("try result pop-up: reducer and render (#52)", () => {
  it("a correct try shows the check line in the pop-up and nothing in the panel", () => {
    const s = run(started(), tryBf4, acceptedBf4, goodBf4(0));
    const out = toast(s);
    expect(out).toContain('data-testid="try-toast"');
    expect(out).toContain("✓");
    expect(out).toContain("Bf4, correct. The best move");
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-live="polite"');
    const p = panel(s);
    expect(p).not.toContain("tutor-attempt");
    expect(p).not.toContain("Bf4, correct");
    expect(p).not.toContain("correct");
  });

  it("a wrong try shows the cross line, and 'Best was' once tutor_reveal arrives", () => {
    let s = run(started(), tryNf3, acceptedNf3, badNf3);
    expect(toast(s)).toContain("✗");
    expect(tryResultText(s.tryResult!)).toBe("Nf3, not quite.");
    s = run(s, revealBf4);
    expect(tryResultText(s.tryResult!)).toBe("Nf3, not quite. Best was Bf4");
    expect(toast(s)).toContain("Nf3, not quite. Best was Bf4");
    expect(panel(s)).not.toContain("not quite");
    expect(panel(s)).not.toContain('data-testid="tutor-reveal"');
  });

  it("the same pop-up when tutor_reveal comes before tutor_attempt", () => {
    const attemptFirst = run(started(), tryNf3, acceptedNf3, badNf3, revealBf4);
    const revealFirst = run(started(), tryNf3, acceptedNf3, revealBf4, badNf3);
    expect(tryResultText(revealFirst.tryResult!)).toBe("Nf3, not quite. Best was Bf4");
    expect(revealFirst.tryResult).toEqual(attemptFirst.tryResult);
  });

  it("the same pop-up when the events overtake the move's HTTP reply", () => {
    const s = run(started(), tryNf3, badNf3, revealBf4, acceptedNf3);
    expect(tryResultText(s.tryResult!)).toBe("Nf3, not quite. Best was Bf4");
  });

  it("a wrong try whose reveal move is null names no best move", () => {
    const s = run(started(), tryNf3, acceptedNf3, badNf3, ev({ type: "tutor_reveal", reveal: reveal({ move: null }) }));
    expect(tryResultText(s.tryResult!)).toBe("Nf3, not quite.");
    expect(toast(s)).not.toContain("Best was");
  });

  it("a reveal for another question does not name a best move", () => {
    const s = run(started(), tryNf3, acceptedNf3, badNf3, ev({ type: "tutor_reveal", reveal: reveal({ questionId: "q0", move: D4 }) }));
    expect(tryResultText(s.tryResult!)).toBe("Nf3, not quite.");
  });

  it("a correct try ignores a reveal: it never says 'Best was'", () => {
    const s = run(started(), tryBf4, acceptedBf4, goodBf4(10), revealBf4);
    expect(tryResultText(s.tryResult!)).toBe("Bf4, correct. Only 0.1 off the best move");
  });

  it("the next move closes it at once", () => {
    const s = run(started(), tryBf4, acceptedBf4, goodBf4(0));
    expect(s.tryResult).not.toBeNull();
    const moved = run(s, { type: "move_attempted", uci: "e2e4", fen: AFTER_BF4_FEN });
    expect(moved.tryResult).toBeNull();
    expect(toast(moved)).not.toContain('data-testid="try-toast"');
  });

  it("expiry closes only the pop-up it was set for", () => {
    const s = run(started(), tryBf4, acceptedBf4, goodBf4(0));
    expect(run(s, { type: "try_result_expired", seq: s.tryResult!.seq + 1 }).tryResult).not.toBeNull();
    expect(run(s, { type: "try_result_expired", seq: s.tryResult!.seq }).tryResult).toBeNull();
  });

  it("a second try replaces the first with a new seq", () => {
    const first = run(started(), tryBf4, acceptedBf4, goodBf4(0));
    const second = run(first, ev({ type: "tutor_attempt", questionId: "q1", move: NF3, correct: false, cpLoss: 85 }));
    expect(tryResultText(second.tryResult!)).toBe("Nf3, not quite.");
    expect(second.tryResult!.seq).not.toBe(first.tryResult!.seq);
  });

  it("opening or reloading a game shows no pop-up, even when its notes hold a graded try", () => {
    const game = view({
      fen: AFTER_BF4_FEN,
      moves: [D4, D5, BF4],
      notes: [
        { questionId: "q1", kind: "opponent_left_book", ply: 2, message: "m", reveal: null, bestMove: BF4, attempt: { move: BF4, correct: true, cpLoss: 0 } },
      ],
    });
    expect(started(game).tryResult).toBeNull();
    expect(run(initialGameState, { type: "game_opening" }, { type: "game_started", game }).tryResult).toBeNull();
    expect(toast(started(game))).not.toContain('data-testid="try-toast"');
    // A state event (the first message on every stream) brings no pop-up either.
    expect(run(started(afterD5()), ev({ type: "state", game })).tryResult).toBeNull();
  });

  it("a tutor_attempt for a question this page never saw shows nothing", () => {
    const s = run(started(afterD5({ tutor: tutorStatus() })), ev({ type: "tutor_attempt", questionId: "q9", move: BF4, correct: true, cpLoss: 0 }));
    expect(s.tryResult).toBeNull();
  });
});

class FakeEventSource implements EventSourceLike {
  readyState = 1;
  readonly listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.readyState = 2;
  }
  emit(event: GameEvent): void {
    for (const l of this.listeners.get(event.type) ?? []) l({ data: JSON.stringify(event) });
  }
}

class FakeTimers implements Timers {
  now = 0;
  private next = 1;
  readonly pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= this.now && this.pending.has(id)) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
}

function harness(game: GameView = afterD5()) {
  let state: GameState = initialGameState;
  const sources: FakeEventSource[] = [];
  const timers = new FakeTimers();
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected call");
  };
  const api: ApiClient = {
    newGame: async () => game,
    getGame: async () => game,
    playMove: async (_id, uci) =>
      uci === "g1f3"
        ? view({ fen: AFTER_NF3_FEN, moves: [D4, D5, NF3], botThinking: true })
        : view({ fen: AFTER_BF4_FEN, moves: [D4, D5, BF4], botThinking: true }),
    takeback: unexpected,
    resign: unexpected,
    botRetry: unexpected,
    tutorHint: unexpected,
    tutorReveal: unexpected,
    eventsUrl: (id) => `/api/games/${id}/events`,
  };
  const controller = createGameController({
    api,
    openEvents: () => {
      const s = new FakeEventSource();
      sources.push(s);
      return s;
    },
    dispatch: (a) => {
      state = gameReducer(state, a);
    },
    getState: () => state,
    timers,
  });
  return { controller, timers, es: () => sources.at(-1)!, state: () => state };
}

describe("try result pop-up: timing in the controller (#52)", () => {
  it(`closes after ${TRY_RESULT_MS} ms (about 5 s)`, async () => {
    expect(TRY_RESULT_MS).toBe(5000);
    const h = harness();
    await h.controller.newGame("w");
    await h.controller.play("c1", "f4");
    h.es().emit({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 0 });
    expect(h.state().tryResult).not.toBeNull();
    h.timers.advance(TRY_RESULT_MS - 1);
    expect(h.state().tryResult).not.toBeNull();
    h.timers.advance(1);
    expect(h.state().tryResult).toBeNull();
    expect(h.timers.pending.size).toBe(0);
  });

  it("closes at the next move, before the timer", async () => {
    const h = harness();
    await h.controller.newGame("w");
    await h.controller.play("c1", "f4");
    h.es().emit({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 0 });
    h.es().emit({ type: "state", game: view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5], tutor: tutorStatus() }) });
    h.timers.advance(1000);
    expect(h.state().tryResult).not.toBeNull();
    // The player's next move (move_attempted) closes it at once.
    const playing = h.controller.play("g1", "f3");
    expect(h.state().tryResult).toBeNull();
    await playing;
    expect(h.timers.pending.size).toBe(0);
  });

  it("a second graded try replaces the first and restarts the timer", async () => {
    const h = harness();
    await h.controller.newGame("w");
    await h.controller.play("c1", "f4");
    h.es().emit({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 0 });
    h.timers.advance(3000);
    h.es().emit({ type: "tutor_attempt", questionId: "q1", move: NF3, correct: false, cpLoss: 85 });
    expect(tryResultText(h.state().tryResult!)).toBe("Nf3, not quite.");
    h.timers.advance(3000); // 6 s after the first, 3 s after the second
    expect(h.state().tryResult).not.toBeNull();
    expect(h.timers.pending.size).toBe(1);
    h.timers.advance(2000);
    expect(h.state().tryResult).toBeNull();
  });

  it("a reveal after the try keeps the timer running from the try", async () => {
    const h = harness();
    await h.controller.newGame("w");
    await h.controller.play("g1", "f3");
    h.es().emit({ type: "tutor_attempt", questionId: "q1", move: NF3, correct: false, cpLoss: 85 });
    h.timers.advance(2000);
    h.es().emit({ type: "tutor_reveal", reveal: reveal() });
    expect(tryResultText(h.state().tryResult!)).toBe("Nf3, not quite. Best was Bf4");
    h.timers.advance(3000);
    expect(h.state().tryResult).toBeNull();
  });

  it("opening a game from its address shows no pop-up", async () => {
    const h = harness();
    await h.controller.navigate("/games/g1");
    h.es().emit({ type: "state", game: afterD5() });
    expect(h.state().tryResult).toBeNull();
    expect(h.timers.pending.size).toBe(0);
  });
});
