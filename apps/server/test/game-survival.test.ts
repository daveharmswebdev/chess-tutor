import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { GameEvent, GameView } from "@chess-tutor/chess-core";
import { buildServer } from "../src/app.ts";
import type { GameManager } from "../src/games.ts";
import { createSqliteGameStore, type GameStore } from "../src/store.ts";
import {
  createFakeAnalyzer,
  createFakeBot,
  createFakeTutor,
  eventCollector,
  fenAfter,
  okOutcome,
  ucis,
  type FakeAnalyzer,
  type FakeBot,
  type FakeTutor,
} from "./helpers.ts";

/*
 * Game survival (#47: NFR-14, FR-5, IR-7, NFR-9). A server ("A") on a file-backed SQLite
 * database is closed the way a deploy closes it, and a new server ("B") on the same file
 * carries on with the game.
 */

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface Server {
  app: FastifyInstance;
  games: GameManager;
  store: GameStore;
  bot: FakeBot;
  analyzer: FakeAnalyzer;
  tutor: FakeTutor;
  close(): Promise<void>;
}

let dir: string;
let dbPath: string;
const open: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chess-tutor-survival-"));
  dbPath = join(dir, "games.sqlite");
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A server on dbPath. Ids are `${prefix}1`, `${prefix}2`, ... so A's and B's never collide. */
function boot(prefix: string, script: string[] = [], opts: { coachingOff?: boolean } = {}): Server {
  const store = createSqliteGameStore(dbPath);
  const bot = createFakeBot(script);
  const analyzer = createFakeAnalyzer();
  const tutor = createFakeTutor();
  let n = 0;
  const { app, games } = buildServer({
    bot,
    store,
    newId: () => `${prefix}${++n}`,
    logger: false,
    coaching: opts.coachingOff
      ? { analyzer, tutor: null, offReason: "Coaching is off: no API key is set." }
      : { analyzer, tutor },
  });
  let closed = false;
  const server: Server = {
    app,
    games,
    store,
    bot,
    analyzer,
    tutor,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      store.close();
    },
  };
  open.push(server);
  return server;
}

async function post(s: Server, url: string, body?: unknown) {
  const res = await s.app.inject({ method: "POST", url, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

async function get(s: Server, id: string) {
  const res = await s.app.inject({ method: "GET", url: `/api/games/${id}` });
  return { status: res.statusCode, view: res.json() as GameView, raw: res.body };
}

async function newGame(s: Server, playerColor: "w" | "b" = "w") {
  const res = await post(s, "/api/games", { playerColor });
  expect(res.status, res.raw).toBe(201);
  const game = res.body as unknown as GameView;
  const events = eventCollector();
  s.games.subscribe(game.id, events.push);
  return { id: game.id, game, events };
}

async function play(s: Server, id: string, uci: string): Promise<GameView> {
  const res = await post(s, `/api/games/${id}/moves`, { uci });
  expect(res.status, res.raw).toBe(200);
  await s.games.idle(id);
  return s.games.view(id)!;
}

/** The row as a second connection on the same file sees it (what a restart would read). */
function onDisk(id: string) {
  const fresh = createSqliteGameStore(dbPath);
  try {
    return fresh.get(id);
  } finally {
    fresh.close();
  }
}

const P1 = fenAfter(["d2d4", "d7d5"]);

/** 1. d4 d5 2. e4?: e4 loses 300 cp (Nf3 was best), so it is a player_blunder; e6 keeps it. */
function scriptBlunderAfterD4D5(a: FakeAnalyzer) {
  a.set(P1, 0, "g1f3");
  a.set(fenAfter(["d2d4", "d7d5", "e2e4"]), -300);
  a.set(fenAfter(["d2d4", "d7d5", "e2e4", "e7e6"]), -300);
}

describe("restart mid-game (NFR-14)", () => {
  it("a new server on the same database file carries on: same moves, fen and open question", async () => {
    const a = boot("a", ["d7d5", "e7e6"]);
    scriptBlunderAfterD4D5(a.analyzer);
    const { id, events } = await newGame(a);
    await play(a, id, "d2d4");
    await play(a, id, "e2e4");
    (await a.tutor.ask(0)).resolve(okOutcome({ reveal: "Nf3 develops and keeps e4 for later.", revealMove: "g1f3" }));
    const reply = await events.next("tutor_reply");
    if (reply.type !== "tutor_reply") throw new Error("unreachable");
    await a.games.idle(id);
    expect(ucis(a.games.view(id)!)).toEqual(["d2d4", "d7d5", "e2e4", "e7e6"]);
    expect((await post(a, `/api/games/${id}/takeback`)).status).toBe(200);
    const before = (await get(a, id)).view;
    expect(before.fen).toBe(P1);
    expect(before.tutor.question).toEqual(reply.question);
    await a.close();

    const b = boot("b", ["g8f6"]);
    const after = await get(b, id);
    expect(after.status).toBe(200);
    expect(after.view).toEqual(before);
    expect(after.view.status).toBe("playing");
    expect(after.raw).not.toContain("Nf3 develops");

    // The open question is still graded: the next move from attemptFen is an attempt.
    const evB = eventCollector();
    b.games.subscribe(id, evB.push);
    const next = await play(b, id, "g1f3");
    expect(ucis(next)).toEqual(["d2d4", "d7d5", "g1f3", "g8f6"]);
    expect(next.moves.map((m) => m.by)).toEqual(["player", "bot", "player", "bot"]);
    expect(await evB.next("tutor_attempt")).toMatchObject({ questionId: reply.question.id, correct: true });
    expect(b.tutor.asks).toHaveLength(0);
  });

  it("shutdown no longer abandons a game in progress", async () => {
    const a = boot("a", ["e7e5"]);
    const { id } = await newGame(a);
    await play(a, id, "e2e4");
    await a.close();
    expect(onDisk(id)).toMatchObject({ status: "playing", result: "*", endReason: null });
    const b = boot("b");
    expect((await get(b, id)).view).toMatchObject({ status: "playing", moves: [{ uci: "e2e4" }, { uci: "e7e5" }] });
  });

  it("a new game after the restart still abandons the restored one", async () => {
    const a = boot("a", ["e7e5"]);
    const { id } = await newGame(a);
    await play(a, id, "e2e4");
    await a.close();
    const b = boot("b");
    const events = eventCollector();
    b.games.subscribe(id, events.push);
    await newGame(b);
    expect(await events.next("game_over")).toMatchObject({ game: { id, status: "abandoned" } });
    expect(onDisk(id)).toMatchObject({ status: "abandoned", endReason: "abandoned" });
  });
});

describe("saved before it is acknowledged", () => {
  it("the player's move is on disk when the HTTP reply arrives, the bot's when bot_move is sent", async () => {
    const a = boot("a", ["e7e5"]);
    a.bot.hold();
    const { id } = await newGame(a);
    expect(onDisk(id)).toMatchObject({ status: "playing", playerColor: "w" });
    const diskAtBotMove: string[] = [];
    a.games.subscribe(id, (e: GameEvent) => {
      if (e.type === "bot_move") diskAtBotMove.push(onDisk(id)!.pgn);
    });
    expect((await post(a, `/api/games/${id}/moves`, { uci: "e2e4" })).status).toBe(200);
    expect(onDisk(id)!.pgn).toMatch(/1\. e4 \*\s*$/);
    a.bot.release();
    await a.games.idle(id);
    expect(diskAtBotMove).toHaveLength(1);
    expect(diskAtBotMove[0]).toMatch(/1\. e4 e5 \*\s*$/);
  });

  it("a bot that answers at once: its move is on disk before the player's HTTP reply", async () => {
    const a = boot("a", ["e7e5"]);
    const { id } = await newGame(a);
    expect((await post(a, `/api/games/${id}/moves`, { uci: "e2e4" })).status).toBe(200);
    await a.games.idle(id);
    expect(onDisk(id)!.pgn).toMatch(/1\. e4 e5 \*\s*$/);
  });

  it("takeback and resign are on disk when acknowledged", async () => {
    const a = boot("a", ["e7e5"]);
    const { id } = await newGame(a);
    await play(a, id, "e2e4");
    expect((await post(a, `/api/games/${id}/takeback`)).status).toBe(200);
    const row = onDisk(id)!;
    expect(row.pgn).not.toContain("e4");
    expect(JSON.parse(row.state!)).toMatchObject({ moves: [] });
    expect((await post(a, `/api/games/${id}/resign`)).status).toBe(200);
    expect(onDisk(id)).toMatchObject({ status: "finished", result: "0-1", endReason: "resigned" });
  });
});

describe("the bot due on restart", () => {
  it("is asked again on startup and its move arrives as usual", async () => {
    const a = boot("a");
    a.bot.hold();
    const { id } = await newGame(a);
    expect((await post(a, `/api/games/${id}/moves`, { uci: "d2d4" })).status).toBe(200);
    expect(a.games.view(id)!.botThinking).toBe(true);
    await a.close();

    const b = boot("b", ["g8f6"]);
    expect(b.bot.calls).toEqual([fenAfter(["d2d4"])]);
    await b.games.idle(id);
    const view = (await get(b, id)).view;
    expect(ucis(view)).toEqual(["d2d4", "g8f6"]);
    expect(view.botThinking).toBe(false);
    expect(onDisk(id)!.pgn).toMatch(/1\. d4 Nf6 \*\s*$/);
  });

  it("a game started as Black whose first bot move was lost", async () => {
    const a = boot("a");
    a.bot.hold();
    const { id } = await newGame(a, "b");
    await a.close();
    const b = boot("b", ["d2d4"]);
    await b.games.idle(id);
    expect((await get(b, id)).view).toMatchObject({ playerColor: "b", botThinking: false, moves: [{ uci: "d2d4", by: "bot" }] });
  });
});

describe("the tutor thinking on restart", () => {
  it("re-runs the same ask, and the reply arrives as usual", async () => {
    const a = boot("a", ["e7e5"]);
    a.analyzer.set(START, 0, "d2d4");
    a.analyzer.set(fenAfter(["e2e4"]), -300);
    a.analyzer.set(fenAfter(["e2e4", "e7e5"]), -300);
    const { id } = await newGame(a);
    await play(a, id, "e2e4");
    const askA = await a.tutor.ask(0);
    expect(a.games.view(id)!.tutor.thinking).toBe(true);
    await a.close();
    expect(askA.signal?.aborted).toBe(true);

    const b = boot("b");
    const askB = await b.tutor.ask(0);
    expect(askB.request).toEqual(askA.request);
    expect(b.tutor.sessions).toEqual([{ id, playerColor: "w", engine: expect.any(Object) }]);
    expect((await get(b, id)).view.tutor).toMatchObject({ thinking: true, question: null });

    const events = eventCollector();
    b.games.subscribe(id, events.push);
    askB.resolve(okOutcome({ reveal: "d4 holds the centre.", revealMove: "d2d4" }));
    const reply = await events.next("tutor_reply");
    expect(reply).toMatchObject({ question: { kind: "player_blunder", attemptFen: START } });
    expect((await get(b, id)).view.tutor).toMatchObject({ thinking: false, question: { attemptFen: START } });
  });

  it("with coaching off after the restart, the ask is dropped and the game goes on (NFR-9)", async () => {
    const a = boot("a", ["e7e5"]);
    a.analyzer.set(START, 0, "d2d4");
    a.analyzer.set(fenAfter(["e2e4"]), -300);
    a.analyzer.set(fenAfter(["e2e4", "e7e5"]), -300);
    const { id } = await newGame(a);
    await play(a, id, "e2e4");
    await a.tutor.ask(0);
    await a.close();

    const b = boot("b", ["b8c6"], { coachingOff: true });
    expect((await get(b, id)).view.tutor).toMatchObject({ available: false, thinking: false });
    expect(JSON.parse(onDisk(id)!.state!)).toMatchObject({ tutor: { ask: null } });
    expect(ucis(await play(b, id, "g1f3"))).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
  });
});

describe("tutor.reveal (#47)", () => {
  async function openQuestion(s: Server) {
    s.analyzer.set(START, 0, "d2d4");
    s.analyzer.set(fenAfter(["e2e4"]), -300);
    s.analyzer.set(fenAfter(["e2e4", "e7e5"]), -300);
    const { id, events } = await newGame(s);
    await play(s, id, "e2e4");
    (await s.tutor.ask(0)).resolve(okOutcome({ reveal: "d4 holds the centre.", revealMove: "d2d4" }));
    const reply = await events.next("tutor_reply");
    if (reply.type !== "tutor_reply") throw new Error("unreachable");
    return { id, events, question: reply.question };
  }

  it("is null while the reveal is held, and the reveal text is not in the view", async () => {
    const a = boot("a", ["e7e5"]);
    const { id } = await openQuestion(a);
    const res = await get(a, id);
    expect(res.view.tutor.reveal).toBeNull();
    expect(res.raw).not.toContain("d4 holds the centre.");
  });

  it("after Show me: the revealed question and its reveal, also after a restart", async () => {
    const a = boot("a", ["e7e5"]);
    const { id, question } = await openQuestion(a);
    const res = await post(a, `/api/games/${id}/tutor/reveal`);
    expect(res.status).toBe(200);
    const shown = (await get(a, id)).view.tutor;
    expect(shown.reveal).toEqual(res.body);
    expect(shown.question).toEqual(question);
    await a.close();

    const b = boot("b");
    const restored = (await get(b, id)).view.tutor;
    expect(restored.reveal).toEqual(res.body);
    expect(restored.question).toEqual(question);
    // Shown already: the question is closed for "Show me".
    expect((await post(b, `/api/games/${id}/tutor/reveal`)).status).toBe(409);
    // The next change of position clears it.
    expect((await post(b, `/api/games/${id}/takeback`)).status).toBe(200);
    expect((await get(b, id)).view.tutor).toMatchObject({ question: null, reveal: null });
  });

  it("after a wrong try: the question is closed into a note, not kept in tutor (#53, FR-24, FR-8)", async () => {
    const a = boot("a", ["e7e5", "e7e5", "b8c6"]);
    const { id, events, question } = await openQuestion(a);
    expect((await post(a, `/api/games/${id}/takeback`)).status).toBe(200);
    await play(a, id, "e2e4"); // the same mistake again: -300
    const revealed = await events.next("tutor_reveal");
    if (revealed.type !== "tutor_reveal") throw new Error("unreachable");
    await a.games.idle(id);
    // The try left attemptFen: the next GameView has no question, and the note holds the reveal.
    const afterTry = events.events.slice(events.events.indexOf(revealed)).find((e) => e.type === "state");
    if (afterTry?.type !== "state") throw new Error("no state after the try");
    for (const v of [afterTry.game, (await get(a, id)).view]) {
      expect(v.tutor).toMatchObject({ question: null, reveal: null });
      expect(v.notes!.at(-1)).toMatchObject({
        questionId: question.id,
        reveal: "d4 holds the centre.",
        bestMove: { uci: "d2d4", san: "d4", by: "player" },
        attempt: { correct: false, cpLoss: 300, move: { uci: "e2e4" } },
      });
    }
    const note = (await get(a, id)).view.notes;
    await a.close();

    const b = boot("b", ["b8c6"]);
    const restored = (await get(b, id)).view;
    expect(restored.tutor).toMatchObject({ question: null, reveal: null });
    expect(restored.notes).toEqual(note);
    await play(b, id, "g1f3");
    expect((await get(b, id)).view.notes).toEqual(note);
  });
});

describe("saved games after a restart (FR-5)", () => {
  it("a finished game and an abandoned one are still GET-able; an unknown id is 404", async () => {
    const a = boot("a", ["e7e5"]);
    const first = await newGame(a);
    await play(a, first.id, "e2e4");
    await newGame(a); // abandons the first
    const second = (await get(a, "a2")).view;
    expect((await post(a, `/api/games/${second.id}/resign`)).status).toBe(200);
    await a.close();

    const b = boot("b");
    const abandoned = await get(b, first.id);
    expect(abandoned.status).toBe(200);
    expect(abandoned.view).toMatchObject({ status: "abandoned", endReason: "abandoned", moves: [{ uci: "e2e4" }, { uci: "e7e5" }] });
    const finished = await get(b, second.id);
    expect(finished.view).toMatchObject({ status: "finished", endReason: "resigned", result: "0-1", botThinking: false });
    expect((await post(b, `/api/games/${second.id}/moves`, { uci: "e2e4" })).status).toBe(409);
    expect((await get(b, "never-created")).status).toBe(404);
    const sse = await b.app.inject({ method: "GET", url: "/api/games/never-created/events" });
    expect(sse.statusCode).toBe(404);
  });
});

describe("schema v1 database", () => {
  it("migrates to v2; its saved games stay readable, rebuilt from the PGN", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE games (
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
    db.exec("PRAGMA user_version = 1");
    const pgn =
      '[Event "Sparring game"]\n[Site "Chess Tutor"]\n[Date "2026.11.07"]\n[Round "-"]\n[White "Sparring bot"]\n' +
      '[Black "Player"]\n[Result "1-0"]\n[Termination "resigned"]\n\n1. d4 Nf6 2. c4 1-0\n';
    db.prepare("INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "old1",
      "b",
      "finished",
      "1-0",
      "resigned",
      pgn,
      "2026-11-07T10:00:00.000Z",
      "2026-11-07T10:05:00.000Z",
    );
    db.close();

    const b = boot("b");
    const check = new DatabaseSync(dbPath);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    check.close();
    expect(b.store.get("old1")).toMatchObject({ status: "finished", pgn, state: null });
    const res = await get(b, "old1");
    expect(res.status).toBe(200);
    expect(res.view).toMatchObject({ id: "old1", playerColor: "b", status: "finished", result: "1-0", endReason: "resigned" });
    expect(res.view.moves).toEqual([
      { uci: "d2d4", san: "d4", by: "bot" },
      { uci: "g8f6", san: "Nf6", by: "player" },
      { uci: "c2c4", san: "c4", by: "bot" },
    ]);
    // A v2 game in the migrated database works as usual.
    const { id } = await newGame(b);
    await play(b, id, "e2e4");
    expect(onDisk(id)).toMatchObject({ status: "playing" });
  });

  it("a database newer than this server is refused", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => createSqliteGameStore(dbPath)).toThrow(/schema version 99/);
  });
});

describe("review 065 (round 2)", () => {
  it("(A) close() stops new tutor asks: detection held at shutdown starts none after release", async () => {
    const a = boot("a", ["e7e5"]);
    a.analyzer.set(START, 0, "d2d4");
    a.analyzer.set(fenAfter(["e2e4"]), -300);
    a.analyzer.set(fenAfter(["e2e4", "e7e5"]), -300);
    const { id, events } = await newGame(a);
    a.analyzer.hold();
    expect((await post(a, `/api/games/${id}/moves`, { uci: "e2e4" })).status).toBe(200);
    await events.next("bot_move"); // detection now waits on the held analyzer
    await a.close();
    a.analyzer.release();
    await a.games.idle(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(a.tutor.asks).toHaveLength(0);
  });

  it("(B) a damaged row (illegal saved move) is left unchanged on startup", async () => {
    const a = boot("a", ["e7e5"]);
    const { id } = await newGame(a);
    await play(a, id, "e2e4");
    await a.close();
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT state FROM games WHERE id = ?").get(id) as { state: string };
    const state = JSON.parse(row.state) as { moves: { uci: string; by: string }[] };
    state.moves.push({ uci: "e1e8", by: "player" }, { uci: "a7a6", by: "bot" });
    db.prepare("UPDATE games SET state = ? WHERE id = ?").run(JSON.stringify(state), id);
    const before = db.prepare("SELECT * FROM games WHERE id = ?").get(id);
    db.close();

    const b = boot("b");
    expect(b.bot.calls).toEqual([]);
    expect((await get(b, id)).status).toBe(200);
    expect((await post(b, `/api/games/${id}/moves`, { uci: "g1f3" })).status).toBe(409);
    await newGame(b); // would abandon a live copy of it
    await b.close();
    const check = new DatabaseSync(dbPath);
    expect(check.prepare("SELECT * FROM games WHERE id = ?").get(id)).toEqual(before);
    check.close();
  });

  it("(C) a failed store write on create is a 500, not a 201", async () => {
    const real = createSqliteGameStore(dbPath);
    const failing: GameStore = {
      save() {
        throw new Error("disk full");
      },
      get: (id) => real.get(id),
      listPlaying: () => real.listPlaying(),
      close: () => real.close(),
    };
    const bot = createFakeBot();
    const { app, games } = buildServer({ bot, store: failing, newId: () => "c1", logger: false });
    try {
      const res = await app.inject({ method: "POST", url: "/api/games", payload: { playerColor: "b" } });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: expect.any(String) });
      expect(games.view("c1")).toBeUndefined();
    } finally {
      await app.close();
      real.close();
    }
  });
});

describe("review 068 (round 3)", () => {
  it("(A) a failed save of the new game leaves the old one playing: no game_over, moves still accepted", async () => {
    const real = createSqliteGameStore(dbPath);
    const store: GameStore = {
      save(g) {
        if (g.id === "g2") throw new Error("disk full");
        real.save(g);
      },
      get: (id) => real.get(id),
      listPlaying: () => real.listPlaying(),
      close: () => real.close(),
    };
    let n = 0;
    const { app, games } = buildServer({ bot: createFakeBot(["e7e5", "b8c6"]), store, newId: () => `g${++n}`, logger: false });
    try {
      const first = await app.inject({ method: "POST", url: "/api/games", payload: { playerColor: "w" } });
      expect(first.statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: "/api/games/g1/moves", payload: { uci: "e2e4" } })).statusCode).toBe(200);
      await games.idle("g1");
      const events = eventCollector();
      games.subscribe("g1", events.push);

      const second = await app.inject({ method: "POST", url: "/api/games", payload: { playerColor: "w" } });
      expect(second.statusCode).toBe(500);
      expect(second.json()).toEqual({ error: expect.any(String) });
      expect(games.view("g1")!.status).toBe("playing");
      expect(onDisk("g1")).toMatchObject({ status: "playing", endReason: null });
      expect(events.events.map((e) => e.type)).not.toContain("game_over");
      expect((await app.inject({ method: "POST", url: "/api/games/g1/moves", payload: { uci: "g1f3" } })).statusCode).toBe(200);
    } finally {
      await app.close();
      real.close();
    }
  });

  it("(B) a store read error is a 500 on GET and on the event stream, not a 404", async () => {
    const real = createSqliteGameStore(dbPath);
    const store: GameStore = {
      save: (g) => real.save(g),
      get() {
        throw new Error("database is locked");
      },
      listPlaying: () => real.listPlaying(),
      close: () => real.close(),
    };
    const { app } = buildServer({ bot: createFakeBot(), store, logger: false });
    try {
      const res = await app.inject({ method: "GET", url: "/api/games/old1" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: expect.any(String) });
      const sse = await app.inject({ method: "GET", url: "/api/games/old1/events" });
      expect(sse.statusCode).toBe(500);
      expect(sse.json()).toEqual({ error: expect.any(String) });
    } finally {
      await app.close();
      real.close();
    }
  });
});
