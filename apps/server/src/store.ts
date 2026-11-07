import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Color, GameEndReason, GameResult, GameStatus } from "@chess-tutor/chess-core";

/** A saved game (FR-5, IR-7). Only finished and abandoned games are written. */
export interface SavedGame {
  id: string;
  playerColor: Color;
  status: GameStatus;
  result: GameResult;
  endReason: GameEndReason | null;
  pgn: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
}

export interface GameStore {
  /** Insert or replace by id. */
  save(game: SavedGame): void;
  get(id: string): SavedGame | undefined;
  close(): void;
}

export const DEFAULT_DB_PATH = fileURLToPath(new URL("../../../data/chess-tutor.sqlite", import.meta.url));

/** DB_PATH from the environment; unset or empty means <repo root>/data/chess-tutor.sqlite. */
export function resolveDbPath(env: Record<string, string | undefined>): string {
  const path = env["DB_PATH"];
  return path === undefined || path === "" ? DEFAULT_DB_PATH : path;
}

const SCHEMA_VERSION = 1;

/**
 * SQLite game store (node:sqlite). Schema version 1 is one `games` row per game with the
 * whole PGN. Tutor comments (#7, FR-5) are planned as a separate `game_comments` table
 * keyed by (game_id, ply) and folded into the PGN as {...} comments; PRAGMA user_version
 * tracks the schema so that table can be added by a migration.
 */
export function createSqliteGameStore(path: string): GameStore {
  if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      player_color TEXT NOT NULL CHECK (player_color IN ('w', 'b')),
      status TEXT NOT NULL,
      result TEXT NOT NULL,
      end_reason TEXT,
      pgn TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version === 0) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const upsert = db.prepare(
    `INSERT INTO games (id, player_color, status, result, end_reason, pgn, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, result = excluded.result,
       end_reason = excluded.end_reason, pgn = excluded.pgn, updated_at = excluded.updated_at`,
  );
  const select = db.prepare("SELECT * FROM games WHERE id = ?");

  return {
    save(g) {
      upsert.run(g.id, g.playerColor, g.status, g.result, g.endReason, g.pgn, g.createdAt, g.updatedAt);
    },
    get(id) {
      const row = select.get(id);
      if (!row) return undefined;
      return {
        id: String(row["id"]),
        playerColor: row["player_color"] as Color,
        status: row["status"] as GameStatus,
        result: row["result"] as GameResult,
        endReason: (row["end_reason"] ?? null) as GameEndReason | null,
        pgn: String(row["pgn"]),
        createdAt: String(row["created_at"]),
        updatedAt: String(row["updated_at"]),
      };
    },
    close() {
      db.close();
    },
  };
}
