import { describe, expect, it } from "vitest";
import {
  createSparringBot,
  type BotConfig,
  type BotEngine,
  type BotExplorer,
  type BotExplorerMove,
  type BotExplorerResult,
  type BotLookupOptions,
} from "../src/index.ts";
import { START } from "./fixtures.ts";

const CONFIG: BotConfig = {
  explorerRatings: [1200, 1400],
  explorerSpeeds: ["blitz", "rapid"],
  minGames: 20,
  outOfBookElo: 1400,
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

function fakeEngine(move = "g1f3"): BotEngine & { calls: { fen: string; opts: unknown }[] } {
  const calls: { fen: string; opts: unknown }[] = [];
  return {
    calls,
    bestMove(fen, opts) {
      calls.push({ fen, opts });
      return Promise.resolve(move);
    },
  };
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
