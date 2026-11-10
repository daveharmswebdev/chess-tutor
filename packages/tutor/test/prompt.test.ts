import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const prompt = readFileSync(`${root}prompts/tutor-system.v2.md`, "utf8");
const changelog = readFileSync(`${root}prompts/CHANGELOG.md`, "utf8");

describe("prompts/tutor-system.v2.md (release artifact)", () => {
  it("is versioned and logged in the changelog with #26 and #28", () => {
    expect(prompt).toMatch(/version: 2/);
    const entry = changelog.split("\n").find((l) => l.includes("tutor-system.v2.md"));
    expect(entry).toBeDefined();
    for (const phrase of ["#26", "#28", "`evals`", "give-away"]) expect(entry).toContain(phrase);
  });

  it("names every tool and covers the FR-8 to FR-12 rules", () => {
    for (const tool of TOOL_DEFINITIONS) expect(prompt).toContain(tool.name);
    for (const phrase of ["reveal", "revealMove", "arrows", "<key_moment>", "<hint_request>", "opponent_left_book", "London", "King's Indian"]) {
      expect(prompt).toContain(phrase);
    }
  });

  it("asks for every quoted evaluation in the evals field, from that side's point of view (#26)", () => {
    expect(prompt).toContain("`evals`");
    for (const phrase of ["side", "cp", "mate", "White's point of view", "cp_loss", "gain_cp"]) expect(prompt).toContain(phrase);
    expect(prompt).toMatch(/quote no evaluation you did not list/i);
    // Changes may be quoted as unsigned sizes, never listed and never signed (round 2).
    expect(prompt).toMatch(/never list them in `evals`/);
    expect(prompt).toMatch(/unsigned size/);
    expect(prompt).not.toMatch(/rather than as a number/);
  });

  it("states the give-away rules for message and arrows (FR-8, #28)", () => {
    expect(prompt).toMatch(/No arrow that starts on the answer's from-square/);
    // An arrow ending on the answer's to-square is a nudge, not a give-away (user, #10).
    expect(prompt).not.toMatch(/ends on its to-square/);
    expect(prompt).toMatch(/to-square is fine/);
    expect(prompt).toMatch(/give a check/);
    expect(prompt).toMatch(/piece/);
  });
});

describe("prompts/tutor-system.v1.md stays on disk unchanged", () => {
  it("is still version 1 and still logged", () => {
    const v1 = readFileSync(`${root}prompts/tutor-system.v1.md`, "utf8");
    expect(v1).toMatch(/version: 1/);
    expect(v1).not.toContain("`evals`");
    expect(changelog).toMatch(/tutor-system\.v1\.md/);
  });
});
