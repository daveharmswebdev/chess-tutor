import { describe, expect, it } from "vitest";
import { Evidence } from "../src/evidence.ts";
import { TOOL_DEFINITIONS, runTool, toolLabel, type ToolContext } from "../src/tools.ts";
import { CONFIG, fakeEngine, fakeExplorer, fakeRepertoire, fenAfter } from "./helpers.ts";

const HISTORY = ["d2d4", "d7d5", "c1f4", "g8f6"];
const FEN = fenAfter(HISTORY);

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    engine: fakeEngine().engine,
    explorer: fakeExplorer({ moves: [], totalGames: 0, opening: null }).explorer,
    repertoire: null,
    config: CONFIG,
    playerColor: "w",
    history: HISTORY,
    evidence: new Evidence(),
    ...over,
  };
}

describe("tool definitions", () => {
  it("are four strict tools in a fixed order with closed schemas", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      "analyze_position",
      "evaluate_move",
      "opening_explorer",
      "get_repertoire_context",
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.input_schema.required).toContain("fen");
      expect(tool.description!.length).toBeGreaterThan(20);
    }
  });
});

describe("analyze_position (FR-16)", () => {
  it("caps depth, multi_pv and movetime by config and returns lines in SAN and UCI", async () => {
    const { engine, calls } = fakeEngine({ [FEN]: [{ moves: ["e2e3", "e7e6"], cp: 35 }, { moves: ["g1f3"], cp: 20 }] });
    const c = ctx({ engine });
    const result = (await runTool("analyze_position", { fen: FEN, depth: 40, multi_pv: 9 }, c)) as any;
    expect(calls[0]!.opts).toEqual({ depth: 18, multiPv: 3, movetimeMs: 1000 });
    expect(result.side_to_move).toBe("white");
    expect(result.lines[0]).toEqual({
      rank: 1,
      eval_cp: 35,
      mate_in: null,
      moves: [
        { san: "e3", uci: "e2e3" },
        { san: "e6", uci: "e7e6" },
      ],
    });
    expect(result.lines[1].moves).toEqual([{ san: "Nf3", uci: "g1f3" }]);
    expect(c.evidence.backs("Nf3")).toBe(true);
  });

  it("uses smaller requested values and config defaults", async () => {
    const { engine, calls } = fakeEngine();
    await runTool("analyze_position", { fen: FEN, depth: 8, multi_pv: 1 }, ctx({ engine }));
    await runTool("analyze_position", { fen: FEN }, ctx({ engine }));
    expect(calls.map((c) => c.opts)).toEqual([
      { depth: 8, multiPv: 1, movetimeMs: 1000 },
      { depth: 18, multiPv: 3, movetimeMs: 1000 },
    ]);
  });

  it("rejects an invalid FEN", async () => {
    await expect(runTool("analyze_position", { fen: "not a fen" }, ctx())).rejects.toThrow(/FEN/);
  });

  it("reports mate scores as mate_in", async () => {
    const { engine } = fakeEngine();
    const mateEngine = {
      async analyze(fen: string) {
        const a = await engine.analyze(fen);
        return { ...a, lines: a.lines.map((l) => ({ ...l, score: { kind: "mate" as const, value: -2 } })) };
      },
    };
    const result = (await runTool("analyze_position", { fen: FEN }, ctx({ engine: mateEngine }))) as any;
    expect(result.lines[0].eval_cp).toBeNull();
    expect(result.lines[0].mate_in).toBe(-2);
  });
});

describe("evaluate_move (FR-17)", () => {
  const lines = {
    [FEN]: [{ moves: ["e2e3", "e7e6"], cp: 40 }],
    [fenAfter([...HISTORY, "b1c3"])]: [{ moves: ["c8f5", "e2e3"], cp: -30 }],
    [fenAfter([...HISTORY, "e2e3"])]: [{ moves: ["e7e6"], cp: 40 }],
  };

  it("accepts SAN, returns centipawn loss for the mover and the engine's reply", async () => {
    const c = ctx({ engine: fakeEngine(lines).engine });
    const r = (await runTool("evaluate_move", { fen: FEN, move: "Nc3" }, c)) as any;
    expect(r.move).toEqual({ san: "Nc3", uci: "b1c3" });
    expect(r.best).toEqual({ san: "e3", uci: "e2e3" });
    expect(r.cp_loss).toBe(70);
    expect(r.reply).toEqual({ san: "Bf5", uci: "c8f5" });
    expect(c.evidence.backs("Bf5")).toBe(true);
    expect(c.evidence.backs("Nc3")).toBe(true);
  });

  it("accepts UCI and reports zero loss for the best move", async () => {
    const r = (await runTool("evaluate_move", { fen: FEN, move: "e2e3" }, ctx({ engine: fakeEngine(lines).engine }))) as any;
    expect(r.move.san).toBe("e3");
    expect(r.cp_loss).toBe(0);
  });

  it("measures loss from Black's point of view when Black moves", async () => {
    const fen = fenAfter(["d2d4", "d7d5", "c1f4"]);
    const l = {
      [fen]: [{ moves: ["g8f6"], cp: 20 }],
      [fenAfter(["d2d4", "d7d5", "c1f4", "a7a6"])]: [{ moves: ["e2e3"], cp: 80 }],
    };
    const r = (await runTool("evaluate_move", { fen, move: "a6" }, ctx({ engine: fakeEngine(l).engine }))) as any;
    expect(r.cp_loss).toBe(60);
  });

  it("throws for an illegal move", async () => {
    await expect(runTool("evaluate_move", { fen: FEN, move: "Qxh7" }, ctx())).rejects.toThrow(/illegal/i);
    await expect(runTool("evaluate_move", { fen: FEN, move: "e2e5" }, ctx())).rejects.toThrow(/illegal/i);
  });

  it("handles a mating move (no engine reply)", async () => {
    const fen = fenAfter(["f2f3", "e7e5", "g2g4"]);
    const l = { [fen]: [{ moves: ["d8h4"], cp: -99999 }] };
    const r = (await runTool("evaluate_move", { fen, move: "Qh4#" }, ctx({ engine: fakeEngine(l).engine }))) as any;
    expect(r.move.san).toBe("Qh4#");
    expect(r.reply).toBeNull();
    expect(r.cp_loss).toBe(0);
  });
});

describe("opening_explorer (FR-18)", () => {
  it("returns human moves with shares and passes the configured ratings and speeds", async () => {
    const { explorer, calls } = fakeExplorer({
      totalGames: 1000,
      opening: { eco: "D02", name: "London System" },
      moves: [
        { uci: "e2e3", san: "e3", games: 600, white: 300, draws: 100, black: 200, averageRating: 1300 },
        { uci: "g1f3", san: "Nf3", games: 400, white: 200, draws: 0, black: 200, averageRating: 1290 },
      ],
    });
    const c = ctx({ explorer });
    const r = (await runTool("opening_explorer", { fen: FEN }, c)) as any;
    expect(calls[0]).toEqual({ fen: FEN, options: CONFIG.explorer });
    expect(r.total_games).toBe(1000);
    expect(r.opening).toBe("D02 London System");
    expect(r.moves[0]).toEqual({ san: "e3", uci: "e2e3", games: 600, share_pct: 60, white_pct: 50, draw_pct: 17, black_pct: 33 });
    expect(c.evidence.backs("Nf3")).toBe(true);
  });

  it("reports unavailable data as a result, not an error", async () => {
    const { explorer } = fakeExplorer({ moves: [], totalGames: 0, opening: null, unavailable: "rate_limited" });
    const r = (await runTool("opening_explorer", { fen: FEN }, ctx({ explorer }))) as any;
    expect(r).toEqual({ available: false, reason: "rate_limited" });
  });
});

describe("get_repertoire_context (FR-19)", () => {
  const rep = fakeRepertoire([
    { name: "London System", color: "w", uci: ["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "e7e6"] },
    { name: "King's Indian Defence", color: "b", uci: ["d2d4", "g8f6", "c2c4", "g7g6"] },
  ]);

  it("says no repertoire is loaded when there is none", async () => {
    const r = (await runTool("get_repertoire_context", { fen: FEN }, ctx())) as any;
    expect(r).toEqual({ repertoire_loaded: false, note: "no repertoire loaded" });
  });

  it("reports in-repertoire positions with the line name and next moves", async () => {
    const c = ctx({ repertoire: rep });
    const r = (await runTool("get_repertoire_context", { fen: FEN }, c)) as any;
    expect(r).toMatchObject({ in_repertoire: true, line: "London System", next_moves: [{ san: "e3", uci: "e2e3" }] });
    expect(r.color).toBe("white");
    expect(c.evidence.backs("e3")).toBe(true);
  });

  it("finds earlier positions of the game and one move ahead", async () => {
    const early = (await runTool("get_repertoire_context", { fen: fenAfter(["d2d4", "d7d5"]) }, ctx({ repertoire: rep }))) as any;
    expect(early.next_moves).toEqual([{ san: "Bf4", uci: "c1f4" }]);
    const ahead = (await runTool("get_repertoire_context", { fen: fenAfter([...HISTORY, "e2e3"]) }, ctx({ repertoire: rep }))) as any;
    expect(ahead.next_moves).toEqual([{ san: "e6", uci: "e7e6" }]);
  });

  it("names the last book line and the move that left it", async () => {
    const history = [...HISTORY, "b1c3"];
    const r = (await runTool("get_repertoire_context", { fen: fenAfter(history) }, ctx({ repertoire: rep, history }))) as any;
    expect(r).toMatchObject({ in_repertoire: false, last_book_line: "London System", left_book_with: { san: "Nc3", uci: "b1c3" } });
  });

  it("uses the player's colour", async () => {
    const r = (await runTool("get_repertoire_context", { fen: FEN }, ctx({ repertoire: rep, playerColor: "b" }))) as any;
    expect(r.in_repertoire).toBe(false);
    expect(r.color).toBe("black");
  });

  it("says when the position is not from this game", async () => {
    const r = (await runTool("get_repertoire_context", { fen: fenAfter(["e2e4"]) }, ctx({ repertoire: rep }))) as any;
    expect(r.in_game).toBe(false);
  });
});

describe("toolLabel (NFR-1)", () => {
  it("names each tool in plain words, evaluate_move with the move in SAN", () => {
    expect(toolLabel("evaluate_move", { fen: FEN, move: "b1c3" })).toBe("Checking Nc3…");
    expect(toolLabel("evaluate_move", { fen: FEN, move: "Nc3" })).toBe("Checking Nc3…");
    expect(toolLabel("evaluate_move", { fen: "bad", move: "zz" })).toBe("Checking zz…");
    expect(toolLabel("analyze_position", { fen: FEN })).toBe("Looking at the engine lines…");
    expect(toolLabel("opening_explorer", { fen: FEN })).toBe("Checking what players usually play…");
    expect(toolLabel("get_repertoire_context", { fen: FEN })).toBe("Checking your repertoire…");
    expect(toolLabel("nope", {})).toBe("Thinking…");
  });
});

describe("runTool", () => {
  it("rejects unknown tools and bad input", async () => {
    await expect(runTool("nope", {}, ctx())).rejects.toThrow(/unknown tool/);
    await expect(runTool("evaluate_move", { fen: FEN }, ctx())).rejects.toThrow(/input/);
  });
});
