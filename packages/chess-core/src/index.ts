export type {
  Analysis,
  AnalysisLine,
  Color,
  Continuations,
  DetectorInput,
  KeyMoment,
  KeyMomentThresholds,
  Repertoire,
  RepertoireLineInput,
  Score,
} from "./types.ts";
export { detect } from "./detector.ts";
export { buildRepertoire } from "./repertoire.ts";
export { MATE_CP, scoreToCp } from "./score.ts";
export { sanOf } from "./moves.ts";
export { createSparringBot } from "./bot.ts";
export type {
  BotConfig,
  BotEngine,
  BotExplorer,
  BotExplorerMove,
  BotExplorerResult,
  BotFallbackReason,
  BotLookupOptions,
  BotMove,
  SparringBot,
  SparringBotOptions,
} from "./bot.ts";
