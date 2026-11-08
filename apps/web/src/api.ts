// Typed client for the game API contract (packages/chess-core/src/api.ts). FR-1, FR-4, IR-5.
// Tutor endpoints (#7: FR-11, FR-12): POST /tutor/hint (202 {}) and POST /tutor/reveal (200 TutorReveal).
import type { Color, GameView, NewGameRequest, PlayMoveRequest } from "@chess-tutor/chess-core";
import type { TutorReveal } from "./tutor-types.ts";

/** A failed API request. `status` is the HTTP status, or 0 when the server could not be reached. */
export class ApiRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export interface ApiClient {
  newGame(playerColor: Color): Promise<GameView>;
  getGame(id: string): Promise<GameView>;
  playMove(id: string, uci: string): Promise<GameView>;
  takeback(id: string): Promise<GameView>;
  resign(id: string): Promise<GameView>;
  /** Asks the bot to try its move again after a failure (#23). */
  botRetry(id: string): Promise<GameView>;
  /** Asks the tutor for a hint (202); the reply arrives over SSE (FR-12). */
  tutorHint(id: string): Promise<void>;
  /** "Show me": the reveal for the open question (FR-11). */
  tutorReveal(id: string): Promise<TutorReveal>;
  eventsUrl(id: string): string;
}

export interface ApiClientOptions {
  /** Defaults to "/api" (vite proxies it to apps/server). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

function serverReason(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim() !== "") return error;
  }
  return null;
}

/** Turns an HTTP status and ApiError body into a message fit for the status line. */
export function readableError(status: number, body: unknown): string {
  const reason = serverReason(body);
  switch (status) {
    case 400:
      return reason ? `That move was not accepted: ${reason}` : "That move was not accepted.";
    case 404:
      return "Game not found. Start a new game.";
    case 409:
      return reason ? `Not possible right now: ${reason}` : "Not possible right now.";
    case 503:
      return reason ? `Coaching is not available right now: ${reason}` : "Coaching is not available right now.";
    default:
      return `Server error (${status}).`;
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const base = options.baseUrl ?? "/api";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const gameUrl = (id: string) => `${base}/games/${encodeURIComponent(id)}`;

  /** Sends the request; resolves with the parsed body (null when empty or not JSON). */
  async function send(url: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; parsed: unknown }> {
    let response: Response;
    try {
      const init: RequestInit = { method, headers: { accept: "application/json" } };
      if (body !== undefined) {
        init.headers = { accept: "application/json", "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      response = await doFetch(url, init);
    } catch {
      throw new ApiRequestError(0, "Cannot reach the game server.");
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) throw new ApiRequestError(response.status, readableError(response.status, parsed));
    return { status: response.status, parsed };
  }

  async function request<T>(url: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const { status, parsed } = await send(url, method, body);
    if (parsed === null) throw new ApiRequestError(status, "The server sent an unreadable response.");
    return parsed as T;
  }

  return {
    newGame: (playerColor) => request<GameView>(`${base}/games`, "POST", { playerColor } satisfies NewGameRequest),
    getGame: (id) => request<GameView>(gameUrl(id), "GET"),
    playMove: (id, uci) => request<GameView>(`${gameUrl(id)}/moves`, "POST", { uci } satisfies PlayMoveRequest),
    takeback: (id) => request<GameView>(`${gameUrl(id)}/takeback`, "POST"),
    resign: (id) => request<GameView>(`${gameUrl(id)}/resign`, "POST"),
    botRetry: (id) => request<GameView>(`${gameUrl(id)}/bot-retry`, "POST"),
    tutorHint: async (id) => {
      await send(`${gameUrl(id)}/tutor/hint`, "POST");
    },
    tutorReveal: (id) => request<TutorReveal>(`${gameUrl(id)}/tutor/reveal`, "POST"),
    eventsUrl: (id) => `${gameUrl(id)}/events`,
  };
}
