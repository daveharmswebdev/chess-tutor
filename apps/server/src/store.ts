import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Color, GameEndReason, GameResult, GameStatus } from "@chess-tutor/chess-core";

/**
 * A saved game (FR-5, IR-7, NFR-14). Every game is written from its creation on, and again
 * before each change to it is acknowledged (#47), so a game in progress survives a restart.
 */
export interface SavedGame {
  id: string;
  playerColor: Color;
  status: GameStatus;
  result: GameResult;
  endReason: GameEndReason | null;
  /** The whole game as PGN (FR-5); Result "*" while playing. */
  pgn: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /**
   * Schema v2: the game manager's live state as JSON (moves, bot due, tutor state; see
   * games.ts), enough to rebuild the game exactly. Null (or omitted on save) for rows written
   * under schema v1; those are rebuilt from the PGN.
   */
  state?: string | null;
}

/** A row as read back: `state` is always present (null for v1 rows). */
export type StoredGame = SavedGame & { state: string | null };

export interface GameStore {
  /** Insert or replace by id. */
  save(game: SavedGame): void;
  get(id: string): StoredGame | undefined;
  /** Every game whose status is "playing", oldest first (loaded on startup, #47). */
  listPlaying(): StoredGame[];
  close(): void;
}

export const DEFAULT_DB_PATH = fileURLToPath(new URL("../../../data/chess-tutor.sqlite", import.meta.url));

/** DB_PATH from the environment; unset or empty means <repo root>/data/chess-tutor.sqlite. */
export function resolveDbPath(env: Record<string, string | undefined>): string {
  const path = env["DB_PATH"];
  return path === undefined || path === "" ? DEFAULT_DB_PATH : path;
}

export const SCHEMA_VERSION = 2;

/**
 * SQLite game store (node:sqlite, one connection). Writes are synchronous: when save()
 * returns, the row is in the database, so the caller can acknowledge the change.
 *
 * Schema (PRAGMA user_version):
 *   1  one `games` row per finished or abandoned game, with the whole PGN.
 *   2  adds `state` (JSON: the live game state) and an index on status; games in progress are
 *      saved too (#47, NFR-14). Migrated from 1 by ALTER TABLE, so v1 rows keep working with
 *      state NULL and are rebuilt from their PGN.
 * Tutor notes (#53, FR-25, FR-5) live in `state` (its `notes` array, [] when absent) and in the
 * PGN as {...} comments; no separate table and no schema change.
 * A database with a newer version than this code knows is refused.
 */
export function createSqliteGameStore(path: string): GameStore {
  if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  const upsert = db.prepare(
    `INSERT INTO games (id, player_color, status, result, end_reason, pgn, created_at, updated_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, result = excluded.result,
       end_reason = excluded.end_reason, pgn = excluded.pgn, updated_at = excluded.updated_at,
       state = excluded.state`,
  );
  const select = db.prepare("SELECT * FROM games WHERE id = ?");
  const selectPlaying = db.prepare("SELECT * FROM games WHERE status = 'playing' ORDER BY created_at, id");

  return {
    save(g) {
      upsert.run(g.id, g.playerColor, g.status, g.result, g.endReason, g.pgn, g.createdAt, g.updatedAt, g.state ?? null);
    },
    get(id) {
      const row = select.get(id);
      return row ? fromRow(row) : undefined;
    },
    listPlaying() {
      return selectPlaying.all().map(fromRow);
    },
    close() {
      db.close();
    },
  };
}

function fromRow(row: Record<string, unknown>): StoredGame {
  const state = row["state"];
  return {
    id: String(row["id"]),
    playerColor: row["player_color"] as Color,
    status: row["status"] as GameStatus,
    result: row["result"] as GameResult,
    endReason: (row["end_reason"] ?? null) as GameEndReason | null,
    pgn: String(row["pgn"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    state: state === null || state === undefined ? null : String(state),
  };
}

function migrate(db: DatabaseSync): void {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > SCHEMA_VERSION) {
    throw new Error(`the game database has schema version ${version}; this server knows versions up to ${SCHEMA_VERSION}`);
  }
  if (version === SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Version 1, the base of every database.
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
    // Version 2 (#47): the live state; games in progress are saved and loaded on startup.
    const columns = db.prepare("PRAGMA table_info(games)").all().map((c) => String(c["name"]));
    if (!columns.includes("state")) db.exec("ALTER TABLE games ADD COLUMN state TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS games_status ON games (status)");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
