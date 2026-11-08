import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../src/tools.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const prompt = readFileSync(`${root}prompts/tutor-system.v1.md`, "utf8");
const changelog = readFileSync(`${root}prompts/CHANGELOG.md`, "utf8");

describe("prompts/tutor-system.v1.md (release artifact)", () => {
  it("is versioned and logged in the changelog", () => {
    expect(prompt).toMatch(/version: 1/);
    expect(changelog).toMatch(/tutor-system\.v1\.md/);
  });

  it("names every tool and covers the FR-8 to FR-12 rules", () => {
    for (const tool of TOOL_DEFINITIONS) expect(prompt).toContain(tool.name);
    for (const phrase of ["reveal", "revealMove", "arrows", "<key_moment>", "<hint_request>", "opponent_left_book", "London", "King's Indian"]) {
      expect(prompt).toContain(phrase);
    }
  });
});
