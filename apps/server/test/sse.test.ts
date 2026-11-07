import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { GameEvent, GameView } from "@chess-tutor/chess-core";
import { buildServer } from "../src/app.ts";
import { createSqliteGameStore, type GameStore } from "../src/store.ts";
import { createFakeBot, type FakeBot } from "./helpers.ts";

let app: FastifyInstance;
let store: GameStore;
let base: string;

async function start(bot: FakeBot) {
  store = createSqliteGameStore(":memory:");
  ({ app } = buildServer({ bot, store, logger: false }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await app.close();
  store.close();
});

interface Message {
  event: string;
  data: GameEvent;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Reads SSE messages from a real HTTP connection until `until` matches a message.
 * `onFirst` runs once the first message has arrived (the stream is then subscribed).
 */
async function readEvents(
  path: string,
  until: (m: Message) => boolean,
  onFirst?: () => Promise<void>,
): Promise<Message[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const res = await fetch(`${base}${path}`, { signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: Message[] = [];
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return messages;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!event) continue; // comment / keep-alive
        const message = { event, data: JSON.parse(data) as GameEvent };
        messages.push(message);
        if (messages.length === 1 && onFirst) await onFirst();
        if (until(message)) return messages;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

describe("GET /api/games/:id/events (real socket)", () => {
  it("sends state first, then the bot's first move for a Black player", async () => {
    await start(createFakeBot(["d2d4"], 100));
    const created = await postJson("/api/games", { playerColor: "b" });
    expect(created.status).toBe(201);
    const game = (await created.json()) as GameView;

    const messages = await readEvents(`/api/games/${game.id}/events`, (m) => m.event === "bot_move");
    expect(messages[0]!.event).toBe("state");
    expect(messages[0]!.data).toMatchObject({ type: "state", game: { id: game.id } });
    expect(messages.at(-1)!.data).toMatchObject({
      type: "bot_move",
      move: { uci: "d2d4", san: "d4", by: "bot" },
      game: { botThinking: false },
    });
  });

  it("first message is state even when the bot already moved; pushes bot_move after a player move", async () => {
    await start(createFakeBot(["e7e5"], 20));
    const game = (await (await postJson("/api/games", { playerColor: "w" })).json()) as GameView;

    const messages = await readEvents(
      `/api/games/${game.id}/events`,
      (m) => m.event === "bot_move",
      async () => {
        const res = await postJson(`/api/games/${game.id}/moves`, { uci: "e2e4" });
        expect(res.status).toBe(200);
      },
    );
    expect(messages[0]).toMatchObject({ event: "state", data: { type: "state", game: { moves: [] } } });
    expect(messages.at(-1)!.data).toMatchObject({ move: { uci: "e7e5", by: "bot" } });

    // A fresh connection starts with the current state.
    const again = await readEvents(`/api/games/${game.id}/events`, () => true);
    expect(again[0]!.data).toMatchObject({ type: "state", game: { moves: [{ uci: "e2e4" }, { uci: "e7e5" }] } });
  });

  // Review 019 (major): after a bot failure the client must learn botThinking is false.
  // "state" comes before "error": the web reducer clears its message on state and sets it on error.
  for (const [name, arrange] of [
    ["the bot rejects", (bot: FakeBot) => bot.failNext("engine crashed")],
    ["the bot returns an illegal move", (bot: FakeBot) => bot.illegalNext("e2e5")],
  ] as const) {
    it(`when ${name}: state (botThinking false) then error, and a takeback works afterwards`, async () => {
      const bot = createFakeBot();
      await start(bot);
      const game = (await (await postJson("/api/games", { playerColor: "w" })).json()) as GameView;
      arrange(bot);

      const messages = await readEvents(
        `/api/games/${game.id}/events`,
        (m) => m.event === "error",
        async () => {
          const res = await postJson(`/api/games/${game.id}/moves`, { uci: "e2e4" });
          expect(res.status).toBe(200);
        },
      );
      const afterMove = messages.slice(1).map((m) => m.event);
      expect(afterMove.slice(-2)).toEqual(["state", "error"]);
      const state = messages.at(-2)!.data;
      expect(state).toMatchObject({
        type: "state",
        game: { botThinking: false, status: "playing", moves: [{ uci: "e2e4", by: "player" }] },
      });
      if (state.type === "state") expect(state.game.moves).toHaveLength(1);
      expect(messages.at(-1)!.data).toMatchObject({ type: "error", message: expect.stringMatching(/bot/i) });

      const takeback = await fetch(`${base}/api/games/${game.id}/takeback`, { method: "POST" });
      expect(takeback.status).toBe(200);
      expect(((await takeback.json()) as GameView).moves).toEqual([]);
    });
  }

  it("404s events for an unknown game", async () => {
    await start(createFakeBot());
    const res = await fetch(`${base}/api/games/nope/events`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toEqual(expect.any(String));
  });
});
