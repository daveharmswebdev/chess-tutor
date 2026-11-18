import type { Color, ExchangeResult } from "@chess-tutor/chess-core";

/**
 * Exchange claims in prose (#44: FR-21, FR-10, FR-23): what the claims check and the NFR-6 grader
 * read as a count of attackers or defenders on a square, or as the outcome of the exchange there.
 * Each one must be backed by this turn's exchange_on_square result for that square.
 *
 * Every claim needs a bare square in the same clause (clauses break at . ! ? ; , : and at so /
 * but / because / since / while / whereas / although / though / now that). A square inside a move
 * ("Nxe5", "Bf4") is not a bare square. Without a square there is no claim, so "the knight
 * attacks the queen" or "trading pieces helps when you are ahead" never trip it.
 *
 * Counts (compared with attackers.length / defenders.length, x-rays included):
 * - passive: "<square> is attacked twice", "defended three times", "protected once", "attacked by
 *   two (pieces)"; the square is the nearest bare square before the verb in the clause, else the
 *   first after it. "defended by two pawns" names pieces of one kind, not a count: not read.
 * - active: "attacks e5 twice", "defends d4 three times", "hits f7 twice" (the square follows the verb).
 * - nouns: "two attackers", "one defender", "no defenders", "a single defender", with the square
 *   placed as for the passive form ("two attackers and one defender on d4"); not when an
 *   exception follows ("no defender except the knight on b5").
 * Attack verbs map to attackers, defend / protect / guard to defenders, whichever side is named.
 *
 * Outcomes (compared with `result`, rounded to whole pawns), only in a clause with an exchange
 * word (exchange, trade, swap, captures, recaptures, "come out"):
 * - "wins / gains / nets / picks up <material>", "loses / drops / costs / gives up <material>",
 *   where <material> is "material" (sign only) or "a pawn", "two pawns", "a piece" (3), "a
 *   knight" / "a bishop" / "a minor piece" (3), "a rook" (5), "the queen" (9), "the exchange" (2),
 *   optionally "for <material>" ("wins a knight for a pawn" = 2);
 * - "comes out [<material>] ahead / up / on top / behind / down [for <material>]";
 * - "breaks even", "an even / equal / level / fair trade", "nobody wins": 0.
 * The point of view is the side named as the verb's object ("costs you a pawn"), else after it
 * ("for White"), else the last side named before it in the clause ("Black comes out a pawn
 * down"), else the attacking side of the result (the side that starts the captures). "you" is the
 * player. The square is the first bare square after the exchange word, else the last before it.
 */

export type ExchangeClaim =
  | { kind: "count"; raw: string; start: number; end: number; square: string; role: "attackers" | "defenders"; n: number }
  | { kind: "outcome"; raw: string; start: number; end: number; square: string; sign: -1 | 0 | 1; size: number | null; side: Color | null };

const CLAUSE_BREAK = /[.!?;,:](?=\s|$)|\n|\b(?:so|but|because|since|while|whereas|although|though|now that)\b/gi;
const SQUARE = /(?<![A-Za-z0-9-])([a-h][1-8])(?![A-Za-z0-9-])/g;

const NUM_WORDS: Record<string, number> = { no: 0, zero: 0, a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const NUM = "(?:zero|one|two|three|four|five|six|seven|eight|\\d)";
const TIMES = `(once|twice|thrice|${NUM}\\s+times)`;
const ADVERB = "(?:(?:only|just|already|still|now|also|currently|actually)\\s+)?";

const PASSIVE = new RegExp(
  `\\b(attacked|defended|protected|guarded)\\s+${ADVERB}(?:${TIMES}|by\\s+(${NUM})(?:\\s+pieces?)?\\b(?!\\s+(?:pawns?|knights?|bishops?|rooks?|queens?|kings?|minor|major|of|white|black|enemy|more|other)\\b))`,
  "gi",
);
const ACTIVE = new RegExp(
  `\\b(attacks|attack|attacking|hits|hit|hitting|defends|defend|defending|protects|protect|protecting|guards|guard|guarding)\\s+([a-h][1-8])\\s+${ADVERB}${TIMES}(?![A-Za-z])`,
  "gi",
);
/** "no defender except the knight" is not a count of zero: an exception after the noun drops the claim. */
const NOUN = new RegExp(
  `\\b(no|zero|a\\s+single|${NUM})\\s+(?:(?:white|black|enemy|extra)\\s+)?(attackers?|defenders?)\\b(?!\\s+(?:except|but|other\\s+than|apart\\s+from|besides|beyond)\\b)`,
  "gi",
);

const PIECE_VALUE: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, piece: 3, "minor piece": 3, rook: 5, queen: 9, exchange: 2 };
const UNIT = `(?:(?:a|an|one|the|${NUM})\\s+(?:(?:whole|extra|clean|full)\\s+)?(?:minor\\s+pieces?|pawns?|knights?|bishops?|rooks?|queens?|pieces?|exchange))`;
const MATERIAL = `(material|${UNIT})(?:\\s+for\\s+(${UNIT}))?`;
const OBJECT = "(?:(you|white|black|your\\s+opponent|the\\s+opponent)\\s+)?";
const FOR_SIDE = "(?:\\s+for\\s+(you|white|black|your\\s+opponent|the\\s+opponent)\\b)?";
const WIN = new RegExp(`\\b(?:wins?|winning|won|gains?|gaining|gained|nets?|netting|netted|picks?\\s+up|picking\\s+up|picked\\s+up)\\s+${OBJECT}${MATERIAL}\\b${FOR_SIDE}`, "gi");
const LOSE = new RegExp(
  `\\b(?:loses?|losing|lost|drops?|dropping|dropped|costs?|costing|gives?\\s+up|giving\\s+up|gave\\s+up)\\s+${OBJECT}${MATERIAL}\\b${FOR_SIDE}`,
  "gi",
);
const COME_OUT = new RegExp(
  `\\b(?:comes?|came|coming)\\s+out\\s+(?:(${UNIT})\\s+)?(ahead|up|on\\s+top|behind|down)\\b(?:\\s+for\\s+(${UNIT}))?${FOR_SIDE}`,
  "gi",
);
const EVEN = /\b(?:breaks?\s+even|broke\s+even|(?:an?\s+)?(?:even|equal|level|fair)\s+(?:trade|exchange|swap)|nobody\s+wins|no\s+one\s+wins|neither\s+side\s+wins)\b/gi;
const EXCHANGE_WORD = /\b(?:exchang(?:e|es|ed|ing)|trad(?:e|es|ed|ing)|swap(?:s|ped|ping)?|captures|recaptures|(?:comes?|came|coming)\s+out)\b/i;
const SIDE_WORD = /\b(white|black|you|your\s+opponent|the\s+opponent|opponent)\b/gi;

function numberOf(word: string): number {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  if (/^\d$/.test(w)) return Number(w);
  if (w === "once") return 1;
  if (w === "twice") return 2;
  if (w === "thrice") return 3;
  const times = /^(\S+) times$/.exec(w);
  if (times) return numberOf(times[1]!);
  if (w === "a single") return 1;
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

interface Clause {
  start: number;
  text: string;
  squares: { square: string; index: number }[];
}

function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  let from = 0;
  const push = (to: number) => {
    const t = text.slice(from, to);
    const squares = [...t.matchAll(SQUARE)].map((m) => ({ square: m[1]!, index: m.index }));
    if (squares.length > 0) out.push({ start: from, text: t, squares });
  };
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    push(m.index);
    from = m.index + m[0].length;
  }
  push(text.length);
  return out;
}

/** The nearest bare square before `at` in the clause, else the first after `after`. */
function squareNear(c: Clause, at: number, after: number): string | null {
  const before = c.squares.filter((s) => s.index + 2 <= at);
  if (before.length > 0) return before[before.length - 1]!.square;
  return c.squares.find((s) => s.index >= after)?.square ?? null;
}

/** The first bare square after `at` in the clause, else the last before it. */
function squareAfter(c: Clause, at: number): string | null {
  return c.squares.find((s) => s.index >= at)?.square ?? c.squares.filter((s) => s.index < at).pop()?.square ?? null;
}

/** Exchange claims in `text`, in order (see the module comment). `playerColor` resolves "you". */
export function findExchangeClaims(text: string, playerColor?: Color): ExchangeClaim[] {
  const found: ExchangeClaim[] = [];
  for (const c of clauses(text)) {
    const at = (i: number, raw: string) => ({ raw, start: c.start + i, end: c.start + i + raw.length });
    for (const m of c.text.matchAll(PASSIVE)) {
      const role = /^attack/i.test(m[1]!) ? "attackers" : "defenders";
      const n = numberOf(m[2] ?? m[3]!);
      const square = squareNear(c, m.index, m.index + m[0].length);
      if (square && Number.isFinite(n)) found.push({ kind: "count", ...at(m.index, m[0]), square, role, n });
    }
    for (const m of c.text.matchAll(ACTIVE)) {
      const role = /^(?:attack|hit)/i.test(m[1]!) ? "attackers" : "defenders";
      const n = numberOf(m[3]!);
      if (Number.isFinite(n)) found.push({ kind: "count", ...at(m.index, m[0]), square: m[2]!.toLowerCase(), role, n });
    }
    for (const m of c.text.matchAll(NOUN)) {
      const role = /^attack/i.test(m[2]!) ? "attackers" : "defenders";
      const n = numberOf(m[1]!);
      const square = squareNear(c, m.index, m.index + m[0].length);
      if (square && Number.isFinite(n)) found.push({ kind: "count", ...at(m.index, m[0]), square, role, n });
    }

    const word = EXCHANGE_WORD.exec(c.text);
    if (!word) continue;
    const square = squareAfter(c, word.index);
    if (!square) continue;
    const subject = (i: number): Color | null => {
      const named = [...c.text.slice(0, i).matchAll(SIDE_WORD)].pop();
      return sideOf(named?.[1], playerColor);
    };
    const outcome = (m: RegExpMatchArray, sign: -1 | 0 | 1, size: number | null, side: Color | null) => {
      const s = size !== null && sign !== 0 && size < 0 ? (-sign as -1 | 1) : sign;
      found.push({ kind: "outcome", ...at(m.index!, m[0]), square, sign: size === 0 ? 0 : s, size: size === null ? null : Math.abs(size), side });
    };
    for (const [re, sign] of [
      [WIN, 1],
      [LOSE, -1],
    ] as const) {
      for (const m of c.text.matchAll(re)) {
        const [, object, material, forUnit, forSide] = m;
        const size = /^material$/i.test(material!) ? null : unitValue(material!) - (forUnit ? unitValue(forUnit) : 0);
        if (size !== null && !Number.isFinite(size)) continue;
        outcome(m, sign, size, sideOf(object, playerColor) ?? sideOf(forSide, playerColor) ?? subject(m.index!));
      }
    }
    for (const m of c.text.matchAll(COME_OUT)) {
      const [, unit, direction, forUnit, forSide] = m;
      const sign = /^(?:ahead|up|on\s+top)$/i.test(direction!) ? 1 : -1;
      const size = unit ? unitValue(unit) - (forUnit ? unitValue(forUnit) : 0) : null;
      if (size !== null && !Number.isFinite(size)) continue;
      outcome(m, sign, size, sideOf(forSide, playerColor) ?? subject(m.index!));
    }
    for (const m of c.text.matchAll(EVEN)) outcome(m, 0, 0, null);
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Whether one exchange_on_square result backs the claim. */
export function exchangeBacks(claim: ExchangeClaim, r: ExchangeResult): boolean {
  if (r.square !== claim.square) return false;
  if (claim.kind === "count") return (claim.role === "attackers" ? r.attackers.length : r.defenders.length) === claim.n;
  const pov = claim.side ?? r.attackingSide;
  const value = Math.round(pov === r.attackingSide ? r.result : -r.result) + 0;
  return Math.sign(value) === claim.sign && (claim.size === null || Math.abs(value) === claim.size);
}

const COLOR_NAME = { w: "White", b: "Black" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

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
      const counts = results.map((r) => `${plural(r.attackers.length, "attacker")} and ${plural(r.defenders.length, "defender")}`);
      problems.push(
        `${field} says "${claim.raw}" about ${claim.square}, but exchange_on_square counts ${[...new Set(counts)].join(" or ")} on ${claim.square} ` +
          `(attackers are the side that captures first, x-rays included). Copy the count from the tool result.`,
      );
    } else {
      const outcomes = results.map((r) => `${signed(Math.round(r.result) + 0)} for ${COLOR_NAME[r.attackingSide]} (the attacking side)`);
      problems.push(
        `${field} says "${claim.raw}" about the exchange on ${claim.square}, but exchange_on_square gives a result of ${[...new Set(outcomes)].join(" or ")}, ` +
          `in pawns with best stopping. State the outcome as the tool gives it, from the right side's point of view.`,
      );
    }
  }
  return problems;
}
