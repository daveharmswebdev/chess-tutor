import { z } from "zod";
import type { ExplorerMove, ExplorerResult } from "./types.ts";

/**
 * Lichess explorer response, as measured in spike 002. Objects are non-strict so
 * unknown extra fields are ignored; only the fields we use are validated.
 */
const count = z.number().int().nonnegative();

const openingSchema = z.object({ eco: z.string(), name: z.string() });

const moveSchema = z.object({
  uci: z.string().min(1),
  san: z.string().min(1),
  averageRating: z.number(),
  white: count,
  draws: count,
  black: count,
});

const responseSchema = z.object({
  white: count,
  draws: count,
  black: count,
  moves: z.array(moveSchema),
  opening: openingSchema.nullish(),
});

/**
 * Lichess may spell castling as king-takes-rook (e1h1, e1a1, e8h8, e8a8). We expose
 * standard UCI (e1g1, e1c1, e8g8, e8c8). Only rewritten when the SAN says it is castling,
 * so a plain king move or capture on those squares is left alone. Idempotent.
 */
const KING_TAKES_ROOK: Record<string, Record<string, string>> = {
  "O-O": { e1h1: "e1g1", e8h8: "e8g8" },
  "O-O-O": { e1a1: "e1c1", e8a8: "e8c8" },
};

export function normalizeCastlingUci(san: string, uci: string): string {
  const castle = /^(O-O(?:-O)?)[+#]?$/.exec(san)?.[1];
  if (castle === undefined) return uci;
  return KING_TAKES_ROOK[castle]?.[uci] ?? uci;
}

/** Normalize every move in a result (used on fresh parse and on cache read). */
export function normalizeResultCastling<T extends ExplorerResult>(result: T): T {
  return { ...result, moves: result.moves.map((m) => ({ ...m, uci: normalizeCastlingUci(m.san, m.uci) })) };
}

/** Parse raw JSON into our ExplorerResult, or return undefined if the shape is wrong. */
export function parseExplorerResponse(raw: unknown): ExplorerResult | undefined {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const moves: ExplorerMove[] = r.moves.map((m) => ({
    uci: normalizeCastlingUci(m.san, m.uci),
    san: m.san,
    games: m.white + m.draws + m.black,
    white: m.white,
    draws: m.draws,
    black: m.black,
    averageRating: m.averageRating,
  }));
  moves.sort((a, b) => b.games - a.games);
  return {
    moves,
    totalGames: r.white + r.draws + r.black,
    opening: r.opening ? { eco: r.opening.eco, name: r.opening.name } : null,
  };
}

/** Schema for a cached ExplorerResult (our own shape), used when reading the cache back. */
export const cachedResultSchema = z.object({
  moves: z.array(
    z.object({
      uci: z.string(),
      san: z.string(),
      games: count,
      white: count,
      draws: count,
      black: count,
      averageRating: z.number(),
    }),
  ),
  totalGames: count,
  opening: openingSchema.nullable(),
});
