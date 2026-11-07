import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteExplorerCache, type ExplorerResult } from "../src/index.ts";

const DAY = 24 * 60 * 60 * 1000;
const RESULT: ExplorerResult = {
  moves: [{ uci: "g7g6", san: "g6", games: 2731659, white: 1280978, draws: 102494, black: 1348187, averageRating: 1434 }],
  totalGames: 9974967,
  opening: { eco: "A45", name: "Indian Defense: Accelerated London System" },
};

const open: { close(): void }[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});
function make(ttlMs?: number) {
  const c = createSqliteExplorerCache(":memory:", ttlMs);
  open.push(c);
  return c;
}

describe("createSqliteExplorerCache", () => {
  it("returns undefined for a missing key and round-trips a stored result", () => {
    const c = make();
    expect(c.get("k", 0)).toBeUndefined();
    c.set("k", RESULT, 1000);
    expect(c.get("k", 1000)).toEqual(RESULT);
  });

  it("expires entries after 30 days by default", () => {
    const c = make();
    c.set("k", RESULT, 0);
    expect(c.get("k", 30 * DAY - 1)).toEqual(RESULT);
    expect(c.get("k", 30 * DAY)).toBeUndefined();
  });

  it("honours a custom ttl and overwrites on set", () => {
    const c = make(1000);
    c.set("k", RESULT, 0);
    expect(c.get("k", 1000)).toBeUndefined();
    const updated = { ...RESULT, totalGames: 1 };
    c.set("k", updated, 1000);
    expect(c.get("k", 1500)).toEqual(updated);
  });

  it("treats a corrupt row (bad JSON or wrong shape) as a miss, and a later set repairs it", () => {
    const dir = mkdtempSync(join(tmpdir(), "explorer-cache-"));
    try {
      const path = join(dir, "cache.db");
      const c = createSqliteExplorerCache(path);
      open.push(c);
      const raw = new DatabaseSync(path);
      const insert = raw.prepare("INSERT OR REPLACE INTO explorer_cache (key, body, fetched_at) VALUES (?, ?, ?)");
      insert.run("bad-json", "{not json", 0);
      insert.run("bad-shape", JSON.stringify({ moves: "nope" }), 0);
      raw.close();
      expect(c.get("bad-json", 1)).toBeUndefined();
      expect(c.get("bad-shape", 1)).toBeUndefined();
      c.set("bad-json", RESULT, 2);
      expect(c.get("bad-json", 3)).toEqual(RESULT);
    } finally {
      for (const c of open.splice(0)) c.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to store an unavailable result", () => {
    const c = make();
    c.set("k", { moves: [], totalGames: 0, opening: null, unavailable: "network" }, 0);
    expect(c.get("k", 0)).toBeUndefined();
  });
});
