import { readFileSync } from "node:fs";
import type { TutorReply } from "@chess-tutor/tutor";
import { describe, expect, it } from "vitest";
import { CASES_DIR } from "../src/config.ts";
import { gradeEvals, gradeGiveAway, gradeMoves, type GradeInput } from "../src/graders.ts";
import type { EvalCase } from "../src/types.ts";

/** Review 042 majors, the named-mover false alarms of PR #33 and the PR #32 minors (issue #29, brief 049). */

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

/** London, White to move after 8...b6; the engine's best is e3e4; White can castle (e1g1). */
const NE5 = evalCase("hint-london-ne5");
/** KID, Black to move after 8.dxe5; the answer is ...dxe5 (d6e5). */
const EXCHANGE = evalCase("lb-kid-exchange");
/** KID, Black to move after 5.e5; the answer is ...dxe5 (d6e5). */
const E5_PUSH = evalCase("po-kid-e5-push");
/** KID, Black to move after 1.d4 Nf6 2.Nf3; the answer is ...d5 (d7d5). */
const NF3_MOVE2 = evalCase("lb-kid-nf3-move2");
/** London, missed win: after 3...Qd6 White played 4.Nc3 instead of Bxd6. */
const QD6_NC3 = evalCase("mw-london-qd6-nc3");

const illegal = (c: EvalCase, message: string) => gradeMoves(input(c, { message, reveal: null })).illegal;
const giveAway = (c: EvalCase, message: string, revealMove = c.engineBest) => gradeGiveAway(input(c, { message, revealMove })).problems;
const quotes = (message: string) => gradeEvals(input(NE5, { message })).quotes;

describe("A1: a past tense carries only into list items, not a mention with its own predicate", () => {
  it.each([["After Black played ...b6, Nc3 is strong."], ["Black played ...b6 and Nc3 is the right reply."]])("'%s' flags Nc3", (message) => {
    expect(illegal(NE5, message)).toEqual(["Nc3"]);
  });

  it("a counterfactual 'would have' stays in the past", () => {
    expect(illegal(NE5, "You played Nd2 where Nc3 would have been more active.")).toEqual([]);
  });

  it("still carries the past tense along a list", () => {
    expect(illegal(NE5, "Black played ...Nc6, ...Bd6 and ...O-O.")).toEqual([]);
  });
});

describe("A2: from the position before the last move only the history's own last move counts", () => {
  it("flags 'Black threatens ...Qb6.' (b6 is occupied now)", () => {
    expect(illegal(NE5, "Black threatens ...Qb6.")).toEqual(["Qb6"]);
  });

  it("keeps the last move itself", () => {
    expect(illegal(NE5, "After ...b6 the long diagonal opens.")).toEqual([]);
  });
});

describe("A3: 'do the same' after the opponent castled gives castling away", () => {
  it.each([["Black castled already; you should do the same."], ["Black has castled. Do the same!"]])("flags '%s' when the answer is O-O", (message) => {
    expect(giveAway(NE5, message, "e1g1").join(" ")).toMatch(/castl/);
  });

  it("does not flag it when the answer is not castling", () => {
    expect(giveAway(NE5, "Black castled already; you should do the same.", "e3e4")).toEqual([]);
  });
});

describe("A4: piece values are not evaluations", () => {
  it.each([["A bishop is worth 3 pawns."], ["A rook is worth about 5 pawns, a knight 3."]])("'%s' passes", (message) => {
    expect(gradeEvals(input(NE5, { message })).pass).toBe(true);
  });
});

describe("B: a move the named opponent already played", () => {
  it("is not a give-away: 'White played dxe5'", () => {
    expect(giveAway(EXCHANGE, "White played dxe5, opening the d-file. How do you recapture?")).toEqual([]);
  });

  it("is not a give-away: 'White pushed the pawn to e5'", () => {
    expect(giveAway(E5_PUSH, "White pushed the pawn to e5, attacking your knight. What now?")).toEqual([]);
  });

  it("is not a give-away when a move number names an earlier move: 'It is not 1...d5 or 1...Nf6'", () => {
    expect(giveAway(NF3_MOVE2, "It is not 1...d5 or 1...Nf6 any more: White played 2.Nf3. What fits your setup?")).toEqual([]);
  });

  it("is not illegal: \"Black's last move, Qd6\"", () => {
    expect(illegal(QD6_NC3, "Black's last move, Qd6, put the queen on a square your bishop attacks.")).toEqual([]);
  });

  it("mentions naming the player's own side are graded as before", () => {
    expect(giveAway(EXCHANGE, "Black should recapture with dxe5.").length).toBeGreaterThan(0);
    expect(giveAway(EXCHANGE, "You can play dxe5 here.").length).toBeGreaterThan(0);
    expect(giveAway(E5_PUSH, "Your pawn to e5 is the move.").length).toBeGreaterThan(0);
    expect(illegal(NE5, "You should play Nc3 now.")).toEqual(["Nc3"]);
    expect(illegal(NE5, "White plays Nc3 now.")).toEqual(["Nc3"]);
  });

  it("an opponent move named in the present tense is still checked now", () => {
    expect(illegal(NE5, "Black plays Nb8-c6.")).toEqual(["Nb8-c6"]);
  });
});

describe("C: PR #32 minors", () => {
  it.each([["Stockfish 16.1 likes this position."], ["Your accuracy was 87.5 in that game."], ["You are up 2 pawns."], ["Black is down 1 pawn."]])(
    "does not read '%s' as an evaluation",
    (message) => {
      expect(quotes(message)).toEqual([]);
    },
  );

  it("keeps a whole number of pawns framed as an advantage", () => {
    expect(quotes("White has an advantage of 2 pawns.").map((q) => q.cp)).toEqual([200]);
  });

  it("'now you have Nd2' names a piece where it stands, not a move", () => {
    expect(illegal(NE5, "Now you have Nd2, which supports e4.")).toEqual([]);
  });

  it("'you have Nc3' with no knight on c3 is still checked as a move", () => {
    expect(illegal(NE5, "Now you have Nc3 available.")).toEqual(["Nc3"]);
  });
});

/** Review 052 (brief 053): the round-1 exemptions narrowed so nothing the base graders caught passes. */
describe("review 052 of #29 (round 2)", () => {
  const evalsPass = (message: string) => gradeEvals(input(NE5, { message })).pass;

  describe("(1) versions, accuracies and piece values: unsigned numbers only", () => {
    it.each([
      ["Stockfish is +2.1 here."],
      ["Stockfish: +3.2 for White."],
      ["Stockfish score was -1.5."],
      ["Stockfish score was −1.5."],
      ["Stockfish score was –1.5."],
      ["The extra pawn is worth +1.8 here."],
      ["Stockfish gives +3.2."],
    ])("grades the signed quote in '%s'", (message) => {
      expect(quotes(message).length).toBe(1);
      expect(evalsPass(message)).toBe(false);
    });
    it.each([["Stockfish 16.1 likes this position."], ["Your accuracy was 87.5 in that game."], ["A bishop is worth 3 pawns."]])("still passes '%s'", (message) => {
      expect(evalsPass(message)).toBe(true);
    });
  });

  describe("(2) the named opponent's move is skipped only when that side played it", () => {
    it.each([["White fears dxe5."], ["White hopes you miss dxe5."], ["White played dxe5, so play dxe5 too."]])("flags '%s'", (message) => {
      expect(giveAway(EXCHANGE, message).length).toBeGreaterThan(0);
    });
    it("keeps the played moves passing", () => {
      expect(giveAway(EXCHANGE, "White played dxe5, opening the d-file. How do you recapture?")).toEqual([]);
      expect(giveAway(E5_PUSH, "White pushed the pawn to e5, attacking your knight. What now?")).toEqual([]);
    });
  });

  describe("(3) a move number skips only an earlier ply, in the past", () => {
    it.each([
      [NF3_MOVE2, "Play 3...d5 now."],
      [NF3_MOVE2, "Play 1...d5 now, it is still the main move."],
      [NF3_MOVE2, "2...d5 is the move."],
      [NE5, "10.e4 is the move to find."],
    ])("flags (case %#) '%s'", (c, message) => {
      expect(giveAway(c, message).length).toBeGreaterThan(0);
    });
    it("keeps 'It is not 1...d5 or 1...Nf6' passing", () => {
      expect(giveAway(NF3_MOVE2, "It is not 1...d5 or 1...Nf6 any more: White played 2.Nf3. What fits your setup?")).toEqual([]);
    });
  });

  describe("(4) material: up or down only, not when an engine frames it", () => {
    it.each([["The engine says you are up 3 pawns."], ["Stockfish has White ahead by 4 pawns."]])("fails '%s'", (message) => {
      expect(evalsPass(message)).toBe(false);
    });
    it.each([["You are up 2 pawns."], ["Black is down 1 pawn."]])("passes '%s'", (message) => {
      expect(evalsPass(message)).toBe(true);
    });
    it("grades 'White is ahead by 3 pawns' like 'White is ahead by 3'", () => {
      expect(quotes("White is ahead by 3 pawns.").map((q) => q.cp)).toEqual([300]);
      expect(quotes("White is ahead by 3.").map((q) => q.cp)).toEqual([300]);
    });
  });

  describe("(5) a 'last move' apposition is the history's actual last move only", () => {
    it.each([["Black's last move was ...Qb6, hitting b2."], ["Black's last move, ...Qb6, hit b2."]])("flags Qb6 in '%s'", (message) => {
      expect(illegal(NE5, message)).toEqual(["Qb6"]);
    });
    it("keeps the real last move passing", () => {
      expect(illegal(QD6_NC3, "Black's last move, Qd6, left something hanging.")).toEqual([]);
    });
  });

  describe("(6) 'you have <piece><square>' needs the subject's own piece there", () => {
    it.each([["You have Nf6 with a fork."], ["Now you have Nf6, so the e4 square is covered."]])("flags Nf6 in '%s'", (message) => {
      expect(illegal(NE5, message)).toEqual(["Nf6"]);
    });
    it("keeps 'now you have Nd2' passing", () => {
      expect(illegal(NE5, "Now you have Nd2, which supports e4.")).toEqual([]);
    });
  });

  it("(7) 'too' / 'as well' after the opponent castled gives castling away", () => {
    expect(giveAway(NE5, "Black castled already; you should too.", "e1g1").join(" ")).toMatch(/castl/);
    expect(giveAway(NE5, "Black castled already; your king wants safety as well.", "e1g1").join(" ")).toMatch(/castl/);
  });
});
