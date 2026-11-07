import { describe, expect, it } from "vitest";
import { TutorReply } from "../src/index.ts";

describe("TutorReply", () => {
  it("accepts a valid reply and rejects more than 3 arrows", () => {
    const ok = { schemaVersion: 1, kind: "hint", message: "What does your knight want?", reveal: null, revealMove: null, arrows: [] };
    expect(TutorReply.parse(ok)).toEqual(ok);
    const arrows = Array.from({ length: 4 }, () => ({ from: "e2", to: "e4" }));
    expect(TutorReply.safeParse({ ...ok, arrows }).success).toBe(false);
  });
});
