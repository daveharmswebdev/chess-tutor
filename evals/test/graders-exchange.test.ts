import { exchangeOnSquare } from "@chess-tutor/chess-core";
import type { TutorReply } from "@chess-tutor/tutor";
import { describe, expect, it } from "vitest";
import { gradeExchanges, gradeReply, type GradeInput, type ToolResultRecord } from "../src/graders.ts";

/**
 * NFR-6 for exchange claims (#44, FR-21, FR-10): a count of attackers or defenders on a square, or
 * an exchange outcome there, must match an exchange_on_square result of this ask for that square.
 * The grader reads claims with the tutor's own recogniser (findExchangeClaims), so both agree.
 */

// 1.d4 d5 2.Bf4 Nc6 3.e3 e5, White to move: e5 attacked by d4 and Bf4, defended by Nc6; +1 for White.
const FEN = "r1bqkbnr/ppp2ppp/2n5/3pp3/3P1B2/4P3/PPP2PPP/RN1QKBNR w KQkq - 0 4";
const HISTORY = ["d2d4", "d7d5", "c1f4", "b8c6", "e2e3", "e7e5"];

const tool = (square: string, over: Partial<ToolResultRecord> = {}): ToolResultRecord => ({
  name: "exchange_on_square",
  input: { fen: FEN, square },
  content: JSON.stringify(exchangeOnSquare(FEN, square)),
  isError: false,
  ...over,
});

function input(reply: Partial<TutorReply>, toolResults: ToolResultRecord[]): GradeInput {
  return {
    kind: "hint",
    playerColor: "w",
    history: HISTORY,
    fen: FEN,
    attemptFen: FEN,
    moment: null,
    engineBest: "d4e5",
    reply: { schemaVersion: 1, kind: "hint", message: "What can you take?", reveal: null, revealMove: null, arrows: [], ...reply },
    toolResults,
    revealCpLoss: null,
    toleranceCp: 50,
  };
}

describe("gradeExchanges (NFR-6, #44)", () => {
  it("passes a count and an outcome that match this ask's exchange_on_square result", () => {
    const g = gradeExchanges(input({ message: "e5 is attacked twice and defended once.", reveal: "The exchange on e5 wins a pawn." }, [tool("e5")]));
    expect(g.pass).toBe(true);
    expect(g.claims.map((c) => c.problem)).toEqual([null, null, null]);
  });

  it("fails a count with no result for that square, and a count or outcome that disagrees", () => {
    expect(gradeExchanges(input({ message: "e5 is attacked twice." }, [])).claims).toEqual([{ field: "message", raw: expect.any(String), square: "e5", problem: "unbacked" }]);
    expect(gradeExchanges(input({ message: "e5 is attacked twice." }, [tool("d5")])).pass).toBe(false);
    expect(gradeExchanges(input({ message: "e5 is attacked three times." }, [tool("e5")])).claims[0]!.problem).toBe("mismatch");
    expect(gradeExchanges(input({ reveal: "Trading on e5 loses material." }, [tool("e5")])).pass).toBe(false);
    // An errored call backs nothing.
    expect(gradeExchanges(input({ message: "e5 is attacked twice." }, [tool("e5", { isError: true, content: "bad" })])).pass).toBe(false);
  });

  it("checks outcomes against startResult, also for recordings made before the field existed (review 108)", () => {
    // 1.e4 e5 2.Nf3 Nc6: result 0, but capturing first on e5 loses a knight for a pawn.
    const even = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
    const rec = (withStart: boolean): ToolResultRecord => {
      const r = exchangeOnSquare(even, "e5");
      return { name: "exchange_on_square", input: { fen: even, square: "e5" }, content: JSON.stringify(withStart ? { ...r, startResult: -2 } : r), isError: false };
    };
    for (const withStart of [true, false]) {
      expect(gradeExchanges(input({ reveal: "Taking on e5 loses a knight for a pawn." }, [rec(withStart)])).pass).toBe(true);
      expect(gradeExchanges(input({ reveal: "The trade on e5 breaks even." }, [rec(withStart)])).claims[0]!.problem).toBe("mismatch");
    }
  });

  it("ignores replies without exchange claims", () => {
    const g = gradeExchanges(input({ message: "Which Black pawn can you take?", reveal: "Your pawn on d4 takes on e5 and opens the f4 bishop." }, []));
    expect(g).toEqual({ pass: true, claims: [] });
  });

  it("counts in NFR-6 evals: an unbacked exchange claim fails nfr6Evals", () => {
    expect(gradeReply(input({ message: "e5 is attacked twice and defended once." }, [tool("e5")])).nfr6Evals).toBe(true);
    const bad = gradeReply(input({ message: "e5 is attacked twice and defended once." }, []));
    expect(bad.nfr6Evals).toBe(false);
    expect(bad.exchanges.pass).toBe(false);
  });
});
