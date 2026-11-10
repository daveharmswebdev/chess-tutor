/**
 * Game server entry point (#6, #7). Wires the real pieces into buildServer:
 * repertoire files (checked at startup), config/tutor.json, Stockfish (WASM, or native via
 * STOCKFISH_PATH), the Lichess explorer (or engine-only without LICHESS_TOKEN), SQLite, and
 * coaching: key-moment detection plus the tutor (Claude) when ANTHROPIC_API_KEY is set.
 *
 * Env: PORT (default 3001), DB_PATH (default <repo>/data/chess-tutor.sqlite, ":memory:" ok),
 * LICHESS_TOKEN (empty => engine-only bot), REPERTOIRE_DIR (default <repo>/repertoire),
 * HOST (default localhost: IPv4 and IPv6 loopback), LOG_LEVEL (default info).
 *
 * Coaching (#7, NFR-9):
 *   ANTHROPIC_API_KEY  unset or empty => coaching off ("Coaching is off: no API key is set."), the
 *                      game still works. Read by the Anthropic SDK; never logged.
 *   APP_ENV            default "development": picks the tutor model in config/models.json.
 *   TUTOR_PROMPT_PATH  default <repo>/prompts/tutor-system.v2.md; a missing file turns coaching
 *                      off with a reason, never a crash.
 * Detection, attempt grading, the bot and the tutor's tools share the one Stockfish process
 * (one search at a time, queued). The server's analysis waits for the bot's search, and the
 * tutor's tool calls go through a per-game wrapper that submits one search at a time, after
 * the bot's (see games.ts), so at most one tutor search can be ahead of the bot (NFR-3).
 */
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createSparringBot } from "@chess-tutor/chess-core";
import { createEngineFromEnv, type StockfishEngine } from "@chess-tutor/engine";
import { buildServer } from "./app.ts";
import {
  loadAnalysisSettings,
  loadAttemptToleranceCp,
  loadBotConfig,
  loadEngineThreads,
  loadKeyMomentThresholds,
  loadTutorConfig,
} from "./config.ts";
import { createBotExplorer, type BotExplorerSetup } from "./explorer-env.ts";
import { createShutdown } from "./shutdown.ts";
import { defaultRepertoireFiles, loadRepertoire, RepertoireLoadError } from "./repertoire.ts";
import { createSqliteGameStore, resolveDbPath, type GameStore } from "./store.ts";
import { NO_KEY_REASON, setupTutor, type TutorSetup } from "./tutor-setup.ts";

export const DEFAULT_PORT = 3001;
export const DEFAULT_PROMPT_PATH = fileURLToPath(new URL("../../../prompts/tutor-system.v2.md", import.meta.url));

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
  const botConfig = loadBotConfig();
  const analysis = loadAnalysisSettings();
  const thresholds = loadKeyMomentThresholds();
  const attemptToleranceCp = loadAttemptToleranceCp();

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

    const sharedEngine = engine;
    const analyzer = {
      analyze: (fen: string) =>
        sharedEngine.analyze(fen, { depth: analysis.depth, movetimeMs: analysis.movetimeCapMs, multiPv: analysis.multiPv }),
    };
    const tutor = tutorFromEnv(env, { explorer, repertoire, warn: (m) => warnings.push(m) });

    const { app } = buildServer({
      bot,
      store,
      // engine: tool calls go through a per-game wrapper that yields to the bot (NFR-3).
      coaching: { analyzer, engine, ...tutor, thresholds, attemptToleranceCp, repertoire },
      logger: { level: env["LOG_LEVEL"] || "info" },
    });
    for (const w of warnings) app.log.warn(w);
    if (tutor.offReason) app.log.warn(tutor.offReason);

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
    app.log.info({ dbPath, engineOnly: explorer.engineOnly, coaching: tutor.tutor !== null }, "game server ready");
  } catch (err) {
    await engine?.quit();
    explorer?.close();
    store?.close();
    throw err;
  }
}

/** The tutor from the environment. Never throws: any problem turns coaching off with a reason. */
function tutorFromEnv(
  env: NodeJS.ProcessEnv,
  deps: {
    explorer: BotExplorerSetup;
    repertoire: ReturnType<typeof loadRepertoire>;
    warn: (message: string) => void;
  },
): TutorSetup {
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") return { tutor: null, offReason: NO_KEY_REASON };
  try {
    return setupTutor({
      apiKey,
      promptPath: env["TUTOR_PROMPT_PATH"] || DEFAULT_PROMPT_PATH,
      makeClient: () => new Anthropic(),
      explorer: deps.explorer.tutorExplorer,
      repertoire: deps.repertoire,
      config: loadTutorConfig(env["APP_ENV"] || "development"),
    });
  } catch (err) {
    deps.warn(`tutor settings: ${err instanceof Error ? err.message : String(err)}`);
    return { tutor: null, offReason: "Coaching is off: the tutor settings could not be read." };
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
