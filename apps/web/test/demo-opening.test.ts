// Opening helper for the guided demo (#59: FR-27): a scripted move is played only when it is
// legal in the actual position (chess.js on the real move list), else the next fallback.
import { describe, expect, it } from "vitest";
import { FALLBACK_MOVES, OPENING_PLAN, fenFromSans, firstLegal } from "../demo/opening.ts";

describe("firstLegal", () => {
  it("plays d4 first and Bf4 after any bot reply", () => {
    expect(firstLegal([], OPENING_PLAN[0]!)).toEqual({ san: "d4", from: "d2", to: "d4" });
    for (const reply of ["d5", "Nf6", "e5", "g6", "c5", "f5", "e6", "Nc6", "h5", "a5", "Nh6", "b6"]) {
      expect(firstLegal(["d4", reply], OPENING_PLAN[1]!)?.san).toBe("Bf4");
    }
  });

  it("skips a scripted move that is illegal in the actual position and takes the next candidate", () => {
    const moves = ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qd4"]; // Black's queen stands on d4
    expect(firstLegal(moves, ["d4", "Nf3"])?.san).toBe("Nf3");
  });

  it("returns null when no candidate is legal", () => {
    expect(firstLegal(["d4", "d5"], ["d4", "Bb2", "O-O"])).toBeNull();
  });

  it("finds no White move when Black is to move", () => {
    expect(firstLegal(["d4"], ["d5", "Nf3"])).toBeNull();
  });

  it("matches a scripted move with or without its check suffix", () => {
    expect(firstLegal(["e4", "f6"], ["Qh5"])).toEqual({ san: "Qh5+", from: "d1", to: "h5" });
    expect(firstLegal(["e4", "f6"], ["Qh5+"])?.san).toBe("Qh5+");
  });

  it("has fallback developing moves, the first legal one played", () => {
    expect(FALLBACK_MOVES.length).toBeGreaterThan(3);
    expect(firstLegal(["d4", "d5", "Bf4", "Nf6"], FALLBACK_MOVES)?.san).toBe(FALLBACK_MOVES[0]);
    // e3 taken already: the next fallback.
    expect(firstLegal(["d4", "d5", "Bf4", "Nf6", "e3", "e6"], FALLBACK_MOVES)?.san).toBe(FALLBACK_MOVES[1]);
  });
});

describe("fenFromSans", () => {
  it("replays the real move list", () => {
    expect(fenFromSans([])).toBe("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(fenFromSans(["d4", "d5"])).toBe("rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2");
  });

  it("throws on a move list that does not replay", () => {
    expect(() => fenFromSans(["d4", "d4"])).toThrow();
  });
});
