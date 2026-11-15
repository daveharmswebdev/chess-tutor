// Captured pieces and the material count beside the board (#42, FR-20, FR-4). A piece count
// only, read from the board's FEN; never an engine evaluation (FR-10).
import { describe, expect, it } from "vitest";
import { materialFromFen } from "../src/material.ts";
import { START_FEN } from "./fixtures.ts";

describe("materialFromFen", () => {
  it("start position: nothing captured, level", () => {
    const m = materialFromFen(START_FEN);
    expect(m.w).toEqual({ captured: [], points: 39, lead: 0 });
    expect(m.b).toEqual({ captured: [], points: 39, lead: 0 });
  });

  it("knight for pawn: +2 to the knight side, the captured knight shown on that side", () => {
    // Black's b8 knight and White's e-pawn are gone.
    const m = materialFromFen("r1bqkbnr/pppppppp/8/8/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3");
    expect(m.w).toEqual({ captured: [{ type: "n", count: 1 }], points: 38, lead: 2 });
    expect(m.b).toEqual({ captured: [{ type: "p", count: 1 }], points: 36, lead: 0 });
  });

  it("groups by type, ordered pawn, knight, bishop, rook, queen", () => {
    // White has lost two pawns, a rook and the queen; Black a pawn and a bishop.
    const m = materialFromFen("rn1qkbnr/ppp1pppp/8/8/8/8/PP1P1PPP/RNB1KBN1 w kq - 0 10");
    expect(m.b.captured).toEqual([
      { type: "p", count: 2 },
      { type: "r", count: 1 },
      { type: "q", count: 1 },
    ]);
    expect(m.w.captured).toEqual([
      { type: "p", count: 1 },
      { type: "b", count: 1 },
    ]);
    expect(m.w.points).toBe(23);
    expect(m.b.points).toBe(35);
    expect(m.b.lead).toBe(12);
    expect(m.w.lead).toBe(0);
  });

  it("promotion to queen: the promoted pawn is not shown captured, the new queen counts 9", () => {
    // White: 7 pawns, 2 queens, one bishop (f1's was captured). Black lost the d-pawn.
    const m = materialFromFen("rnbqkbnr/ppp1pppp/8/8/8/8/PPPP1PPP/RNBQKQNR w KQkq - 0 20");
    expect(m.b.captured).toEqual([{ type: "b", count: 1 }]);
    expect(m.w.captured).toEqual([{ type: "p", count: 1 }]);
    expect(m.w.points).toBe(44);
    expect(m.b.points).toBe(38);
    expect(m.w.lead).toBe(6);
  });

  it("a side with two queens and 7 pawns has lost no queen and no pawn", () => {
    // White: 7 pawns, 2 queens, 1 rook: the only loss is a rook.
    const m = materialFromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKBNQ w Qkq - 0 30");
    expect(m.b.captured).toEqual([{ type: "r", count: 1 }]);
    expect(m.w.captured).toEqual([]);
    expect(m.w.points).toBe(42);
    expect(m.w.lead).toBe(3);
  });

  it("underpromotion to knight: the extra knight counts 3 and no pawn is shown lost", () => {
    // Black: 3 knights, 7 pawns; nothing captured by anyone.
    const m = materialFromFen("rnbqkbnr/ppppppp1/8/8/8/n7/PPPPPPPP/RNBQKBNR b KQkq - 0 30");
    expect(m.w.captured).toEqual([]);
    expect(m.b.captured).toEqual([]);
    expect(m.b.points).toBe(41);
    expect(m.b.lead).toBe(2);
    expect(m.w.lead).toBe(0);
  });

  it("takeback to an earlier FEN gives that position's count again", () => {
    const after = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2"; // 1.e4 d5 2.exd5
    const before = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    expect(materialFromFen(after).w).toEqual({ captured: [{ type: "p", count: 1 }], points: 39, lead: 1 });
    expect(materialFromFen(before)).toEqual(materialFromFen(START_FEN));
  });
});
