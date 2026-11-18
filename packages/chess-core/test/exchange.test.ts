import { describe, expect, it } from "vitest";
import { exchangeOnSquare, type ExchangePiece, type ExchangeResult } from "../src/index.ts";
import { START } from "./fixtures.ts";

/** "Nc4" style labels for a list, so expectations read like chess. */
function labels(pieces: ExchangePiece[]): string[] {
  return pieces.map((p) => `${p.piece.toUpperCase()}${p.square}${p.xray ? " (x-ray)" : ""}`);
}

function captures(r: ExchangeResult): string[] {
  return r.sequence.map(
    (c) => `${c.n}. ${c.by.piece.toUpperCase()}${c.by.square}x${c.captured}${c.promotion ? "=Q" : ""}`,
  );
}

describe("exchangeOnSquare", () => {
  it("2 against 1: Nxe5 wins a pawn, and Black does best not to recapture", () => {
    // White Nc4 and Nf3 attack the e5 pawn; only Nd7 defends it.
    const r = exchangeOnSquare("6k1/3n4/8/4p3/2N5/5N2/8/6K1 w - - 0 1", "e5");
    expect(r.square).toBe("e5");
    expect(r.occupant).toEqual({ piece: "p", color: "b" });
    expect(r.attackingSide).toBe("w");
    expect(r.attackerToMove).toBe(true);
    expect(labels(r.attackers)).toEqual(["Nc4", "Nf3"]);
    expect(labels(r.defenders)).toEqual(["Nd7"]);
    expect(r.attackers[0]).toEqual({ square: "c4", piece: "n", color: "w", value: 3, xray: false });
    expect(captures(r)).toEqual(["1. Nc4xp", "2. Nd7xn", "3. Nf3xn"]);
    // +1 -3 +3
    expect(r.fullResult).toBe(1);
    // After Nxe5, Nxe5 Nxe5 is an even trade for Black, so Black stops: White just wins the pawn.
    expect(r.result).toBe(1);
    expect(r.bestLength).toBe(1);
    expect(r.caveat).toMatch(/pins/);
    expect(r.caveat).toMatch(/checks/);
    expect(r.caveat).toMatch(/engine/);
  });

  it("a defended pawn: capturing loses, so the attacker should not start", () => {
    // Nf3xe5 dxe5 gives a knight for a pawn.
    const r = exchangeOnSquare("6k1/8/3p4/4p3/8/5N2/8/6K1 w - - 0 1", "e5");
    expect(labels(r.attackers)).toEqual(["Nf3"]);
    expect(labels(r.defenders)).toEqual(["Pd6"]);
    expect(captures(r)).toEqual(["1. Nf3xp", "2. Pd6xn"]);
    expect(r.fullResult).toBe(-2);
    expect(r.result).toBe(0);
    expect(r.bestLength).toBe(0);
  });

  it("x-ray behind a rook: doubled rooks, the back rook comes after the front one", () => {
    // Re2 and Re1 on the e-file against the e5 bishop, defended by Re8.
    const r = exchangeOnSquare("4r1k1/8/8/4b3/8/8/4R3/4R1K1 w - - 0 1", "e5");
    expect(labels(r.attackers)).toEqual(["Re2", "Re1 (x-ray)"]);
    expect(labels(r.defenders)).toEqual(["Re8"]);
    expect(captures(r)).toEqual(["1. Re2xb", "2. Re8xr", "3. Re1xr"]);
    expect(r.fullResult).toBe(3);
    expect(r.result).toBe(3);
    // Black loses a rook for a rook by recapturing, an even trade, so it stops.
    expect(r.bestLength).toBe(1);
  });

  it("x-ray behind a bishop: the queen behind the bishop joins after it", () => {
    // Bb2 with Qa1 behind it on the long diagonal, against Ne5 defended by d6.
    const r = exchangeOnSquare("6k1/8/3p4/4n3/8/8/1B6/Q5K1 w - - 0 1", "e5");
    expect(labels(r.attackers)).toEqual(["Bb2", "Qa1 (x-ray)"]);
    expect(r.attackers[1]).toEqual({ square: "a1", piece: "q", color: "w", value: 9, xray: true });
    expect(labels(r.defenders)).toEqual(["Pd6"]);
    expect(captures(r)).toEqual(["1. Bb2xn", "2. Pd6xb", "3. Qa1xp"]);
    expect(r.fullResult).toBe(1);
    expect(r.result).toBe(1);
    expect(r.bestLength).toBe(3);
  });

  it("an enemy slider behind the capturing piece recaptures (review 103)", () => {
    // Qxd5 takes the queen off d6, so Black's Rd8 now sees d5: Rxd5 wins the queen.
    const r = exchangeOnSquare("3r2k1/8/3Q4/3n4/8/8/8/6K1 w - - 0 1", "d5");
    expect(labels(r.attackers)).toEqual(["Qd6"]);
    expect(labels(r.defenders)).toEqual(["Rd8 (x-ray)"]);
    expect(r.defenders[0]).toEqual({ square: "d8", piece: "r", color: "b", value: 5, xray: true });
    expect(captures(r)).toEqual(["1. Qd6xn", "2. Rd8xq"]);
    expect(r.fullResult).toBe(-6);
    expect(r.result).toBe(0);
    expect(r.bestLength).toBe(0);
  });

  it("a defender in front of an enemy rook recaptures and opens the line for it", () => {
    // Nxa6 Rxa6 lets White's Ra1 through: Rxa6. +1 -3 +5, so Black should not recapture.
    const r = exchangeOnSquare("6k1/8/p7/8/1N6/r7/8/R5K1 w - - 0 1", "a6");
    expect(labels(r.attackers)).toEqual(["Nb4", "Ra1 (x-ray)"]);
    expect(labels(r.defenders)).toEqual(["Ra3"]);
    expect(captures(r)).toEqual(["1. Nb4xp", "2. Ra3xn", "3. Ra1xr"]);
    expect(r.fullResult).toBe(3);
    expect(r.result).toBe(1);
    expect(r.bestLength).toBe(1);
  });

  it("an enemy piece that never captures on the square keeps the line blocked", () => {
    // Black's Na3 does not attack a6, so White's Ra1 behind it never reaches a6.
    const r = exchangeOnSquare("6k1/8/p7/8/1N6/n7/8/R5K1 w - - 0 1", "a6");
    expect(labels(r.attackers)).toEqual(["Nb4"]);
    expect(r.defenders).toEqual([]);
    expect(captures(r)).toEqual(["1. Nb4xp"]);
    expect(r.fullResult).toBe(1);
    expect(r.result).toBe(1);
  });

  it("pawn, bishop and queen on one diagonal: both back pieces are x-rays", () => {
    const r = exchangeOnSquare("6k1/8/3p4/4n3/3P4/2B5/1Q6/6K1 w - - 0 1", "e5");
    expect(labels(r.attackers)).toEqual(["Pd4", "Bc3 (x-ray)", "Qb2 (x-ray)"]);
    expect(labels(r.defenders)).toEqual(["Pd6"]);
    expect(captures(r)).toEqual(["1. Pd4xn", "2. Pd6xp", "3. Bc3xp"]);
    expect(r.fullResult).toBe(3);
    expect(r.result).toBe(3);
  });

  it("a queen in front of a rook must capture first, even though it is dearer", () => {
    // Qxd5 Rxd5 Rxd5: +3 -9 +5.
    const r = exchangeOnSquare("3r2k1/8/8/3n4/8/8/3Q4/3R2K1 w - - 0 1", "d5");
    expect(labels(r.attackers)).toEqual(["Qd2", "Rd1 (x-ray)"]);
    expect(labels(r.defenders)).toEqual(["Rd8"]);
    expect(captures(r)).toEqual(["1. Qd2xn", "2. Rd8xq", "3. Rd1xr"]);
    expect(r.fullResult).toBe(-1);
    expect(r.result).toBe(0);
    expect(r.bestLength).toBe(0);
  });

  it("a king on the square is never captured", () => {
    const r = exchangeOnSquare("8/8/8/4k3/8/5N2/8/6K1 w - - 0 1", "e5");
    expect(r.occupant).toEqual({ piece: "k", color: "b" });
    expect(labels(r.attackers)).toEqual(["Nf3"]);
    expect(r.sequence).toEqual([]);
    expect(r.result).toBe(0);
  });

  it("a promotion, then a recapture by an x-ray piece", () => {
    // exd8=Q (+13) Bxd8 (-9) Rxd8 (+3) Qxd8 (-5): Black's Qb6 stands behind Bc7.
    const r = exchangeOnSquare("3r3k/2b1P3/1q6/8/8/8/8/3R3K w - - 0 1", "d8");
    expect(labels(r.attackers)).toEqual(["Pe7", "Rd1"]);
    expect(labels(r.defenders)).toEqual(["Bc7", "Qb6 (x-ray)"]);
    expect(r.sequence.map((c) => [c.captured, c.promotion])).toEqual([
      ["r", true],
      ["q", false],
      ["b", false],
      ["r", false],
    ]);
    expect(r.sequence[3]!.by).toEqual({ square: "b6", piece: "q", color: "b", value: 9, xray: true });
    expect(r.fullResult).toBe(2);
    // White stops after exd8=Q Bxd8: Rxd8 Qxd8 would give a rook for a bishop.
    expect(r.result).toBe(4);
    expect(r.bestLength).toBe(2);
  });

  describe("the king captures only when the square is safe", () => {
    it("takes an undefended pawn", () => {
      const r = exchangeOnSquare("6k1/8/8/4p3/3K4/8/8/8 w - - 0 1", "e5");
      expect(r.attackers).toEqual([{ square: "d4", piece: "k", color: "w", value: 0, xray: false }]);
      expect(r.defenders).toEqual([]);
      expect(captures(r)).toEqual(["1. Kd4xp"]);
      expect(r.fullResult).toBe(1);
      expect(r.result).toBe(1);
      expect(r.bestLength).toBe(1);
    });

    it("does not take a defended pawn", () => {
      const r = exchangeOnSquare("6k1/8/3p4/4p3/3K4/8/8/8 w - - 0 1", "e5");
      expect(labels(r.attackers)).toEqual(["Kd4"]);
      expect(labels(r.defenders)).toEqual(["Pd6"]);
      expect(r.sequence).toEqual([]);
      expect(r.fullResult).toBe(0);
      expect(r.result).toBe(0);
      expect(r.bestLength).toBe(0);
    });

    it("does not step onto a square an enemy rook behind it would then see", () => {
      // Ke4xe5 would open the e-file for Black's Re1.
      const r = exchangeOnSquare("6k1/8/8/4p3/4K3/8/8/4r3 w - - 0 1", "e5");
      expect(labels(r.attackers)).toEqual(["Ke4"]);
      expect(r.sequence).toEqual([]);
      expect(r.result).toBe(0);
    });

    it("stops when an earlier capture reveals a rook that would then see the square", () => {
      // Not in check at the start. Rxd5 Rxd5, and now Kxd5 is impossible: Rd8 sees d5.
      const r = exchangeOnSquare("3r2k1/3r4/2K5/3p4/8/8/8/3R4 w - - 0 1", "d5");
      expect(labels(r.attackers)).toEqual(["Rd1", "Kc6"]);
      expect(labels(r.defenders)).toEqual(["Rd7", "Rd8 (x-ray)"]);
      expect(captures(r)).toEqual(["1. Rd1xp", "2. Rd7xr"]);
      expect(r.fullResult).toBe(-4);
      expect(r.result).toBe(0);
      expect(r.bestLength).toBe(0);
    });

    it("a defending king recaptures when nothing else attacks the square", () => {
      const r = exchangeOnSquare("8/8/5k2/4p3/8/5N2/8/6K1 w - - 0 1", "e5");
      expect(labels(r.defenders)).toEqual(["Kf6"]);
      expect(captures(r)).toEqual(["1. Nf3xp", "2. Kf6xn"]);
      expect(r.fullResult).toBe(-2);
      expect(r.result).toBe(0);
      expect(r.bestLength).toBe(0);
    });

    it("comes last, once the defenders are gone", () => {
      // Nf3xe5 dxe5 Kxe5: the king may recapture because nothing defends e5 any more.
      const r = exchangeOnSquare("6k1/8/3p4/4p3/3K4/5N2/8/8 w - - 0 1", "e5");
      expect(labels(r.attackers)).toEqual(["Nf3", "Kd4"]);
      expect(captures(r)).toEqual(["1. Nf3xp", "2. Pd6xn", "3. Kd4xp"]);
      expect(r.fullResult).toBe(-1);
      expect(r.result).toBe(0);
      expect(r.bestLength).toBe(0);
    });
  });

  it("a pawn that promotes on the capture, then is recaptured as a queen", () => {
    // exd8=Q wins a rook and makes a queen (+5 +8), Nxd8 takes the queen back (-9).
    const r = exchangeOnSquare("3r3k/1n2P3/8/8/8/8/8/6K1 w - - 0 1", "d8");
    expect(r.occupant).toEqual({ piece: "r", color: "b" });
    expect(labels(r.attackers)).toEqual(["Pe7"]);
    expect(labels(r.defenders)).toEqual(["Nb7"]);
    expect(r.sequence).toEqual([
      { n: 1, by: { square: "e7", piece: "p", color: "w", value: 1, xray: false }, captured: "r", promotion: true },
      { n: 2, by: { square: "b7", piece: "n", color: "b", value: 3, xray: false }, captured: "q", promotion: false },
    ]);
    expect(r.fullResult).toBe(4);
    expect(r.result).toBe(4);
    expect(r.bestLength).toBe(2);
  });

  it("a black pawn promotes on the first rank", () => {
    // ...exf1=Q takes the rook (+5 +8); nothing recaptures.
    const r = exchangeOnSquare("6k1/8/8/8/8/8/4p3/5R1K b - - 0 1", "f1");
    expect(r.attackingSide).toBe("b");
    expect(captures(r)).toEqual(["1. Pe2xr=Q"]);
    expect(r.result).toBe(13);
  });

  it("a square nobody attacks", () => {
    const r = exchangeOnSquare("6k1/p7/8/8/8/8/8/6K1 w - - 0 1", "a7");
    expect(r.occupant).toEqual({ piece: "p", color: "b" });
    expect(r.attackingSide).toBe("w");
    expect(r.attackers).toEqual([]);
    expect(r.defenders).toEqual([]);
    expect(r.sequence).toEqual([]);
    expect(r.fullResult).toBe(0);
    expect(r.result).toBe(0);
    expect(r.bestLength).toBe(0);
  });

  it("an empty square: the side to move attacks, pawns attack diagonally only", () => {
    const r = exchangeOnSquare(START, "d3");
    expect(r.occupant).toBeNull();
    expect(r.attackingSide).toBe("w");
    expect(r.attackerToMove).toBe(true);
    // c2 and e2 cover d3 (with Bf1 behind e2); the d2 pawn pushing to d3 does not attack it.
    expect(labels(r.attackers)).toEqual(["Pc2", "Pe2", "Bf1 (x-ray)"]);
    expect(r.defenders).toEqual([]);
    expect(r.sequence).toEqual([]);
    expect(r.result).toBe(0);
    expect(r.bestLength).toBe(0);
  });

  it("an empty square with Black to move: Black is the attacking side", () => {
    const r = exchangeOnSquare("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", "d5");
    expect(r.attackingSide).toBe("b");
    expect(r.attackerToMove).toBe(true);
    expect(r.attackers).toEqual([]);
    expect(labels(r.defenders)).toEqual(["Pe4"]);
  });

  it("attackerToMove is false when the attacker is not to move: the result is a threat", () => {
    const r = exchangeOnSquare("6k1/3n4/8/4p3/2N5/5N2/8/6K1 b - - 0 1", "e5");
    expect(r.attackingSide).toBe("w");
    expect(r.attackerToMove).toBe(false);
    expect(captures(r)).toEqual(["1. Nc4xp", "2. Nd7xn", "3. Nf3xn"]);
    expect(r.result).toBe(1);
    expect(r.bestLength).toBe(1);
  });

  it("the caveat is the same fixed text every time", () => {
    const a = exchangeOnSquare(START, "e4");
    const b = exchangeOnSquare("6k1/8/3p4/4p3/8/5N2/8/6K1 w - - 0 1", "e5");
    expect(a.caveat).toBe(b.caveat);
    expect(a.caveat.length).toBeGreaterThan(20);
  });

  it("throws a clear error on a bad square or FEN", () => {
    expect(() => exchangeOnSquare(START, "e9")).toThrow(/square/);
    expect(() => exchangeOnSquare(START, "E4")).toThrow(/square/);
    expect(() => exchangeOnSquare("not a fen", "e4")).toThrow(/FEN/);
  });
});
