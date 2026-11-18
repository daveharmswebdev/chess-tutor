import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const prompt = readFileSync(`${root}prompts/tutor-system.v4.md`, "utf8");
const v3 = readFileSync(`${root}prompts/tutor-system.v3.md`, "utf8");
const changelog = readFileSync(`${root}prompts/CHANGELOG.md`, "utf8");

describe("prompts/tutor-system.v4.md (release artifact)", () => {
  it("is versioned and logged in the changelog with #44, the tool, the claims rule and the caveat", () => {
    expect(prompt).toMatch(/version: 4/);
    const entry = changelog.split("\n").find((l) => l.includes("**tutor-system.v4.md**"));
    expect(entry).toBeDefined();
    for (const phrase of ["#44", "FR-21", "FR-10", "FR-23", "exchange_on_square", "claims check", "caveat", "pins, checks", "startResult", "review 108"]) expect(entry).toContain(phrase);
  });

  it("evals default to v4 (#44)", () => {
    const config = readFileSync(`${root}evals/src/config.ts`, "utf8");
    expect(config).toContain(`"tutor-system.v4.md"`);
  });

  it("says when to call exchange_on_square, to take counts and outcomes only from it, and to add the caveat (#44, FR-21, FR-23)", () => {
    const tools = prompt.slice(prompt.indexOf("## Tools: when to call which"), prompt.indexOf("## The one rule that matters most"));
    expect(tools).toContain("`exchange_on_square`");
    expect(tools).toMatch(/before you say a piece is hanging/);
    expect(tools).toMatch(/count attackers and defenders/);
    expect(tools).toMatch(/judge a trade/);
    const rule = prompt.slice(prompt.indexOf("### Counts and exchanges"), prompt.indexOf("## Your reply"));
    expect(rule).toMatch(/only from this turn's `exchange_on_square` result for that square/);
    expect(rule).toMatch(/ignores pins, checks and threats elsewhere/);
    expect(rule).toMatch(/never present a count as the full answer/i);
    expect(rule).toMatch(/`evaluate_move` or `analyze_position` before you call a capture good or bad/);
    expect(rule).toMatch(/x-ray/);
    // Review 108: outcomes are about the first capture.
    expect(tools).toMatch(/`startResult`: what the first capture leads to, if the other side then recaptures well/);
    expect(rule).toMatch(/must match `startResult`/);
    expect(rule).toMatch(/null when nobody can capture/);
    expect(rule).toMatch(/A capture named with what it wins or loses .* is an exchange claim too/);
    expect(rule).toMatch(/the count cannot back it/);
  });

  it("backs the plan after the opponent leaves book, or words it without moves (#41, FR-10, FR-9)", () => {
    const rule = prompt.slice(prompt.indexOf("- `opponent_left_book` (FR-9)"), prompt.indexOf("- `hint` (FR-12)"));
    expect(rule).toContain("get_repertoire_context");
    expect(rule).toMatch(/Name a plan move only if this turn's tool results hold it: a move in `usual_setup`, an engine line, or an explorer move/);
    expect(rule).toMatch(/a move from memory gets the reply rejected/);
    expect(rule).toMatch(/in words, without naming the move/);
    expect(rule).toMatch(/pawn break in the centre/);
    // A setup move is the repertoire's plan, not an engine-checked answer.
    expect(rule).toMatch(/`revealMove` unless `analyze_position` or `evaluate_move` backs it/);
    // The claims check rejects a setup move framed as now (review 096).
    expect(rule).toMatch(/do not put one in a clause with "now", "right away" or "immediately"/);
    expect(prompt).toMatch(/`usual_setup`: the student's own next moves of the last book line/);
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

describe("prompts/tutor-system.v3.md stays on disk unchanged", () => {
  it("is still version 3, without exchange_on_square, and still logged", () => {
    expect(v3).toMatch(/version: 3/);
    expect(v3).toContain("usual_setup");
    expect(v3).not.toContain("exchange_on_square");
    const entry = changelog.split("\n").find((l) => l.includes("**tutor-system.v3.md**"));
    for (const phrase of ["#41", "FR-10", "FR-8", "usual_setup", "get_repertoire_context"]) expect(entry).toContain(phrase);
  });
});

describe("prompts/tutor-system.v2.md stays on disk unchanged", () => {
  it("is still version 2, without the #41 rule, and still logged", () => {
    const v2 = readFileSync(`${root}prompts/tutor-system.v2.md`, "utf8");
    expect(v2).toMatch(/version: 2/);
    expect(v2).toContain("`evals`");
    expect(v2).not.toContain("usual_setup");
    const entry = changelog.split("\n").find((l) => l.includes("**tutor-system.v2.md**"));
    for (const phrase of ["#26", "#28", "`evals`", "give-away"]) expect(entry).toContain(phrase);
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
