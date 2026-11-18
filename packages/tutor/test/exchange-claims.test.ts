import type Anthropic from "@anthropic-ai/sdk";
import { exchangeOnSquare, type ExchangeResult } from "@chess-tutor/chess-core";
import { describe, expect, it } from "vitest";
import { checkClaims } from "../src/claims.ts";
import type { TutorRequest } from "../src/contract.ts";
import { createTutorSession } from "../src/index.ts";
import { deps, endTurnMsg, fakeClient, toolUseMsg } from "./helpers.ts";
import { Evidence } from "../src/evidence.ts";
import { exchangeClaimProblems, findExchangeClaims } from "../src/exchange-claims.ts";
import type { TutorDraft } from "../src/schema.ts";

/**
 * The FR-10 check for exchange claims (#44, FR-21, FR-23): a count of attackers or defenders on
 * a square, or the outcome of the exchange there, needs this turn's exchange_on_square result
 * for that square, and must agree with it.
 */

// 1.d4 d5 2.Bf4 Nc6 3.e3 e5: e5 is attacked by d4 and Bf4 (White), defended by Nc6; result +1 for White.
const WINS = "r1bqkbnr/ppp2ppp/2n5/3pp3/3P1B2/4P3/PPP2PPP/RN1QKBNR w KQkq - 0 4";
// 1.e4 e5 2.Nf3 Nc6: e5 is attacked by Nf3 once and defended by Nc6 once; result 0 (Nxe5 loses a piece for a pawn).
const EVEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
// London with Bd3 and Qc2 behind it: h7 is attacked by Bd3 and Qc2 (x-ray), defended by Nf6 and Kg8.
const XRAY = "r1b2rk1/ppq2ppp/2nbpn2/2pp4/3P1B2/2PBPN2/PPQN1PPP/R3K2R w KQ - 3 9";

function evidenceWith(...pairs: [string, string][]): Evidence {
  const e = new Evidence();
  for (const [fen, square] of pairs) {
    e.addPosition(fen);
    e.addExchange(fen, exchangeOnSquare(fen, square));
  }
  return e;
}

const reply = (over: Partial<TutorDraft>): TutorDraft => ({
  schemaVersion: 1,
  kind: "hint",
  message: "What is going on in the centre?",
  reveal: null,
  revealMove: null,
  arrows: [],
  evals: [],
  ...over,
});

const problemsFor = (text: string, e: Evidence, playerColor: "w" | "b" = "w") =>
  exchangeClaimProblems("message", text, (sq) => e.exchangesOn(sq), playerColor);

describe("findExchangeClaims (#44)", () => {
  it("reads attacker and defender counts with the square in the same clause", () => {
    expect(findExchangeClaims("e5 is attacked twice and defended once.").map((c) => [c.square, c.kind, "role" in c ? c.role : null, "n" in c ? c.n : null])).toEqual([
      ["e5", "count", "attackers", 2],
      ["e5", "count", "defenders", 1],
    ]);
    expect(findExchangeClaims("There are two attackers and one defender on d4.").map((c) => ("n" in c ? [c.square, c.role, c.n] : null))).toEqual([
      ["d4", "attackers", 2],
      ["d4", "defenders", 1],
    ]);
    expect(findExchangeClaims("The pawn on d5 is defended three times").map((c) => ("n" in c ? [c.square, c.role, c.n] : null))).toEqual([["d5", "defenders", 3]]);
    expect(findExchangeClaims("Your knight attacks e5 twice").map((c) => ("n" in c ? [c.square, c.role, c.n] : null))).toEqual([["e5", "attackers", 2]]);
    expect(findExchangeClaims("The knight on e5 is attacked by two pieces and defended by one.").map((c) => ("n" in c ? [c.square, c.role, c.n] : null))).toEqual([
      ["e5", "attackers", 2],
      ["e5", "defenders", 1],
    ]);
    expect(findExchangeClaims("The pawn on c6 has no defenders").map((c) => ("n" in c ? [c.square, c.role, c.n] : null))).toEqual([["c6", "defenders", 0]]);
  });

  it("reads exchange outcomes on a square", () => {
    const out = (t: string) => findExchangeClaims(t, "w").map((c) => (c.kind === "outcome" ? [c.square, c.sign, c.size, c.side] : null));
    expect(out("The exchange on e5 wins a pawn")).toEqual([["e5", 1, 1, null]]);
    expect(out("Trading on d5 loses material")).toEqual([["d5", -1, null, null]]);
    expect(out("You come out a knight up on f6")).toEqual([["f6", 1, 3, "w"]]);
    expect(out("After the trades on e4 Black comes out a pawn down")).toEqual([["e4", -1, 1, "b"]]);
    expect(out("The exchange on e5 wins a knight for a pawn")).toEqual([["e5", 1, 2, null]]);
    expect(out("The trade on e5 breaks even")).toEqual([["e5", 0, 0, null]]);
    // Phrasing seen in recorded eval replies.
    expect(out("After the trades on d6 you come out a whole queen ahead for a bishop")).toEqual([["d6", 1, 6, "w"]]);
    expect(out("The exchange on e5 costs you a pawn")).toEqual([["e5", -1, 1, "w"]]);
  });

  it("ignores sentences without a square, ordinary move talk and squares inside moves", () => {
    for (const text of [
      "The knight attacks the queen.",
      "Your pawn on e4 controls d5, and the e5 square is a great outpost.",
      "Trading pieces helps when you are ahead in material.",
      "You won a pawn earlier in the game, so keep it simple.",
      "Exchange the queens on d1 and head for the endgame.",
      "After Nxe5 the knight is attacked twice.",
      "The bishop on g7 attacks the long diagonal, and your rook is attacked.",
      "Castle once you have developed, then play for the f5 break.",
      "Black defends well; the knight on c3 is attacked at once if you push d5.",
      // An exception is not a count of zero (recorded eval reply).
      "The bishop on c7 has no defender except the knight on b5.",
    ]) {
      expect(findExchangeClaims(text, "w"), text).toEqual([]);
    }
  });
});

describe("checkClaims: exchange claims need this turn's exchange_on_square result (FR-10, FR-21)", () => {
  it("rejects a count when no exchange_on_square result for that square exists this turn", () => {
    const e = new Evidence();
    e.addPosition(WINS);
    const problems = checkClaims(reply({ message: "e5 is attacked twice and defended once. What can you take?" }), e, WINS, "w");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/exchange_on_square/);
    expect(problems[0]).toMatch(/e5/);
    // A result for another square does not back it.
    expect(problemsFor("e5 is attacked twice", evidenceWith([WINS, "d5"]))).toHaveLength(1);
  });

  it("rejects a count that disagrees with the result", () => {
    const e = evidenceWith([EVEN, "e5"]);
    const problems = problemsFor("e5 is attacked twice and defended once", e);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/1 attacker and 1 defender/);
    expect(problemsFor("The pawn on e5 is defended twice", e)).toHaveLength(1);
    expect(problemsFor("There are two attackers and one defender on e5", evidenceWith([WINS, "e5"]))).toEqual([]);
    expect(problemsFor("There are three attackers on e5", evidenceWith([WINS, "e5"]))).toHaveLength(1);
  });

  it("accepts a matching count, x-rays included", () => {
    expect(problemsFor("e5 is attacked twice and defended once", evidenceWith([WINS, "e5"]))).toEqual([]);
    expect(problemsFor("e5 is attacked once and defended once", evidenceWith([EVEN, "e5"]))).toEqual([]);
    // The queen behind the bishop counts (x-ray).
    expect(problemsFor("h7 is attacked twice and defended twice", evidenceWith([XRAY, "h7"]))).toEqual([]);
    expect(problemsFor("h7 is attacked once", evidenceWith([XRAY, "h7"]))).toHaveLength(1);
  });

  it("rejects an outcome with the wrong sign or size, and accepts a matching one", () => {
    const e = evidenceWith([WINS, "e5"]); // +1 for White, the attacking side
    expect(problemsFor("The exchange on e5 wins a pawn", e)).toEqual([]);
    expect(problemsFor("Trading on e5 wins material for White", e)).toEqual([]);
    expect(problemsFor("Trading on e5 loses material", e)).toHaveLength(1);
    expect(problemsFor("The exchange on e5 wins a knight", e)).toHaveLength(1);
    // "You" is the player: White wins it, Black loses it.
    expect(problemsFor("You come out a pawn up on e5", e, "w")).toEqual([]);
    expect(problemsFor("You come out a pawn up on e5", e, "b")).toHaveLength(1);
    expect(problemsFor("Black comes out a pawn down in the exchange on e5", e)).toEqual([]);
    const even = evidenceWith([EVEN, "e5"]); // result 0: the attacker should not start
    expect(problemsFor("The trade on e5 breaks even", even)).toEqual([]);
    expect(problemsFor("The exchange on e5 wins material", even)).toHaveLength(1);
    expect(problemsFor("The exchange on e5 wins a pawn", new Evidence())).toHaveLength(1);
  });

  it("reports the result in the correction, from the attacking side's view", () => {
    const [problem] = problemsFor("Trading on e5 loses material", evidenceWith([WINS, "e5"]));
    expect(problem).toMatch(/exchange_on_square/);
    expect(problem).toMatch(/White/);
    expect(problem).toMatch(/\+1/);
  });

  it("checks the reveal too, and accepts a backed claim inside a full reply", () => {
    const e = evidenceWith([WINS, "e5"]);
    expect(checkClaims(reply({ reveal: "The trade on e5 wins a knight." }), e, WINS, "w")).toHaveLength(1);
    expect(checkClaims(reply({ message: "e5 is attacked twice and defended once. What can you take?" }), e, WINS, "w")).toEqual([]);
  });

  it("does not flag ordinary replies without an exchange claim", () => {
    const e = new Evidence();
    e.addPosition(WINS);
    for (const message of [
      "Your bishop on f4 eyes the c7 square. What is Black's knight doing?",
      "Which of Black's pieces is loose?",
      "Trading pieces is good when you are ahead.",
    ]) {
      expect(checkClaims(reply({ message }), e, WINS, "w"), message).toEqual([]);
    }
  });

  describe("through the session's tool loop", () => {
    const history = ["d2d4", "d7d5", "c1f4", "b8c6", "e2e3", "e7e5"];
    const request: TutorRequest = { kind: "hint", fen: WINS, history };
    const game = { playerColor: "w" as const, playerProfile: "About 1000." };
    const hint = reply({ message: "e5 is attacked twice and defended once. What can you take?" });

    it("accepts the count after exchange_on_square, without a correction turn", async () => {
      const { client, calls } = fakeClient([toolUseMsg([{ name: "exchange_on_square", input: { fen: WINS, square: "e5" }, id: "t1" }]), endTurnMsg(hint)]);
      const out = await createTutorSession(deps({ client }), game).ask(request, () => {});
      expect(out).toMatchObject({ ok: true });
      expect(calls).toHaveLength(2);
      const block = (calls[1]!.params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
      expect(block.is_error).toBeUndefined();
      expect(JSON.parse(block.content as string)).toEqual(exchangeOnSquare(WINS, "e5"));
    });

    it("rejects the same count without the tool, and sends is_error for an invalid square", async () => {
      const { client, calls } = fakeClient([
        toolUseMsg([{ name: "exchange_on_square", input: { fen: WINS, square: "e9" }, id: "t1" }]),
        endTurnMsg(hint),
        endTurnMsg(hint),
      ]);
      const out = await createTutorSession(deps({ client }), game).ask(request, () => {});
      expect(out).toMatchObject({ ok: false, reason: "unsupported_claim" });
      const block = (calls[1]!.params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
      expect(block.is_error).toBe(true);
      expect(block.content).toMatch(/square/);
      expect(JSON.stringify(calls[2]!.params.messages.at(-1))).toContain("exchange_on_square");
    });
  });

  it("keys results by position and square: two positions with results for the same square both count", () => {
    const e = evidenceWith([WINS, "e5"], [EVEN, "e5"]);
    expect(e.exchangesOn("e5")).toHaveLength(2);
    expect(problemsFor("e5 is attacked once and defended once", e)).toEqual([]);
    expect(problemsFor("e5 is attacked twice and defended once", e)).toEqual([]);
    // Recording the same position and square twice keeps one result.
    const again: ExchangeResult = exchangeOnSquare(WINS, "e5");
    e.addExchange(WINS, again);
    expect(e.exchangesOn("e5")).toHaveLength(2);
  });
});
