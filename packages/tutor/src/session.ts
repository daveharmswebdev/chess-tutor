import type Anthropic from "@anthropic-ai/sdk";
import { checkClaims } from "./claims.ts";
import type {
  TutorDeps,
  TutorFailureReason,
  TutorGame,
  TutorOutcome,
  TutorProgress,
  TutorReply,
  TutorRequest,
  TutorSession,
  TutorUsage,
} from "./contract.ts";
import { classifyError } from "./errors.ts";
import { Evidence } from "./evidence.ts";
import { buildEvidence, playerBlock, requestTurn } from "./request.ts";
import { TUTOR_REPLY_JSON_SCHEMA, parseReply } from "./schema.ts";
import { TOOL_DEFINITIONS, runTool, toolLabel, type ToolContext } from "./tools.ts";

/** Room for adaptive thinking plus a short JSON reply. Not in config/tutor.json (see the #7 return). */
export const MAX_TOKENS = 16000;

export const FIRST_PROGRESS = "Tutor is looking at the position…";

const FAILURE_MESSAGES: Record<TutorFailureReason, string> = {
  invalid_reply: "The tutor's reply could not be read, even after one retry.",
  unsupported_claim: "The tutor mentioned a move that the engine or the game data did not give it.",
  tool_rounds_exceeded: "The tutor needed too many tool calls for this position.",
  refusal: "The tutor declined to answer.",
  max_tokens: "The tutor's reply was cut off.",
  rate_limited: "The tutor is rate limited; try again in a moment.",
  api_unavailable: "The tutor could not reach the Claude API.",
  auth: "The Claude API key is missing or was rejected; coaching is off for this session.",
};

/**
 * One game, one conversation (architecture §3.5). `history` only grows: the turns of an ask()
 * are added to it only when the ask succeeds, so a failed ask leaves no half-finished turn
 * behind (an unanswered tool_use or a dangling request) and earlier turns are never touched.
 */
export function createTutorSession(deps: TutorDeps, game: TutorGame): TutorSession {
  const history: Anthropic.MessageParam[] = [];
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: deps.systemPrompt },
    { type: "text", text: playerBlock(game, deps.repertoire !== null), cache_control: { type: "ephemeral" } },
  ];
  let tail: Promise<unknown> = Promise.resolve();

  async function run(request: TutorRequest, progress: (label: string) => void, signal: AbortSignal | undefined, started: number) {
    const usage: TutorUsage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const done = (o: { ok: true; reply: TutorReply } | { ok: false; reason: TutorFailureReason; detail?: string }): TutorOutcome => {
      const ms = Math.round(performance.now() - started);
      if (o.ok) return { ok: true, reply: o.reply, usage, ms };
      const message = o.detail ? `${FAILURE_MESSAGES[o.reason]} (${o.detail})` : FAILURE_MESSAGES[o.reason];
      return { ok: false, reason: o.reason, message, usage, ms };
    };

    const evidence: Evidence = buildEvidence(request);
    const tools: ToolContext = {
      engine: deps.engine,
      explorer: deps.explorer,
      repertoire: deps.repertoire,
      config: deps.config,
      playerColor: game.playerColor,
      history: request.history,
      evidence,
    };
    const expectedKind = request.kind === "hint" ? "hint" : request.moment.kind;
    const revealFen = request.kind === "hint" ? request.fen : request.attemptFen;

    const staged: Anthropic.MessageParam[] = [requestTurn(request, game.playerColor)];
    let rounds = 0;
    let retried = false;

    for (;;) {
      if (signal?.aborted) return done({ ok: false, reason: "api_unavailable", detail: "aborted" });
      let response: Anthropic.Message;
      try {
        response = await deps.client.messages
          .stream(
            {
              model: deps.config.model,
              max_tokens: MAX_TOKENS,
              system,
              tools: TOOL_DEFINITIONS,
              tool_choice: { type: "auto" },
              thinking: { type: "adaptive" },
              output_config: { effort: deps.config.effort, format: { type: "json_schema", schema: TUTOR_REPLY_JSON_SCHEMA } },
              messages: [...history, ...staged],
            },
            signal ? { signal } : undefined,
          )
          .finalMessage();
      } catch (err) {
        const { reason, detail } = classifyError(err);
        return done({ ok: false, reason, detail });
      }
      addUsage(usage, response.usage);
      const assistant: Anthropic.MessageParam = { role: "assistant", content: response.content.map(toParam) };
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      const stop = response.stop_reason;
      if (stop === "refusal") return done({ ok: false, reason: "refusal" });
      if (stop === "max_tokens" || stop === "model_context_window_exceeded") {
        return done({ ok: false, reason: "max_tokens", detail: stop });
      }

      // pause_turn: send the conversation back as it is so the model continues; it counts as a round.
      if (stop === "pause_turn" || (stop === "tool_use" && toolUses.length > 0)) {
        if (++rounds > deps.config.maxToolRounds) return done({ ok: false, reason: "tool_rounds_exceeded" });
        staged.push(assistant);
        if (stop === "tool_use") {
          for (const block of toolUses) progress(toolLabel(block.name, block.input));
          // Every tool_use block runs in parallel and is answered in ONE user turn, in block order.
          const results = await Promise.all(toolUses.map((block) => runOne(block, tools)));
          staged.push({ role: "user", content: results });
        }
        continue;
      }

      // end_turn (or anything else that ends the turn): validate the reply, then check its claims.
      staged.push(assistant);
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const parsed = parseReply(text, expectedKind);
      let problem: { reason: TutorFailureReason; text: string };
      if (parsed.ok) {
        const claims = checkClaims(parsed.reply, evidence, revealFen);
        if (claims.length === 0) {
          history.push(...staged);
          return done({ ok: true, reply: parsed.reply });
        }
        problem = { reason: "unsupported_claim", text: claims.join(" ") };
      } else {
        problem = { reason: "invalid_reply", text: parsed.problem };
      }
      // NFR-8: one tool-less correction turn, then give up with the reason of the last failure.
      if (retried) return done({ ok: false, reason: problem.reason, detail: problem.text });
      retried = true;
      staged.push({ role: "user", content: [{ type: "text", text: correction(problem.text) }] });
    }
  }

  return {
    ask(request, onProgress, signal) {
      const started = performance.now();
      const progress = (label: string) => {
        try {
          onProgress({ label } satisfies TutorProgress);
        } catch {
          // The browser going away must not break the loop.
        }
      };
      progress(FIRST_PROGRESS); // NFR-1: synchronous, before any queueing or API call
      const result = tail.then(() =>
        run(request, progress, signal, started).catch((err: unknown): TutorOutcome => {
          const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
          return { ok: false, reason: "api_unavailable", message: `${FAILURE_MESSAGES.api_unavailable} (${String(err)})`, usage, ms: Math.round(performance.now() - started) };
        }),
      );
      tail = result;
      return result;
    },
  };
}

function correction(problem: string): string {
  return (
    `Your last reply was not accepted: ${problem} ` +
    "Send the corrected reply as the JSON object only. Name only moves that appear in this turn's tool results or the key-moment data."
  );
}

async function runOne(block: Anthropic.ToolUseBlock, ctx: ToolContext): Promise<Anthropic.ToolResultBlockParam> {
  try {
    const result = await runTool(block.name, block.input, ctx);
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "tool_result", tool_use_id: block.id, content: message.slice(0, 300), is_error: true };
  }
}

function addUsage(total: TutorUsage, u: Anthropic.Usage | undefined): void {
  total.requests++;
  if (!u) return;
  total.inputTokens += u.input_tokens ?? 0;
  total.outputTokens += u.output_tokens ?? 0;
  total.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
  total.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
}

/**
 * The assistant turn as it goes back into history: the fields the API accepts, nothing the SDK
 * added on the way in (e.g. parsed_output). Thinking blocks keep their signatures (preserved
 * thinking on 5.5 models).
 */
function toParam(block: Anthropic.ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return block.citations ? { type: "text", text: block.text, citations: block.citations as never } : { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    default:
      return block as unknown as Anthropic.ContentBlockParam;
  }
}
