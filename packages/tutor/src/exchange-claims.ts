import type { Color, ExchangeResult, PieceType } from "@chess-tutor/chess-core";

/**
 * Exchange claims in prose (#44: FR-21, FR-10, FR-23): what the claims check and the NFR-6 grader
 * read as a count of attackers or defenders on a square, or as the outcome of the exchange there.
 * Each one must be backed by this turn's exchange_on_square result for that square.
 *
 * Clauses break at . ! ? ; , : and at so / but / because / since / while / whereas / although /
 * though / now that. Every claim needs a square in its clause: a bare square ("e5"; a square inside
 * a move such as "Bf4" is not one). A SAN capture ("Nxe4", "exd5", "Bxe5+") is an exchange word
 * only when the clause also names its square with "on / at / onto <square>" (brief 110): "Nxe4
 * drops a piece on e4" is a claim, "Bxd6 wins the queen" is a move mention. A clause with no square of its own keeps the previous clause's square (and its
 * exchange word) when it follows a comma or starts with but / while / whereas, within one
 * sentence: "e5 is attacked twice but defended only once", "If you capture on e4, you lose a piece
 * for a pawn", "Nc6 defends e5 once, the bishop attacks it twice". Without a square there is no
 * claim, so "the knight attacks the queen", "take your time" or "trading pieces helps when you are
 * ahead" never trip it.
 *
 * Counts (compared with attackers.length / defenders.length, x-rays included):
 * - passive: "<square> is attacked twice", "defended three times", "protected once", "attacked by
 *   two (pieces)", "defended by one knight" (a named kind: compared with the pieces of that kind);
 *   the square is the nearest bare square before the verb in the clause, else the first after it.
 * - active: "attacks e5 twice", "defends d4 three times", "hits f7 twice"; "attacks it twice" uses
 *   the kept square.
 * - nouns: "two attackers", "one defender", "no defenders", "a single defender", with the square
 *   placed as for the passive form ("two attackers and one defender on d4"); not when an
 *   exception follows ("no defender except the knight on b5").
 * "once" is a count only at the end of its clause or before and / but / only / more / now / here /
 * so far / by: "attacks e5 once Black moves" is no count. Attack verbs map to attackers, defend /
 * protect / guard to defenders, whichever side is named.
 *
 * Outcomes, only in a clause with an exchange word (exchange, trade, swap, capture, take / took,
 * recapture, "come out", or a SAN capture), are about what happens if the attacking side starts
 * capturing: they are compared with startResult (below), rounded to whole pawns. A square nobody
 * can capture on backs no outcome.
 * - "wins / gains / nets / picks up <material>", "loses / drops / costs / gives up <material>",
 *   where <material> is "material" (sign only) or "a pawn", "two pawns", "a piece" (3), "a
 *   knight" / "a bishop" / "a minor piece" (3), "a rook" (5), "the queen" (9), "the exchange" (2),
 *   optionally "for <material>" ("wins a knight for a pawn" = 2);
 * - "comes out / is / ends up / finishes [<material>] ahead / up / behind / down [for <material>]";
 * - "breaks even", "an even / equal / level / fair trade", "nobody wins": 0.
 * The point of view is the side named as the verb's object ("costs you a pawn"), else after it
 * ("for White"), else the last side named before it in the clause ("Black comes out a pawn
 * down"), else the attacking side of the result (the side that starts the captures). "you" is the
 * player. The square is the won piece's own square when named ("wins the rook on a1"), else the
 * exchange word's: a SAN capture's own square, else the first "on / at / onto <square>" after the
 * word, else the last one before it, else the kept exchange or count square. A square that only
 * names a capturer ("captured by the d6 pawn") is not the exchange square.
 */

export type ExchangeClaim =
  | { kind: "count"; raw: string; start: number; end: number; square: string; role: "attackers" | "defenders"; n: number; piece?: PieceType }
  | { kind: "outcome"; raw: string; start: number; end: number; square: string; sign: -1 | 0 | 1; size: number | null; side: Color | null };

/** The exchange_on_square tool result: chess-core's ExchangeResult plus startResult (#44, review 108). */
export type TutorExchangeResult = ExchangeResult & { startResult: number | null };

const VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PROMOTION_GAIN = 8;

/**
 * Material for the attacking side, in pawns, when the attacker makes the first capture of
 * `sequence` and from then on each side stops at its best moment (the negamax behind `result`,
 * with capture 1 forced). `result` is max(0, startResult). Null when the sequence is empty: no
 * capture, so no outcome. A capture gains the captured piece (a promoted piece counts 9, it is
 * recorded as a queen) plus 8 when it promotes.
 */
export function startResult(r: Pick<ExchangeResult, "sequence">): number | null {
  const gains = r.sequence.map((c) => VALUE[c.captured] + (c.promotion ? PROMOTION_GAIN : 0));
  if (gains.length === 0) return null;
  let next = 0; // the best the side making capture i can get from capture i on, or 0 by stopping
  for (let i = gains.length - 1; i >= 1; i--) next = Math.max(0, gains[i]! - next);
  return gains[0]! - next + 0;
}

const CLAUSE_BREAK = /[.!?;,:](?=\s|$)|\n|\b(?:so|but|because|since|while|whereas|although|though|now that)\b/gi;
/** Breaks after which a clause without a square keeps the previous clause's square. */
const CARRY_BREAK = /^(?:,|but|while|whereas)$/i;
const SQUARE = /(?<![A-Za-z0-9-])([a-h][1-8])(?![A-Za-z0-9-])/g;
const SAN_CAPTURE = /(?<![A-Za-z0-9-])(?:[KQRBN][a-h]?[1-8]?|[a-h])x([a-h][1-8])(?:=?[QRBN])?[+#]?(?![A-Za-z0-9-])/g;

const NUM_WORDS: Record<string, number> = { no: 0, zero: 0, a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const NUM = "(?:zero|one|two|three|four|five|six|seven|eight|\\d)";
const ONCE = "once(?=\\s*$|\\s*[)!?.,;:]|\\s+(?:and|but|only|more|now|here|so\\s+far|by)\\b)";
const TIMES = `(${ONCE}|twice|thrice|${NUM}\\s+times)`;
const ADVERB = "(?:(?:only|just|already|still|now|also|currently|actually)\\s+)?";
const PIECE_WORD = "(pawns?|knights?|bishops?|rooks?|queens?|kings?)";
const PIECE_OF: Record<string, PieceType> = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };

const PASSIVE = new RegExp(
  `\\b(attacked|defended|protected|guarded)\\s+${ADVERB}(?:${TIMES}|by\\s+(${NUM}|a\\s+single|only\\s+one|just\\s+one)(?:\\s+(?:pieces?|${PIECE_WORD}))?\\b(?!\\s+(?:of|white|black|enemy|more|other|minor|major|pieces?|pawns?|knights?|bishops?|rooks?|queens?|kings?)\\b))`,
  "gi",
);
const ACTIVE = new RegExp(
  `\\b(attacks|attack|attacking|hits|hit|hitting|defends|defend|defending|protects|protect|protecting|guards|guard|guarding)\\s+([a-h][1-8]|it|that\\s+square)\\s+${ADVERB}${TIMES}(?![A-Za-z])`,
  "gi",
);
/** "no defender except the knight" is not a count of zero: an exception after the noun drops the claim. */
const NOUN = new RegExp(
  `\\b(no|zero|a\\s+single|${NUM})\\s+(?:(?:white|black|enemy|extra)\\s+)?(attackers?|defenders?)\\b(?!\\s+(?:except|but|other\\s+than|apart\\s+from|besides|beyond)\\b)`,
  "gi",
);

const PIECE_VALUE: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, piece: 3, "minor piece": 3, rook: 5, queen: 9, exchange: 2 };
const UNIT = `(?:(?:a|an|one|the|${NUM})\\s+(?:(?:whole|extra|clean|full)\\s+)?(?:minor\\s+pieces?|pawns?|knights?|bishops?|rooks?|queens?|pieces?|exchange))`;
const MATERIAL = `(material|${UNIT})(?:\\s+for\\s+(${UNIT}))?(?:\\s+(?:on|at)\\s+([a-h][1-8]))?`;
const OBJECT = "(?:(you|white|black|your\\s+opponent|the\\s+opponent)\\s+)?";
const FOR_SIDE = "(?:\\s+for\\s+(you|white|black|your\\s+opponent|the\\s+opponent)\\b)?";
const WIN = new RegExp(`\\b(?:win|wins|winning|won|gains?|gaining|gained|nets?|netting|netted|picks?\\s+up|picking\\s+up|picked\\s+up)\\s+${OBJECT}${MATERIAL}\\b${FOR_SIDE}`, "gi");
const LOSE = new RegExp(
  `\\b(?:lose|loses|losing|lost|drops?|dropping|dropped|costs?|costing|gives?\\s+up|giving\\s+up|gave\\s+up)\\s+${OBJECT}${MATERIAL}\\b${FOR_SIDE}`,
  "gi",
);
/** "comes out a knight up", "is a piece down", "ends up a pawn ahead", "are up a pawn". */
const STANDING = new RegExp(
  `\\b(?:(?:comes?|came|coming)\\s+out|is|are|was|were|['’]re|ends?\\s+up|ended\\s+up|ending\\s+up|finish(?:es|ed)?)\\s+(?:(${UNIT})\\s+(ahead|up|on\\s+top|behind|down)|(ahead|up|behind|down)\\s+(${UNIT}))\\b(?:\\s+for\\s+(${UNIT}))?${FOR_SIDE}`,
  "gi",
);
/** "comes out ahead": a sign without a size (only with "come out": "is behind" is no outcome). */
const COME_OUT_BARE = new RegExp(`\\b(?:comes?|came|coming)\\s+out\\s+(ahead|on\\s+top|behind)\\b(?!\\s+${UNIT})${FOR_SIDE}`, "gi");
const EVEN = /\b(?:breaks?\s+even|broke\s+even|(?:an?\s+)?(?:even|equal|level|fair)\s+(?:trade|exchange|swap)|nobody\s+wins|no\s+one\s+wins|neither\s+side\s+wins)\b/gi;
const EXCHANGE_WORD =
  /\b(?:exchang(?:e|es|ed|ing)|trad(?:e|es|ed|ing)|swap(?:s|ped|ping)?|(?:re)?captur(?:e|es|ed|ing)|take|takes|taking|took|(?:comes?|came|coming)\s+out)\b/gi;
/** A square named as where something stands or happens: "on e4", "at d5", "onto f7". */
const ON_SQUARE = /\b(?:on|at|onto)\s+$/i;
const SIDE_WORD = /\b(white|black|you|your\s+opponent|the\s+opponent|opponent)\b/gi;

function numberOf(word: string): number {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (/^\d$/.test(w)) return Number(w);
  if (w === "once") return 1;
  if (w === "twice") return 2;
  if (w === "thrice") return 3;
  const times = /^(\S+) times$/.exec(w);
  if (times) return numberOf(times[1]!);
  if (w === "a single" || w === "only one" || w === "just one") return 1;
  return NUM_WORDS[w] ?? NaN;
}

/** Pawns for "a pawn", "two pawns", "the exchange", "a minor piece". */
function unitValue(unit: string): number {
  const m = /^(\S+)\s+(?:(?:whole|extra|clean|full)\s+)?(minor\s+pieces?|\S+)$/i.exec(unit.trim().replace(/\s+/g, " "))!;
  const count = /^(?:a|an|the)$/i.test(m[1]!) ? 1 : numberOf(m[1]!);
  const piece = m[2]!.toLowerCase().replace(/s$/, "");
  return count * (PIECE_VALUE[piece] ?? NaN);
}

function sideOf(word: string | undefined, playerColor: Color | undefined): Color | null {
  if (!word) return null;
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (w === "white") return "w";
  if (w === "black") return "b";
  if (!playerColor) return null;
  if (w === "you") return playerColor;
  return playerColor === "w" ? "b" : "w";
}

interface Anchor {
  square: string;
  index: number;
  /** A SAN capture onto the square (also an exchange word). */
  capture: boolean;
}

interface Clause {
  start: number;
  text: string;
  /** Bare squares and SAN capture squares, in order. */
  anchors: Anchor[];
  /** The break before the clause ("" at the start of the text). */
  after: string;
}

function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  let from = 0;
  let after = "";
  const push = (to: number) => {
    const t = text.slice(from, to);
    const anchors: Anchor[] = [
      ...[...t.matchAll(SQUARE)].map((m) => ({ square: m[1]!, index: m.index, capture: false })),
      ...[...t.matchAll(SAN_CAPTURE)].map((m) => ({ square: m[1]!, index: m.index, capture: true })),
    ].sort((a, b) => a.index - b.index);
    out.push({ start: from, text: t, anchors, after });
  };
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    push(m.index);
    from = m.index + m[0].length;
    after = m[0].trim();
  }
  push(text.length);
  return out;
}

/** The nearest square before `at`, else the first after `after`, else the kept square. */
function squareNear(squares: Anchor[], at: number, after: number, kept: string | null): string | null {
  const before = squares.filter((s) => s.index + 2 <= at);
  if (before.length > 0) return before[before.length - 1]!.square;
  return squares.find((s) => s.index >= after)?.square ?? kept;
}

/** Exchange claims in `text`, in order (see the module comment). `playerColor` resolves "you". */
export function findExchangeClaims(text: string, playerColor?: Color): ExchangeClaim[] {
  const found: ExchangeClaim[] = [];
  /**
   * What a following clause without a square keeps: its square (for counts), the square of a count
   * claim in it, and its exchange square. An outcome keeps only a count or exchange square: in
   * "Black's bishop on d6 stood in front of your bishop on f4, and the trade wins a piece" no
   * square is the trade's.
   */
  type Kept = { square: string; counted: string | null; exchange: string | null };
  let kept: Kept | null = null;
  for (const c of clauses(text)) {
    const own = c.anchors.length > 0;
    const prev = kept as Kept | null; // widened: assigned at the end of the loop body
    const inherited = !own && prev && CARRY_BREAK.test(c.after) ? prev : null;
    if (!own && !inherited) {
      kept = null;
      continue;
    }
    const bare = c.anchors.filter((a) => !a.capture);
    const keptSquare = inherited?.square ?? null;
    const at = (i: number, raw: string) => ({ raw, start: c.start + i, end: c.start + i + raw.length });
    const state: { used: string | null } = { used: null };
    const count = (i: number, raw: string, square: string | null, role: "attackers" | "defenders", n: number, piece?: PieceType) => {
      if (!square || !Number.isFinite(n)) return;
      state.used = square;
      found.push({ kind: "count", ...at(i, raw), square, role, n, ...(piece ? { piece } : {}) });
    };

    for (const m of c.text.matchAll(PASSIVE)) {
      const role = /^attack/i.test(m[1]!) ? "attackers" : "defenders";
      const pieceWord = m[4]?.toLowerCase().replace(/s$/, "");
      count(m.index, m[0], squareNear(bare, m.index, m.index + m[0].length, keptSquare), role, numberOf(m[2] ?? m[3]!), pieceWord ? PIECE_OF[pieceWord] : undefined);
    }
    for (const m of c.text.matchAll(ACTIVE)) {
      const role = /^(?:attack|hit)/i.test(m[1]!) ? "attackers" : "defenders";
      const target = m[2]!.toLowerCase();
      count(m.index, m[0], /^[a-h][1-8]$/.test(target) ? target : keptSquare, role, numberOf(m[3]!));
    }
    for (const m of c.text.matchAll(NOUN)) {
      const role = /^attack/i.test(m[2]!) ? "attackers" : "defenders";
      count(m.index, m[0], squareNear(bare, m.index, m.index + m[0].length, keptSquare), role, numberOf(m[1]!));
    }

    // The exchange word and its square: a SAN capture's own square, else the first "on <square>" after
    // the word, else the last one before it ("captured by the d6 pawn" names the capturer, not the square).
    // A SAN capture is an exchange word only when the clause also names its square with "on / at /
    // onto <square>" (brief 110): "Nxe4 drops a piece on e4" is a claim, "Bxd6 wins the queen" is a
    // move mention, backed by the engine like any other move.
    const words = [...c.text.matchAll(EXCHANGE_WORD)].map((m) => m.index);
    const onSquares = c.anchors.filter((a) => !a.capture && ON_SQUARE.test(c.text.slice(0, a.index)));
    const captures = c.anchors.filter((a) => a.capture && onSquares.some((o) => o.square === a.square));
    const capture = captures[0];
    const first = Math.min(words[0] ?? Infinity, capture?.index ?? Infinity);
    const placed = [...captures, ...onSquares].sort((a, b) => a.index - b.index);
    let square: string | null = null;
    if (first !== Infinity) {
      if (capture && capture.index === first) square = capture.square;
      else if (own) square = placed.find((a) => a.index >= first)?.square ?? placed.filter((a) => a.index < first).pop()?.square ?? null;
      else square = inherited!.exchange ?? inherited!.counted;
    } else if (inherited) {
      square = inherited.exchange;
    }
    kept = inherited
      ? { square: inherited.square, counted: inherited.counted ?? state.used, exchange: square }
      : { square: state.used ?? c.anchors[c.anchors.length - 1]!.square, counted: state.used, exchange: first !== Infinity ? square : null };
    if (!square) continue;

    const subject = (i: number): Color | null => {
      const named = [...c.text.slice(0, i).matchAll(SIDE_WORD)].pop();
      return sideOf(named?.[1], playerColor);
    };
    const outcome = (m: RegExpMatchArray, sign: -1 | 0 | 1, size: number | null, side: Color | null, on?: string) => {
      const s = size !== null && sign !== 0 && size < 0 ? (-sign as -1 | 1) : sign;
      found.push({ kind: "outcome", ...at(m.index!, m[0]), square: on ?? square!, sign: size === 0 ? 0 : s, size: size === null ? null : Math.abs(size), side });
    };
    for (const [re, sign] of [
      [WIN, 1],
      [LOSE, -1],
    ] as const) {
      for (const m of c.text.matchAll(re)) {
        // "wins the rook on a1": the piece's own square names the square.
        const [, object, material, forUnit, onSquare, forSide] = m;
        const size = /^material$/i.test(material!) ? null : unitValue(material!) - (forUnit ? unitValue(forUnit) : 0);
        if (size !== null && !Number.isFinite(size)) continue;
        outcome(m, sign, size, sideOf(object, playerColor) ?? sideOf(forSide, playerColor) ?? subject(m.index!), onSquare);
      }
    }
    for (const m of c.text.matchAll(STANDING)) {
      const [, unitA, dirA, dirB, unitB, forUnit, forSide] = m;
      const sign = /^(?:ahead|up|on\s+top)$/i.test((dirA ?? dirB)!) ? 1 : -1;
      const size = unitValue((unitA ?? unitB)!) - (forUnit ? unitValue(forUnit) : 0);
      if (!Number.isFinite(size)) continue;
      outcome(m, sign, size, sideOf(forSide, playerColor) ?? subject(m.index!));
    }
    for (const m of c.text.matchAll(COME_OUT_BARE)) {
      outcome(m, /^behind$/i.test(m[1]!) ? -1 : 1, null, sideOf(m[2], playerColor) ?? subject(m.index!));
    }
    for (const m of c.text.matchAll(EVEN)) outcome(m, 0, 0, null);
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Whether one exchange_on_square result backs the claim (outcomes: startResult, review 108). */
export function exchangeBacks(claim: ExchangeClaim, r: ExchangeResult): boolean {
  if (r.square !== claim.square) return false;
  if (claim.kind === "count") {
    const list = claim.role === "attackers" ? r.attackers : r.defenders;
    return (claim.piece ? list.filter((p) => p.piece === claim.piece).length : list.length) === claim.n;
  }
  const start = startResult(r);
  if (start === null) return false; // nobody can capture there: no outcome
  const pov = claim.side ?? r.attackingSide;
  const value = Math.round(pov === r.attackingSide ? start : -start) + 0;
  return Math.sign(value) === claim.sign && (claim.size === null || Math.abs(value) === claim.size);
}

const COLOR_NAME = { w: "White", b: "Black" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const worth = (n: number) => `${n} ${n === 1 ? "pawn's" : "pawns'"} worth`;

/** startResult in words: "capturing first on e4 loses 2 pawns' worth for Black". */
function startInWords(r: ExchangeResult, start: number): string {
  const side = COLOR_NAME[r.attackingSide];
  const v = Math.round(start) + 0;
  const what = v > 0 ? `wins ${worth(v)}` : v < 0 ? `loses ${worth(-v)}` : "breaks even";
  return `capturing first on ${r.square} ${what} for ${side} (startResult ${v > 0 ? "+" : ""}${v}, from ${side}'s side, the side that captures first; for the other side the sign flips)`;
}

/**
 * Problems with the exchange claims in one field of the reply (FR-10, #44): a claim with no
 * exchange_on_square result for its square this turn, or one no such result agrees with.
 */
export function exchangeClaimProblems(
  field: string,
  text: string,
  resultsOn: (square: string) => ExchangeResult[],
  playerColor?: Color,
): string[] {
  const problems: string[] = [];
  const unbacked = new Set<string>(); // one "no result" problem per square
  for (const claim of findExchangeClaims(text, playerColor)) {
    const results = resultsOn(claim.square);
    if (results.some((r) => exchangeBacks(claim, r))) continue;
    const what = claim.kind === "count" ? `a count of ${claim.role}` : "the outcome of the exchange";
    if (results.length === 0) {
      if (unbacked.has(claim.square)) continue;
      unbacked.add(claim.square);
      problems.push(
        `${field} says "${claim.raw}" (${what} on ${claim.square}), but no exchange_on_square result for ${claim.square} backs it this turn. ` +
          `Call exchange_on_square for ${claim.square} before you count attackers and defenders or judge the exchange there, or leave the claim out.`,
      );
    } else if (claim.kind === "count") {
      const counts = results.map((r) => {
        if (claim.piece) {
          const list = claim.role === "attackers" ? r.attackers : r.defenders;
          return `${list.filter((p) => p.piece === claim.piece).length} of that kind among the ${claim.role}`;
        }
        return `${plural(r.attackers.length, "attacker")} and ${plural(r.defenders.length, "defender")}`;
      });
      problems.push(
        `${field} says "${claim.raw}" about ${claim.square}, but exchange_on_square counts ${[...new Set(counts)].join(" or ")} on ${claim.square} ` +
          `(attackers are the side that captures first, x-rays included). Copy the count from the tool result.`,
      );
    } else {
      const outcomes = results.map((r) => {
        const start = startResult(r);
        return start === null ? `no capture on ${r.square} (nobody can capture there, so there is no exchange outcome to state)` : startInWords(r, start);
      });
      problems.push(
        `${field} says "${claim.raw}" about the exchange on ${claim.square}, but exchange_on_square says ${[...new Set(outcomes)].join(" or ")}. ` +
          `An outcome is what happens if the first capture is made; state it as startResult gives it, from the right side's point of view, or leave it out.`,
      );
    }
  }
  return problems;
}
