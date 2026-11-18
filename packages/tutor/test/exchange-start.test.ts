import { exchangeOnSquare } from "@chess-tutor/chess-core";
import { describe, expect, it } from "vitest";
import { startResult } from "../src/exchange-claims.ts";

/**
 * startResult (#44, review 108): the material for the attacking side when the attacker makes the
 * first capture and from then on each side stops at its best moment. It is what an outcome claim
 * ("capturing on e4 loses a piece for a pawn") is about; `result` is 0 whenever starting loses.
 */

const cases: { name: string; fen: string; square: string; start: number | null }[] = [
  // 1.d4 d5 2.Bf4 Nc6 3.e3 e5: dxe5 and Black should not recapture (Nxe5 Bxe5): the defender stops early.
  { name: "defender stops early", fen: "r1bqkbnr/ppp2ppp/2n5/3pp3/3P1B2/4P3/PPP2PPP/RN1QKBNR w KQkq - 0 4", square: "e5", start: 1 },
  // 1.e4 e5 2.Nf3 Nc6: Nxe5 Nxe5 loses a knight for a pawn.
  { name: "losing first capture", fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", square: "e5", start: -2 },
  // KID Classical after 8.d5: ...Nxe4 Nxe4.
  { name: "KID ...Nxe4", fen: "r1bq1rk1/ppp2pbp/2np1np1/3Pp3/2P1P3/2N2N2/PP2BPPP/R1BQ1RK1 b - - 0 8", square: "e4", start: -2 },
  // London Bd3 + Qc2 x-ray on h7, defended by Nf6 and Kg8: Bxh7+ Nxh7 and the queen should not go on.
  { name: "x-ray", fen: "r1b2rk1/ppq2ppp/2nbpn2/2pp4/3P1B2/2PBPN2/PPQN1PPP/R3K2R w KQ - 3 9", square: "h7", start: -2 },
  // bxa8=Q (rook + promotion gain 8), Nxa8 takes the new queen (9).
  { name: "promotion", fen: "r3k3/1P6/1n6/8/8/8/8/4K3 w - - 0 1", square: "a8", start: 4 },
  // An undefended knight.
  { name: "free piece", fen: "4k3/8/8/4n3/8/2B5/8/4K3 w - - 0 1", square: "e5", start: 3 },
  // An empty square: no capture, so no outcome.
  { name: "empty sequence", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", square: "e4", start: null },
];

describe("startResult (#44, review 108)", () => {
  it.each(cases)("$name: $square -> $start", ({ fen, square, start }) => {
    const r = exchangeOnSquare(fen, square);
    expect(startResult(r)).toBe(start);
    // Self-consistency with chess-core: result is the better of not starting (0) and starting.
    if (start === null) expect(r.sequence).toEqual([]);
    else expect(r.result).toBe(Math.max(0, start));
    if (start !== null && r.bestLength > 0) expect(start).toBe(r.result);
  });
});
