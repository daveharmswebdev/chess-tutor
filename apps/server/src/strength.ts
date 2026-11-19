import { BOT_STRENGTH } from "@chess-tutor/chess-core";

/**
 * Per-game bot strength (#84: FR-1, FR-2, FR-3 as amended by A11). Valid means a whole number
 * from BOT_STRENGTH.min to BOT_STRENGTH.max on a BOT_STRENGTH.step; omitted means the default.
 */
export function isValidStrength(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= BOT_STRENGTH.min &&
    value <= BOT_STRENGTH.max &&
    (value - BOT_STRENGTH.min) % BOT_STRENGTH.step === 0
  );
}

/** The 400 message for anything else: names the allowed range. */
export const STRENGTH_RANGE_MESSAGE =
  `strength must be a number from ${BOT_STRENGTH.min} to ${BOT_STRENGTH.max} in steps of ${BOT_STRENGTH.step}` +
  ` (omit it for ${BOT_STRENGTH.default})`;
