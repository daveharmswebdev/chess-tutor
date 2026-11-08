import type Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { KeyMoment } from "@chess-tutor/chess-core";
import { describe, expect, it } from "vitest";
import type { TutorFailureReason, TutorProgress, TutorRequest } from "../src/contract.ts";
import { createTutorSession } from "../src/index.ts";
import { TUTOR_REPLY_JSON_SCHEMA } from "../src/schema.ts";
import {
  CONFIG,
  deps,
  endTurnMsg,
  fakeClient,
  fakeEngine,
  fakeExplorer,
  fakeRepertoire,
  fenAfter,
  stopMsg,
  toolUseMsg,
  usage,
} from "./helpers.ts";

// Player (White) played 4.Nc3 where 4.c3 was best.
const HISTORY_BEFORE = ["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "c7c5"];
const ATTEMPT_FEN = fenAfter(HISTORY_BEFORE);
const HISTORY = [...HISTORY_BEFORE, "b1c3"];
const FEN = fenAfter(HISTORY);
const MOMENT: KeyMoment = { kind: "player_blunder", played: "Nc3", cpLoss: 160, best: "c3" };
const KEY_REQUEST: TutorRequest = { kind: "key_moment", moment: MOMENT, fen: FEN, attemptFen: ATTEMPT_FEN, history: HISTORY };

const ENGINE_LINES = {
  [ATTEMPT_FEN]: [{ moves: ["c2c3", "d8b6", "d1b3"], cp: 30 }],
  [FEN]: [{ moves: ["d8b6", "a1b1"], cp: -130 }],
};

const BLUNDER_REPLY = {
  schemaVersion: 1,
  kind: "player_blunder",
  message: "Your knight went to c3. After Qb6, what happens to the pawn on b2?",
  reveal: "c3 keeps d4 protected, and after Qb6 you have Qb3.",
  revealMove: "c2c3",
  arrows: [{ from: "c2", to: "c3" }],
};

/** Mentions only moves from the key-moment data, so it is valid without any tool call. */
const SIMPLE_REPLY = {
  schemaVersion: 1,
  kind: "player_blunder",
  message: "After Nc3, what can Black's queen attack?",
  reveal: "The pawn move to c3 was better: it keeps d4 protected.",
  revealMove: "c2c3",
  arrows: [],
};

const HINT_FEN = fenAfter(["d2d4", "d7d5"]);
const HINT_REQUEST: TutorRequest = { kind: "hint", fen: HINT_FEN, history: ["d2d4", "d7d5"] };
const HINT_REPLY = {
  schemaVersion: 1,
  kind: "hint",
  message: "Which bishop likes to come out before you play e3?",
  reveal: "Bf4 is the London move: the bishop gets out before e3 locks it in.",
  revealMove: "c1f4",
  arrows: [],
};

/** A hint in the key-moment position; Bf4 is backed because it is in the game's history. */
const HINT_IN_GAME = {
  schemaVersion: 1,
  kind: "hint",
  message: "Your Bf4 is already out. What is Black's queen eyeing on b2?",
  reveal: null,
  revealMove: null,
  arrows: [{ from: "d8", to: "b6" }],
};

const GAME = { playerColor: "w" as const, playerProfile: "About 1000 on Chess.com; plays the London and the KID." };

function keyMomentToolUse() {
  return toolUseMsg([
    { name: "evaluate_move", input: { fen: ATTEMPT_FEN, move: "Nc3" }, id: "toolu_a" },
    { name: "analyze_position", input: { fen: ATTEMPT_FEN }, id: "toolu_b" },
  ]);
}

function session(script: Parameters<typeof fakeClient>[0], extra: Partial<Parameters<typeof deps>[0]> = {}, log?: string[]) {
  const { client, calls } = fakeClient(script, log);
  const s = createTutorSession(deps({ client, engine: fakeEngine(ENGINE_LINES).engine, ...extra }), GAME);
  return { s, calls };
}

const noop = () => {};

describe("TutorSession.ask: the tool loop", () => {
  it("key moment: tool_use (parallel) -> one tool_result turn -> end_turn gives a validated reply", async () => {
    const { s, calls } = session([keyMomentToolUse(), endTurnMsg(BLUNDER_REPLY)]);
    const out = await s.ask(KEY_REQUEST, noop);
    expect(out).toMatchObject({ ok: true, reply: BLUNDER_REPLY });
    expect(calls).toHaveLength(2);

    const second = calls[1]!.params.messages;
    const toolTurn = second[second.length - 1]!;
    expect(toolTurn.role).toBe("user");
    const blocks = toolTurn.content as Anthropic.ToolResultBlockParam[];
    expect(blocks.map((b) => [b.type, b.tool_use_id])).toEqual([
      ["tool_result", "toolu_a"],
      ["tool_result", "toolu_b"],
    ]);
    expect(blocks.every((b) => b.is_error !== true)).toBe(true);
    const evalResult = JSON.parse(blocks[0]!.content as string);
    expect(evalResult).toMatchObject({ move: { san: "Nc3", uci: "b1c3" }, best: { san: "c3", uci: "c2c3" }, cp_loss: 160 });
    // The assistant tool_use turn (with its thinking block) is kept as sent.
    expect(second[second.length - 2]).toEqual({ role: "assistant", content: keyMomentToolUse().content.map(stripIds(["toolu_a", "toolu_b"])) });
  });

  it("hint: opening_explorer and repertoire tools -> end_turn ok", async () => {
    const { explorer } = fakeExplorer({
      totalGames: 100,
      opening: null,
      moves: [{ uci: "c1f4", san: "Bf4", games: 100, white: 50, draws: 10, black: 40, averageRating: 1300 }],
    });
    const repertoire = fakeRepertoire([{ name: "London System", color: "w", uci: ["d2d4", "d7d5", "c1f4"] }]);
    const { s, calls } = session(
      [
        toolUseMsg([
          { name: "opening_explorer", input: { fen: HINT_FEN } },
          { name: "get_repertoire_context", input: { fen: HINT_FEN } },
        ]),
        endTurnMsg(HINT_REPLY),
      ],
      { explorer, repertoire },
    );
    const out = await s.ask(HINT_REQUEST, noop);
    expect(out).toMatchObject({ ok: true, reply: HINT_REPLY });
    const user = calls[0]!.params.messages[0]!;
    expect(user.role).toBe("user");
    const text = (user.content as Anthropic.TextBlockParam[])[0]!.text;
    expect(text).toMatch(/^<hint_request>\n[\s\S]*\n<\/hint_request>$/);
    const data = JSON.parse(text.replace(/<\/?hint_request>/g, ""));
    expect(data).toMatchObject({ fen: HINT_FEN, side_to_move: "white", player_color: "white" });
    expect(data.history).toEqual([
      { san: "d4", uci: "d2d4" },
      { san: "d5", uci: "d7d5" },
    ]);
    const rep = JSON.parse(((calls[1]!.params.messages[2]!.content as Anthropic.ToolResultBlockParam[])[1]!.content as string));
    expect(rep).toMatchObject({ in_repertoire: true, line: "London System" });
  });

  it("puts the key-moment data in <key_moment> tags with moves in SAN and UCI", async () => {
    const { s, calls } = session([endTurnMsg(SIMPLE_REPLY)]);
    await s.ask(KEY_REQUEST, noop);
    const text = (calls[0]!.params.messages[0]!.content as Anthropic.TextBlockParam[])[0]!.text;
    expect(text.startsWith("<key_moment>\n")).toBe(true);
    const data = JSON.parse(text.replace(/<\/?key_moment>/g, ""));
    expect(data).toMatchObject({
      kind: "player_blunder",
      fen: FEN,
      attempt_fen: ATTEMPT_FEN,
      player_color: "white",
      moment: { played: { san: "Nc3", uci: "b1c3" }, best: { san: "c3", uci: "c2c3" }, cp_loss: 160 },
    });
  });

  it("answers every tool_use_id, with is_error for a tool that throws", async () => {
    const { s, calls } = session([
      toolUseMsg([
        { name: "evaluate_move", input: { fen: ATTEMPT_FEN, move: "Qxh7" }, id: "t1" },
        { name: "analyze_position", input: { fen: ATTEMPT_FEN }, id: "t2" },
      ]),
      endTurnMsg(BLUNDER_REPLY),
    ]);
    const out = await s.ask(KEY_REQUEST, noop);
    expect(out.ok).toBe(true);
    const blocks = calls[1]!.params.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
    expect(blocks[0]!.is_error).toBe(true);
    expect(blocks[0]!.content).toMatch(/illegal/i);
    expect(blocks[1]!.is_error).toBeUndefined();
  });

  it("runs the tool_use blocks of one turn in parallel", async () => {
    const pending: (() => void)[] = [];
    const base = fakeEngine(ENGINE_LINES).engine;
    const engine = {
      analyze(fen: string, opts?: object) {
        return new Promise<Awaited<ReturnType<typeof base.analyze>>>((resolve) => {
          pending.push(() => void base.analyze(fen, opts).then(resolve));
        });
      },
    };
    const { s } = session(
      [
        toolUseMsg([
          { name: "analyze_position", input: { fen: ATTEMPT_FEN } },
          { name: "analyze_position", input: { fen: FEN } },
        ]),
        endTurnMsg(BLUNDER_REPLY),
      ],
      { engine },
    );
    const done = s.ask(KEY_REQUEST, noop);
    await waitFor(() => pending.length === 2);
    pending.forEach((p) => p());
    expect((await done).ok).toBe(true);
  });

  it("sends the request layout of IR-6: fixed strict tools, auto tool choice, adaptive thinking, effort, schema, cached profile", async () => {
    const controller = new AbortController();
    const { s, calls } = session([endTurnMsg(SIMPLE_REPLY)]);
    await s.ask(KEY_REQUEST, noop, controller.signal);
    const p = calls[0]!.params;
    expect(p.model).toBe(CONFIG.model);
    expect(p.tools!.map((t) => (t as Anthropic.Tool).name)).toEqual([
      "analyze_position",
      "evaluate_move",
      "opening_explorer",
      "get_repertoire_context",
    ]);
    expect(p.tools!.every((t) => (t as Anthropic.Tool).strict === true)).toBe(true);
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema: TUTOR_REPLY_JSON_SCHEMA } });
    const system = p.system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual({ type: "text", text: "SYSTEM PROMPT v1" });
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]!.text).toContain(GAME.playerProfile);
    expect(system[1]!.text).toMatch(/White/);
    expect(p.max_tokens).toBeGreaterThan(1000);
    expect(calls[0]!.options?.signal).toBe(controller.signal);
  });

  it("keeps one conversation per game: history grows and earlier turns stay byte-identical", async () => {
    const { s, calls } = session([keyMomentToolUse(), endTurnMsg(BLUNDER_REPLY), endTurnMsg(HINT_IN_GAME)], {
      explorer: fakeExplorer({ moves: [], totalGames: 0, opening: null }).explorer,
    });
    const first = await s.ask(KEY_REQUEST, noop);
    expect(first.ok).toBe(true);
    const hint: TutorRequest = { kind: "hint", fen: FEN, history: HISTORY };
    const second = await s.ask(hint, noop);
    expect(second).toMatchObject({ ok: true });

    const firstFinal = calls[1]!.params.messages;
    const thirdMessages = calls[2]!.params.messages;
    expect(thirdMessages).toHaveLength(firstFinal.length + 2);
    expect(JSON.stringify(thirdMessages.slice(0, firstFinal.length))).toBe(JSON.stringify(firstFinal));
    expect(thirdMessages[firstFinal.length]!.role).toBe("assistant");
    expect(JSON.stringify(thirdMessages[firstFinal.length]!.content)).toContain("Qb6");
    expect(JSON.stringify(thirdMessages.at(-1))).toContain("<hint_request>");
    // System and tools are identical across calls (prompt cache).
    expect(JSON.stringify(calls[2]!.params.system)).toBe(JSON.stringify(calls[0]!.params.system));
    expect(JSON.stringify(calls[2]!.params.tools)).toBe(JSON.stringify(calls[0]!.params.tools));
  });

  it("a failed ask leaves the history as it was", async () => {
    const { s, calls } = session([new RateLimitError(429, undefined, "slow down", new Headers()), endTurnMsg(SIMPLE_REPLY)]);
    expect((await s.ask(KEY_REQUEST, noop)).ok).toBe(false);
    expect((await s.ask(KEY_REQUEST, noop)).ok).toBe(true);
    expect(calls[1]!.params.messages).toHaveLength(1);
  });

  it("sums usage over every response, including cache tokens, and reports wall time", async () => {
    const tu = keyMomentToolUse();
    tu.usage = usage(1000, 200, 800, 50) as Anthropic.Usage;
    const { s } = session([tu, endTurnMsg(BLUNDER_REPLY, usage(1500, 300, 900, 0))]);
    const out = await s.ask(KEY_REQUEST, noop);
    expect(out.usage).toEqual({
      requests: 2,
      inputTokens: 2500,
      outputTokens: 500,
      cacheReadInputTokens: 1700,
      cacheCreationInputTokens: 50,
    });
    expect(typeof out.ms).toBe("number");
    expect(out.ms).toBeGreaterThanOrEqual(0);
  });

  it("pause_turn resends the conversation to let the model continue", async () => {
    const paused = toolUseMsg([]);
    paused.stop_reason = "pause_turn";
    const { s, calls } = session([paused, endTurnMsg(SIMPLE_REPLY)]);
    const out = await s.ask(KEY_REQUEST, noop);
    expect(out.ok).toBe(true);
    expect(calls[1]!.params.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("serialises calls per session", async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeEngine(ENGINE_LINES).engine;
    const engine = {
      async analyze(fen: string, opts?: object) {
        log.push("engine");
        await gate;
        return slow.analyze(fen, opts);
      },
    };
    const { s } = session(
      [toolUseMsg([{ name: "analyze_position", input: { fen: ATTEMPT_FEN } }]), endTurnMsg(SIMPLE_REPLY), endTurnMsg(SIMPLE_REPLY)],
      { engine },
      log,
    );
    const a = s.ask(KEY_REQUEST, noop);
    const b = s.ask(KEY_REQUEST, noop);
    await waitFor(() => log.includes("engine"));
    expect(log).toEqual(["stream", "engine"]);
    release();
    await Promise.all([a, b]);
    expect(log).toEqual(["stream", "engine", "stream", "stream"]);
  });
});

describe("progress (NFR-1)", () => {
  it("emits the first label synchronously, before the API call, then one per tool_use", async () => {
    const log: string[] = [];
    const { s } = session([keyMomentToolUse(), endTurnMsg(BLUNDER_REPLY)], {}, log);
    const onProgress = (p: TutorProgress) => log.push(p.label);
    const done = s.ask(KEY_REQUEST, onProgress);
    expect(log).toEqual(["Tutor is looking at the position…"]);
    await done;
    expect(log).toEqual(["Tutor is looking at the position…", "stream", "Checking Nc3…", "Looking at the engine lines…", "stream"]);
  });
});

describe("failure reasons: ask() never throws", () => {
  async function fails(script: Parameters<typeof fakeClient>[0], reason: TutorFailureReason, extra = {}) {
    const { s, calls } = session(script, extra);
    const out = await s.ask(KEY_REQUEST, noop);
    expect(out).toMatchObject({ ok: false, reason });
    if (!out.ok) expect(out.message.length).toBeGreaterThan(0);
    return { out, calls };
  }

  it("invalid twice -> invalid_reply, with one tool-less correction turn", async () => {
    const { out, calls } = await fails([endTurnMsg("not json"), endTurnMsg({ ...BLUNDER_REPLY, arrows: "x" })], "invalid_reply");
    expect(out.usage.requests).toBe(2);
    const correction = calls[1]!.params.messages.at(-1)!;
    expect(correction.role).toBe("user");
    const blocks = correction.content as Anthropic.TextBlockParam[];
    expect(blocks.every((b) => b.type === "text")).toBe(true);
    expect(blocks[0]!.text).toMatch(/JSON/);
    expect(calls[1]!.params.messages.at(-2)!.role).toBe("assistant");
  });

  it("invalid once then valid -> ok", async () => {
    const { s } = session([endTurnMsg({ ...SIMPLE_REPLY, kind: "hint" }), endTurnMsg(SIMPLE_REPLY)]);
    expect(await s.ask(KEY_REQUEST, noop)).toMatchObject({ ok: true, reply: SIMPLE_REPLY });
  });

  it("an unbacked move twice -> unsupported_claim; the correction names the move", async () => {
    const bad = { ...BLUNDER_REPLY, message: "Why not Nh4 instead?" };
    const { calls } = await fails([endTurnMsg(bad), endTurnMsg(bad)], "unsupported_claim");
    expect(JSON.stringify(calls[1]!.params.messages.at(-1))).toContain("Nh4");
  });

  it("an unbacked move once, then a backed reply -> ok", async () => {
    const { s } = session([endTurnMsg({ ...SIMPLE_REPLY, reveal: "Qxh7 wins." }), endTurnMsg(SIMPLE_REPLY)]);
    expect((await s.ask(KEY_REQUEST, noop)).ok).toBe(true);
  });

  it("an illegal revealMove counts as an unsupported claim", async () => {
    const bad = { ...BLUNDER_REPLY, revealMove: "c2c5" };
    await fails([endTurnMsg(bad), endTurnMsg(bad)], "unsupported_claim");
  });

  it("more than maxToolRounds tool rounds -> tool_rounds_exceeded", async () => {
    const round = () => toolUseMsg([{ name: "analyze_position", input: { fen: ATTEMPT_FEN } }]);
    const { engine, calls: engineCalls } = fakeEngine(ENGINE_LINES);
    const { out } = await fails([round(), round(), round(), round(), round()], "tool_rounds_exceeded", { engine });
    expect(out.usage.requests).toBe(5);
    expect(engineCalls).toHaveLength(4);
  });

  it("refusal -> refusal", async () => {
    await fails([stopMsg("refusal")], "refusal");
  });

  it("max_tokens -> max_tokens (also model_context_window_exceeded)", async () => {
    await fails([stopMsg("max_tokens")], "max_tokens");
    await fails([stopMsg("model_context_window_exceeded")], "max_tokens");
  });

  it("RateLimitError -> rate_limited", async () => {
    await fails([new RateLimitError(429, undefined, "slow down", new Headers())], "rate_limited");
  });

  it("connection, 5xx and overloaded errors -> api_unavailable", async () => {
    await fails([new APIConnectionError({ message: "offline" })], "api_unavailable");
    await fails([new InternalServerError(500, undefined, "boom", new Headers())], "api_unavailable");
    await fails([new OverloadedError(529 as never, undefined, "overloaded", new Headers())], "api_unavailable");
    await fails([new APIError(529, undefined, "overloaded", new Headers())], "api_unavailable");
    await fails([new BadRequestError(400, undefined, "bad", new Headers())], "api_unavailable");
    await fails([new Error("something unexpected")], "api_unavailable");
  });

  it("an aborted request -> api_unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    const { s, calls } = session([new APIUserAbortError()]);
    expect(await s.ask(KEY_REQUEST, noop, controller.signal)).toMatchObject({ ok: false, reason: "api_unavailable" });
    expect(calls).toHaveLength(0);
    const { s: s2 } = session([new APIUserAbortError()]);
    expect(await s2.ask(KEY_REQUEST, noop, new AbortController().signal)).toMatchObject({ ok: false, reason: "api_unavailable" });
  });

  it("an abort while tools run stops before the next API call", async () => {
    const controller = new AbortController();
    const base = fakeEngine(ENGINE_LINES).engine;
    const engine = {
      async analyze(fen: string, opts?: object) {
        controller.abort();
        return base.analyze(fen, opts);
      },
    };
    const { s, calls } = session([toolUseMsg([{ name: "analyze_position", input: { fen: ATTEMPT_FEN } }]), endTurnMsg(SIMPLE_REPLY)], {
      engine,
    });
    expect(await s.ask(KEY_REQUEST, noop, controller.signal)).toMatchObject({ ok: false, reason: "api_unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("a queued ask still runs when the one before it fails at once", async () => {
    const { s } = session([new APIConnectionError({ message: "offline" }), endTurnMsg(SIMPLE_REPLY)]);
    const [a, b] = await Promise.all([s.ask(KEY_REQUEST, noop), s.ask(KEY_REQUEST, noop)]);
    expect(a).toMatchObject({ ok: false, reason: "api_unavailable" });
    expect(b).toMatchObject({ ok: true });
  });

  it("authentication and permission errors -> auth", async () => {
    await fails([new AuthenticationError(401, undefined, "bad key", new Headers())], "auth");
    await fails([new PermissionDeniedError(403, undefined, "nope", new Headers())], "auth");
  });

  it("a stream() that throws synchronously is handled too", async () => {
    const client = {
      messages: {
        stream() {
          throw new APIConnectionError({ message: "offline" });
        },
      },
    } as never;
    const s = createTutorSession(deps({ client }), GAME);
    expect(await s.ask(KEY_REQUEST, noop)).toMatchObject({ ok: false, reason: "api_unavailable" });
  });

  it("a throwing onProgress does not break ask()", async () => {
    const { s } = session([endTurnMsg(SIMPLE_REPLY)]);
    const out = await s.ask(KEY_REQUEST, () => {
      throw new Error("ui gone");
    });
    expect(out.ok).toBe(true);
  });
});

function stripIds(ids: string[]) {
  let i = 0;
  return (b: Anthropic.ContentBlock) => (b.type === "tool_use" ? { ...b, id: ids[i++]! } : b);
}

async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}
