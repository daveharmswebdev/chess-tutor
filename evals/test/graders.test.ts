import { readFileSync } from "node:fs";
import type { KeyMoment } from "@chess-tutor/chess-core";
import type { TutorReply } from "@chess-tutor/tutor";
import { describe, expect, it } from "vitest";
import {
  gradeArrows,
  gradeEvals,
  gradeGiveAway,
  gradeMoves,
  gradeReply,
  gradeReveal,
  type GradeInput,
} from "../src/graders.ts";

interface BakeoffReply {
  id: string;
  model: string;
  effort: string;
  kind: TutorReply["kind"];
  playerColor: "w" | "b";
  history: string[];
  fen: string;
  attemptFen: string;
  reply: TutorReply;
}

const FIXTURES: BakeoffReply[] = JSON.parse(readFileSync(new URL("./fixtures/bakeoff-replies.json", import.meta.url), "utf8"));

function input(f: BakeoffReply, over: Partial<GradeInput> = {}): GradeInput {
  return {
    kind: f.kind,
    playerColor: f.playerColor,
    history: f.history,
    fen: f.fen,
    attemptFen: f.attemptFen,
    moment: null,
    engineBest: f.reply.revealMove,
    reply: f.reply,
    toolResults: [],
    revealCpLoss: null,
    toleranceCp: 50,
    ...over,
  };
}

const fixture = (prefix: string, model: string, effort: string) => {
  const f = FIXTURES.find((x) => x.id.startsWith(prefix) && x.model === model && x.effort === effort);
  if (!f) throw new Error(`no fixture ${prefix} ${model} ${effort}`);
  return f;
};

/** Hint position from the bake-off (London, White to move, Bd3 is the answer). */
const HINT = fixture("london-hint-bd3", "claude-opus-5-5", "medium");

function withReply(f: BakeoffReply, reply: Partial<TutorReply>): BakeoffReply {
  return { ...f, reply: { ...f.reply, ...reply } };
}

describe("fixtures", () => {
  it("has the 12 bake-off replies", () => {
    expect(FIXTURES).toHaveLength(12);
  });
});

describe("gradeMoves (NFR-6)", () => {
  it.each(FIXTURES.map((f) => [f.id, f] as const))("grades every move in %s legal", (_id, f) => {
    const g = gradeMoves(input(f));
    expect(g.illegal).toEqual([]);
    expect(g.pass).toBe(true);
  });

  it("finds the moves the replies name, including castling, captures, checks and long algebraic", () => {
    const sonnetBook = fixture("kid-trompowsky", "claude-sonnet-5-5", "medium");
    const raws = gradeMoves(input(sonnetBook)).mentions.map((m) => m.raw);
    expect(raws).toEqual(expect.arrayContaining(["Bg5", "g6", "Bg7", "O-O", "d6", "c5", "d5"]));
    const opusPunish = fixture("london-qd6", "claude-opus-5-5", "medium");
    expect(gradeMoves(input(opusPunish)).mentions.map((m) => m.raw)).toEqual(expect.arrayContaining(["Bxd6", "exd6", "Bb5+"]));
    expect(gradeMoves(input(HINT)).mentions.map((m) => m.raw)).toEqual(expect.arrayContaining(["Bd3", "Qe2", "e3-e4"]));
  });

  it("does not treat a square as a move ('the knight on f6', 'Is h5 one of them?')", () => {
    const f = fixture("london-qh5", "claude-opus-5-5", "medium");
    const raws = gradeMoves(input(f)).mentions.map((m) => m.raw);
    expect(raws).not.toContain("f6");
    expect(raws).not.toContain("h5");
  });

  it("flags a move that is legal in no position of the case", () => {
    const g = gradeMoves(input(withReply(HINT, { message: "Now Nxe5 wins a piece, and Qxh7 is mate." })));
    expect(g.pass).toBe(false);
    expect(g.illegal).toEqual(expect.arrayContaining(["Nxe5", "Qxh7"]));
  });

  it("flags an illegal UCI and an illegal long-algebraic move", () => {
    const g = gradeMoves(input(withReply(HINT, { message: "Try f1h3 or Bf1-g2.", reveal: null })));
    expect(g.illegal).toEqual(expect.arrayContaining(["f1h3", "Bf1-g2"]));
  });
});

describe("gradeArrows", () => {
  it("flags the degenerate h7->h7 arrow (Sonnet medium hint)", () => {
    const f = fixture("london-hint-bd3", "claude-sonnet-5-5", "medium");
    const g = gradeArrows(f.reply);
    expect(g.pass).toBe(false);
    expect(g.problems.join(" ")).toMatch(/h7->h7/);
  });

  it("flags off-board squares and more than three arrows", () => {
    expect(gradeArrows({ ...HINT.reply, arrows: [{ from: "i9", to: "a1" }] }).pass).toBe(false);
    const four = [
      { from: "a1", to: "a2" },
      { from: "b1", to: "b2" },
      { from: "c1", to: "c2" },
      { from: "d1", to: "d2" },
    ];
    expect(gradeArrows({ ...HINT.reply, arrows: four }).pass).toBe(false);
  });

  it("passes the other replies' arrows", () => {
    for (const f of FIXTURES.filter((x) => !(x.id.startsWith("london-hint-bd3") && x.model === "claude-sonnet-5-5"))) {
      expect(gradeArrows(f.reply).problems, f.id).toEqual([]);
    }
  });
});

describe("gradeGiveAway (NFR-7)", () => {
  it("flags f1->h7 when the answer is f1d3 (Opus medium hint)", () => {
    const g = gradeGiveAway(input(HINT));
    expect(g.pass).toBe(false);
    expect(g.problems.join(" ")).toMatch(/f1->h7/);
  });

  it("flags f4->e5 when the answer is f4d6 (Opus medium punish_opponent)", () => {
    const g = gradeGiveAway(input(fixture("london-qd6", "claude-opus-5-5", "medium")));
    expect(g.pass).toBe(false);
    expect(g.problems.join(" ")).toMatch(/f4->e5/);
  });

  it("flags 'a check with your other bishop' when the answer is the checking Bb5+ (Opus low punish_opponent)", () => {
    const g = gradeGiveAway(input(fixture("london-qd6", "claude-opus-5-5", "low")));
    expect(g.pass).toBe(false);
    expect(g.problems.join(" ")).toMatch(/bishop.*check|check.*bishop/i);
  });

  it("passes the replies that keep the answer back", () => {
    const clean = FIXTURES.filter(
      (f) =>
        !(f.id.startsWith("london-hint-bd3") && f.model === "claude-opus-5-5") &&
        !(f.id.startsWith("london-qd6") && f.model === "claude-opus-5-5"),
    );
    expect(clean).toHaveLength(8);
    for (const f of clean) expect(gradeGiveAway(input(f)).problems, f.id).toEqual([]);
  });

  it.each([
    ["SAN", "Is Bd3 possible here?"],
    ["UCI", "What about f1d3?"],
    ["long algebraic", "Could Bf1-d3 help?"],
    ["long algebraic without piece", "Think about f1-d3."],
    ["piece to square", "Can the bishop go to d3?"],
  ])("flags a message naming the answer in %s", (_label, message) => {
    const g = gradeGiveAway(input(withReply(HINT, { message, arrows: [] })));
    expect(g.pass).toBe(false);
    expect(g.problems.join(" ")).toMatch(/names the answer/);
  });

  it("does not flag the answer's destination square when used as a square", () => {
    const g = gradeGiveAway(input(withReply(HINT, { message: "Which of your pieces could use the d3 square?", arrows: [] })));
    expect(g.problems).toEqual([]);
  });

  it("flags an arrow equal to, ending on, or along the answer's line, and one starting on its empty destination", () => {
    const along = gradeGiveAway(input(withReply(HINT, { message: "Look.", arrows: [{ from: "e2", to: "d3" }] })));
    expect(along.problems.join(" ")).toMatch(/e2->d3/);
    const equal = gradeGiveAway(input(withReply(HINT, { message: "Look.", arrows: [{ from: "f1", to: "d3" }] })));
    expect(equal.pass).toBe(false);
    const fromDest = gradeGiveAway(input(withReply(HINT, { message: "Look.", arrows: [{ from: "d3", to: "h7" }] })));
    expect(fromDest.problems.join(" ")).toMatch(/d3->h7/);
    const unrelated = gradeGiveAway(input(withReply(HINT, { message: "Look.", arrows: [{ from: "e1", to: "g1" }] })));
    expect(unrelated.problems).toEqual([]);
  });
});

describe("gradeEvals (FR-10 evaluations)", () => {
  // analyze_position at the hint fen said White is +1.5 (eval_cp is White's point of view).
  const analysis = {
    name: "analyze_position",
    input: { fen: HINT.fen },
    isError: false,
    content: JSON.stringify({ fen: HINT.fen, side_to_move: "white", depth: 18, lines: [{ rank: 1, eval_cp: 150, mate_in: null, moves: [] }] }),
  };
  const grade = (message: string, extra: Partial<GradeInput> = {}) =>
    gradeEvals(input(withReply(HINT, { message, reveal: null }), { toolResults: [analysis], ...extra }));

  it("passes a quoted evaluation that matches a tool result", () => {
    expect(grade("White is up 1.5 pawns here.").pass).toBe(true);
    expect(grade("The engine gives +1.5.").pass).toBe(true);
    expect(grade("The engine gives +1.5.").quotes.map((q) => q.raw)).toEqual(["+1.5"]);
    expect(grade("That is about 150 centipawns.").pass).toBe(true);
  });

  it("flags an evaluation credited to the wrong side", () => {
    const g = grade("Black is up 1.5 pawns here.");
    expect(g.pass).toBe(false);
    expect(g.quotes[0]?.problem).toBe("wrong_side");
  });

  it("flags an evaluation no tool result or key-moment data gave", () => {
    const g = grade("The engine gives +3.2.");
    expect(g.pass).toBe(false);
    expect(g.quotes[0]?.problem).toBe("unmatched");
  });

  it("matches cp_loss from evaluate_move and the key-moment data", () => {
    const evalMove = {
      name: "evaluate_move",
      input: { fen: HINT.fen, move: "g6" },
      isError: false,
      content: JSON.stringify({ cp_loss: 14, best_eval: { eval_cp: 40, mate_in: null }, played_eval: { eval_cp: 26, mate_in: null }, eval_pov: "black" }),
    };
    expect(grade("It costs only 14 centipawns.", { toolResults: [evalMove] }).pass).toBe(true);
    // eval_pov black: +0.4 for Black, so "Black is +0.4" matches and "White is +0.4" does not.
    expect(grade("Black is +0.4 here.", { toolResults: [evalMove] }).pass).toBe(true);
    expect(grade("White is +0.4 here.", { toolResults: [evalMove] }).quotes[0]?.problem).toBe("wrong_side");
    const moment: KeyMoment = { kind: "player_blunder", played: "Qh5", cpLoss: 870, best: "Nf3" };
    expect(grade("That move lost about 8.7 pawns.", { toolResults: [], moment }).pass).toBe(true);
  });

  it("matches mate in N", () => {
    const mate = { ...analysis, content: JSON.stringify({ lines: [{ rank: 1, eval_cp: null, mate_in: 3, moves: [] }] }) };
    expect(grade("There is mate in 3.", { toolResults: [mate] }).pass).toBe(true);
    expect(grade("There is mate in 2.", { toolResults: [mate] }).pass).toBe(false);
  });

  it("finds no quotes in the bake-off replies except the 14 centipawns and treats 'points of material' as no evaluation", () => {
    for (const f of FIXTURES) {
      const quotes = gradeEvals(input(f)).quotes.map((q) => q.raw);
      if (f.id.startsWith("kid-trompowsky") && f.model === "claude-sonnet-5-5") expect(quotes).toEqual(["14 centipawns"]);
      else expect(quotes, f.id).toEqual([]);
    }
  });
});

describe("gradeReveal", () => {
  it("passes the engine's best move and flags an illegal one", () => {
    expect(gradeReveal(input(HINT)).pass).toBe(true);
    const bad = gradeReveal(input(withReply(HINT, { revealMove: "f1g2" }), { engineBest: "f1d3" }));
    expect(bad.legal).toBe(false);
    expect(bad.pass).toBe(false);
  });

  it("accepts another move within the tolerance and rejects one beyond it", () => {
    const near = gradeReveal(input(withReply(HINT, { revealMove: "e3e4" }), { engineBest: "f1d3", revealCpLoss: 30 }));
    expect(near.pass).toBe(true);
    const far = gradeReveal(input(withReply(HINT, { revealMove: "e3e4" }), { engineBest: "f1d3", revealCpLoss: 120 }));
    expect(far.pass).toBe(false);
  });
});

describe("gradeReply", () => {
  it("rolls the graders up", () => {
    const g = gradeReply(input(HINT));
    expect(g.schema.pass).toBe(true);
    expect(g.moves.pass).toBe(true);
    expect(g.giveAway.pass).toBe(false);
  });

  it("flags a reply that does not match the schema", () => {
    const g = gradeReply(input(withReply(HINT, { arrows: [{ from: "a1", to: "a2" }, { from: "a1", to: "a3" }, { from: "a1", to: "a4" }, { from: "a1", to: "a5" }] })));
    expect(g.schema.pass).toBe(false);
  });
});
