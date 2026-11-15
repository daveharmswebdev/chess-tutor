import { readFileSync } from "node:fs";
import type { TutorReply } from "@chess-tutor/tutor";
import { describe, expect, it } from "vitest";
import { CASES_DIR } from "../src/config.ts";
import { gradeEvals, gradeGiveAway, gradeMoves, type GradeInput, type ToolResultRecord } from "../src/graders.ts";
import type { EvalCase } from "../src/types.ts";

/** The last grader holes before the CI eval gate: PR #35 false fails, review 056, minors (issue #29, brief 057). */

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

/** One analyze_position result at the case's attempt position with a single White-POV score. */
const analysis = (c: EvalCase, evalCp: number): ToolResultRecord => ({
  name: "analyze_position",
  input: { fen: c.attemptFen },
  isError: false,
  content: JSON.stringify({ fen: c.attemptFen, side_to_move: c.attemptFen.split(" ")[1] === "b" ? "black" : "white", depth: 16, lines: [{ rank: 1, eval_cp: evalCp, mate_in: null, moves: [] }] }),
});

/** KID, missed win: Black should have played ...dxe5 (engine -563 after it, White POV). */
const NE5_A6 = evalCase("mw-kid-ne5-a6");
/** KID, punish: Black takes ...Bxg4 (engine -323, White POV). */
const G4 = evalCase("po-kid-g4");
/** London, missed win: Nxc7+ forks king and rook. */
const H6_E3 = evalCase("mw-london-h6-e3");
/** KID, Black to move after 8.dxe5; the answer is ...dxe5 (d6e5). */
const EXCHANGE = evalCase("lb-kid-exchange");
/** KID, Black to move after 10.Nxe5; the answer is ...Nxe5 (d7e5). */
const NXE5 = evalCase("po-kid-nxe5");
/** KID Saemisch, Black to move after 5.f3; the answer is castling (e8g8). */
const SAEMISCH = evalCase("lb-kid-saemisch");
/** London, White to move after 8...b6; White can castle (e1g1). */
const NE5 = evalCase("hint-london-ne5");
/** KID, Black to move after 1.e4. */
const E4 = evalCase("lb-kid-e4");

const evalQuotes = (c: EvalCase, text: string, evalCp: number) => gradeEvals(input(c, { message: "What now?", reveal: text }, { toolResults: [analysis(c, evalCp)] })).quotes;
const giveAway = (c: EvalCase, message: string, revealMove = c.engineBest) => gradeGiveAway(input(c, { message, revealMove })).problems;
const illegal = (c: EvalCase, text: string) => gradeMoves(input(c, { message: "What now?", reveal: text, revealMove: null })).illegal;

describe("(1) a signed score is White's view: naming the side it favours does not flip it again", () => {
  it.each([
    [NE5_A6, "The engine rates it at −5.63, which is a huge edge for Black.", -563],
    [NE5_A6, "The engine rates it at -5.63, which is a huge edge for Black.", -563],
    [G4, "The engine rates the position after Bxg4 at −3.23, which is clearly better for Black.", -323],
    [G4, "The engine rates the position after Bxg4 at -3.23, which is clearly better for Black.", -323],
    [NE5, "It is +2.1, a clear edge for White.", 210],
    [NE5, "At −1.5, White is worse.", -150],
  ])("passes (case %#) '%s'", (c, text, cp) => {
    const q = evalQuotes(c, text, cp);
    expect(q.length).toBe(1);
    expect(q[0]!.problem).toBeNull();
  });

  it.each([
    [NE5, "It is +2.1, a clear edge for Black.", 210],
    [NE5, "It is +2.1, a clear edge for Black.", -210],
    [NE5_A6, "The engine rates it at −5.63, which is a huge edge for White.", -563],
    [G4, "At -3.23, Black is worse.", -323],
  ])("a signed number that names the wrong side for its sign stays wrong_side (case %#) '%s'", (c, text, cp) => {
    expect(evalQuotes(c, text, cp).map((q) => q.problem)).toEqual(["wrong_side"]);
  });

  it("a side named as the number's subject, with no direction word, keeps the side-relative reading", () => {
    // graders.test.ts: "Black is +0.4 here" with eval_pov black +0.4 passes; unchanged here.
    expect(evalQuotes(NE5, "Black is +0.4 here.", -40).map((q) => q.problem)).toEqual([null]);
    expect(evalQuotes(NE5, "White is +0.4 here.", -40).map((q) => q.problem)).toEqual(["wrong_side"]);
  });
});

describe("(2) a piece value after a piece word or 'which' is not an evaluation", () => {
  it.each([
    ["That wins a whole rook, which is worth about 6 pawns."],
    ["You win a knight, worth 3 pawns."],
    ["You win a knight worth 3 pawns."],
    ["That wins a bishop, which is worth roughly a pawn more than a knight here."],
    ["The exchange, which is worth 2 pawns, goes."],
  ])("'%s' has no quote", (text) => {
    expect(evalQuotes(H6_E3, text, 717)).toEqual([]);
  });

  it.each([
    ["That wins a whole rook, which is worth +9.5."],
    ["The edge, which is worth about 1.5 pawns, is clear."],
    ["Your position is worth about 4 pawns more."],
  ])("still grades '%s'", (text) => {
    expect(evalQuotes(H6_E3, text, 717).map((q) => q.problem)).toEqual(["unmatched"]);
  });
});

describe("(3) the opponent-history skip needs a real playing verb (review 056)", () => {
  it.each([
    [EXCHANGE, "White was worried about dxe5."],
    [EXCHANGE, "White's dxe5 is answered by dxe5."],
    [EXCHANGE, "White had dxe5 in mind."],
    [NXE5, "White was worried about Nxe5."],
    [NXE5, "White's Nxe5 is answered by Nxe5."],
  ])("flags (case %#) '%s'", (c, message) => {
    expect(giveAway(c, message).join(" ")).toMatch(/names the answer/);
  });

  it.each([
    ["White's last move, dxe5, opened the d-file."],
    ["White traded with dxe5."],
    ["White took your pawn with dxe5."],
    ["After your ...e5, White played dxe5."],
    ["White exchanged pawns with dxe5."],
    ["White played dxe5, opening the d-file. How do you recapture?"],
  ])("keeps '%s' ok", (message) => {
    expect(giveAway(EXCHANGE, message)).toEqual([]);
  });

  it("keeps the opponent's own move ok in po-kid-nxe5", () => {
    expect(giveAway(NXE5, "White took your pawn with Nxe5.")).toEqual([]);
    expect(giveAway(NXE5, "White's Nxe5 grabbed a pawn.")).toEqual([]);
  });
});

describe("(5a) NEGATED accepts curly apostrophes", () => {
  it.each([
    ["White hasn’t castled yet. Your king is in the centre too."],
    ["White didn’t castle. Your king is still in the middle too."],
    ["White isn’t castled. Your king is in the centre too."],
  ])("passes '%s'", (message) => {
    expect(giveAway(SAEMISCH, message, "e8g8")).toEqual([]);
  });

  it("still flags a positive opponent castle with a curly apostrophe nearby", () => {
    expect(giveAway(NE5, "Black’s king castled already; you should too.", "e1g1").join(" ")).toMatch(/castl/);
  });
});

describe("(5b) a 'too' after an opponent castle copies it only when the player's clause is about castling or the king", () => {
  it.each([["Black castled; your bishop is strong too."], ["Black castled; you have a good knight too."], ["Black castled and your pieces are active too."]])(
    "passes '%s'",
    (message) => {
      expect(giveAway(NE5, message, "e1g1")).toEqual([]);
    },
  );

  it.each([
    ["Black castled already; you should too."],
    ["Black castled; you can as well."],
    ["Black castled already; your king wants safety as well."],
    ["Black castled and you should too."],
    ["Black castled; get your king safe too."],
  ])("flags '%s'", (message) => {
    expect(giveAway(NE5, message, "e1g1").join(" ")).toMatch(/castl/);
  });
});

describe("(5c) a plan sentence is not graded as a claimed move (lb-kid-e4)", () => {
  it.each([
    ["Put the bishop on g7."],
    ["The plan is to bring the knight to d5."],
    ["The plan is the same one you know. Put a pawn on g6 and the bishop on g7 on the long diagonal."],
    ["Then put your bishop on g7."],
  ])("'%s' is not illegal", (text) => {
    expect(illegal(E4, text)).toEqual([]);
  });

  it.each([
    ["What about putting your knight on e5?", "putting your knight on e5"],
    ["Play Bg7 now.", "Bg7"],
    ["Put the bishop on g7 now.", "Put the bishop on g7"],
    ["You played Nd5 earlier.", "Nd5"],
  ])("still grades '%s'", (text, raw) => {
    expect(illegal(E4, text)).toEqual([raw]);
  });

  it("a plan sentence still gives the answer away (NFR-7 is unchanged)", () => {
    expect(giveAway(NE5, "Put your knight on e5.", "f3e5").join(" ")).toMatch(/names the answer/);
  });
});

describe("round 2: the opponent's real last move described as a past placement is not the answer (po-kid-nxe5)", () => {
  it.each([
    ["White just put a knight on e5. Count the attackers and defenders on that square. How many of your pieces hit it, and how many White pieces guard it?"],
    ["White has put a knight on e5."],
    ["White has just put a knight on e5."],
    ["White brought the knight to e5."],
    ["White has brought a knight to e5."],
    ["White just moved the knight to e5."],
    ["White has moved the knight to e5."],
  ])("passes '%s'", (message) => {
    expect(giveAway(NXE5, message)).toEqual([]);
  });

  it.each([
    ["Put a knight on e5."],
    ["You should put a knight on e5."],
    ["White would love to put a knight on e5."],
    ["White wants to put a knight on e5."],
    ["You just put a knight on e5."],
  ])("keeps '%s' flagged", (message) => {
    expect(giveAway(NXE5, message).join(" ")).toMatch(/names the answer/);
  });

  it("a past placement that is not the opponent's real last move stays flagged", () => {
    // hint-london-ne5: Black's last move was ...b6; the answer here is Nf3-e5.
    expect(giveAway(NE5, "Black just put a knight on e5.", "f3e5").join(" ")).toMatch(/names the answer/);
    expect(giveAway(NE5, "Black has moved the knight to e5.", "f3e5").join(" ")).toMatch(/names the answer/);
  });
});

/** Review 059 (brief 060): the round-1 rules narrowed to what they were meant to catch. */
describe("review 059 of #29 (round 3)", () => {
  /** One analyze_position result with several White-POV scores. */
  const multi = (c: EvalCase, cps: number[]): ToolResultRecord => ({
    ...analysis(c, cps[0]!),
    content: JSON.stringify({ fen: c.attemptFen, depth: 16, lines: cps.map((eval_cp, i) => ({ rank: i + 1, eval_cp, mate_in: null, moves: [] })) }),
  });
  const problems = (c: EvalCase, text: string, cps: number[]) =>
    gradeEvals(input(c, { message: "What now?", reveal: text }, { toolResults: [multi(c, cps)] })).quotes.map((q) => q.problem);

  describe("(A) the White's-view override needs a direction word attached to a side in the quote's own clause", () => {
    it.each([
      [H6_E3, "You played Bd3, but Bg3 was better: after Bd3 the engine gives −1.2.", [-120], [null]],
      [G4, "A better move was ...Bxg4, after which White is at −3.23.", [-323], [null]],
      [G4, "White was better at +0.3 before, but after Bxg4 it is −3.23.", [30, -323], [null, null]],
      [NE5_A6, "The knight on the edge is poor, and White is at −5.63.", [-563], [null]],
    ])("passes (case %#) '%s'", (c, text, cps, want) => {
      expect(problems(c, text, cps)).toEqual(want);
    });

    it.each([
      [NE5_A6, "The engine rates it at −5.63, which is a huge edge for Black.", [-563], [null]],
      [G4, "The engine rates the position after Bxg4 at −3.23, which is clearly better for Black.", [-323], [null]],
      [NE5, "It is +2.1, a clear edge for Black.", [210], ["wrong_side"]],
      [NE5, "It is +2.1, a clear edge for Black.", [-210], ["wrong_side"]],
      [NE5, "Black is better at +2.1.", [210], ["wrong_side"]],
      [NE5, "White is up at +2.1.", [210], [null]],
      [NE5, "At +2.1 the advantage to Black is clear.", [210], ["wrong_side"]],
    ])("keeps round 2's verdict (case %#) '%s'", (c, text, cps, want) => {
      expect(problems(c, text, cps)).toEqual(want);
    });
  });

  describe("(B) more playing verbs, and no passive head", () => {
    it.each([
      ["White answered your ...e5 with dxe5."],
      ["White replied with dxe5."],
      ["White chose dxe5, opening the centre."],
      ["White went for dxe5."],
      ["White opted for dxe5."],
      ["White met your ...e5 with dxe5."],
      ["White has just played dxe5."],
      ["White just exchanged with dxe5."],
      ["White took with dxe5."],
    ])("passes '%s'", (message) => {
      expect(giveAway(EXCHANGE, message)).toEqual([]);
    });

    it.each([
      [EXCHANGE, "White was worried about dxe5."],
      [EXCHANGE, "White's dxe5 is answered by dxe5."],
      [EXCHANGE, "White's dxe5 was met by dxe5."],
      [EXCHANGE, "White fears dxe5."],
      [NXE5, "White's Nxe5 is answered by Nxe5."],
    ])("keeps (case %#) '%s' flagged", (c, message) => {
      expect(giveAway(c, message).join(" ")).toMatch(/names the answer/);
    });
  });

  describe("(C) a piece value needs a singular piece word right before ', which' or ', worth', and a plausible value", () => {
    it.each([["Black gets a big lead, which is worth about 7 pawns."], ["Your pieces, worth 9 pawns more than White's, should win."], ["Taking the pawn, worth 9 pawns of advantage."]])(
      "grades '%s'",
      (text) => {
        expect(problems(G4, text, [-323])).toEqual(["unmatched"]);
      },
    );

    it.each([["That wins a whole rook, which is worth about 6 pawns."], ["You win a knight, worth 3 pawns."]])("still does not grade '%s'", (text) => {
      expect(problems(G4, text, [-323])).toEqual([]);
    });
  });
});
