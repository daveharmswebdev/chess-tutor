import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis } from "@chess-tutor/chess-core";
import { createWasmEngine } from "@chess-tutor/engine";
import { buildServer } from "../src/app.ts";
import { createHealthProbe, START_FEN, type HealthEngine } from "../src/health.ts";
import { REPO_ROOT, resolveWebDist, WebDistError } from "../src/static.ts";
import { createSqliteGameStore, type GameStore } from "../src/store.ts";
import { createFakeBot } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const INDEX_HTML = "<!doctype html><title>Chess Tutor</title><div id=root></div>";
const APP_JS = "console.log('app');";

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "chess-tutor-dist-"));
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), APP_JS);
  return dir;
}

const ANALYSIS: Analysis = { lines: [{ uci: "e2e4", scoreCp: 20, mate: null, pv: ["e2e4"] }] } as unknown as Analysis;

describe("static web build (NFR-13, #12)", () => {
  let dist: string;
  const stores: GameStore[] = [];
  beforeAll(() => {
    dist = makeDist();
  });
  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
    for (const s of stores) s.close();
  });
  function server(webDist?: string) {
    const store = createSqliteGameStore(":memory:");
    stores.push(store);
    return buildServer({ bot: createFakeBot(), store, logger: false, ...(webDist ? { webDist } : {}) }).app;
  }

  it("serves a real file from WEB_DIST", async () => {
    const app = server(dist);
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(APP_JS);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    await app.close();
  });

  it("serves index.html at /", async () => {
    const app = server(dist);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
    await app.close();
  });

  it("SPA fallback: an unknown non-/api GET returns index.html", async () => {
    const app = server(dist);
    for (const url of ["/games/abc", "/games/abc?x=1", "/assets/missing.js", "/apifoo"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toMatch(/text\/html/);
      expect(res.body, url).toBe(INDEX_HTML);
    }
    await app.close();
  });

  it("an unknown /api GET stays a JSON 404", async () => {
    const app = server(dist);
    for (const url of ["/api/nope", "/api", "/api/", "/api?x=1"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: `no route GET ${url}` });
    }
    await app.close();
  });

  it("a non-GET unknown route stays a JSON 404", async () => {
    const app = server(dist);
    const res = await app.inject({ method: "POST", url: "/games/abc" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no route POST /games/abc" });
    await app.close();
  });

  it("existing API routes are unchanged with WEB_DIST set", async () => {
    const app = server(dist);
    const res = await app.inject({ method: "GET", url: "/api/games/zzz" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no game with id "zzz"' });
    await app.close();
  });

  it("without WEB_DIST, / is a JSON 404 as before", async () => {
    const app = server();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no route GET /" });
    await app.close();
  });

  it("buildServer refuses a webDist without index.html", () => {
    const empty = mkdtempSync(join(tmpdir(), "chess-tutor-empty-"));
    try {
      expect(() => server(empty)).toThrow(WebDistError);
      expect(() => server(join(empty, "nope"))).toThrow(/WEB_DIST/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("resolveWebDist", () => {
  let dist: string;
  beforeAll(() => {
    dist = makeDist();
  });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it("unset or empty means no static serving", () => {
    expect(resolveWebDist(undefined)).toBeNull();
    expect(resolveWebDist("")).toBeNull();
    expect(resolveWebDist("   ")).toBeNull();
  });

  it("an absolute directory is used as is", () => {
    expect(resolveWebDist(dist)).toBe(dist);
  });

  it("a relative path resolves against the repository root, not the cwd", () => {
    expect(REPO_ROOT).toBe(fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""));
    const rel = relative(REPO_ROOT, dist);
    expect(rel.startsWith("/")).toBe(false);
    expect(resolveWebDist(rel)).toBe(dist);
    // A path that exists relative to the repo root (apps/server) but has no index.html.
    expect(() => resolveWebDist("apps/server")).toThrow(/index\.html/);
    expect(() => resolveWebDist("apps/server")).toThrow(join(REPO_ROOT, "apps/server"));
  });

  it("a missing directory fails with a clear error", () => {
    expect(() => resolveWebDist(join(dist, "missing"))).toThrow(WebDistError);
    expect(() => resolveWebDist(join(dist, "missing"))).toThrow(/WEB_DIST.*not a directory/);
  });

  it("a file instead of a directory fails", () => {
    expect(() => resolveWebDist(join(dist, "index.html"))).toThrow(/not a directory/);
  });

  it("main exits 1 at startup when WEB_DIST is missing", () => {
    const res = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", MAIN],
      {
        env: { ...process.env, PORT: "0", DB_PATH: ":memory:", LICHESS_TOKEN: "", WEB_DIST: join(dist, "missing") },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/WEB_DIST/);
    expect(res.stderr).toContain(join(dist, "missing"));
  }, 30_000);
});

describe("GET /api/health (NFR-13, #12)", () => {
  const stores: GameStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) {
      try {
        s.close();
      } catch {
        // already closed by the test
      }
    }
  });
  function setup(engine: HealthEngine, timeoutMs = 5000) {
    const store = createSqliteGameStore(":memory:");
    stores.push(store);
    const health = createHealthProbe({ engine, store, timeoutMs });
    const { app } = buildServer({ bot: createFakeBot(), store, logger: false, health });
    return { app, store };
  }

  it("ready: 200 { ok: true, engine: 'ready' } after a depth-1 search of the start position", async () => {
    const calls: { fen: string; opts: unknown }[] = [];
    const { app } = setup({
      analyze: async (fen, opts) => {
        calls.push({ fen, opts });
        return ANALYSIS;
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, engine: "ready" });
    expect(calls).toEqual([{ fen: START_FEN, opts: { depth: 1 } }]);
    await app.close();
  });

  it("engine error: 503 with a reason", async () => {
    const { app } = setup({ analyze: async () => Promise.reject(new Error("engine exited")) });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: "engine error: engine exited" });
    await app.close();
  });

  it("engine error thrown synchronously: 503", async () => {
    const { app } = setup({
      analyze: () => {
        throw new Error("engine is closed");
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: "engine error: engine is closed" });
    await app.close();
  });

  it("engine slower than the timeout: 503", async () => {
    const { app } = setup({ analyze: () => new Promise<Analysis>(() => {}) }, 30);
    const t0 = performance.now();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: "engine did not answer a depth-1 search within 30 ms" });
    await app.close();
  });

  it("engine answers after the timeout: still 503 for that probe, ready on the next", async () => {
    let release: (() => void) | undefined;
    let first = true;
    const { app } = setup(
      {
        analyze: () => {
          if (!first) return Promise.resolve(ANALYSIS);
          first = false;
          return new Promise<Analysis>((r) => (release = () => r(ANALYSIS)));
        },
      },
      30,
    );
    const slow = await app.inject({ method: "GET", url: "/api/health" });
    expect(slow.statusCode).toBe(503);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    const next = await app.inject({ method: "GET", url: "/api/health" });
    expect(next.statusCode).toBe(200);
    await app.close();
  });

  it("concurrent probes share one engine search", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const { app } = setup({
      analyze: () => {
        calls += 1;
        return new Promise<Analysis>((r) => (release = () => r(ANALYSIS)));
      },
    });
    const a = app.inject({ method: "GET", url: "/api/health" });
    const b = app.inject({ method: "GET", url: "/api/health" });
    await new Promise((r) => setTimeout(r, 20));
    release!();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
    expect(calls).toBe(1);
    await app.close();
  });

  it("a timed-out search still in the queue is not stacked by later probes", async () => {
    let calls = 0;
    const { app } = setup(
      {
        analyze: () => {
          calls += 1;
          return new Promise<Analysis>(() => {});
        },
      },
      20,
    );
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(503);
    }
    expect(calls).toBe(1);
    await app.close();
  });

  it("store closed: 503, and the engine is not asked", async () => {
    let calls = 0;
    const { app, store } = setup({
      analyze: async () => {
        calls += 1;
        return ANALYSIS;
      },
    });
    store.close();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.json().reason).toMatch(/^store not open/);
    expect(calls).toBe(0);
    await app.close();
  });

  it("without a health probe: 503", async () => {
    const store = createSqliteGameStore(":memory:");
    stores.push(store);
    const { app } = buildServer({ bot: createFakeBot(), store, logger: false });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: "no health probe configured" });
    await app.close();
  });

  it("health is not shadowed by the SPA fallback", async () => {
    const dist = makeDist();
    try {
      const store = createSqliteGameStore(":memory:");
      stores.push(store);
      const health = createHealthProbe({ engine: { analyze: async () => ANALYSIS }, store });
      const { app } = buildServer({ bot: createFakeBot(), store, logger: false, health, webDist: dist });
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.json()).toEqual({ ok: true, engine: "ready" });
      await app.close();
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("real WASM Stockfish: ready", async () => {
    const engine = createWasmEngine({ threads: 1 });
    try {
      const { app } = setup(engine);
      const t0 = performance.now();
      const res = await app.inject({ method: "GET", url: "/api/health" });
      const ms = performance.now() - t0;
      expect(res.json()).toEqual({ ok: true, engine: "ready" });
      expect(ms).toBeLessThan(2000);
      await app.close();
    } finally {
      await engine.quit();
    }
  }, 10_000);
});
