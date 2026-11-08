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

/**
 * Positions a mention may refer to: the game's positions, fen, attemptFen, the position after
 * revealMove (a reveal explains the line that follows the answer), and every position along the
 * lines in this ask's tool results (engine lines, evaluate_move's reply line, explorer and
 * repertoire moves), each line played from the position its tool was asked about.
 */
export function basePositions(input: Pick<GradeInput, "history" | "fen" | "attemptFen" | "kind" | "reply" | "toolResults">): string[] {
  return unique([...historyFens(input.history), ...currentPositions(input)]);
}

/**
 * Positions a move described as played now or next may refer to (#29): fen, attemptFen, the
 * position after revealMove and the tool-line positions, but no earlier position of the game.
 */
export function currentPositions(input: Pick<GradeInput, "fen" | "attemptFen" | "kind" | "reply" | "toolResults">): string[] {
  const list = [input.fen, input.attemptFen];
  const attempt = input.kind === "hint" ? input.fen : input.attemptFen;
  const answer = input.reply.revealMove ? playUci(attempt, input.reply.revealMove) : null;
  if (answer) list.push(answer.fen);
  for (const t of input.toolResults) list.push(...toolLinePositions(t));
  return unique(list);
}

/**
 * The position before the last move of the game, if any. Only the side that made that move
 * plays there (no turn flip), so "Black's ...b6 weakened c6" and "After ...b6" read as the
 * opponent's last move without opening earlier positions to the player's moves (#29 round 2).
 */
export function lastMovePosition(history: string[]): string | null {
  const fens = historyFens(history);
  return fens.length >= 2 && fens.length === history.length + 1 ? fens[fens.length - 2]! : null;
}

// Tense of a move mention (#29). Past: the game so far ("you played Nd2", "Black castled"), so
// any position of the game may hold it. Present or none: now, next, a plan or a line, held to the
// current positions. Decided per clause: the last cue before the mention in its clause wins.
const PAST_CUE =
  /\b(?:played|went|moved|took|captured|castled|developed|pushed|answered|replied|responded|chose|was|were|had|did|earlier|already|ago|previously|previous|(?:just|has|have|had)\s+put)\b/gi;
const PRESENT_CUE =
  /\b(?:now|next|play|plays|push|pushes|try|tries|can|could|should|will|would|must|threatens?|wants?|consider)\b/gi;
/** Clause boundaries: punctuation, and conjunctions that start a new clause. */
const CLAUSE_BREAK = /[.!?;,:](?=\s|$)|\n|\b(?:so|but|because|since|while|whereas|although|though|now that)\b/gi;
/** A move number right before the mention ("2.Bf4", "9...c5"). */
const NUMBERED = /(?:^|[^\w.])(\d+)\.(\.\.)?\s?$/;
/** Text between two moves of one list or line: "Nc6, ...Bd6 and ...O-O", "2.Bf4 Nf6". */
const LIST_GAP = /^\s*(?:,|and|or|then|,\s*and|,\s*or|,\s*then)?\s*(?:\.\.\.)?\s*$/i;

/** SAN after "your", "the", "Black's" names a piece where it stands ("your Bf4"), not a move. */
const PIECE_REF = /\b(?:your|the|their|his|her|my|our|white's|black's|opponent's)\s+$/i;

function pieceStands(fen: string, piece: string, square: string): boolean {
  const at = board(fen)?.get(square as never);
  return at !== undefined && at.type === piece;
}

/** Half-moves played before `fen` (0 at the start position). */
function plyOf(fen: string): number {
  const parts = fen.trim().split(/\s+/);
  const full = Number(parts[5] ?? "1");
  return (Number.isFinite(full) ? full - 1 : 0) * 2 + (parts[1] === "b" ? 1 : 0);
}

/** Start of the clause that holds `at`. */
function clauseStart(text: string, at: number): number {
  let start = 0;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    if (m.index! + m[0].length > at) break;
    start = m.index! + m[0].length;
  }
  return start;
}

/** End of the clause that holds `at`. */
function clauseEnd(text: string, at: number): number {
  const re = new RegExp(CLAUSE_BREAK.source, "gi");
  re.lastIndex = at;
  const m = re.exec(text);
  return m ? m.index : text.length;
}

interface TenseContext {
  /** Ply of the current move (the earlier of fen and attemptFen). */
  currentPly: number;
  /** The previous mention in this text, if any. */
  prev: { end: number; past: boolean } | null;
}

/**
 * True when the mention at [at, end) refers to the game so far:
 * 1. a move number before it decides: an earlier move is a game record, the current move or a
 *    later one is a line ("Play 9.Nc3 now");
 * 2. a move listed right after a past mention ("...Nc6, ...Bd6 and ...O-O") stays past, unless
 *    its clause has a present cue ("You played Nd2, and Nc3 is better now");
 * 3. otherwise the last cue before it in its clause (with the mention's own first word, for
 *    "just put their queen on d6").
 */
function isPastMention(text: string, at: number, end: number, ctx: TenseContext): boolean {
  const before = text.slice(0, at);
  const numbered = NUMBERED.exec(before);
  if (numbered) return (Number(numbered[1]) - 1) * 2 + (numbered[2] ? 1 : 0) < ctx.currentPly;
  const start = clauseStart(text, at);
  const clause = text.slice(start, clauseEnd(text, end));
  if (ctx.prev?.past && LIST_GAP.test(text.slice(ctx.prev.end, at)) && !new RegExp(PRESENT_CUE.source, "i").test(clause)) return true;
  const head = text.slice(start, at) + (/^[A-Za-z]+/.exec(text.slice(at))?.[0] ?? "");
  const last = (re: RegExp) => Math.max(-1, ...[...head.matchAll(re)].map((m) => m.index!));
  const past = last(PAST_CUE);
  return past >= 0 && past > last(PRESENT_CUE);
}

const ucis = (moves: unknown): string[] =>
  Array.isArray(moves) ? moves.map((m) => (m && typeof m === "object" ? (m as { uci?: unknown }).uci : m)).filter((u): u is string => typeof u === "string") : [];

/** Positions reached along the move lines of one tool result. */
export function toolLinePositions(t: ToolResultRecord): string[] {
  if (t.isError) return [];
  const fen = (t.input as { fen?: unknown } | null)?.fen;
  if (typeof fen !== "string" || !board(fen)) return [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(t.content) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: string[] = [];
  const line = (from: string, moves: string[]) => {
    let at = from;
    for (const uci of moves) {
      const next = playUci(at, uci);
      if (!next) break;
      out.push(next.fen);
      at = next.fen;
    }
  };
  if (Array.isArray(data["lines"])) for (const l of data["lines"] as { moves?: unknown }[]) line(fen, ucis(l?.moves));
  const played = ucis([data["move"]])[0];
  if (played) {
    const after = playUci(fen, played);
    if (after) {
      out.push(after.fen);
      line(after.fen, ucis(data["reply_line"]));
    }
  }
  for (const single of [...ucis([data["best"]]), ...ucis(data["moves"]), ...ucis(data["next_moves"])]) line(fen, [single]);
  return out;
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

const MAX_POSITIONS = 400;

/**
 * NFR-6, moves: every move named in `message` and `reveal` must be legal in a position it may
 * refer to, or in one reached by moves named earlier in the same field (so "Bxd6 exd6" and "g6,
 * then Bg7 and O-O" read as lines). A move described as played now, next or in a plan ("Play Nc3
 * now", "Black plays Nb8-c6", "9.Nc3!") is held to currentPositions and the last move's own
 * position (lastMovePosition, its mover only); only a past-tense reference ("you played Nd2") or
 * an earlier move number ("2.Bf4") may use the game's earlier positions (#29).
 * Either side may be to move: explanations often give one side's plan ("g6, Bg7, O-O") without
 * the replies. Plan mentions ("the f5 break") are not graded: a plan need not be legal yet.
 */
export function gradeMoves(input: GradeInput): MovesGrade {
  const mentions: MentionGrade[] = [];
  const current = currentPositions(input);
  const history = historyFens(input.history);
  const lastFen = lastMovePosition(input.history);
  for (const field of ["message", "reveal"] as const) {
    const text = input.reply[field];
    if (!text) continue;
    // Two pools: lines from current positions, and everything (history too) for past references.
    let now = current;
    let all = unique([...history, ...current]);
    const ctx: TenseContext = { currentPly: Math.min(plyOf(input.fen), plyOf(input.attemptFen)), prev: null };
    for (const m of findMentions(text)) {
      if (m.plan) continue;
      const past = isPastMention(text, m.start, m.end, ctx);
      ctx.prev = { end: m.end, past };
      const reached: string[] = [];
      for (const fen of past ? all : now) {
        for (const variant of [fen, flipTurn(fen)]) {
          if (!variant) continue;
          for (const mv of resolve(variant, m.spec)) reached.push(mv.after);
        }
      }
      // The opponent's last move, from the position before it, as its mover only.
      if (!past && lastFen) for (const mv of resolve(lastFen, m.spec)) reached.push(mv.after);
      let legal = reached.length > 0;
      if (!legal && m.spec.piece && m.spec.to && !m.spec.capture && PIECE_REF.test(text.slice(0, m.start))) {
        legal = (past ? all : now).some((fen) => pieceStands(fen, m.spec.piece!, m.spec.to!));
      }
      mentions.push({ field, raw: m.raw, legal });
      if (!past) now = unique([...now, ...reached]).slice(0, MAX_POSITIONS);
      all = unique([...all, ...reached]).slice(0, MAX_POSITIONS);
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
  /** Arrows that point at the answer's square without giving the move (allowed Socratic nudges). */
  nudges: string[];
}

const PIECE_NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const CHECK_NOUN =
  /\b(?:a|give|gives|giving|gave|with|deliver|delivers|delivering)\s+check\b|\b(?:king|queen|rook|bishop|knight|pawn)\s+checks?\b|\bcheck(?:s|ed|ing)?\s+(?:with|from|by)\b|\bchecks?\s+(?:the|black's|white's|your opponent's)\s+king\b/i;
/** Castling in words: "castle", "castles", "castling", "castled" (#29). */
const CASTLE_WORD = /\bcastl(?:e|es|ed|ing)\b/gi;
/** Who a clause is about: the nearest of these before the word is its subject. */
const SUBJECT = /\b(white|black|you|your|you're|opponent|opponent's|they|their|he|she)\b/gi;

/** True when some castle word in `text` is about the player, not the opponent ("Black castled"). */
function playerCastleWord(text: string, player: Color): boolean {
  for (const m of text.matchAll(CASTLE_WORD)) {
    const head = text.slice(clauseStart(text, m.index!), m.index!);
    const subject = [...head.matchAll(SUBJECT)].pop()?.[1]?.toLowerCase();
    const opponent = subject === undefined ? false : subject === "white" ? player === "b" : subject === "black" ? player === "w" : !subject.startsWith("you");
    if (!opponent) return true;
  }
  return false;
}

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
 * NFR-7, the user's rule (2026-11-08): the first message and the pre-reveal arrows give the
 * answer away when
 * - the message names revealMove in any notation (SAN, UCI, long algebraic, "bishop to d3",
 *   or a pawn move's square in a move context);
 * - the message names the answer's piece and a check, when the answer gives check
 *   ("can a check with your other bishop ...", "a bishop check", "checks with your bishop");
 * - the message says "castle" (in any form) when the answer is castling, unless its clause is
 *   about the opponent ("Black has already castled");
 * - an arrow is the answer move or starts on its from-square (shows the piece).
 * An arrow that only ends on the answer's to-square, runs along its line through it, or starts
 * on its empty to-square is a Socratic nudge: reported in `nudges` ("points at the answer
 * square"), not a give-away. Malformed arrows (the session drops them) are ignored here.
 * Without a revealMove the answer is the case's engineBest: a reply that names the engine's
 * move without revealing it still gives it away (#29).
 */
export function gradeGiveAway(input: GradeInput): GiveAwayGrade {
  const problems: string[] = [];
  const nudges: string[] = [];
  const answer = input.reply.revealMove ?? input.engineBest;
  if (!answer) return { pass: true, problems, nudges };
  const attempt = input.kind === "hint" ? input.fen : input.attemptFen;
  const played = playUci(attempt, answer);
  if (played?.move.san.startsWith("O-O") && playerCastleWord(input.reply.message, input.playerColor)) {
    problems.push(`message says "castle" and the answer ${answer} is castling (${played.move.san})`);
  }
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
    if (!isSquare(a.from) || !isSquare(a.to) || a.from === a.to || !isSquare(from) || !isSquare(to)) continue;
    const label = `arrow ${a.from}->${a.to}`;
    if (a.from === from && a.to === to) problems.push(`${label} is the answer ${answer}`);
    else if (a.from === from) problems.push(`${label} starts on the answer's from-square ${from}`);
    else if (a.to === to) nudges.push(`${label} ends on the answer's to-square ${to}`);
    else if (alongLine(from, to, a)) nudges.push(`${label} runs along the answer's line through ${to}`);
    else if (a.from === to && empty) nudges.push(`${label} starts on the answer's empty to-square ${to}`);
  }
  return { pass: problems.length === 0, problems, nudges };
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

const MATE_QUOTE = /(?<![\w.])mate in (\d+)/gi;
/** "1.5 pawns", "+2 pawns", "150 cp", "a 1.5-pawn edge". */
const UNIT_QUOTE = /(?<![\w.])([+\-−])?(\d+(?:\.\d+)?)(?:\s*-\s*|\s*)(pawns?|centipawns?|cp)\b/gi;
/** "+1.5", "-0.4". */
const SIGNED_QUOTE = /(?<![\w.])([+\-−])(\d+(?:\.\d+)?)(?!\w|\.\d)/g;
/**
 * Any other decimal ("better by 2.3", "down 0.4 or so", "The engine gives 1.8", "White is 1.5
 * better"): chess text has no other decimals (a move number is followed by a move, "9.e4"), so
 * a decimal is an evaluation unless a unit of something else follows (#29 round 2).
 */
const DECIMAL_QUOTE = /(?<![\w.+\-−])(\d+\.\d+)(?![\w%]|\.\d)(?!\s*(?:-\s*)?(?:pawns?|centipawns?|cp|points?|seconds?|minutes?|hours?|percent|%)\b)/gi;
/** A whole number without a unit ("better by 1", "White is down 2"), framed by EVAL_LEAD. */
const INTEGER_QUOTE =
  /(?<![\w.+\-−])(\d+)(?![\w%]|\.\d)(?!\s*-?\s*(?:pawns?|centipawns?|cp)\b)(?!\s+(?:moves?|tempi|tempo|squares?|files?|ranks?|pieces?|points?|minutes?|seconds?|games?|times?)\b)/g;
/**
 * A whole number of pawns, or a whole number without a unit, is an evaluation only when an
 * evaluation word frames it: "is up 2 pawns", "better by 1", "an advantage of 2 pawns", "a 2-pawn
 * edge". Otherwise it is a count ("2 pawns on the queenside", "defended by 2 pawns", "backed up
 * by 2 pawns"). "up 2 pawns in material" is a material claim, not an engine evaluation: not graded.
 */
const EVAL_LEAD =
  /(?:\b(?:is|are|am|be|been|being|stays?|remains?|still|now|you're|we're|they're|white's|black's|it's)\s+(?:up|down|ahead|behind)(?:\s+by)?|\b(?:better|worse|ahead|behind|leads?|trails?)\s+by|\bworth|\b(?:advantage|edge|lead|deficit)\s+of)\s+(?:(?:about|roughly|around|nearly|almost|just|only|over|under)\s+)?$/i;
const EVAL_FOLLOW = /^\s+(?:edge|advantage|lead|deficit|better|worse|ahead|behind)\b/i;
const MATERIAL_FOLLOW = /^\s+(?:in|of)\s+material\b/i;

interface RawQuote {
  raw: string;
  index: number;
  mate: number | null;
  sign: string | undefined;
  num: string;
  unit: string;
}

/** Every evaluation quoted in `text`, in order, without overlaps (the earliest, then longest, wins). */
export function findEvalQuotes(text: string): RawQuote[] {
  const found: RawQuote[] = [];
  const framed = (index: number, raw: string) => EVAL_LEAD.test(text.slice(0, index)) || EVAL_FOLLOW.test(text.slice(index + raw.length));
  for (const m of text.matchAll(MATE_QUOTE)) found.push({ raw: m[0], index: m.index!, mate: Number(m[1]), sign: undefined, num: m[1]!, unit: "" });
  for (const m of text.matchAll(UNIT_QUOTE)) {
    const [raw, sign, num, unit] = m as unknown as [string, string | undefined, string, string];
    const whole = sign === undefined && !num.includes(".") && unit.toLowerCase().startsWith("p");
    if (whole && (!framed(m.index!, raw) || MATERIAL_FOLLOW.test(text.slice(m.index! + raw.length)))) continue;
    found.push({ raw, index: m.index!, mate: null, sign, num, unit: unit.toLowerCase() });
  }
  for (const m of text.matchAll(SIGNED_QUOTE)) found.push({ raw: m[0], index: m.index!, mate: null, sign: m[1], num: m[2]!, unit: "" });
  for (const m of text.matchAll(DECIMAL_QUOTE)) found.push({ raw: m[0], index: m.index!, mate: null, sign: undefined, num: m[1]!, unit: "" });
  for (const m of text.matchAll(INTEGER_QUOTE)) {
    if (framed(m.index!, m[0])) found.push({ raw: m[0], index: m.index!, mate: null, sign: undefined, num: m[1]!, unit: "" });
  }
  const sorted = found.sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
  const out: RawQuote[] = [];
  for (const q of sorted) {
    const last = out[out.length - 1];
    if (last && q.index < last.index + last.raw.length) continue;
    out.push(q);
  }
  return out;
}
const SIDE = /\b(white|black|you|your|you're|you are|opponent|opponent's)\b/gi;
const UP = /\b(up|ahead|better|advantage|edge|winning|plus|favou?r)\b/i;
const DOWN = /\b(down|behind|worse|losing|minus)\b/i;

/**
 * NFR-6, evaluations (FR-10): every quoted evaluation (+1.5, 1.5 pawns, 150 cp / centipawns,
 * mate in N, and unsigned ones: any decimal such as "better by 2.3", "The engine gives 1.8",
 * "a 1.5-pawn edge", or a whole number framed by an evaluation word, "is up 2 pawns"; not a
 * count such as "2 pawns on the queenside" or "defended by 2 pawns") must match a score from this ask's tool results or the key-moment data, within
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
    for (const q of findEvalQuotes(text)) {
      const { raw, sign, num, unit } = q;
      if (q.mate !== null) {
        const n = q.mate;
        quotes.push({ raw, cp: null, mate: n, side: null, problem: ev.mates.includes(n) ? null : "unmatched" });
        continue;
      }
      const size = unit.startsWith("c") ? Number(num) : Math.round(Number(num) * 100);
      const tol = !unit.startsWith("c") && !num.includes(".") ? 50 : EVAL_TOLERANCE_CP;
      const near = (a: number, b: number) => Math.abs(a - b) <= tol + 1e-9;
      const { side, direction } = sideOf(text, q.index, raw.length, input.playerColor, sign);
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
  /** NFR-6: every move named is legal and revealMove (when given) is legal at the attempt position. */
  nfr6Moves: boolean;
  /** NFR-6: every quoted evaluation is backed. */
  nfr6Evals: boolean;
  /** NFR-7: nothing gives the answer away before the reveal. */
  nfr7: boolean;
  /** Information only: an arrow points at the answer's square (giveAway.nudges). */
  pointsAtAnswer: boolean;
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
    nfr6Moves: moves.pass && (input.reply.revealMove === null || reveal.legal),
    nfr6Evals: evals.pass,
    nfr7: giveAway.pass,
    pointsAtAnswer: giveAway.nudges.length > 0,
  };
}
