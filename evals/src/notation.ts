import { Chess, type Move, type Square } from "chess.js";

/**
 * Move mentions in the tutor's text, found and resolved with chess.js only (the graders do not
 * use packages/tutor internals, so they check the tutor rather than repeat it).
 *
 * Recognised: SAN piece moves (Nf3, Bxd6, Nbd7, R1e2), pawn captures (exd6), promotions
 * (e8=Q), castling (O-O, O-O-O, 0-0), each with an optional + or #; UCI (g1f3, e7e8q); long
 * algebraic (Ng1-f3, e3-e4, Bc4xf7); "<piece> [goes/moves/...] to <square>"; "putting/bringing/
 * placing [your] <piece> on <square>"; and a bare square as a pawn move only in a move context:
 * after "...", a move number, a verb such as play/push/try/then/move/break, after "and"/"or"/","
 * that follows another move mention (the same piece's move when that mention was "<piece> to
 * <square>"), or followed by an annotation (! !? ?! ?? + #; a lone "?" ends a question).
 * Elsewhere a square is a square ("the knight on f6", "go after c7", "the rook on a8?").
 *
 * A square named as a plan ("the e4 break", "the e4-break", "the f5 pawn push") is a pawn move,
 * and "your knight belongs on e5" the knight's, with `plan: true`: it
 * names the move (NFR-7) but need not be legal yet ("prepare the f5 break"), so the legality
 * grader skips it.
 */

export interface Mention {
  raw: string;
  start: number;
  end: number;
  /** The move as parsed from the text. */
  spec: MoveSpec;
  /** Found as "<piece> to <square>" (or chained to one). */
  pieceTo?: boolean;
  /** A pawn move named as a plan ("the e4 break"): a move for NFR-7, not graded for legality. */
  plan?: boolean;
}

/** What a mention says about a move; null fields are unspecified. */
export interface MoveSpec {
  piece: "p" | "n" | "b" | "r" | "q" | "k" | null;
  fromFile: string | null;
  fromRank: string | null;
  to: string | null;
  capture: boolean;
  promotion: string | null;
  castle: "k" | "q" | null;
  /** UCI and long algebraic name the exact from-square. */
  exact: boolean;
}

const B = "(?<![A-Za-z0-9-])";
const E = "(?![A-Za-z0-9-])";

const CASTLE = new RegExp(`${B}(O-O-O|O-O|0-0-0|0-0)[+#]?${E}`, "g");
const LAN = new RegExp(`${B}([KQRBN])?([a-h][1-8])([-x])([a-h][1-8])(?:=?([QRBNqrbn]))?[+#]?${E}`, "g");
const UCI = new RegExp(`${B}([a-h][1-8])([a-h][1-8])([qrbn])?${E}`, "g");
const PIECE = new RegExp(`${B}([KQRBN])([a-h])?([1-8])?(x)?([a-h][1-8])[+#]?${E}`, "g");
const PAWN_CAPTURE = new RegExp(`${B}([a-h])x([a-h][1-8])(?:=?([QRBN]))?[+#]?${E}`, "g");
const PROMOTION = new RegExp(`${B}([a-h][18])=?([QRBN])[+#]?${E}`, "g");
const PIECE_TO = new RegExp(
  `\\b(king|queen|rook|bishop|knight|pawn)\\s+(?:(?:can\\s+|could\\s+)?(?:go|goes|went|jump|jumps|jumped|move|moves|moved|come|comes|came)\\s+)?to\\s+([a-h][1-8])${E}`,
  "gi",
);
// "putting your knight on e5", "bring the other bishop to d3" (#29).
const PLACE_PIECE = new RegExp(
  `\\b(?:put|puts|putting|place|places|placing|bring|brings|bringing|plant|plants|planting|post|posts|posting|land|lands|landing|get|gets|getting|reroute|reroutes|rerouting|send|sends|sending)\\s+(?:(?:your|the|a|his|her|their|that|white's|black's)\\s+)?(?:(?:other|light-squared|dark-squared|king's|queen's|kingside|queenside)\\s+)?(king|queen|rook|bishop|knight|pawn)\\s+(?:on|to|onto|into)\\s+([a-h][1-8])${E}`,
  "gi",
);
/** A square followed by a plan noun is a pawn move: "the e4 break", "the e4 pawn break", "the e4-break" (#29). */
const PLAN_SQUARE = new RegExp(`${B}([a-h][1-8])(?:-|\\s+)(?:pawn\\s+)?(?:break|push|advance|thrust|lever)\\b`, "gi");
/** Where a piece belongs, a plan: "your knight belongs on e5" (#29 round 2). */
const PIECE_BELONGS = new RegExp(`\\b(king|queen|rook|bishop|knight|pawn)\\s+belongs?\\s+(?:on|to)\\s+([a-h][1-8])${E}`, "gi");
const SQUARE = new RegExp(`${B}([a-h][1-8])([!?+#]+)?${E}`, "g");
// Not "after" or "with": "go after c7", "with c7 covered" name squares (#10 round 2).
const MOVE_VERBS =
  /(?:^|[^A-Za-z])(?:play|plays|played|playing|push|pushes|pushed|pushing|try|tries|tried|advance|advances|then|move|break|breaks|like|answer|answers|reply|replies)\s+$/i;
/** A move annotation; a lone "?" ends a question ("the rook on a8?") and makes no move. */
const ANNOTATION = /^(?:[!+#].*|\?[!?].*)$/;
const MOVE_NUMBER = /(?:(?:^|[^\w.])\d+\.(?:\.\.)?\s?|(?:^|[^\w.])\.\.\.\s?)$/;
const CHAIN = /^\s*(?:,|and|or|,\s*and|,\s*or|then|,\s*then)\s*$/i;

const PIECE_LETTER: Record<string, MoveSpec["piece"]> = { K: "k", Q: "q", R: "r", B: "b", N: "n" };
const PIECE_WORD: Record<string, MoveSpec["piece"]> = { king: "k", queen: "q", rook: "r", bishop: "b", knight: "n", pawn: "p" };

const spec = (s: Partial<MoveSpec>): MoveSpec => ({
  piece: null,
  fromFile: null,
  fromRank: null,
  to: null,
  capture: false,
  promotion: null,
  castle: null,
  exact: false,
  ...s,
});

/** Every move mention in `text`, in order, without overlaps (the earliest, then longest, wins). */
export function findMentions(text: string): Mention[] {
  const found: Mention[] = [];
  const add = (m: RegExpMatchArray, s: MoveSpec, raw = m[0]) => found.push({ raw, start: m.index!, end: m.index! + m[0].length, spec: s });

  for (const m of text.matchAll(CASTLE)) add(m, spec({ castle: m[1]!.length > 3 ? "q" : "k", piece: "k" }));
  for (const m of text.matchAll(LAN)) {
    const [, piece, from, sep, to, promo] = m;
    add(m, spec({ piece: piece ? PIECE_LETTER[piece]! : null, fromFile: from![0]!, fromRank: from![1]!, to: to!, capture: sep === "x", promotion: promo?.toLowerCase() ?? null, exact: true }));
  }
  for (const m of text.matchAll(UCI)) {
    const [, from, to, promo] = m;
    add(m, spec({ fromFile: from![0]!, fromRank: from![1]!, to: to!, promotion: promo ?? null, exact: true }));
  }
  for (const m of text.matchAll(PIECE)) {
    const [, piece, file, rank, x, to] = m;
    add(m, spec({ piece: PIECE_LETTER[piece!]!, fromFile: file ?? null, fromRank: rank ?? null, to: to!, capture: x === "x" }));
  }
  for (const m of text.matchAll(PAWN_CAPTURE)) {
    const [, file, to, promo] = m;
    add(m, spec({ piece: "p", fromFile: file!, to: to!, capture: true, promotion: promo?.toLowerCase() ?? null }));
  }
  for (const m of text.matchAll(PROMOTION)) add(m, spec({ piece: "p", to: m[1]!, promotion: m[2]!.toLowerCase() }));
  for (const m of text.matchAll(PIECE_TO)) {
    found.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, spec: spec({ piece: PIECE_WORD[m[1]!.toLowerCase()]!, to: m[2]! }), pieceTo: true });
  }
  for (const m of text.matchAll(PLAN_SQUARE)) {
    found.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, spec: spec({ piece: "p", to: m[1]! }), plan: true });
  }
  for (const m of text.matchAll(PIECE_BELONGS)) {
    found.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, spec: spec({ piece: PIECE_WORD[m[1]!.toLowerCase()]!, to: m[2]! }), plan: true });
  }
  for (const m of text.matchAll(PLACE_PIECE)) {
    found.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, spec: spec({ piece: PIECE_WORD[m[1]!.toLowerCase()]!, to: m[2]! }), pieceTo: true });
  }

  let mentions = dedupe(found);
  // Bare squares as pawn moves, only in a move context (needs the other mentions for chains).
  const squares: Mention[] = [];
  for (const m of text.matchAll(SQUARE)) {
    const start = m.index!;
    if (mentions.some((x) => start >= x.start && start < x.end)) continue;
    const before = text.slice(0, start);
    const annotated = m[2] !== undefined && ANNOTATION.test(m[2]);
    const prev = [...mentions, ...squares].filter((x) => x.end <= start).sort((a, b) => b.end - a.end)[0];
    const chained = prev !== undefined && CHAIN.test(text.slice(prev.end, start));
    if (annotated || MOVE_VERBS.test(before) || MOVE_NUMBER.test(before) || chained) {
      // "the knight can go to a6 or c7": a square chained to a piece-to-square mention is that piece's move.
      const piece = chained && prev.pieceTo ? prev.spec.piece : "p";
      const raw = m[0];
      squares.push({ raw, start, end: start + raw.length, spec: spec({ piece, to: m[1]! }), pieceTo: chained && prev.pieceTo === true });
    }
  }
  mentions = dedupe([...mentions, ...squares]);
  return mentions;
}

function dedupe(list: Mention[]): Mention[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Mention[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) continue;
    out.push(m);
  }
  return out;
}

/** Legal moves in `fen` that fit the mention. */
export function resolve(fen: string, s: MoveSpec): Move[] {
  return legalMoves(fen).filter((mv) => fits(mv, s));
}

// Legal moves per position: the graders resolve every mention in hundreds of positions, and
// building a Chess and its move list each time made grading a recorded case take seconds (#29).
const MOVES = new Map<string, Move[]>();
const MAX_CACHED = 20_000;

/** Every legal move in `fen` (verbose, with `after`); [] for an invalid FEN. Do not mutate the result. */
export function legalMoves(fen: string): Move[] {
  let list = MOVES.get(fen);
  if (list) return list;
  list = board(fen)?.moves({ verbose: true }) ?? [];
  if (MOVES.size >= MAX_CACHED) MOVES.clear();
  MOVES.set(fen, list);
  return list;
}

function fits(mv: Move, s: MoveSpec): boolean {
  if (s.castle) {
    const san = mv.san.replace(/[+#]$/, "");
    return san === (s.castle === "k" ? "O-O" : "O-O-O");
  }
  if (s.piece && mv.piece !== s.piece) return false;
  if (s.to && mv.to !== s.to) return false;
  if (s.fromFile && mv.from[0] !== s.fromFile) return false;
  if (s.fromRank && mv.from[1] !== s.fromRank) return false;
  if (s.capture && !mv.captured) return false;
  if (s.promotion) return mv.promotion === s.promotion;
  // A UCI or long-algebraic move without a promotion letter is not a promotion; SAN "e8" may be any.
  return !(s.exact && mv.promotion);
}

export function board(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** The same position with the other side to move (en passant cleared), for "plan" moves by one side. Null if invalid. */
export function flipTurn(fen: string): string | null {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) return null;
  parts[1] = parts[1] === "w" ? "b" : "w";
  parts[3] = "-";
  const flipped = parts.join(" ");
  return board(flipped) ? flipped : null;
}

export const uciOf = (mv: Move): string => mv.from + mv.to + (mv.promotion ?? "");

export function isSquare(s: unknown): s is Square {
  return typeof s === "string" && /^[a-h][1-8]$/.test(s);
}

/** Positions of the game: the start position and the position after each history move. */
export function historyFens(history: string[]): string[] {
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const uci of history) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
    } catch {
      break;
    }
    fens.push(chess.fen());
  }
  return fens;
}

/** Plays a UCI move; null when illegal. */
export function playUci(fen: string, uci: string): { move: Move; fen: string } | null {
  const chess = board(fen);
  if (!chess || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  try {
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) });
    return { move, fen: chess.fen() };
  } catch {
    return null;
  }
}
