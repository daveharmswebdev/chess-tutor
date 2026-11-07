import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BotConfig } from "@chess-tutor/chess-core";

export const TUTOR_CONFIG_PATH = fileURLToPath(new URL("../../../config/tutor.json", import.meta.url));

interface TutorConfig {
  engine?: { threads?: number };
  bot?: BotConfig;
}

function readConfig(path: string): TutorConfig {
  return JSON.parse(readFileSync(path, "utf8")) as TutorConfig;
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
