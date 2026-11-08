// Tutor panel state in the reducer (#7: FR-8, FR-11, FR-12, NFR-1, NFR-9).
// GameView.tutor is the truth; tutor_* events are the live updates between "state" events.
import type { GameEvent, GameView } from "@chess-tutor/chess-core";
import { describe, expect, it } from "vitest";
import {
  canHint,
  canReveal,
  gameReducer,
  initialGameState,
  tutorArrows,
  tutorAttemptText,
  tutorStatusOf,
  type GameAction,
  type GameState,
} from "../src/game-state.ts";
import { AFTER_D4_D5_FEN, AFTER_D4_FEN, BF4, D4, D5, NF3, question, reveal, tutorStatus, view } from "./fixtures.ts";

const afterD5 = (overrides: Partial<GameView> = {}) => view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5], ...overrides });

function run(state: GameState, ...actions: GameAction[]): GameState {
  return actions.reduce(gameReducer, state);
}
const ev = (event: GameEvent): GameAction => ({ type: "server_event", event });

function started(game: GameView = afterD5()): GameState {
  return gameReducer(initialGameState, { type: "game_started", game });
}

describe("tutor state: live events", () => {
  it("tutor_thinking shows thinking at once and clears an old failure", () => {
    const s = run(started(), ev({ type: "tutor_failed", message: "The tutor could not answer." }), ev({ type: "tutor_thinking", kind: "hint" }));
    expect(tutorStatusOf(s).thinking).toBe(true);
    expect(s.tutor.failed).toBeNull();
    expect(canHint(s)).toBe(false);
  });

  it("tutor_progress replaces the label each time", () => {
    let s = run(started(), ev({ type: "tutor_thinking", kind: "opponent_left_book" }));
    s = run(s, ev({ type: "tutor_progress", label: "Tutor is looking at the position…" }));
    expect(s.tutor.progress).toBe("Tutor is looking at the position…");
    s = run(s, ev({ type: "tutor_progress", label: "Checking Bf4…" }));
    expect(s.tutor.progress).toBe("Checking Bf4…");
  });

  it("tutor_reply opens the question, stops thinking and draws its arrows", () => {
    const q = question({ arrows: [{ from: "c1", to: "f4" }, { from: "g1", to: "f3" }] });
    const s = run(started(), ev({ type: "tutor_thinking", kind: "opponent_left_book" }), ev({ type: "tutor_progress", label: "x" }), ev({ type: "tutor_reply", question: q }));
    expect(tutorStatusOf(s).thinking).toBe(false);
    expect(tutorStatusOf(s).question).toEqual(q);
    expect(s.tutor.question).toEqual(q);
    expect(s.tutor.open).toBe(true);
    expect(s.tutor.progress).toBeNull();
    expect(tutorArrows(s)).toEqual([{ from: "c1", to: "f4", kind: "question" }, { from: "g1", to: "f3", kind: "question" }]);
    expect(canReveal(s)).toBe(true);
  });

  it("draws at most 3 arrows", () => {
    const arrows = ["a3", "b3", "c3", "d3"].map((to, i) => ({ from: `${"abcd"[i]}2`, to }));
    const s = run(started(), ev({ type: "tutor_reply", question: question({ arrows }) }));
    expect(tutorArrows(s)).toHaveLength(3);
  });

  it("tutor_failed shows a plain message and stops thinking", () => {
    const s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), ev({ type: "tutor_failed", message: "The tutor is not available right now." }));
    expect(s.tutor.failed).toBe("The tutor is not available right now.");
    expect(tutorStatusOf(s).thinking).toBe(false);
    expect(s.tutor.progress).toBeNull();
  });

  it("a new question replaces the old one, its reveal, its result and its arrows", () => {
    let s = run(started(), ev({ type: "tutor_reply", question: question() }), ev({ type: "tutor_reveal", reveal: reveal() }));
    s = run(s, ev({ type: "tutor_reply", question: question({ id: "q2", message: "Hint: look at the e-file.", arrows: [] }) }));
    expect(s.tutor.question?.id).toBe("q2");
    expect(s.tutor.reveal).toBeNull();
    expect(tutorArrows(s)).toEqual([]);
  });
});

describe("tutor state: Show me", () => {
  it("a reveal (HTTP or SSE) shows the text and draws the reveal arrows and move", () => {
    const r = reveal({ arrows: [{ from: "d4", to: "c5" }], move: BF4 });
    for (const action of [{ type: "tutor_reveal_received", reveal: r } as const, ev({ type: "tutor_reveal", reveal: r })]) {
      const s = run(started(), ev({ type: "tutor_reply", question: question() }), action);
      expect(s.tutor.reveal).toEqual(r);
      expect(tutorArrows(s)).toEqual([{ from: "d4", to: "c5", kind: "reveal" }, { from: "c1", to: "f4", kind: "reveal" }]);
      expect(canReveal(s)).toBe(false);
    }
  });

  it("does not draw the reveal move twice when it is also one of the arrows", () => {
    const s = run(started(), ev({ type: "tutor_reply", question: question() }), ev({ type: "tutor_reveal", reveal: reveal() }));
    expect(tutorArrows(s)).toEqual([{ from: "c1", to: "f4", kind: "reveal" }]);
  });

  it("is idempotent per questionId in both arrival orders (HTTP then SSE, SSE then HTTP)", () => {
    const base = run(started(), ev({ type: "tutor_reply", question: question() }));
    const r = reveal();
    const httpFirst = run(base, { type: "tutor_reveal_received", reveal: r }, ev({ type: "tutor_reveal", reveal: r }));
    const sseFirst = run(base, ev({ type: "tutor_reveal", reveal: r }), { type: "tutor_reveal_received", reveal: r });
    const once = run(base, ev({ type: "tutor_reveal", reveal: r }));
    expect(httpFirst.tutor).toEqual(once.tutor);
    expect(sseFirst.tutor).toEqual(once.tutor);
    // The second identical reveal changes nothing at all.
    expect(gameReducer(once, ev({ type: "tutor_reveal", reveal: r }))).toBe(once);
  });

  it("ignores a reveal for another question", () => {
    const s = run(started(), ev({ type: "tutor_reply", question: question() }), ev({ type: "tutor_reveal", reveal: reveal({ questionId: "q0" }) }));
    expect(s.tutor.reveal).toBeNull();
  });

  it("canReveal needs an open question that holds a reveal", () => {
    expect(canReveal(started())).toBe(false);
    expect(canReveal(run(started(), ev({ type: "tutor_reply", question: question({ canReveal: false }) })))).toBe(false);
    expect(canReveal(run(started(), ev({ type: "tutor_reply", question: question() })))).toBe(true);
  });
});

describe("tutor state: trying again", () => {
  it("tutor_attempt (correct) closes the question, shows the result and clears the arrows", () => {
    const s = run(
      started(),
      ev({ type: "tutor_reply", question: question() }),
      ev({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 5 }),
    );
    expect(s.tutor.open).toBe(false);
    expect(tutorStatusOf(s).question).toBeNull();
    expect(s.tutor.attempt).toEqual({ questionId: "q1", move: BF4, correct: true, cpLoss: 5 });
    expect(tutorAttemptText(s)).toBe("Correct: Bf4 is a good move.");
    expect(tutorArrows(s)).toEqual([]);
    expect(canReveal(s)).toBe(false);
  });

  it("a wrong try shows the cp loss, then the reveal text (no arrows: the question is closed)", () => {
    const s = run(
      started(),
      ev({ type: "tutor_reply", question: question() }),
      ev({ type: "tutor_attempt", questionId: "q1", move: NF3, correct: false, cpLoss: 85 }),
      ev({ type: "tutor_reveal", reveal: reveal() }),
    );
    expect(tutorAttemptText(s)).toBe("Not quite: Nf3 loses 85 centipawns against the best move.");
    expect(s.tutor.reveal?.text).toBe(reveal().text);
    expect(tutorArrows(s)).toEqual([]);
  });

  it("the same result whether tutor_reveal comes before or after tutor_attempt", () => {
    const base = run(started(), ev({ type: "tutor_reply", question: question() }));
    const attempt = ev({ type: "tutor_attempt", questionId: "q1", move: NF3, correct: false, cpLoss: 85 });
    const rev = ev({ type: "tutor_reveal", reveal: reveal() });
    expect(run(base, attempt, rev).tutor).toEqual(run(base, rev, attempt).tutor);
  });

  it("keeps the result when the player's move state (question null) arrives before tutor_attempt", () => {
    const moved = view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true });
    const s = run(
      started(),
      ev({ type: "tutor_reply", question: question() }),
      ev({ type: "state", game: moved }),
      ev({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 0 }),
    );
    expect(s.tutor.attempt?.correct).toBe(true);
    expect(s.tutor.question?.id).toBe("q1");
    expect(s.tutor.open).toBe(false);
  });

  it("ignores tutor_attempt for an unknown question", () => {
    const s = run(started(), ev({ type: "tutor_reply", question: question() }), ev({ type: "tutor_attempt", questionId: "q9", move: BF4, correct: true, cpLoss: 0 }));
    expect(s.tutor.attempt).toBeNull();
    expect(s.tutor.open).toBe(true);
  });
});

describe("tutor state: GameView.tutor is the source of truth", () => {
  it("the first state restores the panel after a reload: thinking, or an open question", () => {
    const thinking = run(initialGameState, { type: "game_started", game: afterD5() }, ev({ type: "state", game: afterD5({ tutor: tutorStatus({ thinking: true }) }) }));
    expect(tutorStatusOf(thinking).thinking).toBe(true);

    const q = question();
    const restored = run(initialGameState, { type: "game_started", game: afterD5({ tutor: tutorStatus({ question: q }) }) });
    expect(restored.tutor.question).toEqual(q);
    expect(restored.tutor.open).toBe(true);
    expect(tutorArrows(restored)).toEqual([{ from: "c1", to: "f4", kind: "question" }]);
    expect(canReveal(restored)).toBe(true);
  });

  it("a state without the question closes it", () => {
    const s = run(started(afterD5({ tutor: tutorStatus({ question: question() }) })), ev({ type: "state", game: afterD5() }));
    expect(s.tutor.open).toBe(false);
    expect(tutorArrows(s)).toEqual([]);
  });

  it("a state with a different question replaces the old one and its reveal", () => {
    let s = run(started(afterD5({ tutor: tutorStatus({ question: question() }) })), ev({ type: "tutor_reveal", reveal: reveal() }));
    s = run(s, ev({ type: "state", game: afterD5({ tutor: tutorStatus({ question: question({ id: "q2", arrows: [] }) }) }) }));
    expect(s.tutor.question?.id).toBe("q2");
    expect(s.tutor.reveal).toBeNull();
  });

  it("a state with the same question keeps its reveal", () => {
    const withQ = afterD5({ tutor: tutorStatus({ question: question() }) });
    const s = run(started(withQ), ev({ type: "tutor_reveal", reveal: reveal() }), ev({ type: "state", game: withQ }));
    expect(s.tutor.reveal).toEqual(reveal());
  });

  it("a state that is no longer thinking drops the progress label", () => {
    const s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), ev({ type: "tutor_progress", label: "Checking Nf3…" }), ev({ type: "state", game: afterD5() }));
    expect(s.tutor.progress).toBeNull();
    expect(tutorStatusOf(s).thinking).toBe(false);
  });

  it("a new game clears the panel", () => {
    let s = run(started(), ev({ type: "tutor_reply", question: question() }), ev({ type: "tutor_reveal", reveal: reveal() }), { type: "tutor_notice", message: "Not possible right now." });
    s = run(s, { type: "request_started" }, { type: "game_started", game: view({ id: "g2" }) });
    expect(s.tutor.question).toBeNull();
    expect(s.tutor.reveal).toBeNull();
    expect(s.tutor.notice).toBeNull();
    expect(tutorArrows(s)).toEqual([]);
  });

  it("shows coaching as unavailable with its reason, and disables Hint (NFR-9)", () => {
    const s = started(afterD5({ tutor: tutorStatus({ available: false, reason: "Coaching is off: no API key is set." }) }));
    expect(tutorStatusOf(s)).toMatchObject({ available: false, reason: "Coaching is off: no API key is set." });
    expect(canHint(s)).toBe(false);
  });

  it("treats a GameView without tutor (an older server) as unavailable", () => {
    const { tutor: _omit, ...legacy } = afterD5();
    const s = started(legacy as GameView);
    expect(tutorStatusOf(s).available).toBe(false);
    expect(canHint(s)).toBe(false);
  });
});

describe("tutor state: HTTP replies vs tutor events (#23 ordering)", () => {
  const moved = view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true });

  it("tutor events before the move reply: the reply's game applies but its older tutor does not", () => {
    const s = run(
      started(view()),
      { type: "move_attempted", uci: "d2d4", fen: AFTER_D4_FEN },
      ev({ type: "tutor_thinking", kind: "player_blunder" }),
      { type: "move_accepted", game: moved },
    );
    expect(s.game?.moves).toEqual([D4]);
    expect(s.pendingFen).toBeNull();
    expect(tutorStatusOf(s).thinking).toBe(true);
  });

  it("move reply first, then tutor events", () => {
    const s = run(
      started(view()),
      { type: "move_attempted", uci: "d2d4", fen: AFTER_D4_FEN },
      { type: "move_accepted", game: moved },
      ev({ type: "tutor_thinking", kind: "player_blunder" }),
    );
    expect(s.game?.moves).toEqual([D4]);
    expect(tutorStatusOf(s).thinking).toBe(true);
  });

  it("a takeback reply applies its tutor when no tutor event came first", () => {
    const s = run(
      started(afterD5({ tutor: tutorStatus({ question: question() }) })),
      { type: "request_started" },
      { type: "request_succeeded", game: view() },
    );
    expect(s.tutor.open).toBe(false);
  });
});

describe("tutor state: Hint", () => {
  it("canHint: playing, the player's turn, bot not thinking, coaching available and idle", () => {
    expect(canHint(initialGameState)).toBe(false);
    expect(canHint(started())).toBe(true);
    expect(canHint(started(view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true })))).toBe(false);
    expect(canHint(started(view({ fen: AFTER_D4_FEN, moves: [D4] })))).toBe(false); // bot's turn
    expect(canHint(started(afterD5({ status: "finished", result: "0-1", endReason: "resigned" })))).toBe(false);
    expect(canHint(started(afterD5({ tutor: tutorStatus({ thinking: true }) })))).toBe(false);
    expect(canHint(run(started(), { type: "request_started" }))).toBe(false);
  });

  it("a tutor notice shows until the next tutor activity", () => {
    let s = run(started(), { type: "tutor_notice", message: "Coaching is not available right now." });
    expect(s.tutor.notice).toBe("Coaching is not available right now.");
    s = run(s, ev({ type: "tutor_thinking", kind: "hint" }));
    expect(s.tutor.notice).toBeNull();
  });
});
