import type Anthropic from "@anthropic-ai/sdk";
import type { Analysis, Color, KeyMoment, Repertoire } from "@chess-tutor/chess-core";
import type { ExplorerResult, LookupOptions } from "@chess-tutor/explorer";
import { z } from "zod";

/**
 * The tutor package's public contract (#7). Coordinator-owned: change it only on main, before
 * the spokes that depend on it. apps/server uses only what is declared here.
 * Architecture §3.5; requirements FR-8 to FR-12, FR-16 to FR-19, NFR-1, NFR-8.
 */

/**
 * The model's final reply, validated with zod when it arrives (NFR-8). The JSON Schema sent as
 * output_config.format is derived from this, with every object closed (additionalProperties
 * false) and every field required (spike 003). `arrows.max(3)` is checked here, not by the API.
 */
export const TutorReply = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["opponent_left_book", "player_blunder", "missed_win", "punish_opponent", "hint"]),
  /** The Socratic question or explanation shown now (FR-8). */
  message: z.string(),
  /** The full answer; held server-side until "Show me" or a wrong try. */
  reveal: z.string().nullable(),
  /** UCI; must be legal in the attempt position and come from engine output (FR-10). */
  revealMove: z.string().nullable(),
  arrows: z.array(z.object({ from: z.string(), to: z.string() })).max(3),
});
export type TutorReply = z.infer<typeof TutorReply>;

/** What the tutor is asked about. All moves UCI, history from the standard start position. */
export type TutorRequest =
  | {
      kind: "key_moment";
      moment: KeyMoment;
      /** Position after the move that triggered the moment. */
      fen: string;
      /** Where the player's attempt is graded: before the player's move for player_blunder and
       *  missed_win, otherwise `fen`. */
      attemptFen: string;
      history: string[];
    }
  | { kind: "hint"; fen: string; history: string[] };

/** Progress for the browser (NFR-1), e.g. { label: "Checking Nf3…" } from a tool_use block. */
export interface TutorProgress {
  label: string;
}

export type TutorFailureReason =
  | "invalid_reply" // failed validation twice (NFR-8: retry once, then give up)
  | "unsupported_claim" // mentioned a move or evaluation that is illegal or came from no tool result / key-moment data (FR-10)
  | "tool_rounds_exceeded" // more than config.maxToolRounds tool rounds
  | "refusal"
  | "max_tokens"
  | "rate_limited"
  | "api_unavailable" // network, 5xx, overloaded
  | "auth"; // missing or rejected API key: coaching off for the session (NFR-9)

export type TutorOutcome =
  | { ok: true; reply: TutorReply; usage: TutorUsage; ms: number }
  | { ok: false; reason: TutorFailureReason; message: string; usage: TutorUsage; ms: number };

/** Summed over every request in one ask(); feeds the usage ledger (#9). */
export interface TutorUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** One game is one conversation (architecture §3.5): history only grows. */
export interface TutorSession {
  /**
   * Runs the hand-written tool loop for one request. Never throws for API or model failures:
   * they come back as { ok: false }. Calls are serialised per session.
   */
  ask(request: TutorRequest, onProgress: (p: TutorProgress) => void, signal?: AbortSignal): Promise<TutorOutcome>;
}

/** Structural views of the other packages, so tests can pass fakes. */
export interface TutorEngine {
  analyze(fen: string, opts?: { depth?: number; movetimeMs?: number; multiPv?: number }): Promise<Analysis>;
}
export interface TutorExplorer {
  lookup(fen: string, options: LookupOptions): Promise<ExplorerResult>;
}
/** The subset of the Anthropic client the loop uses; tests pass a fake (#7: CI mocks the API). */
export type TutorClient = Pick<Anthropic, "messages">;

export interface TutorConfig {
  /** From config/models.json for the environment, e.g. "claude-opus-5-5". */
  model: string;
  /** config/tutor.json tutor.effort */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** config/tutor.json tutor.maxToolRounds */
  maxToolRounds: number;
  /** config/tutor.json engine settings for analyze_position / evaluate_move. */
  engine: { depth: number; movetimeCapMs: number; multiPv: number };
  /** config/tutor.json bot.explorerRatings / explorerSpeeds. */
  explorer: LookupOptions;
}

export interface TutorDeps {
  client: TutorClient;
  engine: TutorEngine;
  explorer: TutorExplorer;
  repertoire: Repertoire | null;
  config: TutorConfig;
  /** prompts/tutor-system.vN.md contents; the server reads the file. */
  systemPrompt: string;
}

export interface TutorGame {
  playerColor: Color;
  /** Short player profile for the per-game cached system block. */
  playerProfile: string;
}
