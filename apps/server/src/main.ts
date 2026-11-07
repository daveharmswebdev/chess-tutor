/**
 * Game server entry point (#6). Wires the real pieces into buildServer:
 * repertoire files (checked at startup), config/tutor.json, Stockfish (WASM, or native via
 * STOCKFISH_PATH), the Lichess explorer (or engine-only without LICHESS_TOKEN) and SQLite.
 *
 * Env: PORT (default 3001), DB_PATH (default <repo>/data/chess-tutor.sqlite, ":memory:" ok),
 * LICHESS_TOKEN (empty => engine-only bot), REPERTOIRE_DIR (default <repo>/repertoire),
 * HOST (default localhost: IPv4 and IPv6 loopback), LOG_LEVEL (default info).
 */
import { createSparringBot } from "@chess-tutor/chess-core";
import { createEngineFromEnv, type StockfishEngine } from "@chess-tutor/engine";
import { buildServer } from "./app.ts";
import { loadBotConfig, loadEngineThreads } from "./config.ts";
import { createBotExplorer, type BotExplorerSetup } from "./explorer-env.ts";
import { createShutdown } from "./shutdown.ts";
import { defaultRepertoireFiles, loadRepertoire, RepertoireLoadError } from "./repertoire.ts";
import { createSqliteGameStore, resolveDbPath, type GameStore } from "./store.ts";

export const DEFAULT_PORT = 3001;

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be 0-65535 (got "${value}")`);
  return port;
}

async function main(): Promise<void> {
  const env = process.env;
  const port = parsePort(env["PORT"]);

  // Repertoire first: a missing or broken file stops the server before anything starts.
  const repertoireDir = env["REPERTOIRE_DIR"];
  const repertoire = loadRepertoire(defaultRepertoireFiles(repertoireDir || undefined));
  void repertoire; // kept loaded for FR-6a/FR-19 (the tutor, #7)
  const botConfig = loadBotConfig();

  const dbPath = resolveDbPath(env);
  let store: GameStore | undefined;
  let explorer: BotExplorerSetup | undefined;
  let engine: StockfishEngine | undefined;
  try {
    store = createSqliteGameStore(dbPath);
    const threads = loadEngineThreads();
    engine = createEngineFromEnv(threads === undefined ? {} : { threads });
    const warnings: string[] = [];
    explorer = createBotExplorer({ token: env["LICHESS_TOKEN"], dbPath, warn: (m) => warnings.push(m) });
    const bot = createSparringBot({ explorer: explorer.explorer, engine, config: botConfig });

    const { app } = buildServer({ bot, store, logger: { level: env["LOG_LEVEL"] || "info" } });
    for (const w of warnings) app.log.warn(w);

    const [liveEngine, liveExplorer, liveStore] = [engine, explorer, store];
    const shutdown = createShutdown({
      app,
      resources: [
        { name: "engine", close: () => liveEngine.quit() },
        { name: "explorer cache", close: () => liveExplorer.close() },
        { name: "game store", close: () => liveStore.close() },
      ],
      log: app.log,
      exit: (code) => process.exit(code),
    });
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    await app.listen({ port, host: env["HOST"] || "localhost" });
    app.log.info({ dbPath, engineOnly: explorer.engineOnly }, "game server ready");
  } catch (err) {
    await engine?.quit();
    explorer?.close();
    store?.close();
    throw err;
  }
}

main().catch((err: unknown) => {
  if (err instanceof RepertoireLoadError) {
    console.error(`Cannot start the server: ${err.message}`);
  } else {
    console.error("Cannot start the server:", err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
