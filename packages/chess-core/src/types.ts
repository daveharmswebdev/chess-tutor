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
  /**
   * The player's own drops stay quiet (no player_blunder or missed_win) while the
   * player's evaluation after the move is strictly above this, unless a forced mate
   * for the player was missed (#16). Opponent moves are not affected.
   */
  stillWinningCp: number;
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

/**
 * Exchange on a square (#44: FR-21, FR-10, FR-23). Contract shared by chess-core's pure
 * `exchangeOnSquare(fen: string, square: string): ExchangeResult` (no engine search) and the
 * tutor's `exchange_on_square(fen, square)` tool, whose result is this object as JSON.
 *
 * Sides: the attacking side is the colour opposite the square's occupant; on an empty square it is
 * the side to move. `attackerToMove` is false when that side is not to move in `fen` (the result is
 * then a threat: what the attacker could win if it were its turn), and the sequence is computed as if
 * it were.
 * Order: each list is in capture order, cheapest first (pawn 1, knight 3, bishop 3, rook 5, queen 9,
 * king last). An x-ray piece (one that reaches the square only after a piece in front of it on the
 * same line has captured) is listed with `xray: true` and comes no earlier than the piece in front
 * of it. A king captures only when the square is then no longer attacked by the other side.
 * Promotion: a pawn capturing onto the last rank becomes a queen (gain counted, and it is worth 9
 * when recaptured).
 * Results are in pawns for the attacking side (positive: it wins material), using the values above.
 * Pins, checks, mates and threats elsewhere are ignored; `caveat` says so in plain words, and the
 * tutor must not present a count as the full answer (FR-23).
 */
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export interface ExchangePiece {
  /** Square, e.g. "f3". */
  square: string;
  piece: PieceType;
  color: Color;
  /** 1, 3, 3, 5, 9; the king is 0 here (it never decides the result, it only captures last when safe). */
  value: number;
  /** True when it attacks the square only through a friendly piece in front of it on the same line. */
  xray: boolean;
}

export interface ExchangeCapture {
  /** 1-based: odd captures are by the attacking side, even ones by the defending side. */
  n: number;
  /** The capturing piece (from `attackers` or `defenders`). */
  by: ExchangePiece;
  /** The piece taken on the square (after any earlier promotion there). */
  captured: PieceType;
  /** True when this capture is a pawn promoting (to a queen). */
  promotion: boolean;
}

export interface ExchangeResult {
  /** The square asked about, e.g. "e5". */
  square: string;
  /** What stands on the square before any capture, or null when it is empty. */
  occupant: { piece: PieceType; color: Color } | null;
  attackingSide: Color;
  /** Whether attackingSide is the side to move in the FEN. */
  attackerToMove: boolean;
  /** The attacking side's pieces that bear on the square, in capture order (x-rays included). */
  attackers: ExchangePiece[];
  /** The other side's pieces that bear on the square (they recapture), in capture order. */
  defenders: ExchangePiece[];
  /** Every capture if both sides keep recapturing, cheapest piece first, until one side cannot. Empty when the square is empty or nobody attacks it. */
  sequence: ExchangeCapture[];
  /** Material for attackingSide, in pawns, when both sides recapture to the end of `sequence`. */
  fullResult: number;
  /** Material for attackingSide, in pawns, when each side stops at its best moment (either side may stop early); 0 when not starting is best. */
  result: number;
  /** How many captures of `sequence` are played with best stopping (0 means the attacker should not capture). */
  bestLength: number;
  /** Fixed plain text: a static count that ignores pins, checks and threats elsewhere; check with the engine. */
  caveat: string;
}
