import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Grading a recorded live case replays every engine line with chess.js. Before the legal-move
// cache of #29 that took about 2 s locally and over 5 s on CI runners; the timeout stays generous.
vi.setConfig({ testTimeout: 20_000 });
import { CASES_DIR } from "../src/config.ts";
import { gradeGiveAway, gradeMoves, gradeReply } from "../src/graders.ts";
import { gradeInputFor } from "../src/regrade.ts";
import type { CaseResult, EvalCase } from "../src/types.ts";

/** Real per-case results from the first live runs (2026-11-08), copied from the coordinator's q3-results. */
function fixture(run: string, caseId: string): { result: CaseResult; evalCase: EvalCase } {
  const result = JSON.parse(readFileSync(new URL(`./fixtures/q3/${run}--${caseId}.json`, import.meta.url), "utf8")) as CaseResult;
  const evalCase = JSON.parse(readFileSync(`${CASES_DIR}/${caseId}.json`, "utf8")) as EvalCase;
  return { result, evalCase };
}
const inputOf = (run: string, caseId: string) => {
  const { result, evalCase } = fixture(run, caseId);
  return gradeInputFor(result, evalCase, 50)!;
};

describe("NFR-6 move legality on the live-run false positives", () => {
  it.each([
    ["opus-medium", "po-london-ng4", "exf4"], // "Step back with Qe2, and after exf4 exf4": the evaluate_move reply line
    ["sonnet-medium", "lb-london-c5", "exd4"], // "If Black plays cxd4, recapture with exd4": after the answer e3
    ["opus-medium", "hint-london-ne5", "Qxh5"], // "The engine's main line goes e4 Be7 e5 ... Then Ng5 and Qxh5"
    ["sonnet-medium", "po-london-bg6-trap", "Bxh5"], // "If Black plays Bxh5, you take back with gxh5": after the answer h5
    ["opus-medium", "lb-kid-london-nc3", "c7"], // "jump to b5 to go after c7": a square
    ["sonnet-medium", "lb-kid-four-pawns", "c7"], // "your knight can go to a6 or c7": the knight, via a6
  ])("%s %s: %s is graded legal", (run, caseId, raw) => {
    const g = gradeMoves(inputOf(run, caseId));
    expect(g.illegal).not.toContain(raw);
  });

  it.each([
    ["opus-medium", "lb-london-qb6", "c7"], // "joins the attack on c7?"
    ["opus-low", "lb-london-qb6", "b2"], // "instead of just guarding b2?"
    ["opus-low", "po-london-qxb2", "a8"], // "the rook on a8?"
    ["sonnet-medium", "hint-london-c5", "d2"], // "a good square on d2?"
  ])("%s %s: '%s?' is a square, not a move", (run, caseId, square) => {
    const g = gradeMoves(inputOf(run, caseId));
    expect(g.mentions.map((m) => m.raw)).not.toContain(`${square}?`);
    expect(g.illegal).toEqual([]);
  });

  it("still flags a move that is illegal inside a line", () => {
    const input = inputOf("opus-medium", "po-london-ng4");
    const reveal = `${input.reply.reveal} After exf4 exf4 Qxa8 wins the rook.`;
    const g = gradeMoves({ ...input, reply: { ...input.reply, reveal } });
    expect(g.illegal).toEqual(["Qxa8"]);
  });

  it("reads 'Look at c7?' as a square, but '...c5?' and 'play c5?!' as moves", () => {
    const input = inputOf("opus-medium", "lb-london-qb6");
    const raws = (message: string) => gradeMoves({ ...input, reply: { ...input.reply, message, reveal: null } }).mentions.map((m) => m.raw);
    expect(raws("Look at c7? What guards it?")).toEqual([]);
    expect(raws("Black answered ...c5? and play c4?! is risky")).toEqual(["c5?", "c4?!"]);
  });
});

describe("NFR-7 on live replies, per the user's rule", () => {
  it("an arrow that only ends on the answer's square is a nudge, not a give-away", () => {
    // po-kid-ne5 style: arrows d7->e5, g7->e5 point at e5; the answer is dxe5.
    const g = gradeGiveAway(inputOf("opus-medium", "po-london-ng4"));
    // arrows g4->g4 (malformed, ignored for NFR-7) and e2->g4 (ends on g4): no give-away, one nudge
    expect(g.pass).toBe(true);
    expect(g.nudges.join(" ")).toMatch(/e2->g4/);
  });

  it("gradeReply reports pointsAtAnswer separately from nfr7", () => {
    const r = gradeReply(inputOf("opus-medium", "po-london-ng4"));
    expect(r.nfr7).toBe(true);
    expect(r.pointsAtAnswer).toBe(true);
  });
});
