import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSparringBot } from "@chess-tutor/chess-core";
import { defaultRepertoireFiles, loadRepertoire, RepertoireLoadError } from "../src/repertoire.ts";
import { createBotExplorer } from "../src/explorer-env.ts";

const REPO_REPERTOIRE = fileURLToPath(new URL("../../../repertoire/", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "chess-tutor-rep-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadRepertoire", () => {
  it("loads the real London (White) and KID (Black) files", () => {
    const rep = loadRepertoire(defaultRepertoireFiles(REPO_REPERTOIRE));
    expect(rep.continuations([], "w")).not.toBeNull();
    expect(rep.continuations([], "b")).not.toBeNull();
  });

  it("names a missing file", () => {
    withTempDir((dir) => {
      copyFileSync(join(REPO_REPERTOIRE, "london.pgn"), join(dir, "london.pgn"));
      const files = defaultRepertoireFiles(dir);
      expect(() => loadRepertoire(files)).toThrow(RepertoireLoadError);
      expect(() => loadRepertoire(files)).toThrow(/kid\.pgn.*missing/i);
    });
  });

  it("names a file that does not parse (bad PGN or an illegal move)", () => {
    withTempDir((dir) => {
      copyFileSync(join(REPO_REPERTOIRE, "kid.pgn"), join(dir, "kid.pgn"));
      writeFileSync(join(dir, "london.pgn"), '[Line "broken"]\n\n1. d4 (1. e4) d5 *\n');
      expect(() => loadRepertoire(defaultRepertoireFiles(dir))).toThrow(/london\.pgn.*does not parse/i);
      writeFileSync(join(dir, "london.pgn"), '[Line "illegal"]\n\n1. d4 d5 2. Ke4 *\n');
      expect(() => loadRepertoire(defaultRepertoireFiles(dir))).toThrow(/london\.pgn.*does not parse/i);
    });
  });

  it("main exits 1 with a clear message naming the missing file, before starting the engine", () => {
    withTempDir((dir) => {
      copyFileSync(join(REPO_REPERTOIRE, "london.pgn"), join(dir, "london.pgn"));
      const res = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", MAIN],
        {
          env: { ...process.env, PORT: "0", DB_PATH: ":memory:", LICHESS_TOKEN: "", REPERTOIRE_DIR: dir },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/kid\.pgn/);
      expect(res.stderr).toMatch(/repertoire/i);
    });
  }, 30_000);
});

describe("createBotExplorer", () => {
  for (const token of ["", undefined, "   "]) {
    it(`token ${JSON.stringify(token)}: one warning, no-token stub, engine-only bot without throwing`, async () => {
      const warnings: string[] = [];
      const ex = createBotExplorer({ token, dbPath: ":memory:", warn: (m) => warnings.push(m) });
      expect(ex.engineOnly).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/LICHESS_TOKEN/);
      const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      expect(await ex.explorer.lookup(start, { ratings: [1200], speeds: ["blitz"] })).toEqual({
        moves: [],
        totalGames: 0,
        unavailable: "no_token",
      });
      const bot = createSparringBot({
        explorer: ex.explorer,
        engine: { bestMove: async () => "d2d4" },
        config: { explorerRatings: [1200], explorerSpeeds: ["blitz"], minGames: 20, outOfBookElo: 1400 },
      });
      expect(await bot.chooseMove(start)).toMatchObject({ uci: "d2d4", source: "engine", fallbackReason: "unavailable" });
      ex.close();
    });
  }

  it("with a token builds the real client and cache (no lookup made)", () => {
    const warnings: string[] = [];
    const ex = createBotExplorer({ token: "dummy-not-a-token", dbPath: ":memory:", warn: (m) => warnings.push(m) });
    expect(ex.engineOnly).toBe(false);
    expect(warnings).toEqual([]);
    ex.close();
  });
});
