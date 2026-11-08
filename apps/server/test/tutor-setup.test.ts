import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TutorClient, TutorConfig } from "@chess-tutor/tutor";
import { buildServer } from "../src/app.ts";
import { loadAttemptToleranceCp, loadKeyMomentThresholds, loadTutorConfig } from "../src/config.ts";
import { createSqliteGameStore, type GameStore } from "../src/store.ts";
import { NO_KEY_REASON, PLAYER_PROFILE, setupTutor } from "../src/tutor-setup.ts";
import { createBotExplorer, NO_TOKEN_TUTOR_EXPLORER } from "../src/explorer-env.ts";
import { createFakeAnalyzer, createFakeBot } from "./helpers.ts";

const config: TutorConfig = {
  model: "claude-opus-5-5",
  effort: "medium",
  maxToolRounds: 4,
  engine: { depth: 18, movetimeCapMs: 1000, multiPv: 3 },
  explorer: { ratings: [1200], speeds: ["blitz"] },
};

const fakeEngine = { analyze: async () => ({ fen: "", depth: 0, lines: [], bestMove: "", timeMs: 0 }) };
let dir: string;
let clientsMade = 0;
const deps = () => ({
  makeClient: (): TutorClient => {
    clientsMade++;
    return { messages: {} as TutorClient["messages"] };
  },
  explorer: NO_TOKEN_TUTOR_EXPLORER,
  repertoire: null,
  config,
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  clientsMade = 0;
});

function tempPrompt(contents?: string): string {
  dir = mkdtempSync(join(tmpdir(), "chess-tutor-prompt-"));
  const path = join(dir, "tutor-system.v1.md");
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

describe("setupTutor (NFR-9)", () => {
  for (const key of [undefined, "", "   "]) {
    it(`API key ${JSON.stringify(key)}: coaching off with the no-key reason, no client made`, () => {
      const setup = setupTutor({ ...deps(), apiKey: key, promptPath: tempPrompt("prompt") });
      expect(setup).toEqual({ tutor: null, offReason: NO_KEY_REASON });
      expect(NO_KEY_REASON).toBe("Coaching is off: no API key is set.");
      expect(clientsMade).toBe(0);
    });
  }

  it("a missing prompt file: coaching off with a reason naming the file, never a throw", () => {
    const path = tempPrompt();
    const setup = setupTutor({ ...deps(), apiKey: "sk-test-not-real", promptPath: path });
    expect(setup.tutor).toBeNull();
    expect(setup.offReason).toMatch(/^Coaching is off: /);
    expect(setup.offReason).toContain("tutor-system.v1.md");
  });

  it("an empty prompt file is treated as missing", () => {
    const setup = setupTutor({ ...deps(), apiKey: "sk-test-not-real", promptPath: tempPrompt("  \n") });
    expect(setup.tutor).toBeNull();
    expect(setup.offReason).toMatch(/^Coaching is off: /);
  });

  it("key and prompt present: a session factory, one session per call", () => {
    const setup = setupTutor({ ...deps(), apiKey: "sk-test-not-real", promptPath: tempPrompt("You are a tutor.") });
    expect(setup.offReason).toBeNull();
    expect(setup.tutor).not.toBeNull();
    const session = setup.tutor!.createSession({ id: "g1", playerColor: "w", engine: fakeEngine });
    expect(typeof session.ask).toBe("function");
    expect(clientsMade).toBe(1);
    expect(PLAYER_PROFILE).toMatch(/1000/);
    expect(PLAYER_PROFILE).toMatch(/London/);
    expect(PLAYER_PROFILE).toMatch(/King's Indian/);
  });

  it("the server with a missing prompt file still plays, reporting the reason", async () => {
    const setup = setupTutor({ ...deps(), apiKey: "sk-test-not-real", promptPath: tempPrompt() });
    const store: GameStore = createSqliteGameStore(":memory:");
    const { app, games } = buildServer({
      bot: createFakeBot(),
      store,
      logger: false,
      coaching: { analyzer: createFakeAnalyzer(), ...setup },
    });
    try {
      const created = await app.inject({ method: "POST", url: "/api/games", payload: { playerColor: "w" } });
      const id = created.json().id as string;
      expect(created.json().tutor).toEqual({ available: false, reason: setup.offReason, thinking: false, question: null });
      const moved = await app.inject({ method: "POST", url: `/api/games/${id}/moves`, payload: { uci: "d2d4" } });
      expect(moved.statusCode).toBe(200);
      await games.idle(id);
      expect(games.view(id)!.moves).toHaveLength(2);
    } finally {
      await app.close();
      store.close();
    }
  });
});

describe("the tutor's explorer", () => {
  it("without a token: every lookup is unavailable (no network)", async () => {
    const setup = createBotExplorer({ token: "", dbPath: ":memory:", warn: () => {} });
    const result = await setup.tutorExplorer.lookup("fen", { ratings: [1200], speeds: ["blitz"] });
    expect(result).toEqual({ moves: [], totalGames: 0, opening: null, unavailable: "no_token" });
    setup.close();
  });

  it("with a token: the same client as the bot", () => {
    const setup = createBotExplorer({ token: "dummy-not-a-token", dbPath: ":memory:", warn: () => {} });
    expect(setup.tutorExplorer).toBe(setup.explorer);
    setup.close();
  });
});

describe("config/tutor.json coaching settings", () => {
  it("reads thresholds, tolerance and tutor settings", () => {
    expect(loadKeyMomentThresholds()).toEqual({ blunderCp: 150, missedWinCp: 150, punishCp: 150, stillWinningCp: 500 });
    expect(loadAttemptToleranceCp()).toBe(50);
    expect(loadTutorConfig("development")).toEqual({
      model: "claude-opus-5-5",
      effort: "medium",
      maxToolRounds: 4,
      engine: { depth: 18, movetimeCapMs: 1000, multiPv: 3 },
      explorer: { ratings: [1200, 1400], speeds: ["blitz", "rapid"] },
    });
    expect(() => loadTutorConfig("no-such-env")).toThrow(/no-such-env/);
  });
});
