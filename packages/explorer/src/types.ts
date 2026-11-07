/** Our own explorer types. Nothing outside this package sees Lichess's raw JSON (IR-8). */

export interface ExplorerMove {
  uci: string;
  san: string;
  /** white + draws + black */
  games: number;
  white: number;
  draws: number;
  black: number;
  averageRating: number;
}

export type OutOfBookReason = "rate_limited" | "server_error" | "network" | "timeout" | "bad_response";

export interface ExplorerResult {
  /** Sorted by games, descending. */
  moves: ExplorerMove[];
  /** white + draws + black of the position. */
  totalGames: number;
  opening: { eco: string; name: string } | null;
  /** Set only when Lichess couldn't answer; then moves is [] and totalGames is 0. */
  unavailable?: OutOfBookReason;
}

export interface LookupOptions {
  ratings: number[];
  speeds: string[];
}

export interface ExplorerCache {
  get(key: string, nowMs: number): ExplorerResult | undefined;
  set(key: string, value: ExplorerResult, nowMs: number): void;
}

/** A misconfiguration (missing or rejected token). Never carries the token itself. */
export class ExplorerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplorerConfigError";
  }
}
