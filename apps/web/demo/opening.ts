// Opening moves for the guided demo (#59: FR-27). The bot's replies are not known in advance, so
// each scripted move is played only if chess.js finds it legal in the actual position (built from
// the real move list on the page); otherwise the next candidate is tried.
import { Chess } from "chess.js";

/** One step per White move; each step lists candidates in order of preference. */
export const OPENING_PLAN: readonly (readonly string[])[] = [
  ["d4"],
  // Legal whatever Black replied: d4 opened c1-f4 and no single Black move blocks or covers it away.
  ["Bf4"],
];

/** Quiet London developing moves, for one more move when no mistake qualifies yet. */
export const FALLBACK_MOVES: readonly string[] = ["e3", "Nf3", "c3", "Nbd2", "h3", "Bd3", "Be2", "a3"];

export interface PlannedMove {
  san: string;
  from: string;
  to: string;
}

export function fenFromSans(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san); // throws on an illegal move
  return chess.fen();
}

const bare = (san: string) => san.replace(/[+#]$/, "");

/** The first candidate legal for White in the position after `sans`, or null. */
export function firstLegal(sans: readonly string[], candidates: readonly string[]): PlannedMove | null {
  const chess = new Chess(fenFromSans(sans));
  if (chess.turn() !== "w") return null;
  const legal = chess.moves({ verbose: true });
  for (const c of candidates) {
    const m = legal.find((l) => bare(l.san) === bare(c));
    if (m) return { san: m.san, from: m.from, to: m.to };
  }
  return null;
}
