import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { BOT_STRENGTH, type GameView } from "@chess-tutor/chess-core";
import { buildServer } from "../src/app.ts";
import type { GameManager } from "../src/games.ts";
import { createSqliteGameStore, SCHEMA_VERSION, type GameStore } from "../src/store.ts";
import { createFakeBot, type FakeBot } from "./helpers.ts";

/*
 * Per-game bot strength (#84: FR-1, FR-2, FR-3, NFR-14). POST /api/games takes an optional
 * strength; it is saved with the game, reported in every GameView, and passed to every
 * bot.chooseMove for that game, after a restart too.
 */

interface Server {
  app: FastifyInstance;
  games: GameManager;
  store: GameStore;
  bot: FakeBot;
  close(): Promise<void>;
}

let dir: string;
let dbPath: string;
const open: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chess-tutor-strength-"));
  dbPath = join(dir, "games.sqlite");
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

function boot(prefix: string, opts: { demoToken?: string } = {}): Server {
  const store = createSqliteGameStore(dbPath);
  const bot = createFakeBot();
  let n = 0;
  const { app, games } = buildServer({
    bot,
    store,
    newId: () => `${prefix}${++n}`,
    logger: false,
    ...(opts.demoToken === undefined ? {} : { demoToken: opts.demoToken }),
  });
  let closed = false;
  const s: Server = {
    app,
    games,
    store,
    bot,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      store.close();
    },
  };
  open.push(s);
  return s;
}

async function post(s: Server, url: string, body?: unknown, headers?: Record<string, string>) {
  const res = await s.app.inject({
    method: "POST",
    url,
    ...(headers ? { headers } : {}),
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.json() as GameView & { error?: string }, raw: res.body };
}

async function newGame(s: Server, body: Record<string, unknown>): Promise<GameView> {
  const res = await post(s, "/api/games", body);
  expect(res.status, res.raw).toBe(201);
  await s.games.idle(res.body.id);
  return res.body;
}

async function play(s: Server, id: string, uci: string): Promise<GameView> {
  const res = await post(s, `/api/games/${id}/moves`, { uci });
  expect(res.status, res.raw).toBe(200);
  await s.games.idle(id);
  return s.games.view(id)!;
}

function rowCount(): number {
  const db = new DatabaseSync(dbPath);
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

describe("POST /api/games with a strength (#84, FR-1)", () => {
  it("strength 800: the GameView reports it and the bot's reply uses it", async () => {
    const s = boot("a");
    const game = await newGame(s, { playerColor: "w", strength: 800 });
    expect(game.strength).toBe(800);
    const after = await play(s, game.id, "d2d4");
    expect(after.strength).toBe(800);
    expect(s.bot.options).toEqual([{ strength: 800 }]);
    expect((await s.app.inject({ method: "GET", url: `/api/games/${game.id}` })).json()).toMatchObject({ strength: 800 });
  });

  it("strength 800 as Black: the bot's first move uses it", async () => {
    const s = boot("a");
    const game = await newGame(s, { playerColor: "b", strength: 800 });
    expect(game.strength).toBe(800);
    expect(s.bot.options).toEqual([{ strength: 800 }]);
    await play(s, game.id, "e7e5");
    expect(s.bot.options).toEqual([{ strength: 800 }, { strength: 800 }]);
  });

  it("no strength: 1400 in the GameView and in chooseMove", async () => {
    const s = boot("a");
    const game = await newGame(s, { playerColor: "b" });
    expect(game.strength).toBe(BOT_STRENGTH.default);
    expect(game.strength).toBe(1400);
    await play(s, game.id, "e7e5");
    expect(s.bot.options).toEqual([{ strength: 1400 }, { strength: 1400 }]);
  });

  it.each([500, 1300, 1400, 2500])("boundary %i is valid", async (strength) => {
    const s = boot("a");
    const game = await newGame(s, { playerColor: "b", strength });
    expect(game.strength).toBe(strength);
    expect(s.bot.options).toEqual([{ strength }]);
  });

  const invalid: [string, unknown][] = [
    ['the string "800"', "800"],
    ["850 (not on a step)", 850],
    ["1320 (not on a step)", 1320],
    ["400 (below the range)", 400],
    ["2600 (above the range)", 2600],
    ["null", null],
    ["a fraction", 800.5],
    ["true", true],
    ["an object", { value: 800 }],
  ];

  it.each(invalid)("%s answers 400, creates nothing and leaves the playing game alone", async (_label, strength) => {
    const s = boot("a");
    const existing = await newGame(s, { playerColor: "w", strength: 1200 });
    await play(s, existing.id, "d2d4");
    const before = s.games.view(existing.id)!;
    const callsBefore = s.bot.calls.length;

    const res = await post(s, "/api/games", { playerColor: "w", strength });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toMatch(/500/);
    expect(res.body.error).toMatch(/2500/);
    expect(res.body.error).toMatch(/100/);
    expect(s.games.view(existing.id)).toEqual(before);
    expect(s.games.view(existing.id)?.status).toBe("playing");
    expect(s.games.view("a2")).toBeUndefined();
    expect(rowCount()).toBe(1);
    expect(s.bot.calls.length).toBe(callsBefore);
  });

  it("NaN (not sendable as JSON) is refused by the manager with a 400", () => {
    const s = boot("a");
    expect(() => s.games.create("w", { strength: Number.NaN })).toThrow(/500/);
    try {
      s.games.create("w", { strength: Number.NaN });
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
    expect(rowCount()).toBe(0);
  });

  it("a demo game takes a strength under the same rules", async () => {
    const s = boot("a", { demoToken: "tok" });
    const ok = await post(s, "/api/games", { playerColor: "b", strength: 2000 }, { "x-demo-token": "tok" });
    expect(ok.status, ok.raw).toBe(201);
    expect(ok.body.strength).toBe(2000);
    await s.games.idle(ok.body.id);
    expect(s.bot.options).toEqual([{ strength: 2000 }]);
    const bad = await post(s, "/api/games", { playerColor: "b", strength: 2050 }, { "x-demo-token": "tok" });
    expect(bad.status).toBe(400);
    expect(s.games.view(ok.body.id)?.status).toBe("playing");
  });
});

describe("bot retry (#23) keeps the game's strength", () => {
  it("botRetry calls chooseMove with the game's strength", async () => {
    const s = boot("a");
    const game = await newGame(s, { playerColor: "w", strength: 900 });
    s.bot.failNext("engine died");
    await play(s, game.id, "d2d4");
    expect(s.games.view(game.id)?.botThinking).toBe(false);
    const res = await post(s, `/api/games/${game.id}/bot-retry`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.strength).toBe(900);
    await s.games.idle(game.id);
    expect(s.bot.options).toEqual([{ strength: 900 }, { strength: 900 }]);
    expect(s.games.view(game.id)?.moves).toHaveLength(2);
  });
});

describe("restart (NFR-14) keeps the game's strength", () => {
  it("a game saved at 800 comes back at 800, and its resumed bot move uses 800", async () => {
    const a = boot("a");
    const game = await newGame(a, { playerColor: "w", strength: 800 });
    a.bot.hold();
    const res = await post(a, `/api/games/${game.id}/moves`, { uci: "d2d4" });
    expect(res.status).toBe(200);
    await a.close(); // the bot was still thinking: B must ask again
    expect(createSqliteGameStoreGet(game.id)?.strength).toBe(800);

    const b = boot("b");
    await b.games.idle(game.id);
    expect(b.bot.options).toEqual([{ strength: 800 }]);
    const view = b.games.view(game.id)!;
    expect(view.strength).toBe(800);
    expect(view.moves).toHaveLength(2);
    await play(b, game.id, "c2c4");
    expect(b.bot.options).toEqual([{ strength: 800 }, { strength: 800 }]);
  });

  it("a finished game read back from the store reports its strength", async () => {
    const a = boot("a");
    const game = await newGame(a, { playerColor: "w", strength: 2300 });
    expect((await post(a, `/api/games/${game.id}/resign`)).status).toBe(200);
    await a.close();
    const b = boot("b");
    expect(b.games.view(game.id)).toMatchObject({ status: "finished", strength: 2300 });
  });

  it("a later save does not change the saved strength", async () => {
    const a = boot("a");
    const game = await newGame(a, { playerColor: "w", strength: 600 });
    a.store.save({ ...a.store.get(game.id)!, strength: 2000, updatedAt: new Date().toISOString() });
    expect(a.store.get(game.id)?.strength).toBe(600);
  });
});

function createSqliteGameStoreGet(id: string) {
  const s = createSqliteGameStore(dbPath);
  try {
    return s.get(id);
  } finally {
    s.close();
  }
}

describe("schema v5: the strength column (#84, NFR-14)", () => {
  it("is at schema version 5", () => {
    expect(SCHEMA_VERSION).toBe(5);
  });

  it("a v4 database migrates to v5; rows without a strength read back as 1400 and play at 1400", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        player_color TEXT NOT NULL CHECK (player_color IN ('w', 'b')),
        status TEXT NOT NULL, result TEXT NOT NULL, end_reason TEXT, pgn TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT,
        source TEXT NOT NULL DEFAULT 'player' CHECK (source IN ('player', 'demo'))
      );
      CREATE INDEX games_status ON games (status);
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, game_id TEXT,
        source TEXT NOT NULL CHECK (source IN ('player', 'demo')), kind TEXT NOT NULL,
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)), reason TEXT, ms INTEGER NOT NULL, requests INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL, model TEXT
      );
      CREATE INDEX usage_events_at ON usage_events (at);
      INSERT INTO games VALUES ('old-1', 'w', 'playing', '*', NULL, '[Event "Sparring game"]\n[Result "*"]\n\n1. e4 *\n', '2026-11-15T09:00:00.000Z', '2026-11-15T09:01:00.000Z', NULL, 'player');
      INSERT INTO games VALUES ('old-2', 'b', 'finished', '1-0', 'resigned', 'pgn-b', '2026-11-14T09:00:00.000Z', '2026-11-14T09:01:00.000Z', NULL, 'demo');
      PRAGMA user_version = 4;
    `);
    db.close();

    const b = boot("b");
    const check = new DatabaseSync(dbPath);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    expect(check.prepare("PRAGMA table_info(games)").all().map((c) => String(c["name"]))).toContain("strength");
    check.close();
    expect(b.store.get("old-1")).toMatchObject({ status: "playing", strength: 1400 });
    expect(b.store.get("old-2")).toMatchObject({ status: "finished", source: "demo", strength: 1400 });
    // The restored game's bot move (after 1. e4 it is Black's turn: the bot's) plays at 1400.
    await b.games.idle("old-1");
    expect(b.bot.options).toEqual([{ strength: 1400 }]);
    expect(b.games.view("old-1")?.strength).toBe(1400);
    await b.close();

    // Reopening a v5 database is a no-op; a v4 database whose column already exists migrates again.
    const again = new DatabaseSync(dbPath);
    again.exec("PRAGMA user_version = 4");
    again.close();
    const c = boot("c");
    expect(c.store.get("old-2")?.strength).toBe(1400);
  });

  it("a database newer than v5 is still refused", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 6");
    db.close();
    expect(() => createSqliteGameStore(dbPath)).toThrow(/schema version 6/);
  });
});
