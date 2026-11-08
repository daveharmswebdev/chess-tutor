import { afterAll, describe, expect, it } from "vitest";
import { createSparringBot } from "@chess-tutor/chess-core";
import { createWasmEngine } from "@chess-tutor/engine";
import { buildServer } from "../src/app.ts";
import { createBotExplorer } from "../src/explorer-env.ts";
import { loadAnalysisSettings, loadBotConfig } from "../src/config.ts";
import { createSqliteGameStore } from "../src/store.ts";
import { createFakeTutor, eventCollector, okOutcome } from "./helpers.ts";

// NFR-3: real WASM Stockfish behind the sparring bot, engine-only (no token, no network).
describe("bot latency with real WASM Stockfish (integration)", () => {
  const engine = createWasmEngine({ threads: 2 });
  const explorer = createBotExplorer({ token: "", dbPath: ":memory:", warn: () => {} });
  const store = createSqliteGameStore(":memory:");
  const bot = createSparringBot({ explorer: explorer.explorer, engine, config: loadBotConfig() });
  const { app, games } = buildServer({ bot, store, logger: false });

  afterAll(async () => {
    await app.close();
    await engine.quit();
    explorer.close();
    store.close();
  });

  it("replies to the player's moves in under 2000 ms, cold engine included", async () => {
    const created = await app.inject({ method: "POST", url: "/api/games", payload: { playerColor: "w" } });
    const id = created.json().id as string;
    const events = eventCollector();
    games.subscribe(id, events.push);

    const latencies: number[] = [];
    for (const [i, uci] of ["d2d4", "c1f4"].entries()) {
      const t0 = performance.now();
      const res = await app.inject({ method: "POST", url: `/api/games/${id}/moves`, payload: { uci } });
      expect(res.statusCode, res.body).toBe(200);
      const ev = await events.next("bot_move", i, 5000);
      latencies.push(performance.now() - t0);
      expect(ev.type === "bot_move" && ev.move.by).toBe("bot");
    }
    console.info(`bot reply latencies (ms): ${latencies.map(Math.round).join(", ")}`);
    for (const ms of latencies) expect(ms).toBeLessThan(2000);
  }, 30_000);

  // #7: with coaching on, detection analysis shares the one engine; the bot still answers in time.
  it("with key-moment analysis on the same engine, the bot still replies in under 2000 ms", async () => {
    const settings = loadAnalysisSettings();
    const tutor = createFakeTutor();
    tutor.auto = () => okOutcome();
    const coached = buildServer({
      bot,
      store,
      logger: false,
      coaching: {
        analyzer: {
          analyze: (fen) =>
            engine.analyze(fen, { depth: settings.depth, movetimeMs: settings.movetimeCapMs, multiPv: settings.multiPv }),
        },
        tutor,
      },
    });
    try {
      const created = await coached.app.inject({ method: "POST", url: "/api/games", payload: { playerColor: "w" } });
      const id = created.json().id as string;
      const events = eventCollector();
      coached.games.subscribe(id, events.push);
      const latencies: number[] = [];
      for (const [i, uci] of ["d2d4", "c1f4", "e2e3"].entries()) {
        await coached.games.idle(id); // the previous detection finished, as when a player thinks
        const t0 = performance.now();
        const res = await coached.app.inject({ method: "POST", url: `/api/games/${id}/moves`, payload: { uci } });
        expect(res.statusCode, res.body).toBe(200);
        await events.next("bot_move", i, 5000);
        latencies.push(performance.now() - t0);
      }
      console.info(`bot reply latencies with coaching (ms): ${latencies.map(Math.round).join(", ")}`);
      for (const ms of latencies) expect(ms).toBeLessThan(2000);
    } finally {
      await coached.app.close();
    }
  }, 30_000);
});
