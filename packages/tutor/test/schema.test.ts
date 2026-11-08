import { describe, expect, it } from "vitest";
import { TutorReply } from "../src/contract.ts";
import { TUTOR_REPLY_JSON_SCHEMA, parseReply } from "../src/schema.ts";

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
    expect(objects).toBe(2);
  });

  it("has the same fields as the zod TutorReply", () => {
    expect(Object.keys(TUTOR_REPLY_JSON_SCHEMA.properties).sort()).toEqual(Object.keys(TutorReply.shape).sort());
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
  const good = { schemaVersion: 1, kind: "hint", message: "Q?", reveal: null, revealMove: null, arrows: [] };

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
