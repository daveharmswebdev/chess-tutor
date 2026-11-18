import { exchangeOnSquare, type ExchangeResult } from "@chess-tutor/chess-core";
import { describe, expect, it } from "vitest";
import { Evidence } from "../src/evidence.ts";
import { exchangeClaimProblems, findExchangeClaims } from "../src/exchange-claims.ts";
import { runTool, type ToolContext } from "../src/tools.ts";

/**
 * Review 108 (#44, FR-21, FR-10): outcome claims are about starting the captures, so they are
 * compared with startResult, not result; the capture / take phrasings and SAN captures are read;
 * "once" as a conjunction is no count; a later clause of the sentence keeps the square.
 */

// KID Classical after 8.d5, Black to move: e4 attacked by Nf6, defended by Nc3; ...Nxe4 Nxe4 loses 2 for Black.
const KID_E4 = "r1bq1rk1/ppp2pbp/2np1np1/3Pp3/2P1P3/2N2N2/PP2BPPP/R1BQ1RK1 b - - 0 8";
// London Bd3 + Qc2 (x-ray) on h7, defended by Nf6 and Kg8: Bxh7+ loses the bishop for a pawn.
const XRAY = "r1b2rk1/ppq2ppp/2nbpn2/2pp4/3P1B2/2PBPN2/PPQN1PPP/R3K2R w KQ - 3 9";
// 1.d4 d5 2.Bf4 Nc6 3.e3 e5: e5 attacked twice (d4, Bf4), defended once (Nc6).
const WINS = "r1bqkbnr/ppp2ppp/2n5/3pp3/3P1B2/4P3/PPP2PPP/RN1QKBNR w KQkq - 0 4";
// An undefended black knight on e5, attacked by Bc3.
const FREE_E5 = "4k3/8/8/4n3/8/2B5/8/4K3 w - - 0 1";
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function evidenceWith(fen: string, square: string): Evidence {
  const e = new Evidence();
  e.addExchange(fen, exchangeOnSquare(fen, square));
  return e;
}
const problemsFor = (text: string, e: Evidence, playerColor: "w" | "b" = "w") =>
  exchangeClaimProblems("message", text, (sq) => e.exchangesOn(sq), playerColor);
const kid = () => evidenceWith(KID_E4, "e4");
const black = (text: string, e: Evidence) => problemsFor(text, e, "b");

describe("outcomes are compared with startResult (review 108 blocking)", () => {
  it("accepts true 'loses' claims for a losing first capture and rejects 'breaks even' (reviewer probes)", () => {
    expect(black("The trade on e4 loses a piece for a pawn.", kid())).toEqual([]);
    expect(black("The exchange on e4 breaks even.", kid())).toHaveLength(1);
    const xray = evidenceWith(XRAY, "h7");
    expect(problemsFor("The exchange on h7 loses the bishop for a pawn.", xray)).toEqual([]);
    expect(problemsFor("Trading on h7 costs you material.", xray)).toEqual([]);
    expect(problemsFor("The exchange on h7 breaks even.", xray)).toHaveLength(1);
  });

  it("states startResult in words in the correction, never 'a result of 0' for a losing capture", () => {
    const [problem] = black("The exchange on e4 breaks even.", kid());
    expect(problem).toMatch(/capturing first on e4 loses 2 pawns' worth for Black/);
    expect(problem).not.toMatch(/result of 0/);
  });

  it("rejects an outcome claim on a square where no capture is possible", () => {
    const [problem] = problemsFor("The exchange on e4 breaks even.", evidenceWith(START, "e4"));
    expect(problem).toMatch(/no capture/);
  });

  it("returns startResult in the tool result (the tutor's extended type)", async () => {
    const ctx = { evidence: new Evidence() } as unknown as ToolContext;
    const r = (await runTool("exchange_on_square", { fen: KID_E4, square: "e4" }, ctx)) as ExchangeResult & { startResult: number | null };
    expect(r).toEqual({ ...exchangeOnSquare(KID_E4, "e4"), startResult: -2 });
    const empty = (await runTool("exchange_on_square", { fen: START, square: "e4" }, ctx)) as { startResult: number | null };
    expect(empty.startResult).toBeNull();
  });
});

describe("capture / take phrasings and SAN captures (review 108 major)", () => {
  const claims = (t: string) => findExchangeClaims(t, "b").map((c) => (c.kind === "outcome" ? [c.square, c.sign, c.size] : [c.square, c.role, c.n]));

  it("recognises the seven phrasings", () => {
    expect(claims("Capturing on e4 loses a piece for a pawn.")).toEqual([["e4", -1, 2]]);
    expect(claims("Taking on e4 loses a knight for a pawn.")).toEqual([["e4", -1, 2]]);
    expect(claims("If you capture on e4, you lose a piece for a pawn.")).toEqual([["e4", -1, 2]]);
    expect(claims("Nxe4 drops a piece on e4.")).toEqual([["e4", -1, 3]]);
    expect(claims("Bxe5 wins a piece on e5.")).toEqual([["e5", 1, 3]]);
    expect(claims("After the exchanges on e4 Black is a piece down.")).toEqual([["e4", -1, 3]]);
    expect(claims("e4 is attacked by one knight and defended by one knight.")).toEqual([
      ["e4", "attackers", 1],
      ["e4", "defenders", 1],
    ]);
    // A SAN capture alone names the square; so do took / recaptures.
    expect(claims("Nxe4 loses a piece for a pawn.")).toEqual([["e4", -1, 2]]);
    expect(claims("If Black recaptures on e4 Black ends up a piece down.")).toEqual([["e4", -1, 3]]);
  });

  it("checks them against the result: true ones pass, false ones fail", () => {
    expect(black("Capturing on e4 loses a piece for a pawn.", kid())).toEqual([]);
    expect(black("Taking on e4 loses a knight for a pawn.", kid())).toEqual([]);
    expect(black("If you capture on e4, you lose a piece for a pawn.", kid())).toEqual([]);
    expect(black("Nxe4 drops a piece on e4.", kid())).toHaveLength(1); // it is a piece for a pawn: 2
    expect(black("After the exchanges on e4 Black is a piece down.", kid())).toHaveLength(1);
    expect(black("After the exchanges on e4 Black is a piece down for a pawn.", kid())).toEqual([]);
    expect(black("e4 is attacked by one knight and defended by one knight.", kid())).toEqual([]);
    expect(black("e4 is attacked by two knights.", kid())).toHaveLength(1);
    expect(problemsFor("Bxe5 wins a piece on e5.", evidenceWith(FREE_E5, "e5"))).toEqual([]);
    expect(problemsFor("Bxe5 wins a rook on e5.", evidenceWith(FREE_E5, "e5"))).toHaveLength(1);
    expect(problemsFor("Bxe5 wins a piece on e5.", new Evidence())).toHaveLength(1);
  });

  it("takes the exchange square from 'on <square>' or the won piece's square, not from the capturer (recorded replies)", () => {
    const squares = (t: string) => findExchangeClaims(t, "w").map((c) => c.square);
    expect(squares("After Qf3, the knight takes on c2 with check and then wins the rook on a1.")).toEqual(["a1"]);
    expect(squares("On e5 the bishop can be captured by the d6 pawn, and that wins a whole bishop.")).toEqual(["e5"]);
    expect(squares("Be5 puts the bishop where Black's d6 pawn can capture it, and that loses a piece.")).toEqual([]);
    expect(squares("Black's bishop on d6 stood right in front of your bishop on f4, and the trade wins a piece for free.")).toEqual([]);
    // A count square carries: the outcome is about the counted square.
    expect(squares("The knight on e4 is attacked twice, and taking it wins a piece.")).toEqual(["e4", "e4"]);
  });

  it("does not read the new exchange words without a square in the clause", () => {
    for (const text of [
      "Take your time and look at the whole board.",
      "White takes over the centre and wins space.",
      "Try to capture the initiative before Black castles.",
      "You took a pawn earlier and lost a piece later.",
      "Taking risks can win material, but be careful.",
    ]) {
      expect(findExchangeClaims(text, "w"), text).toEqual([]);
    }
  });
});

describe("'once' and clause carry (review 108 minors)", () => {
  it("does not read 'once' as a count when it is a conjunction", () => {
    for (const text of ["Your knight attacks e5 once Black moves the queen.", "The pawn on d4 is defended once you play Nf3.", "e5 is attacked once the bishop moves."]) {
      expect(findExchangeClaims(text, "w"), text).toEqual([]);
    }
    expect(findExchangeClaims("e5 is attacked once and defended twice.").map((c) => ("n" in c ? c.n : null))).toEqual([1, 2]);
    expect(findExchangeClaims("e5 is defended only once.").map((c) => ("n" in c ? c.n : null))).toEqual([1]);
  });

  it("carries the square into a later clause of the same sentence", () => {
    const counts = (t: string) => findExchangeClaims(t, "w").map((c) => ("n" in c ? [c.square, c.role, c.n] : null));
    expect(counts("e5 is attacked twice but defended only once.")).toEqual([
      ["e5", "attackers", 2],
      ["e5", "defenders", 1],
    ]);
    expect(counts("Nc6 defends e5 once, the bishop attacks it twice.")).toEqual([
      ["e5", "defenders", 1],
      ["e5", "attackers", 2],
    ]);
    // Not across a sentence.
    expect(counts("Look at e5. The bishop attacks it twice.")).toEqual([]);
    expect(problemsFor("e5 is attacked twice but defended only once.", evidenceWith(WINS, "e5"))).toEqual([]);
    expect(problemsFor("e5 is attacked twice but defended twice.", evidenceWith(WINS, "e5"))).toHaveLength(1);
  });
});
