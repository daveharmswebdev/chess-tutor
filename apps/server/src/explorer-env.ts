import type { BotExplorer } from "@chess-tutor/chess-core";
import { createExplorerClient, createSqliteExplorerCache, type OutOfBookReason } from "@chess-tutor/explorer";
import type { TutorExplorer } from "@chess-tutor/tutor";

export interface BotExplorerSetup {
  explorer: BotExplorer;
  /** The same explorer as the tutor sees it (#7): the real client, or an always-unavailable stub. */
  tutorExplorer: TutorExplorer;
  /** True when there is no token and the bot plays engine-only. */
  engineOnly: boolean;
  close(): void;
}

/** Explorer for a missing token: every position is out of book, so the bot uses the engine. */
export const NO_TOKEN_EXPLORER: BotExplorer = {
  async lookup() {
    return { moves: [], totalGames: 0, unavailable: "no_token" };
  },
};

/**
 * The tutor's no-token explorer: every lookup is unavailable, which the tutor handles.
 * "no_token" is not an OutOfBookReason (contract gap reported for #7), hence the cast.
 */
export const NO_TOKEN_TUTOR_EXPLORER: TutorExplorer = {
  async lookup() {
    return { moves: [], totalGames: 0, opening: null, unavailable: "no_token" as OutOfBookReason };
  },
};

/**
 * The bot's explorer from LICHESS_TOKEN. With a token: the real Lichess client with a
 * SQLite cache in the server database. Without one (unset, empty or blank): one warning
 * and the no-token stub, so the server still runs (and e2e tests make no network calls).
 */
export function createBotExplorer(opts: {
  token: string | undefined;
  dbPath: string;
  warn: (message: string) => void;
}): BotExplorerSetup {
  if (opts.token === undefined || opts.token.trim() === "") {
    opts.warn(
      "LICHESS_TOKEN is not set: the sparring bot plays engine-only (no opening explorer). " +
        "Add LICHESS_TOKEN to .env to enable human-like opening moves.",
    );
    return { explorer: NO_TOKEN_EXPLORER, tutorExplorer: NO_TOKEN_TUTOR_EXPLORER, engineOnly: true, close() {} };
  }
  const cache = createSqliteExplorerCache(opts.dbPath);
  try {
    const explorer = createExplorerClient({ token: opts.token, cache });
    return { explorer, tutorExplorer: explorer, engineOnly: false, close: () => cache.close() };
  } catch (err) {
    cache.close();
    throw err;
  }
}
