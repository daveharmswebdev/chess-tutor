import { parseExplorerResponse } from "./schema.ts";
import {
  ExplorerConfigError,
  type ExplorerCache,
  type ExplorerResult,
  type LookupOptions,
  type OutOfBookReason,
} from "./types.ts";

export interface ExplorerClientOptions {
  /** Lichess personal token (no permissions needed). The caller reads it from LICHESS_TOKEN. */
  token: string;
  cache: ExplorerCache;
  /**
   * Injected fetch (tests, proxies). It must honour the AbortSignal it is given: on a
   * timeout the client aborts and moves on to the next queued request, so a fetch that
   * ignores the signal would leave a request running and break one-request-at-a-time.
   */
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-request timeout, covering the response body. Default 1500 ms (NFR-3: bot replies within 2 s). */
  timeoutMs?: number;
  /**
   * After a timeout, network error or 5xx, lookups that need the network return
   * unavailable (same reason) without fetching for this long. Default 30000 ms.
   * A 429 uses Retry-After instead; bad_response starts no cooldown.
   */
  failureCooldownMs?: number;
  /** Default https://explorer.lichess.ovh */
  baseUrl?: string;
  /** How many candidate moves to ask for. Default 12. */
  moves?: number;
}

export interface ExplorerClient {
  lookup(fen: string, options: LookupOptions): Promise<ExplorerResult>;
}

const DEFAULT_BASE_URL = "https://explorer.lichess.ovh";
export const DEFAULT_TIMEOUT_MS = 1500;
export const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;
const DEFAULT_MOVES = 12;
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** Collapse whitespace in a FEN. */
function tidyFen(fen: string): string {
  return fen.trim().split(/\s+/).join(" ");
}

function sortedOptions(o: LookupOptions): { ratings: number[]; speeds: string[] } {
  return {
    ratings: [...new Set(o.ratings)].sort((a, b) => a - b),
    speeds: [...new Set(o.speeds)].sort(),
  };
}

/**
 * Cache key: the first four FEN fields (placement, side, castling, en passant; the move
 * counters don't change explorer statistics) plus sorted ratings and speeds, so option
 * order never matters.
 */
export function cacheKey(fen: string, options: LookupOptions): string {
  const position = tidyFen(fen).split(" ").slice(0, 4).join(" ");
  const { ratings, speeds } = sortedOptions(options);
  return `${position}|${ratings.join(",")}|${speeds.join(",")}`;
}

function outOfBook(reason: OutOfBookReason): ExplorerResult {
  return { moves: [], totalGames: 0, opening: null, unavailable: reason };
}

/** Retry-After is delta-seconds or an HTTP-date. Returns a delay in ms. */
function retryAfterMs(header: string | null, nowMs: number): number {
  if (header === null || header.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const v = header.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // Only something that looks like an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT") is
  // parsed as one; "1.5" or "-5" would otherwise parse as odd dates in the past.
  if (/[a-z]/i.test(v)) {
    const date = Date.parse(v);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

class TimeoutError extends Error {}

type Outcome = { kind: "ok"; result: ExplorerResult } | { kind: "unavailable"; reason: OutOfBookReason; retryAfterMs?: number };

/**
 * Lichess opening-explorer client (FR-2, FR-18, IR-8).
 * One network request at a time; concurrent lookups of the same key share one request.
 * A 401 throws ExplorerConfigError; 429, 5xx, timeouts, network errors and malformed
 * responses resolve to an out-of-book result (unavailable set) and are never cached.
 */
export function createExplorerClient(opts: ExplorerClientOptions): ExplorerClient {
  if (typeof opts.token !== "string" || opts.token.trim() === "") {
    throw new ExplorerConfigError(
      "Lichess explorer token is missing: set LICHESS_TOKEN to a Lichess personal access token (no permissions needed).",
    );
  }
  const token = opts.token.trim();
  const cache = opts.cache;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const movesParam = opts.moves ?? DEFAULT_MOVES;
  const failureCooldownMs = opts.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;

  let queue: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<string, Promise<ExplorerResult>>();
  let cooldownUntil = 0;
  let cooldownReason: OutOfBookReason = "rate_limited";

  /** A cache fault is a local problem, never a reason to fail a lookup: get failing is a miss. */
  function cacheGet(key: string): ExplorerResult | undefined {
    try {
      return cache.get(key, now());
    } catch {
      return undefined;
    }
  }
  /** set failing is ignored: the fetched result is still returned. */
  function cacheSet(key: string, value: ExplorerResult): void {
    try {
      cache.set(key, value, now());
    } catch {
      // ignored on purpose
    }
  }

  async function request(fen: string, options: LookupOptions): Promise<Outcome> {
    const { ratings, speeds } = sortedOptions(options);
    const params = new URLSearchParams({
      fen: tidyFen(fen),
      ratings: ratings.join(","),
      speeds: speeds.join(","),
      moves: String(movesParam),
      topGames: "0",
      recentGames: "0",
    });
    const url = `${baseUrl}/lichess?${params.toString()}`;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError());
      }, timeoutMs);
    });

    const exchange = (async () => {
      const res = await doFetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (res.ok) return { res, body: await res.text() };
      // Release the connection: we never read the body of a non-ok response.
      await res.body?.cancel().catch(() => {});
      return { res, body: undefined };
    })();
    exchange.catch(() => {}); // may settle after the timeout won the race

    let res: Response;
    let body: string | undefined;
    try {
      ({ res, body } = await Promise.race([exchange, timeout]));
    } catch (e) {
      if (e instanceof TimeoutError || controller.signal.aborted) return { kind: "unavailable", reason: "timeout" };
      return { kind: "unavailable", reason: "network" };
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      throw new ExplorerConfigError(
        "Lichess explorer rejected the token (HTTP 401): check that LICHESS_TOKEN holds a valid Lichess personal access token.",
      );
    }
    if (res.status === 429) {
      return { kind: "unavailable", reason: "rate_limited", retryAfterMs: retryAfterMs(res.headers.get("retry-after"), now()) };
    }
    if (res.status >= 500) return { kind: "unavailable", reason: "server_error" };
    if (!res.ok || body === undefined) return { kind: "unavailable", reason: "bad_response" };

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { kind: "unavailable", reason: "bad_response" };
    }
    const result = parseExplorerResponse(json);
    return result ? { kind: "ok", result } : { kind: "unavailable", reason: "bad_response" };
  }

  async function run(key: string, fen: string, options: LookupOptions): Promise<ExplorerResult> {
    const cached = cacheGet(key);
    if (cached) return cached;
    if (now() < cooldownUntil) return outOfBook(cooldownReason);

    const outcome = await request(fen, options);
    if (outcome.kind === "unavailable") {
      const pause =
        outcome.retryAfterMs ?? (outcome.reason === "bad_response" ? undefined : failureCooldownMs);
      if (pause !== undefined) {
        cooldownUntil = now() + pause;
        cooldownReason = outcome.reason;
      }
      return outOfBook(outcome.reason);
    }
    cacheSet(key, outcome.result);
    return outcome.result;
  }

  return {
    lookup(fen, options) {
      // Always a Promise: nothing in here may throw synchronously at the caller.
      let key: string;
      try {
        key = cacheKey(fen, options);
      } catch (e) {
        return Promise.reject(e);
      }
      const cached = cacheGet(key);
      if (cached) return Promise.resolve(cached);
      const existing = inFlight.get(key);
      if (existing) return existing;

      const p = queue.then(() => run(key, fen, options));
      queue = p.catch(() => {});
      inFlight.set(key, p);
      const clear = () => {
        if (inFlight.get(key) === p) inFlight.delete(key);
      };
      p.then(clear, clear);
      return p;
    },
  };
}
