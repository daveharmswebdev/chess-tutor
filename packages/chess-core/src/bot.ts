import { Chess } from "chess.js";
import { playUci } from "./moves.ts";

/*
 * Sparring bot (FR-1, FR-2, FR-3, architecture §3.3).
 *
 * Pure: the explorer and engine are injected. The interfaces below are
 * structural subsets of @chess-tutor/explorer and @chess-tutor/engine, so the
 * real clients satisfy them without chess-core depending on those packages.
 */

/** Subset of @chess-tutor/explorer ExplorerMove that the bot reads. */
export interface BotExplorerMove {
  uci: string;
  san: string;
  games: number;
}

/** Subset of @chess-tutor/explorer ExplorerResult that the bot reads. */
export interface BotExplorerResult {
  /** Top moves only, so the sum of games may be below totalGames. */
  moves: BotExplorerMove[];
  totalGames: number;
  /** Set when Lichess could not be reached; then moves is [] and totalGames 0. */
  unavailable?: string;
}

export interface BotLookupOptions {
  ratings: number[];
  speeds: string[];
}

export interface BotExplorer {
  lookup(fen: string, options: BotLookupOptions): Promise<BotExplorerResult>;
}

export interface BotEngine {
  bestMove(fen: string, opts?: { elo?: number }): Promise<string>;
}

/** The `bot` block of config/tutor.json. */
export interface BotConfig {
  explorerRatings: number[];
  explorerSpeeds: string[];
  /** Positions with fewer explorer games than this are out of book. */
  minGames: number;
  /** Engine strength (UCI_Elo) once out of book. */
  outOfBookElo: number;
}

export type BotFallbackReason =
  | "unavailable"
  | "few_games"
  | "no_moves"
  | "lookup_failed"
  | "illegal_explorer_move";

export interface BotMove {
  uci: string;
  san: string;
  source: "explorer" | "engine";
  /** Present when source is "explorer". share = games / totalGames. */
  explorer?: { games: number; totalGames: number; share: number };
  /** Present when source is "engine": why the explorer was not used. */
  fallbackReason?: BotFallbackReason;
}

export interface SparringBot {
  chooseMove(fen: string): Promise<BotMove>;
}

export interface SparringBotOptions {
  explorer: BotExplorer;
  engine: BotEngine;
  config: BotConfig;
  /** Uniform in [0, 1). Defaults to Math.random; inject for deterministic tests. */
  random?: () => number;
}

function validateConfig(config: BotConfig): void {
  const problems: string[] = [];
  if (!Number.isInteger(config.minGames) || config.minGames < 1) {
    problems.push(`minGames must be an integer >= 1 (got ${config.minGames})`);
  }
  if (!Number.isFinite(config.outOfBookElo) || config.outOfBookElo <= 0) {
    problems.push(`outOfBookElo must be a positive number (got ${config.outOfBookElo})`);
  }
  if (!Array.isArray(config.explorerRatings) || config.explorerRatings.length === 0) {
    problems.push("explorerRatings must be a non-empty array");
  }
  if (!Array.isArray(config.explorerSpeeds) || config.explorerSpeeds.length === 0) {
    problems.push("explorerSpeeds must be a non-empty array");
  }
  if (problems.length > 0) {
    throw new Error(`invalid bot config: ${problems.join("; ")}`);
  }
}

function loadPosition(fen: string): Chess {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch (err) {
    throw new Error(`invalid FEN "${fen}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (chess.isGameOver()) {
    throw new Error(`game over in position ${fen}: the bot has no move to make`);
  }
  return chess;
}

/** Weighted pick by games; candidates must all have games > 0. */
function pickWeighted(candidates: BotExplorerMove[], random: () => number): number {
  const total = candidates.reduce((sum, m) => sum + m.games, 0);
  const target = random() * total;
  let cumulative = 0;
  for (let i = 0; i < candidates.length; i++) {
    cumulative += candidates[i]!.games;
    if (target < cumulative) return i;
  }
  return candidates.length - 1; // guards float rounding at the top end
}

export function createSparringBot(options: SparringBotOptions): SparringBot {
  const { explorer, engine, config } = options;
  const random = options.random ?? Math.random;
  validateConfig(config);
  const lookupOptions: BotLookupOptions = {
    ratings: [...config.explorerRatings],
    speeds: [...config.explorerSpeeds],
  };

  async function engineMove(fen: string, reason: BotFallbackReason): Promise<BotMove> {
    const uci = await engine.bestMove(fen, { elo: config.outOfBookElo });
    let san: string;
    try {
      san = playUci(new Chess(fen), uci).san;
    } catch {
      throw new Error(`engine returned illegal move "${uci}" in position ${fen}`);
    }
    return { uci, san, source: "engine", fallbackReason: reason };
  }

  return {
    async chooseMove(fen) {
      loadPosition(fen);

      let result: BotExplorerResult;
      try {
        result = await explorer.lookup(fen, lookupOptions);
      } catch (err) {
        if (err instanceof Error && err.name === "ExplorerConfigError") throw err;
        return engineMove(fen, "lookup_failed");
      }

      if (result.unavailable !== undefined) return engineMove(fen, "unavailable");
      if (!(result.totalGames >= config.minGames)) return engineMove(fen, "few_games");

      const candidates = result.moves.filter((m) => m.games > 0);
      if (candidates.length === 0) return engineMove(fen, "no_moves");

      while (candidates.length > 0) {
        const index = pickWeighted(candidates, random);
        const picked = candidates[index]!;
        try {
          const move = playUci(new Chess(fen), picked.uci);
          return {
            uci: picked.uci,
            san: move.san,
            source: "explorer",
            explorer: {
              games: picked.games,
              totalGames: result.totalGames,
              share: picked.games / result.totalGames,
            },
          };
        } catch {
          candidates.splice(index, 1); // never return an unchecked move (FR-10)
        }
      }
      return engineMove(fen, "illegal_explorer_move");
    },
  };
}
