import { describe, expect, it } from "vitest";
import {
  createSparringBot,
  explorerRatingsFor,
  weakeningAt,
  type BotAnalysis,
  type BotConfig,
  type BotEngine,
  type BotExplorer,
  type BotExplorerMove,
  type BotExplorerResult,
  type BotLookupOptions,
  type BotWeakeningConfig,
  type Score,
} from "../src/index.ts";
import { START } from "./fixtures.ts";

/** Same values as config/tutor.json bot.weakening at 03f355b. */
const WEAKENING: BotWeakeningConfig = {
  multiPv: 5,
  depth: 10,
  blunderMinLossCp: 200,
  anchors: [
    { strength: 500, temperatureCp: 250, blunderRate: 0.25 },
    { strength: 900, temperatureCp: 150, blunderRate: 0.1 },
    { strength: 1300, temperatureCp: 60, blunderRate: 0.02 },
  ],
};

const CONFIG: BotConfig = {
  explorerRatings: [1200, 1400],
  explorerSpeeds: ["blitz", "rapid"],
  minGames: 20,
  outOfBookElo: 1400,
  weakening: WEAKENING,
};

/** After 1.f3 e5 2.g4 Qh4#: White is checkmated. */
const MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
/** Black to move, no legal moves, not in check. */
const STALEMATE = "k7/8/1Q6/8/8/8/8/7K b - - 0 1";

function mv(uci: string, games: number): BotExplorerMove {
  return { uci, san: uci, games };
}

function result(moves: BotExplorerMove[], totalGames?: number): BotExplorerResult {
  return { moves, totalGames: totalGames ?? moves.reduce((s, m) => s + m.games, 0) };
}

function fakeExplorer(
  answer: BotExplorerResult | (() => Promise<BotExplorerResult>),
): BotExplorer & { calls: { fen: string; options: BotLookupOptions }[] } {
  const calls: { fen: string; options: BotLookupOptions }[] = [];
  return {
    calls,
    lookup(fen, options) {
      calls.push({ fen, options });
      return typeof answer === "function" ? answer() : Promise.resolve(answer);
    },
  };
}

function fakeEngine(
  move = "g1f3",
  analysis?: BotAnalysis,
): BotEngine & { calls: { fen: string; opts: unknown }[]; analyzeCalls: { fen: string; opts: unknown }[] } {
  const calls: { fen: string; opts: unknown }[] = [];
  const analyzeCalls: { fen: string; opts: unknown }[] = [];
  return {
    calls,
    analyzeCalls,
    bestMove(fen, opts) {
      calls.push({ fen, opts });
      return Promise.resolve(move);
    },
    analyze(fen, opts) {
      analyzeCalls.push({ fen, opts });
      return Promise.resolve(analysis ?? { bestMove: move, lines: [{ moves: [move], score: cp(0) }] });
    },
  };
}

function cp(value: number): Score {
  return { kind: "cp", value };
}

function mate(value: number): Score {
  return { kind: "mate", value };
}

/** Returns the given values in order, then repeats the last one. */
function fixedRandom(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

/** mulberry32: small deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOOK = result([mv("e2e4", 60), mv("d2d4", 30), mv("c2c4", 10)]);

describe("createSparringBot: explorer sampling (FR-2)", () => {
  it("picks by cumulative weight at exact boundaries", async () => {
    const cases: [number, string][] = [
      [0, "e2e4"],
      [0.5999, "e2e4"],
      [0.6, "d2d4"],
      [0.8999, "d2d4"],
      [0.9, "c2c4"],
      [0.99999, "c2c4"],
    ];
    for (const [r, expected] of cases) {
      const bot = createSparringBot({
        explorer: fakeExplorer(BOOK),
        engine: fakeEngine(),
        config: CONFIG,
        random: fixedRandom(r),
      });
      const move = await bot.chooseMove(START);
      expect(move.uci, `random ${r}`).toBe(expected);
      expect(move.source).toBe("explorer");
    }
  });

  it("returns SAN and explorer stats with the share of total games", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(result([mv("e2e4", 60), mv("d2d4", 30)], 120)),
      engine: fakeEngine(),
      config: CONFIG,
      random: fixedRandom(0),
    });
    const move = await bot.chooseMove(START);
    expect(move).toEqual({
      uci: "e2e4",
      san: "e4",
      source: "explorer",
      explorer: { games: 60, totalGames: 120, share: 0.5 },
    });
  });

  it("samples in proportion to games played over many draws", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(BOOK),
      engine: fakeEngine(),
      config: CONFIG,
      random: mulberry32(42),
    });
    const counts: Record<string, number> = {};
    const n = 5000;
    for (let i = 0; i < n; i++) {
      const { uci } = await bot.chooseMove(START);
      counts[uci] = (counts[uci] ?? 0) + 1;
    }
    expect(counts["e2e4"]! / n).toBeCloseTo(0.6, 1);
    expect(counts["d2d4"]! / n).toBeCloseTo(0.3, 1);
    expect(counts["c2c4"]! / n).toBeCloseTo(0.1, 1);
    expect(Object.keys(counts).sort()).toEqual(["c2c4", "d2d4", "e2e4"]);
  });

  it("never picks moves with zero games", async () => {
    const explorer = fakeExplorer(result([mv("e2e4", 0), mv("d2d4", 25), mv("c2c4", 0)], 25));
    for (const r of [0, 0.3, 0.7, 0.99999]) {
      const bot = createSparringBot({ explorer, engine: fakeEngine(), config: CONFIG, random: fixedRandom(r) });
      expect((await bot.chooseMove(START)).uci).toBe("d2d4");
    }
  });

  it("looks up with the configured ratings and speeds", async () => {
    const explorer = fakeExplorer(BOOK);
    const bot = createSparringBot({ explorer, engine: fakeEngine(), config: CONFIG, random: fixedRandom(0) });
    await bot.chooseMove(START);
    expect(explorer.calls).toEqual([
      { fen: START, options: { ratings: [1200, 1400], speeds: ["blitz", "rapid"] } },
    ]);
  });

  it("samples at exactly minGames total games", async () => {
    const engine = fakeEngine();
    const bot = createSparringBot({
      explorer: fakeExplorer(result([mv("e2e4", 20)], 20)),
      engine,
      config: CONFIG,
      random: fixedRandom(0),
    });
    const move = await bot.chooseMove(START);
    expect(move.source).toBe("explorer");
    expect(engine.calls).toEqual([]);
  });

  it("skips an illegal explorer move and resamples among the rest", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(result([mv("e2e5", 90), mv("d2d4", 10)])),
      engine: fakeEngine(),
      config: CONFIG,
      random: fixedRandom(0),
    });
    const move = await bot.chooseMove(START);
    expect(move.uci).toBe("d2d4");
    expect(move.source).toBe("explorer");
  });

  it("recomputes weights over the remaining moves after dropping an illegal one", async () => {
    const moves = [mv("e2e5", 50), mv("d2d4", 25), mv("c2c4", 25)];
    // After the splice the remaining total is 50: 0.6 * 50 = 30 >= 25 -> c2c4,
    // and 0.4 * 50 = 20 < 25 -> d2d4 (a stale total of 100 would give 40 -> c2c4).
    for (const [r, expected] of [
      [0.6, "c2c4"],
      [0.4, "d2d4"],
    ] as const) {
      const bot = createSparringBot({
        explorer: fakeExplorer(result(moves)),
        engine: fakeEngine(),
        config: CONFIG,
        random: fixedRandom(0, r),
      });
      const move = await bot.chooseMove(START);
      expect(move.uci, `second random ${r}`).toBe(expected);
      expect(move.source).toBe("explorer");
    }
  });
});

describe("createSparringBot: castling spelled king-takes-rook (FR-2, FR-10)", () => {
  const CASTLE_W = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  const CASTLE_B = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1";
  /** 1.d4 Nf6 2.Bf4 g6 3.e3 Bg7 4.Nf3 d6 5.Be2: Black to move, O-O legal. */
  const KID_LONDON = "rnbqk2r/ppp1ppbp/3p1np1/8/3P1B2/4PN2/PPP1BPPP/RN1QK2R b KQkq - 1 5";

  it.each([
    ["White O-O", "e1h1", CASTLE_W, "O-O", "e1g1"],
    ["White O-O-O", "e1a1", CASTLE_W, "O-O-O", "e1c1"],
    ["Black O-O", "e8h8", CASTLE_B, "O-O", "e8g8"],
    ["Black O-O-O", "e8a8", CASTLE_B, "O-O-O", "e8c8"],
    ["standard Black O-O", "e8g8", CASTLE_B, "O-O", "e8g8"],
  ])("%s given as %s returns standard UCI", async (_label, uci, fen, san, expected) => {
    const bot = createSparringBot({
      explorer: fakeExplorer(result([{ uci, san, games: 50 }])),
      engine: fakeEngine(),
      config: CONFIG,
      random: fixedRandom(0),
    });
    const move = await bot.chooseMove(fen);
    expect(move.uci).toBe(expected);
    expect(move.san).toBe(san);
    expect(move.source).toBe("explorer");
  });

  it("plays book castling in the reviewer's London vs KID position", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(
        result(
          [
            { uci: "e8h8", san: "O-O", games: 600 },
            { uci: "c7c5", san: "c5", games: 100 },
          ],
          900,
        ),
      ),
      engine: fakeEngine(),
      config: CONFIG,
      random: fixedRandom(0),
    });
    expect(await bot.chooseMove(KID_LONDON)).toEqual({
      uci: "e8g8",
      san: "O-O",
      source: "explorer",
      explorer: { games: 600, totalGames: 900, share: 600 / 900 },
    });
  });

  it("still drops a move whose uci and san are both illegal", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(
        result([
          { uci: "e2e5", san: "e5", games: 90 },
          { uci: "d2d4", san: "d4", games: 10 },
        ]),
      ),
      engine: fakeEngine(),
      config: CONFIG,
      random: fixedRandom(0),
    });
    expect((await bot.chooseMove(START)).uci).toBe("d2d4");
  });
});

describe("createSparringBot: engine fallback (FR-3)", () => {
  it("uses the engine one game below minGames, with the configured elo", async () => {
    const engine = fakeEngine("g1f3");
    const bot = createSparringBot({
      explorer: fakeExplorer(result([mv("e2e4", 19)], 19)),
      engine,
      config: CONFIG,
      random: fixedRandom(0),
    });
    const move = await bot.chooseMove(START);
    expect(move).toEqual({ uci: "g1f3", san: "Nf3", source: "engine", fallbackReason: "few_games" });
    expect(engine.calls).toEqual([{ fen: START, opts: { elo: 1400 } }]);
  });

  it("uses the engine when the explorer is unavailable", async () => {
    const engine = fakeEngine();
    const bot = createSparringBot({
      explorer: fakeExplorer({ moves: [], totalGames: 0, unavailable: "rate_limited" }),
      engine,
      config: CONFIG,
    });
    const move = await bot.chooseMove(START);
    expect(move.source).toBe("engine");
    expect(move.fallbackReason).toBe("unavailable");
    expect(engine.calls).toHaveLength(1);
  });

  it("uses the engine when no listed move has games", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(result([mv("e2e4", 0)], 500)),
      engine: fakeEngine(),
      config: CONFIG,
    });
    const move = await bot.chooseMove(START);
    expect(move.source).toBe("engine");
    expect(move.fallbackReason).toBe("no_moves");
  });

  it("uses the engine when every listed move is illegal", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(result([mv("e2e5", 50), mv("a1a8", 50)])),
      engine: fakeEngine(),
      config: CONFIG,
      random: fixedRandom(0.7),
    });
    const move = await bot.chooseMove(START);
    expect(move.source).toBe("engine");
    expect(move.fallbackReason).toBe("illegal_explorer_move");
  });

  it("uses the engine when the lookup rejects with a generic error", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(() => Promise.reject(new Error("socket hang up"))),
      engine: fakeEngine(),
      config: CONFIG,
    });
    const move = await bot.chooseMove(START);
    expect(move.source).toBe("engine");
    expect(move.fallbackReason).toBe("lookup_failed");
  });

  it("rethrows an ExplorerConfigError without calling the engine", async () => {
    class ExplorerConfigError extends Error {
      override name = "ExplorerConfigError";
    }
    const engine = fakeEngine();
    const bot = createSparringBot({
      explorer: fakeExplorer(() => Promise.reject(new ExplorerConfigError("401 bad token"))),
      engine,
      config: CONFIG,
    });
    await expect(bot.chooseMove(START)).rejects.toThrow("401 bad token");
    expect(engine.calls).toEqual([]);
  });

  it("throws when the engine returns an illegal move", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(result([], 0)),
      engine: fakeEngine("e2e5"),
      config: CONFIG,
    });
    await expect(bot.chooseMove(START)).rejects.toThrow(/e2e5.*rnbqkbnr\/pppppppp/);
  });
});

describe("createSparringBot: guards", () => {
  it.each([
    ["checkmate", MATED],
    ["stalemate", STALEMATE],
  ])("throws on a game-over position (%s) before calling anything", async (_label, fen) => {
    const explorer = fakeExplorer(BOOK);
    const engine = fakeEngine();
    const bot = createSparringBot({ explorer, engine, config: CONFIG });
    await expect(bot.chooseMove(fen)).rejects.toThrow(/game over/i);
    expect(explorer.calls).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it("throws on an invalid FEN before calling anything", async () => {
    const explorer = fakeExplorer(BOOK);
    const engine = fakeEngine();
    const bot = createSparringBot({ explorer, engine, config: CONFIG });
    await expect(bot.chooseMove("not a fen")).rejects.toThrow(/invalid FEN/i);
    expect(explorer.calls).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it.each<[string, Partial<BotConfig>]>([
    ["minGames 0", { minGames: 0 }],
    ["minGames fractional", { minGames: 2.5 }],
    ["outOfBookElo 0", { outOfBookElo: 0 }],
    ["outOfBookElo NaN", { outOfBookElo: Number.NaN }],
    ["no ratings", { explorerRatings: [] }],
    ["no speeds", { explorerSpeeds: [] }],
  ])("rejects bad config: %s", (_label, patch) => {
    expect(() =>
      createSparringBot({ explorer: fakeExplorer(BOOK), engine: fakeEngine(), config: { ...CONFIG, ...patch } }),
    ).toThrow(/config/i);
  });
});

/** Black to move after 1.e4: scores below are White's POV, so Black prefers lower numbers. */
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const OUT_OF_BOOK = result([], 0);

describe("explorerRatingsFor (FR-2, #84)", () => {
  it.each<[number, number[]]>([
    [500, [0]],
    [900, [0]],
    [1000, [0, 1000]],
    [1300, [1000, 1200]],
    [1400, [1200, 1400]],
    [1500, [1200, 1400]],
    [2400, [2000, 2200]],
    [2500, [2200, 2500]],
  ])("strength %i -> %j", (strength, expected) => {
    expect(explorerRatingsFor(strength)).toEqual(expected);
  });

  it.each([450, 1450, 2600, 1400.5, 400, Number.NaN])("throws on invalid strength %s", (strength) => {
    expect(() => explorerRatingsFor(strength)).toThrow(/strength/i);
  });
});

describe("weakeningAt: interpolation between anchors (FR-3, A11)", () => {
  it.each<[number, number, number]>([
    [500, 250, 0.25],
    [700, 200, 0.175],
    [900, 150, 0.1],
    [1100, 105, 0.06],
    [1300, 60, 0.02],
  ])("strength %i -> temperature %d cp, blunder rate %d", (strength, temperatureCp, blunderRate) => {
    const w = weakeningAt(strength, WEAKENING);
    expect(w.temperatureCp).toBeCloseTo(temperatureCp, 9);
    expect(w.blunderRate).toBeCloseTo(blunderRate, 9);
  });

  it("returns anchor values exactly at an anchor", () => {
    expect(weakeningAt(900, WEAKENING)).toEqual({ temperatureCp: 150, blunderRate: 0.1 });
  });

  it("clamps outside the anchors", () => {
    const single: BotWeakeningConfig = { ...WEAKENING, anchors: WEAKENING.anchors.slice(1, 2) };
    expect(weakeningAt(500, single)).toEqual({ temperatureCp: 150, blunderRate: 0.1 });
    expect(weakeningAt(1200, single)).toEqual({ temperatureCp: 150, blunderRate: 0.1 });
    const upper: BotWeakeningConfig = { ...WEAKENING, anchors: WEAKENING.anchors.slice(1) };
    expect(weakeningAt(500, upper)).toEqual({ temperatureCp: 150, blunderRate: 0.1 });
    expect(weakeningAt(1500, WEAKENING)).toEqual({ temperatureCp: 60, blunderRate: 0.02 });
  });
});

describe("createSparringBot: per-game strength (FR-1, FR-2, FR-3, #84)", () => {
  it("with no strength looks up [1200, 1400] and plays elo 1400 out of book, never analyze", async () => {
    const explorer = fakeExplorer(OUT_OF_BOOK);
    const engine = fakeEngine("g1f3");
    const bot = createSparringBot({ explorer, engine, config: CONFIG });
    const move = await bot.chooseMove(START);
    expect(move).toEqual({ uci: "g1f3", san: "Nf3", source: "engine", fallbackReason: "few_games" });
    expect(explorer.calls[0]!.options).toEqual({ ratings: [1200, 1400], speeds: ["blitz", "rapid"] });
    expect(engine.calls).toEqual([{ fen: START, opts: { elo: 1400 } }]);
    expect(engine.analyzeCalls).toEqual([]);
  });

  it("looks up the rating buckets for the strength", async () => {
    for (const [strength, ratings] of [
      [500, [0]],
      [1300, [1000, 1200]],
      [2500, [2200, 2500]],
    ] as const) {
      const explorer = fakeExplorer(BOOK);
      const bot = createSparringBot({ explorer, engine: fakeEngine(), config: CONFIG, random: fixedRandom(0) });
      await bot.chooseMove(START, { strength });
      expect(explorer.calls[0]!.options, `strength ${strength}`).toEqual({ ratings, speeds: ["blitz", "rapid"] });
    }
  });

  it("S=1800 out of book calls bestMove with elo 1800 and never analyze", async () => {
    const engine = fakeEngine("g1f3");
    const bot = createSparringBot({ explorer: fakeExplorer(OUT_OF_BOOK), engine, config: CONFIG });
    const move = await bot.chooseMove(START, { strength: 1800 });
    expect(move.uci).toBe("g1f3");
    expect(move.weakening).toBeUndefined();
    expect(engine.calls).toEqual([{ fen: START, opts: { elo: 1800 } }]);
    expect(engine.analyzeCalls).toEqual([]);
  });

  it("strength is per call: one bot plays 2000 then 600", async () => {
    const engine = fakeEngine("g1f3");
    const bot = createSparringBot({ explorer: fakeExplorer(OUT_OF_BOOK), engine, config: CONFIG, random: fixedRandom(0.9, 0) });
    await bot.chooseMove(START, { strength: 2000 });
    await bot.chooseMove(START, { strength: 600 });
    expect(engine.calls).toEqual([{ fen: START, opts: { elo: 2000 } }]);
    expect(engine.analyzeCalls).toEqual([{ fen: START, opts: { multiPv: 5, depth: 10 } }]);
  });

  it.each([450, 1450, 2600, 1400.5])("rejects invalid strength %s before calling anything", async (strength) => {
    const explorer = fakeExplorer(BOOK);
    const engine = fakeEngine();
    const bot = createSparringBot({ explorer, engine, config: CONFIG });
    await expect(bot.chooseMove(START, { strength })).rejects.toThrow(/strength/i);
    expect(explorer.calls).toEqual([]);
    expect(engine.calls).toEqual([]);
    expect(engine.analyzeCalls).toEqual([]);
  });

  it("below 1320 with no weakening config throws a clear error", async () => {
    const { weakening: _w, ...noWeakening } = CONFIG;
    const explorer = fakeExplorer(OUT_OF_BOOK);
    const engine = fakeEngine();
    const bot = createSparringBot({ explorer, engine, config: noWeakening });
    await expect(bot.chooseMove(START, { strength: 800 })).rejects.toThrow(/weakening/);
    expect(explorer.calls).toEqual([]);
    expect(engine.calls).toEqual([]);
    expect(engine.analyzeCalls).toEqual([]);
    // 1320 and up still works without it.
    expect((await bot.chooseMove(START, { strength: 1400 })).source).toBe("engine");
  });

  it("below 1320 with an engine that cannot analyze throws a clear error", async () => {
    const bot = createSparringBot({
      explorer: fakeExplorer(OUT_OF_BOOK),
      engine: { bestMove: async () => "g1f3" },
      config: CONFIG,
    });
    await expect(bot.chooseMove(START, { strength: 800 })).rejects.toThrow(/analyze/);
  });

  it("below 1320 still plays from the explorer while in book", async () => {
    const engine = fakeEngine();
    const bot = createSparringBot({ explorer: fakeExplorer(BOOK), engine, config: CONFIG, random: fixedRandom(0) });
    const move = await bot.chooseMove(START, { strength: 800 });
    expect(move.source).toBe("explorer");
    expect(engine.calls).toEqual([]);
    expect(engine.analyzeCalls).toEqual([]);
  });
});

describe("createSparringBot: weakening below 1320 (FR-3 as amended by A11, FR-10)", () => {
  /** White to move at the start; White POV scores, so higher is better for the mover. */
  const LINES: BotAnalysis = {
    bestMove: "e2e4",
    lines: [
      { moves: ["e2e4", "e7e5"], score: cp(40) },
      { moves: ["d2d4"], score: cp(30) },
      { moves: ["g1f3"], score: cp(-60) },
      { moves: ["a2a3"], score: cp(-200) },
      { moves: ["g2g4"], score: cp(-300) },
    ],
  };

  function weakBot(analysis: BotAnalysis, random: () => number, config: BotConfig = CONFIG) {
    const engine = fakeEngine("h2h3", analysis);
    const bot = createSparringBot({ explorer: fakeExplorer(OUT_OF_BOOK), engine, config, random });
    return { engine, bot };
  }

  it("S=800 calls analyze with multiPv 5 depth 10 at full strength and never bestMove", async () => {
    const { engine, bot } = weakBot(LINES, fixedRandom(0.99, 0));
    const move = await bot.chooseMove(START, { strength: 800 });
    expect(engine.analyzeCalls).toEqual([{ fen: START, opts: { multiPv: 5, depth: 10 } }]);
    expect(engine.calls).toEqual([]);
    expect(move.source).toBe("engine");
    expect(move.fallbackReason).toBe("few_games");
    expect(move.uci).toBe("e2e4");
  });

  it("forced blunder plays a line losing >= 200 cp, uniform among them", async () => {
    // Strength 500: blunder rate 0.25. First random < 0.25 -> blunder; losses 240 (a2a3) and 340 (g2g4).
    const cases: [number, string, number][] = [
      [0, "a2a3", 240],
      [0.49, "a2a3", 240],
      [0.5, "g2g4", 340],
      [0.99, "g2g4", 340],
    ];
    for (const [r, uci, lossCp] of cases) {
      const { bot } = weakBot(LINES, fixedRandom(0.1, r));
      const move = await bot.chooseMove(START, { strength: 500 });
      expect(move.uci, `second random ${r}`).toBe(uci);
      expect(move.weakening).toEqual({ lossCp, blunder: true, candidates: 5, temperatureCp: 250, blunderRate: 0.25 });
    }
  });

  it("no blunder when the first random is at or above the blunder rate", async () => {
    // 0.25 is not < 0.25; second random 0 -> the best line by temperature sampling.
    const { bot } = weakBot(LINES, fixedRandom(0.25, 0));
    const move = await bot.chooseMove(START, { strength: 500 });
    expect(move.uci).toBe("e2e4");
    expect(move.weakening).toMatchObject({ lossCp: 0, blunder: false });
  });

  it("forced blunder with no line losing >= 200 cp falls back to temperature sampling", async () => {
    const mild: BotAnalysis = {
      bestMove: "e2e4",
      lines: [
        { moves: ["e2e4"], score: cp(40) },
        { moves: ["d2d4"], score: cp(30) },
      ],
    };
    // Weights exp(0) = 1 and exp(-10/250); second random 0 -> first line, 0.99 -> second.
    const { bot } = weakBot(mild, fixedRandom(0, 0));
    const move = await bot.chooseMove(START, { strength: 500 });
    expect(move.uci).toBe("e2e4");
    expect(move.weakening).toMatchObject({ lossCp: 0, blunder: false, candidates: 2 });
    const { bot: bot2 } = weakBot(mild, fixedRandom(0, 0.99));
    const second = await bot2.chooseMove(START, { strength: 500 });
    expect(second.uci).toBe("d2d4");
    expect(second.weakening).toMatchObject({ lossCp: 10, blunder: false, candidates: 2 });
  });

  it("temperature sampling picks the line from the cumulative exp(-loss / T) weights", async () => {
    // Strength 900: T = 150, blunder rate 0.1. First random 0.5 -> no blunder.
    const losses = [0, 10, 100, 240, 340];
    const weights = losses.map((l) => Math.exp(-l / 150));
    const total = weights.reduce((a, b) => a + b, 0);
    const cumulative = weights.map((_, i) => weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / total);
    const ucis = ["e2e4", "d2d4", "g1f3", "a2a3", "g2g4"];
    for (let i = 0; i < ucis.length; i++) {
      const lower = i === 0 ? 0 : cumulative[i - 1]!;
      for (const r of [lower + 1e-9, cumulative[i]! - 1e-9]) {
        const { bot } = weakBot(LINES, fixedRandom(0.5, r));
        const move = await bot.chooseMove(START, { strength: 900 });
        expect(move.uci, `random ${r}`).toBe(ucis[i]);
        expect(move.weakening).toEqual({
          lossCp: losses[i],
          blunder: false,
          candidates: 5,
          temperatureCp: 150,
          blunderRate: 0.1,
        });
      }
    }
  });

  it("computes loss from the mover's point of view (Black to move)", async () => {
    // White POV: Black's best is -50; d7d5 at +150 loses 200 cp for Black.
    const black: BotAnalysis = {
      bestMove: "c7c5",
      lines: [
        { moves: ["c7c5"], score: cp(-50) },
        { moves: ["d7d5"], score: cp(150) },
      ],
    };
    const { bot } = weakBot(black, fixedRandom(0, 0));
    const move = await bot.chooseMove(AFTER_E4, { strength: 500 });
    expect(move.uci).toBe("d7d5");
    expect(move.weakening).toMatchObject({ lossCp: 200, blunder: true, candidates: 2 });
  });

  it("handles mate scores: missing a mate is a blunder; a mate line is best", async () => {
    const mates: BotAnalysis = {
      bestMove: "e2e4",
      lines: [
        { moves: ["e2e4"], score: mate(3) },
        { moves: ["d2d4"], score: cp(500) },
        { moves: ["a2a3"], score: mate(-2) },
      ],
    };
    // No blunder: the ~99k-cp losses weigh ~0 at T = 250, so even random 0.999999 picks the mate.
    const { bot } = weakBot(mates, fixedRandom(0.9, 0.999999));
    const move = await bot.chooseMove(START, { strength: 500 });
    expect(move.uci).toBe("e2e4");
    expect(move.weakening).toMatchObject({ lossCp: 0, blunder: false });
    // Blunder forced: both other lines lose >= 200; the losses are finite numbers.
    const { bot: bot2 } = weakBot(mates, fixedRandom(0, 0.99));
    const blunder = await bot2.chooseMove(START, { strength: 500 });
    expect(blunder.uci).toBe("a2a3");
    expect(blunder.weakening!.blunder).toBe(true);
    expect(Number.isFinite(blunder.weakening!.lossCp)).toBe(true);
    expect(blunder.weakening!.lossCp).toBeGreaterThan(100000);
  });

  it("drops illegal and empty lines before sampling", async () => {
    const dirty: BotAnalysis = {
      bestMove: "e2e4",
      lines: [
        { moves: ["e2e4"], score: cp(40) },
        { moves: [], score: cp(30) },
        { moves: ["e2e5"], score: cp(-500) },
        { moves: ["g1f3"], score: cp(-300) },
      ],
    };
    // Forced blunder: only g1f3 (loss 340) is a legal blunder line.
    for (const r of [0, 0.5, 0.99]) {
      const { bot } = weakBot(dirty, fixedRandom(0, r));
      const move = await bot.chooseMove(START, { strength: 500 });
      expect(move.uci).toBe("g1f3");
      expect(move.san).toBe("Nf3");
      expect(move.weakening).toMatchObject({ lossCp: 340, blunder: true, candidates: 2 });
    }
  });

  it("measures loss from the best legal line when line 1 is illegal", async () => {
    const dirty: BotAnalysis = {
      bestMove: "d2d4",
      lines: [
        { moves: ["e2e5"], score: cp(90) },
        { moves: ["d2d4"], score: cp(30) },
        { moves: ["g1f3"], score: cp(-200) },
      ],
    };
    const { bot } = weakBot(dirty, fixedRandom(0, 0));
    const move = await bot.chooseMove(START, { strength: 500 });
    expect(move.uci).toBe("g1f3");
    expect(move.weakening).toMatchObject({ lossCp: 230, blunder: true, candidates: 2 });
  });

  it("falls back to analysis.bestMove when no line is legal", async () => {
    const none: BotAnalysis = {
      bestMove: "d2d4",
      lines: [
        { moves: ["e2e5"], score: cp(0) },
        { moves: [], score: cp(0) },
      ],
    };
    const { bot } = weakBot(none, fixedRandom(0, 0));
    const move = await bot.chooseMove(START, { strength: 500 });
    expect(move.uci).toBe("d2d4");
    expect(move.source).toBe("engine");
    expect(move.weakening).toEqual({ lossCp: 0, blunder: false, candidates: 0, temperatureCp: 250, blunderRate: 0.25 });
  });

  it("throws when no line is legal and analysis.bestMove is illegal too", async () => {
    const none: BotAnalysis = { bestMove: "e2e5", lines: [] };
    const { bot } = weakBot(none, fixedRandom(0, 0));
    await expect(bot.chooseMove(START, { strength: 500 })).rejects.toThrow(/e2e5.*rnbqkbnr\/pppppppp/);
  });

  it("at 1300 blunders about 2% of the time and always plays a listed line", async () => {
    const { bot } = weakBot(LINES, mulberry32(7));
    const listed = new Set(LINES.lines.map((l) => l.moves[0]));
    let blunders = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const move = await bot.chooseMove(START, { strength: 1300 });
      expect(listed.has(move.uci)).toBe(true);
      if (move.weakening!.blunder) blunders++;
    }
    expect(blunders / n).toBeGreaterThan(0.005);
    expect(blunders / n).toBeLessThan(0.04);
  });
});

describe("createSparringBot: weakening config validation", () => {
  it.each<[string, Partial<BotWeakeningConfig>]>([
    ["no anchors", { anchors: [] }],
    [
      "unsorted anchors",
      {
        anchors: [
          { strength: 900, temperatureCp: 150, blunderRate: 0.1 },
          { strength: 500, temperatureCp: 250, blunderRate: 0.25 },
        ],
      },
    ],
    [
      "duplicate anchor strength",
      {
        anchors: [
          { strength: 900, temperatureCp: 150, blunderRate: 0.1 },
          { strength: 900, temperatureCp: 100, blunderRate: 0.05 },
        ],
      },
    ],
    ["temperature 0", { anchors: [{ strength: 500, temperatureCp: 0, blunderRate: 0.1 }] }],
    ["blunder rate above 1", { anchors: [{ strength: 500, temperatureCp: 100, blunderRate: 1.5 }] }],
    ["blunder rate negative", { anchors: [{ strength: 500, temperatureCp: 100, blunderRate: -0.1 }] }],
    ["multiPv 0", { multiPv: 0 }],
    ["depth 0", { depth: 0 }],
    ["blunderMinLossCp NaN", { blunderMinLossCp: Number.NaN }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      createSparringBot({
        explorer: fakeExplorer(BOOK),
        engine: fakeEngine(),
        config: { ...CONFIG, weakening: { ...WEAKENING, ...patch } },
      }),
    ).toThrow(/weakening/);
  });

  it("accepts the config/tutor.json bot block as committed", async () => {
    const { readFileSync } = await import("node:fs");
    const json = JSON.parse(readFileSync(new URL("../../../config/tutor.json", import.meta.url), "utf8")) as {
      bot: BotConfig;
    };
    expect(json.bot.weakening).toEqual(WEAKENING);
    expect(() => createSparringBot({ explorer: fakeExplorer(BOOK), engine: fakeEngine(), config: json.bot })).not.toThrow();
  });
});
