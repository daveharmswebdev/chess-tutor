import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { ServerResponse } from "node:http";
import type { ApiError, GameEvent, SparringBot } from "@chess-tutor/chess-core";
import { createGameManager, GameError, type GameManager } from "./games.ts";
import type { GameStore } from "./store.ts";

export interface ServerDeps {
  bot: SparringBot;
  store: GameStore;
  newId?: () => string;
  now?: () => Date;
  /** Fastify logger option: false in tests, true or pino options in main. */
  logger?: FastifyServerOptions["logger"];
  /** SSE keep-alive comment interval. */
  keepAliveMs?: number;
}

const DEFAULT_KEEP_ALIVE_MS = 15_000;

function apiError(message: string): ApiError {
  return { error: message };
}

function sseMessage(event: GameEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The game API (#6: FR-1, FR-4, FR-5, IR-5) over injected dependencies, so tests use a
 * fake bot and fastify.inject. On close, games still playing are abandoned and saved and
 * open event streams are ended. The caller owns bot/engine and store lifetimes.
 */
export function buildServer(deps: ServerDeps): { app: FastifyInstance; games: GameManager } {
  const app = Fastify({ logger: deps.logger ?? false });
  const games = createGameManager({
    bot: deps.bot,
    store: deps.store,
    ...(deps.newId ? { newId: deps.newId } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    log: app.log,
  });
  const streams = new Set<ServerResponse>();

  // Accept an empty JSON body (e.g. POST /takeback sent with a JSON content type).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = String(body);
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("request body is not valid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    if (err instanceof GameError) return reply.status(err.statusCode).send(apiError(err.message));
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, "request failed");
      return reply.status(500).send(apiError("internal server error"));
    }
    return reply.status(status).send(apiError(err.message));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(apiError(`no route ${request.method} ${request.url}`));
  });

  app.post("/api/games", async (request, reply) => {
    const body = request.body as { playerColor?: unknown } | undefined;
    const color = body?.playerColor;
    if (color !== "w" && color !== "b") {
      throw new GameError(400, 'playerColor must be "w" or "b"');
    }
    return reply.status(201).send(games.create(color));
  });

  app.get<{ Params: { id: string } }>("/api/games/:id", async (request) => {
    const view = games.view(request.params.id);
    if (!view) throw new GameError(404, `no game with id "${request.params.id}"`);
    return view;
  });

  app.post<{ Params: { id: string } }>("/api/games/:id/moves", async (request) => {
    const { id } = request.params;
    if (!games.view(id)) throw new GameError(404, `no game with id "${id}"`);
    const uci = (request.body as { uci?: unknown } | undefined)?.uci;
    if (typeof uci !== "string") throw new GameError(400, "uci must be a string such as \"e2e4\"");
    return games.play(id, uci);
  });

  app.post<{ Params: { id: string } }>("/api/games/:id/takeback", async (request) => games.takeback(request.params.id));

  app.post<{ Params: { id: string } }>("/api/games/:id/bot-retry", async (request) => games.botRetry(request.params.id));

  app.post<{ Params: { id: string } }>("/api/games/:id/resign", async (request) => games.resign(request.params.id));

  app.get<{ Params: { id: string } }>("/api/games/:id/events", (request, reply) => {
    const { id } = request.params;
    const view = games.view(id);
    if (!view) {
      reply.status(404).send(apiError(`no game with id "${id}"`));
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(sseMessage({ type: "state", game: view }));
    const unsubscribe = games.subscribe(id, (event) => res.write(sseMessage(event)));
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), deps.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
    streams.add(res);
    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
      streams.delete(res);
    };
    request.raw.on("close", cleanup);
    res.on("close", cleanup);
  });

  // Before the server stops accepting: abandon and save live games (FR-5), tell open
  // streams (game_over), then end them so close() does not wait on them.
  app.addHook("preClose", async () => {
    games.abandonAll();
    for (const res of streams) res.end();
    streams.clear();
  });

  return { app, games };
}
