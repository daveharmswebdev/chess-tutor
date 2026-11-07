import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteExplorerCache, type ExplorerResult } from "../src/index.ts";
import { parseExplorerResponse } from "../src/schema.ts";

/**
 * SYNTHETIC fixture: hand-written, NOT recorded from Lichess. Shaped like
 * london-after-bf4.json, for 1.d4 Nf6 2.Bf4 g6 3.e3 Bg7 4.Nf3 d6 5.Be2 (Black to move),
 * with O-O in Lichess's king-takes-rook spelling (e8h8). Counts are invented.
 * The live spelling is still to be confirmed against Lichess (issue #17).
 */
const SYNTHETIC = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "castling-synthetic.json"), "utf8"),
) as { moves: { uci: string; san: string }[] };

function rawWith(moves: { uci: string; san: string }[]) {
  return {
    white: moves.length,
    draws: 0,
    black: 0,
    moves: moves.map((m) => ({ ...m, averageRating: 1500, white: 1, draws: 0, black: 0 })),
    opening: null,
  };
}

function ucis(raw: unknown): string[] {
  const r = parseExplorerResponse(raw);
  if (!r) throw new Error("parse failed");
  return r.moves.map((m) => m.uci);
}

describe("castling UCI normalisation on parse (FR-2, FR-10, #17)", () => {
  it("rewrites O-O e8h8 to e8g8 in the synthetic fixture and leaves other moves alone", () => {
    const r = parseExplorerResponse(SYNTHETIC);
    expect(r?.moves.map((m) => [m.san, m.uci])).toEqual([
      ["O-O", "e8g8"],
      ["c5", "c7c5"],
      ["Nbd7", "b8d7"],
      ["Kf8", "e8f8"],
    ]);
  });

  it.each([
    ["O-O", "e1h1", "e1g1"],
    ["O-O-O", "e1a1", "e1c1"],
    ["O-O", "e8h8", "e8g8"],
    ["O-O-O", "e8a8", "e8c8"],
    ["O-O+", "e1h1", "e1g1"],
    ["O-O-O#", "e8a8", "e8c8"],
  ])("%s %s becomes %s", (san, uci, expected) => {
    expect(ucis(rawWith([{ san, uci }]))).toEqual([expected]);
  });

  it("is idempotent on already-standard castling", () => {
    const standard = {
      ...SYNTHETIC,
      moves: SYNTHETIC.moves.map((m) => (m.san === "O-O" ? { ...m, uci: "e8g8" } : m)),
    };
    expect(ucis(standard)[0]).toBe("e8g8");
    expect(
      ucis(
        rawWith([
          { san: "O-O", uci: "e1g1" },
          { san: "O-O-O", uci: "e1c1" },
          { san: "O-O", uci: "e8g8" },
          { san: "O-O-O", uci: "e8c8" },
        ]),
      ),
    ).toEqual(["e1g1", "e1c1", "e8g8", "e8c8"]);
  });

  it("leaves non-castling king moves and non-king moves untouched", () => {
    expect(
      ucis(
        rawWith([
          { san: "Kf1", uci: "e1f1" },
          { san: "Kxh1", uci: "e1h1" },
          { san: "Rxa8", uci: "e8a8" },
          { san: "Nf3", uci: "g1f3" },
        ]),
      ),
    ).toEqual(["e1f1", "e1h1", "e8a8", "g1f3"]);
  });
});

describe("castling UCI normalisation on cache read (#17)", () => {
  it("serves a pre-fix row stored with e8h8 as e8g8, without a key change", () => {
    const dir = mkdtempSync(join(tmpdir(), "explorer-castling-"));
    try {
      const path = join(dir, "cache.db");
      const cache = createSqliteExplorerCache(path);
      const old: ExplorerResult = {
        moves: [
          { uci: "e8h8", san: "O-O", games: 10, white: 5, draws: 1, black: 4, averageRating: 1400 },
          { uci: "e8f8", san: "Kf8", games: 2, white: 1, draws: 0, black: 1, averageRating: 1100 },
        ],
        totalGames: 12,
        opening: null,
      };
      const raw = new DatabaseSync(path);
      raw
        .prepare("INSERT INTO explorer_cache (key, body, fetched_at) VALUES (?, ?, ?)")
        .run("k", JSON.stringify(old), 0);
      raw.close();
      expect(cache.get("k", 1)?.moves.map((m) => m.uci)).toEqual(["e8g8", "e8f8"]);
      cache.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
