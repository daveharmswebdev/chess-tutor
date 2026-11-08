import type Anthropic from "@anthropic-ai/sdk";
import type { Analysis } from "@chess-tutor/chess-core";
import type { TutorClient, TutorEngine, TutorExplorer } from "@chess-tutor/tutor";
import { Chess } from "chess.js";
import type { EvalCase } from "../src/types.ts";

/** Engine stub: the first legal move at +20 cp (White's view) for every position. */
export function fakeEngine(): TutorEngine & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async analyze(fen) {
      calls.push(fen);
      const legal = new Chess(fen).moves({ verbose: true });
      const first = legal[0];
      const result: Analysis = {
        fen,
        depth: 10,
        lines: first ? [{ rank: 1, moves: [first.lan], score: { kind: "cp", value: 20 }, depth: 10 }] : [],
        bestMove: first?.lan ?? "",
        timeMs: 1,
      };
      return result;
    },
  };
}

export const fakeExplorer: TutorExplorer = {
  async lookup() {
    return { moves: [], totalGames: 0, opening: null, unavailable: "network" };
  },
};

export interface FakeClientOptions {
  /** Delay per request, to let cases overlap. */
  delayMs?: number;
  /** Throw for a request whose request text contains this FEN. */
  failFen?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * A fake Anthropic client that plays a plausible tutor: round 1 calls analyze_position on the
 * attempt position, round 2 answers with the engine's first move as revealMove. Never calls the API.
 */
export function fakeClient(opts: FakeClientOptions = {}) {
  let active = 0;
  const stats = { requests: 0, maxActive: 0 };
  let id = 0;
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        return {
          async finalMessage(): Promise<Anthropic.Message> {
            stats.requests++;
            active++;
            stats.maxActive = Math.max(stats.maxActive, active);
            try {
              await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
              const first = params.messages.find((m) => m.role === "user")!;
              const requestText = (first.content as Anthropic.TextBlockParam[])[0]!.text;
              if (opts.failFen && requestText.includes(opts.failFen)) throw new Error("Connection error.");
              const data = JSON.parse(requestText.split("\n")[1]!) as { kind?: string; fen: string; attempt_fen?: string };
              const kind = requestText.startsWith("<hint_request>") ? "hint" : data.kind!;
              const attempt = data.attempt_fen ?? data.fen;
              const last = params.messages[params.messages.length - 1]!;
              const toolResult = Array.isArray(last.content)
                ? last.content.find((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result")
                : undefined;
              const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...opts.usage };
              if (!toolResult) {
                return msg([{ type: "tool_use", id: `toolu_${++id}`, name: "analyze_position", input: { fen: attempt } }], "tool_use", usage);
              }
              const result = JSON.parse((toolResult as Anthropic.ToolResultBlockParam).content as string) as { lines: { moves: { uci: string }[] }[] };
              const reply = {
                schemaVersion: 1,
                kind,
                message: "What is your opponent threatening?",
                reveal: "The engine's move.",
                revealMove: result.lines[0]?.moves[0]?.uci ?? null,
                arrows: [],
              };
              return msg([{ type: "text", text: JSON.stringify(reply), citations: null }], "end_turn", usage);
            } finally {
              active--;
            }
          },
        };
      },
    },
  } as unknown as TutorClient;
  return { client, stats };
}

function msg(content: unknown[], stop_reason: string, usage: object): Anthropic.Message {
  return { id: "msg", type: "message", role: "assistant", model: "fake", content, stop_reason, stop_sequence: null, usage } as unknown as Anthropic.Message;
}

function fenAfter(uci: string[]): string {
  const c = new Chess();
  for (const m of uci) c.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
  return c.fen();
}

/** A hint case at the position after `uci` (the engine best is the fake engine's first legal move). */
export function hintCase(id: string, uci: string[]): EvalCase {
  const fen = fenAfter(uci);
  const best = new Chess(fen).moves({ verbose: true })[0]!.lan;
  return { id, kind: "hint", playerColor: new Chess(fen).turn(), history: uci, fen, moment: null, attemptFen: fen, engineBest: best, engineBestCp: 20, source: "test" };
}
