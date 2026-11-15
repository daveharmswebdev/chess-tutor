import { afterEach, describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import type { FastifyInstance } from "fastify";
import type { Analysis, GameEvent, GameView, TutorNote } from "@chess-tutor/chess-core";
import { buildServer, type CoachingDeps } from "../src/app.ts";
import type { GameManager } from "../src/games.ts";
import { toPgn } from "../src/pgn.ts";
import { createSqliteGameStore, type GameStore, type SavedGame } from "../src/store.ts";
import {
  createFakeAnalyzer,
  createFakeBot,
  createFakeTutor,
  eventCollector,
  fenAfter,
  okOutcome,
  type FakeAnalyzer,
  type FakeBot,
  type FakeTutor,
} from "./helpers.ts";

/*
 * Tutor notes (#53: FR-25, FR-8 as amended by A6, FR-5, NFR-14, FR-10). A tutor question that
 * closes because its position is left becomes a TutorNote in GameView.notes.
 */

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const SECRET = "SECRET: d4 was better.";
const D4 = { uci: "d2d4", san: "d4", by: "player" } as const;

interface Server {
  app: FastifyInstance;
  games: GameManager;
  bot: FakeBot;
  analyzer: FakeAnalyzer;
  tutor: FakeTutor;
}

let store: GameStore;
let storeOpen = false;
let servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  if (storeOpen) store.close();
  storeOpen = false;
});

function freshStore() {
  const inner = createSqliteGameStore(":memory:");
  storeOpen = true;
  servers = [];
  store = {
    save: (game: SavedGame) => inner.save(game),
    get: (id) => inner.get(id),
    listPlaying: () => inner.listPlaying(),
    close: () => inner.close(),
  };
}

/** A server on the shared store; a second call after the first app closed is a restart. */
function boot(opts: { script?: string[]; prefix?: string; coaching?: Partial<CoachingDeps> } = {}): Server {
  const bot = createFakeBot(opts.script ?? ["e7e5", "b8c6", "g8f6", "f8e7"]);
  const analyzer = createFakeAnalyzer();
  const tutor = createFakeTutor();
  let n = 0;
  const prefix = opts.prefix ?? "g";
  const { app, games } = buildServer({
    bot,
    store,
    newId: () => `${prefix}${++n}`,
    logger: false,
    coaching: { analyzer, tutor, ...opts.coaching },
  });
  const s = { app, games, bot, analyzer, tutor };
  servers.push(s);
  return s;
}

async function post(s: Server, url: string, body?: unknown) {
  const res = await s.app.inject({ method: "POST", url, ...(body === undefined ? {} : { payload: body as object }) });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

async function get(s: Server, id: string) {
  const res = await s.app.inject({ method: "GET", url: `/api/games/${id}` });
  return { status: res.statusCode, view: res.json() as GameView, raw: res.body };
}

async function newGame(s: Server) {
  const res = await post(s, "/api/games", { playerColor: "w" });
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

function savedNotes(id: string): TutorNote[] {
  return (JSON.parse(store.get(id)!.state!) as { notes: TutorNote[] }).notes;
}

/** e2e4 loses 300 cp for White (player_blunder, d4 best); the bot's e7e5 keeps it (quiet). */
function scriptPlayerBlunder(a: FakeAnalyzer) {
  a.set(START, 0, "d2d4");
  a.set(fenAfter(["e2e4"]), -300);
  a.set(fenAfter(["e2e4", "e7e5"]), -300);
}

/** 1. e4? e5 with the player_blunder question open (attemptFen START, ply 0). */
async function blunderQuestion(s: Server) {
  scriptPlayerBlunder(s.analyzer);
  const { id, events } = await newGame(s);
  await play(s, id, "e2e4");
  (await s.tutor.ask(0)).resolve(okOutcome({ reveal: SECRET, revealMove: "d2d4" }));
  const reply = await events.next("tutor_reply");
  if (reply.type !== "tutor_reply") throw new Error("unreachable");
  await s.games.idle(id);
  return { id, events, question: reply.question };
}

const views = (events: GameEvent[]) => events.flatMap((e) => ("game" in e ? [e.game] : []));

describe("a note is created when the question's position is left (FR-25)", () => {
  it("graded correct try: question, reveal, the engine's best move and the attempt", async () => {
    freshStore();
    const s = boot();
    const { id, events, question } = await blunderQuestion(s);
    expect((await post(s, `/api/games/${id}/takeback`)).status).toBe(200);
    expect(s.games.view(id)!.notes).toEqual([]);
    s.analyzer.set(fenAfter(["g1f3"]), -40);
    await play(s, id, "g1f3");
    await events.next("tutor_attempt");
    const note: TutorNote = {
      questionId: question.id,
      kind: "player_blunder",
      ply: 0,
      message: question.message,
      reveal: SECRET,
      bestMove: D4,
      attempt: { move: { uci: "g1f3", san: "Nf3", by: "player" }, correct: true, cpLoss: 40 },
    };
    expect(s.games.view(id)!.notes).toEqual([note]);
    expect((await get(s, id)).view.notes).toEqual([note]);
    // The note reaches the client inside a GameView: a "state" after the attempt.
    const typesAfterAttempt = events.events.slice(events.events.findIndex((e) => e.type === "tutor_attempt")).map((e) => e.type);
    expect(typesAfterAttempt).toContain("state");
    expect(views(events.events).at(-1)!.notes).toEqual([note]);
  });

  it("wrong try: the attempt is graded false, with the reveal and best move", async () => {
    freshStore();
    const s = boot({ script: ["e7e5", "e7e5", "b8c6"] });
    const { id, events, question } = await blunderQuestion(s);
    expect((await post(s, `/api/games/${id}/takeback`)).status).toBe(200);
    await play(s, id, "e2e4");
    await events.next("tutor_reveal");
    await s.games.idle(id);
    expect(s.games.view(id)!.notes).toEqual([
      {
        questionId: question.id,
        kind: "player_blunder",
        ply: 0,
        message: question.message,
        reveal: SECRET,
        bestMove: D4,
        attempt: { move: { uci: "e2e4", san: "e4", by: "player" }, correct: false, cpLoss: 300 },
      },
    ]);
    // The next move leaves the shown question: no second note for it.
    await play(s, id, "g1f3");
    expect(s.games.view(id)!.notes).toHaveLength(1);
  });

  it("moved on without a takeback: attempt null, reveal and best move released in the move's reply", async () => {
    freshStore();
    const s = boot();
    const { id, events, question } = await blunderQuestion(s);
    // FR-8: nothing of the held reveal before the question closes.
    const before = JSON.stringify(events.events) + (await get(s, id)).raw;
    expect(before).not.toContain("SECRET");
    expect(s.games.view(id)!.notes).toEqual([]);
    const res = await post(s, `/api/games/${id}/moves`, { uci: "g1f3" });
    expect(res.status).toBe(200);
    const note = {
      questionId: question.id,
      kind: "player_blunder",
      ply: 0,
      message: question.message,
      reveal: SECRET,
      bestMove: D4,
      attempt: null,
    };
    expect((res.body as unknown as GameView).notes).toEqual([note]);
    // Saved before the reply (NFR-14).
    expect(savedNotes(id)).toEqual([note]);
    await s.games.idle(id);
    expect(s.games.view(id)!.notes).toEqual([note]);
  });

  it("Show me, then move on: no note while shown, a note (attempt null) once the player moves on", async () => {
    freshStore();
    const s = boot();
    const { id, question } = await blunderQuestion(s);
    expect((await post(s, `/api/games/${id}/tutor/reveal`)).status).toBe(200);
    expect(s.games.view(id)!.notes).toEqual([]);
    const view = await play(s, id, "g1f3");
    expect(view.notes).toEqual([
      { questionId: question.id, kind: "player_blunder", ply: 0, message: question.message, reveal: SECRET, bestMove: D4, attempt: null },
    ]);
  });

  it("game end (resign) with the question still open: a note in game_over and the saved row", async () => {
    freshStore();
    const s = boot();
    const { id, events, question } = await blunderQuestion(s);
    const res = await post(s, `/api/games/${id}/resign`);
    expect(res.status).toBe(200);
    const note = { questionId: question.id, kind: "player_blunder", ply: 0, message: question.message, reveal: SECRET, bestMove: D4, attempt: null };
    expect((res.body as unknown as GameView).notes).toEqual([note]);
    const over = await events.next("game_over");
    expect(over).toMatchObject({ game: { notes: [note] } });
    expect(savedNotes(id)).toEqual([note]);
  });

  it("game end with a hint open at the current position: ply === moves.length", async () => {
    freshStore();
    const s = boot();
    s.analyzer.set(fenAfter(["e2e4", "e7e5"]), 0, "g1f3");
    const { id, events } = await newGame(s);
    await play(s, id, "e2e4");
    expect((await post(s, `/api/games/${id}/tutor/hint`)).status).toBe(202);
    (await s.tutor.ask(0)).resolve(okOutcome({ kind: "hint", message: "What about the knight?", reveal: "Nf3 develops.", revealMove: "g1f3" }));
    const reply = await events.next("tutor_reply");
    if (reply.type !== "tutor_reply") throw new Error("unreachable");
    await s.games.idle(id);
    const res = await post(s, `/api/games/${id}/resign`);
    expect((res.body as unknown as GameView).notes).toEqual([
      {
        questionId: reply.question.id,
        kind: "hint",
        ply: 2,
        message: "What about the knight?",
        reveal: "Nf3 develops.",
        bestMove: { uci: "g1f3", san: "Nf3", by: "player" },
        attempt: null,
      },
    ]);
  });

  it("an abandoned game (a new game started) keeps its open question as a note", async () => {
    freshStore();
    const s = boot();
    const { id, question } = await blunderQuestion(s);
    await newGame(s);
    const old = (await get(s, id)).view;
    expect(old.status).toBe("abandoned");
    expect(old.notes).toMatchObject([{ questionId: question.id, ply: 0, attempt: null, reveal: SECRET }]);
  });

  it("a new ask replacing an open question turns it into a note", async () => {
    freshStore();
    const s = boot();
    const { id, question } = await blunderQuestion(s);
    s.tutor.auto = () => okOutcome({ kind: "hint" });
    expect((await post(s, `/api/games/${id}/tutor/hint`)).status).toBe(202);
    const view = s.games.view(id)!;
    expect(view.notes).toEqual([
      { questionId: question.id, kind: "player_blunder", ply: 0, message: question.message, reveal: SECRET, bestMove: D4, attempt: null },
    ]);
    expect(savedNotes(id)).toHaveLength(1);
  });

  it("bestMove is null when the engine had no evaluation, or its best move is not legal (FR-10)", async () => {
    freshStore();
    const failing = createFakeAnalyzer();
    const bad = fenAfter(["e2e4", "e7e5"]);
    const analyzer = {
      calls: failing.calls,
      set: failing.set,
      hold: failing.hold,
      release: failing.release,
      analyze(fen: string): Promise<Analysis> {
        if (fen === bad) return Promise.reject(new Error("engine down"));
        return failing.analyze(fen);
      },
    };
    const s = boot({ coaching: { analyzer } });
    const { id, events } = await newGame(s);
    await play(s, id, "e2e4");
    expect((await post(s, `/api/games/${id}/tutor/hint`)).status).toBe(202);
    (await s.tutor.ask(0)).resolve(okOutcome({ kind: "hint", reveal: "Nf3.", revealMove: "g1f3" }));
    await events.next("tutor_reply");
    await s.games.idle(id);
    const res = await post(s, `/api/games/${id}/resign`);
    expect((res.body as unknown as GameView).notes).toMatchObject([{ kind: "hint", ply: 2, bestMove: null, reveal: "Nf3." }]);

    // An illegal engine best move is never released either.
    const t = boot({ prefix: "t" });
    t.analyzer.set(fenAfter(["e2e4", "e7e5"]), 0, "e1e5");
    const g = await newGame(t);
    await play(t, g.id, "e2e4");
    expect((await post(t, `/api/games/${g.id}/tutor/hint`)).status).toBe(202);
    (await t.tutor.ask(0)).resolve(okOutcome({ kind: "hint" }));
    await g.events.next("tutor_reply");
    await t.games.idle(g.id);
    const r2 = await post(t, `/api/games/${g.id}/resign`);
    expect((r2.body as unknown as GameView).notes).toMatchObject([{ kind: "hint", bestMove: null, reveal: null }]);
  });
});

describe("FR-8: the open question's reveal and best move stay on the server", () => {
  it("no GameView carries the held reveal, or a note, until the question closes", async () => {
    freshStore();
    const s = boot();
    const { id, events } = await blunderQuestion(s);
    expect((await post(s, `/api/games/${id}/takeback`)).status).toBe(200);
    // Back at attemptFen (player_blunder retry): the question is still open, no note.
    const atRetry = s.games.view(id)!;
    expect(atRetry.tutor.question).not.toBeNull();
    expect(atRetry.notes).toEqual([]);
    for (const v of [...views(events.events), atRetry, (await get(s, id)).view]) {
      expect(v.notes).toEqual([]);
      expect(JSON.stringify(v)).not.toContain("SECRET");
    }
  });
});

describe("takebacks", () => {
  it("remove notes with ply >= the new moves.length and never reopen the question", async () => {
    freshStore();
    const s = boot({ script: ["e7e5", "e7e5", "b8c6"] });
    const { id, events } = await blunderQuestion(s);
    expect((await post(s, `/api/games/${id}/takeback`)).status).toBe(200);
    await play(s, id, "e2e4"); // wrong try, note on ply 0
    await events.next("tutor_reveal");
    await s.games.idle(id);
    expect(s.games.view(id)!.notes).toHaveLength(1);
    const res = await post(s, `/api/games/${id}/takeback`);
    expect(res.status).toBe(200);
    const view = res.body as unknown as GameView;
    expect(view.moves).toEqual([]);
    expect(view.notes).toEqual([]);
    expect(view.tutor.question).toBeNull();
    expect(savedNotes(id)).toEqual([]);
    // Not reopened: the next move from START is not graded.
    await play(s, id, "d2d4");
    expect(events.events.filter((e) => e.type === "tutor_attempt")).toHaveLength(1);
  });

  it("keep notes on moves still played", async () => {
    freshStore();
    const s = boot();
    const { id } = await blunderQuestion(s);
    await play(s, id, "g1f3"); // moved on: note on ply 0 (e4)
    expect(s.games.view(id)!.moves).toHaveLength(4);
    const res = await post(s, `/api/games/${id}/takeback`);
    const view = res.body as unknown as GameView;
    expect(view.moves).toHaveLength(2);
    expect(view.notes).toMatchObject([{ ply: 0 }]);
  });
});

describe("saving (NFR-14)", () => {
  it("the graded try's note is in the store before the event that carries it", async () => {
    freshStore();
    const s = boot();
    const { id, events } = await blunderQuestion(s);
    expect((await post(s, `/api/games/${id}/takeback`)).status).toBe(200);
    const seen: { type: string; saved: number; sent: number }[] = [];
    s.games.subscribe(id, (e) => {
      if ("game" in e) seen.push({ type: e.type, saved: savedNotes(id).length, sent: e.game.notes?.length ?? -1 });
    });
    s.analyzer.set(fenAfter(["g1f3"]), -10);
    await play(s, id, "g1f3");
    await events.next("tutor_attempt");
    await s.games.idle(id);
    expect(seen.some((x) => x.sent === 1)).toBe(true);
    for (const x of seen) expect(x.saved).toBeGreaterThanOrEqual(x.sent);
  });

  it("a slow grading: the try's reply has no note yet; the note arrives in a later state, saved first", async () => {
    freshStore();
    const s = boot();
    const { id, events, question } = await blunderQuestion(s);
    expect((await post(s, `/api/games/${id}/takeback`)).status).toBe(200);
    s.analyzer.hold(); // the analysis after Nf3 is not cached: grading waits
    const res = await post(s, `/api/games/${id}/moves`, { uci: "g1f3" });
    expect((res.body as unknown as GameView).notes).toEqual([]);
    expect((res.body as unknown as GameView).tutor.question).toBeNull();
    await events.next("bot_move", 1);
    expect(s.games.view(id)!.notes).toEqual([]);
    const statesBefore = events.events.filter((e) => e.type === "state").length;
    s.analyzer.release();
    await s.games.idle(id);
    const state = await events.next("state", statesBefore);
    expect(state).toMatchObject({ game: { notes: [{ questionId: question.id, ply: 0, attempt: { move: { uci: "g1f3" } } }] } });
    expect(savedNotes(id)).toHaveLength(1);
  });

  it("notes come back after a restart, and the try result with them", async () => {
    freshStore();
    const a = boot();
    const { id, question } = await blunderQuestion(a);
    expect((await post(a, `/api/games/${id}/takeback`)).status).toBe(200);
    a.analyzer.set(fenAfter(["g1f3"]), -40);
    await play(a, id, "g1f3");
    await a.games.idle(id);
    const before = a.games.view(id)!.notes;
    expect(before).toMatchObject([{ questionId: question.id, attempt: { correct: true, cpLoss: 40 } }]);
    await a.app.close();

    const b = boot({ prefix: "b" });
    expect((await get(b, id)).view.notes).toEqual(before);
  });

  it("an open question's best move survives a restart and is released once the player moves on", async () => {
    freshStore();
    const a = boot();
    const { id, question } = await blunderQuestion(a);
    await a.app.close();
    const b = boot({ prefix: "b", script: ["b8c6"] });
    expect((await get(b, id)).view.notes).toEqual([]);
    const view = await play(b, id, "g1f3");
    expect(view.notes).toEqual([
      { questionId: question.id, kind: "player_blunder", ply: 0, message: question.message, reveal: SECRET, bestMove: D4, attempt: null },
    ]);
  });

  it("a finished game's notes are served from the store", async () => {
    freshStore();
    const a = boot();
    const { id } = await blunderQuestion(a);
    await post(a, `/api/games/${id}/resign`);
    await a.app.close();
    const b = boot({ prefix: "b" });
    expect((await get(b, id)).view.notes).toMatchObject([{ ply: 0, reveal: SECRET, bestMove: D4 }]);
  });

  it("an old state row without notes loads as []", async () => {
    freshStore();
    const state = { v: 1, moves: [{ uci: "e2e4", by: "player" }, { uci: "e7e5", by: "bot" }], botThinking: false, tutor: { ask: null, question: null, shown: null } };
    store.save({
      id: "old1",
      playerColor: "w",
      status: "playing",
      result: "*",
      endReason: null,
      pgn: "",
      createdAt: "2026-11-14T10:00:00.000Z",
      updatedAt: "2026-11-14T10:00:00.000Z",
      state: JSON.stringify(state),
    });
    store.save({
      id: "old2",
      playerColor: "w",
      status: "finished",
      result: "0-1",
      endReason: "resigned",
      pgn: "",
      createdAt: "2026-11-14T10:00:00.000Z",
      updatedAt: "2026-11-14T10:00:00.000Z",
      state: JSON.stringify(state),
    });
    const s = boot();
    expect((await get(s, "old1")).view.notes).toEqual([]);
    expect((await get(s, "old2")).view.notes).toEqual([]);
    expect(s.games.view("old1")!.notes).toEqual([]);
  });

  it("every GameView carries notes, [] when none", async () => {
    freshStore();
    const s = boot();
    const { id, events } = await newGame(s);
    await play(s, id, "e2e4");
    for (const v of [s.games.view(id)!, ...views(events.events)]) expect(v.notes).toEqual([]);
  });
});

describe("PGN (FR-5)", () => {
  function gameView(notes: TutorNote[], ucis = ["e2e4", "e7e5", "g1f3"]): GameView {
    const chess = new Chess();
    const moves = ucis.map((uci, i) => {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
      return { uci, san: m.san, by: i % 2 === 0 ? ("player" as const) : ("bot" as const) };
    });
    return {
      id: "g1",
      playerColor: "w",
      fen: chess.fen(),
      moves,
      status: "finished",
      result: "0-1",
      endReason: "resigned",
      botThinking: false,
      tutor: { available: true, reason: null, thinking: false, question: null, reveal: null },
      notes,
    };
  }
  const note = (over: Partial<TutorNote>): TutorNote => ({
    questionId: "q1",
    kind: "player_blunder",
    ply: 0,
    message: "What does e4 leave undefended?",
    reveal: "d4 was better.",
    bestMove: D4,
    attempt: null,
    ...over,
  });
  const movetextOf = (pgn: string) => pgn.split("\n\n")[1]!.trim();

  it("writes a {...} comment after the move the note sits on, and loads back with chess.js", () => {
    const pgn = toPgn(
      gameView([
        note({ ply: 0, attempt: { move: { uci: "g1f3", san: "Nf3", by: "player" }, correct: true, cpLoss: 40 } }),
      ]),
      new Date("2026-11-15T10:00:00Z"),
    );
    const text = movetextOf(pgn);
    expect(text).toMatch(/^1\. e4 \{Tutor: What does e4 leave undefended\? [^}]*d4 was better\.[^}]*\} e5 2\. Nf3 0-1$/);
    expect(text).toContain("Best was d4");
    expect(text).toContain("Nf3");
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(["e4", "e5", "Nf3"]);
    const comments = chess.getComments();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.fen).toBe(fenAfter(["e2e4"]));
  });

  it("ply === moves.length sits after the last move; braces and newlines never break the PGN", () => {
    const pgn = toPgn(
      gameView([note({ ply: 3, kind: "hint", message: "Line one\nline {two}", reveal: "} closing }}", bestMove: null })]),
      new Date(),
    );
    const text = movetextOf(pgn);
    expect(text).toMatch(/^1\. e4 e5 2\. Nf3 \{[^{}\n]*\} 0-1$/);
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toHaveLength(3);
    expect(chess.getComments()[0]!.fen).toBe(fenAfter(["e2e4", "e7e5", "g1f3"]));
  });

  it("two notes on one move share a comment; the saved game's PGN has its notes", async () => {
    const pgn = toPgn(gameView([note({ ply: 1, questionId: "a" }), note({ ply: 1, questionId: "b", message: "Second." })]), new Date());
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.getComments()).toHaveLength(1);
    expect(chess.getComments()[0]!.comment).toContain("Second.");

    freshStore();
    const s = boot();
    const { id } = await blunderQuestion(s);
    await post(s, `/api/games/${id}/resign`);
    const saved = store.get(id)!.pgn;
    expect(movetextOf(saved)).toMatch(/^1\. e4 \{Tutor: [^}]*\} e5 0-1$/);
  });
});
