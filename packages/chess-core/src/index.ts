export type {
  Analysis,
  AnalysisLine,
  Color,
  Continuations,
  DetectorInput,
  ExchangeCapture,
  ExchangePiece,
  ExchangeResult,
  KeyMoment,
  KeyMomentThresholds,
  PieceType,
  Repertoire,
  RepertoireLineInput,
  Score,
} from "./types.ts";
export { detect } from "./detector.ts";
export { buildRepertoire } from "./repertoire.ts";
export { parseRepertoirePgn } from "./repertoire-pgn.ts";
export { MATE_CP, scoreToCp } from "./score.ts";
export { sanOf } from "./moves.ts";
export {
  assertBotStrength,
  createSparringBot,
  EXPLORER_RATING_BUCKETS,
  explorerRatingsFor,
  weakeningAt,
} from "./bot.ts";
export { EXCHANGE_CAVEAT, exchangeOnSquare } from "./exchange.ts";
export type {
  BotAnalysis,
  BotChooseOptions,
  BotConfig,
  BotEngine,
  BotExplorer,
  BotExplorerMove,
  BotExplorerResult,
  BotFallbackReason,
  BotLookupOptions,
  BotMove,
  BotWeakeningAnchor,
  BotWeakeningConfig,
  BotWeakeningInfo,
  SparringBot,
  SparringBotOptions,
} from "./bot.ts";
export type {
  ApiError,
  DailyStats,
  OpsEvent,
  OpsEventCode,
  OpsEvents,
  GameEndReason,
  GameEvent,
  GameResult,
  GameStatus,
  GameView,
  MoveView,
  NewGameRequest,
  PlayMoveRequest,
  TutorArrow,
  TutorKind,
  TutorNote,
  TutorQuestion,
  TutorReveal,
  TutorStatus,
  UsageCounts,
} from "./api.ts";
export { BOT_STRENGTH, OPS_EVENT_CODES } from "./api.ts";
