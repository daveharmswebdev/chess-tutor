import { describe, expect, it } from "vitest";
import { checkClaims, extractMoveTokens } from "../src/claims.ts";
import type { TutorReply } from "../src/contract.ts";
import { Evidence } from "../src/evidence.ts";
import { fenAfter } from "./helpers.ts";

describe("extractMoveTokens (FR-10)", () => {
  it("finds piece moves, captures, castling, promotions and check marks", () => {
    expect(extractMoveTokens("After Nf3, Black plays exd5 and then O-O. Later Qxh7+ and Rxe8#.")).toEqual([
      "Nf3",
      "exd5",
      "O-O",
      "Qxh7+",
      "Rxe8#",
    ]);
    expect(extractMoveTokens("Long castling O-O-O, or 0-0 written with zeros.")).toEqual(["O-O-O", "0-0"]);
    expect(extractMoveTokens("Promote with e8=Q, or b1N, or dxc8=Q+.")).toEqual(["e8=Q", "b1N", "dxc8=Q+"]);
    expect(extractMoveTokens("Disambiguated: Nbd7, R1e2 and Qh4xe1.")).toEqual(["Nbd7", "R1e2", "Qh4xe1"]);
    expect(extractMoveTokens("Move numbers: 1.d4 d5 2.Bf4 Nf6 3...e6")).toEqual(["Bf4", "Nf6"]);
  });

  it("allows bare squares and pawn pushes, which read as squares", () => {
    expect(extractMoveTokens("Your pawn on e4 controls d5; the a4 square is weak. Play e5 later?")).toEqual([]);
  });

  it("has no false positives on plain English", () => {
    const prose =
      "Be careful: Black can Bend the rules? No. A Knight belongs in the centre. Box, Bxx, Ka, Qa, Re, " +
      "Rook to the back rank. OK, OO, O-Oh, 10-0 win, B2B, K9, Nz3, e9, i4, ax, bx4.";
    expect(extractMoveTokens(prose)).toEqual([]);
  });

  it("ignores UCI and tokens embedded in longer words", () => {
    expect(extractMoveTokens("engine says g1f3 and e7e8q; see xNf3 or Nf3x or Nf3a")).toEqual([]);
  });
});

describe("checkClaims (FR-10)", () => {
  const history = ["d2d4", "d7d5", "c1f4", "g8f6"];
  const fen = fenAfter(history);
  const reply = (over: Partial<TutorReply>): TutorReply => ({
    schemaVersion: 1,
    kind: "hint",
    message: "What does your bishop want?",
    reveal: null,
    revealMove: null,
    arrows: [],
    ...over,
  });
  function evidence() {
    const e = new Evidence();
    e.addPosition(fen);
    e.addLine(fen, ["e2e3", "e7e6", "g1f3"]);
    return e;
  }

  it("accepts moves that are legal and backed by a line", () => {
    expect(checkClaims(reply({ message: "After e3 e6, is Nf3 natural?", reveal: "Nf3 develops." }), evidence(), fen)).toEqual([]);
  });

  it("rejects a legal move that no tool result or key-moment data mentions", () => {
    const problems = checkClaims(reply({ message: "What about Nc3?" }), evidence(), fen);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Nc3/);
  });

  it("rejects a move that is illegal in every position shown", () => {
    const problems = checkClaims(reply({ reveal: "Then Qxh7 wins." }), evidence(), fen);
    expect(problems.join(" ")).toMatch(/Qxh7.*not legal/);
  });

  it("accepts SAN with extra check marks or zero castling when the move is backed", () => {
    const e = evidence();
    const castleFen = fenAfter(["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"]);
    e.addLine(castleFen, ["e1g1"]);
    expect(checkClaims(reply({ message: "Can you castle 0-0+ here? O-O is fine." }), e, fen)).toEqual([]);
  });

  it("checks revealMove: legal UCI in the attempt position and backed", () => {
    expect(checkClaims(reply({ revealMove: "e2e3" }), evidence(), fen)).toEqual([]);
    expect(checkClaims(reply({ revealMove: "b1c3" }), evidence(), fen).join(" ")).toMatch(/b1c3.*not backed/);
    expect(checkClaims(reply({ revealMove: "e2e5" }), evidence(), fen).join(" ")).toMatch(/e2e5.*not a legal/);
    expect(checkClaims(reply({ revealMove: "Nf3" }), evidence(), fen).join(" ")).toMatch(/Nf3.*not a legal UCI/);
    // e7e6 is backed (in the line) but it is Black's move, not legal where the player moves.
    expect(checkClaims(reply({ revealMove: "e7e6" }), evidence(), fen).join(" ")).toMatch(/not a legal/);
  });

  it("does not let message give the revealMove away (FR-8)", () => {
    const e = evidence();
    const problems = checkClaims(reply({ message: "Play Nf3!", revealMove: "g1f3" }), e, fenAfter([...history, "e2e3", "e7e6"]));
    expect(problems.join(" ")).toMatch(/gives the answer away/);
  });

});
