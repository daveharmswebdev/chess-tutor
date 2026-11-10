import type { Color } from "@chess-tutor/chess-core";
import type { Chess } from "chess.js";
import { boardOf, isUci, normalizeSan, playSan, playUci, sideToMove, uciOf } from "./chess-util.ts";
import { positionKey, type Evidence } from "./evidence.ts";
import type { EvalEntry, TutorDraft } from "./schema.ts";

/**
 * The FR-10 check: the tutor may only name moves and evaluations that this turn's tool results
 * or the key-moment data gave it (moves already played in the game may be mentioned too).
 *
 * Move mentions recognised (a mention must stand alone: a letter, digit or hyphen directly
 * before or after it means it is part of a longer word, e.g. UCI "g1f3", "O-Oh", "10-0"):
 * - SAN: piece moves (Nf3, Bxe5, Nbd7, R1e2), pawn captures (exd5), promotions (e8=Q, b1N),
 *   castling (O-O, O-O-O, 0-0), optional + or #; also figurines (♘f3) and lowercase piece
 *   letters (nf6; a lowercase "b" followed by "x" is a pawn capture).
 * - Long algebraic: Nb1-c3, Bc4xf7, e2-e4.
 * - "<piece name> [goes/moves/...] to <square>": "Knight to g4", "the pawn to e5".
 * - A bare square counts as a pawn move only in a move context: followed by ! ? + #
 *   ("h5!", "e6?!"), after push/play/advance/try/consider ("push h5"), or after a move number
 *   ("12.h4", "12...h5", "...h5"). Elsewhere a square is just a square ("the e5 square").
 *   A square in a move context that is no legal move anywhere is treated as a square.
 */

const PIECE_CHARS: Record<string, string> = { "♔": "K", "♕": "Q", "♖": "R", "♗": "B", "♘": "N", "♚": "K", "♛": "Q", "♜": "R", "♝": "B", "♞": "N" };
const FIG = "♔♕♖♗♘♚♛♜♝♞";
const END = "(?![A-Za-z0-9-])";
const START = "(?<![A-Za-z0-9-])";

type Resolver = (chess: Chess) => string[];

interface Mention {
  raw: string;
  start: number;
  end: number;
  /** Lower wins on a tie. */
  priority: number;
  /** A square in a move context: ignored when it is no legal move anywhere. */
  soft: boolean;
  resolve: Resolver;
}

function sanResolver(san: string): Resolver {
  return (chess) => {
    const m = playSan(chess, san);
    return m ? [uciOf(m)] : [];
  };
}

const LAN = new RegExp(`${START}([KQRBN${FIG}])?([a-h][1-8])([-x])([a-h][1-8])(?:=?([QRBNqrbn]))?[+#]?${END}`, "g");
const SAN = new RegExp(
  `${START}(?:O-O-O|O-O|0-0-0|0-0|[KQRBN${FIG}][a-h]?[1-8]?x?[a-h][1-8]|(?:[kqrn]|b(?!x))[a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][18]=?[QRBN])[+#]?${END}`,
  "g",
);
const PIECE_TO = new RegExp(
  `\\b(king|queen|rook|bishop|knight|pawn)\\s+(?:(?:goes|went|jumps|jumped|moves|moved|move|comes|came)\\s+)?to\\s+([a-h][1-8])${END}`,
  "gi",
);
const SQUARE_ANNOTATED = new RegExp(`${START}([a-h][1-8])(?=[!?+#])`, "g");
const SQUARE_AFTER_VERB = new RegExp(
  `\\b(?:push(?:es|ed|ing)?|play(?:s|ed|ing)?|advanc(?:e|es|ed|ing)|tr(?:y|ies|ied|ying)|consider(?:s|ed|ing)?)\\s+([a-h][1-8])${END}`,
  "gi",
);
const SQUARE_AFTER_NUMBER = new RegExp(`(?:(?<![\\w.])\\d+\\.(?:\\.\\.)?\\s?|(?<![\\w.])\\.\\.\\.\\s?)([a-h][1-8])${END}`, "g");

const PIECE_NAMES: Record<string, string> = { king: "k", queen: "q", rook: "r", bishop: "b", knight: "n", pawn: "p" };

function findMentions(text: string): Mention[] {
  const found: Mention[] = [];
  for (const m of text.matchAll(LAN)) {
    const [raw, piece, from, , to, promo] = m as unknown as [string, string | undefined, string, string, string, string | undefined];
    const uci = from + to + (promo ? promo.toLowerCase() : "");
    const want = piece ? (PIECE_CHARS[piece] ?? piece).toLowerCase() : null;
    found.push({
      raw,
      start: m.index,
      end: m.index + raw.length,
      priority: 0,
      soft: false,
      resolve: (chess) => {
        const p = chess.get(from as never);
        if (!p || (want !== null && p.type !== want)) return [];
        return playUci(chess, uci) ? [uci] : [];
      },
    });
  }
  for (const m of text.matchAll(SAN)) {
    const raw = m[0];
    let san = raw.replace(/^[♔♕♖♗♘♚♛♜♝♞]/, (c) => PIECE_CHARS[c]!);
    if (/^[kqrbn]/.test(san) && !/^b?x/.test(san)) san = san[0]!.toUpperCase() + san.slice(1);
    found.push({ raw, start: m.index, end: m.index + raw.length, priority: 1, soft: false, resolve: sanResolver(san) });
  }
  for (const m of text.matchAll(PIECE_TO)) {
    const piece = PIECE_NAMES[m[1]!.toLowerCase()]!;
    const to = m[2]!;
    found.push({
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      priority: 2,
      soft: false,
      resolve: (chess) =>
        chess
          .moves({ verbose: true })
          .filter((mv) => mv.piece === piece && mv.to === to)
          .map(uciOf),
    });
  }
  for (const re of [SQUARE_ANNOTATED, SQUARE_AFTER_VERB, SQUARE_AFTER_NUMBER]) {
    for (const m of text.matchAll(re)) {
      const square = m[1]!;
      const start = m.index + m[0].length - square.length;
      found.push({ raw: square, start, end: start + 2, priority: 3, soft: true, resolve: sanResolver(square) });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || a.priority - b.priority);
  const kept: Mention[] = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    kept.push(f);
    lastEnd = f.end;
  }
  return kept;
}

export function extractMoveTokens(text: string): string[] {
  return findMentions(text).map((m) => m.raw);
}

/** An evaluation quoted in prose, as the claims check reads it (#26). */
export interface EvalMention {
  raw: string;
  quote:
    | { kind: "signed"; cp: number; tolerance: number } // White's point of view
    | { kind: "size"; cp: number; tolerance: number } // no sign: a size, either side
    | { kind: "mate"; n: number; white: number | null }; // white: a signed "+M3" / "-M3" in White's view
}

/**
 * Evaluation-like numbers in prose (#26). Every one must be backed by an entry in `evals`.
 *
 * A number is evaluation-like when it is
 * - signed: "+0.4", "-1.5", "−2", "–2" (en dash), "+2 pawns", "+150 cp";
 * - a decimal with "pawn(s)" or no unit: "1.5 pawns", "a 1.5-pawn edge", "the engine gives 1.8";
 * - in centipawns: "150 cp", "90 centipawns";
 * - a mate: "mate in 3", "mated in 3", "M3", "#3"; a signed one ("+M3", "-M3") is read from
 *   White's point of view like a signed number: +M3 = White mates in 3, -M3 = Black does.
 * Not evaluation-like: a whole number of pawns without a sign ("up 2 pawns in material", "down
 * 1 pawn": material counts), any other whole number ("3 moves", "move 12"), clock and score
 * phrases ("10.5 seconds", "1:30", "0.5 points", "2.5/3", "1-0", "1/2-1/2"), percentages, and
 * numbers in words. There are no word lists beyond these units: whether a side is "better" or
 * "worse" is not read from the prose, only the number.
 *
 * `tolerance` is the rounding of the written number: half its last digit ("+1.5" covers 145 to
 * 155 cp, "+2" covers 150 to 250, "150 cp" is exact).
 */
const NUMBER = /(?<![\w.\/:+\-−–])([+\-−–])?(\d+(?:\.(\d+))?)(?!\d|\.\d|%|\/|:\d)/g;
const EVAL_UNIT = /^\s*(?:-\s*)?(cp|centipawns?|pawns?)\b/i;
const OTHER_UNIT = /^\s*(?:-\s*)?(?:s|secs?|seconds?|mins?|minutes?|hours?|hrs?|ms|points?|pts|percent)\b/i;
const MATE_QUOTES = [/\bmated? in (\d+)\b/gi, /(?<![\w#])([+\-−–]?)M(\d+)\b/g, /(?<![\w#])#(\d+)\b/g];

export function extractEvals(text: string): EvalMention[] {
  const found: (EvalMention & { start: number; end: number })[] = [];
  for (const re of MATE_QUOTES) {
    for (const m of text.matchAll(re)) {
      const sign = m.length > 2 ? m[1] : "";
      const n = Number(m[m.length - 1]);
      const white = sign ? (sign === "+" ? n : -n) : null;
      found.push({ raw: m[0], start: m.index, end: m.index + m[0].length, quote: { kind: "mate", n, white } });
    }
  }
  for (const m of text.matchAll(NUMBER)) {
    const [num, sign, digits, decimals] = m as unknown as [string, string | undefined, string, string | undefined];
    const after = text.slice(m.index + num.length);
    if (OTHER_UNIT.test(after)) continue;
    const unitMatch = EVAL_UNIT.exec(after);
    const unit = unitMatch?.[1]?.toLowerCase() ?? "";
    const centipawns = unit.startsWith("c");
    if (!sign && !decimals && !centipawns) continue; // a whole number of pawns, or a plain count
    const raw = unitMatch ? num + unitMatch[0] : num;
    const cp = centipawns ? Number(digits) : Math.round(Number(digits) * 100);
    const tolerance = centipawns ? 0.5 : 50 / 10 ** (decimals?.length ?? 0);
    const quote = sign
      ? { kind: "signed" as const, cp: (sign === "+" ? 1 : -1) * cp, tolerance }
      : { kind: "size" as const, cp, tolerance };
    found.push({ raw, start: m.index, end: m.index + raw.length, quote });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: EvalMention[] = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    kept.push({ raw: f.raw, quote: f.quote });
    lastEnd = f.end;
  }
  return kept;
}

/** Whether a prose quote is backed by one of the listed entries (#26). */
function listed(quote: EvalMention["quote"], evals: EvalEntry[]): boolean {
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9;
  return evals.some((e) => {
    const white = e.side === "white" ? 1 : -1;
    if (quote.kind === "mate") {
      if (e.mate === null) return false;
      return quote.white !== null ? white * e.mate === quote.white : Math.abs(e.mate) === quote.n;
    }
    if (e.cp === null) return false;
    if (quote.kind === "signed") return near(quote.cp, white * e.cp, quote.tolerance);
    return near(quote.cp, Math.abs(e.cp), quote.tolerance);
  });
}

function describeEntry(e: EvalEntry): string {
  return e.cp !== null ? `{side: "${e.side}", cp: ${e.cp}}` : `{side: "${e.side}", mate: ${e.mate}}`;
}

const SIDE_WORD = "white|black|your opponent|the opponent|opponent|you";

/** The text of the clause that ends at `index`: after the last sentence break (". ", "; ", "! ", "? ", newline). */
function clauseBefore(text: string, index: number): string {
  const before = text.slice(0, index);
  let cut = 0;
  for (const m of before.matchAll(/[.!?;](?=\s)|\n/g)) cut = m.index + 1;
  return before.slice(cut);
}

function sideOf(word: string | undefined, playerColor: Color | undefined): Color | null {
  if (!word) return null;
  const w = word.toLowerCase();
  if (w === "white") return "w";
  if (w === "black") return "b";
  if (!playerColor) return null;
  if (w === "you") return playerColor;
  return playerColor === "w" ? "b" : "w"; // the opponent
}

/** "3.", "3. ", "3...", "3... " right before a move: groups 1 (+2 for Black's dots) or 3 ("3 ..."). */
const MOVE_NUMBER_BEFORE = /(?<![\w.])(?:(\d+)\.(\.\.)?|(\d+)\s+\.\.\.)\s*$/;
/** A side right before a move as its mover: "White castled with ", "your opponent's ", "Black ". */
const MOVER_BEFORE = new RegExp(
  `\\b(${SIDE_WORD}|your)(?:['’]s)?\\s+(?:(?!(?:is|are|was|were|be|been|and|but|or|so|if|then|now)\\b)[a-z]+\\s+){0,3}$`,
  "i",
);

/**
 * The side named as the mover right before a move mention (`before` is the text up to it):
 * "White played ", "your opponent's ", "Black castled with ". Null when no side is named or a
 * copula or comma breaks the link. Shared with the eval graders (evals/src/graders.ts, #29).
 */
export function moverOf(before: string, playerColor: Color | undefined): Color | null {
  const clause = clauseBefore(before, before.length);
  const m = MOVER_BEFORE.exec(clause.slice(clause.lastIndexOf(",") + 1));
  if (!m) return null;
  return sideOf(m[1]!.toLowerCase() === "your" ? "you" : m[1], playerColor);
}

const PIECE_NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
/** A check named as a thing to find or give (the same phrases the eval grader uses, evals/src/graders.ts). */
const CHECK_NOUN =
  /\b(?:a|give|gives|giving|gave|with|deliver|delivers|delivering)\s+check\b|\b(?:king|queen|rook|bishop|knight|pawn)\s+checks?\b|\bcheck(?:s|ed|ing)?\s+(?:with|from|by)\b|\bchecks?\s+(?:the|black's|white's|your opponent's)\s+king\b/i;

/**
 * Returns the problems with a schema-valid reply; empty means it passes FR-10 and the FR-8 rule
 * that neither message nor arrows give the answer away. `revealFen` is where revealMove must be
 * legal (attemptFen for a key moment, fen for a hint); it counts as a focus position.
 *
 * Moves: a mention passes when, in some shown position where it is legal, that (position, move)
 * is backed by a tool result or the key-moment data. Failing that, a move of the game's history
 * may be mentioned, but only if the mention is not also a legal move in a focus position: there
 * the tutor is talking about what to play now, and the history does not back that. Two readings
 * narrow that (#26):
 * - A move number before the mention ("3.Bf4", "3...Bg7") points at that ply of the game: if
 *   the mention is the move played there, it passes, even when it is also legal now.
 * - A side named as the mover just before it ("White castled with O-O", "your opponent's O-O")
 *   limits the positions to those where that side moves (when it is legal in any of them).
 *   "you"/"your opponent" need `playerColor`. A copula or a comma in between breaks the link
 *   ("White is fine, so O-O" names no mover).
 *
 * Evaluations (#26): every `evals` entry must be exactly an engine score of this turn for its
 * side (Evidence.backsEntry), and every evaluation-like number in message or reveal (see
 * extractEvals) must match a listed entry: a signed number read from White's point of view
 * against the entry converted to White's view, an unsigned one against an entry's size, "mate
 * in N" against a mate entry with |mate| = N. An unsigned number may instead be a change of this
 * turn (the key moment's cpLoss / gainCp, evaluate_move's cp_loss) quoted as a size, within the
 * same rounding (FR-10 A2): "That cost you 1.6 pawns". A change never backs an entry or a signed
 * number ("You are -1.6" is an evaluation).
 *
 * Give-aways (FR-8, #28), when revealMove is set: the message names the move; an arrow is the
 * move or starts on its from-square (it shows the piece); or the answer gives check and the
 * message names its piece together with a check ("can your queen give a check?").
 */
export function checkClaims(reply: TutorDraft, evidence: Evidence, revealFen: string, playerColor?: Color): string[] {
  const problems: string[] = [];
  const positions = evidence.positionList();
  if (boardOf(revealFen) && !positions.some((p) => positionKey(p) === positionKey(revealFen))) positions.push(revealFen);
  const isFocus = (fen: string) => evidence.isFocus(fen) || positionKey(fen) === positionKey(revealFen);
  const seen = new Set<string>();

  for (const entry of reply.evals) {
    if (evidence.backsEntry(entry)) continue;
    const size = entry.cp ?? 0;
    const delta = entry.cp !== null && evidence.isDelta(size)
      ? ` ${Math.abs(size)} is a change (cp_loss or gain_cp), not an evaluation: never list a change in evals; quote it in the text as an unsigned size ("about 1.6 pawns").`
      : "";
    problems.push(
      `evals quotes the evaluation ${describeEntry(entry)}, which matches no engine score for ${entry.side === "white" ? "White" : "Black"} in this turn's tool results. ` +
        `Copy the number exactly as a tool gave it, from that side's point of view (positive = good for that side).${delta}`,
    );
  }

  for (const [field, text] of [
    ["message", reply.message],
    ["reveal", reply.reveal ?? ""],
  ] as const) {
    for (const mention of findMentions(text)) {
      const before = text.slice(0, mention.start);
      const numbered = MOVE_NUMBER_BEFORE.exec(before);
      if (numbered) {
        const ply = evidence.historyPly(Number(numbered[1] ?? numbered[3]), numbered[1] && !numbered[2] ? "w" : "b");
        const board = ply ? boardOf(ply.fen) : null;
        if (ply && board && mention.resolve(board).includes(ply.uci)) continue; // the game's move at that number
      }
      const mover = moverOf(before, playerColor);
      const key = `${field}:${mover ?? ""}:${mention.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let legal: { fen: string; uci: string }[] = [];
      for (const fen of positions) {
        const chess = boardOf(fen);
        if (chess) for (const uci of mention.resolve(chess)) legal.push({ fen, uci });
      }
      if (mover) {
        const own = legal.filter((l) => sideToMove(l.fen) === mover);
        if (own.length > 0) legal = own;
      }
      if (legal.length === 0) {
        if (!mention.soft) problems.push(`${field} mentions ${mention.raw}, which is not legal in any position you were shown.`);
        continue;
      }
      const backed =
        legal.some((l) => evidence.backsMove(l.fen, l.uci)) ||
        (!legal.some((l) => isFocus(l.fen)) && legal.some((l) => evidence.inHistory(l.fen, l.uci)));
      if (!backed) {
        problems.push(`${field} mentions ${mention.raw}, which does not appear in this turn's tool results or the key-moment data.`);
      }
    }
    for (const e of extractEvals(text)) {
      if (listed(e.quote, reply.evals)) continue;
      if (e.quote.kind === "size" && evidence.backsChange(e.quote.cp, e.quote.tolerance)) continue; // a quoted change (FR-10 A2)
      const delta = e.quote.kind === "signed" && evidence.backsChange(e.quote.cp, e.quote.tolerance)
        ? " If it is a cp_loss or gain_cp, that is a change, not an evaluation: quote it without a + or - sign."
        : "";
      problems.push(
        `${field} quotes the evaluation "${e.raw}", which no entry in evals backs. List every evaluation you quote in evals; ` +
          `in the text a signed number (+1.5, -0.4) is read from White's point of view.${delta}`,
      );
    }
  }

  if (reply.revealMove !== null) {
    const uci = reply.revealMove;
    const chess = boardOf(revealFen);
    const move = isUci(uci) && chess ? playUci(chess, uci) : null;
    if (!isUci(uci)) {
      problems.push(`revealMove "${uci}" is not a legal UCI move (use from-square + to-square, e.g. "g1f3").`);
    } else if (!move) {
      problems.push(`revealMove "${uci}" is not a legal move in the position where the player moves.`);
    } else {
      if (!evidence.backsMove(revealFen, uci)) {
        problems.push(`revealMove "${uci}" (${move.san}) is not backed by this turn's tool results or the key-moment data for this position.`);
      }
      // A mention whose named mover is the side not to move here describes the opponent's move
      // ("White pushed a pawn to e5"), not the answer (review 047).
      const toMove = sideToMove(revealFen);
      const named = findMentions(reply.message).some((m) => {
        const mover = moverOf(reply.message.slice(0, m.start), playerColor);
        if (mover !== null && mover !== toMove) return false;
        const board = boardOf(revealFen);
        return board !== null && m.resolve(board).includes(uci);
      });
      if (named) problems.push(`message names ${normalizeSan(move.san)}, which gives the answer away: keep it for reveal.`);
      if (/[+#]$/.test(move.san)) {
        const piece = PIECE_NAME[move.piece]!;
        if (new RegExp(`\\b${piece}s?\\b`, "i").test(reply.message) && CHECK_NOUN.test(reply.message)) {
          problems.push(
            `message names your ${piece} together with the check it gives (${move.san}), which gives the answer away: ask about the idea (the king, a loose piece) instead.`,
          );
        }
      }
      const from = uci.slice(0, 2);
      for (const a of reply.arrows) {
        if (a.from + a.to === uci.slice(0, 4)) {
          problems.push(`arrow ${a.from}-${a.to} is the answer move, which gives the answer away before "Show me".`);
        } else if (a.from === from) {
          problems.push(`arrow ${a.from}-${a.to} starts on ${from}, the square of the piece the answer moves, which gives the answer away before "Show me".`);
        }
      }
    }
  }

  return problems;
}
