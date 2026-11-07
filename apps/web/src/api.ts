// Typed client for the game API contract (packages/chess-core/src/api.ts). FR-1, FR-4, IR-5.
import type { Color, GameView, NewGameRequest, PlayMoveRequest } from "@chess-tutor/chess-core";

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
    default:
      return `Server error (${status}).`;
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const base = options.baseUrl ?? "/api";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const gameUrl = (id: string) => `${base}/games/${encodeURIComponent(id)}`;

  async function request(url: string, method: "GET" | "POST", body?: unknown): Promise<GameView> {
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
    if (parsed === null) throw new ApiRequestError(response.status, "The server sent an unreadable response.");
    return parsed as GameView;
  }

  return {
    newGame: (playerColor) => request(`${base}/games`, "POST", { playerColor } satisfies NewGameRequest),
    getGame: (id) => request(gameUrl(id), "GET"),
    playMove: (id, uci) => request(`${gameUrl(id)}/moves`, "POST", { uci } satisfies PlayMoveRequest),
    takeback: (id) => request(`${gameUrl(id)}/takeback`, "POST"),
    resign: (id) => request(`${gameUrl(id)}/resign`, "POST"),
    botRetry: (id) => request(`${gameUrl(id)}/bot-retry`, "POST"),
    eventsUrl: (id) => `${gameUrl(id)}/events`,
  };
}
