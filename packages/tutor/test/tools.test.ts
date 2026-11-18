import { EXCHANGE_CAVEAT, exchangeOnSquare } from "@chess-tutor/chess-core";
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
  it("are five strict tools in a fixed order with closed schemas; exchange_on_square is appended last (IR-6, #44)", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      "analyze_position",
      "evaluate_move",
      "opening_explorer",
      "get_repertoire_context",
      "exchange_on_square",
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
    expect(c.evidence.backsMove(FEN, "g1f3")).toBe(true);
    // Each ply is backed in the position it is played from, not anywhere else.
    expect(c.evidence.backsMove(fenAfter([...HISTORY, "e2e3"]), "e7e6")).toBe(true);
    expect(c.evidence.backsMove(FEN, "e7e6")).toBe(false);
    // Scores are kept signed, White-relative (#26): an evals entry must name the right side.
    expect(c.evidence.backsEntry({ side: "white", cp: 35, mate: null })).toBe(true);
    expect(c.evidence.backsEntry({ side: "black", cp: -20, mate: null })).toBe(true);
    expect(c.evidence.backsEntry({ side: "black", cp: 20, mate: null })).toBe(false);
    expect(c.evidence.backsEntry({ side: "white", cp: 30, mate: null })).toBe(false);
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
  it("records the played_eval it shows when the move ends the game (review 047 minor 4)", async () => {
    // White: Kg6, Qf5; Black: Kh8. Qf7 stalemates.
    const fen = "7k/8/6K1/5Q2/8/8/8/8 w - - 0 1";
    const c = ctx({ engine: fakeEngine({ [fen]: [{ moves: ["f5c8"], cp: 500 }] }).engine });
    const r = (await runTool("evaluate_move", { fen, move: "Qf7" }, c)) as any;
    expect(r.game_over_after_move).toBe(true);
    expect(r.played_eval).toEqual({ eval_cp: 0, mate_in: null });
    expect(c.evidence.backsEntry({ side: "white", cp: 0, mate: null })).toBe(true);
  });

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
    expect(c.evidence.backsMove(fenAfter([...HISTORY, "b1c3"]), "c8f5")).toBe(true);
    expect(c.evidence.backsMove(FEN, "b1c3")).toBe(true);
    expect(c.evidence.backsMove(FEN, "c8f5")).toBe(false);
    // The scores before (+40) and after Nc3 (-30), White-relative; cp_loss is a change, not a standing (#26).
    expect(c.evidence.backsEntry({ side: "white", cp: 40, mate: null })).toBe(true);
    expect(c.evidence.backsEntry({ side: "white", cp: -30, mate: null })).toBe(true);
    expect(c.evidence.backsEntry({ side: "black", cp: 30, mate: null })).toBe(true);
    expect(c.evidence.backsEntry({ side: "white", cp: 70, mate: null })).toBe(false);
    expect(c.evidence.isDelta(70)).toBe(true);
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
    expect(c.evidence.backsMove(FEN, "g1f3")).toBe(true);
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
    expect(c.evidence.backsMove(FEN, "e2e3")).toBe(true);
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

  it("keeps the in-book result shape: no usual_setup while in book (#41)", async () => {
    const r = (await runTool("get_repertoire_context", { fen: FEN }, ctx({ repertoire: rep }))) as any;
    expect(Object.keys(r).sort()).toEqual(["color", "end_of_line", "in_repertoire", "line", "next_moves"]);
  });

  describe("out of book: the player's usual setup from the last book position (#41, FR-9, FR-10)", () => {
    const kid = fakeRepertoire([
      {
        name: "KID Classical",
        color: "b",
        uci: ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f8g7", "e2e4", "d7d6", "g1f3", "e8g8", "f1e2", "e7e5"],
      },
    ]);
    const history = ["d2d4", "g8f6", "g1f3"]; // 2.Nf3 instead of c4
    const fen = fenAfter(history);
    const black = (over: Partial<ToolContext> = {}) => ctx({ repertoire: kid, history, playerColor: "b", ...over });

    it("lists the player's next moves of the last book line, in order, and says they are not engine-checked", async () => {
      const r = (await runTool("get_repertoire_context", { fen }, black())) as any;
      expect(r).toMatchObject({ in_repertoire: false, last_book_line: "KID Classical", left_book_with: { san: "Nf3", uci: "g1f3" } });
      expect(r.usual_setup).toEqual([
        { san: "g6", uci: "g7g6" },
        { san: "Bg7", uci: "f8g7" },
        { san: "d6", uci: "d7d6" },
        { san: "O-O", uci: "e8g8" },
        { san: "e5", uci: "e7e5" },
      ]);
      expect(r.usual_setup_note).toMatch(/not engine-checked/);
    });

    it("registers each setup move as plan evidence in the position it is played from, never as backed moves (review 096)", async () => {
      const c = black();
      await runTool("get_repertoire_context", { fen }, c);
      expect(c.evidence.backsPlan(fen, "g7g6")).toBe(true); // the first one, in the game position
      // Plan evidence never backs a move as such: revealMove checks backsMove only.
      expect(c.evidence.backsMove(fen, "g7g6")).toBe(false);
      // Bg7 is not legal in the game position itself, so it is not plan evidence there.
      expect(c.evidence.backsPlan(fen, "f8g7")).toBe(false);
      // The opponent's replies are left out: after ...g6 it is Black's turn again.
      const afterG6 = fenAfter(history).replace("pppppppp/5n2/8", "pppppp1p/5np1/8");
      expect(c.evidence.backsPlan(afterG6, "f8g7")).toBe(true);
      expect(c.evidence.backsMove(afterG6, "f8g7")).toBe(false);
    });

    it("stops after a setup move that gives check (no position with the side not to move in check)", async () => {
      const checking = fakeRepertoire([
        { name: "KID Classical", color: "b", uci: ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "e2e3", "g7g6"] },
      ]);
      const r = (await runTool("get_repertoire_context", { fen }, black({ repertoire: checking }))) as any;
      expect(r.usual_setup).toEqual([
        { san: "e6", uci: "e7e6" },
        { san: "Bb4+", uci: "f8b4" },
      ]);
    });

    it("drops repertoire moves that are illegal in the new position, and stays empty when it is not the player's turn", async () => {
      const line = fakeRepertoire([
        { name: "KID Classical", color: "b", uci: ["d2d4", "g8f6", "c2c4", "g7g6", "b1c3", "f6h5", "e2e4", "d7d6"] },
      ]);
      // 2.Bg5 g6 3.Bxf6: ...g6 is already played and the knight on f6 is gone, so ...g6 and
      // ...Nh5 are dropped; ...d6 is kept.
      const h = ["d2d4", "g8f6", "c1g5", "g7g6", "g5f6"];
      const c = ctx({ repertoire: line, history: h, playerColor: "b" });
      const r = (await runTool("get_repertoire_context", { fen: fenAfter(h) }, c)) as any;
      expect(r).toMatchObject({ in_repertoire: false, left_book_with: { san: "Bg5" } });
      expect(r.usual_setup).toEqual([{ san: "d6", uci: "d7d6" }]);
      expect(c.evidence.backsPlan(fenAfter(h), "d7d6")).toBe(true);
      expect(c.evidence.backsPlan(fenAfter(h), "f6h5")).toBe(false);
      // The player's own move left the book: the opponent is to move, so no setup is given.
      const own = ["d2d4", "g8f6", "c2c4", "e7e6"];
      const r2 = (await runTool("get_repertoire_context", { fen: fenAfter(own) }, ctx({ repertoire: line, history: own, playerColor: "b" }))) as any;
      expect(r2).toMatchObject({ in_repertoire: false, left_book_with: { san: "e6" }, usual_setup: [] });
    });
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

describe("exchange_on_square (FR-21, #44)", () => {
  // 1.d4 d5 2.Bf4 Nc6 3.e3 e5: e5 is attacked by d4 and Bf4, defended by Nc6; dxe5 wins a pawn.
  const fen = "r1bqkbnr/ppp2ppp/2n5/3pp3/3P1B2/4P3/PPP2PPP/RN1QKBNR w KQkq - 0 4";

  it("is strict, closed and needs fen and square", () => {
    const tool = TOOL_DEFINITIONS[4]!;
    expect(tool.name).toBe("exchange_on_square");
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(["fen", "square"]);
    expect(Object.keys(tool.input_schema.properties as object)).toEqual(["fen", "square"]);
    // The description says it is a static count and to confirm with the engine (FR-23).
    expect(tool.description).toMatch(/pins/);
    expect(tool.description).toMatch(/engine/);
  });

  it("returns chess-core's exchangeOnSquare result and records it as evidence for that position and square", async () => {
    const c = ctx();
    const r = await runTool("exchange_on_square", { fen, square: "e5" }, c);
    expect(r).toEqual({ ...exchangeOnSquare(fen, "e5"), startResult: 1 });
    const result = r as ReturnType<typeof exchangeOnSquare>;
    expect(result.attackers.map((p) => p.square)).toEqual(["d4", "f4"]);
    expect(result.defenders.map((p) => p.square)).toEqual(["c6"]);
    expect(result.result).toBe(1);
    expect(result.caveat).toBe(EXCHANGE_CAVEAT);
    expect(c.evidence.exchangesOn("e5")).toEqual([exchangeOnSquare(fen, "e5")]);
    expect(c.evidence.exchangesOn("d4")).toEqual([]);
    // The capture sequence is not move evidence: a capture is judged by the engine (FR-10).
    expect(c.evidence.backsMove(fen, "d4e5")).toBe(false);
  });

  it("accepts an upper-case square", async () => {
    const r = (await runTool("exchange_on_square", { fen, square: "E5" }, ctx())) as ReturnType<typeof exchangeOnSquare>;
    expect(r.square).toBe("e5");
  });

  it("throws for an invalid square or FEN (the loop turns that into is_error)", async () => {
    await expect(runTool("exchange_on_square", { fen, square: "z9" }, ctx())).rejects.toThrow(/square/);
    await expect(runTool("exchange_on_square", { fen: "not a fen", square: "e5" }, ctx())).rejects.toThrow(/FEN/);
    await expect(runTool("exchange_on_square", { fen }, ctx())).rejects.toThrow(/input/);
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
    expect(toolLabel("exchange_on_square", { fen: FEN, square: "e5" })).toBe("Counting attackers and defenders on e5…");
    expect(toolLabel("exchange_on_square", { fen: FEN })).toBe("Counting attackers and defenders…");
    expect(toolLabel("nope", {})).toBe("Thinking…");
  });
});

describe("runTool", () => {
  it("rejects unknown tools and bad input", async () => {
    await expect(runTool("nope", {}, ctx())).rejects.toThrow(/unknown tool/);
    await expect(runTool("evaluate_move", { fen: FEN }, ctx())).rejects.toThrow(/input/);
  });
});
