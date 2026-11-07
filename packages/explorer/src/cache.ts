import { DatabaseSync } from "node:sqlite";
import { cachedResultSchema } from "./schema.ts";
import type { ExplorerCache, ExplorerResult } from "./types.ts";

export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * SQLite cache for explorer results (node:sqlite, no native dependency).
 * Entries older than ttlMs are treated as missing; set() overwrites.
 * Unavailable (out-of-book because Lichess failed) results are never stored.
 */
export function createSqliteExplorerCache(
  path: string,
  ttlMs: number = DEFAULT_TTL_MS,
): ExplorerCache & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE IF NOT EXISTS explorer_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL)",
  );
  const select = db.prepare("SELECT body, fetched_at FROM explorer_cache WHERE key = ?");
  const upsert = db.prepare(
    "INSERT INTO explorer_cache (key, body, fetched_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
  );

  return {
    get(key, nowMs) {
      const row = select.get(key);
      if (!row) return undefined;
      const fetchedAt = Number(row["fetched_at"]);
      if (!(nowMs - fetchedAt < ttlMs)) return undefined;
      try {
        const parsed = cachedResultSchema.safeParse(JSON.parse(String(row["body"])));
        return parsed.success ? (parsed.data satisfies ExplorerResult) : undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value, nowMs) {
      if (value.unavailable !== undefined) return;
      const body: ExplorerResult = { moves: value.moves, totalGames: value.totalGames, opening: value.opening };
      upsert.run(key, JSON.stringify(body), Math.trunc(nowMs));
    },
    close() {
      db.close();
    },
  };
}
