import type Anthropic from "@anthropic-ai/sdk";
import type { Analysis, Continuations, Repertoire } from "@chess-tutor/chess-core";
import type { ExplorerResult } from "@chess-tutor/explorer";
import { Chess } from "chess.js";
import type { TutorClient, TutorConfig, TutorDeps, TutorEngine, TutorExplorer } from "../src/contract.ts";

/** FEN after playing UCI moves from the start position. */
export function fenAfter(uci: string[]): string {
  const chess = new Chess();
  for (const m of uci) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), ...(m.length === 5 ? { promotion: m[4] } : {}) });
  return chess.fen();
}

export const CONFIG: TutorConfig = {
  model: "claude-opus-5-5",
  effort: "medium",
  maxToolRounds: 4,
  engine: { depth: 18, movetimeCapMs: 1000, multiPv: 3 },
  explorer: { ratings: [1200, 1400], speeds: ["blitz", "rapid"] },
};

/** A scripted engine: lines per FEN (UCI, White-relative cp); unknown FENs get the first legal move at 0 cp. */
export function fakeEngine(lines: Record<string, { moves: string[]; cp: number }[]> = {}) {
  const calls: { fen: string; opts: unknown }[] = [];
  const engine: TutorEngine = {
    async analyze(fen, opts) {
      calls.push({ fen, opts });
      const scripted = lines[fen];
      const chosen =
        scripted ??
        (() => {
          const legal = new Chess(fen).moves({ verbose: true });
          return legal.length === 0 ? [] : [{ moves: [legal[0]!.lan], cp: 0 }];
        })();
      const result: Analysis = {
        fen,
        depth: 12,
        lines: chosen.map((l, i) => ({ rank: i + 1, moves: l.moves, score: { kind: "cp", value: l.cp }, depth: 12 })),
        bestMove: chosen[0]?.moves[0] ?? "",
        timeMs: 5,
      };
      return result;
    },
  };
  return { engine, calls };
}

export function fakeExplorer(result: ExplorerResult | Error) {
  const calls: { fen: string; options: unknown }[] = [];
  const explorer: TutorExplorer = {
    async lookup(fen, options) {
      calls.push({ fen, options });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { explorer, calls };
}

/** A repertoire whose lines are UCI lists; continuations follow the brief's semantics. */
export function fakeRepertoire(lines: { name: string; color: "w" | "b"; uci: string[] }[]): Repertoire {
  return {
    continuations(history, color): Continuations | null {
      for (const line of lines) {
        if (line.color !== color) continue;
        if (history.length > line.uci.length) continue;
        if (!history.every((m, i) => line.uci[i] === m)) continue;
        const next = line.uci[history.length];
        if (next === undefined) return { line: line.name, moves: [] };
        const san = new Chess(fenAfter(history)).move({ from: next.slice(0, 2), to: next.slice(2, 4) }).san;
        return { line: line.name, moves: [{ uci: next, san }] };
      }
      return null;
    },
  };
}

type Script = Anthropic.Message | Error | ((params: Anthropic.MessageCreateParams) => Anthropic.Message | Error);

export interface RecordedCall {
  params: Anthropic.MessageCreateParams;
  options: { signal?: AbortSignal | null } | undefined;
}

/** A fake Anthropic client: stream(params).finalMessage() returns the next scripted message. */
export function fakeClient(script: Script[], log?: string[]) {
  const calls: RecordedCall[] = [];
  const queue = [...script];
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams, options?: { signal?: AbortSignal | null }) {
        log?.push("stream");
        calls.push({ params: structuredClone(params), options });
        const next = queue.shift();
        return {
          async finalMessage() {
            if (next === undefined) throw new Error("fake client: script exhausted");
            const value = typeof next === "function" ? next(params) : next;
            if (value instanceof Error) throw value;
            return value;
          },
        };
      },
    },
  } as unknown as TutorClient;
  return { client, calls };
}

let idCounter = 0;
function usage(input = 100, output = 50, cacheRead = 0, cacheCreate = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

function message(content: unknown[], stop_reason: string, u = usage()): Anthropic.Message {
  return {
    id: `msg_${++idCounter}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: u,
  } as unknown as Anthropic.Message;
}

export function toolUseMsg(blocks: { name: string; input: Record<string, unknown>; id?: string }[]) {
  return message(
    [
      { type: "thinking", thinking: "Let me check.", signature: "sig" },
      ...blocks.map((b, i) => ({ type: "tool_use", id: b.id ?? `toolu_${idCounter}_${i}`, name: b.name, input: b.input })),
    ],
    "tool_use",
  );
}

/**
 * The model's final reply. An object without an `evals` key gets `evals: []` (the model-facing
 * draft requires it, #26); pass `evals: undefined` to send a reply with the field missing.
 */
export function endTurnMsg(reply: unknown, u?: ReturnType<typeof usage>) {
  const body = reply && typeof reply === "object" && !Array.isArray(reply) && !("evals" in reply) ? { ...reply, evals: [] } : reply;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return message([{ type: "text", text, citations: null }], "end_turn", u);
}

export function stopMsg(stop_reason: string) {
  return message([{ type: "text", text: "", citations: null }], stop_reason);
}

export { usage };

export function deps(over: Partial<TutorDeps> & { client: TutorClient }): TutorDeps {
  return {
    engine: fakeEngine().engine,
    explorer: fakeExplorer({ moves: [], totalGames: 0, opening: null }).explorer,
    repertoire: null,
    config: CONFIG,
    systemPrompt: "SYSTEM PROMPT v1",
    ...over,
  };
}
