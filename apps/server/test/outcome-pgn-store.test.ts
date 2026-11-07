import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameView } from "@chess-tutor/chess-core";
import { outcomeOf } from "../src/outcome.ts";
import { toPgn } from "../src/pgn.ts";
import { createSqliteGameStore, resolveDbPath } from "../src/store.ts";

describe("outcomeOf", () => {
  const cases: [string, string, ReturnType<typeof outcomeOf>][] = [
    ["start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", null],
    ["white mated", "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", { result: "0-1", endReason: "checkmate" }],
    ["black mated", "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4", { result: "1-0", endReason: "checkmate" }],
    ["stalemate", "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", { result: "1/2-1/2", endReason: "stalemate" }],
    ["insufficient material", "8/8/4k3/8/8/4K3/8/8 w - - 0 1", { result: "1/2-1/2", endReason: "insufficient_material" }],
    ["fifty moves", "8/8/4k3/8/8/4K3/4R3/8 w - - 100 80", { result: "1/2-1/2", endReason: "fifty_moves" }],
  ];
  for (const [name, fen, expected] of cases) {
    it(name, () => expect(outcomeOf(new Chess(fen))).toEqual(expected));
  }
});

function view(over: Partial<GameView>): GameView {
  return {
    id: "g1",
    playerColor: "w",
    fen: "",
    moves: [
      { uci: "e2e4", san: "e4", by: "player" },
      { uci: "e7e5", san: "e5", by: "bot" },
    ],
    status: "finished",
    result: "0-1",
    endReason: "resigned",
    botThinking: false,
    ...over,
  };
}

describe("toPgn", () => {
  it("writes the Seven Tag Roster with names by colour, Result and Termination", () => {
    const pgn = toPgn(view({ playerColor: "b", result: "1-0" }), new Date("2026-11-07T12:00:00Z"));
    const tags = [...pgn.matchAll(/^\[(\w+) "([^"]*)"\]$/gm)].map((m) => [m[1], m[2]]);
    expect(tags).toEqual([
      ["Event", "Sparring game"],
      ["Site", "Chess Tutor"],
      ["Date", "2026.11.07"],
      ["Round", "-"],
      ["White", "Sparring bot"],
      ["Black", "Player"],
      ["Result", "1-0"],
      ["Termination", "resigned"],
    ]);
    expect(pgn).toMatch(/\n\n1\. e4 e5 1-0\s*$/);
  });

  it("round-trips through chess.js", () => {
    const pgn = toPgn(view({ status: "abandoned", result: "*", endReason: "abandoned" }), new Date());
    const chess = new Chess();
    chess.loadPgn(pgn);
    expect(chess.history()).toEqual(["e4", "e5"]);
    expect(chess.getHeaders()["Result"]).toBe("*");
  });
});

describe("game store", () => {
  it("saves (upsert) and reads back a game", () => {
    const store = createSqliteGameStore(":memory:");
    const rec = {
      id: "g1",
      playerColor: "w" as const,
      status: "abandoned" as const,
      result: "*" as const,
      endReason: "abandoned" as const,
      pgn: "pgn-1",
      createdAt: "2026-11-07T10:00:00.000Z",
      updatedAt: "2026-11-07T10:05:00.000Z",
    };
    store.save(rec);
    store.save({ ...rec, pgn: "pgn-2", updatedAt: "2026-11-07T10:06:00.000Z" });
    expect(store.get("g1")).toEqual({ ...rec, pgn: "pgn-2", updatedAt: "2026-11-07T10:06:00.000Z" });
    expect(store.get("nope")).toBeUndefined();
    store.close();
  });

  it("creates the database directory for a file path and reopens an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "chess-tutor-store-"));
    try {
      const path = join(dir, "nested", "games.sqlite");
      const store = createSqliteGameStore(path);
      store.save({
        id: "g1",
        playerColor: "b",
        status: "finished",
        result: "1-0",
        endReason: "resigned",
        pgn: "x",
        createdAt: "a",
        updatedAt: "b",
      });
      store.close();
      const again = createSqliteGameStore(path);
      expect(again.get("g1")?.result).toBe("1-0");
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves DB_PATH, defaulting to data/chess-tutor.sqlite at the repo root", () => {
    expect(resolveDbPath({ DB_PATH: ":memory:" })).toBe(":memory:");
    expect(resolveDbPath({})).toMatch(/[/\\]data[/\\]chess-tutor\.sqlite$/);
    expect(resolveDbPath({ DB_PATH: "" })).toMatch(/[/\\]data[/\\]chess-tutor\.sqlite$/);
  });
});
