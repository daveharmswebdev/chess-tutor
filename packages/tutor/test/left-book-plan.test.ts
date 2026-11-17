import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRepertoire, parseRepertoirePgn, type KeyMoment } from "@chess-tutor/chess-core";
import { describe, expect, it } from "vitest";
import type { TutorRequest } from "../src/contract.ts";
import { createTutorSession } from "../src/index.ts";
import { deps, endTurnMsg, fakeClient, fakeEngine, toolUseMsg } from "./helpers.ts";

/**
 * #41: after the opponent leaves book, the tutor explained the usual King's Indian plan
 * ("...d6 and ...e5", "the knight to f6") and the claims check rejected it (FR-10), because no
 * tool result held those moves. get_repertoire_context now returns the player's usual setup
 * from the last book position as evidence. These run the eval cases lb-kid-nf3-move2 and
 * lb-kid-e4 through the session with a scripted client and the real repertoire (kid.pgn).
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const repertoire = buildRepertoire(parseRepertoirePgn(readFileSync(`${root}repertoire/kid.pgn`, "utf8"), "b"));

interface EvalCase {
  id: string;
  history: string[];
  fen: string;
  attemptFen: string;
  moment: KeyMoment;
}
const evalCase = (id: string) => JSON.parse(readFileSync(`${root}evals/cases/${id}.json`, "utf8")) as EvalCase;

function request(c: EvalCase): TutorRequest {
  return { kind: "key_moment", moment: c.moment, fen: c.fen, attemptFen: c.attemptFen, history: c.history };
}

const GAME = { playerColor: "b" as const, playerProfile: "About 1000 on Chess.com; plays the London and the KID." };

function session(script: Parameters<typeof fakeClient>[0]) {
  const { client, calls } = fakeClient(script);
  return { s: createTutorSession(deps({ client, repertoire }), GAME), calls };
}

/** The shape of the rejected lb-kid-nf3-move2 reply (eval run 43716378888: "reveal mentions d6 ... e5"). */
const NF3_REPLY = {
  schemaVersion: 1,
  kind: "opponent_left_book",
  message: "White played Nf3 instead of c4 or Bf4. How would you set up your pieces against it?",
  reveal: "You can keep your King's Indian setup: ...g6 and ...Bg7, then ...d6 and ...O-O, and later the pawn break ...e5 to fight for the centre.",
  revealMove: null,
  arrows: [],
};

/** The shape of the rejected lb-kid-e4 reply (eval run 42864019702: "reveal mentions knight to f6 ... e5 ..."). */
const E4_REPLY = {
  schemaVersion: 1,
  kind: "opponent_left_book",
  message: "White opened with e4 instead of d4. How do you want to develop?",
  reveal: "Develop the knight to f6 and play ...g6, ...Bg7 and ...d6 with ...O-O: your pieces belong where they do in the King's Indian, and ...e5 is the pawn break.",
  revealMove: null,
  arrows: [],
};

const noop = () => {};

for (const [id, reply, missing] of [
  ["lb-kid-nf3-move2", NF3_REPLY, ["d6", "e5"]],
  ["lb-kid-e4", E4_REPLY, ["knight to f6", "e5"]],
] as const) {
  describe(`eval case ${id} (#41, FR-9, FR-10)`, () => {
    const c = evalCase(id);

    it("the plan reveal is rejected when no tool gave the setup moves", async () => {
      const { s, calls } = session([endTurnMsg(reply), endTurnMsg(reply)]);
      const out = await s.ask(request(c), noop);
      expect(out).toMatchObject({ ok: false, reason: "unsupported_claim" });
      const correction = JSON.stringify(calls[1]!.params.messages.at(-1));
      for (const move of missing) expect(correction).toContain(`mentions ${move}`);
    });

    it("the same reveal is accepted once get_repertoire_context returned the usual setup", async () => {
      const { s, calls } = session([toolUseMsg([{ name: "get_repertoire_context", input: { fen: c.fen }, id: "toolu_rep" }]), endTurnMsg(reply)]);
      const out = await s.ask(request(c), noop);
      expect(out).toMatchObject({ ok: true, reply: { reveal: reply.reveal } });
      expect(calls).toHaveLength(2); // no correction turn
      const toolTurn = calls[1]!.params.messages.at(-1)!;
      const result = JSON.parse((toolTurn.content as { content: string }[])[0]!.content);
      expect(result).toMatchObject({ in_repertoire: false, last_book_line: "KID Classical" });
      expect(result.usual_setup.map((m: { san: string }) => m.san)).toEqual(
        id === "lb-kid-e4" ? ["Nf6", "g6", "Bg7", "d6", "O-O", "e5"] : ["g6", "Bg7", "d6", "O-O", "e5", "Nc6"],
      );
    });

    it("a plan move outside the setup and the other tool results is still rejected (claims check not loosened)", async () => {
      const bad = { ...reply, reveal: `${reply.reveal} Also consider ...c5.` };
      const { s, calls } = session([
        toolUseMsg([{ name: "get_repertoire_context", input: { fen: c.fen }, id: "toolu_rep" }]),
        endTurnMsg(bad),
        endTurnMsg(bad),
      ]);
      const out = await s.ask(request(c), noop);
      expect(out).toMatchObject({ ok: false, reason: "unsupported_claim" });
      expect(JSON.stringify(calls[2]!.params.messages.at(-1))).toContain("mentions c5");
    });
  });
}

describe("a usual_setup move is the plan, never the answer (review 096, FR-10, FR-8)", () => {
  const c = evalCase("lb-kid-e4");
  const ANSWER = { ...E4_REPLY, reveal: "The best move is ...Nf6, attacking e4.", revealMove: "g8f6" };
  const repTool = () => toolUseMsg([{ name: "get_repertoire_context", input: { fen: c.fen }, id: "toolu_rep" }]);

  it("revealMove = a setup move with only get_repertoire_context (no engine call) is rejected", async () => {
    const engine = fakeEngine();
    const { client, calls } = fakeClient([repTool(), endTurnMsg(ANSWER), endTurnMsg(ANSWER)]);
    const s = createTutorSession(deps({ client, repertoire, engine: engine.engine }), GAME);
    const out = await s.ask(request(c), noop);
    expect(out).toMatchObject({ ok: false, reason: "unsupported_claim" });
    expect(engine.calls).toHaveLength(0);
    expect(JSON.stringify(calls[2]!.params.messages.at(-1))).toContain('revealMove \\"g8f6\\"');
  });

  it("the same revealMove is accepted once analyze_position backs it", async () => {
    const engine = fakeEngine({ [c.fen]: [{ moves: ["g8f6", "e4e5"], cp: 30 }] });
    const { client } = fakeClient([
      toolUseMsg([
        { name: "get_repertoire_context", input: { fen: c.fen }, id: "toolu_rep" },
        { name: "analyze_position", input: { fen: c.fen }, id: "toolu_eng" },
      ]),
      endTurnMsg(ANSWER),
    ]);
    const s = createTutorSession(deps({ client, repertoire, engine: engine.engine }), GAME);
    expect(await s.ask(request(c), noop)).toMatchObject({ ok: true, reply: { revealMove: "g8f6" } });
  });

  it("a setup move framed as played now ('Play ...Bg7 right now.') is rejected", async () => {
    const bad = { ...E4_REPLY, reveal: "Play ...Bg7 right now." };
    const { client, calls } = fakeClient([repTool(), endTurnMsg(bad), endTurnMsg(bad)]);
    const s = createTutorSession(deps({ client, repertoire }), GAME);
    expect(await s.ask(request(c), noop)).toMatchObject({ ok: false, reason: "unsupported_claim" });
    expect(JSON.stringify(calls[2]!.params.messages.at(-1))).toContain("mentions Bg7");
  });
});
