/**
 * Analysis shapes, structurally identical to @chess-tutor/engine's types so engine
 * output can be passed in without a package dependency.
 */

/** An engine score, always from White's point of view. */
export type Score =
  | { kind: "cp"; value: number } // centipawns: +100 means White is about a pawn ahead
  | { kind: "mate"; value: number }; // mate in N moves: positive means White mates, negative means Black mates

export interface AnalysisLine {
  rank: number; // 1-based
  moves: string[]; // UCI
  score: Score;
  depth: number;
}

export interface Analysis {
  fen: string;
  depth: number;
  lines: AnalysisLine[]; // best line first
  bestMove: string; // UCI
  timeMs: number;
}

export type Color = "w" | "b";

/** All move strings are SAN. `line` is the repertoire line's name (architecture §3.4). */
export type KeyMoment =
  | { kind: "opponent_left_book"; line: string; expected: string[]; played: string }
  | { kind: "player_blunder"; played: string; cpLoss: number; best: string }
  | { kind: "missed_win"; played: string; best: string; gainCp: number }
  | { kind: "punish_opponent"; opponentMove: string; refutation: string; gainCp: number };

/** From config/tutor.json `keyMoments`, passed in by the caller. */
export interface KeyMomentThresholds {
  blunderCp: number;
  missedWinCp: number;
  punishCp: number;
}

export interface RepertoireLineInput {
  name: string;
  color: Color;
  /** Mainline movetext only, e.g. "1. d4 d5 2. Bf4 Nf6 3. e3". */
  pgn: string;
}

export interface Continuations {
  line: string;
  moves: { uci: string; san: string }[];
}

export interface Repertoire {
  /**
   * Continuations after history (UCI from the start position) for lines of this color,
   * or null when history has left every line. Empty array when history is at the end of a line.
   */
  continuations(history: string[], color: Color): Continuations | null;
}

export interface DetectorInput {
  playerColor: Color;
  /** Position before the move; its side to move is the mover. */
  fenBefore: string;
  /** The move just played, UCI (e.g. "e2e4", "e7e8q"). */
  move: string;
  /** UCI moves from the standard start position up to but not including `move`. */
  history: string[];
  /** Analysis of fenBefore. */
  before: Analysis;
  /** Analysis of the position after `move`. Empty `lines` means the game is over. */
  after: Analysis;
  repertoire: Repertoire | null;
  thresholds: KeyMomentThresholds;
}
