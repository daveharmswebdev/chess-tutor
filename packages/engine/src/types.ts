/** An engine score, always from White's point of view. */
export type Score =
  | { kind: "cp"; value: number } // centipawns: +100 means White is about a pawn ahead
  | { kind: "mate"; value: number }; // mate in N moves: positive means White mates, negative means Black mates

export interface AnalysisLine {
  /** 1-based rank (UCI multipv). */
  rank: number;
  /** Principal variation in UCI notation, e.g. ["d7d5", "g1f3"]. */
  moves: string[];
  score: Score;
  depth: number;
}

export interface Analysis {
  fen: string;
  depth: number;
  /** Best line first. */
  lines: AnalysisLine[];
  bestMove: string;
  timeMs: number;
}

export interface AnalyzeOptions {
  /** Target depth (default 18). */
  depth?: number;
  /** Time cap in ms (default 1000). The search stops at the depth target or the cap, whichever comes first. */
  movetimeMs?: number;
  /** Number of candidate lines (UCI MultiPV). Default 1. */
  multiPv?: number;
}

export interface BestMoveOptions {
  /** Play at a reduced strength (UCI_LimitStrength + UCI_Elo). */
  elo?: number;
  movetimeMs?: number;
  depth?: number;
}

export interface Engine {
  analyze(fen: string, opts?: AnalyzeOptions): Promise<Analysis>;
  bestMove(fen: string, opts?: BestMoveOptions): Promise<string>;
  quit(): Promise<void>;
}
