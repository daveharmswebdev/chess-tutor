import type { Color, KeyMoment } from "@chess-tutor/chess-core";
import { moverOf, TutorReply } from "@chess-tutor/tutor";
import { board, findMentions, flipTurn, historyFens, isSquare, playUci, resolve, uciOf, type Mention } from "./notation.ts";

/**
 * Deterministic graders for one tutor reply (architecture §5): NFR-6 (moves legal, quoted
 * evaluations backed), NFR-7 (the first message and the arrows keep the answer back), the
 * schema, and the reveal move. They see only the case, the reply and this ask's tool results,
 * and use chess.js. The one shared reading is packages/tutor's moverOf (the side named before a
 * move mention, "White played dxe5"), so the tutor's claims check and these graders agree on it.
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
  /\b(?:played|went|moved|took|captured|castled|developed|pushed|traded|exchanged|recaptured|advanced|answered|replied|responded|chose|was|were|had|did|earlier|already|ago|previously|previous|(?:just|has|have|had)\s+put)\b/gi;
const PRESENT_CUE =
  /\b(?:now|next|play|plays|push|pushes|try|tries|can|could|should|will|would|must|threatens?|wants?|consider)\b/gi;
/** Clause boundaries: punctuation, and conjunctions that start a new clause. */
const CLAUSE_BREAK = /[.!?;,:](?=\s|$)|\n|\b(?:so|but|because|since|while|whereas|although|though|now that)\b/gi;
/**
 * A present predicate right after the mention ("Nc3 is strong", "...Bb7 will follow"): the
 * mention is the subject of its own clause, so a past tense before it does not reach it (#29,
 * review 042). "would have" / "could have" stay open: "Nc3 would have been better" is the past.
 */
const OWN_PRESENT =
  /^\s*[!?+#]*\s*(?:(?:is|are|looks?|seems?|wins?|works?|keeps?|gives?|remains?|stays?|threatens?)\b|(?:will|can|must|may|might|would|could|should)\b(?!\s+have\b))/i;
/** A move number right before the mention ("2.Bf4", "9...c5"). */
const NUMBERED = /(?:^|[^\w.])(\d+)\.(\.\.)?\s?$/;
/** Text between two moves of one list or line: "Nc6, ...Bd6 and ...O-O", "2.Bf4 Nf6". */
const LIST_GAP = /^\s*(?:,|and|or|then|,\s*and|,\s*or|,\s*then)?\s*(?:\.\.\.)?\s*$/i;

/** SAN after "your", "the", "Black's" names a piece where it stands ("your Bf4"), not a move. */
const PIECE_REF = /\b(?:your|the|their|his|her|my|our|white's|black's|opponent's)\s+$/i;
/**
 * SAN after "<subject> have/has" ("now you have Nd2") names a piece where it stands, but only the
 * subject's own piece: "You have Nf6" with Black's knight on f6 is still a move (#29, review 052).
 */
const HAVE_REF = /\b(you|we|white|black|they|he|she|opponent|your opponent)\s+(?:(?:still|now|also|already)\s+)?(?:have|has|had)\s+$/i;

/** The colour a HAVE_REF subject owns: "you"/"we" the player, "White"/"Black" that side, others the opponent. */
function haveOwner(subject: string, player: Color): Color {
  const w = subject.toLowerCase();
  if (w === "white") return "w";
  if (w === "black") return "b";
  if (w === "you" || w === "we") return player;
  return player === "w" ? "b" : "w";
}

/**
 * "Black's last move, Qd6", "your opponent's previous move was ...b6": the side named owns a move
 * already played (moverOf stops at the comma, so the apposition is read here).
 */
const LAST_MOVE_BEFORE =
  /\b(white|black|your opponent|the opponent|opponent|you|your)(?:['’]s)?\s+(?:last|previous)\s+move(?:\s+(?:was|is))?\s*[,:]?\s*(?:\.\.\.)?\s*$/i;

/** The side named as the mover of the mention starting at `at` (moverOf, or a "last move" apposition). */
function namedMover(text: string, at: number, player: Color): { mover: Color | null; lastMove: boolean } {
  const before = text.slice(0, at);
  const mover = moverOf(before, player);
  if (mover !== null) return { mover, lastMove: false };
  const last = LAST_MOVE_BEFORE.exec(before);
  return last ? { mover: moverOf(`${last[1]} `, player), lastMove: true } : { mover: null, lastMove: false };
}

/** True when `side` played a move fitting `spec` in the game (from that move's own position). */
function playedBy(history: string[], side: Color, s: Mention["spec"]): boolean {
  const fens = historyFens(history);
  return history.some((uci, i) => {
    const fen = fens[i];
    return fen !== undefined && fen.split(" ")[1] === side && resolve(fen, s).some((mv) => uciOf(mv) === uci);
  });
}

/**
 * True when the mention is `side`'s last move of the game, from that move's own position ("Black's
 * last move, Qd6" after 3...Qd6 4.Nc3): the only move a "last move" apposition may name (review 052).
 */
function lastMoveOf(history: string[], side: Color, s: Mention["spec"]): string | null {
  const fens = historyFens(history);
  for (let i = Math.min(history.length, fens.length - 1) - 1; i >= 0; i--) {
    if (fens[i]!.split(" ")[1] !== side) continue;
    const mv = resolve(fens[i]!, s).find((x) => uciOf(x) === history[i]);
    return mv ? mv.after : null;
  }
  return null;
}

/** True when the last tense cue in the clause before the mention is a past one ("White played", "White pushed the"). */
function pastHead(text: string, at: number): boolean {
  const head = text.slice(clauseStart(text, at), at);
  const last = (re: RegExp) => Math.max(-1, ...[...head.matchAll(re)].map((m) => m.index!));
  const past = last(PAST_CUE);
  return past >= 0 && past > last(PRESENT_CUE);
}

/** Side words that can be a clause's subject; a possessive "your" ("took your pawn") is an object (review 054). */
const SUBJECT_SIDE = /\b(white|black|you|your\s+opponent|the\s+opponent|opponent)\b/gi;

function sideWord(w: string, player: Color): Color {
  const x = w.toLowerCase();
  if (x === "white") return "w";
  if (x === "black") return "b";
  return x === "you" ? player : player === "w" ? "b" : "w";
}

/** The side of the side word nearest before the mention in its clause ("White hopes you miss dxe5": you). */
function nearestSide(text: string, at: number, player: Color): Color | null {
  const head = text.slice(clauseStart(text, at), at);
  const w = [...head.matchAll(SUBJECT_SIDE)].pop()?.[1];
  return w === undefined ? null : sideWord(w, player);
}

/** The clause's subject: its first side word ("White took your pawn with dxe5": White). */
function subjectSide(text: string, at: number, player: Color): Color | null {
  const head = text.slice(clauseStart(text, at), at);
  const w = [...head.matchAll(SUBJECT_SIDE)][0]?.[1];
  return w === undefined ? null : sideWord(w, player);
}

/** A possessive right before the mention: "White's dxe5", "After Black's ...Qd6", "your ...e5" (review 054). */
const POSSESSIVE_BEFORE = /\b(?:(white|black|your opponent|the opponent|opponent)['’]s|(your))\s+(?:\.\.\.\s?)?$/i;

function possessiveSide(before: string, player: Color): Color | null {
  const m = POSSESSIVE_BEFORE.exec(before);
  if (!m) return null;
  return m[2] ? player : sideWord(m[1]!.replace(/^(?:your|the)\s+/i, ""), player);
}

/**
 * The side a history reference points at: "After X" (the opponent), a possessive ("Black's
 * ...Qd6"), or "With ...X Black ..." (the side named after it). Null when the mention is none.
 */
function historyRefSide(text: string, at: number, end: number, player: Color): Color | null {
  const before = text.slice(0, at);
  const possessive = possessiveSide(before, player);
  if (possessive !== null) return possessive;
  if (/\bafter\s+(?:\.\.\.\s?)?$/i.test(before)) return player === "w" ? "b" : "w";
  const named = /^\s+(white|black|your opponent|the opponent)\b/i.exec(text.slice(end));
  if (/\bwith\s+(?:\.\.\.\s?)?$/i.test(before) && named) return sideWord(named[1]!.replace(/^(?:your|the)\s+/i, ""), player);
  return null;
}

/** True when the clause before the mention has a present cue ("Black plays", "Black threatens"). */
function presentClause(text: string, at: number): boolean {
  return new RegExp(PRESENT_CUE.source, "i").test(text.slice(clauseStart(text, at), at));
}

function pieceStands(fen: string, piece: string, square: string, color?: Color): boolean {
  const at = board(fen)?.get(square as never);
  return at !== undefined && at.type === piece && (color === undefined || at.color === color);
}

/** The ply a NUMBERED match names: "9." is White's 9th move, "9..." Black's. */
function numberedPly(m: RegExpExecArray): number {
  return (Number(m[1]) - 1) * 2 + (m[2] ? 1 : 0);
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
 * 2. a mention with its own present predicate is present ("After Black played ...b6, Nc3 is
 *    strong", "Black played ...b6 and Nc3 is the right reply");
 * 3. a move listed right after a past mention ("...Nc6, ...Bd6 and ...O-O") stays past, unless
 *    its clause has a present cue ("You played Nd2, and Nc3 is better now");
 * 4. otherwise the last cue before it in its clause (with the mention's own first word, for
 *    "just put their queen on d6").
 */
function isPastMention(text: string, at: number, end: number, ctx: TenseContext): boolean {
  const before = text.slice(0, at);
  const numbered = NUMBERED.exec(before);
  if (numbered) return numberedPly(numbered) < ctx.currentPly;
  if (OWN_PRESENT.test(text.slice(end, clauseEnd(text, end)))) return false;
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
 * position (lastMovePosition, the history's last move only); only a past-tense reference ("you
 * played Nd2", "Black's last move, Qd6") or an earlier move number ("2.Bf4") may use the game's
 * earlier positions (#29). A "last move" apposition ("Black's last move, Qd6") passes only for
 * that side's actual last move of the game (review 052). A side named as the mover (moverOf: "White's dxe5 opens the d-file")
 * that is the opponent may also name a move that side already played, unless its clause has a
 * present cue ("Black plays Nb8-c6" is checked now).
 * Either side may be to move: explanations often give one side's plan ("g6, Bg7, O-O") without
 * the replies. Plan mentions ("the f5 break") are not graded: a plan need not be legal yet.
 */
export function gradeMoves(input: GradeInput): MovesGrade {
  const mentions: MentionGrade[] = [];
  const current = currentPositions(input);
  const history = historyFens(input.history);
  const lastFen = lastMovePosition(input.history);
  const lastUci = input.history[input.history.length - 1];
  for (const field of ["message", "reveal"] as const) {
    const text = input.reply[field];
    if (!text) continue;
    // Two pools: lines from current positions, and everything (history too) for past references.
    let now = current;
    let all = unique([...history, ...current]);
    const ctx: TenseContext = { currentPly: Math.min(plyOf(input.fen), plyOf(input.attemptFen)), prev: null };
    for (const m of findMentions(text)) {
      if (m.plan) continue;
      const named = namedMover(text, m.start, input.playerColor);
      // "Black's last move, Qd6": that side's real last move, or else graded as played now (review 052).
      const lastOfSide = named.lastMove && named.mover ? lastMoveOf(input.history, named.mover, m.spec) : null;
      const past = !named.lastMove && isPastMention(text, m.start, m.end, ctx);
      ctx.prev = { end: m.end, past };
      const reached: string[] = [];
      for (const fen of past ? all : now) {
        for (const variant of [fen, flipTurn(fen)]) {
          if (!variant) continue;
          for (const mv of resolve(variant, m.spec)) reached.push(mv.after);
        }
      }
      // The opponent's last move, from the position before it: that move only (review 042).
      if (!past && lastFen) for (const mv of resolve(lastFen, m.spec)) if (uciOf(mv) === lastUci) reached.push(mv.after);
      if (lastOfSide) reached.push(lastOfSide);
      let legal = reached.length > 0;
      // A move the named opponent already played ("White's dxe5 opens the d-file"), unless the
      // clause puts it now ("Black plays Nb8-c6"): a game reference, not the player's move now.
      const opponentNamed = named.mover !== null && named.mover !== input.playerColor;
      if (!legal && !named.lastMove && opponentNamed && !presentClause(text, m.start) && playedBy(input.history, named.mover!, m.spec)) legal = true;
      // The opponent's own last move named as history: "After Qd6 ...", "Black's ...Qd6 hangs",
      // "With ...Qd6 Black ..." is checked against the position before it (review 054).
      if (!legal) {
        const ref = historyRefSide(text, m.start, m.end, input.playerColor);
        if (ref !== null && ref !== input.playerColor && lastMoveOf(input.history, ref, m.spec)) legal = true;
      }
      if (!legal && m.spec.piece && m.spec.to && !m.spec.capture) {
        const before = text.slice(0, m.start);
        const have = HAVE_REF.exec(before);
        const owner = have ? haveOwner(have[1]!, input.playerColor) : undefined;
        if (have || PIECE_REF.test(before)) legal = (past ? all : now).some((fen) => pieceStands(fen, m.spec.piece!, m.spec.to!, owner));
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

/** "Do the same", "follow suit": copies what the opponent did (review 042: "Black has castled. Do the same!"). */
const DO_SAME =
  /\b(?:do|doing|does)\s+the\s+same\b|\bfollow(?:s|ing)?\s+suit\b|\bthe\s+same\s+(?:thing|idea|plan)\b|\bcopy\s+(?:that|them|it|him|her|white|black|your\s+opponent)\b/i;
/** "too", "as well", "likewise": a copy only right after the opponent castled, addressed to the player (review 054). */
const TOO = /\btoo\b|\bas\s+well\b|\blikewise\b/gi;
/** Addressed to the player: "you", "your", or an imperative at the clause start. */
const ADDRESSED = /\b(?:you|your|you're)\b|^\s*(?:castle|do|follow|get|bring|tuck|go|play|make)\b/i;
/** A castle word that says the side did not castle: "hasn't castled", "skipped castling", "yet to castle". */
const NEGATED = /\b(?:hasn't|has\s+not|haven't|have\s+not|hadn't|had\s+not|didn't|did\s+not|doesn't|does\s+not|not|never|yet\s+to|skipped|skips|skipping|skip|without|won't|can't|cannot)\b/i;

/** Non-empty clauses of `text`, in order (CLAUSE_BREAK boundaries). */
function clauses(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  const push = (end: number) => {
    if (text.slice(start, end).trim()) out.push({ start, end });
  };
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    push(m.index!);
    start = m.index! + m[0].length;
  }
  push(text.length);
  return out;
}

/**
 * Whether some castle word in `text` is about the player, whether the opponent positively castled
 * ("Black castled"; not "White hasn't castled"), and whether a "too" / "as well" copies it: in the
 * same clause after it or in the next clause, addressed to the player ("Black castled; you should too").
 */
function castleWords(text: string, player: Color): { player: boolean; opponent: boolean; copied: boolean } {
  const out = { player: false, opponent: false, copied: false };
  const list = clauses(text);
  const clauseOf = (at: number) => list.findIndex((c) => at >= c.start && at < c.end);
  const toos = [...text.matchAll(TOO)].map((t) => t.index!);
  for (const m of text.matchAll(CASTLE_WORD)) {
    const head = text.slice(clauseStart(text, m.index!), m.index!);
    const found = [...head.matchAll(SUBJECT)].pop();
    const subject = found?.[1]?.toLowerCase();
    const opponent = subject === undefined ? false : subject === "white" ? player === "b" : subject === "black" ? player === "w" : !subject.startsWith("you");
    if (!opponent) {
      out.player = true;
      continue;
    }
    if (NEGATED.test(head.slice(found!.index!))) continue;
    out.opponent = true;
    const here = clauseOf(m.index!);
    for (const t of toos) {
      const c = clauseOf(t);
      if (c === here && ADDRESSED.test(text.slice(m.index!, t))) out.copied = true;
      if (c === here + 1 && ADDRESSED.test(text.slice(list[c]!.start, t))) out.copied = true;
    }
  }
  return out;
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
 *   about the opponent ("Black has already castled"); an opponent's castling with "do the same"
 *   ("Black castled already; you should do the same.") still gives it away, and so does "too" /
 *   "as well" / "likewise" right after a positive opponent castle, addressed to the player
 *   ("Black castled; you should too"; not "White hasn't castled ... too", review 054);
 * - an arrow is the answer move or starts on its from-square (shows the piece).
 * An arrow that only ends on the answer's to-square, runs along its line through it, or starts
 * on its empty to-square is a Socratic nudge: reported in `nudges` ("points at the answer
 * square"), not a give-away. Malformed arrows (the session drops them) are ignored here.
 * Without a revealMove the answer is the case's engineBest: a reply that names the engine's
 * move without revealing it still gives it away (#29). Not the answer (review 052 narrowed both):
 * a mention whose named mover (moverOf, and the nearest side word) is the side not to move, told
 * in the past, and that side played it in the game ("White played dxe5"; "White fears dxe5" and
 * "White hopes you miss dxe5" are still graded); a mention numbered as an earlier ply, without a
 * present cue or predicate ("It is not 1...d5" when Black plays move 2; "Play 1...d5 now" and
 * "10.e4 is the move" are still graded).
 */
export function gradeGiveAway(input: GradeInput): GiveAwayGrade {
  const problems: string[] = [];
  const nudges: string[] = [];
  const answer = input.reply.revealMove ?? input.engineBest;
  if (!answer) return { pass: true, problems, nudges };
  const attempt = input.kind === "hint" ? input.fen : input.attemptFen;
  const played = playUci(attempt, answer);
  if (played?.move.san.startsWith("O-O")) {
    const words = castleWords(input.reply.message, input.playerColor);
    if (words.player) problems.push(`message says "castle" and the answer ${answer} is castling (${played.move.san})`);
    else if (words.copied || (words.opponent && DO_SAME.test(input.reply.message))) {
      problems.push(`message says the opponent castled and to do the same, and the answer ${answer} is castling (${played.move.san})`);
    }
  }
  const from = answer.slice(0, 2);
  const to = answer.slice(2, 4);

  const toMove: Color = attempt.trim().split(/\s+/)[1] === "b" ? "b" : "w";
  const attemptPly = plyOf(attempt);
  const msg = input.reply.message;
  for (const m of findMentions(msg)) {
    const now = presentClause(msg, m.start) || OWN_PRESENT.test(msg.slice(m.end, clauseEnd(msg, m.end)));
    // The named opponent's move, told in the past and played in the game ("White played dxe5",
    // "White pushed the pawn to e5"), is not the answer (#29); "White fears dxe5" still is (review 052).
    const named = namedMover(msg, m.start, input.playerColor);
    // (a) "White's last move, dxe5, ...": that side's real last move (review 054).
    if (named.lastMove && named.mover !== null && named.mover !== toMove && lastMoveOf(input.history, named.mover, m.spec)) continue;
    // (b) A possessive ("White's dxe5", "After your ...e5") naming that side's real last move, not put now.
    const possessive = possessiveSide(msg.slice(0, m.start), input.playerColor);
    if (possessive !== null && !presentClause(msg, m.start) && lastMoveOf(input.history, possessive, m.spec)) continue;
    // (c, d) Told in the past by the clause's subject, who is also the nearest side word.
    const subject = subjectSide(msg, m.start, input.playerColor) ?? named.mover;
    const nearest = nearestSide(msg, m.start, input.playerColor) ?? named.mover;
    if (!named.lastMove && subject !== null && subject !== toMove && nearest === subject && !now && pastHead(msg, m.start) && playedBy(input.history, subject, m.spec)) continue;
    // Nor is a move numbered as an earlier ply, told in the past ("It is not 1...d5" when Black plays move 2).
    const numbered = NUMBERED.exec(msg.slice(0, m.start));
    if (numbered && numberedPly(numbered) < attemptPly && !now) continue;
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
 * evaluation word frames it: "better by 1", "an advantage of 2 pawns", "a 2-pawn edge", "White is
 * down 2". Otherwise it is a count ("2 pawns on the queenside", "defended by 2 pawns", "backed up
 * by 2 pawns"). "up 2 pawns" (with or without "in material") is a material claim, not an engine
 * evaluation: not graded; nor are piece values ("a bishop is worth 3 pawns"), versions
 * ("Stockfish 16.1") and accuracies ("accuracy was 87.5").
 */
const EVAL_LEAD =
  /(?:\b(?:is|are|am|be|been|being|stays?|remains?|still|now|you're|we're|they're|white's|black's|it's)\s+(?:up|down|ahead|behind)(?:\s+by)?|\b(?:better|worse|ahead|behind|leads?|trails?)\s+by|\bworth|\b(?:advantage|edge|lead|deficit)\s+of)\s+(?:(?:about|roughly|around|nearly|almost|just|only|over|under)\s+)?$/i;
const EVAL_FOLLOW = /^\s+(?:edge|advantage|lead|deficit|better|worse|ahead|behind)\b/i;
/**
 * "up 2 pawns", "down 1 pawn": a whole number of pawns up or down is material (#29, PR #32); not
 * "ahead by" / "behind by", and not when an engine word frames the clause ("The engine says you
 * are up 3 pawns", review 052).
 */
const MATERIAL_LEAD = /\b(?:(?<!\bend(?:s|ed|ing)?\s+)up|down)(?:\s+by)?\s+(?:(?:about|roughly|around|nearly|almost|just|only|over|under)\s+)?$/i;
/** An engine word anywhere in the sentence makes "up 3 pawns" an evaluation (review 054); "says" / "gives" alone do not. */
const ENGINE_WORD = /\b(?:engines?|stockfish|evals?|evaluations?|evaluates|computer|analysis)\b/i;

/** The sentence holding `at`: between [.!?] breaks, so it spans commas, colons and semicolons. */
function sentenceAt(text: string, at: number): string {
  let start = 0;
  for (const m of text.matchAll(/[.!?](?=\s|$)|\n/g)) {
    if (m.index! >= at) return text.slice(start, m.index!);
    start = m.index! + 1;
  }
  return text.slice(start);
}
/** A number that names something other than an evaluation: "Stockfish 16.1", "accuracy was 87.5", "depth 18". */
const NOT_EVAL_BEFORE = /\bstockfish\s+$|\b(?:version|accuracy|accuracies|rating|elo|depth)(?:\s+(?:score|was|is|of|at|around|about))*\s*[:=]?\s*$/i;
/** A piece value: "A bishop is worth 3 pawns", "a rook is worth about 5" (review 042). */
const PIECE_VALUE_BEFORE =
  /\b(?:pawns?|knights?|bishops?|rooks?|queens?|pieces?|exchange)\s+(?:is|are)\s+(?:(?:usually|normally|generally|roughly|about|around|only|still|each|traditionally)\s+)*worth\s+(?:(?:about|roughly|around|nearly|almost|just|only|over|under)\s+)?$/i;
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
    if (whole && (!framed(m.index!, raw) || MATERIAL_FOLLOW.test(text.slice(m.index! + raw.length)) || (MATERIAL_LEAD.test(text.slice(0, m.index!)) && !EVAL_FOLLOW.test(text.slice(m.index! + raw.length)) && !ENGINE_WORD.test(sentenceAt(text, m.index!))))) continue;
    found.push({ raw, index: m.index!, mate: null, sign, num, unit: unit.toLowerCase() });
  }
  for (const m of text.matchAll(SIGNED_QUOTE)) found.push({ raw: m[0], index: m.index!, mate: null, sign: m[1], num: m[2]!, unit: "" });
  for (const m of text.matchAll(DECIMAL_QUOTE)) found.push({ raw: m[0], index: m.index!, mate: null, sign: undefined, num: m[1]!, unit: "" });
  for (const m of text.matchAll(INTEGER_QUOTE)) {
    if (framed(m.index!, m[0])) found.push({ raw: m[0], index: m.index!, mate: null, sign: undefined, num: m[1]!, unit: "" });
  }
  const sorted = found
    // Versions, accuracies and piece values are unsigned; a signed quote is always graded (review 052).
    .filter((q) => q.sign !== undefined || /[–]\s*$/.test(text.slice(0, q.index)) || (!NOT_EVAL_BEFORE.test(text.slice(0, q.index)) && !PIECE_VALUE_BEFORE.test(text.slice(0, q.index))))
    .sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
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
 * "a 1.5-pawn edge", or a whole number framed by an evaluation word, "an advantage of 2 pawns";
 * not a count such as "2 pawns on the queenside", "defended by 2 pawns" or material, "up 2 pawns") must match a score from this ask's tool results or the key-moment data, within
 * 0.3 pawns (0.5 for a whole number of pawns). Sign-aware where the sentence names a side and a
 * direction ("Black is up 1.5", "+1.5 for White", "you are better by 2 pawns"): such a quote must
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
