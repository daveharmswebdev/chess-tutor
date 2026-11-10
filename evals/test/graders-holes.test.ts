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

describe("review 038 of #29 (round 2)", () => {
  const illegal = (message: string) => gradeMoves(input(NE5, { message, reveal: null })).illegal;
  const quotes = (message: string) => gradeEvals(input(NE5, { message })).quotes;

  it.each([["Play 9.Nc3 now."], ["9.Nc3! is best."]])("a numbered mention of the current move or later uses the current position: '%s'", (message) => {
    expect(illegal(message)).toEqual(["Nc3"]);
  });

  it("an earlier move number is still a game record", () => {
    expect(illegal("The game began 1.d4 d5 2.Bf4 and 6.Nbd2 came later.")).toEqual([]);
  });

  it.each([
    ["Black's last move was ...b6, so Nc3 is strong."],
    ["Since Black was slow, Nc3 is best."],
    ["Now that you have developed, Nc3 is the move."],
    ["Black played ...b6 so Nc3 is strong."],
  ])("decides tense per clause: '%s' flags Nc3", (message) => {
    expect(illegal(message)).toEqual(["Nc3"]);
  });

  it("carries a past tense along a list of moves, not into a present-tense clause", () => {
    expect(illegal("Black played ...Nc6, ...Bd6 and ...O-O.")).toEqual([]);
    expect(illegal("You played Nd2, and Nc3 is better now.")).toEqual(["Nc3"]);
  });

  it.each([["Black's ...b6 weakened c6."], ["After ...b6 the long diagonal opens."], ["Black's last move ...b6 weakens c6."]])(
    "the opponent's last move is a valid reference without a past-tense cue: '%s'",
    (message) => {
      expect(illegal(message)).toEqual([]);
    },
  );

  it("the position before the last move gives no moves to the player", () => {
    // White to move now; before ...b6 it was Black to move, so a White move there is not current.
    expect(illegal("Play Nb1-c3 now.")).toEqual(["Nb1-c3"]);
  });

  it.each([
    ["You are better by 2.3 and should attack.", 230],
    ["White is down 0.4 or so.", 40],
    ["You are up 1.5 to 2 here.", 150],
    ["The engine gives 1.8 for White.", 180],
    ["The evaluation is 2.3 in White's favour.", 230],
    ["White is 1.5 better.", 150],
  ])("extracts the unsigned evaluation in '%s'", (message, cp) => {
    const q = quotes(message);
    expect(q.map((x) => Math.abs(x.cp ?? 0))).toEqual([cp]);
    expect(q.every((x) => x.problem === "unmatched")).toBe(true);
  });

  it.each([
    ["e4 is defended by 2 pawns."],
    ["Black's c5 pawn is backed up by 2 pawns."],
    // Documented choice: "up N pawns in/of material" is a material count, not an engine evaluation.
    ["After the trade you are up 2 pawns in material."],
    ["The engine's top line after 9.e4 runs at depth 18."],
  ])("does not read '%s' as an evaluation", (message) => {
    expect(quotes(message)).toEqual([]);
  });

  it("keeps whole-pawn evaluations that a lead word frames", () => {
    // "up 2 pawns" alone is material since brief 049 (#29); an advantage word still frames an evaluation.
    expect(quotes("White has an advantage of 2 pawns.").map((q) => q.cp)).toEqual([200]);
    expect(quotes("You are better by 1 here.").map((q) => q.cp)).toEqual([100]);
  });

  describe("castle words", () => {
    const ga = (message: string) => gradeGiveAway(input(NE5, { message, revealMove: "e1g1" })).problems;
    it.each([["Black has already castled. Where is your king safest?"], ["Black castled; is your king safe?"], ["Your opponent castled long."]])(
      "passes '%s' (about the opponent)",
      (message) => {
        expect(ga(message)).toEqual([]);
      },
    );
    it.each([["Is it time to castle?"], ["Should you castle?"], ["What about castling now?"]])("flags '%s'", (message) => {
      expect(ga(message).join(" ")).toMatch(/castl/);
    });
  });

  it.each([
    ["the e4 pawn break", "e3e4", "Think about the e4 pawn break."],
    ["the e4-break", "e3e4", "Think about the e4-break."],
    ["putting your king's knight on e5", "f3e5", "What about putting your king's knight on e5?"],
    ["your knight belongs on e5", "f3e5", "Your knight belongs on e5, doesn't it?"],
  ])("flags '%s' when it is the answer", (_label, revealMove, message) => {
    expect(gradeGiveAway(input(NE5, { message, revealMove })).problems.length).toBeGreaterThan(0);
  });
});
