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
  tryResultText,
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
  it("tutor_attempt (correct) closes the question and clears the arrows", () => {
    const s = run(
      started(),
      ev({ type: "tutor_reply", question: question() }),
      ev({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 5 }),
    );
    expect(s.tutor.open).toBe(false);
    expect(tutorStatusOf(s).question).toBeNull();
    // No move was attempted on this page: the pop-up shows only the grade of the player's latest move (#52, try-toast.test.ts).
    expect(s.tryResult).toBeNull();
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
    // No move was attempted on this page: the pop-up shows only the grade of the player's latest move (#52, try-toast.test.ts).
    expect(s.tryResult).toBeNull();
    expect(s.tutor.reveal?.text).toBe(reveal().text);
    expect(tutorArrows(s)).toEqual([]);
  });

  it("the same result whether tutor_reveal comes before or after tutor_attempt", () => {
    const base = run(started(), ev({ type: "tutor_reply", question: question() }));
    const attempt = ev({ type: "tutor_attempt", questionId: "q1", move: NF3, correct: false, cpLoss: 85 });
    const rev = ev({ type: "tutor_reveal", reveal: reveal() });
    expect(run(base, attempt, rev).tutor).toEqual(run(base, rev, attempt).tutor);
    expect(run(base, attempt, rev).tryResult).toEqual(run(base, rev, attempt).tryResult);
  });

  // #51 (FR-24): the try result no longer stays in the panel once the position is gone.
  it("the player's move state (question null) arriving before tutor_attempt takes the question off the panel", () => {
    const moved = view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true });
    const s = run(
      started(),
      ev({ type: "tutor_reply", question: question() }),
      ev({ type: "state", game: moved }),
      ev({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 0 }),
    );
    // The result never goes to the panel; with no move attempted here it opens no pop-up either (#52).
    expect(s.tryResult).toBeNull();
    expect(s.tutor.question).toBeNull();
    expect(s.tutor.open).toBe(false);
    expect(tutorStatusOf(s).question).toBeNull();
  });

  it("ignores tutor_attempt for an unknown question", () => {
    const s = run(started(), ev({ type: "tutor_reply", question: question() }), ev({ type: "tutor_attempt", questionId: "q9", move: BF4, correct: true, cpLoss: 0 }));
    expect(s.tryResult).toBeNull();
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

// #51 (FR-24, FR-8): the panel only shows text about the position on the board. The player's move
// clears it at once; only the server brings a question back (a takeback's open question, a new reply).
describe("tutor state: the panel clears on the player's move (#51)", () => {
  const AFTER_BF4_FEN = "rnbqkbnr/ppp1pppp/8/3p4/3P1B2/8/PPP1PPPP/RN1QKBNR b KQkq - 1 2";
  const NF6 = { uci: "g8f6", san: "Nf6", by: "bot" } as const;
  const tryBf4: GameAction = { type: "move_attempted", uci: "c1f4", fen: AFTER_BF4_FEN };
  const afterBf4 = (overrides: Partial<GameView> = {}) =>
    view({ fen: AFTER_BF4_FEN, moves: [D4, D5, BF4], botThinking: true, ...overrides });
  const withQuestion = () => started(afterD5({ tutor: tutorStatus({ question: question() }) }));
  const attemptQ1 = ev({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: false, cpLoss: 85 });
  const empty = (s: GameState) => {
    expect(s.tutor.question).toBeNull();
    expect(s.tutor.open).toBe(false);
    expect(s.tutor.reveal).toBeNull();
    expect(s.tutor.failed).toBeNull();
    expect(s.tutor.notice).toBeNull();
    expect(tutorArrows(s)).toEqual([]);
    expect(canReveal(s)).toBe(false);
  };

  it("move_attempted clears the question, its reveal, the try result, a failure and a notice", () => {
    let s = run(withQuestion(), ev({ type: "tutor_reveal", reveal: reveal() }), { type: "tutor_notice", message: "Not possible right now." });
    expect(s.tutor.reveal).not.toBeNull();
    empty(run(s, tryBf4));

    s = run(started(), ev({ type: "tutor_reply", question: question() }), tryBf4, attemptQ1);
    expect(s.tryResult).not.toBeNull();
    expect(tryResultText(s.tryResult!)).toBe("Bf4, not quite.");
    empty(run(s, tryBf4));

    s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), ev({ type: "tutor_failed", message: "The tutor could not answer." }));
    expect(s.tutor.failed).not.toBeNull();
    empty(run(s, tryBf4));
  });

  it("keeps the tutor's thinking and progress on a move (the server decides)", () => {
    const s = run(started(), ev({ type: "tutor_thinking", kind: "opponent_left_book" }), ev({ type: "tutor_progress", label: "Checking Bf4…" }), tryBf4);
    expect(tutorStatusOf(s).thinking).toBe(true);
    expect(s.tutor.progress).toBe("Checking Bf4…");
  });

  it("late tutor_attempt and tutor_reveal for the left question do not bring it back (any order with the reply)", () => {
    const rev = ev({ type: "tutor_reveal", reveal: reveal() });
    const accepted: GameAction = { type: "move_accepted", game: afterBf4() };
    const orders: GameAction[][] = [
      [accepted, attemptQ1, rev],
      [accepted, rev, attemptQ1],
      [attemptQ1, rev, accepted],
      [attemptQ1, accepted, rev],
      [rev, attemptQ1, accepted],
    ];
    for (const order of orders) {
      const s = run(withQuestion(), tryBf4, ...order);
      empty(s);
      expect(tutorStatusOf(s).question).toBeNull();
    }
  });

  it("a later state or bot_move that still carries the left question as shown does not bring it back", () => {
    const shown = tutorStatus({ question: question({ canReveal: false }), reveal: reveal() });
    const s = run(
      withQuestion(),
      tryBf4,
      { type: "move_accepted", game: afterBf4() },
      attemptQ1,
      ev({ type: "tutor_reveal", reveal: reveal() }),
      ev({ type: "state", game: afterBf4({ tutor: shown }) }),
      ev({ type: "bot_move", move: NF6, game: view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5, BF4, NF6], tutor: shown }) }),
    );
    empty(s);
  });

  it("the Show me reply arriving after the move does not bring the reveal back", () => {
    empty(run(withQuestion(), tryBf4, { type: "tutor_reveal_received", reveal: reveal() }));
  });

  it("move_rejected and request_failed restore the panel exactly as before the attempt", () => {
    const before = run(withQuestion(), ev({ type: "tutor_reveal", reveal: reveal() }), { type: "tutor_notice", message: "Not possible right now." });
    const rejected = run(before, tryBf4, { type: "move_rejected", message: "illegal move" });
    expect(rejected.tutor).toEqual(before.tutor);
    expect(tutorArrows(rejected)).toEqual(tutorArrows(before));
    const failed = run(before, tryBf4, { type: "request_failed", message: "Request failed." });
    expect(failed.tutor).toEqual(before.tutor);
    // The next move still clears it.
    empty(run(rejected, tryBf4));
  });

  it("after a rejected move a state with the question shows it as usual", () => {
    const s = run(withQuestion(), tryBf4, { type: "move_rejected", message: "illegal move" }, ev({ type: "state", game: afterD5({ tutor: tutorStatus({ question: question() }) }) }));
    expect(s.tutor.question?.id).toBe("q1");
    expect(s.tutor.open).toBe(true);
  });

  it("an accepted move is not undone by a later failed request", () => {
    empty(run(withQuestion(), tryBf4, { type: "move_accepted", game: afterBf4() }, { type: "request_started" }, { type: "request_failed", message: "x" }));
  });

  it("a takeback whose GameView.tutor.question is open shows that question again (FR-8 retry), reply or state first", () => {
    const blunder = question({ id: "q7", kind: "player_blunder", attemptFen: AFTER_D4_D5_FEN });
    let s = run(started(), tryBf4, { type: "move_accepted", game: afterBf4() });
    s = run(s, ev({ type: "bot_move", move: NF6, game: view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5, BF4, NF6] }) }));
    s = run(s, ev({ type: "tutor_reply", question: blunder }));
    const back = afterD5({ tutor: tutorStatus({ question: blunder }) });
    const reply = run(s, { type: "request_started" }, { type: "request_succeeded", game: back });
    expect(reply.tutor.question?.id).toBe("q7");
    expect(reply.tutor.open).toBe(true);
    const state = run(s, { type: "request_started" }, ev({ type: "state", game: back }), { type: "request_succeeded", game: back });
    expect(state.tutor.question?.id).toBe("q7");
    expect(state.tutor.open).toBe(true);
  });

  it("a takeback after a move that left a question does not reopen the left one", () => {
    empty(run(withQuestion(), tryBf4, { type: "move_accepted", game: afterBf4() }, { type: "request_started" }, { type: "request_succeeded", game: afterD5() }));
  });

  it("a tutor_reply after the move shows the new question (after the move reply, or after the move's state)", () => {
    const q2 = question({ id: "q2", message: "What does Nf6 threaten?" });
    const accepted: GameAction = { type: "move_accepted", game: afterBf4() };
    const reply = ev({ type: "tutor_reply", question: q2 });
    for (const order of [[accepted, reply], [ev({ type: "state", game: afterBf4() }), reply, accepted]]) {
      const s = run(withQuestion(), tryBf4, ...order);
      expect(s.tutor.question?.id).toBe("q2");
      expect(s.tutor.open).toBe(true);
      expect(s.tryResult).toBeNull();
    }
  });

  it("a move applied while the server was unreachable clears the panel on reconnect; one not applied keeps it", () => {
    const lost = run(
      withQuestion(),
      tryBf4,
      { type: "reconnecting", message: null },
      { type: "move_rejected", message: "may not have arrived", unconfirmed: { uci: "c1f4", ply: 2 } },
    );
    expect(lost.tutor.question?.id).toBe("q1");
    empty(run(lost, { type: "reconnected", game: view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5, BF4, NF6] }) }));
    const notApplied = run(lost, { type: "reconnected", game: afterD5({ tutor: tutorStatus({ question: question() }) }) });
    expect(notApplied.tutor.question?.id).toBe("q1");
    expect(notApplied.tutor.open).toBe(true);
  });

  // Round 2 (review 072): tutor output that arrives while the move is in flight is about the
  // position being left until the move's GameView says otherwise.
  const qX = question({ id: "qX", message: "What is Black threatening?" });
  const movedState = ev({ type: "state", game: afterBf4() });
  const accepted: GameAction = { type: "move_accepted", game: afterBf4() };

  it("a tutor_reply that arrives while the move is in flight leaves with the move (state then reply)", () => {
    const s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), tryBf4, ev({ type: "tutor_reply", question: qX }), movedState, accepted);
    empty(s);
    expect(tutorStatusOf(s).question).toBeNull();
  });

  it("the same when the move reply comes before the state, or when there is no state", () => {
    for (const order of [[accepted, movedState], [accepted]]) {
      const s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), tryBf4, ev({ type: "tutor_reply", question: qX }), ...order);
      empty(s);
      expect(tutorStatusOf(s).question).toBeNull();
    }
  });

  it("the same when the move reply overtakes the tutor_reply (reply, tutor_reply, state)", () => {
    const s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), tryBf4, accepted, ev({ type: "tutor_reply", question: qX }), movedState);
    empty(s);
  });

  it("a tutor_failed that arrives while the move is in flight leaves with the move", () => {
    for (const order of [[movedState, accepted], [accepted], [accepted, movedState]]) {
      const s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), tryBf4, ev({ type: "tutor_failed", message: "The tutor could not answer." }), ...order);
      empty(s);
    }
  });

  it("a tentative reply that the move's GameView still holds open stays shown", () => {
    // Held open by the server, so about the board after the move (round 3: the FR-24 guard).
    const qNew = { ...qX, attemptFen: AFTER_BF4_FEN };
    const holds = afterBf4({ tutor: tutorStatus({ question: qNew }) });
    for (const order of [[ev({ type: "state", game: holds }), { type: "move_accepted", game: holds } as GameAction], [{ type: "move_accepted", game: holds } as GameAction]]) {
      const s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), tryBf4, ev({ type: "tutor_reply", question: qNew }), ...order);
      expect(s.tutor.question?.id).toBe("qX");
      expect(s.tutor.open).toBe(true);
    }
  });

  it("a reply for the new position after the move's state stays (player_blunder on the move just played)", () => {
    const s = run(started(), tryBf4, movedState, ev({ type: "tutor_thinking", kind: "player_blunder" }), ev({ type: "tutor_reply", question: qX }), accepted);
    expect(s.tutor.question?.id).toBe("qX");
    expect(s.tutor.open).toBe(true);
  });

  it("Show me on the current position still shows after a state", () => {
    const shown = afterD5({ tutor: tutorStatus({ question: question({ canReveal: false }), reveal: reveal() }) });
    const s = run(withQuestion(), { type: "tutor_reveal_received", reveal: reveal() }, ev({ type: "state", game: shown }));
    expect(s.tutor.question?.id).toBe("q1");
    expect(s.tutor.reveal).toEqual(reveal());
  });

  it("a GameView without a question removes a closed question's text from the panel", () => {
    const s = run(
      started(),
      ev({ type: "tutor_reply", question: question() }),
      ev({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 0 }),
      ev({ type: "state", game: afterBf4() }),
    );
    empty(s);
  });

  it("a rejection after a mid-request tutor_failed keeps the message", () => {
    const s = run(withQuestion(), tryBf4, ev({ type: "tutor_failed", message: "The tutor could not answer." }), { type: "move_rejected", message: "illegal move" });
    expect(s.tutor.failed).toBe("The tutor could not answer.");
    expect(s.tutor.question?.id).toBe("q1");
  });

  it("a rejection after mid-request tutor_progress keeps the live label", () => {
    const s = run(
      started(),
      ev({ type: "tutor_thinking", kind: "hint" }),
      ev({ type: "tutor_progress", label: "Tutor is looking at the position…" }),
      tryBf4,
      ev({ type: "tutor_progress", label: "Checking Nf3…" }),
      { type: "move_rejected", message: "illegal move" },
    );
    expect(s.tutor.progress).toBe("Checking Nf3…");
    expect(tutorStatusOf(s).thinking).toBe(true);
  });

  it("a rejection after a mid-request tutor_reply keeps the new question", () => {
    const s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), tryBf4, ev({ type: "tutor_reply", question: qX }), { type: "request_failed", message: "x" });
    expect(s.tutor.question?.id).toBe("qX");
    expect(s.tutor.open).toBe(true);
    // Not tentative any more: a later move still clears it, and a later state holding it keeps it.
    expect(run(s, ev({ type: "state", game: afterD5({ tutor: tutorStatus({ question: qX }) }) })).tutor.question?.id).toBe("qX");
  });

  it("a rejection after a mid-request state syncs with the server", () => {
    const q2 = question({ id: "q2", message: "Another question." });
    const replaced = run(withQuestion(), tryBf4, ev({ type: "state", game: afterD5({ tutor: tutorStatus({ question: q2 }) }) }), { type: "move_rejected", message: "illegal move" });
    expect(replaced.tutor.question?.id).toBe("q2");
    expect(replaced.tutor.open).toBe(true);
    const same = run(withQuestion(), tryBf4, ev({ type: "state", game: afterD5({ tutor: tutorStatus({ question: question() }) }) }), { type: "move_rejected", message: "illegal move" });
    expect(same.tutor.question?.id).toBe("q1");
    expect(same.tutor.open).toBe(true);
    const closed = run(withQuestion(), tryBf4, ev({ type: "state", game: afterD5() }), { type: "move_rejected", message: "illegal move" });
    expect(closed.tutor.question).toBeNull();
  });

  // Round 3 (review 075): a GameView question about a position that is not on the board never shows.
  const AFTER_NF6_FEN = "rnbqkb1r/ppp1pppp/5n2/3p4/3P1B2/8/PPP1PPPP/RN1QKBNR w KQkq - 2 3";
  const afterNf6 = (overrides: Partial<GameView> = {}) => view({ fen: AFTER_NF6_FEN, moves: [D4, D5, BF4, NF6], ...overrides });

  it("a reload after a wrong try (shown question about the position before the try) shows an empty panel", () => {
    const shownQ1 = tutorStatus({ question: question({ canReveal: false }), reveal: reveal() });
    empty(started(afterNf6({ tutor: shownQ1 })));
    empty(run(started(afterNf6()), ev({ type: "state", game: afterNf6({ tutor: shownQ1 }) })));
    empty(run(started(afterNf6()), { type: "reconnected", game: afterNf6({ tutor: shownQ1 }) }));
  });

  it("a Show me reveal whose attemptFen is the board still shows on reload (move counters ignored)", () => {
    const q = question({ canReveal: false, attemptFen: AFTER_D4_D5_FEN.replace(/ 0 2$/, " 7 9") });
    const s = started(afterD5({ tutor: tutorStatus({ question: q, reveal: reveal() }) }));
    expect(s.tutor.question?.id).toBe("q1");
    expect(s.tutor.reveal).toEqual(reveal());
    expect(tutorArrows(s)).toEqual([{ from: "c1", to: "f4", kind: "reveal" }]);
  });

  it("a question whose attemptFen differs in castling or side to move is not on the board", () => {
    for (const attemptFen of [AFTER_D4_D5_FEN.replace(" w KQkq ", " w Kkq "), AFTER_D4_D5_FEN.replace(" w ", " b ")]) {
      empty(started(afterD5({ tutor: tutorStatus({ question: question({ attemptFen }) }) })));
    }
  });

  it("a takeback that reopens a question on the board shows it", () => {
    const blunder = question({ id: "q7", kind: "player_blunder", attemptFen: AFTER_D4_D5_FEN });
    const s = run(started(afterNf6()), { type: "request_started" }, { type: "request_succeeded", game: afterD5({ tutor: tutorStatus({ question: blunder }) }) });
    expect(s.tutor.question?.id).toBe("q7");
    expect(s.tutor.open).toBe(true);
  });

  it("an open lesson question one takeback away (FR-8 retry offer) still shows, on reload too", () => {
    const blunder = question({ id: "q7", kind: "player_blunder", attemptFen: AFTER_D4_D5_FEN });
    const s = started(afterNf6({ tutor: tutorStatus({ question: blunder }) }));
    expect(s.tutor.question?.id).toBe("q7");
    expect(s.tutor.open).toBe(true);
  });

  it("a reconnect after a tentative reply resets tentative: a later tutor_failed survives a late move_accepted", () => {
    const holds = afterBf4({ tutor: tutorStatus({ question: question({ id: "qX", attemptFen: AFTER_BF4_FEN }) }) });
    let s = run(started(), ev({ type: "tutor_thinking", kind: "hint" }), tryBf4, ev({ type: "tutor_reply", question: qX }));
    expect(s.tutor.tentative).toBe(true);
    s = run(s, { type: "reconnecting", message: null }, { type: "reconnected", game: holds });
    expect(s.tutor.tentative).toBe(false);
    s = run(s, ev({ type: "tutor_failed", message: "The tutor could not answer." }), { type: "move_accepted", game: afterBf4() });
    expect(s.tutor.failed).toBe("The tutor could not answer.");
  });

  it("a GameView without a question resets tentative", () => {
    const s = run(started(), tryBf4, ev({ type: "tutor_failed", message: "x" }), ev({ type: "state", game: afterD5() }));
    expect(s.tutor.tentative).toBe(false);
  });
});
