import { describe, expect, it } from "vitest";
import { buildRepertoire } from "../src/index.ts";

const rep = buildRepertoire([
  { name: "London vs ...d5", color: "w", pgn: "1. d4 d5 2. Bf4 Nf6 3. e3" },
  { name: "London vs ...d5 c5", color: "w", pgn: "1. d4 d5 2. Bf4 c5 3. e3" },
  { name: "London vs KID setup", color: "w", pgn: "1. d4 g6 2. Bf4 Bg7 3. e3" },
  { name: "KID vs c4", color: "b", pgn: "1. d4 Nf6 2. c4 g6 3. Nc3 Bg7" },
  { name: "KID vs London", color: "b", pgn: "1. d4 Nf6 2. Bf4 g6" },
]);

const sans = (r: ReturnType<typeof rep.continuations>) => r?.moves.map((m) => m.san);

describe("buildRepertoire / continuations", () => {
  it("returns the first move from the start position, merged across lines", () => {
    const r = rep.continuations([], "w");
    expect(r).toEqual({ line: "London vs ...d5", moves: [{ uci: "d2d4", san: "d4" }] });
  });

  it("merges shared prefixes into unique continuations", () => {
    expect(sans(rep.continuations(["d2d4"], "w"))).toEqual(["d5", "g6"]);
    expect(sans(rep.continuations(["d2d4", "d7d5"], "w"))).toEqual(["Bf4"]);
    expect(sans(rep.continuations(["d2d4", "d7d5", "c1f4"], "w"))).toEqual(["Nf6", "c5"]);
  });

  it("names the first line that matches the history", () => {
    expect(rep.continuations(["d2d4", "d7d5", "c1f4"], "w")?.line).toBe("London vs ...d5");
    expect(rep.continuations(["d2d4", "g7g6"], "w")?.line).toBe("London vs KID setup");
  });

  it("carries UCI and SAN for each continuation", () => {
    expect(rep.continuations(["d2d4", "d7d5", "c1f4"], "w")?.moves).toEqual([
      { uci: "g8f6", san: "Nf6" },
      { uci: "c7c5", san: "c5" },
    ]);
  });

  it("returns null once history has left every line", () => {
    expect(rep.continuations(["e2e4"], "w")).toBeNull();
    expect(rep.continuations(["d2d4", "e7e5"], "w")).toBeNull();
    expect(rep.continuations(["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "e7e6"], "w")).toBeNull();
  });

  it("returns an empty continuation list at the end of a line", () => {
    expect(rep.continuations(["d2d4", "d7d5", "c1f4", "g8f6", "e2e3"], "w")).toEqual({
      line: "London vs ...d5",
      moves: [],
    });
  });

  it("names the first matching line that still has a continuation", () => {
    const r = buildRepertoire([
      { name: "Short", color: "w", pgn: "1. e4 e5 2. Nf3" },
      { name: "Italian", color: "w", pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4" },
    ]);
    expect(r.continuations(["e2e4", "e7e5", "g1f3"], "w")).toEqual({
      line: "Italian",
      moves: [{ uci: "b8c6", san: "Nc6" }],
    });
    expect(r.continuations(["e2e4"], "w")?.line).toBe("Short");
  });

  it("filters by color", () => {
    expect(sans(rep.continuations(["d2d4"], "b"))).toEqual(["Nf6"]);
    expect(sans(rep.continuations(["d2d4", "g8f6"], "b"))).toEqual(["c4", "Bf4"]);
    expect(rep.continuations(["d2d4", "g8f6"], "w")).toBeNull();
    expect(rep.continuations(["d2d4", "d7d5"], "b")).toBeNull();
  });

  it("returns null for a color with no lines", () => {
    const whiteOnly = buildRepertoire([{ name: "London", color: "w", pgn: "1. d4 d5 2. Bf4" }]);
    expect(whiteOnly.continuations([], "b")).toBeNull();
  });

  it("rejects an unparseable or empty PGN", () => {
    expect(() => buildRepertoire([{ name: "bad", color: "w", pgn: "1. d4 d5 2. Qxh7" }])).toThrow(/bad/);
    expect(() => buildRepertoire([{ name: "empty", color: "w", pgn: "" }])).toThrow(/empty/);
  });
});
