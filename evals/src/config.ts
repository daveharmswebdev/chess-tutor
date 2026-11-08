import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepertoire, parseRepertoirePgn, type KeyMomentThresholds, type Repertoire } from "@chess-tutor/chess-core";
import type { TutorConfig, TutorUsage } from "@chess-tutor/tutor";

/**
 * Settings for evals, read from the same release artifacts the server uses (config/tutor.json,
 * config/models.json, prompts/, repertoire/). Mirrors apps/server/src/config.ts and
 * repertoire.ts without importing the server.
 */

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CASES_DIR = join(REPO_ROOT, "evals", "cases");
export const RESULTS_DIR = join(REPO_ROOT, "evals", "results");
export const DEFAULT_PROMPT = join(REPO_ROOT, "prompts", "tutor-system.v1.md");

/** Same as apps/server/src/tutor-setup.ts PLAYER_PROFILE. */
export const PLAYER_PROFILE =
  "Rated around 1000 on Chess.com. Plays the London System as White and the King's Indian Defence as Black.";

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

interface TutorJson {
  engine: { threads?: number; depth: number; movetimeCapMs: number; multiPv: number };
  keyMoments: KeyMomentThresholds;
  bot: { explorerRatings: number[]; explorerSpeeds: string[] };
  tutor: { effort: TutorConfig["effort"]; maxToolRounds: number; attemptToleranceCp: number };
}
interface ModelsJson {
  eval?: { tutor?: string };
  pricingPerMTok: Record<string, Price>;
}

export interface EvalSettings {
  /** The tutor config with the eval environment's model (config/models.json "eval"). */
  tutor: TutorConfig;
  thresholds: KeyMomentThresholds;
  toleranceCp: number;
  engineThreads: number | undefined;
  pricing: Record<string, Price>;
}

export function loadSettings(root: string = REPO_ROOT): EvalSettings {
  const t = JSON.parse(readFileSync(join(root, "config", "tutor.json"), "utf8")) as TutorJson;
  const m = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8")) as ModelsJson;
  const model = m.eval?.tutor;
  if (!model) throw new Error('config/models.json has no "eval".tutor model');
  return {
    tutor: {
      model,
      effort: t.tutor.effort,
      maxToolRounds: t.tutor.maxToolRounds,
      engine: { depth: t.engine.depth, movetimeCapMs: t.engine.movetimeCapMs, multiPv: t.engine.multiPv },
      explorer: { ratings: [...t.bot.explorerRatings], speeds: [...t.bot.explorerSpeeds] },
    },
    thresholds: t.keyMoments,
    toleranceCp: t.tutor.attemptToleranceCp,
    engineThreads: t.engine.threads,
    pricing: m.pricingPerMTok,
  };
}

/** london.pgn (White) and kid.pgn (Black). */
export function loadRepertoire(root: string = REPO_ROOT): Repertoire {
  const lines = [
    ...parseRepertoirePgn(readFileSync(join(root, "repertoire", "london.pgn"), "utf8"), "w"),
    ...parseRepertoirePgn(readFileSync(join(root, "repertoire", "kid.pgn"), "utf8"), "b"),
  ];
  return buildRepertoire(lines);
}

/** USD for one ask. input_tokens excludes cache reads and writes; cache writes cost 1.25x input (5-minute TTL). */
export function costUsd(u: TutorUsage, p: Price): number {
  return (u.inputTokens * p.input + u.cacheCreationInputTokens * p.input * 1.25 + u.cacheReadInputTokens * p.cacheRead + u.outputTokens * p.output) / 1e6;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
