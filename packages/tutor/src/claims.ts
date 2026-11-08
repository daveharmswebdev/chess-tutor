import type { Chess } from "chess.js";
import { boardOf, isUci, normalizeSan, playSan, playUci, uciOf } from "./chess-util.ts";
import type { TutorReply } from "./contract.ts";
import { positionKey, type Evidence } from "./evidence.ts";

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

export interface EvalMention {
  raw: string;
  quote: { cp: number } | { mate: number };
}

/**
 * Quoted evaluations: signed numbers (+4.2, -1.5: pawns), "N.N pawns", "N pawns up/down/ahead/
 * behind/better/worse", centipawns ("150 cp", "90 centipawns"), "mate in N" and "M3". Plain
 * numbers (3 moves, move 12, 1-0, 20%) and words ("two pawns up") are not evaluations here.
 */
const NUMBER = /(?<![\w.])([+\-−]?)(\d+(?:\.\d+)?)(\s*(?:cp|centipawns?)\b|\s*pawns?(?:\s+(?:up|down|ahead|behind|better|worse))?\b)?(?![\d%]|\.\d)/g;
const MATE_IN = /\bmate in (\d+)\b/gi;
const MATE_M = /(?<![\w])[+\-−]?M(\d+)\b/g;

export function extractEvals(text: string): EvalMention[] {
  const found: (EvalMention & { start: number })[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const [raw, sign, digits, unit] = m as unknown as [string, string, string, string | undefined];
    const value = Number(digits);
    const signed = sign !== "";
    if (unit && /c/.test(unit)) {
      found.push({ raw, start: m.index, quote: { cp: value } });
    } else if (unit) {
      if (signed || digits.includes(".") || /(up|down|ahead|behind|better|worse)$/.test(unit)) {
        found.push({ raw, start: m.index, quote: { cp: value * 100 } });
      }
    } else if (signed) {
      found.push({ raw, start: m.index, quote: { cp: value * 100 } });
    }
  }
  for (const re of [MATE_IN, MATE_M]) {
    for (const m of text.matchAll(re)) found.push({ raw: m[0], start: m.index, quote: { mate: Number(m[1]) } });
  }
  return found.sort((a, b) => a.start - b.start).map(({ raw, quote }) => ({ raw, quote }));
}

/**
 * Returns the problems with a schema-valid reply; empty means it passes FR-10 and the FR-8 rule
 * that neither message nor arrows give the answer away. `revealFen` is where revealMove must be
 * legal (attemptFen for a key moment, fen for a hint); it counts as a focus position.
 *
 * A move mention passes when, in some shown position where it is legal, that (position, move)
 * is backed by a tool result or the key-moment data. Failing that, a move of the game's history
 * may be mentioned, but only if the mention is not also a legal move in a focus position: there
 * the tutor is talking about what to play now, and the history does not back that.
 */
export function checkClaims(reply: TutorReply, evidence: Evidence, revealFen: string): string[] {
  const problems: string[] = [];
  const positions = evidence.positionList();
  if (boardOf(revealFen) && !positions.some((p) => positionKey(p) === positionKey(revealFen))) positions.push(revealFen);
  const isFocus = (fen: string) => evidence.isFocus(fen) || positionKey(fen) === positionKey(revealFen);
  const seen = new Set<string>();

  for (const [field, text] of [
    ["message", reply.message],
    ["reveal", reply.reveal ?? ""],
  ] as const) {
    for (const mention of findMentions(text)) {
      const key = `${field}:${mention.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const legal: { fen: string; uci: string }[] = [];
      for (const fen of positions) {
        const chess = boardOf(fen);
        if (chess) for (const uci of mention.resolve(chess)) legal.push({ fen, uci });
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
      if (!evidence.backsEval(e.quote)) {
        problems.push(`${field} quotes the evaluation "${e.raw}", which matches no score in this turn's tool results or the key-moment data.`);
      }
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
      const named = findMentions(reply.message).some((m) => {
        const board = boardOf(revealFen);
        return board !== null && m.resolve(board).includes(uci);
      });
      if (named) problems.push(`message names ${normalizeSan(move.san)}, which gives the answer away: keep it for reveal.`);
      const arrow = reply.arrows.find((a) => a.from + a.to === uci.slice(0, 4));
      if (arrow) problems.push(`arrow ${arrow.from}-${arrow.to} is the answer move, which gives the answer away before "Show me".`);
    }
  }

  return problems;
}
