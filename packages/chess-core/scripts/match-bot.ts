/**
 * Rough strength check for the sparring bot (#84, FR-3 as amended by A11).
 *
 *   pnpm match:bot [-- --strength S] [-- --games N] [-- --opponent-elo E] [-- --max-plies P]
 *
 * Plays N games between the bot at strength S and Stockfish at UCI_Elo E (default 1320, the
 * lowest Stockfish supports), alternating colours. The bot runs engine-only (an explorer stub
 * that is always "unavailable"), so no LICHESS_TOKEN or network is needed and the result
 * measures the out-of-book play, which is what the weakening controls. It loads no .env.
 * Uses the real engine
 * (WASM, or native through STOCKFISH_PATH), one process, searches queued. Not run in tests.
 * A game still going after P plies (default 300) is scored as a draw.
 */
import { Chess } from "chess.js";
import { createEngineFromEnv } from "@chess-tutor/engine";
import { readFileSync } from "node:fs";
import { assertBotStrength, createSparringBot, type BotConfig, type BotExplorer } from "../src/index.ts";
import { playUci } from "../src/moves.ts";

interface Args {
  strength: number;
  games: number;
  opponentElo: number;
  maxPlies: number;
}

function usage(message: string): never {
  console.error(
    `${message}\nUsage: pnpm match:bot [-- --strength S] [-- --games N] [-- --opponent-elo E] [-- --max-plies P]`,
  );
  process.exit(2);
}

function positiveInt(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) usage(`${flag} must be a positive integer (got ${value})`);
  return n;
}

function parseArgs(argv: string[]): Args {
  const args = argv.filter((a) => a !== "--");
  const out: Args = { strength: 800, games: 10, opponentElo: 1320, maxPlies: 300 };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--strength") {
      const n = Number(value);
      try {
        assertBotStrength(n);
      } catch (err) {
        usage(err instanceof Error ? err.message : String(err));
      }
      out.strength = n;
    } else if (flag === "--games") out.games = positiveInt(flag, value);
    else if (flag === "--opponent-elo") out.opponentElo = positiveInt(flag, value);
    else if (flag === "--max-plies") out.maxPlies = positiveInt(flag, value);
    else usage(`unknown argument ${flag}`);
  }
  return out;
}

function loadBotConfig(): BotConfig {
  const path = new URL("../../../config/tutor.json", import.meta.url);
  const json = JSON.parse(readFileSync(path, "utf8")) as { bot?: BotConfig };
  if (!json.bot) throw new Error(`no "bot" block in ${path.pathname}`);
  return json.bot;
}

const offlineExplorer: BotExplorer = {
  lookup: async () => ({ moves: [], totalGames: 0, unavailable: "offline_match" }),
};

async function main(): Promise<number> {
  const { strength, games, opponentElo, maxPlies } = parseArgs(process.argv.slice(2));
  const engine = createEngineFromEnv();
  try {
    const bot = createSparringBot({ explorer: offlineExplorer, engine, config: loadBotConfig() });
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let botMoves = 0;
    let blunders = 0;
    let lossSum = 0;

    console.log(`Bot strength ${strength} vs Stockfish UCI_Elo ${opponentElo}, ${games} games.\n`);
    for (let g = 0; g < games; g++) {
      const botColor = g % 2 === 0 ? "w" : "b";
      const chess = new Chess();
      while (!chess.isGameOver() && chess.history().length < maxPlies) {
        const fen = chess.fen();
        if (chess.turn() === botColor) {
          const move = await bot.chooseMove(fen, { strength });
          playUci(chess, move.uci);
          botMoves++;
          if (move.weakening) {
            lossSum += Math.min(move.weakening.lossCp, 1000);
            if (move.weakening.blunder) blunders++;
          }
        } else {
          playUci(chess, await engine.bestMove(fen, { elo: opponentElo }));
        }
      }
      let outcome: "win" | "draw" | "loss" = "draw";
      if (chess.isCheckmate()) outcome = chess.turn() === botColor ? "loss" : "win";
      if (outcome === "win") wins++;
      else if (outcome === "loss") losses++;
      else draws++;
      const plies = chess.history().length;
      console.log(`game ${g + 1}: bot ${botColor === "w" ? "White" : "Black"}, ${outcome}, ${plies} plies`);
    }

    const score = (wins + draws / 2) / games;
    console.log(`\nBot: +${wins} =${draws} -${losses}, score ${(score * 100).toFixed(1)}%`);
    if (blunders > 0 || lossSum > 0) {
      console.log(
        `Weakened moves: ${botMoves}, blunders ${blunders} (${((blunders / botMoves) * 100).toFixed(1)}%), ` +
          `mean loss ${(lossSum / botMoves).toFixed(0)} cp (each move capped at 1000)`,
      );
    }
    return 0;
  } finally {
    await engine.quit();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
