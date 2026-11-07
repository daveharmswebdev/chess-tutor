import { describe, expect, it } from "vitest";
import { fenAfter, isOwnPiece, legalTargets, moveToUci } from "../src/chess-rules.ts";
import { AFTER_D4_FEN, START_FEN } from "./fixtures.ts";

const PROMO_FEN = "8/4P3/8/8/8/8/k7/4K3 w - - 0 1";
const CASTLE_FEN = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";

describe("chess rules (client-side legality, the server stays the authority)", () => {
  it("lists legal target squares for a piece", () => {
    expect(legalTargets(START_FEN, "d2")).toEqual(["d3", "d4"]);
    expect(legalTargets(START_FEN, "g1")).toEqual(["f3", "h3"]);
    expect(legalTargets(START_FEN, "d7")).toEqual([]); // not White's piece to move
    expect(legalTargets(START_FEN, "e4")).toEqual([]);
  });

  it("turns a legal from/to pair into UCI and rejects illegal ones", () => {
    expect(moveToUci(START_FEN, "d2", "d4")).toBe("d2d4");
    expect(moveToUci(START_FEN, "d2", "d5")).toBeNull();
    expect(moveToUci(AFTER_D4_FEN, "g8", "f6")).toBe("g8f6");
  });

  it("auto-queens a promotion", () => {
    expect(moveToUci(PROMO_FEN, "e7", "e8")).toBe("e7e8q");
  });

  it("encodes castling as the king moving two squares", () => {
    expect(moveToUci(CASTLE_FEN, "e1", "g1")).toBe("e1g1");
    expect(moveToUci(CASTLE_FEN, "e1", "c1")).toBe("e1c1");
  });

  it("computes the FEN after a UCI move", () => {
    expect(fenAfter(START_FEN, "d2d4")).toBe(AFTER_D4_FEN);
    expect(fenAfter(START_FEN, "d2d5")).toBeNull();
  });

  it("knows whose pieces are whose", () => {
    expect(isOwnPiece(START_FEN, "e2", "w")).toBe(true);
    expect(isOwnPiece(START_FEN, "e7", "w")).toBe(false);
    expect(isOwnPiece(START_FEN, "e4", "w")).toBe(false);
    expect(isOwnPiece(START_FEN, "e7", "b")).toBe(true);
  });

  it("does not throw on a malformed FEN or square", () => {
    expect(legalTargets("not a fen", "e2")).toEqual([]);
    expect(moveToUci(START_FEN, "z9", "e4")).toBeNull();
  });
});
