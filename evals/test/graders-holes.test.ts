import { readFileSync } from "node:fs";
import type { TutorReply } from "@chess-tutor/tutor";
import { describe, expect, it } from "vitest";
import { CASES_DIR } from "../src/config.ts";
import { gradeEvals, gradeGiveAway, gradeMoves, type GradeInput } from "../src/graders.ts";
import type { EvalCase } from "../src/types.ts";

/** The false-pass holes found in review 034 of #10 (issue #29). */

const evalCase = (id: string) => JSON.parse(readFileSync(`${CASES_DIR}/${id}.json`, "utf8")) as EvalCase;

function input(c: EvalCase, reply: Partial<TutorReply>, over: Partial<GradeInput> = {}): GradeInput {
  return {
    kind: c.kind,
    playerColor: c.playerColor,
    history: c.history,
    fen: c.fen,
    attemptFen: c.attemptFen,
    moment: c.moment,
    engineBest: c.engineBest,
    reply: { schemaVersion: 1, kind: c.kind, message: "What is your plan?", reveal: null, revealMove: c.engineBest, arrows: [], ...reply } as TutorReply,
    toolResults: [],
    revealCpLoss: null,
    toleranceCp: 50,
    ...over,
  };
}

/** London, White to move after 8...b6; the engine's best is e3e4. */
const NE5 = evalCase("hint-london-ne5");
/** KID, Black to move, can castle. */
const KID_CASTLE = evalCase("hint-kid-castle");

describe("NFR-6 evaluations: unsigned quotes are extracted (#29)", () => {
  const quotes = (message: string) => gradeEvals(input(NE5, { message })).quotes;

  it.each([
    ["You are better by 2.3 here.", 230],
    ["White is down 0.4 after that.", 40],
    ["Black keeps a 1.5-pawn edge.", 150],
  ])("extracts '%s' and fails it without a backing score", (message, cp) => {
    const q = quotes(message);
    expect(q.map((x) => Math.abs(x.cp ?? 0))).toEqual([cp]);
    expect(q[0]!.problem).toBe("unmatched");
  });

  it("passes an unsigned quote that a tool result backs, with the side", () => {
    const analysis = {
      name: "analyze_position",
      input: { fen: NE5.fen },
      isError: false,
      content: JSON.stringify({ lines: [{ rank: 1, eval_cp: 40, mate_in: null, moves: [] }] }),
    };
    expect(gradeEvals(input(NE5, { message: "You are better by 0.4 here." }, { toolResults: [analysis] })).pass).toBe(true);
    expect(gradeEvals(input(NE5, { message: "White is down 0.4 here." }, { toolResults: [analysis] })).quotes[0]?.problem).toBe("wrong_side");
  });

  it("does not read a material count as an evaluation", () => {
    expect(quotes("You have 2 pawns on the queenside against 3.")).toEqual([]);
    expect(quotes("Black's 3 pawns on the kingside are strong; move up 2 squares.")).toEqual([]);
  });
});

describe("NFR-6 legality: a move played now is checked against the current position (#29)", () => {
  const illegal = (message: string) => gradeMoves(input(NE5, { message, reveal: null })).illegal;

  it("flags 'Play Nc3 now' (legal only before 6.Nbd2)", () => {
    expect(illegal("Play Nc3 now.")).toEqual(["Nc3"]);
  });

  it("flags 'Black plays Nb8-c6' (the knight left b8 on move 5)", () => {
    expect(illegal("Black plays Nb8-c6.")).toEqual(["Nb8-c6"]);
  });

  it("flags a next-move mention that is legal only in an earlier position", () => {
    expect(illegal("Your next move should be Nc3.")).toEqual(["Nc3"]);
  });

  it("keeps current moves, plans and lines legal", () => {
    expect(illegal("Play e4 now. Then Qe2 and Rad1.")).toEqual([]);
  });

  it("lets past-tense references and game-record move numbers use the game's history", () => {
    expect(illegal("Earlier you played Nd2 instead of Nc3.")).toEqual([]);
    expect(illegal("Black played ...Nc6 and castled with O-O.")).toEqual([]);
    expect(illegal("After 1.d4 d5 2.Bf4 Nf6 3.e3 you reached the London.")).toEqual([]);
  });

  it("checks a past-tense mention in the same sentence as 'now' against the current position", () => {
    expect(illegal("You played Bf4 earlier, and now Nc3 is the move.")).toEqual(["Nc3"]);
  });
});

describe("NFR-7 give-away wordings (#29)", () => {
  /** london-qd6 punish_opponent: the answer is the checking Bb5+. */
  const QD6 = {
    ...NE5,
    kind: "punish_opponent" as const,
    fen: "rnb1kb1r/ppp1pppp/3q1n2/3p4/3P1B2/4P3/PPP2PPP/RN1QKBNR w KQkq - 1 4",
    attemptFen: "rnb1kb1r/ppp1pppp/3q1n2/3p4/3P1B2/4P3/PPP2PPP/RN1QKBNR w KQkq - 1 4",
    history: ["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "d8d6"],
    engineBest: "f1b5",
    moment: null,
  };
  const problems = (c: EvalCase, reply: Partial<TutorReply>, over: Partial<GradeInput> = {}) => gradeGiveAway(input(c, reply, over)).problems;

  it.each([
    ["a bishop check", QD6, "f1b5", "Is there a bishop check that wins something?"],
    ["checks with your bishop", QD6, "f1b5", "What happens if White checks with your bishop?"],
    ["castle in words", KID_CASTLE, "e8g8", "Is it time to castle?"],
    ["the e4 break", NE5, "e3e4", "Think about the e4 break."],
    ["putting your knight on e5", NE5, "f3e5", "What about putting your knight on e5?"],
  ])("flags '%s' when it is the answer", (_label, c, revealMove, message) => {
    const p = problems(c, { message, revealMove });
    expect(p.length).toBeGreaterThan(0);
  });

  it("does not flag the same wordings when they are not the answer", () => {
    expect(problems(NE5, { message: "Is it time to castle?", revealMove: "e3e4" })).toEqual([]);
    expect(problems(NE5, { message: "Think about the c4 break.", revealMove: "e3e4" })).toEqual([]);
    expect(problems(NE5, { message: "What about putting your knight on e5?", revealMove: "e3e4" })).toEqual([]);
  });

  it("grades a null revealMove against the case's engine best instead of passing", () => {
    const p = problems(NE5, { message: "Play e4 now!", revealMove: null });
    expect(p.join(" ")).toMatch(/e3e4/);
    expect(problems(NE5, { message: "What is your plan?", revealMove: null })).toEqual([]);
    expect(problems(NE5, { message: "Play e4 now!", revealMove: null }, { engineBest: null })).toEqual([]);
  });
});
