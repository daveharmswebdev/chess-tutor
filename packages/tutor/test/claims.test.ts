import { describe, expect, it } from "vitest";
import { checkClaims, extractEvals, extractMoveTokens } from "../src/claims.ts";
import type { TutorReply } from "../src/contract.ts";
import { Evidence } from "../src/evidence.ts";
import { buildEvidence } from "../src/request.ts";
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
    expect(extractMoveTokens("Move numbers: 1.d4 d5 2.Bf4 Nf6 3...e6")).toEqual(["d4", "Bf4", "Nf6", "e6"]);
  });

  it("allows bare squares, which are not moves", () => {
    expect(extractMoveTokens("Your pawn on e4 controls d5; the a4 square is weak, the e5 square too, and the a-file is open.")).toEqual([]);
  });

  it("treats a square as a pawn move after push/play/advance, a move number, or before ! ? + #", () => {
    expect(extractMoveTokens("Push h5! It wins")).toEqual(["h5"]);
    expect(extractMoveTokens("Play e5 later? After 12.h4 and 12...h5, or ...g5, then 13. g4 ...")).toEqual(["e5", "h4", "h5", "g5", "g4"]);
    expect(extractMoveTokens("advance c5, playing d5, he plays f4, try b4, then e6?! or a6?? or h3+")).toEqual(["c5", "d5", "f4", "b4", "e6", "a6", "h3"]);
  });

  it("recognises long algebraic, lowercase pieces, figurines and '<piece> to <square>' (reviewer probe)", () => {
    expect(extractMoveTokens("Nb1-c3, Ng8-f6, nf6, ♘f3, Bc4xf7, Knight to g4")).toEqual([
      "Nb1-c3",
      "Ng8-f6",
      "nf6",
      "♘f3",
      "Bc4xf7",
      "Knight to g4",
    ]);
    expect(extractMoveTokens("e2-e4, then the bishop goes to b5 and the pawn to e5; bxc3 is a pawn capture")).toEqual([
      "e2-e4",
      "bishop goes to b5",
      "pawn to e5",
      "bxc3",
    ]);
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


  it("checks pawn pushes in move contexts (reviewer probe 'Push h5! It wins')", () => {
    const blackFen = fenAfter(["d2d4", "d7d5", "c1f4"]);
    const e = new Evidence();
    e.addPosition(blackFen);
    expect(checkClaims(reply({ message: "Push h5! It wins" }), e, blackFen).join(" ")).toMatch(/h5/);
    e.addLine(blackFen, ["h7h5"]);
    expect(checkClaims(reply({ message: "Push h5! It wins" }), e, blackFen)).toEqual([]);
  });

  it("ignores a square in a move context that is no legal move anywhere (it is a square)", () => {
    expect(checkClaims(reply({ message: "The key square is d5!" }), evidence(), fen)).toEqual([]);
  });

  it("checks long algebraic, figurines and '<piece> to <square>' like SAN", () => {
    const e = evidence();
    expect(checkClaims(reply({ message: "Later ♘f3, or Ng1-f3." }), e, fen)).toEqual([]);
    expect(checkClaims(reply({ message: "What about the Knight to c3?" }), e, fen).join(" ")).toMatch(/Knight to c3/);
    expect(checkClaims(reply({ message: "Then Knight to g4." }), e, fen).join(" ")).toMatch(/Knight to g4/);
  });

  it("does not let an arrow give the revealMove away (FR-8)", () => {
    const problems = checkClaims(reply({ revealMove: "e2e3", arrows: [{ from: "e2", to: "e3" }] }), evidence(), fen);
    expect(problems.join(" ")).toMatch(/arrow.*gives the answer away/);
    expect(checkClaims(reply({ revealMove: "e2e3", arrows: [{ from: "f4", to: "b8" }] }), evidence(), fen)).toEqual([]);
  });

  it("does not let message name a pawn-push revealMove (FR-8)", () => {
    const problems = checkClaims(reply({ message: "Why not play e3?", revealMove: "e2e3" }), evidence(), fen);
    expect(problems.join(" ")).toMatch(/gives the answer away/);
  });
});

describe("checkClaims: a move is backed only in the position it was played from (reviewer probe)", () => {
  // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.O-O Bc5 5.d3 d6 6.c3, Black to move.
  const history = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1", "f8c5", "d2d3", "d7d6", "c2c3"];
  const fen = fenAfter(history);
  const hint = { kind: "hint" as const, fen, history };
  const reply = (over: Partial<TutorReply>): TutorReply => ({
    schemaVersion: 1,
    kind: "hint",
    message: "What would make your king safer?",
    reveal: null,
    revealMove: null,
    arrows: [],
    ...over,
  });

  it("rejects Black's O-O and e8g8 when only White's history castled", () => {
    const e = buildEvidence(hint);
    expect(checkClaims(reply({ message: "Why not castle with O-O now?", reveal: "Play O-O." }), e, fen).length).toBeGreaterThan(0);
    expect(checkClaims(reply({ revealMove: "e8g8" }), e, fen).length).toBeGreaterThan(0);
  });

  it("accepts them once an engine line from the current position has O-O", () => {
    const e = buildEvidence(hint);
    e.addLine(fen, ["e8g8", "b1d2"]);
    expect(checkClaims(reply({ message: "Why not castle with O-O now?", reveal: "Play O-O." }), e, fen)).toEqual([]);
    expect(checkClaims(reply({ revealMove: "e8g8", reveal: "O-O, then Nbd2 for White." }), e, fen)).toEqual([]);
  });

  it("still accepts a mention of a move already played in the game", () => {
    expect(checkClaims(reply({ message: "Your opponent's Bc4 aims at f7." }), buildEvidence(hint), fen)).toEqual([]);
  });

  it("backs key-moment moves where they were played", () => {
    const blunderHistory = ["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "c7c5", "b1c3"];
    const attemptFen = fenAfter(blunderHistory.slice(0, -1));
    const e = buildEvidence({
      kind: "key_moment",
      moment: { kind: "player_blunder", played: "Nc3", cpLoss: 160, best: "c3" },
      fen: fenAfter(blunderHistory),
      attemptFen,
      history: blunderHistory,
    });
    expect(e.backsMove(attemptFen, "c2c3")).toBe(true);
    expect(e.backsMove(attemptFen, "b1c3")).toBe(true);
    expect(checkClaims(reply({ kind: "player_blunder", revealMove: "c2c3", message: "That cost you 1.6 pawns." }), e, attemptFen)).toEqual([]);
  });
});

describe("evaluations (FR-10)", () => {
  const fen = fenAfter(["d2d4", "d7d5"]);
  const reply = (message: string): TutorReply => ({ schemaVersion: 1, kind: "hint", message, reveal: null, revealMove: null, arrows: [] });
  const ev = (cps: number[] = [], mates: number[] = []) => {
    const e = buildEvidence({ kind: "hint", fen, history: ["d2d4", "d7d5"] });
    cps.forEach((c) => e.addCp(c));
    mates.forEach((m) => e.addMate(m));
    return e;
  };

  it("extracts signed pawns, pawns, centipawns and mates, but not plain numbers", () => {
    expect(extractEvals("+4.2, completely winning; -1.5 for Black; 0.8 pawns; 2 pawns up; 150 cp; 90 centipawns; mate in 3; M2").map((e) => e.raw)).toEqual([
      "+4.2",
      "-1.5",
      "0.8 pawns",
      "2 pawns up",
      "150 cp",
      "90 centipawns",
      "mate in 3",
      "M2",
    ]);
    expect(extractEvals("3 moves, move 12, 1-0, 20% of games, +20%, two pawns up, e4-e5, Nb1-c3, 12...h5, 1/2-1/2")).toEqual([]);
  });

  it("rejects an evaluation with no tool score behind it (reviewer probe '+4.2, completely winning')", () => {
    expect(checkClaims(reply("+4.2, completely winning"), ev(), fen).join(" ")).toMatch(/\+4\.2/);
  });

  it("accepts an evaluation within 0.3 pawns of a backed score, from either side", () => {
    expect(checkClaims(reply("+4.2, completely winning"), ev([400]), fen)).toEqual([]);
    expect(checkClaims(reply("+4.2, completely winning"), ev([380]), fen).length).toBe(1);
    expect(checkClaims(reply("Black is -1.6 here"), ev([160]), fen)).toEqual([]);
    expect(checkClaims(reply("You lost about 150 cp"), ev([160]), fen)).toEqual([]);
    expect(checkClaims(reply("That is 1.5 pawns"), ev([-150]), fen)).toEqual([]);
  });

  it("requires mate in N exactly", () => {
    expect(checkClaims(reply("There is mate in 3."), ev([], [3]), fen)).toEqual([]);
    expect(checkClaims(reply("There is mate in 3."), ev([], [-2]), fen).length).toBe(1);
    expect(checkClaims(reply("Engine says M2."), ev([], [-2]), fen)).toEqual([]);
  });

  it("takes key-moment cpLoss and gainCp as backed scores", () => {
    const history = ["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "c7c5", "b1c3"];
    const e = buildEvidence({
      kind: "key_moment",
      moment: { kind: "missed_win", played: "Nc3", best: "c3", gainCp: 250 },
      fen: fenAfter(history),
      attemptFen: fenAfter(history.slice(0, -1)),
      history,
    });
    expect(checkClaims(reply("You missed +2.5"), e, fen)).toEqual([]);
  });
});
