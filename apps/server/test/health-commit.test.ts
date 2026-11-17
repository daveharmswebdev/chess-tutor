import { afterEach, describe, expect, it } from "vitest";
import type { Analysis } from "@chess-tutor/chess-core";
import { buildServer } from "../src/app.ts";
import { createHealthProbe, type HealthEngine } from "../src/health.ts";
import { createSqliteGameStore, type GameStore } from "../src/store.ts";
import { createFakeBot } from "./helpers.ts";

// The probe only awaits the search; the value is never read.
const ANALYSIS = {} as Analysis;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ready: HealthEngine = { analyze: async () => ANALYSIS };
const hung: HealthEngine = { analyze: () => new Promise<Analysis>(() => {}) };

describe("GET /api/health reports the running commit (FR-26, #58)", () => {
  const stores: GameStore[] = [];
  const savedEnv = process.env.RENDER_GIT_COMMIT;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = savedEnv;
    for (const s of stores.splice(0)) {
      try {
        s.close();
      } catch {
        // already closed by the test
      }
    }
  });
  function store(): GameStore {
    const s = createSqliteGameStore(":memory:");
    stores.push(s);
    return s;
  }

  it("commit dep given: the ok response carries it", async () => {
    const probe = createHealthProbe({ engine: ready, store: store(), commit: SHA });
    expect(await probe()).toEqual({ ok: true, engine: "ready", commit: SHA });
  });

  it("commit dep null: commit is null, even when the env var is set", async () => {
    process.env.RENDER_GIT_COMMIT = SHA;
    const probe = createHealthProbe({ engine: ready, store: store(), commit: null });
    expect(await probe()).toEqual({ ok: true, engine: "ready", commit: null });
  });

  it("dep absent: reads RENDER_GIT_COMMIT, trimmed, not shortened", async () => {
    process.env.RENDER_GIT_COMMIT = `  ${SHA}\n`;
    const probe = createHealthProbe({ engine: ready, store: store() });
    expect(await probe()).toEqual({ ok: true, engine: "ready", commit: SHA });
  });

  it("dep absent, env unset: commit null", async () => {
    delete process.env.RENDER_GIT_COMMIT;
    const probe = createHealthProbe({ engine: ready, store: store() });
    expect(await probe()).toEqual({ ok: true, engine: "ready", commit: null });
  });

  it("dep absent, env empty or whitespace: commit null", async () => {
    for (const blank of ["", "   ", "\n\t"]) {
      process.env.RENDER_GIT_COMMIT = blank;
      const probe = createHealthProbe({ engine: ready, store: store() });
      expect(await probe()).toEqual({ ok: true, engine: "ready", commit: null });
    }
  });

  it("env is read once when the probe is created, not per request", async () => {
    process.env.RENDER_GIT_COMMIT = SHA;
    const probe = createHealthProbe({ engine: ready, store: store() });
    process.env.RENDER_GIT_COMMIT = "changed-later";
    expect(await probe()).toMatchObject({ commit: SHA });
  });

  it("unhealthy (engine timeout) response carries commit", async () => {
    const probe = createHealthProbe({ engine: hung, store: store(), commit: SHA, timeoutMs: 20 });
    expect(await probe()).toEqual({
      ok: false,
      reason: "engine did not answer a depth-1 search within 20 ms",
      commit: SHA,
    });
  });

  it("unhealthy (engine error) response carries commit", async () => {
    const engine: HealthEngine = { analyze: async () => Promise.reject(new Error("engine exited")) };
    const probe = createHealthProbe({ engine, store: store(), commit: SHA });
    expect(await probe()).toEqual({ ok: false, reason: "engine error: engine exited", commit: SHA });
  });

  it("unhealthy (store closed) response carries commit, and the engine is not asked", async () => {
    let calls = 0;
    const s = store();
    const probe = createHealthProbe({
      engine: {
        analyze: async () => {
          calls += 1;
          return ANALYSIS;
        },
      },
      store: s,
      commit: null,
    });
    s.close();
    const status = await probe();
    expect(status).toMatchObject({ ok: false, commit: null });
    expect(calls).toBe(0);
  });

  it("HTTP 200 body includes commit", async () => {
    const s = store();
    const health = createHealthProbe({ engine: ready, store: s, commit: SHA });
    const { app } = buildServer({ bot: createFakeBot(), store: s, logger: false, health });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, engine: "ready", commit: SHA });
    await app.close();
  });

  it("HTTP 503 body includes commit", async () => {
    const s = store();
    const health = createHealthProbe({ engine: hung, store: s, commit: SHA, timeoutMs: 20 });
    const { app } = buildServer({ bot: createFakeBot(), store: s, logger: false, health });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ok: false,
      reason: "engine did not answer a depth-1 search within 20 ms",
      commit: SHA,
    });
    await app.close();
  });

  it("HTTP 503 body with no commit known says null", async () => {
    const s = store();
    const health = createHealthProbe({ engine: hung, store: s, commit: null, timeoutMs: 20 });
    const { app } = buildServer({ bot: createFakeBot(), store: s, logger: false, health });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, commit: null });
    await app.close();
  });
});
