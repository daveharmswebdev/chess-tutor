import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { ServerResponse } from "node:http";
import fastifyStatic from "@fastify/static";
import type { ApiError, GameEvent, SparringBot } from "@chess-tutor/chess-core";
import type { CoachingDeps } from "./coaching.ts";
import { createGameManager, GameError, type GameManager } from "./games.ts";
import type { HealthProbe } from "./health.ts";
import { checkWebDist, isApiPath } from "./static.ts";
import type { GameStore } from "./store.ts";

export type { CoachingDeps } from "./coaching.ts";

export interface ServerDeps {
  bot: SparringBot;
  store: GameStore;
  /** Key-moment detection and the tutor (#7). Without it, GameView.tutor reports coaching off. */
  coaching?: CoachingDeps;
  newId?: () => string;
  now?: () => Date;
  /** Fastify logger option: false in tests, true or pino options in main. */
  logger?: FastifyServerOptions["logger"];
  /** SSE keep-alive comment interval. */
  keepAliveMs?: number;
  /** GET /api/health (NFR-13). Without it, health reports 503 "no health probe configured". */
  health?: HealthProbe;
  /**
   * Absolute directory of the built web app (see resolveWebDist). When set, it is served
   * at / with an SPA fallback to index.html for non-/api GETs. Must hold index.html.
   */
  webDist?: string;
}

const DEFAULT_KEEP_ALIVE_MS = 15_000;

function apiError(message: string): ApiError {
  return { error: message };
}

function sseMessage(event: GameEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * The game API (#6: FR-1, FR-4, FR-5, IR-5; #7: FR-7 to FR-12, NFR-9) over injected
 * dependencies, so tests use a fake bot, analyzer and tutor, and fastify.inject. On close,
 * games still playing are abandoned and saved, tutor asks are aborted, and open event
 * streams are ended. The caller owns bot/engine and store lifetimes.
 */
export function buildServer(deps: ServerDeps): { app: FastifyInstance; games: GameManager } {
  const app = Fastify({ logger: deps.logger ?? false });
  const games = createGameManager({
    bot: deps.bot,
    store: deps.store,
    ...(deps.coaching ? { coaching: deps.coaching } : {}),
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

  // Static web build (architecture §6.1): files at /, index.html for any other non-/api
  // GET or HEAD (SPA fallback). /api/* and other methods keep the JSON 404.
  const webDist = deps.webDist;
  if (webDist !== undefined) {
    checkWebDist(webDist);
    void app.register(fastifyStatic, { root: webDist });
  }

  app.setNotFoundHandler((request, reply) => {
    const method = request.method;
    if (webDist !== undefined && (method === "GET" || method === "HEAD") && !isApiPath(request.url)) {
      return reply.status(200).sendFile("index.html");
    }
    return reply.status(404).send(apiError(`no route ${method} ${request.url}`));
  });

  app.get("/api/health", async (_request, reply) => {
    const status = deps.health ? await deps.health() : { ok: false as const, reason: "no health probe configured" };
    return reply.status(status.ok ? 200 : 503).send(status);
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

  // Tutor (#7, FR-12). The hint reply arrives over SSE; reveal makes no Claude call.
  app.post<{ Params: { id: string } }>("/api/games/:id/tutor/hint", async (request, reply) => {
    games.hint(request.params.id);
    return reply.status(202).send({});
  });

  app.post<{ Params: { id: string } }>("/api/games/:id/tutor/reveal", async (request) => games.reveal(request.params.id));

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
