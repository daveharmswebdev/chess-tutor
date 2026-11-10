import { describe, expect, it } from "vitest";
import { TutorReply } from "../src/contract.ts";
import { EvalEntry, TUTOR_REPLY_JSON_SCHEMA, TutorDraft, parseReply } from "../src/schema.ts";

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (n: Node) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === "object") {
    visit(node as Node);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

describe("TutorReply JSON Schema (spike 003)", () => {
  it("closes every object and requires every property", () => {
    let objects = 0;
    walk(TUTOR_REPLY_JSON_SCHEMA, (n) => {
      if (n.type === "object") {
        objects++;
        expect(n.additionalProperties).toBe(false);
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as Node).sort());
      }
    });
    expect(objects).toBe(3);
  });

  it("has the same fields as the zod draft type (TutorReply plus evals, #26)", () => {
    expect(Object.keys(TUTOR_REPLY_JSON_SCHEMA.properties).sort()).toEqual(Object.keys(TutorDraft.shape).sort());
    expect(Object.keys(TutorDraft.shape).sort()).toEqual([...Object.keys(TutorReply.shape), "evals"].sort());
    const item = TUTOR_REPLY_JSON_SCHEMA.properties.evals.items;
    expect(Object.keys(item.properties).sort()).toEqual(Object.keys(EvalEntry.shape).sort());
    expect(item.properties.side.enum).toEqual(EvalEntry.shape.side.options);
    expect(item.properties.cp).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(item.properties.mate).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(TUTOR_REPLY_JSON_SCHEMA.required).toContain("evals");
  });

  it("keeps the public TutorReply without evals (schemaVersion 1)", () => {
    expect(Object.keys(TutorReply.shape)).not.toContain("evals");
    expect(TUTOR_REPLY_JSON_SCHEMA.properties.schemaVersion).toEqual({ type: "integer", enum: [1] });
  });

  it("writes nullable fields as anyOf [T, null] and uses no unsupported constraints", () => {
    const props = TUTOR_REPLY_JSON_SCHEMA.properties as Record<string, Node>;
    expect(props.reveal).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(props.revealMove).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    const json = JSON.stringify(TUTOR_REPLY_JSON_SCHEMA);
    for (const banned of ["maxItems", "minItems", "maxLength", "minLength", "minimum", "maximum", "$schema"]) {
      expect(json).not.toContain(banned);
    }
    expect((props.kind as Node).enum).toEqual(TutorReply.shape.kind.options);
  });
});

describe("parseReply (NFR-8)", () => {
  const good = { schemaVersion: 1, kind: "hint", message: "Q?", reveal: null, revealMove: null, arrows: [], evals: [] };

  it("accepts a valid reply and normalises kind case", () => {
    expect(parseReply(JSON.stringify(good), "hint")).toEqual({ ok: true, reply: good });
    expect(parseReply(JSON.stringify({ ...good, kind: " HINT " }), "hint")).toEqual({ ok: true, reply: good });
    const left = { ...good, kind: "Opponent-Left-Book" };
    expect(parseReply(JSON.stringify(left), "opponent_left_book")).toMatchObject({ ok: true, reply: { kind: "opponent_left_book" } });
  });

  it("rejects non-JSON, schema violations, too many arrows and the wrong kind", () => {
    expect(parseReply("Sure! Here is", "hint")).toMatchObject({ ok: false, problem: expect.stringMatching(/JSON/) });
    expect(parseReply(JSON.stringify({ ...good, schemaVersion: 2 }), "hint")).toMatchObject({ ok: false });
    const arrows = Array.from({ length: 4 }, () => ({ from: "e2", to: "e4" }));
    expect(parseReply(JSON.stringify({ ...good, arrows }), "hint")).toMatchObject({ ok: false, problem: expect.stringMatching(/arrows/) });
    // An off-board arrow is no longer a schema failure: the session drops it (FR-11, #10 round 2).
    const offBoard = { ...good, arrows: [{ from: "e2", to: "e9" }] };
    expect(parseReply(JSON.stringify(offBoard), "hint")).toMatchObject({ ok: true });
    expect(parseReply(JSON.stringify(good), "player_blunder")).toMatchObject({ ok: false, problem: expect.stringMatching(/kind/) });
  });
});

describe("parseReply: the evals field (#26)", () => {
  const good = { schemaVersion: 1, kind: "hint", message: "Q?", reveal: null, revealMove: null, arrows: [], evals: [] };

  it("accepts entries with exactly one of cp and mate", () => {
    const evals = [
      { side: "white", cp: 35, mate: null },
      { side: "black", cp: null, mate: 3 },
    ];
    expect(parseReply(JSON.stringify({ ...good, evals }), "hint")).toEqual({ ok: true, reply: { ...good, evals } });
  });

  it("rejects a missing evals, both or neither of cp and mate, a non-integer and an unknown side", () => {
    const { evals: _drop, ...noEvals } = good;
    expect(parseReply(JSON.stringify(noEvals), "hint")).toMatchObject({ ok: false, problem: expect.stringMatching(/evals/) });
    for (const e of [
      { side: "white", cp: 35, mate: 2 },
      { side: "white", cp: null, mate: null },
      { side: "white", cp: 1.5, mate: null },
      { side: "you", cp: 35, mate: null },
    ]) {
      expect(parseReply(JSON.stringify({ ...good, evals: [e] }), "hint"), JSON.stringify(e)).toMatchObject({ ok: false, problem: expect.stringMatching(/evals/) });
    }
  });
});
