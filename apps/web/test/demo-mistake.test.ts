// Mistake picker for the guided demo (#59: FR-27, FR-10). A fake Engine scores the position
// after each legal White move, so the picker's rules are checked without Stockfish.
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import type { Analysis, AnalyzeOptions, Engine, Score } from "@chess-tutor/engine";
import { chooseMistake, evaluateMoves, pickMistake, type MoveEval } from "../demo/mistake.ts";

const AFTER_D4_D5 = "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2";

const cp = (value: number): Score => ({ kind: "cp", value });

function analysis(fen: string, score: Score): Analysis {
  return { fen, depth: 12, lines: [{ rank: 1, moves: [], score, depth: 12 }], bestMove: "", timeMs: 1 };
}

/** Scores the position after each White move by its SAN (White's point of view); others get `rest`. */
function fakeEngine(bySan: Record<string, Score>, rest: Score = cp(30), start = AFTER_D4_D5) {
  const fenToSan = new Map<string, string>();
  for (const m of new Chess(start).moves({ verbose: true })) fenToSan.set(m.after, m.san);
  const calls: Array<{ fen: string; opts: AnalyzeOptions | undefined }> = [];
  const engine: Engine = {
    async analyze(fen, opts) {
      calls.push({ fen, opts });
      const san = fenToSan.get(fen);
      return analysis(fen, (san !== undefined ? bySan[san] : undefined) ?? rest);
    },
    bestMove: async () => "",
    quit: async () => {},
  };
  return { engine, calls };
}

describe("pickMistake (FR-27: chosen by Stockfish from the actual position)", () => {
  it("picks the move losing the least among those losing >= 200 cp", async () => {
    // Best is +40; Bh6 loses 340, Qd3 loses 210 (the smallest qualifying), Bg5 loses 150 (too small).
    const { engine } = fakeEngine({ e3: cp(40), Bh6: cp(-300), Qd3: cp(-170), Bg5: cp(-110) });
    const m = await pickMistake(engine, AFTER_D4_D5);
    expect(m).toEqual({ uci: "d1d3", san: "Qd3", from: "d1", to: "d3", bestCp: 40, playedCp: -170, lossCp: 210 });
  });

  it("evaluates every legal White move in the actual position, with the given search options", async () => {
    const { engine, calls } = fakeEngine({});
    await pickMistake(engine, AFTER_D4_D5, { analyze: { depth: 10, movetimeMs: 100 } });
    const legal = new Chess(AFTER_D4_D5).moves({ verbose: true });
    expect(calls.map((c) => c.fen).sort()).toEqual(legal.map((m) => m.after).sort());
    expect(calls[0]!.opts).toEqual({ depth: 10, movetimeMs: 100 });
  });

  it("skips a move after which White is still above +500 (the tutor would stay quiet)", async () => {
    // Best +900; Nc3 drops to +650 (loss 250) but White is still winning: no key moment.
    // Bg5 drops to +480 (loss 420) and qualifies.
    const { engine } = fakeEngine({ e4: cp(900), Nc3: cp(650), Bg5: cp(480) }, cp(880));
    expect((await pickMistake(engine, AFTER_D4_D5))?.san).toBe("Bg5");
  });

  it("accepts exactly +500 after the move", async () => {
    const { engine } = fakeEngine({ e4: cp(900), Nc3: cp(500) }, cp(880));
    expect((await pickMistake(engine, AFTER_D4_D5))?.san).toBe("Nc3");
  });

  it("skips a move that allows a forced mate against White", async () => {
    // Qd3 allows mate in 3 for Black: a huge loss but no lesson; Bh6 loses 300 cp.
    const { engine } = fakeEngine({ e3: cp(40), Qd3: { kind: "mate", value: -3 }, Bh6: cp(-260) });
    expect((await pickMistake(engine, AFTER_D4_D5))?.san).toBe("Bh6");
  });

  it("returns null when nothing qualifies", async () => {
    const { engine } = fakeEngine({ e3: cp(40), Bh6: cp(-100), Qd3: { kind: "mate", value: -2 } });
    expect(await pickMistake(engine, AFTER_D4_D5)).toBeNull();
  });

  it("reads scores from White's point of view although Black is to move after the White move", async () => {
    // +40 is good for White, -200 bad. A picker that flipped the sign would call Bh6 the best move.
    const { engine } = fakeEngine({ e3: cp(40), Bh6: cp(-200) }, cp(20));
    const m = await pickMistake(engine, AFTER_D4_D5);
    expect(m?.san).toBe("Bh6");
    expect(m?.lossCp).toBe(240);
  });

  it("honours a custom minimum loss", async () => {
    const { engine } = fakeEngine({ e3: cp(40), Qd3: cp(-170), Bh6: cp(-300) });
    expect((await pickMistake(engine, AFTER_D4_D5, { minLossCp: 250 }))?.san).toBe("Bh6");
  });

  it("can skip king moves (a king walk is a poor first lesson)", async () => {
    const { engine } = fakeEngine({ e3: cp(40), Kd2: cp(-170), Bh6: cp(-300) });
    expect((await pickMistake(engine, AFTER_D4_D5))?.san).toBe("Kd2");
    expect((await pickMistake(engine, AFTER_D4_D5, { skipKingMoves: true }))?.san).toBe("Bh6");
  });

  it("refuses a position with Black to move", async () => {
    const { engine } = fakeEngine({});
    await expect(pickMistake(engine, "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1")).rejects.toThrow(
      /White to move/,
    );
  });
});

describe("chooseMistake", () => {
  const ev = (san: string, cpValue: number, matedAgainst = false): MoveEval => ({
    uci: san,
    san,
    from: "a2",
    to: "a3",
    piece: "p",
    cp: cpValue,
    matedAgainst,
  });

  it("counts a mate for White as the best move", () => {
    expect(chooseMistake([ev("mates", 99_000), ev("b3", 300)])?.san).toBe("b3");
  });

  it("returns null for no moves", () => {
    expect(chooseMistake([])).toBeNull();
  });
});

describe("evaluateMoves", () => {
  it("scores a checkmating move as a mate for White and keeps the promotion piece in the UCI", async () => {
    const fen = "k7/7P/1K6/8/8/8/8/8 w - - 0 1";
    // h8=Q is mate: Black to move and mated, so the engine reports mate 0.
    const engine: Engine = {
      analyze: async (f) => analysis(f, new Chess(f).isCheckmate() ? { kind: "mate", value: 0 } : cp(800)),
      bestMove: async () => "",
      quit: async () => {},
    };
    const evals = await evaluateMoves(engine, fen);
    const queen = evals.find((e) => e.san === "h8=Q#");
    expect(queen?.uci).toBe("h7h8q");
    expect(queen?.cp).toBeGreaterThan(90_000);
    expect(queen?.matedAgainst).toBe(false);
    expect(evals.find((e) => e.san === "Kc7")?.cp).toBe(800);
  });
});
