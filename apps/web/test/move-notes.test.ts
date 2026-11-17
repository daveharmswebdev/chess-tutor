// Tutor notes in the move list (#54: FR-25, FR-10, NFR-14): which row a note sits on, and the
// note's full text. Every move name and number comes from the note's own fields (FR-10).
import type { MoveView, TutorNote } from "@chess-tutor/chess-core";
import { describe, expect, it } from "vitest";
import { moveRows, noteHasMore, noteLabel, noteParts, noteText, toggleKey } from "../src/move-notes.ts";
import { BF4, D4, D5, NF3 } from "./fixtures.ts";

const G6: MoveView = { uci: "g7g6", san: "g6", by: "bot" };
const E3: MoveView = { uci: "e2e3", san: "e3", by: "player" };
const H3: MoveView = { uci: "h2h3", san: "h3", by: "player" };

function note(overrides: Partial<TutorNote> = {}): TutorNote {
  return {
    questionId: "q1",
    kind: "opponent_left_book",
    ply: 2,
    message: "Black left your book. What does ...g6 change?",
    reveal: null,
    bestMove: null,
    attempt: null,
    ...overrides,
  };
}

describe("moveRows: notes on rows (FR-25)", () => {
  const moves = [D4, D5, BF4, G6, E3];

  it("puts a note on a white ply on that move's row", () => {
    const n = note({ ply: 2 });
    const rows = moveRows(moves, [n]);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(rows[1]!.notes).toEqual([n]);
    expect(rows[0]!.notes).toEqual([]);
    expect(rows[2]!.notes).toEqual([]);
  });

  it("puts a note on a black ply on that move's row", () => {
    const n = note({ ply: 3 });
    const rows = moveRows(moves, [n]);
    expect(rows[1]!.notes).toEqual([n]);
  });

  it("keeps the rows and moves as before", () => {
    const rows = moveRows(moves, []);
    expect(rows).toEqual([
      { n: 1, ply: 0, white: D4, black: D5, notes: [] },
      { n: 2, ply: 2, white: BF4, black: G6, notes: [] },
      { n: 3, ply: 4, white: E3, black: undefined, notes: [] },
    ]);
  });

  it("puts a note with ply === moves.length after the last move (odd and even lengths)", () => {
    const odd = note({ ply: 5 });
    expect(moveRows(moves, [odd])[2]!.notes).toEqual([odd]);
    const four = moves.slice(0, 4);
    const even = note({ ply: 4 });
    const rows = moveRows(four, [even]);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.notes).toEqual([even]);
  });

  it("shows every note on one ply, and on one row, in GameView order", () => {
    const a = note({ questionId: "a", ply: 2 });
    const b = note({ questionId: "b", ply: 3 });
    const c = note({ questionId: "c", ply: 2 });
    const rows = moveRows(moves, [a, b, c]);
    expect(rows[1]!.notes.map((x) => x.questionId)).toEqual(["a", "b", "c"]);
  });

  it("follows a takeback: shorter moves and fewer notes give fewer rows and no stale note", () => {
    const before = [note({ questionId: "a", ply: 1 }), note({ questionId: "b", ply: 4 })];
    expect(moveRows(moves, before)[2]!.notes).toHaveLength(1);
    // The server removes notes with ply >= the new moves.length (api.ts, #53).
    const after = moveRows(moves.slice(0, 3), before.slice(0, 1));
    expect(after).toHaveLength(2);
    expect(after.flatMap((r) => r.notes.map((x) => x.questionId))).toEqual(["a"]);
  });

  it("drops a note past the end of the moves rather than inventing a row", () => {
    const rows = moveRows(moves.slice(0, 2), [note({ ply: 7 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notes).toEqual([]);
  });

  it("gives a note on the start position (no moves) a row of its own", () => {
    const n = note({ ply: 0 });
    const rows = moveRows([], [n]);
    expect(rows).toEqual([{ n: 1, ply: 0, white: undefined, black: undefined, notes: [n] }]);
    expect(moveRows([], [])).toEqual([]);
  });
});

describe("noteText: the full note (FR-25, FR-10)", () => {
  it("is the message only when nothing else is known", () => {
    const n = note();
    expect(noteParts(n)).toEqual(["Black left your book. What does ...g6 change?"]);
    expect(noteText(n)).toBe("Black left your book. What does ...g6 change?");
    expect(noteHasMore(n)).toBe(false);
  });

  it("adds the reveal after the message", () => {
    const n = note({ reveal: "...g6 prepares Bg7. Keep developing: e3 and Nf3." });
    expect(noteParts(n)).toEqual([
      "Black left your book. What does ...g6 change?",
      "...g6 prepares Bg7. Keep developing: e3 and Nf3.",
    ]);
    expect(noteHasMore(n)).toBe(true);
  });

  it("names a correct try, and no best move when the try was the best move", () => {
    const n = note({ attempt: { move: NF3, correct: true, cpLoss: 0 }, bestMove: NF3 });
    expect(noteParts(n).slice(1)).toEqual(["You tried Nf3: correct, the best move."]);
  });

  it("gives a correct try's loss in pawns with one decimal", () => {
    const n = note({ attempt: { move: NF3, correct: true, cpLoss: 37 }, bestMove: E3 });
    expect(noteParts(n).slice(1)).toEqual(["You tried Nf3: correct, only 0.4 off the best move."]);
    const tiny = note({ attempt: { move: NF3, correct: true, cpLoss: 3 }, bestMove: null });
    expect(noteParts(tiny).slice(1)).toEqual(["You tried Nf3: correct, less than 0.1 off the best move."]);
  });

  it("says how much a wrong try lost, from cpLoss/100 rounded to 0.1", () => {
    const n = note({ attempt: { move: NF3, correct: false, cpLoss: 118 }, bestMove: H3 });
    expect(noteParts(n).slice(1)).toEqual(["You tried Nf3: it lost about 1.2 pawns.", "Best was h3."]);
    expect(noteText(n)).toBe("Black left your book. What does ...g6 change? You tried Nf3: it lost about 1.2 pawns. Best was h3.");
  });

  it("shows the best move without a try (released when the player moved on)", () => {
    const n = note({ reveal: "Be2 lets ...Nh5 hit your bishop.", bestMove: H3 });
    expect(noteParts(n).slice(1)).toEqual(["Be2 lets ...Nh5 hit your bishop.", "Best was h3."]);
  });

  it("invents nothing when the fields are null: no try line, no best move", () => {
    const n = note({ reveal: null, bestMove: null, attempt: { move: NF3, correct: false, cpLoss: 90 } });
    const text = noteText(n);
    expect(text).not.toContain("Best was");
    expect(noteParts(note())).toHaveLength(1);
    expect(noteText(note())).not.toMatch(/tried|Best was|pawns/);
  });

  it("leaves a message-only note's cut-off check to the browser (review 095): no character count", () => {
    // Whether the one-line message is cut off depends on the column width; MoveList measures it.
    expect(noteHasMore(note({ message: "Why does Bf4 come before e3 here, do you think?" }))).toBe(false);
    expect(noteHasMore(note({ message: "x".repeat(200) }))).toBe(false);
  });

  it("names no other best move after a correct try (review 095): no 'correct, the best move. Best was X.'", () => {
    const best = note({ attempt: { move: NF3, correct: true, cpLoss: 0 }, bestMove: E3 });
    expect(noteParts(best).slice(1)).toEqual(["You tried Nf3: correct, the best move."]);
    expect(noteText(best)).not.toContain("Best was");
    const close = note({ attempt: { move: NF3, correct: true, cpLoss: 37 }, bestMove: E3 });
    expect(noteText(close)).not.toContain("Best was");
    // A wrong try still names the best move.
    const wrong = note({ attempt: { move: NF3, correct: false, cpLoss: 118 }, bestMove: E3 });
    expect(noteText(wrong)).toContain("Best was e3.");
  });
});

describe("noteLabel: the ❝ button's name (FR-25)", () => {
  const moves = [D4, D5, BF4, G6, E3];

  it("names the white or black move the note sits on", () => {
    const rows = moveRows(moves, [note({ ply: 2 })]);
    expect(noteLabel(rows[1]!)).toBe("Tutor note for move 2. Bf4");
    expect(noteLabel(moveRows(moves, [note({ ply: 3 })])[1]!)).toBe("Tutor note for move 2... g6");
  });

  it("names a note after the last move by that move", () => {
    expect(noteLabel(moveRows(moves, [note({ ply: 5 })])[2]!)).toBe("Tutor note after move 3. e3");
  });

  it("names both moves when a row holds notes on both plies", () => {
    const rows = moveRows(moves, [note({ ply: 2 }), note({ questionId: "b", ply: 3 })]);
    expect(noteLabel(rows[1]!)).toBe("Tutor notes for moves 2. Bf4 and 2... g6");
    const twoOnOne = moveRows(moves, [note({ ply: 2 }), note({ questionId: "b", ply: 2 })]);
    expect(noteLabel(twoOnOne[1]!)).toBe("Tutor notes for move 2. Bf4");
  });
});

describe("toggleKey", () => {
  it("adds a missing key and removes a present one, without changing the input", () => {
    const empty = new Set<string>();
    const one = toggleKey(empty, "a");
    expect([...one]).toEqual(["a"]);
    expect(empty.size).toBe(0);
    expect([...toggleKey(one, "a")]).toEqual([]);
  });
});
