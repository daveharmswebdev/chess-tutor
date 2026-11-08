import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyCorrection, regradeDir } from "../src/regrade.ts";
import type { CaseResult, RunSummary } from "../src/types.ts";

const FIX = fileURLToPath(new URL("./fixtures/q3/", import.meta.url));

function runDir(files: string[], summary?: Partial<RunSummary>): string {
  const dir = mkdtempSync(join(tmpdir(), "evals-regrade-"));
  mkdirSync(join(dir, "cases"));
  for (const f of files) copyFileSync(join(FIX, `opus-medium--${f}.json`), join(dir, "cases", `${f}.json`));
  if (summary) writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
  return dir;
}

describe("regradeDir", () => {
  it("re-grades recorded cases offline and rewrites the case files, summary.json and report.md", () => {
    const dir = runDir(["po-london-ng4", "hint-london-ne5", "lb-kid-london-nc3", "lb-london-qb6"], {
      model: "claude-opus-5-5",
      effort: "medium",
      promptFile: "tutor-system.v1.md",
      promptSha256: "a".repeat(64),
      startedAt: "2026-11-08T10:00:00.000Z",
      finishedAt: "2026-11-08T10:10:00.000Z",
      maxUsd: 2.5,
      spentUsd: 0.12,
      stoppedByBudget: false,
      skipped: [],
    });
    const before = JSON.parse(readFileSync(join(dir, "cases", "po-london-ng4.json"), "utf8")) as CaseResult;
    expect(before.grades!.moves.illegal).toEqual(["exf4", "exf4"]);

    const summary = regradeDir(dir);
    expect(summary.model).toBe("claude-opus-5-5");
    expect(summary.maxUsd).toBe(2.5);
    expect(summary.metrics.cases).toBe(4);
    expect(summary.metrics.moveLegalPct).toBe(1);
    const after = JSON.parse(readFileSync(join(dir, "cases", "po-london-ng4.json"), "utf8")) as CaseResult;
    expect(after.grades!.moves.illegal).toEqual([]);
    expect(after.costUsd).toBe(before.costUsd);
    expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).metrics.moveLegalPct).toBe(1);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toMatch(/Points at the answer square/);
  });

  it("works without a summary.json, taking model and effort from the cases", () => {
    const summary = regradeDir(runDir(["po-london-ng4"]));
    expect(summary.model).toBe("claude-opus-5-5");
    expect(summary.effort).toBe("medium");
  });
});

describe("classifyCorrection", () => {
  it("buckets the session's correction texts", () => {
    expect(classifyCorrection("Your last reply was not accepted: message names dxe5, which gives the answer away: keep it for reveal.")).toEqual(["give_away"]);
    expect(classifyCorrection("Your last reply was not accepted: arrow b5-c7 is the answer move, which gives the answer away before \"Show me\".")).toEqual(["give_away"]);
    expect(classifyCorrection("Your last reply was not accepted: message mentions d5, which does not appear in this turn's tool results or the key-moment data.")).toEqual(["unbacked_move"]);
    expect(classifyCorrection("Your last reply was not accepted: reveal mentions Nxe5, which is not legal in any position you were shown.")).toEqual(["illegal_move"]);
    expect(classifyCorrection("Your last reply was not accepted: reveal quotes the evaluation \"+2.1\", which matches no score in this turn's tool results or the key-moment data.")).toEqual(["unbacked_eval"]);
    expect(classifyCorrection("Your last reply was not accepted: Your reply was not valid JSON.")).toEqual(["invalid_reply"]);
    expect(classifyCorrection("Your last reply was not accepted: revealMove \"e2e5\" is not a legal move in the position where the player moves.")).toEqual(["reveal_move"]);
    expect(
      classifyCorrection("Your last reply was not accepted: message mentions d5, which does not appear in this turn's tool results. message names dxe5, which gives the answer away: keep it for reveal."),
    ).toEqual(["give_away", "unbacked_move"]);
  });
});
