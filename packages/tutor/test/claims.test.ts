import { describe, expect, it } from "vitest";
import { checkClaims, extractEvals, extractMoveTokens } from "../src/claims.ts";
import type { KeyMoment, Score } from "@chess-tutor/chess-core";
import type { TutorDraft } from "../src/schema.ts";
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
  const reply = (over: Partial<TutorDraft>): TutorDraft => ({
    schemaVersion: 1,
    kind: "hint",
    message: "What does your bishop want?",
    reveal: null,
    revealMove: null,
    arrows: [],
    evals: [],
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
  const reply = (over: Partial<TutorDraft>): TutorDraft => ({
    schemaVersion: 1,
    kind: "hint",
    message: "What would make your king safer?",
    reveal: null,
    revealMove: null,
    arrows: [],
    evals: [],
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


type Entry = TutorDraft["evals"][number];
const W = (cp: number): Entry => ({ side: "white", cp, mate: null });
const B = (cp: number): Entry => ({ side: "black", cp, mate: null });
const WM = (mate: number): Entry => ({ side: "white", cp: null, mate });
const BM = (mate: number): Entry => ({ side: "black", cp: null, mate });
const cp = (value: number): Score => ({ kind: "cp", value });
const mate = (value: number): Score => ({ kind: "mate", value });

describe("evaluations: every quoted evaluation is listed in evals and backed (FR-10, NFR-6, #26)", () => {
  const history = ["d2d4", "d7d5"];
  const fen = fenAfter(history);
  const reply = (message: string, evals: Entry[] = [], reveal: string | null = null): TutorDraft => ({
    schemaVersion: 1,
    kind: "hint",
    message,
    reveal,
    revealMove: null,
    arrows: [],
    evals,
  });
  const scored = (...scores: Score[]) => {
    const e = buildEvidence({ kind: "hint", fen, history });
    scores.forEach((s) => e.addScore(s));
    return e;
  };

  it("passes an entry that matches an engine score for its side exactly", () => {
    expect(checkClaims(reply("Is it level?", [W(20)]), scored(cp(20)), fen)).toEqual([]);
    expect(checkClaims(reply("Is it level?", [B(-20)]), scored(cp(20)), fen)).toEqual([]);
    expect(checkClaims(reply("Who is better?", [B(150), W(-150)]), scored(cp(-150)), fen)).toEqual([]);
    expect(checkClaims(reply("Can you see it?", [BM(3), WM(-3)]), scored(mate(-3)), fen)).toEqual([]);
  });

  it("rejects an entry for the wrong side, with the wrong value or kind, or with no evidence", () => {
    // Wrong side: the engine has White at +1.5, so Black is -150, not +150.
    expect(checkClaims(reply("Who is better?", [B(150)]), scored(cp(150)), fen).join(" ")).toMatch(/evals quotes the evaluation.*black/i);
    // Wrong value: the check is exact.
    expect(checkClaims(reply("Who is better?", [W(151)]), scored(cp(150)), fen)).toHaveLength(1);
    // Wrong kind: a mate is not a centipawn score and the other way round.
    expect(checkClaims(reply("Who is better?", [W(300)]), scored(mate(3)), fen)).toHaveLength(1);
    expect(checkClaims(reply("Who is better?", [WM(3)]), scored(cp(300)), fen)).toHaveLength(1);
    expect(checkClaims(reply("Who is better?", [BM(3)]), scored(mate(3)), fen)).toHaveLength(1);
    // No backing evidence at all.
    expect(checkClaims(reply("Who is better?", [W(0)]), scored(), fen)).toHaveLength(1);
  });

  it("rejects 'You are up 2 pawns (+2.0)' as Black when Black is at -200 (review 037)", () => {
    // White +200 from the engine: Black's own view is -200, so {black, 200} is backed by nothing.
    const problems = checkClaims(reply("You are up 2 pawns (+2.0).", [B(200)]), scored(cp(200)), fen, "b");
    expect(problems.join(" ")).toMatch(/evals quotes the evaluation/);
    // Listed correctly, the prose "+2.0" (White's view, +200) is backed.
    expect(checkClaims(reply("White is up 2 pawns (+2.0).", [B(-200)]), scored(cp(200)), fen, "b")).toEqual([]);
  });

  it("passes 'Black is down 1 pawn but the engine has White at only +0.2' with {white, cp 20} (review 041)", () => {
    expect(checkClaims(reply("Black is down 1 pawn but the engine has White at only +0.2."), scored(cp(20)), fen)).toHaveLength(1);
    expect(checkClaims(reply("Black is down 1 pawn but the engine has White at only +0.2.", [W(20)]), scored(cp(20)), fen)).toEqual([]);
  });

  it("rejects a signed or decimal evaluation or a mate quote in message or reveal that no entry backs", () => {
    const e = scored(cp(-150), cp(420), cp(180), cp(-80), mate(-3));
    for (const text of [
      "+4.2, completely winning",
      "-1.5 for Black",
      "The engine gives 1.8.",
      "That is 0.8 pawns.",
      "a 1.5-pawn edge",
      "150 cp",
      "There is mate in 3.",
      "Engine says M3.",
      "It is #3.",
      "White gets mated in 3.",
    ]) {
      expect(checkClaims(reply(text), e, fen).join(" "), text).toMatch(/message quotes the evaluation/);
      expect(checkClaims(reply("What now?", [], text), e, fen).join(" "), text).toMatch(/reveal quotes the evaluation/);
    }
    // Being in the tool results is not enough: the quote needs an entry.
    expect(checkClaims(reply("+4.2, completely winning"), e, fen)).toHaveLength(1);
    expect(checkClaims(reply("+4.2, completely winning", [W(420)]), e, fen)).toEqual([]);
  });

  it("reads a signed prose number from White's point of view and an unsigned one as a size", () => {
    const e = scored(cp(-150), cp(180), cp(-80));
    expect(checkClaims(reply("The engine says -1.5.", [B(150)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("The engine says -1.5.", [W(-150)]), e, fen)).toEqual([]);
    // "+1.5" is White +150; the listed entry is White -150.
    expect(checkClaims(reply("The engine says +1.5.", [B(150)]), e, fen).join(" ")).toMatch(/"\+1\.5"/);
    expect(checkClaims(reply("Black is 1.5 pawns better.", [B(150)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("The engine gives 1.8.", [W(180)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("Only 0.8 pawns.", [W(-80)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("150 cp for Black.", [B(150)]), e, fen)).toEqual([]);
  });

  it("matches a prose number to an entry within its rounding", () => {
    const e = scored(cp(153), cp(160), cp(180));
    expect(checkClaims(reply("+1.5", [W(153)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("+1.5", [W(160)]), e, fen)).toHaveLength(1);
    expect(checkClaims(reply("+2", [W(180)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("+1.53", [W(153)]), e, fen)).toEqual([]);
  });

  it("requires a mate quote to match a listed mate entry with |mate| = N", () => {
    const e = scored(mate(-3));
    expect(checkClaims(reply("Black has mate in 3.", [BM(3)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("M3 for Black.", [BM(3)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("White gets mated in 3.", [WM(-3)]), e, fen)).toEqual([]);
    expect(checkClaims(reply("Black has mate in 2.", [BM(3)]), e, fen)).toHaveLength(1);
  });

  it("does not count material counts, plain numbers, clock or score phrases as evaluations", () => {
    const text =
      "You are up 2 pawns in material; Black is down 1 pawn. 3 moves, move 12, 1-0, 1/2-1/2, a 2.5/3 score, " +
      "20% of games, +20%, 10.5 seconds left, 1:30 on the clock, 0.5 points, two pawns up.";
    expect(extractEvals(text)).toEqual([]);
    expect(checkClaims(reply(text), scored(), fen)).toEqual([]);
  });

  it("passes an empty evals list with no numbers in the prose", () => {
    expect(checkClaims(reply("What is your opponent threatening?", [], "Your bishop is loose."), scored(), fen)).toEqual([]);
  });

  describe("quoted changes: cpLoss, gainCp, cp_loss as unsigned sizes (FR-10 A2, round 2)", () => {
    const h = ["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "c7c5", "b1c3"];
    const moment = (m: KeyMoment) =>
      buildEvidence({ kind: "key_moment", moment: m, fen: fenAfter(h), attemptFen: fenAfter(h.slice(0, -1)), history: h });
    const blunder = () => moment({ kind: "player_blunder", played: "Nc3", cpLoss: 160, best: "c3" });
    const missed = () => moment({ kind: "missed_win", played: "Nc3", best: "c3", gainCp: 250 });

    it("passes an unsigned quote of the key moment's change, within its rounding", () => {
      expect(checkClaims(reply("That cost you 1.6 pawns."), blunder(), fenAfter(h))).toEqual([]);
      expect(checkClaims(reply("You missed a 2.5-pawn chance."), missed(), fenAfter(h))).toEqual([]);
      expect(checkClaims(reply("That cost you 160 centipawns."), blunder(), fenAfter(h))).toEqual([]);
    });

    it("rejects a size that matches no change", () => {
      expect(checkClaims(reply("That cost you 2.5 pawns."), blunder(), fenAfter(h)).join(" ")).toMatch(/quotes the evaluation "2\.5 pawns"/);
    });

    it("reads a signed number as an evaluation, which a change never backs", () => {
      expect(checkClaims(reply("You are -1.6."), blunder(), fenAfter(h)).join(" ")).toMatch(/quotes the evaluation "-1\.6"/);
    });

    it("never lets a change back an evals entry", () => {
      expect(checkClaims(reply("You missed 2.5 pawns.", [W(250)]), missed(), fenAfter(h)).join(" ")).toMatch(/evals quotes the evaluation/);
    });

    it("passes a size quote of evaluate_move's cp_loss", () => {
      const e = buildEvidence({ kind: "hint", fen, history });
      e.addDelta(70);
      expect(checkClaims(reply("Nothing like the 0.7 pawns you lost before."), e, fen)).toEqual([]);
    });
  });
});

describe("checkClaims: give-aways the check missed (FR-8, NFR-7, #28)", () => {
  const reply = (over: Partial<TutorDraft>): TutorDraft => ({
    schemaVersion: 1,
    kind: "hint",
    message: "What is your opponent's weakest square?",
    reveal: null,
    revealMove: null,
    arrows: [],
    evals: [],
    ...over,
  });

  it("rejects an arrow that starts on the answer's from-square (c1->h6 for Bh6)", () => {
    // 1.d4 Nf6 2.Nf3 g6 3.Nc3 Bg7 4.e4 d6: White's bishop on c1 can go to h6.
    const history = ["d2d4", "g8f6", "g1f3", "g7g6", "b1c3", "f8g7", "e2e4", "d7d6"];
    const fen = fenAfter(history);
    const e = buildEvidence({ kind: "hint", fen, history });
    e.addLine(fen, ["c1h6"]);
    const exact = checkClaims(reply({ revealMove: "c1h6", arrows: [{ from: "c1", to: "h6" }] }), e, fen);
    expect(exact.join(" ")).toMatch(/arrow c1-h6.*gives the answer away/);
    const fromOnly = checkClaims(reply({ revealMove: "c1h6", arrows: [{ from: "c1", to: "g5" }] }), e, fen);
    expect(fromOnly.join(" ")).toMatch(/arrow c1-g5 starts on c1.*gives the answer away/);
    // An arrow at the target, not from the answer's piece, is a Socratic pointer.
    expect(checkClaims(reply({ revealMove: "c1h6", arrows: [{ from: "g7", to: "h6" }] }), e, fen)).toEqual([]);
  });

  it("rejects an arrow from the h4 piece when the answer moves it (h4->g5)", () => {
    // London: 1.d4 d5 2.Bf4 Nf6 3.e3 e6 4.Nf3 Be7 5.Bg5 h6 6.Bh4 Nbd7, White to move.
    const history = ["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "e7e6", "g1f3", "f8e7", "f4g5", "h7h6", "g5h4", "b8d7"];
    const fen = fenAfter(history);
    const e = buildEvidence({ kind: "hint", fen, history });
    e.addLine(fen, ["h4g5"]);
    const problems = checkClaims(reply({ revealMove: "h4g5", arrows: [{ from: "h4", to: "e7" }] }), e, fen);
    expect(problems.join(" ")).toMatch(/arrow h4-e7 starts on h4.*gives the answer away/);
    expect(checkClaims(reply({ revealMove: "h4g5", arrows: [{ from: "e7", to: "g5" }] }), e, fen)).toEqual([]);
  });

  it("rejects naming the answer's piece with the check it gives (a queen check, 'can your queen give a check?')", () => {
    // 1.d4 d5 2.Bf4 Nf6 3.e3 c5 4.c3 Nc6 5.Nd2 Nb4?: White to move; Qa4+ hits the knight.
    const history = ["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "c7c5", "c2c3", "b8c6", "b1d2", "c6b4"];
    const fen = fenAfter(history);
    const e = buildEvidence({ kind: "hint", fen, history });
    e.addLine(fen, ["d1a4"]);
    const problems = checkClaims(reply({ revealMove: "d1a4", message: "Can your queen give a check?" }), e, fen);
    expect(problems.join(" ")).toMatch(/queen.*check.*gives the answer away/);
    expect(checkClaims(reply({ revealMove: "d1a4", message: "Is there a queen check?" }), e, fen)).toHaveLength(1);
    // A general question, or the piece without the check, still passes.
    expect(checkClaims(reply({ revealMove: "d1a4", message: "Black's knight on b4 looks loose. How can you hit it?" }), e, fen)).toEqual([]);
    expect(checkClaims(reply({ revealMove: "d1a4", message: "Where is your queen most active?" }), e, fen)).toEqual([]);
  });
});

describe("checkClaims: false alarms on moves of the game (#26 round 1, review 031)", () => {
  const reply = (message: string): TutorDraft => ({ schemaVersion: 1, kind: "hint", message, reveal: null, revealMove: null, arrows: [], evals: [] });

  it("resolves a move number against that ply of the history ('Your 3.Bf4' after Bg3)", () => {
    // 1.d4 d5 2.Nf3 Nf6 3.Bf4 e6 4.Bg3 c5: White to move, and Bg3-f4 is legal again.
    const history = ["d2d4", "d7d5", "g1f3", "g8f6", "c1f4", "e7e6", "f4g3", "c7c5"];
    const fen = fenAfter(history);
    const e = buildEvidence({ kind: "hint", fen, history });
    expect(checkClaims(reply("Your 3.Bf4 was the right London setup."), e, fen)).toEqual([]);
    expect(checkClaims(reply("Your 3. Bf4 was right, and 3...e6 was solid."), e, fen)).toEqual([]);
    // A move number that was not that move, and a bare mention, are still checked.
    expect(checkClaims(reply("Your 3.Bg5 was the right setup."), e, fen).length).toBe(1);
    expect(checkClaims(reply("Your 5.Bf4 is the plan."), e, fen).length).toBe(1);
    expect(checkClaims(reply("Why not Bf4?"), e, fen).length).toBe(1);
  });

  it("accepts the opponent's castling from the history on the player's turn", () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.O-O Bc5 5.d3 d6 6.c3, Black to move.
    const history = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1", "f8c5", "d2d3", "d7d6", "c2c3"];
    const fen = fenAfter(history);
    const e = buildEvidence({ kind: "hint", fen, history });
    expect(checkClaims(reply("White castled with O-O earlier."), e, fen)).toEqual([]);
    expect(checkClaims(reply("Your opponent's O-O tucked the king away."), e, fen, "b")).toEqual([]);
    // Still rejected: Black's castling, named or not.
    expect(checkClaims(reply("Why not castle with O-O now?"), e, fen).length).toBeGreaterThan(0);
    expect(checkClaims(reply("Black castles with O-O now."), e, fen).length).toBeGreaterThan(0);
    expect(checkClaims(reply("White is fine, so O-O now."), e, fen).length).toBeGreaterThan(0);
  });
});

describe("review 047 fixes (FR-8, FR-10, NFR-6, #26, #28)", () => {
  const reply = (over: Partial<TutorDraft>): TutorDraft => ({
    schemaVersion: 1,
    kind: "hint",
    message: "What now?",
    reveal: null,
    revealMove: null,
    arrows: [],
    evals: [],
    ...over,
  });

  describe("major 1: a mention whose named mover is the opponent is no give-away", () => {
    // 1.d4 Nf6 2.c4 g6 3.Nc3 Bg7 4.e4 d6 5.e5, Black to move; the answer is dxe5.
    const history = ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7", "e2e4", "d7d6", "e4e5"];
    const fen = fenAfter(history);
    const evidence = () => {
      const e = buildEvidence({ kind: "hint", fen, history });
      e.addLine(fen, ["d6e5"]);
      return e;
    };

    it("passes the po-kid-e5-push message (White's pawn to e5 is the opponent's move)", () => {
      const message =
        "White pushed a pawn to e5, deep into your side of the board. Look at that pawn. Who defends it, and can one of your pawns challenge it?";
      expect(checkClaims(reply({ message, revealMove: "d6e5" }), evidence(), fen, "b")).toEqual([]);
    });

    it("still rejects the mention with no side named, or with the player's side named", () => {
      for (const message of ["What about the pawn to e5?", "Can your pawn to e5 help?", "Can Black play dxe5 now?"]) {
        expect(checkClaims(reply({ message, revealMove: "d6e5" }), evidence(), fen, "b").join(" "), message).toMatch(/gives the answer away/);
      }
    });
  });

  describe("major 2: a signed mate quote keeps its sign (White's view)", () => {
    const history = ["d2d4", "d7d5"];
    const fen = fenAfter(history);
    const e = () => {
      const ev = buildEvidence({ kind: "hint", fen, history });
      ev.addScore(mate(-3));
      return ev;
    };
    const evals = [BM(3)];

    it("rejects +M3 when Black mates, passes -M3 and an unsigned mate in 3", () => {
      expect(checkClaims(reply({ message: "White is +M3 here.", evals }), e(), fen).join(" ")).toMatch(/quotes the evaluation "\+M3"/);
      expect(checkClaims(reply({ message: "Black mates: -M3.", evals }), e(), fen)).toEqual([]);
      expect(checkClaims(reply({ message: "Black mates: −M3.", evals }), e(), fen)).toEqual([]);
      expect(checkClaims(reply({ message: "Black has mate in 3.", evals }), e(), fen)).toEqual([]);
    });

    it("keeps the sign in extractEvals", () => {
      expect(extractEvals("-M4")).toEqual([{ raw: "-M4", quote: { kind: "mate", n: 4, white: -4 } }]);
      expect(extractEvals("+M4")[0]!.quote).toEqual({ kind: "mate", n: 4, white: 4 });
      expect(extractEvals("M4")[0]!.quote).toEqual({ kind: "mate", n: 4, white: null });
    });
  });

  it("minor 3: reads an en dash as a minus sign", () => {
    const history = ["d2d4", "d7d5"];
    const fen = fenAfter(history);
    const ev = buildEvidence({ kind: "hint", fen, history });
    ev.addScore(cp(150));
    expect(checkClaims(reply({ message: "White is –1.5.", evals: [W(150)] }), ev, fen).join(" ")).toMatch(/quotes the evaluation "–1\.5"/);
    expect(checkClaims(reply({ message: "White is +1.5.", evals: [W(150)] }), ev, fen)).toEqual([]);
  });
});
