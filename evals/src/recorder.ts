import type Anthropic from "@anthropic-ai/sdk";
import type { TutorClient } from "@chess-tutor/tutor";
import type { RecordedRound } from "./types.ts";

/**
 * Wraps the client the tutor session uses so every API round is recorded: stop reason, tool
 * calls, text, usage and time, and (from the next request's tool_result blocks) what each tool
 * answered, and the text of every correction turn (NFR-8) the session sends after a rejected
 * reply. Only `messages.stream(...).finalMessage()` is used by the session (#7).
 */
export function recordingClient(inner: TutorClient, rounds: RecordedRound[], now: () => number = () => performance.now()): TutorClient {
  const stream = (params: Anthropic.MessageCreateParams, options?: unknown) => {
    attachToolResults(params, rounds);
    attachCorrection(params, rounds);
    const started = now();
    const s = (inner.messages.stream as (p: unknown, o?: unknown) => { finalMessage(): Promise<Anthropic.Message> })(params, options);
    return {
      async finalMessage(): Promise<Anthropic.Message> {
        try {
          const m = await s.finalMessage();
          rounds.push({
            ms: Math.round(now() - started),
            stopReason: m.stop_reason ?? null,
            toolUses: m.content
              .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
              .map((b) => ({ id: b.id, name: b.name, input: b.input })),
            toolResults: [],
            text: m.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text)
              .join(""),
            usage: (m.usage as unknown as Record<string, unknown>) ?? null,
            error: null,
            correction: null,
          });
          return m;
        } catch (err) {
          rounds.push({ ms: Math.round(now() - started), stopReason: null, toolUses: [], toolResults: [], text: "", usage: null, error: String(err), correction: null });
          throw err;
        }
      },
    };
  };
  return { messages: { stream } } as unknown as TutorClient;
}

function attachToolResults(params: Anthropic.MessageCreateParams, rounds: RecordedRound[]): void {
  const last = params.messages[params.messages.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return;
  for (const block of last.content) {
    if (block.type !== "tool_result") continue;
    const round = rounds.find((r) => r.toolUses.some((u) => u.id === block.tool_use_id));
    const use = round?.toolUses.find((u) => u.id === block.tool_use_id);
    if (!round || !use || round.toolResults.some((t) => t.id === block.tool_use_id)) continue;
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
    round.toolResults.push({ id: block.tool_use_id, name: use.name, input: use.input, content, isError: block.is_error === true });
  }
}

/** The session's correction turn starts with this (packages/tutor session.ts correction()). */
export const CORRECTION_PREFIX = "Your last reply was not accepted";

/** A user text turn after the last recorded round is the correction for that round's reply. */
function attachCorrection(params: Anthropic.MessageCreateParams, rounds: RecordedRound[]): void {
  const last = params.messages[params.messages.length - 1];
  const round = rounds[rounds.length - 1];
  if (!last || last.role !== "user" || !round || round.correction) return;
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const text = blocks
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (text.startsWith(CORRECTION_PREFIX)) round.correction = text;
}
