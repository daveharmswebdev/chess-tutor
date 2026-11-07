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

  it("refuses to store an unavailable result", () => {
    const c = make();
    c.set("k", { moves: [], totalGames: 0, opening: null, unavailable: "network" }, 0);
    expect(c.get("k", 0)).toBeUndefined();
  });
});
