import type { Color, Score } from "./types.ts";

/** Value of "mate now" in centipawns; mate in N is MATE_CP - 100 * N. */
export const MATE_CP = 100000;
const MATE_STEP_CP = 100;

/**
 * Converts a White-relative engine score to centipawns from `pov`'s point of view.
 * Mate in N (N != 0) maps to sign * (MATE_CP - 100 * |N|), so faster mates score higher.
 * Mate 0 means the side to move in the scored position is mated; pass `sideToMove`
 * so it can be signed (without it, mate 0 is treated as 0).
 */
export function scoreToCp(score: Score, pov: Color, sideToMove?: Color): number {
  let white: number;
  if (score.kind === "cp") {
    white = score.value;
  } else if (score.value === 0) {
    white = sideToMove === undefined ? 0 : sideToMove === "w" ? -MATE_CP : MATE_CP;
  } else {
    white = Math.sign(score.value) * (MATE_CP - MATE_STEP_CP * Math.abs(score.value));
  }
  const cp = pov === "w" ? white : -white;
  return cp === 0 ? 0 : cp; // avoid -0
}
