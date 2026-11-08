import type { Color, KeyMoment } from "@chess-tutor/chess-core";
import { TutorReply } from "@chess-tutor/tutor";
import { board, findMentions, flipTurn, historyFens, isSquare, playUci, resolve, uciOf, type Mention } from "./notation.ts";

/**
 * Deterministic graders for one tutor reply (architecture §5): NFR-6 (moves legal, quoted
 * evaluations backed), NFR-7 (the first message and the arrows keep the answer back), the
 * schema, and the reveal move. They see only the case, the reply and this ask's tool results,
 * and use chess.js, never packages/tutor internals.
 *
 * Out of reach for these graders (needs an LLM judge later): false positional claims such as
 * "the bishop pins the knight on f6" when a pawn blocks the diagonal, and a give-away in plain
 * words that names neither the move nor the piece-and-check pattern below.
 */

/** One tool call of this ask with what the tool answered (content as the model saw it). */
export interface ToolResultRecord {
  /** tool_use id */
  id?: string;
  name: string;
  input: unknown;
  content: string;
  isError: boolean;
}

export interface GradeInput {
  kind: TutorReply["kind"];
  playerColor: Color;
  /** UCI from the start position, including the triggering move. */
  history: string[];
  fen: string;
  attemptFen: string;
  moment: KeyMoment | null;
  /** Engine best move (UCI) at attemptFen, from the frozen case. */
  engineBest: string | null;
  reply: TutorReply;
  toolResults: ToolResultRecord[];
  /** Centipawn loss of revealMove against engineBest, measured by the runner; null if not measured. */
  revealCpLoss: number | null;
  /** config/tutor.json tutor.attemptToleranceCp */
  toleranceCp: number;
}

export interface MentionGrade {
  field: "message" | "reveal";
  raw: string;
  legal: boolean;
}
export interface MovesGrade {
  pass: boolean;
  mentions: MentionGrade[];
  illegal: string[];
}

/** Positions a mention may refer to: the game's positions, fen and attemptFen. */
function basePositions(input: GradeInput): string[] {
  return unique([...historyFens(input.history), input.fen, input.attemptFen]);
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

const MAX_POSITIONS = 400;

/**
 * NFR-6, moves: every move named in `message` and `reveal` must be legal in a position of the
 * case (the game's positions, fen, attemptFen) or in one reached by moves named earlier in the
 * same field (so "Bxd6 exd6" and "g6, then Bg7 and O-O" read as lines). Either side may be to
 * move: explanations often give one side's plan ("g6, Bg7, O-O") without the replies.
 */
export function gradeMoves(input: GradeInput): MovesGrade {
  const mentions: MentionGrade[] = [];
  for (const field of ["message", "reveal"] as const) {
    const text = input.reply[field];
    if (!text) continue;
    let positions = basePositions(input);
    for (const m of findMentions(text)) {
      const reached: string[] = [];
      for (const fen of positions) {
        for (const variant of [fen, flipTurn(fen)]) {
          if (!variant) continue;
          for (const mv of resolve(variant, m.spec)) {
            const after = playUci(variant, uciOf(mv));
            if (after) reached.push(after.fen);
          }
        }
      }
      mentions.push({ field, raw: m.raw, legal: reached.length > 0 });
      positions = unique([...positions, ...reached]).slice(0, MAX_POSITIONS);
    }
  }
  const illegal = mentions.filter((m) => !m.legal).map((m) => m.raw);
  return { pass: illegal.length === 0, mentions, illegal };
}

export interface ArrowsGrade {
  pass: boolean;
  problems: string[];
}

/** Arrows are well formed: at most 3, each between two distinct real squares, no duplicates (FR-11). */
export function gradeArrows(reply: Pick<TutorReply, "arrows">): ArrowsGrade {
  const problems: string[] = [];
  const arrows = Array.isArray(reply.arrows) ? reply.arrows : [];
  if (arrows.length > 3) problems.push(`${arrows.length} arrows (max 3)`);
  const seen = new Set<string>();
  for (const a of arrows) {
    const label = `${a.from}->${a.to}`;
    if (!isSquare(a.from) || !isSquare(a.to)) problems.push(`arrow ${label} is not between two squares`);
    else if (a.from === a.to) problems.push(`arrow ${label} starts and ends on the same square`);
    if (seen.has(label)) problems.push(`arrow ${label} appears twice`);
    seen.add(label);
  }
  return { pass: problems.length === 0, problems };
}

export interface GiveAwayGrade {
  pass: boolean;
  problems: string[];
}

const PIECE_NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const CHECK_NOUN = /\b(?:a|give|gives|giving|gave|with|deliver|delivers|delivering)\s+check\b|\bcheck\s+(?:with|from)\b|\bchecks?\s+(?:the|black's|white's|your opponent's)\s+king\b/i;

const coords = (sq: string) => ({ f: sq.charCodeAt(0) - 97, r: Number(sq[1]) - 1 });

/** True when the arrow lies on the straight line of the move and covers its destination. */
function alongLine(from: string, to: string, a: { from: string; to: string }): boolean {
  const m0 = coords(from);
  const m1 = coords(to);
  const df = m1.f - m0.f;
  const dr = m1.r - m0.r;
  if (!(df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr))) return false; // knight moves have no line
  const onLine = (p: { f: number; r: number }) => (p.f - m0.f) * dr - (p.r - m0.r) * df === 0;
  const a0 = coords(a.from);
  const a1 = coords(a.to);
  if (!onLine(a0) || !onLine(a1)) return false;
  const within = (x: number, lo: number, hi: number) => x >= Math.min(lo, hi) && x <= Math.max(lo, hi);
  return within(m1.f, a0.f, a1.f) && within(m1.r, a0.r, a1.r);
}

/**
 * NFR-7: the first message and the pre-reveal arrows must not give away revealMove.
 * - The message names revealMove in any notation (SAN, UCI, long algebraic, "bishop to d3",
 *   or a pawn move's square in a move context).
 * - The message names the answer's piece and a check, when the answer gives check
 *   ("can a check with your other bishop ...").
 * - An arrow equals the move, starts on its from-square, ends on its to-square, runs along its
 *   line through the to-square, or starts on its (empty) to-square.
 */
export function gradeGiveAway(input: GradeInput): GiveAwayGrade {
  const problems: string[] = [];
  const answer = input.reply.revealMove;
  if (!answer) return { pass: true, problems };
  const attempt = input.kind === "hint" ? input.fen : input.attemptFen;
  const played = playUci(attempt, answer);
  const from = answer.slice(0, 2);
  const to = answer.slice(2, 4);

  for (const m of findMentions(input.reply.message)) {
    if (namesMove(attempt, m, answer)) problems.push(`message names the answer ${answer} as "${m.raw}"`);
  }
  if (played?.move.san.endsWith("+") || played?.move.san.endsWith("#")) {
    const piece = PIECE_NAME[played.move.piece]!;
    if (new RegExp(`\\b${piece}s?\\b`, "i").test(input.reply.message) && CHECK_NOUN.test(input.reply.message)) {
      problems.push(`message names the answer's piece (${piece}) and the check it gives (${played.move.san})`);
    }
  }

  const empty = board(attempt)?.get(to as never) === undefined;
  for (const a of input.reply.arrows) {
    if (!isSquare(a.from) || !isSquare(a.to) || !isSquare(from) || !isSquare(to)) continue;
    const label = `arrow ${a.from}->${a.to}`;
    if (a.from === from && a.to === to) problems.push(`${label} is the answer ${answer}`);
    else if (a.from === from) problems.push(`${label} starts on the answer's from-square ${from}`);
    else if (a.to === to) problems.push(`${label} ends on the answer's to-square ${to}`);
    else if (alongLine(from, to, a)) problems.push(`${label} runs along the answer's line through ${to}`);
    else if (a.from === to && empty) problems.push(`${label} starts on the answer's empty to-square ${to}`);
  }
  return { pass: problems.length === 0, problems };
}

function namesMove(fen: string, m: Mention, uci: string): boolean {
  if (resolve(fen, m.spec).some((mv) => uciOf(mv) === uci)) return true;
  // The answer named in a form that does not resolve here (e.g. UCI text), compared as text.
  return m.raw.replace(/[+#!?]+$/, "").toLowerCase() === uci;
}

export interface EvalQuote {
  raw: string;
  /** Centipawns (pawns x 100) or null for a mate quote. */
  cp: number | null;
  mate: number | null;
  /** The side the quote is credited to, when the text names one with a direction. */
  side: Color | null;
  problem: "unmatched" | "wrong_side" | null;
}
export interface EvalsGrade {
  pass: boolean;
  quotes: EvalQuote[];
}

interface EvalEvidence {
  /** White-POV centipawns. */
  signed: number[];
  /** Magnitudes without a side: cp_loss, gain, key-moment data. */
  magnitude: number[];
  mates: number[];
}

/** Scores the tutor was given this turn: tool results (parsed JSON) and the key-moment data. */
export function evalEvidence(input: Pick<GradeInput, "toolResults" | "moment">): EvalEvidence {
  const ev: EvalEvidence = { signed: [], magnitude: [], mates: [] };
  const walk = (v: unknown, pov: Color) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, pov));
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const here: Color = o["eval_pov"] === "black" ? "b" : o["eval_pov"] === "white" ? "w" : pov;
    for (const [k, x] of Object.entries(o)) {
      if (typeof x === "number" && Number.isFinite(x)) {
        if (k === "eval_cp") ev.signed.push(here === "w" ? x : -x);
        else if (k === "mate_in") ev.mates.push(Math.abs(x));
        else if (k === "cp_loss" || k === "gain_cp") ev.magnitude.push(Math.abs(x));
      } else walk(x, here);
    }
  };
  for (const t of input.toolResults) {
    if (t.isError) continue;
    try {
      walk(JSON.parse(t.content), "w");
    } catch {
      // not JSON: nothing to read
    }
  }
  const m = input.moment;
  if (m?.kind === "player_blunder") ev.magnitude.push(m.cpLoss);
  if (m?.kind === "missed_win" || m?.kind === "punish_opponent") ev.magnitude.push(m.gainCp);
  return ev;
}

/** 0.3 pawns: engine scores drift and the tutor rounds (the tutor's own claims check uses the same). */
const EVAL_TOLERANCE_CP = 30;

const QUOTE =
  /(?<![\w.])(?:mate in (\d+)|([+\-−])?(\d+(?:\.\d+)?)\s*(pawns?|centipawns?|cp)\b|([+\-−])(\d+(?:\.\d+)?)(?!\w|\.\d))/gi;
const SIDE = /\b(white|black|you|your|you're|you are|opponent|opponent's)\b/gi;
const UP = /\b(up|ahead|better|advantage|edge|winning|plus)\b/i;
const DOWN = /\b(down|behind|worse|losing|minus)\b/i;

/**
 * NFR-6, evaluations (FR-10): every quoted evaluation (+1.5, 1.5 pawns, 150 cp / centipawns,
 * mate in N) must match a score from this ask's tool results or the key-moment data, within
 * 0.3 pawns (0.5 for a whole number of pawns). Sign-aware where the sentence names a side and a
 * direction ("Black is up 1.5", "+1.5 for White", "you are down 2 pawns"): such a quote must
 * match a White-relative engine score for that side; matching only the other side's score is
 * "wrong_side". Without a side, any score's size, a centipawn loss or a gain may back it.
 */
export function gradeEvals(input: GradeInput): EvalsGrade {
  const ev = evalEvidence(input);
  const quotes: EvalQuote[] = [];
  for (const field of ["message", "reveal"] as const) {
    const text = input.reply[field];
    if (!text) continue;
    for (const m of text.matchAll(QUOTE)) {
      const raw = m[0];
      if (m[1] !== undefined) {
        const n = Number(m[1]);
        quotes.push({ raw, cp: null, mate: n, side: null, problem: ev.mates.includes(n) ? null : "unmatched" });
        continue;
      }
      const sign = m[2] ?? m[5];
      const num = m[3] ?? m[6]!;
      const unit = (m[4] ?? "").toLowerCase();
      const size = unit.startsWith("c") ? Number(num) : Number(num) * 100;
      const tol = !unit.startsWith("c") && !num.includes(".") ? 50 : EVAL_TOLERANCE_CP;
      const near = (a: number, b: number) => Math.abs(a - b) <= tol + 1e-9;
      const { side, direction } = sideOf(text, m.index!, raw.length, input.playerColor, sign);
      let problem: EvalQuote["problem"] = null;
      if (side !== null && direction !== 0) {
        const white = (side === "w" ? 1 : -1) * direction * size;
        if (ev.signed.some((e) => near(e, white))) problem = null;
        else if (ev.signed.some((e) => near(e, -white))) problem = "wrong_side";
        else if (ev.magnitude.some((e) => near(e, size))) problem = null;
        else problem = "unmatched";
      } else {
        const all = [...ev.signed.map(Math.abs), ...ev.magnitude];
        problem = all.some((e) => near(e, size)) ? null : "unmatched";
      }
      quotes.push({ raw, cp: size * (sign === "-" || sign === "−" ? -1 : 1), mate: null, side, problem });
    }
  }
  return { pass: quotes.every((q) => q.problem === null), quotes };
}

/** The side named nearest to the quote in its sentence, and the direction (+1 up, -1 down, 0 none). */
function sideOf(text: string, at: number, len: number, player: Color, sign: string | undefined): { side: Color | null; direction: number } {
  const startSentence = Math.max(text.lastIndexOf(". ", at), text.lastIndexOf("! ", at), text.lastIndexOf("? ", at), text.lastIndexOf("; ", at)) + 1;
  const endMatch = /[.!?;](?:\s|$)/.exec(text.slice(at + len));
  const sentence = text.slice(startSentence, endMatch ? at + len + endMatch.index : text.length);
  const rel = at - startSentence;
  let side: Color | null = null;
  let best = Infinity;
  for (const s of sentence.matchAll(SIDE)) {
    const d = Math.abs(s.index! - rel);
    if (d >= best) continue;
    best = d;
    const w = s[1]!.toLowerCase();
    side = w === "white" ? "w" : w === "black" ? "b" : w.startsWith("opponent") ? (player === "w" ? "b" : "w") : player;
  }
  let direction = 0;
  if (sign === "+") direction = 1;
  else if (sign === "-" || sign === "−") direction = -1;
  else if (UP.test(sentence)) direction = 1;
  else if (DOWN.test(sentence)) direction = -1;
  return { side, direction };
}

export interface RevealGrade {
  pass: boolean;
  /** revealMove is legal where the attempt is graded. */
  legal: boolean;
  equalsBest: boolean;
  cpLoss: number | null;
  problems: string[];
}

/** revealMove is legal at attemptFen (fen for a hint) and is the engine's best or within the tolerance of it. */
export function gradeReveal(input: GradeInput): RevealGrade {
  const attempt = input.kind === "hint" ? input.fen : input.attemptFen;
  const move = input.reply.revealMove;
  if (!move) return { pass: false, legal: false, equalsBest: false, cpLoss: null, problems: ["no revealMove"] };
  const legal = playUci(attempt, move) !== null;
  if (!legal) return { pass: false, legal, equalsBest: false, cpLoss: null, problems: [`revealMove ${move} is illegal at the attempt position`] };
  const equalsBest = input.engineBest !== null && move === input.engineBest;
  const cpLoss = equalsBest ? 0 : input.revealCpLoss;
  const problems: string[] = [];
  if (!equalsBest) {
    if (cpLoss === null) problems.push(`revealMove ${move} is not the engine's best ${input.engineBest ?? "?"} and was not measured`);
    else if (cpLoss > input.toleranceCp) problems.push(`revealMove ${move} loses ${cpLoss} cp against ${input.engineBest} (tolerance ${input.toleranceCp})`);
  }
  return { pass: problems.length === 0, legal, equalsBest, cpLoss, problems };
}

export interface SchemaGrade {
  pass: boolean;
  problems: string[];
}

export interface ReplyGrades {
  schema: SchemaGrade;
  moves: MovesGrade;
  evals: EvalsGrade;
  giveAway: GiveAwayGrade;
  arrows: ArrowsGrade;
  reveal: RevealGrade;
  /** NFR-6: every move named is legal and revealMove is legal at the attempt position. */
  nfr6Moves: boolean;
  /** NFR-6: every quoted evaluation is backed. */
  nfr6Evals: boolean;
  /** NFR-7: nothing gives the answer away before the reveal. */
  nfr7: boolean;
}

export function gradeReply(input: GradeInput): ReplyGrades {
  const parsed = TutorReply.safeParse(input.reply);
  const schemaProblems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  if (parsed.success && parsed.data.kind !== input.kind) schemaProblems.push(`kind ${parsed.data.kind}, expected ${input.kind}`);
  const moves = gradeMoves(input);
  const evals = gradeEvals(input);
  const giveAway = gradeGiveAway(input);
  const arrows = gradeArrows(input.reply);
  const reveal = gradeReveal(input);
  return {
    schema: { pass: schemaProblems.length === 0, problems: schemaProblems },
    moves,
    evals,
    giveAway,
    arrows,
    reveal,
    nfr6Moves: moves.pass && reveal.legal,
    nfr6Evals: evals.pass,
    nfr7: giveAway.pass,
  };
}
