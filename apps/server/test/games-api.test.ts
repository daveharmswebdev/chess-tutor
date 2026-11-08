import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GameView } from "@chess-tutor/chess-core";
import { buildServer } from "../src/app.ts";
import type { GameManager } from "../src/games.ts";
import { createSqliteGameStore, type GameStore } from "../src/store.ts";
import { createFakeBot, eventCollector, ucis, type FakeBot } from "./helpers.ts";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let app: FastifyInstance;
let games: GameManager;
let store: GameStore;
let bot: FakeBot;

function setup(script: string[] = []) {
  bot = createFakeBot(script);
  store = createSqliteGameStore(":memory:");
  let n = 0;
  ({ app, games } = buildServer({ bot, store, newId: () => `g${++n}`, logger: false }));
}

afterEach(async () => {
  await app.close();
  store.close();
});

async function post(url: string, body?: unknown) {
  const res = await app.inject({
    method: "POST",
    url,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.json() as GameView & { error?: string } };
}

async function newGame(playerColor: "w" | "b") {
  const res = await post("/api/games", { playerColor });
  expect(res.status).toBe(201);
  return res.body;
}

/** Plays a player move, then waits for the bot to finish. */
async function play(id: string, uci: string): Promise<GameView> {
  const res = await post(`/api/games/${id}/moves`, { uci });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await games.idle(id);
  return games.view(id)!;
}

describe("POST /api/games", () => {
  it("creates a game as White: player to move, bot not thinking", async () => {
    setup();
    const g = await newGame("w");
    expect(g).toEqual({
      id: "g1",
      playerColor: "w",
      fen: START,
      moves: [],
      status: "playing",
      result: "*",
      endReason: null,
      botThinking: false,
      tutor: { available: false, reason: expect.stringMatching(/^Coaching is off/), thinking: false, question: null },
    });
    expect(bot.calls).toHaveLength(0);
  });

  it("creates a game as Black: bot thinking, its first move arrives as a bot_move event", async () => {
    setup(["d2d4"]);
    bot.hold();
    const g = await newGame("b");
    expect(g.botThinking).toBe(true);
    expect(g.moves).toEqual([]);
    const events = eventCollector();
    games.subscribe(g.id, events.push);
    bot.release();
    const ev = await events.next("bot_move");
    if (ev.type !== "bot_move") throw new Error("unreachable");
    expect(ev.move).toEqual({ uci: "d2d4", san: "d4", by: "bot" });
    expect(ev.game.botThinking).toBe(false);
    expect(ucis(ev.game)).toEqual(["d2d4"]);
    expect(ev.game.fen).toMatch(/ b KQkq /);
  });

  it("rejects a malformed request with 400 and an ApiError", async () => {
    setup();
    for (const body of [{}, { playerColor: "white" }, { playerColor: 1 }]) {
      const res = await post("/api/games", body);
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
    const raw = await app.inject({
      method: "POST",
      url: "/api/games",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(raw.statusCode).toBe(400);
    expect(typeof raw.json().error).toBe("string");
  });

  it("abandons a game still playing when a new one is created, and saves it as PGN", async () => {
    setup(["e7e5"]);
    const first = await newGame("w");
    await play(first.id, "e2e4");
    const events = eventCollector();
    games.subscribe(first.id, events.push);
    const second = await newGame("b");
    expect(second.id).not.toBe(first.id);

    const old = await app.inject({ method: "GET", url: `/api/games/${first.id}` });
    expect(old.json()).toMatchObject({ status: "abandoned", result: "*", endReason: "abandoned" });
    const over = await events.next("game_over");
    expect(over.type === "game_over" && over.game.status).toBe("abandoned");

    const saved = store.get(first.id)!;
    expect(saved).toMatchObject({ status: "abandoned", result: "*", endReason: "abandoned", playerColor: "w" });
    expect(saved.pgn).toContain('[White "Player"]');
    expect(saved.pgn).toContain('[Black "Sparring bot"]');
    expect(saved.pgn).toContain('[Result "*"]');
    expect(saved.pgn).toContain('[Termination "abandoned"]');
    expect(saved.pgn).toMatch(/1\. e4 e5 \*\s*$/);
  });

  it("does not save a game that is still playing", async () => {
    setup();
    const g = await newGame("w");
    await play(g.id, "e2e4");
    expect(store.get(g.id)).toBeUndefined();
  });
});

describe("GET /api/games/:id", () => {
  it("returns the game view", async () => {
    setup();
    const g = await newGame("w");
    const res = await app.inject({ method: "GET", url: `/api/games/${g.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(g);
  });

  it("404s an unknown id with an ApiError", async () => {
    setup();
    const res = await app.inject({ method: "GET", url: "/api/games/nope" });
    expect(res.statusCode).toBe(404);
    expect(typeof res.json().error).toBe("string");
  });
});

describe("POST /api/games/:id/moves", () => {
  it("applies a legal move (200, botThinking) and the bot replies with a bot_move event", async () => {
    setup(["e7e5"]);
    const g = await newGame("w");
    const events = eventCollector();
    games.subscribe(g.id, events.push);
    const res = await post(`/api/games/${g.id}/moves`, { uci: "e2e4" });
    expect(res.status).toBe(200);
    expect(res.body.moves).toEqual([{ uci: "e2e4", san: "e4", by: "player" }]);
    expect(res.body.botThinking).toBe(true);
    const ev = await events.next("bot_move");
    if (ev.type !== "bot_move") throw new Error("unreachable");
    expect(ev.move).toEqual({ uci: "e7e5", san: "e5", by: "bot" });
    expect(ev.game.botThinking).toBe(false);
    expect(ucis(ev.game)).toEqual(["e2e4", "e7e5"]);
  });

  it("accepts castling as king two squares and promotion with a piece letter", async () => {
    setup(["e7e5", "b8c6", "g8f6"]);
    const g = await newGame("w");
    await play(g.id, "e2e4");
    await play(g.id, "g1f3");
    await play(g.id, "f1c4");
    const after = await play(g.id, "e1g1");
    expect(after.moves[6]).toEqual({ uci: "e1g1", san: "O-O", by: "player" });
  });

  it("400s an illegal or malformed move", async () => {
    setup();
    const g = await newGame("w");
    for (const body of [{ uci: "e2e5" }, { uci: "e7e5" }, { uci: "e2e4q" }, { uci: "zz" }, { uci: 42 }, {}]) {
      const res = await post(`/api/games/${g.id}/moves`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
    expect(games.view(g.id)!.moves).toEqual([]);
  });

  it("409s when it is not the player's turn or the bot is thinking", async () => {
    setup();
    bot.hold();
    const g = await newGame("w");
    const first = await post(`/api/games/${g.id}/moves`, { uci: "e2e4" });
    expect(first.status).toBe(200);
    const thinking = await post(`/api/games/${g.id}/moves`, { uci: "d2d4" });
    expect(thinking.status).toBe(409);
    expect(typeof thinking.body.error).toBe("string");
    bot.release();
    await games.idle(g.id);

    // Black player while the bot (White) is still choosing its first move.
    bot.hold();
    const b = await newGame("b");
    const early = await post(`/api/games/${b.id}/moves`, { uci: "e7e5" });
    expect(early.status).toBe(409);
    bot.release();
    await games.idle(b.id);
  });

  it("409s when the bot failed and it is still the bot's turn, after an error event", async () => {
    setup();
    const g = await newGame("w");
    const events = eventCollector();
    games.subscribe(g.id, events.push);
    bot.failNext("engine crashed");
    await post(`/api/games/${g.id}/moves`, { uci: "e2e4" });
    const err = await events.next("error");
    expect(err.type === "error" && err.message).toMatch(/bot/i);
    const view = games.view(g.id)!;
    expect(view).toMatchObject({ status: "playing", botThinking: false });
    const res = await post(`/api/games/${g.id}/moves`, { uci: "d7d5" });
    expect(res.status).toBe(409);
  });

  it("409s when the game is not playing", async () => {
    setup();
    const g = await newGame("w");
    await post(`/api/games/${g.id}/resign`);
    const res = await post(`/api/games/${g.id}/moves`, { uci: "e2e4" });
    expect(res.status).toBe(409);
  });

  it("404s an unknown game", async () => {
    setup();
    const res = await post("/api/games/nope/moves", { uci: "e2e4" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/games/:id/takeback", () => {
  it("after the bot's reply removes two plies and returns to the player's turn", async () => {
    setup(["e7e5", "g8f6"]);
    const g = await newGame("w");
    await play(g.id, "e2e4");
    const before = await play(g.id, "g1f3");
    expect(ucis(before)).toEqual(["e2e4", "e7e5", "g1f3", "g8f6"]);
    const res = await post(`/api/games/${g.id}/takeback`);
    expect(res.status).toBe(200);
    expect(ucis(res.body)).toEqual(["e2e4", "e7e5"]);
    expect(res.body.fen).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
    expect(res.body.botThinking).toBe(false);
    const again = await post(`/api/games/${g.id}/takeback`);
    expect(again.status).toBe(200);
    expect(again.body.fen).toBe(START);
  });

  it("as Black keeps the bot's first move", async () => {
    setup(["d2d4", "c2c4"]);
    const g = await newGame("b");
    await games.idle(g.id);
    await play(g.id, "g8f6");
    const res = await post(`/api/games/${g.id}/takeback`);
    expect(res.status).toBe(200);
    expect(ucis(res.body)).toEqual(["d2d4"]);
    const none = await post(`/api/games/${g.id}/takeback`);
    expect(none.status).toBe(409);
  });

  it("removes only the player's move when the bot failed to reply", async () => {
    setup();
    const g = await newGame("w");
    bot.failNext("boom");
    await post(`/api/games/${g.id}/moves`, { uci: "e2e4" });
    await games.idle(g.id);
    const res = await post(`/api/games/${g.id}/takeback`);
    expect(res.status).toBe(200);
    expect(res.body.fen).toBe(START);
  });

  it("409s with nothing to undo, while the bot thinks, and when not playing; 404 unknown", async () => {
    setup();
    const g = await newGame("w");
    expect((await post(`/api/games/${g.id}/takeback`)).status).toBe(409);
    bot.hold();
    await post(`/api/games/${g.id}/moves`, { uci: "e2e4" });
    expect((await post(`/api/games/${g.id}/takeback`)).status).toBe(409);
    bot.release();
    await games.idle(g.id);
    await post(`/api/games/${g.id}/resign`);
    expect((await post(`/api/games/${g.id}/takeback`)).status).toBe(409);
    expect((await post("/api/games/nope/takeback")).status).toBe(404);
  });
});

describe("POST /api/games/:id/resign", () => {
  it("finishes the game for the bot, emits game_over and saves the PGN", async () => {
    setup(["e7e5"]);
    const g = await newGame("w");
    await play(g.id, "e2e4");
    const events = eventCollector();
    games.subscribe(g.id, events.push);
    const res = await post(`/api/games/${g.id}/resign`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "finished", result: "0-1", endReason: "resigned", botThinking: false });
    await events.next("game_over");
    const saved = store.get(g.id)!;
    expect(saved).toMatchObject({ status: "finished", result: "0-1", endReason: "resigned" });
    expect(saved.pgn).toContain('[Result "0-1"]');
    expect(saved.pgn).toContain('[Termination "resigned"]');
    expect(saved.pgn).toMatch(/1\. e4 e5 0-1\s*$/);
  });

  it("as Black gives 1-0; discards a bot move that finishes after the resignation", async () => {
    setup();
    bot.hold();
    const g = await newGame("b");
    const res = await post(`/api/games/${g.id}/resign`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: "1-0", botThinking: false });
    bot.release();
    await games.idle(g.id);
    expect(games.view(g.id)!.moves).toEqual([]);
    expect((await post(`/api/games/${g.id}/resign`)).status).toBe(409);
    expect((await post("/api/games/nope/resign")).status).toBe(404);
  });
});

describe("game over", () => {
  it("player checkmate (Scholar's mate) ends the game 1-0 without asking the bot", async () => {
    setup(["e7e5", "b8c6", "g8f6"]);
    const g = await newGame("w");
    await play(g.id, "e2e4");
    await play(g.id, "f1c4");
    await play(g.id, "d1h5");
    const events = eventCollector();
    games.subscribe(g.id, events.push);
    const callsBefore = bot.calls.length;
    const res = await post(`/api/games/${g.id}/moves`, { uci: "h5f7" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "finished", result: "1-0", endReason: "checkmate", botThinking: false });
    expect(res.body.moves.at(-1)).toEqual({ uci: "h5f7", san: "Qxf7#", by: "player" });
    await events.next("game_over");
    expect(bot.calls.length).toBe(callsBefore);
    const saved = store.get(g.id)!;
    expect(saved).toMatchObject({ result: "1-0", endReason: "checkmate" });
    expect(saved.pgn).toContain("Qxf7# 1-0");
  });

  it("bot checkmate (Fool's mate) ends the game 0-1 with bot_move then game_over", async () => {
    setup(["e7e5", "d8h4"]);
    const g = await newGame("w");
    const events = eventCollector();
    games.subscribe(g.id, events.push);
    await play(g.id, "f2f3");
    const final = await play(g.id, "g2g4");
    expect(final).toMatchObject({ status: "finished", result: "0-1", endReason: "checkmate", botThinking: false });
    const over = await events.next("game_over");
    expect(over.type === "game_over" && over.game.result).toBe("0-1");
    const types = events.events.map((e) => e.type).filter((t) => t !== "state");
    expect(types.slice(-2)).toEqual(["bot_move", "game_over"]);
    expect(store.get(g.id)).toMatchObject({ result: "0-1", endReason: "checkmate" });
  });

  it("threefold repetition draws the game", async () => {
    setup(["g8f6", "f6g8", "g8f6", "f6g8"]);
    const g = await newGame("w");
    await play(g.id, "g1f3");
    await play(g.id, "f3g1");
    await play(g.id, "g1f3");
    const final = await play(g.id, "f3g1");
    expect(final).toMatchObject({
      status: "finished",
      result: "1/2-1/2",
      endReason: "threefold_repetition",
      botThinking: false,
    });
    const saved = store.get(g.id)!;
    expect(saved.pgn).toContain('[Result "1/2-1/2"]');
    expect(saved.pgn).toContain('[Termination "threefold_repetition"]');
  });
});

describe("shutdown", () => {
  it("abandons and saves games still playing when the server closes", async () => {
    setup();
    const g = await newGame("w");
    await play(g.id, "d2d4");
    await app.close();
    expect(store.get(g.id)).toMatchObject({ status: "abandoned", result: "*", endReason: "abandoned" });
  });
});

// #23: after a bot failure it is the bot's turn, and before bot-retry only resign or a new game got out.
describe("POST /api/games/:id/bot-retry", () => {
  for (const [name, arrange] of [
    ["rejects", (b: FakeBot) => b.failNext("engine crashed")],
    ["returns an illegal move", (b: FakeBot) => b.illegalNext("e7e5")],
  ] as const) {
    it(`as Black, when the bot's first move ${name}: retry -> botThinking, bot_move, then the player can move`, async () => {
      setup(["d2d4"]);
      arrange(bot);
      const g = await newGame("b");
      await games.idle(g.id);
      expect(games.view(g.id)).toMatchObject({ status: "playing", botThinking: false, moves: [] });
      expect((await post(`/api/games/${g.id}/moves`, { uci: "g8f6" })).status).toBe(409);

      const events = eventCollector();
      games.subscribe(g.id, events.push);
      bot.hold();
      const res = await post(`/api/games/${g.id}/bot-retry`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "playing", botThinking: true, moves: [] });
      expect(await events.next("state")).toMatchObject({ type: "state", game: { botThinking: true } });
      bot.release();
      const ev = await events.next("bot_move");
      expect(ev).toMatchObject({ move: { uci: "d2d4", by: "bot" }, game: { botThinking: false } });
      expect(events.events.some((e) => e.type === "error")).toBe(false);

      const after = await play(g.id, "g8f6");
      expect(ucis(after).slice(0, 2)).toEqual(["d2d4", "g8f6"]);
    });
  }

  it("recovers a mid-game failure as White", async () => {
    setup(["e7e5", "b8c6"]);
    const g = await newGame("w");
    await play(g.id, "e2e4");
    bot.failNext("boom");
    const failed = await play(g.id, "g1f3");
    expect(ucis(failed)).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(failed.botThinking).toBe(false);

    const res = await post(`/api/games/${g.id}/bot-retry`);
    expect(res.status).toBe(200);
    expect(res.body.botThinking).toBe(true);
    await games.idle(g.id);
    expect(ucis(games.view(g.id)!)).toEqual(["e2e4", "e7e5", "g1f3", "b8c6"]);
    const next = await play(g.id, "f1b5");
    expect(ucis(next).slice(0, 5)).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]);
  });

  it("can fail again and be retried again", async () => {
    setup(["d2d4"]);
    bot.failNext("first");
    const g = await newGame("b");
    await games.idle(g.id);
    const events = eventCollector();
    games.subscribe(g.id, events.push);
    bot.failNext("second");
    expect((await post(`/api/games/${g.id}/bot-retry`)).status).toBe(200);
    const err = await events.next("error");
    expect(err.type === "error" && err.message).toMatch(/second/);
    expect(games.view(g.id)!.botThinking).toBe(false);
    expect((await post(`/api/games/${g.id}/bot-retry`)).status).toBe(200);
    await games.idle(g.id);
    expect(ucis(games.view(g.id)!)).toEqual(["d2d4"]);
  });

  it("409s while the bot thinks, on the player's turn, and when not playing; 404 unknown", async () => {
    setup();
    const g = await newGame("w");
    const turn = await post(`/api/games/${g.id}/bot-retry`);
    expect(turn.status).toBe(409);
    expect(turn.body.error).toMatch(/player's turn/);
    bot.hold();
    await post(`/api/games/${g.id}/moves`, { uci: "e2e4" });
    const thinking = await post(`/api/games/${g.id}/bot-retry`);
    expect(thinking.status).toBe(409);
    expect(thinking.body.error).toMatch(/thinking/);
    bot.release();
    await games.idle(g.id);
    expect(bot.calls).toHaveLength(1);
    expect((await post(`/api/games/${g.id}/bot-retry`)).status).toBe(409);
    await post(`/api/games/${g.id}/resign`);
    expect((await post(`/api/games/${g.id}/bot-retry`)).status).toBe(409);
    expect((await post("/api/games/nope/bot-retry")).status).toBe(404);
  });

  it("409s for a failed game that was then resigned", async () => {
    setup();
    bot.failNext("boom");
    const g = await newGame("b");
    await games.idle(g.id);
    await post(`/api/games/${g.id}/resign`);
    expect((await post(`/api/games/${g.id}/bot-retry`)).status).toBe(409);
    expect(bot.calls).toHaveLength(1);
  });

  // The retry goes through startBot, so its stale-result guard still applies.
  it("discards a retried bot move that finishes after a resignation", async () => {
    setup(["d2d4"]);
    bot.failNext("boom");
    const g = await newGame("b");
    await games.idle(g.id);
    bot.hold();
    expect((await post(`/api/games/${g.id}/bot-retry`)).status).toBe(200);
    expect((await post(`/api/games/${g.id}/takeback`)).status).toBe(409);
    await post(`/api/games/${g.id}/resign`);
    bot.release();
    await games.idle(g.id);
    expect(games.view(g.id)).toMatchObject({ status: "finished", moves: [] });
  });

  it("discards a retried bot move that finishes after a new game abandons this one", async () => {
    setup(["e7e5"]);
    const g = await newGame("w");
    bot.failNext("boom");
    await play(g.id, "e2e4");
    bot.hold();
    expect((await post(`/api/games/${g.id}/bot-retry`)).status).toBe(200);
    const g2 = await newGame("w");
    bot.release();
    await games.idle(g.id);
    expect(games.view(g.id)).toMatchObject({ status: "abandoned", moves: [{ uci: "e2e4" }] });
    expect(games.view(g2.id)!.moves).toEqual([]);
  });
});
