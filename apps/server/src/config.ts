import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BotConfig, KeyMomentThresholds } from "@chess-tutor/chess-core";
import type { TutorConfig } from "@chess-tutor/tutor";

export const TUTOR_CONFIG_PATH = fileURLToPath(new URL("../../../config/tutor.json", import.meta.url));
export const MODELS_CONFIG_PATH = fileURLToPath(new URL("../../../config/models.json", import.meta.url));

interface TutorJson {
  engine?: { threads?: number; depth?: number; movetimeCapMs?: number; multiPv?: number };
  keyMoments?: KeyMomentThresholds;
  bot?: BotConfig;
  tutor?: { effort?: TutorConfig["effort"]; maxToolRounds?: number; attemptToleranceCp?: number };
}

function readConfig(path: string): TutorJson {
  return JSON.parse(readFileSync(path, "utf8")) as TutorJson;
}

/** The `bot` block of config/tutor.json (validated by createSparringBot). */
export function loadBotConfig(path: string = TUTOR_CONFIG_PATH): BotConfig {
  const bot = readConfig(path).bot;
  if (!bot) throw new Error(`no "bot" block in ${path}`);
  return bot;
}

export function loadEngineThreads(path: string = TUTOR_CONFIG_PATH): number | undefined {
  return readConfig(path).engine?.threads;
}

/** Engine settings for the server's own analysis (key-moment detection, attempt grading). */
export interface AnalysisSettings {
  depth: number;
  movetimeCapMs: number;
  multiPv: number;
}

export function loadAnalysisSettings(path: string = TUTOR_CONFIG_PATH): AnalysisSettings {
  const e = readConfig(path).engine;
  if (!e || typeof e.depth !== "number" || typeof e.movetimeCapMs !== "number" || typeof e.multiPv !== "number") {
    throw new Error(`"engine" in ${path} needs depth, movetimeCapMs and multiPv`);
  }
  return { depth: e.depth, movetimeCapMs: e.movetimeCapMs, multiPv: e.multiPv };
}

/** config/tutor.json `keyMoments` (FR-6). */
export function loadKeyMomentThresholds(path: string = TUTOR_CONFIG_PATH): KeyMomentThresholds {
  const k = readConfig(path).keyMoments;
  const fields = ["blunderCp", "missedWinCp", "punishCp", "stillWinningCp"] as const;
  if (!k || fields.some((f) => typeof k[f] !== "number")) {
    throw new Error(`"keyMoments" in ${path} needs ${fields.join(", ")}`);
  }
  return { blunderCp: k.blunderCp, missedWinCp: k.missedWinCp, punishCp: k.punishCp, stillWinningCp: k.stillWinningCp };
}

/** config/tutor.json `tutor.attemptToleranceCp`: an attempt within this loss of the best move is correct. */
export function loadAttemptToleranceCp(path: string = TUTOR_CONFIG_PATH): number {
  const cp = readConfig(path).tutor?.attemptToleranceCp;
  if (typeof cp !== "number" || cp < 0) throw new Error(`"tutor.attemptToleranceCp" in ${path} must be a number >= 0`);
  return cp;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * The tutor's settings: model from config/models.json for `appEnv` (IR-9), effort and
 * maxToolRounds from config/tutor.json `tutor`, engine settings from `engine`, explorer
 * ratings and speeds from `bot`. Throws on a missing environment or a malformed block.
 */
export function loadTutorConfig(
  appEnv: string,
  paths: { tutor?: string; models?: string } = {},
): TutorConfig {
  const tutorPath = paths.tutor ?? TUTOR_CONFIG_PATH;
  const modelsPath = paths.models ?? MODELS_CONFIG_PATH;
  const models = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, { tutor?: unknown } | undefined>;
  const model = models[appEnv]?.tutor;
  if (typeof model !== "string" || model === "") {
    throw new Error(`no tutor model for environment "${appEnv}" in ${modelsPath}`);
  }
  const json = readConfig(tutorPath);
  const t = json.tutor;
  if (!t || typeof t.effort !== "string" || !EFFORTS.has(t.effort) || typeof t.maxToolRounds !== "number") {
    throw new Error(`"tutor" in ${tutorPath} needs effort and maxToolRounds`);
  }
  const bot = loadBotConfig(tutorPath);
  return {
    model,
    effort: t.effort,
    maxToolRounds: t.maxToolRounds,
    engine: loadAnalysisSettings(tutorPath),
    explorer: { ratings: [...bot.explorerRatings], speeds: [...bot.explorerSpeeds] },
  };
}
