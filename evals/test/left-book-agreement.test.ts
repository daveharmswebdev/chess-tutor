import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { createTutorSession, type TutorClient, type TutorReply } from "@chess-tutor/tutor";
import { describe, expect, it } from "vitest";
import { CASES_DIR, loadRepertoire, loadSettings } from "../src/config.ts";
import { gradeMoves, type ToolResultRecord } from "../src/graders.ts";
import type { EvalCase } from "../src/types.ts";
import { fakeEngine, fakeExplorer } from "./fakes.ts";

/**
 * Review 096 (#41): the claims check (FR-10) and the NFR-6 grader must give the same verdict on
 * plan moves backed by get_repertoire_context's usual_setup. Each reply runs through the real
 * session (scripted client, fake engine, real repertoire); the grader then reads the same tool
 * result the session produced.
 */

const evalCase = (id: string) => JSON.parse(readFileSync(`${CASES_DIR}/${id}.json`, "utf8")) as EvalCase;
const repertoire = loadRepertoire();
const config = loadSettings().tutor;

function message(content: unknown[], stop_reason: string): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: config.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

/** Round 1: get_repertoire_context on fen; then the same reply on every later round. Records the tool result. */
function scripted(c: EvalCase, reply: Record<string, unknown>) {
  const toolResults: ToolResultRecord[] = [];
  let round = 0;
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        return {
          async finalMessage() {
            round++;
            if (round === 1) {
              return message([{ type: "tool_use", id: "toolu_rep", name: "get_repertoire_context", input: { fen: c.fen } }], "tool_use");
            }
            if (round === 2) {
              const block = (params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
              toolResults.push({ id: "toolu_rep", name: "get_repertoire_context", input: { fen: c.fen }, content: block.content as string, isError: false });
            }
            return message([{ type: "text", text: JSON.stringify({ ...reply, evals: [] }), citations: null }], "end_turn");
          },
        };
      },
    },
  } as unknown as TutorClient;
  return { client, toolResults };
}

async function verdicts(id: string, reveal: string) {
  const c = evalCase(id);
  const reply = { schemaVersion: 1, kind: "opponent_left_book", message: "Your opponent left the book. How will you set up your pieces?", reveal, revealMove: null, arrows: [] };
  const { client, toolResults } = scripted(c, reply);
  const session = createTutorSession(
    { client, engine: fakeEngine(), explorer: fakeExplorer, repertoire, config, systemPrompt: "test" },
    { playerColor: c.playerColor, playerProfile: "test" },
  );
  const out = await session.ask({ kind: "key_moment", moment: c.moment!, fen: c.fen, attemptFen: c.attemptFen, history: c.history }, () => {});
  const grade = gradeMoves({
    kind: c.kind,
    playerColor: c.playerColor,
    history: c.history,
    fen: c.fen,
    attemptFen: c.attemptFen,
    moment: c.moment,
    engineBest: c.engineBest,
    reply: reply as TutorReply,
    toolResults,
    revealCpLoss: null,
    toleranceCp: 50,
  });
  return { claims: out.ok, grader: grade.pass, illegal: grade.illegal };
}

describe("claims check and NFR-6 grader agree on usual_setup plan moves (review 096, #41)", () => {
  it.each([
    // The reviewer's probes.
    ["lb-kid-e4", "Put your bishop on g7 with ...Bg7 and castle.", true],
    ["lb-kid-e4", "Play ...g6, ...Bg7, ...d6 and ...O-O, then ...e5.", true],
    ["lb-kid-nf3-move2", "Play ...Bg7 and ...g6, then ...d6 and ...O-O, and later ...e5.", true],
    ["lb-kid-e4", "Play ...Bg7 right now.", false],
    // The round-1 reveals (packages/tutor/test/left-book-plan.test.ts NF3_REPLY / E4_REPLY).
    [
      "lb-kid-nf3-move2",
      "You can keep your King's Indian setup: ...g6 and ...Bg7, then ...d6 and ...O-O, and later the pawn break ...e5 to fight for the centre.",
      true,
    ],
    [
      "lb-kid-e4",
      "Develop the knight to f6 and play ...g6, ...Bg7 and ...d6 with ...O-O: your pieces belong where they do in the King's Indian, and ...e5 is the pawn break.",
      true,
    ],
  ] as const)("%s: '%s' -> %s from both", async (id, reveal, expected) => {
    const v = await verdicts(id, reveal);
    expect(v).toMatchObject({ claims: expected, grader: expected });
  });

  it("where they differ, the claims check is the stricter one: a setup move legal now but framed as now", async () => {
    // ...g6 is legal after 1.e4, so NFR-6 (legality) passes; the claims check (backing) rejects it
    // because only usual_setup holds it and the clause puts it now. Never the other way round.
    expect(await verdicts("lb-kid-e4", "Play ...g6 now.")).toMatchObject({ claims: false, grader: true });
  });
});
