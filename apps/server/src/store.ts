import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BOT_STRENGTH, type Color, type GameEndReason, type GameResult, type GameStatus } from "@chess-tutor/chess-core";
import { isValidStrength } from "./strength.ts";

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
  /**
   * Schema v3 (FR-28, #64): who started the game. "demo" for a game started by the daily demo
   * with the right DEMO_TOKEN, else "player" (the default when omitted). Set once, on insert:
   * a later save never changes it. Server-side only; not part of GameView.
   */
  source?: GameSource;
  /**
   * Schema v5 (#84: FR-1, NFR-14): the bot's strength for this game (BOT_STRENGTH). Set once, on
   * insert: a later save never changes it. Omitted on save means BOT_STRENGTH.default; rows from
   * before v5 (NULL) read back as BOT_STRENGTH.default.
   */
  strength?: number;
}

export type GameSource = "player" | "demo";

/**
 * One row of the usage ledger (schema v4; FR-29, NFR-5, architecture 3.8): one per finished tutor
 * ask (replies dropped after the fact included: their tokens were spent) and one per bot failure.
 * Counts and categories only; no PGN, FEN or text (NFR-15).
 */
export interface UsageEvent {
  /** ISO 8601 UTC, from the game manager's now(). */
  at: string;
  /** For per-game sums (#9); never part of the daily stats. Null when unknown. */
  gameId: string | null;
  source: GameSource;
  /** A TutorKind for tutor asks, or "bot_failed". */
  kind: string;
  ok: boolean;
  /** The TutorFailureReason of a failed ask; null when ok and for bot_failed. */
  reason: string | null;
  ms: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** The model that served the ask; null for bot_failed rows or when unknown. */
  model: string | null;
}

/** The stored usage ledger (IR-7): survives restarts; read by /ops/daily-stats and later BudgetGuard (#9). */
export interface UsageLedger {
  /** Appends a row; synchronous like save(). */
  recordUsage(event: UsageEvent): void;
  /** Rows with from <= at < to (ISO strings), oldest first. */
  usageBetween(fromIso: string, toIso: string): UsageEvent[];
  /** Games created with from <= created_at < to, by source. */
  gamesStartedBetween(fromIso: string, toIso: string): Record<GameSource, number>;
}

export type SqliteGameStore = GameStore & UsageLedger;

/** True when a store also keeps the usage ledger (the SQLite store does). */
export function isUsageLedger(value: unknown): value is UsageLedger {
  const v = value as Partial<UsageLedger> | null;
  return !!v && typeof v.recordUsage === "function" && typeof v.usageBetween === "function" && typeof v.gamesStartedBetween === "function";
}

/** A row as read back: `state` and `source` are always present (null and "player" for old rows). */
export type StoredGame = SavedGame & { state: string | null; source: GameSource; strength: number };

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

export const SCHEMA_VERSION = 5;

/**
 * SQLite game store (node:sqlite, one connection). Writes are synchronous: when save()
 * returns, the row is in the database, so the caller can acknowledge the change.
 *
 * Schema (PRAGMA user_version):
 *   1  one `games` row per finished or abandoned game, with the whole PGN.
 *   2  adds `state` (JSON: the live game state) and an index on status; games in progress are
 *      saved too (#47, NFR-14). Migrated from 1 by ALTER TABLE, so v1 rows keep working with
 *      state NULL and are rebuilt from their PGN.
 *   3  adds `source` ('player' or 'demo', default 'player'; FR-28, #64), so usage reporting can
 *      tell demo games apart. Migrated by ALTER TABLE; older rows read back as 'player'.
 *   4  adds the usage ledger `usage_events` (FR-29, NFR-5, #60; architecture 3.8): one row per
 *      finished tutor ask and per bot failure (at, game_id, source, kind, ok, reason, ms, the five
 *      token counts, model), indexed on `at`. Read by GET /ops/daily-stats and later BudgetGuard
 *      (#9). Created with CREATE TABLE IF NOT EXISTS; v3 games are untouched.
 *   5  adds `strength` (INTEGER, the bot's strength for the game; #84, FR-1, NFR-14), written on
 *      insert only. Migrated by ALTER TABLE; older rows (NULL) read back as BOT_STRENGTH.default.
 * Tutor notes (#53, FR-25, FR-5) live in `state` (its `notes` array, [] when absent) and in the
 * PGN as {...} comments; no separate table and no schema change.
 * A database with a newer version than this code knows is refused.
 */
export function createSqliteGameStore(path: string): SqliteGameStore {
  if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }

  const upsert = db.prepare(
    `INSERT INTO games (id, player_color, status, result, end_reason, pgn, created_at, updated_at, state, source, strength)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, result = excluded.result,
       end_reason = excluded.end_reason, pgn = excluded.pgn, updated_at = excluded.updated_at,
       state = excluded.state`,
  );
  const select = db.prepare("SELECT * FROM games WHERE id = ?");
  const selectPlaying = db.prepare("SELECT * FROM games WHERE status = 'playing' ORDER BY created_at, id");
  const insertUsage = db.prepare(
    `INSERT INTO usage_events (at, game_id, source, kind, ok, reason, ms, requests, input_tokens, output_tokens,
       cache_read_input_tokens, cache_creation_input_tokens, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectUsage = db.prepare("SELECT * FROM usage_events WHERE at >= ? AND at < ? ORDER BY at, id");
  const countStarted = db.prepare("SELECT source, COUNT(*) AS n FROM games WHERE created_at >= ? AND created_at < ? GROUP BY source");

  return {
    save(g) {
      upsert.run(g.id, g.playerColor, g.status, g.result, g.endReason, g.pgn, g.createdAt, g.updatedAt, g.state ?? null, g.source ?? "player", g.strength ?? BOT_STRENGTH.default);
    },
    get(id) {
      const row = select.get(id);
      return row ? fromRow(row) : undefined;
    },
    listPlaying() {
      return selectPlaying.all().map(fromRow);
    },
    recordUsage(e) {
      insertUsage.run(
        e.at,
        e.gameId,
        e.source,
        e.kind,
        e.ok ? 1 : 0,
        e.reason,
        Math.round(e.ms),
        e.requests,
        e.inputTokens,
        e.outputTokens,
        e.cacheReadInputTokens,
        e.cacheCreationInputTokens,
        e.model,
      );
    },
    usageBetween(fromIso, toIso) {
      return selectUsage.all(fromIso, toIso).map(usageFromRow);
    },
    gamesStartedBetween(fromIso, toIso) {
      const counts: Record<GameSource, number> = { player: 0, demo: 0 };
      for (const r of countStarted.all(fromIso, toIso)) counts[r["source"] === "demo" ? "demo" : "player"] += Number(r["n"]);
      return counts;
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
    source: row["source"] === "demo" ? "demo" : "player",
    strength: strengthFromRow(row["strength"]),
  };
}

/** NULL (a row from before v5) or a damaged value reads back as the default strength. */
function strengthFromRow(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  return isValidStrength(n) ? n : BOT_STRENGTH.default;
}

function usageFromRow(row: Record<string, unknown>): UsageEvent {
  const nullable = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    at: String(row["at"]),
    gameId: nullable(row["game_id"]),
    source: row["source"] === "demo" ? "demo" : "player",
    kind: String(row["kind"]),
    ok: Number(row["ok"]) === 1,
    reason: nullable(row["reason"]),
    ms: Number(row["ms"]),
    requests: Number(row["requests"]),
    inputTokens: Number(row["input_tokens"]),
    outputTokens: Number(row["output_tokens"]),
    cacheReadInputTokens: Number(row["cache_read_input_tokens"]),
    cacheCreationInputTokens: Number(row["cache_creation_input_tokens"]),
    model: nullable(row["model"]),
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
    // Version 3 (#64, FR-28): who started the game; every older row is a player game.
    if (!columns.includes("source")) db.exec("ALTER TABLE games ADD COLUMN source TEXT NOT NULL DEFAULT 'player' CHECK (source IN ('player', 'demo'))");
    // Version 4 (#60, FR-29): the usage ledger. Counts only (NFR-15); `at` is ISO UTC.
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        game_id TEXT,
        source TEXT NOT NULL CHECK (source IN ('player', 'demo')),
        kind TEXT NOT NULL,
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        reason TEXT,
        ms INTEGER NOT NULL,
        requests INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL,
        model TEXT
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events (at)");
    // Version 5 (#84, FR-1): the bot's strength per game; older rows stay NULL (the default).
    if (!columns.includes("strength")) db.exec("ALTER TABLE games ADD COLUMN strength INTEGER");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
