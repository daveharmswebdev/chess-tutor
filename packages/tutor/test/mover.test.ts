import { describe, expect, it } from "vitest";
import { moverOf } from "../src/index.ts";

/** moverOf is exported for the eval graders (#29, brief 049); its reading is the claims check's. */
describe("moverOf", () => {
  it.each([
    ["White played ", "b", "w"],
    ["White pushed the ", "b", "w"],
    ["Your opponent's ", "w", "b"],
    ["You can play ", "b", "b"],
    ["Black castled with ", "w", "b"],
  ] as const)("reads the side named in '%s' (player %s) as %s", (before, player, mover) => {
    expect(moverOf(before, player)).toBe(mover);
  });

  it.each([["It is not 1..."], ["White is fine, so "], ["Black's last move, "]])("names no mover in '%s'", (before) => {
    expect(moverOf(before, "w")).toBeNull();
  });
});
