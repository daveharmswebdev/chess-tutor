import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { GameView } from "@chess-tutor/chess-core";
import type { TutorUsage } from "@chess-tutor/tutor";
import { buildServer, DEMO_TOKEN_HEADER } from "../src/app.ts";
import { loadPricing } from "../src/config.ts";
import type { GameManager } from "../src/games.ts";
import { computeDailyStats, nearestRank, parseStatsDate, type DailyStats, type Pricing } from "../src/stats.ts";
import { createSqliteGameStore, SCHEMA_VERSION, type SqliteGameStore, type UsageEvent } from "../src/store.ts";
import {
  createFakeAnalyzer,
  createFakeBot,
  createFakeTutor,
  failOutcome,
  fenAfter,
  okOutcome,
  type FakeBot,
  type FakeTutor,
} from "./helpers.ts";

/*
 * GET /ops/daily-stats (FR-29, #60; NFR-5, NFR-15, IR-10, IR-7, FR-28): one UTC day's counts
 * from SQLite, behind OPS_STATS_TOKEN, player and demo apart.
 */

const TOKEN = "ops-test-token-0123456789";
const DEMO = "demo-test-token";
const SONNET = "claude-sonnet-5-5";
const PRICING: Pricing = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

let dir: string;
let dbPath: string;
let app: FastifyInstance;
let games: GameManager;
let store: SqliteGameStore;
let bot: FakeBot;
let tutor: FakeTutor;
let clock: Date;
let logLines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chess-tutor-stats-"));
  dbPath = join(dir, "games.sqlite");
  clock = new Date("2026-11-15T12:00:00.000Z");
});

afterEach(async () => {
  await app?.close();
  try {
    store?.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { token?: string | undefined; model?: string; pricing?: Pricing; webDist?: string } = {}) {
  bot = createFakeBot(["e7e5", "b8c6", "g8f6", "d7d6"]);
  tutor = createFakeTutor();
  store = createSqliteGameStore(dbPath);
  let n = 0;
  logLines = [];
  const token = "token" in opts ? opts.token : TOKEN;
  ({ app, games } = buildServer({
    bot,
    store,
    newId: () => `game-id-${++n}`,
    now: () => clock,
    logger: { level: "trace", stream: { write: (line: string) => void logLines.push(line) } },
    demoToken: DEMO,
    coaching: { analyzer: createFakeAnalyzer(), tutor, model: opts.model ?? SONNET },
    pricing: opts.pricing ?? PRICING,
    ...(token === undefined ? {} : { opsStatsToken: token }),
    ...(opts.webDist ? { webDist: opts.webDist } : {}),
  }));
}

/** A built web app (index.html only) in the test's temp dir. */
function webDist(): string {
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>spa</title>");
  return web;
}

/** The ledger rows of 2026-11-15. */
const day15 = () => store.usageBetween("2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z");

/** `auth` null sends no authorization header. */
async function stats(query = "", auth: string | null = `Bearer ${TOKEN}`) {
  const res = await app.inject({
    method: "GET",
    url: `/ops/daily-stats${query}`,
    headers: auth === null ? {} : { authorization: auth },
  });
  return { status: res.statusCode, body: res.json() as DailyStats & { error?: string }, raw: res.body };
}

async function newGame(source: "player" | "demo" = "player", color: "w" | "b" = "w"): Promise<GameView> {
  const res = await app.inject({
    method: "POST",
    url: "/api/games",
    payload: { playerColor: color },
    headers: source === "demo" ? { [DEMO_TOKEN_HEADER]: DEMO } : {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as GameView;
}

const usage = (over: Partial<TutorUsage> = {}): TutorUsage => ({
  requests: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  ...over,
});

/** Asks for a hint and resolves it with `outcome`; waits until the server has handled it. */
async function hintWith(id: string, outcome: ReturnType<typeof okOutcome>) {
  const before = tutor.asks.length;
  const res = await app.inject({ method: "POST", url: `/api/games/${id}/tutor/hint` });
  expect(res.statusCode, res.body).toBe(202);
  const ask = await tutor.ask(before);
  ask.resolve(outcome);
  await new Promise((r) => setTimeout(r, 5));
}

function row(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    at: "2026-11-15T10:00:00.000Z",
    gameId: "g",
    source: "player",
    kind: "hint",
    ok: true,
    reason: null,
    ms: 100,
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    model: SONNET,
    ...over,
  };
}

describe("GET /ops/daily-stats auth (IR-10)", () => {
  for (const token of [undefined, "", "   "]) {
    it(`OPS_STATS_TOKEN ${JSON.stringify(token)}: the route is off, the usual JSON 404`, async () => {
      setup({ token });
      const res = await stats("?date=2026-11-15");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "no route GET /ops/daily-stats?date=2026-11-15" });
    });
  }

  it("token set, no authorization header: 401", async () => {
    setup();
    const res = await stats("", null);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  for (const [name, auth] of [
    ["a wrong token of the same length", `Bearer ${TOKEN.slice(0, -1)}X`],
    ["a shorter token", "Bearer ops"],
    ["a longer token", `Bearer ${TOKEN}0`],
    ["no Bearer scheme", TOKEN],
    ["another scheme", `Basic ${TOKEN}`],
    ["an empty bearer", "Bearer "],
  ] as const) {
    it(`${name}: 401, and the token never appears in the reply or the log`, async () => {
      setup();
      const res = await stats("", auth);
      expect(res.status).toBe(401);
      expect(res.raw).not.toContain(TOKEN);
      expect(logLines.join("\n")).not.toContain(TOKEN);
    });
  }

  it("the right token: 200 DailyStats version 1 with both sources", async () => {
    setup();
    const res = await stats("?date=2026-11-15");
    expect(res.status).toBe(200);
    const empty = {
      gamesStarted: 0,
      tutorReplies: 0,
      tutorLatencyMs: { p50: null, p95: null },
      errors: {},
      claude: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, spendUsd: 0 },
    };
    expect(res.body).toEqual({ version: 1, date: "2026-11-15", generatedAt: clock.toISOString(), player: empty, demo: empty });
    expect(logLines.join("\n")).not.toContain(TOKEN);
  });

  it("a configured token with surrounding whitespace is trimmed", async () => {
    setup({ token: `  ${TOKEN}\n` });
    expect((await stats()).status).toBe(200);
  });
});

describe("review 088 (round 2): routing and the auth scheme", () => {
  for (const token of [undefined, "  "]) {
    it(`token ${JSON.stringify(token)} with webDist set: still the JSON 404, not the SPA`, async () => {
      setup({ token, webDist: webDist() });
      const res = await app.inject({ method: "GET", url: "/ops/daily-stats" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.json()).toEqual({ error: "no route GET /ops/daily-stats" });
    });
  }

  for (const url of ["/ops/daily-stats/", "/ops/other", "/ops", "/ops/"]) {
    it(`${url} with webDist set: JSON 404, not index.html`, async () => {
      setup({ webDist: webDist() });
      const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.json()).toEqual({ error: expect.any(String) });
    });
  }

  it("other paths still get the SPA fallback (e.g. /games/x, /opsx)", async () => {
    setup({ webDist: webDist() });
    for (const url of ["/games/abc", "/opsx"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain("<title>spa</title>");
    }
  });

  for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
    it(`the scheme is case-insensitive: "${scheme} <token>" -> 200`, async () => {
      setup();
      expect((await stats("?date=2026-11-15", `${scheme} ${TOKEN}`)).status).toBe(200);
    });
  }

  it("the token itself stays case-sensitive", async () => {
    setup();
    expect((await stats("", `Bearer ${TOKEN.toUpperCase()}`)).status).toBe(401);
  });
});

describe("review 088 (round 2): asks the server cancelled are not errors", () => {
  /** The real session's answer to an aborted ask (packages/tutor session.ts). */
  const aborted = (u: Partial<TutorUsage>) => ({ ...failOutcome("api_unavailable", "aborted"), usage: usage(u), ms: 30 });

  it("player moves while the tutor thinks: stored as cancelled, not in errors, tokens in claude", async () => {
    setup();
    const g = await newGame();
    await app.inject({ method: "POST", url: `/api/games/${g.id}/tutor/hint` });
    const ask = await tutor.ask(0);
    const moved = await app.inject({ method: "POST", url: `/api/games/${g.id}/moves`, payload: { uci: "d2d4" } });
    expect(moved.statusCode).toBe(200);
    await games.idle(g.id);
    expect(ask.signal?.aborted).toBe(true);
    ask.resolve(aborted({ inputTokens: 1_000_000 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(day15().map((r) => [r.ok, r.reason])).toEqual([[false, "cancelled"]]);
    const s = (await stats("?date=2026-11-15")).body.player;
    expect(s.errors).toEqual({});
    expect(s.tutorReplies).toBe(0);
    expect(s.claude).toMatchObject({ requests: 1, inputTokens: 1_000_000, spendUsd: 2 });
  });

  it("game end (resign) while the tutor thinks: cancelled, not an error", async () => {
    setup();
    const g = await newGame();
    await app.inject({ method: "POST", url: `/api/games/${g.id}/tutor/hint` });
    const ask = await tutor.ask(0);
    expect((await app.inject({ method: "POST", url: `/api/games/${g.id}/resign` })).statusCode).toBe(200);
    expect(ask.signal?.aborted).toBe(true);
    ask.resolve(aborted({ outputTokens: 100_000 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(day15().map((r) => r.reason)).toEqual(["cancelled"]);
    const s = (await stats("?date=2026-11-15")).body.player;
    expect(s.errors).toEqual({});
    expect(s.claude).toMatchObject({ outputTokens: 100_000, spendUsd: 1 });
  });

  it("game end by a new game of the same source (abandon): cancelled", async () => {
    setup();
    const g = await newGame();
    await app.inject({ method: "POST", url: `/api/games/${g.id}/tutor/hint` });
    const ask = await tutor.ask(0);
    await newGame();
    expect(ask.signal?.aborted).toBe(true);
    ask.resolve(aborted({ inputTokens: 5 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(day15().map((r) => r.reason)).toEqual(["cancelled"]);
    expect((await stats("?date=2026-11-15")).body.player.errors).toEqual({});
  });

  it("shutdown while the tutor thinks: cancelled", async () => {
    setup();
    const g = await newGame();
    await app.inject({ method: "POST", url: `/api/games/${g.id}/tutor/hint` });
    const first = await tutor.ask(0);
    // Shutdown also cancels: close the manager, then the aborted ask answers.
    games.close();
    expect(first.signal?.aborted).toBe(true);
    first.resolve(aborted({ inputTokens: 7 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(day15().map((r) => r.reason)).toEqual(["cancelled"]);
  });

  it("a genuine api_unavailable on an ask nobody cancelled still counts as an error", async () => {
    setup();
    const g = await newGame();
    await hintWith(g.id, aborted({ inputTokens: 3 }));
    expect(day15().map((r) => r.reason)).toEqual(["api_unavailable"]);
    const s = (await stats("?date=2026-11-15")).body.player;
    expect(s.errors).toEqual({ api_unavailable: 1 });
    expect(s.claude.inputTokens).toBe(3);
  });

  it("a validated reply that arrives after its ask was cancelled stays ok (counted as a reply)", async () => {
    setup();
    const g = await newGame();
    await app.inject({ method: "POST", url: `/api/games/${g.id}/tutor/hint` });
    const ask = await tutor.ask(0);
    await app.inject({ method: "POST", url: `/api/games/${g.id}/moves`, payload: { uci: "d2d4" } });
    await games.idle(g.id);
    ask.resolve(okOutcome({ kind: "hint" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(day15().map((r) => [r.ok, r.reason])).toEqual([[true, null]]);
  });

  it("computeDailyStats: cancelled rows add tokens, never errors or replies", () => {
    const s = computeDailyStats({
      date: "2026-11-15",
      generatedAt: "2026-11-16T01:00:00.000Z",
      gamesStarted: { player: 0, demo: 0 },
      events: [row({ ok: false, reason: "cancelled", inputTokens: 1_000_000, ms: 5 })],
      pricing: PRICING,
    });
    expect(s.player.errors).toEqual({});
    expect(s.player).toMatchObject({ tutorReplies: 0, tutorLatencyMs: { p50: null, p95: null }, claude: { requests: 1, spendUsd: 2 } });
  });
});

describe("the date parameter", () => {
  it("defaults to yesterday (UTC)", async () => {
    setup();
    clock = new Date("2026-11-16T00:30:00.000Z");
    const res = await stats();
    expect(res.status).toBe(200);
    expect(res.body.date).toBe("2026-11-15");
    clock = new Date("2026-03-01T23:59:00.000Z");
    expect((await stats()).body.date).toBe("2026-02-28");
  });

  it("today is allowed", async () => {
    setup();
    expect((await stats("?date=2026-11-15")).status).toBe(200);
  });

  for (const bad of ["2026-11-16", "2027-01-01", "2026-1-5", "20261115", "2026-02-30", "2026-13-01", "abc", "", "2026-11-15T00:00:00Z"]) {
    it(`date=${JSON.stringify(bad)}: 400`, async () => {
      setup();
      const res = await stats(`?date=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
    });
  }

  it("auth is checked before the date (401, not 400)", async () => {
    setup();
    expect((await stats("?date=abc", null)).status).toBe(401);
  });

  it("parseStatsDate: repeated date is 400", () => {
    expect(parseStatsDate(["2026-11-14", "2026-11-15"], clock)).toEqual({ error: expect.any(String) });
    expect(parseStatsDate(undefined, clock)).toEqual({ date: "2026-11-14" });
  });
});

describe("counting (FR-29, FR-28, NFR-5)", () => {
  it("player and demo are counted apart: games started, replies and spend", async () => {
    setup();
    const p1 = await newGame("player");
    await newGame("player"); // abandons p1: same source (FR-28)
    const d1 = await newGame("demo");
    const p2 = games.view("game-id-2")!;
    expect(p1.id).toBe("game-id-1");
    await hintWith(p2.id, { ...okOutcome({ kind: "hint" }), usage: usage({ inputTokens: 1_000_000 }), ms: 300 });
    await hintWith(d1.id, { ...okOutcome({ kind: "hint" }), usage: usage({ outputTokens: 1_000_000 }), ms: 700 });
    await hintWith(d1.id, { ...okOutcome({ kind: "hint" }), usage: usage({ outputTokens: 500_000, requests: 2 }), ms: 900 });
    const res = await stats("?date=2026-11-15");
    expect(res.status).toBe(200);
    expect(res.body.player).toMatchObject({
      gamesStarted: 2,
      tutorReplies: 1,
      tutorLatencyMs: { p50: 300, p95: 300 },
      claude: { requests: 1, inputTokens: 1_000_000, outputTokens: 0, spendUsd: 2 },
    });
    expect(res.body.demo).toMatchObject({
      gamesStarted: 1,
      tutorReplies: 2,
      tutorLatencyMs: { p50: 700, p95: 900 },
      claude: { requests: 3, inputTokens: 0, outputTokens: 1_500_000, spendUsd: 15 },
    });
  });

  it("only the asked UTC day counts (games and ledger rows), boundaries included", async () => {
    setup();
    clock = new Date("2026-11-14T23:59:59.999Z");
    const a = await newGame();
    await hintWith(a.id, { ...okOutcome({ kind: "hint" }), usage: usage({ inputTokens: 10 }) });
    clock = new Date("2026-11-15T00:00:00.000Z");
    const b = await newGame();
    await hintWith(b.id, { ...okOutcome({ kind: "hint" }), usage: usage({ inputTokens: 20 }) });
    clock = new Date("2026-11-16T00:00:00.000Z");
    const c = await newGame();
    await hintWith(c.id, { ...okOutcome({ kind: "hint" }), usage: usage({ inputTokens: 40 }) });
    clock = new Date("2026-11-16T08:00:00.000Z");
    const d14 = (await stats("?date=2026-11-14")).body.player;
    const d15 = (await stats("?date=2026-11-15")).body.player;
    const d16 = (await stats("?date=2026-11-16")).body.player;
    expect([d14.gamesStarted, d14.claude.inputTokens]).toEqual([1, 10]);
    expect([d15.gamesStarted, d15.claude.inputTokens]).toEqual([1, 20]);
    expect([d16.gamesStarted, d16.claude.inputTokens]).toEqual([1, 40]);
  });

  it("errors by tutor failure reason plus bot_failed; zero counts left out; failed asks still count usage", async () => {
    setup();
    const g = await newGame("player", "b"); // the bot moves first
    await games.idle(g.id);
    await hintWith(g.id, { ...failOutcome("invalid_reply"), usage: usage({ inputTokens: 100 }) });
    await hintWith(g.id, { ...failOutcome("invalid_reply"), usage: usage({ inputTokens: 100 }) });
    await hintWith(g.id, { ...failOutcome("rate_limited"), usage: usage({ requests: 1 }) });
    // A tutor ask that throws arrives at finishAsk as api_unavailable with no usage.
    const before = tutor.asks.length;
    await app.inject({ method: "POST", url: `/api/games/${g.id}/tutor/hint` });
    (await tutor.ask(before)).reject(new Error("socket hang up"));
    await new Promise((r) => setTimeout(r, 5));
    bot.failNext("engine crashed");
    const moved = await app.inject({ method: "POST", url: `/api/games/${g.id}/moves`, payload: { uci: "e7e5" } });
    expect(moved.statusCode, moved.body).toBe(200);
    await games.idle(g.id);
    const res = await stats("?date=2026-11-15");
    expect(res.body.player.errors).toEqual({ invalid_reply: 2, rate_limited: 1, api_unavailable: 1, bot_failed: 1 });
    expect(res.body.player.tutorReplies).toBe(0);
    expect(res.body.player.tutorLatencyMs).toEqual({ p50: null, p95: null });
    expect(res.body.player.claude).toMatchObject({ requests: 3, inputTokens: 200 });
    expect(res.body.demo.errors).toEqual({});
  });

  it("a dropped reply (the question was replaced or its position left) still counts its spend", async () => {
    setup();
    const g = await newGame();
    await app.inject({ method: "POST", url: `/api/games/${g.id}/tutor/hint` });
    const ask = await tutor.ask(0);
    const moved = await app.inject({ method: "POST", url: `/api/games/${g.id}/moves`, payload: { uci: "d2d4" } });
    expect(moved.statusCode).toBe(200);
    await games.idle(g.id);
    expect(ask.signal?.aborted).toBe(true);
    ask.resolve({ ...okOutcome({ kind: "hint" }), usage: usage({ inputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 }), ms: 50 });
    await new Promise((r) => setTimeout(r, 5));
    const res = await stats("?date=2026-11-15");
    expect(res.body.player.claude).toMatchObject({ requests: 1, inputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, spendUsd: 4.5 });
  });

  it("records the model that served the ask (from the coaching deps)", async () => {
    setup({ model: "claude-opus-5-5" });
    const g = await newGame();
    await hintWith(g.id, { ...okOutcome({ kind: "hint" }), usage: usage({ outputTokens: 1_000_000 }) });
    expect((await stats("?date=2026-11-15")).body.player.claude.spendUsd).toBe(20);
    expect(store.usageBetween("2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z").map((r) => r.model)).toEqual(["claude-opus-5-5"]);
  });

  it("a ledger write failure does not break the game: logged, and the reply still arrives", async () => {
    setup();
    const g = await newGame();
    store.recordUsage = () => {
      throw new Error("disk full");
    };
    await hintWith(g.id, okOutcome({ kind: "hint" }));
    expect(games.view(g.id)!.tutor.question).not.toBeNull();
    expect(logLines.join("\n")).toContain("could not record usage");
  });

  it("rows survive a restart (SQLite, IR-7)", async () => {
    setup();
    const g = await newGame("demo");
    await hintWith(g.id, { ...okOutcome({ kind: "hint" }), usage: usage({ inputTokens: 500_000 }), ms: 42 });
    const before = (await stats("?date=2026-11-15")).body;
    await app.close();
    store.close();
    setup();
    const after = (await stats("?date=2026-11-15")).body;
    expect(after).toEqual(before);
    expect(after.demo).toMatchObject({ gamesStarted: 1, tutorReplies: 1, tutorLatencyMs: { p50: 42, p95: 42 }, claude: { spendUsd: 1 } });
  });

  it("privacy (NFR-15): no game id, FEN or tutor text in the JSON", async () => {
    setup();
    const g = await newGame();
    const moved = await app.inject({ method: "POST", url: `/api/games/${g.id}/moves`, payload: { uci: "e2e4" } });
    expect(moved.statusCode).toBe(200);
    await games.idle(g.id);
    const fen = fenAfter(["e2e4", "e7e5"]);
    const text = `Zanzibar-quokka idea: look at ${fen}`;
    await hintWith(g.id, { ...okOutcome({ kind: "hint", message: text, reveal: "Secret reveal Xylophone" }), usage: usage({ inputTokens: 7 }) });
    expect(games.view(g.id)!.tutor.question?.message).toBe(text);
    const res = await stats("?date=2026-11-15");
    expect(res.body.player.tutorReplies).toBe(1);
    for (const secret of [g.id, "game-id", fen, fen.split(" ")[0]!, "Zanzibar", "Xylophone", "e2e4", "1. e4"]) {
      expect(res.raw).not.toContain(secret);
    }
  });
});

describe("computeDailyStats (pure)", () => {
  const base = { date: "2026-11-15", generatedAt: "2026-11-16T01:00:00.000Z", gamesStarted: { player: 0, demo: 0 } };

  it("nearest-rank p50/p95 over a known set; null with none", () => {
    expect(nearestRank([], 0.5)).toBeNull();
    const ms = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(nearestRank(ms, 0.5)).toBe(50);
    expect(nearestRank(ms, 0.95)).toBe(100);
    expect(nearestRank([5, 1, 3], 0.5)).toBe(3);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(nearestRank(twenty, 0.95)).toBe(19);
    expect(nearestRank(twenty, 0.5)).toBe(10);
    const events = [...ms].reverse().map((m) => row({ ms: m }));
    // A failed row's ms is not a reply latency.
    events.push(row({ ok: false, reason: "max_tokens", ms: 99_999 }));
    const s = computeDailyStats({ ...base, events, pricing: PRICING });
    expect(s.player.tutorLatencyMs).toEqual({ p50: 50, p95: 100 });
    expect(s.player.tutorReplies).toBe(10);
    expect(s.demo.tutorLatencyMs).toEqual({ p50: null, p95: null });
  });

  it("spend priced per model including cacheRead and cacheWrite, rounded to 4 decimals", () => {
    const events = [
      row({ model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 3000, cacheCreationInputTokens: 4000 }),
      row({ model: SONNET, inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 3000, cacheCreationInputTokens: 4000 }),
      row({ model: SONNET, inputTokens: 1, ok: false, reason: "refusal" }),
    ];
    const s = computeDailyStats({ ...base, events, pricing: PRICING });
    // opus: (1000*4 + 2000*20 + 3000*0.2 + 4000*5)/1e6 = 0.0646; sonnet: 0.0323; + 0.000002
    expect(s.player.claude).toEqual({
      requests: 3,
      inputTokens: 2001,
      outputTokens: 4000,
      cacheReadInputTokens: 6000,
      cacheCreationInputTokens: 8000,
      spendUsd: 0.0969,
    });
  });

  it("an unknown model: tokens counted, 0 spend, one warning per model", () => {
    const warned: (string | null)[] = [];
    const events = [row({ model: "claude-mystery-1", inputTokens: 1_000_000 }), row({ model: "claude-mystery-1", inputTokens: 5 }), row({ model: null, inputTokens: 1 })];
    const s = computeDailyStats({ ...base, events, pricing: PRICING, warnUnknownModel: (m) => warned.push(m) });
    expect(s.player.claude).toMatchObject({ requests: 3, inputTokens: 1_000_006, spendUsd: 0 });
    // A row with no model is reported as such (null), not as a model named "null" (review 088).
    expect(warned).toEqual(["claude-mystery-1", null]);
  });

  it("the route words a row with no model as an unknown model, once", async () => {
    setup();
    store.recordUsage(row({ model: null, inputTokens: 10 }));
    expect((await stats("?date=2026-11-15")).body.player.claude).toMatchObject({ inputTokens: 10, spendUsd: 0 });
    await stats("?date=2026-11-15");
    const lines = logLines.filter((l) => l.includes("usage stats"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unknown model");
    expect(lines[0]).not.toContain('"null"');
  });

  it("the route warns once per unknown model across requests", async () => {
    setup({ model: "claude-mystery-1" });
    const g = await newGame();
    await hintWith(g.id, { ...okOutcome({ kind: "hint" }), usage: usage({ inputTokens: 10 }) });
    expect((await stats("?date=2026-11-15")).body.player.claude).toMatchObject({ inputTokens: 10, spendUsd: 0 });
    await stats("?date=2026-11-15");
    expect(logLines.filter((l) => l.includes("no price") && l.includes("claude-mystery-1"))).toHaveLength(1);
  });

  it("bot_failed rows count as errors only, never as tutor usage", () => {
    const events = [row({ kind: "bot_failed", ok: false, reason: null, requests: 0, ms: 0, model: null }), row({ source: "demo", ok: false, reason: "auth" })];
    const s = computeDailyStats({ ...base, events, pricing: PRICING });
    expect(s.player.errors).toEqual({ bot_failed: 1 });
    expect(s.player.claude.requests).toBe(0);
    expect(s.demo.errors).toEqual({ auth: 1 });
  });

  it("loadPricing reads config/models.json pricingPerMTok", () => {
    expect(loadPricing()[SONNET]).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  });
});

describe("schema v4: the usage ledger (IR-7)", () => {
  it("a v3 database migrates to v4 with its games intact, and gains usage_events with a day index", () => {
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
      INSERT INTO games VALUES ('old-1', 'w', 'playing', '*', NULL, 'pgn-a', '2026-11-15T09:00:00.000Z', '2026-11-15T09:01:00.000Z', '{"v":1}', 'demo');
      INSERT INTO games VALUES ('old-2', 'b', 'finished', '1-0', 'resigned', 'pgn-b', '2026-11-14T09:00:00.000Z', '2026-11-14T09:01:00.000Z', NULL, 'player');
      PRAGMA user_version = 3;
    `);
    db.close();

    const s = createSqliteGameStore(dbPath);
    expect(s.get("old-1")).toMatchObject({ id: "old-1", status: "playing", pgn: "pgn-a", state: '{"v":1}', source: "demo" });
    expect(s.get("old-2")).toMatchObject({ id: "old-2", status: "finished", endReason: "resigned", source: "player" });
    expect(s.gamesStartedBetween("2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z")).toEqual({ player: 0, demo: 1 });
    s.recordUsage(row());
    expect(s.usageBetween("2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z")).toEqual([row()]);
    s.close();

    const check = new DatabaseSync(dbPath);
    expect(SCHEMA_VERSION).toBe(4);
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
    const indexes = check.prepare("PRAGMA index_list(usage_events)").all().map((r) => String(r["name"]));
    expect(indexes).toContain("usage_events_at");
    check.close();
    // Reopening a v4 database is a no-op.
    const again = createSqliteGameStore(dbPath);
    expect(again.usageBetween("2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z")).toHaveLength(1);
    again.close();
  });

  it("a fresh database is v4; rows read back exactly, ordered by time, half-open day range", () => {
    const s = createSqliteGameStore(":memory:");
    const rows = [
      row({ at: "2026-11-15T23:59:59.999Z", kind: "player_blunder", ok: false, reason: "unsupported_claim", source: "demo", gameId: null }),
      row({ at: "2026-11-15T00:00:00.000Z", inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 6, requests: 2 }),
      row({ at: "2026-11-16T00:00:00.000Z" }),
      row({ at: "2026-11-14T23:59:59.999Z", kind: "bot_failed", model: null }),
    ];
    for (const r of rows) s.recordUsage(r);
    expect(s.usageBetween("2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z")).toEqual([rows[1], rows[0]]);
    s.close();
  });
});
