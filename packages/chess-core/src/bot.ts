import { Chess, type Move } from "chess.js";
import { BOT_STRENGTH } from "./api.ts";
import { playUci, toUci } from "./moves.ts";
import { scoreToCp } from "./score.ts";
import type { Score } from "./types.ts";

/*
 * Sparring bot (FR-1, FR-2, FR-3 as amended by A11, FR-10, architecture §3.3).
 *
 * Pure: the explorer and engine are injected. The interfaces below are
 * structural subsets of @chess-tutor/explorer and @chess-tutor/engine, so the
 * real clients satisfy them without chess-core depending on those packages.
 *
 * Strength (#84) is per call, 500 to 2500 in steps of 100 (default 1400):
 * - in book: Lichess explorer moves from the rating buckets around the strength;
 * - out of book, strength >= 1320: Stockfish at UCI_Elo = strength;
 * - out of book, strength < 1320: full-strength MultiPV lines, sampled by
 *   centipawn loss with a temperature plus a blunder rate (config bot.weakening).
 * Every move comes from the explorer list or the engine's output and is checked legal.
 */

/** Subset of @chess-tutor/explorer ExplorerMove that the bot reads. */
export interface BotExplorerMove {
  /** May spell castling as king-takes-rook (e1h1); the bot then falls back to san. */
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

/** Subset of @chess-tutor/engine Analysis that the bot reads. Scores are White's POV; lines best first. */
export interface BotAnalysis {
  bestMove: string;
  lines: { moves: string[]; score: Score }[];
}

export interface BotEngine {
  bestMove(fen: string, opts?: { elo?: number }): Promise<string>;
  /**
   * Full-strength MultiPV analysis (subset of @chess-tutor/engine Engine.analyze). Needed only
   * for strengths below BOT_STRENGTH.uciEloMin; optional so engine stubs that only play
   * at UCI_Elo still type-check. Missing it below 1320 makes chooseMove throw.
   */
  analyze?(fen: string, opts?: { multiPv?: number; depth?: number }): Promise<BotAnalysis>;
}

/** One point of the strength -> weakening curve; values between anchors are interpolated linearly. */
export interface BotWeakeningAnchor {
  strength: number;
  /** Softmax temperature in centipawns: weight of a line is exp(-lossCp / temperatureCp). */
  temperatureCp: number;
  /** Probability, in [0, 1], of playing a line that loses at least blunderMinLossCp. */
  blunderRate: number;
}

/** The `bot.weakening` block of config/tutor.json (FR-3 as amended by A11). */
export interface BotWeakeningConfig {
  /** Lines to ask the engine for (UCI MultiPV). */
  multiPv: number;
  /** Search depth for those lines. */
  depth: number;
  /** A line losing at least this much against the best line counts as a blunder. */
  blunderMinLossCp: number;
  /** Sorted by strength, strictly increasing; at least one. Clamped outside the range. */
  anchors: BotWeakeningAnchor[];
}

/** The `bot` block of config/tutor.json. */
export interface BotConfig {
  /**
   * Still validated and read by the server for the tutor's explorer; the bot itself picks
   * its ratings from the strength (explorerRatingsFor) since #84.
   */
  explorerRatings: number[];
  explorerSpeeds: string[];
  /** Positions with fewer explorer games than this are out of book. */
  minGames: number;
  /** Still validated; the bot plays UCI_Elo = strength out of book since #84. */
  outOfBookElo: number;
  /** Required for strengths below BOT_STRENGTH.uciEloMin (1320). */
  weakening?: BotWeakeningConfig;
}

export type BotFallbackReason =
  | "unavailable"
  | "few_games"
  | "no_moves"
  | "lookup_failed"
  | "illegal_explorer_move";

/** How a weakened engine move (strength below 1320) was chosen. */
export interface BotWeakeningInfo {
  /** Centipawn loss of the played line against the best legal line, mover's POV (0 = best). */
  lossCp: number;
  /** True when the blunder branch chose the line. */
  blunder: boolean;
  /** Legal lines sampled from; 0 means analysis.bestMove was played. */
  candidates: number;
  temperatureCp: number;
  blunderRate: number;
}

export interface BotMove {
  uci: string;
  san: string;
  source: "explorer" | "engine";
  /**
   * Present when source is "explorer". share = games / totalGames: how often
   * real players chose this move in the position. It is not the sampling
   * probability, which is games / (sum of games over the listed moves), since
   * the explorer lists only the top moves.
   */
  explorer?: { games: number; totalGames: number; share: number };
  /** Present when source is "engine": why the explorer was not used. */
  fallbackReason?: BotFallbackReason;
  /** Present when the engine move came from the weakening path (strength below 1320). */
  weakening?: BotWeakeningInfo;
}

export interface BotChooseOptions {
  /** 500 to 2500 in steps of 100 (BOT_STRENGTH); omitted means 1400. Anything else throws. */
  strength?: number;
}

export interface SparringBot {
  chooseMove(fen: string, opts?: BotChooseOptions): Promise<BotMove>;
}

export interface SparringBotOptions {
  explorer: BotExplorer;
  engine: BotEngine;
  config: BotConfig;
  /** Uniform in [0, 1). Defaults to Math.random; inject for deterministic tests. */
  random?: () => number;
}

/**
 * Lichess explorer `ratings` buckets (lower bounds; each runs up to the next).
 * Source: the Lichess OpenAPI spec (brief 101).
 */
export const EXPLORER_RATING_BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const;

/** Throws unless strength is a multiple of BOT_STRENGTH.step within [min, max]. */
export function assertBotStrength(strength: number): void {
  const { min, max, step } = BOT_STRENGTH;
  if (!Number.isInteger(strength) || strength < min || strength > max || strength % step !== 0) {
    throw new Error(`invalid bot strength ${strength}: must be ${min} to ${max} in steps of ${step}`);
  }
}

/**
 * Explorer rating buckets for a bot strength (FR-2, #84): the bucket containing the
 * strength plus the one below it, if any. 1400 -> [1200, 1400]; 500 -> [0]; 1300 -> [1000, 1200].
 */
export function explorerRatingsFor(strength: number): number[] {
  assertBotStrength(strength);
  let index = 0;
  for (let i = 0; i < EXPLORER_RATING_BUCKETS.length; i++) {
    if (EXPLORER_RATING_BUCKETS[i]! <= strength) index = i;
  }
  return index === 0 ? [EXPLORER_RATING_BUCKETS[0]] : [EXPLORER_RATING_BUCKETS[index - 1]!, EXPLORER_RATING_BUCKETS[index]!];
}

/**
 * Temperature and blunder rate for a strength: linear between the surrounding anchors,
 * clamped to the first or last anchor outside them. Anchors must be valid (sorted, non-empty).
 */
export function weakeningAt(
  strength: number,
  config: Pick<BotWeakeningConfig, "anchors">,
): { temperatureCp: number; blunderRate: number } {
  const anchors = config.anchors;
  const first = anchors[0];
  if (first === undefined) throw new Error("invalid bot config: weakening.anchors is empty");
  const pick = (a: BotWeakeningAnchor) => ({ temperatureCp: a.temperatureCp, blunderRate: a.blunderRate });
  if (strength <= first.strength) return pick(first);
  for (let i = 1; i < anchors.length; i++) {
    const lo = anchors[i - 1]!;
    const hi = anchors[i]!;
    if (strength === hi.strength) return pick(hi);
    if (strength < hi.strength) {
      const t = (strength - lo.strength) / (hi.strength - lo.strength);
      return {
        temperatureCp: lo.temperatureCp + (hi.temperatureCp - lo.temperatureCp) * t,
        blunderRate: lo.blunderRate + (hi.blunderRate - lo.blunderRate) * t,
      };
    }
  }
  return pick(anchors[anchors.length - 1]!);
}

function weakeningProblems(w: BotWeakeningConfig): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(w.multiPv) || w.multiPv < 1) {
    problems.push(`weakening.multiPv must be an integer >= 1 (got ${w.multiPv})`);
  }
  if (!Number.isInteger(w.depth) || w.depth < 1) {
    problems.push(`weakening.depth must be an integer >= 1 (got ${w.depth})`);
  }
  if (!Number.isFinite(w.blunderMinLossCp) || w.blunderMinLossCp <= 0) {
    problems.push(`weakening.blunderMinLossCp must be a positive number (got ${w.blunderMinLossCp})`);
  }
  if (!Array.isArray(w.anchors) || w.anchors.length === 0) {
    problems.push("weakening.anchors must be a non-empty array");
    return problems;
  }
  w.anchors.forEach((a, i) => {
    if (!Number.isFinite(a.strength)) problems.push(`weakening.anchors[${i}].strength must be a number`);
    if (!Number.isFinite(a.temperatureCp) || a.temperatureCp <= 0) {
      problems.push(`weakening.anchors[${i}].temperatureCp must be > 0 (got ${a.temperatureCp})`);
    }
    if (!Number.isFinite(a.blunderRate) || a.blunderRate < 0 || a.blunderRate > 1) {
      problems.push(`weakening.anchors[${i}].blunderRate must be in [0, 1] (got ${a.blunderRate})`);
    }
    if (i > 0 && !(a.strength > w.anchors[i - 1]!.strength)) {
      problems.push("weakening.anchors must be sorted by strictly increasing strength");
    }
  });
  return problems;
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
  if (config.weakening !== undefined) problems.push(...weakeningProblems(config.weakening));
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

/**
 * The legal chess.js move for an explorer entry, or null if it is not legal.
 * Tries the UCI first, then the SAN: Lichess may spell castling as
 * king-takes-own-rook (e8h8), which playUci rejects but "O-O" resolves.
 */
function resolveExplorerMove(fen: string, entry: BotExplorerMove): Move | null {
  try {
    return playUci(new Chess(fen), entry.uci);
  } catch {
    // fall through to SAN
  }
  try {
    return new Chess(fen).move(entry.san);
  } catch {
    return null;
  }
}

/** The legal move for a UCI string in fen, or null (FR-10). */
function legalUci(fen: string, uci: string | undefined): Move | null {
  if (uci === undefined || uci === "") return null;
  try {
    return playUci(new Chess(fen), uci);
  } catch {
    return null;
  }
}

/** Index picked in proportion to weights (all >= 0, sum > 0); target = random() * sum. */
function pickByWeight(weights: number[], random: () => number): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  const target = random() * total;
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i]!;
    if (target < cumulative) return i;
  }
  return weights.length - 1; // guards float rounding at the top end
}

interface Candidate {
  move: Move;
  lossCp: number;
}

export function createSparringBot(options: SparringBotOptions): SparringBot {
  const { explorer, engine, config } = options;
  const random = options.random ?? Math.random;
  validateConfig(config);
  const speeds = [...config.explorerSpeeds];

  async function eloMove(fen: string, strength: number, reason: BotFallbackReason): Promise<BotMove> {
    const uci = await engine.bestMove(fen, { elo: strength });
    const move = legalUci(fen, uci);
    if (move === null) throw new Error(`engine returned illegal move "${uci}" in position ${fen}`);
    return { uci, san: move.san, source: "engine", fallbackReason: reason };
  }

  async function weakenedMove(
    fen: string,
    strength: number,
    weakening: BotWeakeningConfig,
    analyze: NonNullable<BotEngine["analyze"]>,
    reason: BotFallbackReason,
  ): Promise<BotMove> {
    const { temperatureCp, blunderRate } = weakeningAt(strength, weakening);
    const analysis = await analyze(fen, { multiPv: weakening.multiPv, depth: weakening.depth });
    const mover = new Chess(fen).turn();

    const legal: { move: Move; cp: number }[] = [];
    for (const line of analysis.lines) {
      const move = legalUci(fen, line.moves[0]);
      if (move === null) continue; // never play an unchecked move (FR-10)
      legal.push({ move, cp: scoreToCp(line.score, mover, mover) });
    }

    if (legal.length === 0) {
      const move = legalUci(fen, analysis.bestMove);
      if (move === null) throw new Error(`engine returned illegal move "${analysis.bestMove}" in position ${fen}`);
      return {
        uci: toUci(move),
        san: move.san,
        source: "engine",
        fallbackReason: reason,
        weakening: { lossCp: 0, blunder: false, candidates: 0, temperatureCp, blunderRate },
      };
    }

    // Lines come best first, so the best legal line is line 1 unless line 1 was dropped.
    const best = Math.max(...legal.map((l) => l.cp));
    const candidates: Candidate[] = legal.map((l) => ({ move: l.move, lossCp: Math.max(0, best - l.cp) }));

    let chosen: Candidate | undefined;
    let blunder = false;
    if (random() < blunderRate) {
      const blunders = candidates.filter((c) => c.lossCp >= weakening.blunderMinLossCp);
      if (blunders.length > 0) {
        chosen = blunders[Math.min(Math.floor(random() * blunders.length), blunders.length - 1)]!;
        blunder = true;
      }
    }
    if (chosen === undefined) {
      const weights = candidates.map((c) => Math.exp(-c.lossCp / temperatureCp));
      chosen = candidates[pickByWeight(weights, random)]!;
    }

    return {
      uci: toUci(chosen.move),
      san: chosen.move.san,
      source: "engine",
      fallbackReason: reason,
      weakening: { lossCp: chosen.lossCp, blunder, candidates: candidates.length, temperatureCp, blunderRate },
    };
  }

  return {
    async chooseMove(fen, opts = {}) {
      const strength = opts.strength ?? BOT_STRENGTH.default;
      const ratings = explorerRatingsFor(strength); // validates the strength
      const weakened = strength < BOT_STRENGTH.uciEloMin;
      const weakening = config.weakening;
      if (weakened && weakening === undefined) {
        throw new Error(
          `bot strength ${strength} is below ${BOT_STRENGTH.uciEloMin} but the bot config has no weakening block`,
        );
      }
      const analyze = engine.analyze?.bind(engine);
      if (weakened && analyze === undefined) {
        throw new Error(`bot strength ${strength} is below ${BOT_STRENGTH.uciEloMin} but the engine has no analyze()`);
      }
      loadPosition(fen);

      const engineMove = (reason: BotFallbackReason): Promise<BotMove> =>
        weakened ? weakenedMove(fen, strength, weakening!, analyze!, reason) : eloMove(fen, strength, reason);

      let result: BotExplorerResult;
      try {
        result = await explorer.lookup(fen, { ratings, speeds: [...speeds] });
      } catch (err) {
        if (err instanceof Error && err.name === "ExplorerConfigError") throw err;
        return engineMove("lookup_failed");
      }

      if (result.unavailable !== undefined) return engineMove("unavailable");
      if (!(result.totalGames >= config.minGames)) return engineMove("few_games");

      const candidates = result.moves.filter((m) => m.games > 0);
      if (candidates.length === 0) return engineMove("no_moves");

      while (candidates.length > 0) {
        const index = pickByWeight(
          candidates.map((m) => m.games),
          random,
        );
        const picked = candidates[index]!;
        const move = resolveExplorerMove(fen, picked);
        if (move === null) {
          candidates.splice(index, 1); // never return an unchecked move (FR-10)
          continue;
        }
        return {
          uci: toUci(move),
          san: move.san,
          source: "explorer",
          explorer: {
            games: picked.games,
            totalGames: result.totalGames,
            share: picked.games / result.totalGames,
          },
        };
      }
      return engineMove("illegal_explorer_move");
    },
  };
}
