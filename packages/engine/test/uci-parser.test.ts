import { describe, expect, it } from "vitest";
import { parseBestMove, parseInfo, sideToMove } from "../src/uci-parser.ts";

describe("parseInfo", () => {
  it("parses a full info line", () => {
    const line =
      "info depth 18 seldepth 28 multipv 2 score cp -10 nodes 874669 nps 3215694 hashfull 293 time 272 pv d7d5 g1f3 c7c5";
    expect(parseInfo(line)).toEqual({
      depth: 18,
      multipv: 2,
      score: { kind: "cp", value: -10 },
      nodes: 874669,
      nps: 3215694,
      timeMs: 272,
      pv: ["d7d5", "g1f3", "c7c5"],
    });
  });

  it("parses mate scores", () => {
    expect(parseInfo("info depth 5 score mate -2 pv e1e2")?.score).toEqual({ kind: "mate", value: -2 });
  });

  it("flags bound scores so they are not mistaken for final values", () => {
    const info = parseInfo("info depth 12 multipv 1 score cp 35 lowerbound nodes 100 pv e2e4");
    expect(info?.bound).toBe(true);
    expect(info?.score).toEqual({ kind: "cp", value: 35 });
    expect(info?.pv).toEqual(["e2e4"]);
  });

  it("ignores info string and non-info lines", () => {
    expect(parseInfo("info string NNUE evaluation using nn-1234.nnue")).toBeNull();
    expect(parseInfo("readyok")).toBeNull();
  });
});

describe("parseBestMove", () => {
  it("parses bestmove with and without ponder", () => {
    expect(parseBestMove("bestmove d7d5 ponder g1f3")).toEqual({ move: "d7d5", ponder: "g1f3" });
    expect(parseBestMove("bestmove e2e4")).toEqual({ move: "e2e4" });
    expect(parseBestMove("info depth 1")).toBeNull();
  });
});

describe("sideToMove", () => {
  it("reads the side to move", () => {
    expect(sideToMove("rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1")).toBe("b");
    expect(() => sideToMove("garbage")).toThrow();
  });
});
