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
