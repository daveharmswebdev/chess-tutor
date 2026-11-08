import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Color, Repertoire } from "@chess-tutor/chess-core";
import {
  createTutorSession,
  type TutorClient,
  type TutorConfig,
  type TutorEngine,
  type TutorExplorer,
  type TutorSession,
} from "@chess-tutor/tutor";

/** NFR-9: shown in GameView.tutor.reason when ANTHROPIC_API_KEY is not set. */
export const NO_KEY_REASON = "Coaching is off: no API key is set.";

/** The short per-game player profile for the tutor's cached system block. */
export const PLAYER_PROFILE =
  "Rated around 1000 on Chess.com. Plays the London System as White and the King's Indian Defence as Black.";

/** Makes one TutorSession per game (one game is one conversation, architecture §3.5). */
export interface TutorFactory {
  /**
   * engine: the server's per-game wrapper around the shared Stockfish, which lets the bot go
   * first and drops a cancelled ask's waiting searches (NFR-3).
   */
  createSession(game: { id: string; playerColor: Color; engine: TutorEngine }): TutorSession;
}

export interface TutorSetup {
  /** null when coaching is off; offReason then says why. */
  tutor: TutorFactory | null;
  offReason: string | null;
}

export interface TutorSetupOptions {
  /** ANTHROPIC_API_KEY. Only checked for presence; never logged or stored. */
  apiKey: string | undefined;
  /** The system prompt file (prompts/tutor-system.vN.md). */
  promptPath: string;
  /** Called once, only when a key and the prompt are present (main: `new Anthropic()`). */
  makeClient: () => TutorClient;
  explorer: TutorExplorer;
  repertoire: Repertoire | null;
  config: TutorConfig;
}

/**
 * Decides whether coaching is on (NFR-9) and builds the session factory. Never throws:
 * a missing key or prompt file turns coaching off with a plain reason, and the game works.
 */
export function setupTutor(opts: TutorSetupOptions): TutorSetup {
  if (opts.apiKey === undefined || opts.apiKey.trim() === "") return { tutor: null, offReason: NO_KEY_REASON };
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(opts.promptPath, "utf8");
  } catch {
    return { tutor: null, offReason: `Coaching is off: the tutor prompt file ${basename(opts.promptPath)} is missing.` };
  }
  if (systemPrompt.trim() === "") {
    return { tutor: null, offReason: `Coaching is off: the tutor prompt file ${basename(opts.promptPath)} is empty.` };
  }
  const client = opts.makeClient();
  const shared = {
    client,
    explorer: opts.explorer,
    repertoire: opts.repertoire,
    config: opts.config,
    systemPrompt,
  };
  return {
    tutor: {
      createSession: (game) =>
        createTutorSession({ ...shared, engine: game.engine }, { playerColor: game.playerColor, playerProfile: PLAYER_PROFILE }),
    },
    offReason: null,
  };
}
