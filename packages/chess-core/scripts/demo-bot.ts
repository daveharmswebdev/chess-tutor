/**
 * Terminal demo of the sparring bot (FR-1, FR-2, FR-3, issue #5).
 *
 *   pnpm demo:bot [-- --as white|black] [-- --moves N] [-- --strength S]
 *
 * S is the bot's strength, 500 to 2500 in steps of 100 (default 1400, #84).
 *
 * The human side is scripted (London as White, King's Indian as Black, then
 * full-strength Stockfish once the script runs out); the bot plays the other
 * side using the real Lichess explorer and WASM (or native) Stockfish.
 * Needs LICHESS_TOKEN in the environment (.env is loaded by the npm script).
 */
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
import { createEngineFromEnv } from "@chess-tutor/engine";
import { createExplorerClient, createSqliteExplorerCache } from "@chess-tutor/explorer";
import {
  BOT_STRENGTH,
  assertBotStrength,
  createSparringBot,
  explorerRatingsFor,
  type BotConfig,
  type BotMove,
} from "../src/index.ts";
import { playUci } from "../src/moves.ts";

const LONDON = ["d2d4", "c1f4", "e2e3", "g1f3", "c2c3", "f1d3", "b1d2", "e1g1"];
const KID = ["g8f6", "g7g6", "f8g7", "d7d6", "e8g8", "e7e5", "b8d7", "c7c6"];

function usage(message: string): never {
  console.error(`${message}\nUsage: pnpm demo:bot [-- --as white|black] [-- --moves N] [-- --strength S]`);
  process.exit(2);
}

function parseArgs(argv: string[]): { as: "white" | "black"; moves: number; strength: number } {
  const args = argv.filter((a) => a !== "--");
  let as: "white" | "black" = "white";
  let moves = 10;
  let strength: number = BOT_STRENGTH.default;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--as") {
      if (value !== "white" && value !== "black") usage(`--as must be white or black (got ${value})`);
      as = value;
      i++;
    } else if (flag === "--moves") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) usage(`--moves must be a positive integer (got ${value})`);
      moves = n;
      i++;
    } else if (flag === "--strength") {
      const n = Number(value);
      try {
        assertBotStrength(n);
      } catch (err) {
        usage(err instanceof Error ? err.message : String(err));
      }
      strength = n;
      i++;
    } else {
      usage(`unknown argument ${flag}`);
    }
  }
  return { as, moves, strength };
}

function loadBotConfig(): BotConfig {
  const path = new URL("../../../config/tutor.json", import.meta.url);
  const json = JSON.parse(readFileSync(path, "utf8")) as { bot?: BotConfig };
  if (!json.bot) throw new Error(`no "bot" block in ${path.pathname}`);
  return json.bot;
}

function describeBotMove(move: BotMove, strength: number): string {
  if (move.source === "explorer" && move.explorer) {
    const { games, totalGames, share } = move.explorer;
    return `from explorer (${games} of ${totalGames} games, ${(share * 100).toFixed(1)}% of players)`;
  }
  const reason = move.fallbackReason ?? "out of book";
  if (move.weakening) {
    const w = move.weakening;
    const kind = w.blunder ? "blunder" : "sampled";
    return `from engine (weakened ~${strength}: ${kind}, loses ${w.lossCp} cp, ${w.candidates} lines) - ${reason}`;
  }
  return `from engine (UCI_Elo ${strength}) - ${reason}`;
}

async function main(): Promise<number> {
  const { as, moves: fullMoves, strength } = parseArgs(process.argv.slice(2));

  const token = process.env.LICHESS_TOKEN;
  if (!token) {
    console.error(
      "LICHESS_TOKEN is not set. Create a personal token at https://lichess.org/account/oauth/token " +
        "(no scopes needed) and add LICHESS_TOKEN=<token> to the .env file at the repository root, " +
        "or export it in your shell.",
    );
    return 1;
  }

  const config = loadBotConfig();
  // Everything that holds a resource is created inside the try, so a bad
  // config (thrown by createSparringBot) still quits the engine and closes the cache.
  let cache: ReturnType<typeof createSqliteExplorerCache> | undefined;
  let engine: ReturnType<typeof createEngineFromEnv> | undefined;
  try {
    cache = createSqliteExplorerCache(":memory:");
    const explorer = createExplorerClient({ token, cache });
    engine = createEngineFromEnv();
    const bot = createSparringBot({ explorer, engine, config });

    const chess = new Chess();
    const humanColor = as === "white" ? "w" : "b";
    const script = [...(as === "white" ? LONDON : KID)];

    console.log(`You (scripted) play ${as}; the bot plays ${as === "white" ? "black" : "white"}.`);
    console.log(
      `Bot (strength ${strength}): explorer ratings ${explorerRatingsFor(strength).join("/")}, ` +
        `speeds ${config.explorerSpeeds.join("/")}, min ${config.minGames} games, then ` +
        (strength < BOT_STRENGTH.uciEloMin
          ? "weakened full-strength engine lines.\n"
          : `engine at UCI_Elo ${strength}.\n`),
    );

    for (let ply = 0; ply < fullMoves * 2 && !chess.isGameOver(); ply++) {
      const fen = chess.fen();
      const moveNo = chess.moveNumber();
      const prefix = chess.turn() === "w" ? `${moveNo}.` : `${moveNo}...`;

      if (chess.turn() === humanColor) {
        let label = "you (script)";
        let played = false;
        while (script.length > 0 && !played) {
          const uci = script.shift()!;
          try {
            const move = playUci(chess, uci);
            console.log(`${prefix.padEnd(5)} ${move.san.padEnd(7)} ${label}`);
            played = true;
          } catch {
            // Not legal here; skip to the next scripted move.
          }
        }
        if (!played) {
          label = "you (engine, full strength)";
          const uci = await engine.bestMove(fen);
          const move = playUci(chess, uci);
          console.log(`${prefix.padEnd(5)} ${move.san.padEnd(7)} ${label}`);
        }
      } else {
        const botMove = await bot.chooseMove(fen, { strength });
        playUci(chess, botMove.uci);
        console.log(`${prefix.padEnd(5)} ${botMove.san.padEnd(7)} bot ${describeBotMove(botMove, strength)}`);
      }
    }
    console.log(`\nFinal position: ${chess.fen()}`);
    console.log(`PGN: ${chess.pgn()}`);
    return 0;
  } finally {
    await engine?.quit();
    cache?.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
