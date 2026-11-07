import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheKey,
  createExplorerClient,
  DEFAULT_TIMEOUT_MS,
  createSqliteExplorerCache,
  ExplorerConfigError,
  type ExplorerCache,
  type LookupOptions,
} from "../src/index.ts";

/**
 * Recorded from spike 002 (docs/spikes/002-lichess-explorer-auth.md). The top-level
 * totals, the g6 row and the opening are verbatim; the other five rows were rebuilt
 * from the spike's share / White-score table so the fixture covers all six moves.
 */
const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "london-after-bf4.json"), "utf8");

/** 1.d4 Nf6 2.Bf4, Black to move. */
const FEN = "rnbqkb1r/pppppppp/5n2/8/3P1B2/8/PPP1PPPP/RN1QKBNR b KQkq - 2 2";
const OTHER_FEN = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const OPTS: LookupOptions = { ratings: [1200, 1400], speeds: ["blitz", "rapid"] };
const TOKEN = "lip_secret-token-xyz";
const DAY = 24 * 60 * 60 * 1000;

interface Call {
  url: URL;
  headers: Headers;
}

type Responder = (call: Call, init: RequestInit | undefined) => Promise<Response> | Response;

function fakeFetch(respond: Responder = () => new Response(FIXTURE, { status: 200 })) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(input)), headers: new Headers(init?.headers) };
    calls.push(call);
    return respond(call, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const open: { close(): void }[] = [];
function memoryCache() {
  const cache = createSqliteExplorerCache(":memory:");
  open.push(cache);
  return cache;
}
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});

function setup(respond?: Responder, extra: { timeoutMs?: number; cache?: ExplorerCache } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const { fetch, calls } = fakeFetch(respond);
  const cache = extra.cache ?? memoryCache();
  const client = createExplorerClient({
    token: TOKEN,
    cache,
    fetch,
    now: () => clock.t,
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
  });
  return { client, calls, clock, cache };
}

describe("parsing", () => {
  it("parses the recorded response into our ExplorerResult, sorted by games", async () => {
    const { client } = setup();
    const r = await client.lookup(FEN, OPTS);
    expect(r.unavailable).toBeUndefined();
    expect(r.totalGames).toBe(4919012 + 375304 + 4680651);
    expect(r.opening).toEqual({ eco: "A45", name: "Indian Defense: Accelerated London System" });
    expect(r.moves.map((m) => m.san)).toEqual(["g6", "d5", "e6", "d6", "c5", "Nc6"]);
    expect(r.moves[0]).toEqual({
      uci: "g7g6",
      san: "g6",
      games: 1280978 + 102494 + 1348187,
      white: 1280978,
      draws: 102494,
      black: 1348187,
      averageRating: 1434,
    });
    // Only our fields survive: no raw Lichess shape leaks out.
    expect(Object.keys(r).sort()).toEqual(["moves", "opening", "totalGames"]);
  });

  it("sorts by games even when Lichess returns another order, and accepts a null opening and extra fields", async () => {
    const raw = JSON.parse(FIXTURE) as { moves: unknown[]; opening: unknown; extra?: unknown };
    raw.moves.reverse();
    raw.opening = null;
    raw.extra = { surprise: true };
    const { client } = setup(() => new Response(JSON.stringify(raw)));
    const r = await client.lookup(FEN, OPTS);
    expect(r.opening).toBeNull();
    const games = r.moves.map((m) => m.games);
    expect(games).toEqual([...games].sort((a, b) => b - a));
    expect(r.moves[0]?.san).toBe("g6");
  });

  it("returns an empty book for a position with no games", async () => {
    const empty = { white: 0, draws: 0, black: 0, moves: [], recentGames: [], topGames: [], opening: null };
    const { client } = setup(() => new Response(JSON.stringify(empty)));
    expect(await client.lookup(FEN, OPTS)).toEqual({ moves: [], totalGames: 0, opening: null });
  });
});

describe("request", () => {
  it("sends fen, sorted ratings and speeds, moves, topGames=0, recentGames=0 and the Bearer token", async () => {
    const { client, calls } = setup();
    await client.lookup(FEN, { ratings: [1400, 1200], speeds: ["rapid", "blitz"] });
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0]!;
    expect(url.origin + url.pathname).toBe("https://explorer.lichess.ovh/lichess");
    expect(url.searchParams.get("fen")).toBe(FEN);
    expect(url.searchParams.get("ratings")).toBe("1200,1400");
    expect(url.searchParams.get("speeds")).toBe("blitz,rapid");
    expect(url.searchParams.get("moves")).toBe("12");
    expect(url.searchParams.get("topGames")).toBe("0");
    expect(url.searchParams.get("recentGames")).toBe("0");
    expect(url.searchParams.has("play")).toBe(false);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("honours the moves and baseUrl options", async () => {
    const { fetch, calls } = fakeFetch();
    const client = createExplorerClient({
      token: TOKEN,
      cache: memoryCache(),
      fetch,
      moves: 6,
      baseUrl: "http://localhost:9999/",
    });
    await client.lookup(FEN, OPTS);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("http://localhost:9999/lichess");
    expect(calls[0]!.url.searchParams.get("moves")).toBe("6");
  });
});

describe("cache", () => {
  it("a cache hit makes no request", async () => {
    const { client, calls } = setup();
    const first = await client.lookup(FEN, OPTS);
    const second = await client.lookup(FEN, OPTS);
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("option order and FEN whitespace or move counters do not change the cache key", async () => {
    const { client, calls } = setup();
    await client.lookup(FEN, OPTS);
    await client.lookup(`  ${FEN.replace(" 2 2", " 0 7")}  `, { ratings: [1400, 1200], speeds: ["rapid", "blitz"] });
    expect(calls).toHaveLength(1);
    expect(cacheKey(FEN, OPTS)).toBe(cacheKey(FEN, { ratings: [1400, 1200], speeds: ["rapid", "blitz"] }));
    expect(cacheKey(FEN, OPTS)).not.toBe(cacheKey(FEN, { ratings: [1200], speeds: ["blitz", "rapid"] }));
    expect(cacheKey(FEN, OPTS)).not.toBe(cacheKey(OTHER_FEN, OPTS));
  });

  it("refetches after 30 days and serves from cache just before", async () => {
    const { client, calls, clock } = setup();
    await client.lookup(FEN, OPTS);
    clock.t += 30 * DAY - 1;
    await client.lookup(FEN, OPTS);
    expect(calls).toHaveLength(1);
    clock.t += 1;
    await client.lookup(FEN, OPTS);
    expect(calls).toHaveLength(2);
    clock.t += 1;
    await client.lookup(FEN, OPTS);
    expect(calls).toHaveLength(2); // the refetch overwrote the expired entry
  });
});

describe("configuration errors", () => {
  it("throws ExplorerConfigError on an empty or blank token at construction", () => {
    for (const token of ["", "   "]) {
      expect(() => createExplorerClient({ token, cache: memoryCache() })).toThrow(ExplorerConfigError);
    }
  });

  it("a 401 throws ExplorerConfigError without the token in the message, and later lookups still run", async () => {
    let status = 401;
    const { client, calls } = setup(() =>
      status === 401 ? new Response("Authorization required", { status: 401 }) : new Response(FIXTURE),
    );
    const err = await client.lookup(FEN, OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExplorerConfigError);
    expect((err as Error).message).toMatch(/401/);
    expect((err as Error).message).toMatch(/LICHESS_TOKEN/);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(String((err as Error).stack)).not.toContain(TOKEN);
    status = 200;
    expect((await client.lookup(FEN, OPTS)).moves).toHaveLength(6);
    expect(calls).toHaveLength(2); // the 401 was not cached
  });
});

describe("out of book", () => {
  const OUT = { moves: [], totalGames: 0, opening: null };

  it("a 429 with Retry-After returns rate_limited and suppresses requests until it expires", async () => {
    let first = true;
    const { client, calls, clock } = setup(() => {
      if (first) {
        first = false;
        return new Response("", { status: 429, headers: { "Retry-After": "120" } });
      }
      return new Response(FIXTURE);
    });
    expect(await client.lookup(FEN, OPTS)).toEqual({ ...OUT, unavailable: "rate_limited" });
    clock.t += 119_999;
    expect(await client.lookup(OTHER_FEN, OPTS)).toEqual({ ...OUT, unavailable: "rate_limited" });
    expect(calls).toHaveLength(1);
    clock.t += 1;
    expect((await client.lookup(FEN, OPTS)).moves).toHaveLength(6);
    expect(calls).toHaveLength(2);
  });

  it("a 429 without Retry-After cools down for 60 s", async () => {
    let first = true;
    const { client, calls, clock } = setup(() => {
      if (first) {
        first = false;
        return new Response("", { status: 429 });
      }
      return new Response(FIXTURE);
    });
    expect((await client.lookup(FEN, OPTS)).unavailable).toBe("rate_limited");
    clock.t += 59_999;
    expect((await client.lookup(FEN, OPTS)).unavailable).toBe("rate_limited");
    expect(calls).toHaveLength(1);
    clock.t += 1;
    expect((await client.lookup(FEN, OPTS)).unavailable).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("a 429 with an HTTP-date Retry-After waits until that date", async () => {
    let first = true;
    const { client, calls, clock } = setup(() => {
      if (first) {
        first = false;
        return new Response("", {
          status: 429,
          headers: { "Retry-After": new Date(clock.t + 10_000).toUTCString() },
        });
      }
      return new Response(FIXTURE);
    });
    expect((await client.lookup(FEN, OPTS)).unavailable).toBe("rate_limited");
    clock.t += 9_000;
    expect((await client.lookup(FEN, OPTS)).unavailable).toBe("rate_limited");
    clock.t += 1_000;
    expect((await client.lookup(FEN, OPTS)).unavailable).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  const cases: [string, Responder, string, number?][] = [
    ["a 500", () => new Response("oops", { status: 500 }), "server_error"],
    ["a 503", () => new Response("", { status: 503 }), "server_error"],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
      "network",
    ],
    ["malformed JSON", () => new Response("{not json"), "bad_response"],
    ["JSON of the wrong shape", () => new Response(JSON.stringify({ moves: "nope" })), "bad_response"],
    ["an unexpected 404", () => new Response("", { status: 404 }), "bad_response"],
    [
      "a timeout (fetch honours the abort signal)",
      (_c, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      "timeout",
      20,
    ],
    ["a timeout (fetch ignores the abort signal)", () => new Promise<Response>(() => {}), "timeout", 20],
  ];

  for (const [name, respond, reason, timeoutMs] of cases) {
    const cools = reason !== "bad_response";
    it(`${name} returns unavailable ${reason}, is not cached, and ${cools ? "starts a 30 s cooldown" : "starts no cooldown"}`, async () => {
      let broken = true;
      const { client, calls, clock } = setup(
        (c, init) => (broken ? respond(c, init) : new Response(FIXTURE)),
        timeoutMs === undefined ? {} : { timeoutMs },
      );
      expect(await client.lookup(FEN, OPTS)).toEqual({ ...OUT, unavailable: reason });
      broken = false;
      if (cools) {
        // Within the cooldown: another uncached lookup gets the same reason without fetching.
        clock.t += 29_999;
        expect(await client.lookup(OTHER_FEN, OPTS)).toEqual({ ...OUT, unavailable: reason });
        expect(calls).toHaveLength(1);
        clock.t += 1;
      }
      const r = await client.lookup(FEN, OPTS);
      expect(r.unavailable).toBeUndefined();
      expect(r.moves).toHaveLength(6);
      expect(calls).toHaveLength(2);
    });
  }

  it("the failure cooldown is configurable through failureCooldownMs", async () => {
    let broken = true;
    const clock = { t: 0 };
    const { fetch, calls } = fakeFetch(() => (broken ? new Response("", { status: 502 }) : new Response(FIXTURE)));
    const client = createExplorerClient({ token: TOKEN, cache: memoryCache(), fetch, now: () => clock.t, failureCooldownMs: 5_000 });
    expect((await client.lookup(FEN, OPTS)).unavailable).toBe("server_error");
    broken = false;
    clock.t = 4_999;
    expect((await client.lookup(FEN, OPTS)).unavailable).toBe("server_error");
    clock.t = 5_000;
    expect((await client.lookup(FEN, OPTS)).unavailable).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("cache hits are still served during a cooldown", async () => {
    let broken = false;
    const { client, calls } = setup(() => (broken ? new Response("", { status: 500 }) : new Response(FIXTURE)));
    await client.lookup(FEN, OPTS);
    broken = true;
    expect((await client.lookup(OTHER_FEN, OPTS)).unavailable).toBe("server_error");
    expect((await client.lookup(FEN, OPTS)).moves).toHaveLength(6);
    expect(calls).toHaveLength(2);
  });

  for (const header of ["1.5", "-5"]) {
    it(`a 429 with an unparseable Retry-After "${header}" falls back to 60 s`, async () => {
      let first = true;
      const { client, calls, clock } = setup(() => {
        if (first) {
          first = false;
          return new Response("", { status: 429, headers: { "Retry-After": header } });
        }
        return new Response(FIXTURE);
      });
      expect((await client.lookup(FEN, OPTS)).unavailable).toBe("rate_limited");
      clock.t += 59_999;
      expect((await client.lookup(FEN, OPTS)).unavailable).toBe("rate_limited");
      expect(calls).toHaveLength(1);
      clock.t += 1;
      expect((await client.lookup(FEN, OPTS)).unavailable).toBeUndefined();
    });
  }

  for (const status of [401, 404, 429, 500]) {
    it(`cancels the body of a ${status} response`, async () => {
      let cancelled = false;
      const body = new ReadableStream({
        pull() {},
        cancel() {
          cancelled = true;
        },
      });
      const { client } = setup(() => new Response(body, { status }));
      await client.lookup(FEN, OPTS).catch(() => undefined);
      expect(cancelled).toBe(true);
    });
  }

  it("parses a response with the opening field missing (not null) as opening null", async () => {
    const raw = JSON.parse(FIXTURE) as Record<string, unknown>;
    delete raw["opening"];
    const { client } = setup(() => new Response(JSON.stringify(raw)));
    const r = await client.lookup(FEN, OPTS);
    expect(r.opening).toBeNull();
    expect(r.moves).toHaveLength(6);
  });
});

describe("default timeout (NFR-3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is 1500 ms", async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(1500);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch } = fakeFetch(() => new Promise<Response>(() => {}));
    const client = createExplorerClient({ token: TOKEN, cache: memoryCache(), fetch });
    let result: unknown;
    void client.lookup(FEN, OPTS).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(1499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ moves: [], totalGames: 0, opening: null, unavailable: "timeout" });
  });
});

describe("a faulty cache never breaks a lookup", () => {
  const throwing: ExplorerCache = {
    get() {
      throw new Error("disk I/O error");
    },
    set() {
      throw new Error("database is locked");
    },
  };

  it("lookup returns a promise, treats a get failure as a miss and ignores a set failure", async () => {
    const { client, calls } = setup(undefined, { cache: throwing });
    let p: Promise<unknown> | undefined;
    expect(() => {
      p = client.lookup(FEN, OPTS);
    }).not.toThrow();
    expect(p).toBeInstanceOf(Promise);
    const r = (await p) as { moves: unknown[]; unavailable?: string };
    expect(r.unavailable).toBeUndefined();
    expect(r.moves).toHaveLength(6);
    expect(calls).toHaveLength(1);
  });
});

describe("same-key waiters on a failing request", () => {
  const failures: [string, Responder, string, number, number?][] = [
    ["429", () => new Response("", { status: 429, headers: { "Retry-After": "10" } }), "rate_limited", 10_000],
    [
      "timeout",
      (_c, init) =>
        new Promise<Response>((_r, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      "timeout",
      30_000,
      20,
    ],
  ];
  for (const [name, respond, reason, cooldown, timeoutMs] of failures) {
    it(`all waiters get unavailable ${reason} on a ${name}, and can refetch after the cooldown`, async () => {
      let broken = true;
      const { client, calls, clock } = setup(
        (c, init) => (broken ? respond(c, init) : new Response(FIXTURE)),
        timeoutMs === undefined ? {} : { timeoutMs },
      );
      const results = await Promise.all([
        client.lookup(FEN, OPTS),
        client.lookup(FEN, OPTS),
        client.lookup(FEN, { ratings: [1400, 1200], speeds: ["rapid", "blitz"] }),
      ]);
      for (const r of results) expect(r).toEqual({ moves: [], totalGames: 0, opening: null, unavailable: reason });
      expect(calls).toHaveLength(1);
      broken = false;
      clock.t += cooldown;
      const after = await client.lookup(FEN, OPTS);
      expect(after.moves).toHaveLength(6);
      expect(calls).toHaveLength(2);
    });
  }
});

describe("one request at a time", () => {
  it("serialises concurrent lookups and deduplicates the same key", async () => {
    let active = 0;
    let maxActive = 0;
    const pending: (() => void)[] = [];
    const { client, calls } = setup(
      () =>
        new Promise<Response>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          pending.push(() => {
            active--;
            resolve(new Response(FIXTURE));
          });
        }),
    );
    const a1 = client.lookup(FEN, OPTS);
    const a2 = client.lookup(FEN, { ratings: [1400, 1200], speeds: ["rapid", "blitz"] });
    const b = client.lookup(OTHER_FEN, OPTS);

    // Drain: release whichever request is in flight until all three settle.
    const all = Promise.all([a1, a2, b]);
    let settled = false;
    void all.then(() => (settled = true));
    while (!settled) {
      await new Promise((r) => setTimeout(r, 0));
      pending.shift()?.();
    }
    const [r1, r2, r3] = await all;
    expect(maxActive).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url.searchParams.get("fen"))).toEqual([FEN, OTHER_FEN]);
    expect(r1).toEqual(r2);
    expect(r3.moves).toHaveLength(6);
  });

  it("a failed lookup does not block the queue", async () => {
    let n = 0;
    const { client, calls } = setup(() => {
      n++;
      if (n === 1) return new Response("", { status: 401 });
      return new Response(FIXTURE);
    });
    const failing = client.lookup(FEN, OPTS);
    const next = client.lookup(OTHER_FEN, OPTS);
    await expect(failing).rejects.toBeInstanceOf(ExplorerConfigError);
    expect((await next).moves).toHaveLength(6);
    expect(calls).toHaveLength(2);
  });
});
