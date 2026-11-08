import type { Analysis } from "@chess-tutor/chess-core";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { KINDS, loadCases, selectCases } from "../src/cases.ts";
import { CASES_DIR, loadRepertoire, loadSettings } from "../src/config.ts";
import { generateCase, type Analyzer, type Sequence } from "../src/generate-cases.ts";
import { historyFens, playUci } from "../src/notation.ts";

describe("committed cases (frozen by generate-cases with real Stockfish)", () => {
  const cases = loadCases(CASES_DIR);

  it.each(KINDS)("has at least 8 %s cases, with both colours", (kind) => {
    const of = cases.filter((c) => c.kind === kind);
    expect(of.length).toBeGreaterThanOrEqual(8);
    expect(new Set(of.map((c) => c.playerColor))).toEqual(new Set(["w", "b"]));
  });

  it("is consistent: fen follows the history, engineBest is legal at attemptFen, ids are unique", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      const fens = historyFens(c.history);
      expect(fens).toHaveLength(c.history.length + 1);
      expect(fens[fens.length - 1], c.id).toBe(c.fen);
      const before = c.kind === "player_blunder" || c.kind === "missed_win";
      expect(c.attemptFen, c.id).toBe(before ? fens[fens.length - 2] : c.fen);
      expect(playUci(c.attemptFen, c.engineBest), c.id).not.toBeNull();
      expect(c.moment === null, c.id).toBe(c.kind === "hint");
      if (c.kind === "hint") expect(new Chess(c.fen).turn(), c.id).toBe(c.playerColor);
    }
  });
});

describe("selectCases", () => {
  const cases = loadCases(CASES_DIR);
  it("selects by kind, id glob or a comma list", () => {
    expect(selectCases(cases, "hint").every((c) => c.kind === "hint")).toBe(true);
    expect(selectCases(cases, "pb-kid-*").every((c) => c.id.startsWith("pb-kid-"))).toBe(true);
    expect(selectCases(cases, "po-london-qd6,hint-kid-move1").map((c) => c.id).sort()).toEqual(["hint-kid-move1", "po-london-qd6"]);
    expect(selectCases(cases, undefined)).toHaveLength(cases.length);
  });
});

describe("generateCase", () => {
  const settings = loadSettings();
  const deps = (lines: Record<string, { move: string; cp: number }>) => {
    const engine: Analyzer = {
      async analyze(fen): Promise<Analysis> {
        const l = lines[fen.split(" ").slice(0, 2).join(" ")];
        const move = l?.move ?? new Chess(fen).moves({ verbose: true })[0]!.lan;
        return { fen, depth: 18, lines: [{ rank: 1, moves: [move], score: { kind: "cp", value: l?.cp ?? 0 }, depth: 18 }], bestMove: move, timeMs: 1 };
      },
    };
    return { engine, settings: { depth: 18, movetimeMs: 1000, multiPv: 3 }, thresholds: settings.thresholds, repertoire: loadRepertoire() };
  };
  const seq = (over: Partial<Sequence>): Sequence => ({ id: "t", kind: "player_blunder", playerColor: "w", san: [], source: "test", ...over });
  const key = (san: string[]) => {
    const c = new Chess();
    for (const m of san) c.move(m);
    return c.fen().split(" ").slice(0, 2).join(" ");
  };

  it("makes a player_blunder case graded before the move, with the engine's best there", async () => {
    const san = ["d4", "d5", "Bf4", "Nf6", "e3", "e6", "Qh5"];
    const out = await generateCase(seq({ san }), deps({ [key(san.slice(0, -1))]: { move: "g1f3", cp: 20 }, [key(san)]: { move: "f6h5", cp: -900 } }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.case.moment?.kind).toBe("player_blunder");
    expect(out.case.attemptFen).toBe(historyFens(out.case.history).at(-2));
    expect(out.case.engineBest).toBe("g1f3");
    expect(out.case.engineBestCp).toBe(20);
  });

  it("skips a sequence whose kind is not what it says, or with an illegal move", async () => {
    const san = ["d4", "d5", "Bf4", "Nf6", "e3", "e6", "Nf3"];
    const quiet = await generateCase(seq({ san }), deps({}));
    expect(quiet).toEqual({ ok: false, id: "t", problem: "no key moment (wanted player_blunder)" });
    const illegal = await generateCase(seq({ san: ["d4", "Qxh7"] }), deps({}));
    expect(illegal.ok).toBe(false);
    const wrongSide = await generateCase(seq({ kind: "hint", san: ["d4"], playerColor: "w" }), deps({}));
    expect(wrongSide.ok).toBe(false);
  });
});
