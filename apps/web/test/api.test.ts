import { describe, expect, it } from "vitest";
import { ApiRequestError, createApiClient } from "../src/api.ts";
import { view } from "./fixtures.ts";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function rejection(p: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiRequestError) return e;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe("api client", () => {
  it("creates a game with POST /api/games and returns the GameView", async () => {
    const calls: Call[] = [];
    const api = createApiClient({ fetch: fakeFetch(201, view(), calls) });
    const game = await api.newGame("b");
    expect(game.id).toBe("g1");
    expect(calls).toEqual([{ url: "/api/games", method: "POST", body: { playerColor: "b" } }]);
  });

  it("posts moves, takebacks, resignations and bot retries to the game's routes", async () => {
    const calls: Call[] = [];
    const api = createApiClient({ baseUrl: "/api", fetch: fakeFetch(200, view(), calls) });
    await api.playMove("g1", "d2d4");
    await api.takeback("g1");
    await api.resign("g1");
    await api.botRetry("g1");
    await api.getGame("g1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/games/g1/moves",
      "POST /api/games/g1/takeback",
      "POST /api/games/g1/resign",
      "POST /api/games/g1/bot-retry",
      "GET /api/games/g1",
    ]);
    expect(calls[0]?.body).toEqual({ uci: "d2d4" });
  });

  it("encodes the game id in URLs", async () => {
    const calls: Call[] = [];
    const api = createApiClient({ fetch: fakeFetch(200, view(), calls) });
    await api.getGame("a/b");
    expect(calls[0]?.url).toBe("/api/games/a%2Fb");
    expect(api.eventsUrl("a/b")).toBe("/api/games/a%2Fb/events");
  });

  it("maps 400 to a readable illegal-move error that includes the server's reason", async () => {
    const api = createApiClient({ fetch: fakeFetch(400, { error: "illegal move e2e5" }) });
    const err = await rejection(api.playMove("g1", "e2e5"));
    expect(err.status).toBe(400);
    expect(err.message).toBe("That move was not accepted: illegal move e2e5");
  });

  it("maps 404 to a readable game-not-found error", async () => {
    const api = createApiClient({ fetch: fakeFetch(404, { error: "no such game" }) });
    const err = await rejection(api.getGame("nope"));
    expect(err.status).toBe(404);
    expect(err.message).toBe("Game not found. Start a new game.");
  });

  it("maps 409 to a readable not-now error that includes the server's reason", async () => {
    const api = createApiClient({ fetch: fakeFetch(409, { error: "bot is thinking" }) });
    const err = await rejection(api.takeback("g1"));
    expect(err.status).toBe(409);
    expect(err.message).toBe("Not possible right now: bot is thinking");
  });

  it("falls back to a generic message when the error body is not an ApiError", async () => {
    const api = createApiClient({
      fetch: (async () => new Response("oops", { status: 500 })) as typeof fetch,
    });
    const err = await rejection(api.resign("g1"));
    expect(err.status).toBe(500);
    expect(err.message).toBe("Server error (500).");
  });

  it("reports a network failure as status 0 with a readable message", async () => {
    const api = createApiClient({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const err = await rejection(api.newGame("w"));
    expect(err.status).toBe(0);
    expect(err.message).toBe("Cannot reach the game server.");
  });
});
