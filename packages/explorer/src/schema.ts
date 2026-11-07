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

/** Parse raw JSON into our ExplorerResult, or return undefined if the shape is wrong. */
export function parseExplorerResponse(raw: unknown): ExplorerResult | undefined {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const moves: ExplorerMove[] = r.moves.map((m) => ({
    uci: m.uci,
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
