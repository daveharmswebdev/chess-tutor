import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GameEvent, GameView } from "@chess-tutor/chess-core";
import { buildServer, type CoachingDeps } from "../src/app.ts";
import type { GameManager } from "../src/games.ts";
import { NO_KEY_REASON } from "../src/tutor-setup.ts";
import { createSqliteGameStore, type GameStore } from "../src/store.ts";
import {
  botOnEngine,
  createFakeAnalyzer,
  createFakeBot,
  createFakeEngine,
  createFakeTutor,
  SESSION_FIRST_LABEL,
  eventCollector,
  failOutcome,
  fenAfter,
  okOutcome,
  type FakeAnalyzer,
  type FakeBot,
  type FakeTutor,
} from "./helpers.ts";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let app: FastifyInstance;
let games: GameManager;
let store: GameStore;
let bot: FakeBot;
let analyzer: FakeAnalyzer;
let tutor: FakeTutor;

function setup(opts: { script?: string[]; coaching?: Partial<CoachingDeps> } = {}) {
  bot = createFakeBot(opts.script ?? ["e7e5", "b8c6", "g8f6"]);
  analyzer = createFakeAnalyzer();
  tutor = createFakeTutor();
  store = createSqliteGameStore(":memory:");
  let n = 0;
  ({ app, games } = buildServer({
    bot,
    store,
    newId: () => `g${++n}`,
    logger: false,
    coaching: { analyzer, tutor, ...opts.coaching },
  }));
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
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

async function newGame(playerColor: "w" | "b" = "w") {
  const res = await post("/api/games", { playerColor });
  expect(res.status).toBe(201);
  const game = res.body as unknown as GameView;
  const events = eventCollector();
  games.subscribe(game.id, events.push);
  return { id: game.id, game, events };
}

async function play(id: string, uci: string): Promise<GameView> {
  const res = await post(`/api/games/${id}/moves`, { uci });
  expect(res.status, res.raw).toBe(200);
  await games.idle(id);
  return games.view(id)!;
}

const tutorTypes = (events: GameEvent[]) => events.map((e) => e.type).filter((t) => t.startsWith("tutor_"));

/** e2e4 loses 300 cp for White (player_blunder); the bot's e7e5 keeps it (quiet). */
function scriptPlayerBlunder() {
  analyzer.set(START, 0, "d2d4");
  analyzer.set(fenAfter(["e2e4"]), -300);
  analyzer.set(fenAfter(["e2e4", "e7e5"]), -300);
}

describe("key moments (FR-6, FR-7)", () => {
  it("a quiet move by either side runs the detector but never asks the tutor", async () => {
    setup();
    const { id, events } = await newGame();
    await play(id, "e2e4");
    await play(id, "g1f3");
    expect(analyzer.calls).toEqual(
      expect.arrayContaining([START, fenAfter(["e2e4"]), fenAfter(["e2e4", "e7e5"]), fenAfter(["e2e4", "e7e5", "g1f3"])]),
    );
    expect(tutor.asks).toHaveLength(0);
    expect(tutorTypes(events.events)).toEqual([]);
  });

  it("the player's blunder: exactly one ask, attemptFen before the move", async () => {
    setup();
    scriptPlayerBlunder();
    const { id } = await newGame();
    await play(id, "e2e4");
    const ask = await tutor.ask(0);
    expect(tutor.asks).toHaveLength(1);
    expect(ask.request).toMatchObject({
      kind: "key_moment",
      moment: { kind: "player_blunder", played: "e4", best: "d4", cpLoss: 300 },
      fen: fenAfter(["e2e4"]),
      attemptFen: START,
      history: ["e2e4"],
    });
    expect(tutor.sessions).toEqual([{ id, playerColor: "w", engine: expect.any(Object) }]);
  });

  it("the bot's mistake: exactly one ask (punish_opponent), attemptFen after the bot's move", async () => {
    setup();
    analyzer.set(fenAfter(["e2e4", "e7e5"]), 300);
    const { id } = await newGame();
    await play(id, "e2e4");
    const ask = await tutor.ask(0);
    await games.idle(id);
    expect(tutor.asks).toHaveLength(1);
    expect(ask.request).toMatchObject({
      kind: "key_moment",
      moment: { kind: "punish_opponent", opponentMove: "e5" },
      fen: fenAfter(["e2e4", "e7e5"]),
      attemptFen: fenAfter(["e2e4", "e7e5"]),
      history: ["e2e4", "e7e5"],
    });
  });

  it("SSE order: tutor_thinking, tutor_progress*, tutor_reply; reveal and revealMove stay on the server", async () => {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    await play(id, "e2e4");
    const ask = await tutor.ask(0);
    expect(games.view(id)!.tutor).toMatchObject({ available: true, thinking: true, question: null });
    ask.progress("Checking Nf3…");
    ask.resolve(okOutcome({ reveal: "SECRET-REVEAL", revealMove: "d2d4", arrows: [{ from: "e2", to: "e4" }] }));
    const reply = await events.next("tutor_reply");

    const types = tutorTypes(events.events);
    expect(types[0]).toBe("tutor_thinking");
    expect(types.at(-1)).toBe("tutor_reply");
    expect(types.slice(1, -1).every((t) => t === "tutor_progress")).toBe(true);
    expect(events.events).toContainEqual({ type: "tutor_progress", label: "Checking Nf3…" });
    expect(events.events.find((e) => e.type === "tutor_thinking")).toEqual({ type: "tutor_thinking", kind: "player_blunder" });

    if (reply.type !== "tutor_reply") throw new Error("unreachable");
    expect(reply.question).toEqual({
      id: expect.any(String),
      kind: "player_blunder",
      message: "What does your move leave undefended?",
      arrows: [{ from: "e2", to: "e4" }],
      attemptFen: START,
      canReveal: true,
    });
    const view = games.view(id)!;
    expect(view.tutor).toEqual({ available: true, reason: null, thinking: false, question: reply.question });
    const everything = JSON.stringify(events.events) + JSON.stringify(view);
    expect(everything).not.toContain("SECRET-REVEAL");
    expect(everything).not.toMatch(/revealMove|"reveal"/);
  });

  it("the bot replies while the tutor is still working (NFR-3: the game never waits)", async () => {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    await play(id, "e2e4");
    await tutor.ask(0); // held: never resolved
    expect(games.view(id)!.tutor.thinking).toBe(true);
    // Take back and try another move while the tutor is still working (attemptFen START stays
    // one takeback away, so the ask survives); the bot answers as usual.
    expect((await post(`/api/games/${id}/takeback`)).status).toBe(200);
    const res = await post(`/api/games/${id}/moves`, { uci: "d2d4" });
    expect(res.status).toBe(200);
    const botMove = await events.next("bot_move", 1);
    expect(botMove).toMatchObject({ game: { tutor: { thinking: true } } });
    expect(tutorTypes(events.events)).not.toContain("tutor_reply");
  });

  it("the shared engine serves the bot first: no analysis starts until the bot's search has settled (NFR-3)", async () => {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    await play(id, "d2d3"); // warms the cache for START
    await post(`/api/games/${id}/takeback`);
    await games.idle(id);
    const before = analyzer.calls.length;
    bot.hold();
    await post(`/api/games/${id}/moves`, { uci: "e2e4" });
    await new Promise((r) => setTimeout(r, 20));
    expect(analyzer.calls.slice(before)).toEqual([]);
    expect(tutor.asks).toHaveLength(0);
    bot.release();
    await events.next("bot_move", 1);
    await games.idle(id);
    expect(analyzer.calls.slice(before)).toContain(fenAfter(["e2e4"]));
    expect(tutor.asks).toHaveLength(1);
  });

  it("the detector sees the bot's move even when the analysis is slower than the bot", async () => {
    setup();
    analyzer.set(fenAfter(["e2e4", "e7e5"]), 300);
    const { id, events } = await newGame();
    analyzer.hold();
    await post(`/api/games/${id}/moves`, { uci: "e2e4" });
    await events.next("bot_move");
    expect(tutor.asks).toHaveLength(0);
    analyzer.release();
    await games.idle(id);
    expect(tutor.asks).toHaveLength(1);
    expect(tutor.asks[0]!.request).toMatchObject({ moment: { kind: "punish_opponent" } });
  });

  it("a key moment for a move that was taken back before detection finished is dropped", async () => {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    analyzer.hold();
    await post(`/api/games/${id}/moves`, { uci: "e2e4" });
    await events.next("bot_move");
    expect((await post(`/api/games/${id}/takeback`)).status).toBe(200);
    analyzer.release();
    await games.idle(id);
    expect(tutor.asks).toHaveLength(0);
  });

  for (const [name, settle] of [
    ["fails (rate_limited)", (t: FakeTutor) => t.asks[0]!.resolve(failOutcome("rate_limited", "RAW-MODEL-TEXT"))],
    ["fails (api_unavailable)", (t: FakeTutor) => t.asks[0]!.resolve(failOutcome("api_unavailable", "RAW-MODEL-TEXT"))],
    ["throws", (t: FakeTutor) => t.asks[0]!.reject(new Error("RAW-MODEL-TEXT"))],
  ] as const) {
    it(`when the tutor ${name}: tutor_failed with a plain message, coaching stays on`, async () => {
      setup();
      scriptPlayerBlunder();
      const { id, events } = await newGame();
      await play(id, "e2e4");
      await tutor.ask(0);
      settle(tutor);
      const failed = await events.next("tutor_failed");
      expect(failed).toEqual({ type: "tutor_failed", message: expect.any(String) });
      expect(JSON.stringify(failed)).not.toContain("RAW-MODEL-TEXT");
      expect(tutorTypes(events.events)).toEqual(["tutor_thinking", "tutor_progress", "tutor_failed"]);
      expect(games.view(id)!.tutor).toEqual({ available: true, reason: null, thinking: false, question: null });
    });
  }

  it("a new key moment replaces an ask the player has moved past: the old one is aborted, its late reply dropped", async () => {
    setup();
    analyzer.set(fenAfter(["e2e4", "e7e5"]), 300, "d1h5"); // the bot's e5: punish_opponent
    analyzer.set(fenAfter(["e2e4", "e7e5", "g1f3"]), 0); // the player misses it: missed_win
    const { id, events } = await newGame();
    await play(id, "e2e4");
    const first = await tutor.ask(0);
    expect(first.request).toMatchObject({ moment: { kind: "punish_opponent" } });
    await play(id, "g1f3");
    const second = await tutor.ask(1);
    expect(second.request).toMatchObject({ moment: { kind: "missed_win" } });
    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);

    first.resolve(okOutcome({ message: "LATE" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(tutorTypes(events.events)).not.toContain("tutor_reply");
    expect(games.view(id)!.tutor.thinking).toBe(true);

    second.resolve(okOutcome({ kind: "missed_win", message: "What did e5 leave undefended?" }));
    const reply = await events.next("tutor_reply");
    expect(reply).toMatchObject({ question: { kind: "missed_win", attemptFen: fenAfter(["e2e4", "e7e5"]) } });
    expect(events.events.filter((e) => e.type === "tutor_reply")).toHaveLength(1);
    expect(JSON.stringify(events.events)).not.toContain("LATE");
  });

  // Review 028 (minor): the bot's key moment must not drop the player's own lesson.
  const repertoire = {
    continuations: (history: string[]) =>
      history.join(" ") === "e2e4" ? { line: "Test line", moves: [{ uci: "c7c5", san: "c5" }] } : null,
  };
  for (const [name, arrange] of [
    ["punish_opponent", () => analyzer.set(fenAfter(["e2e4", "e7e5"]), 300)],
    ["opponent_left_book", () => undefined],
  ] as const) {
    it(`player_blunder, then the bot's reply is ${name}: the player's lesson is kept, one ask`, async () => {
      setup({ coaching: { repertoire } });
      analyzer.set(START, 0, "d2d4");
      analyzer.set(fenAfter(["e2e4"]), -300);
      analyzer.set(fenAfter(["e2e4", "e7e5"]), -300);
      arrange();
      const { id, events } = await newGame();
      await play(id, "e2e4");
      const ask = await tutor.ask(0);
      await games.idle(id);
      expect(tutor.asks).toHaveLength(1);
      expect(ask.request).toMatchObject({ moment: { kind: "player_blunder" } });
      expect(ask.signal?.aborted).toBe(false);
      ask.resolve(okOutcome());
      expect(await events.next("tutor_reply")).toMatchObject({ question: { kind: "player_blunder", attemptFen: START } });
      expect(tutorTypes(events.events).filter((t) => t === "tutor_thinking")).toHaveLength(1);
    });
  }

  it("an open player_blunder question is not replaced by the bot's later key moment either", async () => {
    setup();
    analyzer.set(START, 0, "d2d4");
    analyzer.set(fenAfter(["e2e4"]), -300); // player_blunder
    analyzer.set(fenAfter(["e2e4", "e7e5"]), 300); // and the bot's e5 is punish_opponent
    tutor.auto = () => okOutcome(); // the player's question is open before the bot's detection runs
    const { id, events } = await newGame();
    await play(id, "e2e4");
    const reply = await events.next("tutor_reply");
    await games.idle(id);
    if (reply.type !== "tutor_reply") throw new Error("unreachable");
    expect(reply.question.kind).toBe("player_blunder");
    expect(games.view(id)!.tutor.question).toEqual(reply.question);
    expect(tutor.asks).toHaveLength(1);
  });

  it("a key moment of the bot's move is not coached once the player has moved past its attemptFen", async () => {
    setup();
    analyzer.set(fenAfter(["e2e4", "e7e5"]), 300); // punish_opponent, attemptFen after e5
    analyzer.set(fenAfter(["e2e4", "e7e5", "g1f3"]), 300); // g1f3 keeps it: quiet
    const { id, events } = await newGame();
    analyzer.hold();
    await post(`/api/games/${id}/moves`, { uci: "e2e4" });
    await events.next("bot_move");
    bot.hold(); // the bot's reply to g1f3 waits, so the e5 position is just one ply back
    await post(`/api/games/${id}/moves`, { uci: "g1f3" }); // before the bot move's detection ran
    analyzer.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(tutor.asks).toHaveLength(0);
    bot.release();
    await games.idle(id);
    expect(tutor.asks).toHaveLength(0);
    expect(tutorTypes(events.events)).toEqual([]);
  });

  it("an in-flight player_blunder ask survives the bot's reply and the takeback, then opens at the current position", async () => {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    await play(id, "e2e4");
    const ask = await tutor.ask(0);
    expect(games.view(id)!.moves).toHaveLength(2); // the bot has replied
    expect((await post(`/api/games/${id}/takeback`)).status).toBe(200);
    expect(games.view(id)!.tutor.thinking).toBe(true);
    ask.resolve(okOutcome());
    expect(await events.next("tutor_reply")).toMatchObject({ question: { attemptFen: START } });
  });

  it("each ask sends the first progress label once (the session's own)", async () => {
    setup();
    tutor.auto = () => okOutcome({ kind: "hint" });
    const { id, events } = await newGame();
    expect((await post(`/api/games/${id}/tutor/hint`)).status).toBe(202);
    await events.next("tutor_reply");
    const firsts = events.events.filter((e) => e.type === "tutor_progress" && e.label === SESSION_FIRST_LABEL);
    expect(firsts).toHaveLength(1);
    expect(tutorTypes(events.events)).toEqual(["tutor_thinking", "tutor_progress", "tutor_reply"]);
  });
});

describe("a reply never opens a question the player cannot reach (review 028)", () => {
  it("hint, then a move before the reply: the ask is aborted, thinking clears, no tutor_reply", async () => {
    setup();
    const { id, events } = await newGame();
    expect((await post(`/api/games/${id}/tutor/hint`)).status).toBe(202);
    const ask = await tutor.ask(0);
    await play(id, "e2e4");
    expect(ask.signal?.aborted).toBe(true);
    const states = events.events.filter((e) => e.type === "state");
    expect(states.at(-1)).toMatchObject({ game: { tutor: { thinking: false, question: null } } });
    ask.resolve(okOutcome({ kind: "hint", arrows: [{ from: "e2", to: "e4" }] }));
    await new Promise((r) => setTimeout(r, 10));
    expect(tutorTypes(events.events)).not.toContain("tutor_reply");
    expect(games.view(id)!.tutor).toMatchObject({ thinking: false, question: null });
  });

  it("a reply that arrives after a resign opens nothing; the ask is aborted", async () => {
    setup();
    const { id, events } = await newGame();
    await post(`/api/games/${id}/tutor/hint`);
    const ask = await tutor.ask(0);
    expect((await post(`/api/games/${id}/resign`)).status).toBe(200);
    expect(ask.signal?.aborted).toBe(true);
    expect(events.events.at(-1)).toMatchObject({ type: "game_over", game: { tutor: { thinking: false } } });
    ask.resolve(okOutcome({ kind: "hint", reveal: "x", revealMove: "e2e4" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(tutorTypes(events.events)).not.toContain("tutor_reply");
    expect(games.view(id)!.tutor.question).toBeNull();
    expect((await post(`/api/games/${id}/tutor/reveal`)).status).toBe(409);
  });

  it("a reply that arrives after checkmate opens nothing (the ask was still reachable by a takeback)", async () => {
    setup({ script: ["e7e5", "b8c6", "g8f6"] });
    const { id, events } = await newGame();
    for (const m of ["e2e4", "f1c4", "d1h5"]) await play(id, m);
    const x = games.view(id)!.fen; // Qxf7# is on
    analyzer.set(x, 0, "h5f7");
    analyzer.set(fenAfter(["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5h6"]), -300);
    await play(id, "h5h6"); // player_blunder, attemptFen x
    const ask = await tutor.ask(0);
    expect((await post(`/api/games/${id}/takeback`)).status).toBe(200);
    expect(games.view(id)!.fen).toBe(x);
    const mate = await play(id, "h5f7");
    expect(mate).toMatchObject({ status: "finished", endReason: "checkmate", tutor: { thinking: false } });
    expect(ask.signal?.aborted).toBe(true);
    ask.resolve(okOutcome({ reveal: "Qxf7#", revealMove: "h5f7" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(tutorTypes(events.events)).not.toContain("tutor_reply");
    expect(games.view(id)!.tutor.question).toBeNull();
  });
});

describe("the tutor's engine searches never delay the bot (NFR-3, review 028)", () => {
  async function askWithEngine() {
    const engine = createFakeEngine();
    analyzer = createFakeAnalyzer();
    tutor = createFakeTutor();
    store = createSqliteGameStore(":memory:");
    ({ app, games } = buildServer({
      bot: botOnEngine(engine, 20),
      store,
      logger: false,
      coaching: { analyzer, tutor, engine },
    }));
    scriptPlayerBlunder();
    analyzer.set(fenAfter(["e2e4", "a7a6"]), -300);
    const { id, events } = await newGame();
    await play(id, "e2e4");
    const ask = await tutor.ask(0);
    expect(ask.request).toMatchObject({ moment: { kind: "player_blunder" } });
    const tutorEngine = tutor.sessions[0]!.engine;
    engine.hold();
    const searches = ["8/8/8/8/8/8/8/K1k5 w - - 0 1", "8/8/8/8/8/8/8/K2k4 w - - 0 1", "8/8/8/8/8/8/8/K3k3 w - - 0 1"].map(
      (fen) => {
        const p = tutorEngine.analyze(fen, { depth: 18, movetimeMs: 1000, multiPv: 3 });
        const settled = p.then(
          () => "resolved",
          (err: unknown) => `rejected: ${err instanceof Error ? err.name : String(err)}`,
        );
        return { fen, settled };
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    return { id, events, ask, engine, searches };
  }

  it("at most one tutor search is submitted; the bot's search goes ahead of the waiting ones", async () => {
    const { id, events, engine, searches } = await askWithEngine();
    const tutorSubs = () => engine.submissions.filter((s) => searches.some((x) => s === `analyze ${x.fen}`));
    expect(tutorSubs()).toEqual([`analyze ${searches[0]!.fen}`]);

    // The player retries from the attempt position: the ask stays (attemptFen one takeback away).
    expect((await post(`/api/games/${id}/takeback`)).status).toBe(200);
    expect((await post(`/api/games/${id}/moves`, { uci: "d2d4" })).status).toBe(200);
    engine.release(); // the first tutor search ends while the bot is still in its explorer lookup
    await events.next("bot_move", 1);
    await Promise.all(searches.map((s) => s.settled));

    const order = engine.submissions.slice(engine.submissions.indexOf(`analyze ${searches[0]!.fen}`));
    expect(order).toEqual([
      `analyze ${searches[0]!.fen}`,
      `bestMove ${fenAfter(["d2d4"])}`,
      `analyze ${searches[1]!.fen}`,
      `analyze ${searches[2]!.fen}`,
    ]);
    expect(await Promise.all(searches.map((s) => s.settled))).toEqual(["resolved", "resolved", "resolved"]);
  });

  it("aborting the ask rejects its waiting tutor searches; they never reach the engine", async () => {
    const { id, ask, engine, searches } = await askWithEngine();
    // Moving on (no takeback) makes attemptFen unreachable: the ask is aborted.
    expect((await post(`/api/games/${id}/moves`, { uci: "g1f3" })).status).toBe(200);
    expect(ask.signal?.aborted).toBe(true);
    expect(await searches[1]!.settled).toBe("rejected: AbortError");
    expect(await searches[2]!.settled).toBe("rejected: AbortError");
    engine.release();
    await games.idle(id);
    expect(engine.submissions).not.toContain(`analyze ${searches[1]!.fen}`);
    expect(engine.submissions).not.toContain(`analyze ${searches[2]!.fen}`);
  });
});

describe("POST /api/games/:id/tutor/hint (FR-12)", () => {
  it("202 {}, then the hint arrives over SSE; the request is the current position", async () => {
    setup();
    tutor.auto = () => okOutcome({ kind: "hint", message: "Which piece is not developed yet?" });
    const { id, events } = await newGame();
    await play(id, "e2e4");
    const res = await post(`/api/games/${id}/tutor/hint`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
    expect(tutor.asks[0]!.request).toEqual({
      kind: "hint",
      fen: fenAfter(["e2e4", "e7e5"]),
      history: ["e2e4", "e7e5"],
    });
    const reply = await events.next("tutor_reply");
    expect(reply).toMatchObject({
      question: { kind: "hint", attemptFen: fenAfter(["e2e4", "e7e5"]), canReveal: false },
    });
    expect(tutorTypes(events.events)).toEqual(["tutor_thinking", "tutor_progress", "tutor_reply"]);
  });

  it("409 while the tutor is working, when it is not the player's turn, and when the game is over", async () => {
    setup();
    const { id } = await newGame();
    expect((await post(`/api/games/${id}/tutor/hint`)).status).toBe(202);
    expect((await post(`/api/games/${id}/tutor/hint`)).status).toBe(409);
    tutor.asks[0]!.resolve(okOutcome({ kind: "hint" }));
    await new Promise((r) => setTimeout(r, 0));

    bot.hold();
    await post(`/api/games/${id}/moves`, { uci: "d2d4" });
    const notYourTurn = await post(`/api/games/${id}/tutor/hint`);
    expect(notYourTurn.status).toBe(409);
    expect(notYourTurn.body).toEqual({ error: expect.any(String) });
    bot.release();
    await games.idle(id);

    expect((await post(`/api/games/${id}/resign`)).status).toBe(200);
    expect((await post(`/api/games/${id}/tutor/hint`)).status).toBe(409);
    expect((await post(`/api/games/nope/tutor/hint`)).status).toBe(404);
    expect(tutor.asks).toHaveLength(1);
  });

  it("a hint replaces an open question", async () => {
    setup();
    scriptPlayerBlunder();
    tutor.auto = (req) => okOutcome({ kind: req.kind === "hint" ? "hint" : "player_blunder" });
    const { id, events } = await newGame();
    await play(id, "e2e4");
    const first = await events.next("tutor_reply");
    expect((await post(`/api/games/${id}/tutor/hint`)).status).toBe(202);
    const second = await events.next("tutor_reply", 1);
    if (first.type !== "tutor_reply" || second.type !== "tutor_reply") throw new Error("unreachable");
    expect(second.question.id).not.toBe(first.question.id);
    expect(games.view(id)!.tutor.question).toEqual(second.question);
  });
});

describe("POST /api/games/:id/tutor/reveal (Show me)", () => {
  async function openQuestion(revealMove: string | null, reveal: string | null = "Bf4 keeps the pawn defended.") {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    await play(id, "e2e4");
    (await tutor.ask(0)).resolve(okOutcome({ reveal, revealMove, arrows: [{ from: "d2", to: "d4" }] }));
    const reply = await events.next("tutor_reply");
    if (reply.type !== "tutor_reply") throw new Error("unreachable");
    return { id, events, question: reply.question };
  }

  it("200 TutorReveal and a tutor_reveal event, with no tutor call; the question closes", async () => {
    const { id, events, question } = await openQuestion("d2d4");
    const res = await post(`/api/games/${id}/tutor/reveal`);
    expect(res.status).toBe(200);
    const reveal = {
      questionId: question.id,
      text: "Bf4 keeps the pawn defended.",
      move: { uci: "d2d4", san: "d4", by: "player" },
      arrows: [{ from: "d2", to: "d4" }],
    };
    expect(res.body).toEqual(reveal);
    expect(events.events.at(-1)).toEqual({ type: "tutor_reveal", reveal });
    expect(tutor.asks).toHaveLength(1);
    expect(games.view(id)!.tutor.question).toBeNull();
    expect((await post(`/api/games/${id}/tutor/reveal`)).status).toBe(409);
  });

  it("an illegal revealMove becomes move: null (FR-10)", async () => {
    const { id } = await openQuestion("e1e5");
    const res = await post(`/api/games/${id}/tutor/reveal`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ move: null, text: "Bf4 keeps the pawn defended." });
  });

  it("409 when there is no open question", async () => {
    setup();
    const { id } = await newGame();
    const res = await post(`/api/games/${id}/tutor/reveal`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(tutor.asks).toHaveLength(0);
  });
});

describe("trying again: the engine grades the attempt (no Claude call)", () => {
  async function blunderQuestion() {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    await play(id, "e2e4");
    (await tutor.ask(0)).resolve(okOutcome({ reveal: "d4 was better.", revealMove: "d2d4" }));
    const reply = await events.next("tutor_reply");
    if (reply.type !== "tutor_reply") throw new Error("unreachable");
    expect((await post(`/api/games/${id}/takeback`)).status).toBe(200);
    expect(games.view(id)!.fen).toBe(START);
    expect(games.view(id)!.tutor.question).toEqual(reply.question);
    return { id, events, question: reply.question };
  }

  it("correct within attemptToleranceCp: tutor_attempt correct, no reveal, question closed", async () => {
    const { id, events, question } = await blunderQuestion();
    analyzer.set(fenAfter(["g1f3"]), -40); // 40 cp worse than best (d4): within 50
    await play(id, "g1f3");
    const attempt = await events.next("tutor_attempt");
    expect(attempt).toEqual({
      type: "tutor_attempt",
      questionId: question.id,
      move: { uci: "g1f3", san: "Nf3", by: "player" },
      correct: true,
      cpLoss: 40,
    });
    expect(tutorTypes(events.events)).not.toContain("tutor_reveal");
    expect(games.view(id)!.tutor.question).toBeNull();
    expect(tutor.asks).toHaveLength(1);
  });

  it("wrong: tutor_attempt (correct false) then tutor_reveal; question closed; no new ask for that move", async () => {
    const { id, events, question } = await blunderQuestion();
    await play(id, "e2e4");
    await events.next("tutor_reveal");
    const types = tutorTypes(events.events);
    expect(types.slice(-2)).toEqual(["tutor_attempt", "tutor_reveal"]);
    expect(events.events.find((e) => e.type === "tutor_attempt")).toMatchObject({
      questionId: question.id,
      correct: false,
      cpLoss: 300,
      move: { uci: "e2e4", by: "player" },
    });
    expect(events.events.at(-1)).toEqual({
      type: "tutor_reveal",
      reveal: {
        questionId: question.id,
        text: "d4 was better.",
        move: { uci: "d2d4", san: "d4", by: "player" },
        arrows: [{ from: "d2", to: "d4" }],
      },
    });
    expect(games.view(id)!.tutor.question).toBeNull();
    await games.idle(id);
    expect(tutor.asks).toHaveLength(1);
  });

  it("just over the tolerance (51 cp) is wrong", async () => {
    const { id, events } = await blunderQuestion();
    analyzer.set(fenAfter(["g1f3"]), -51);
    await play(id, "g1f3");
    expect(await events.next("tutor_attempt")).toMatchObject({ correct: false, cpLoss: 51 });
    await events.next("tutor_reveal");
  });

  it("a retry taken back before its grading finished sends no tutor_attempt (review 028)", async () => {
    const { id, events } = await blunderQuestion();
    analyzer.hold();
    expect((await post(`/api/games/${id}/moves`, { uci: "g1f3" })).status).toBe(200);
    await events.next("bot_move", 1);
    expect((await post(`/api/games/${id}/takeback`)).status).toBe(200);
    analyzer.release();
    await games.idle(id);
    expect(tutorTypes(events.events)).not.toContain("tutor_attempt");
    expect(tutorTypes(events.events)).not.toContain("tutor_reveal");
  });

  it("moving on without a takeback closes the question without grading", async () => {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    await play(id, "e2e4");
    (await tutor.ask(0)).resolve(okOutcome({ reveal: "d4 was better.", revealMove: "d2d4" }));
    await events.next("tutor_reply");
    const view = await play(id, "g1f3");
    expect(view.tutor.question).toBeNull();
    expect(tutorTypes(events.events)).not.toContain("tutor_attempt");
    expect(tutorTypes(events.events)).not.toContain("tutor_reveal");
  });

  it("a punish_opponent question is graded on the player's very next move", async () => {
    setup();
    analyzer.set(fenAfter(["e2e4", "e7e5"]), 300, "d1h5");
    const { id, events } = await newGame();
    await play(id, "e2e4");
    (await tutor.ask(0)).resolve(okOutcome({ kind: "punish_opponent", revealMove: "d1h5", reveal: "Qh5!" }));
    await events.next("tutor_reply");
    analyzer.set(fenAfter(["e2e4", "e7e5", "d1h5"]), 300);
    await play(id, "d1h5");
    expect(await events.next("tutor_attempt")).toMatchObject({ correct: true, cpLoss: 0, move: { uci: "d1h5" } });
  });
});

describe("availability (NFR-9)", () => {
  it("no tutor: available false with the reason everywhere; hint 503; the game still plays", async () => {
    setup({ coaching: { tutor: null, offReason: NO_KEY_REASON } });
    const { id, game, events } = await newGame();
    const off = { available: false, reason: "Coaching is off: no API key is set.", thinking: false, question: null };
    expect(game.tutor).toEqual(off);
    const hint = await post(`/api/games/${id}/tutor/hint`);
    expect(hint.status).toBe(503);
    expect(hint.body).toEqual({ error: "Coaching is off: no API key is set." });
    scriptPlayerBlunder();
    const view = await play(id, "e2e4");
    expect(view.tutor).toEqual(off);
    expect(events.events.find((e) => e.type === "state")).toMatchObject({ game: { tutor: off } });
    expect(view.moves).toHaveLength(2);
  });

  it("an auth outcome turns coaching off for the process, with a reason; games keep working", async () => {
    setup();
    scriptPlayerBlunder();
    const { id, events } = await newGame();
    await play(id, "e2e4");
    (await tutor.ask(0)).resolve(failOutcome("auth"));
    await events.next("tutor_failed");
    const state = await events.next("state", 1);
    if (state.type !== "state") throw new Error("unreachable");
    expect(state.game.tutor).toMatchObject({ available: false, reason: expect.stringMatching(/^Coaching is off/) });
    expect((await post(`/api/games/${id}/tutor/hint`)).status).toBe(503);

    // A new game in the same process is off too, and plays.
    const second = await newGame();
    expect(second.game.tutor.available).toBe(false);
    const view = await play(second.id, "e2e4");
    expect(view.moves).toHaveLength(2);
    expect(tutor.asks).toHaveLength(1);
  });

  it("without coaching deps at all, games report coaching off", async () => {
    bot = createFakeBot();
    store = createSqliteGameStore(":memory:");
    ({ app, games } = buildServer({ bot, store, logger: false }));
    const res = await post("/api/games", { playerColor: "w" });
    expect((res.body as unknown as GameView).tutor).toMatchObject({ available: false, reason: expect.any(String) });
  });
});
