import type { Color, KeyMoment } from "@chess-tutor/chess-core";
import type { TutorFailureReason, TutorReply, TutorUsage } from "@chess-tutor/tutor";
import type { ReplyGrades, ToolResultRecord } from "./graders.ts";

/** One frozen eval case (evals/cases/<id>.json), made by generate-cases.ts with real Stockfish. */
export interface EvalCase {
  id: string;
  kind: TutorReply["kind"];
  playerColor: Color;
  /** UCI from the start position, including the triggering move. */
  history: string[];
  /** Position after the last history move. */
  fen: string;
  /** detect() output; null for hints. */
  moment: KeyMoment | null;
  /** Where the attempt is graded: before the move for player_blunder / missed_win, else fen. */
  attemptFen: string;
  /** Engine best move (UCI) at attemptFen. */
  engineBest: string;
  /** Engine evaluation of engineBest, centipawns from the attempt side's point of view. */
  engineBestCp: number;
  source: string;
}

/** One API round of an ask, as the recording client saw it. */
export interface RecordedRound {
  ms: number;
  stopReason: string | null;
  toolUses: { id: string; name: string; input: unknown }[];
  /** Results sent back for this round's tool_use blocks (filled when the next request goes out). */
  toolResults: ToolResultRecord[];
  text: string;
  usage: Record<string, unknown> | null;
  error: string | null;
}

export interface CaseResult {
  /** caseId, plus #n when --repeat > 1. */
  id: string;
  caseId: string;
  repeat: number;
  kind: EvalCase["kind"];
  model: string;
  effort: string;
  ok: boolean;
  reason: TutorFailureReason | "threw" | null;
  failureMessage: string | null;
  reply: TutorReply | null;
  ms: number;
  firstRoundMs: number | null;
  toolCalls: number;
  /** end_turn rounds after the first: the session's NFR-8 correction retry. */
  retries: number;
  usage: TutorUsage;
  costUsd: number;
  revealCpLoss: number | null;
  progress: string[];
  rounds: RecordedRound[];
  grades: ReplyGrades | null;
}

/** The light per-case row kept in summary.json (and used by compare). */
export interface CaseRow {
  id: string;
  caseId: string;
  kind: EvalCase["kind"];
  ok: boolean;
  reason: string | null;
  nfr6Moves: boolean | null;
  nfr6Evals: boolean | null;
  nfr7: boolean | null;
  arrowsOk: boolean | null;
  revealOk: boolean | null;
  schemaOk: boolean | null;
  toolCalls: number;
  retries: number;
  ms: number;
  firstRoundMs: number | null;
  costUsd: number;
  problems: string[];
}

export interface RunMetrics {
  /** Cases asked (skipped ones excluded). */
  cases: number;
  okRate: number | null;
  failureReasons: Record<string, number>;
  /** Over successful replies. */
  graded: number;
  moveLegalPct: number | null;
  evalMatchPct: number | null;
  noGiveAwayPct: number | null;
  arrowsOkPct: number | null;
  revealOkPct: number | null;
  schemaOkPct: number | null;
  toolCallsMean: number | null;
  retriesTotal: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  firstRoundP50Ms: number | null;
  firstRoundP95Ms: number | null;
  costPerCaseUsd: number | null;
  /** costPerCaseUsd x KEY_MOMENTS_PER_GAME. */
  costPerGameUsd: number | null;
  totalCostUsd: number;
}

export interface RunSummary {
  model: string;
  effort: string;
  promptFile: string;
  promptSha256: string;
  startedAt: string;
  finishedAt: string;
  maxUsd: number;
  spentUsd: number;
  stoppedByBudget: boolean;
  /** Case ids (with #n) not started because of the budget. */
  skipped: string[];
  metrics: RunMetrics;
  rows: CaseRow[];
}

/** Assumption for the per-game cost (brief 032): about 10 key moments or hints per game. */
export const KEY_MOMENTS_PER_GAME = 10;

/** Known defects these deterministic graders cannot see; the report lists them. */
export const NEEDS_JUDGE = [
  "False positional claims (e.g. 'the bishop pins the knight on f6' after 1.d4 Nf6 2.Bg5, where the e7 pawn blocks the diagonal to the queen): needs an LLM judge.",
  "Give-aways in plain words that name neither the move nor the answer's piece together with the check it gives: needs an LLM judge.",
  "Clarity and fit for a 1000-rated player: needs an LLM judge (architecture §5, optional).",
];
