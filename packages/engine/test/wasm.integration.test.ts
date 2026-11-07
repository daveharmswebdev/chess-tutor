import { afterAll, describe, expect, it } from "vitest";
import { createWasmEngine } from "../src/stockfish-engine.ts";

// Starts real WASM Stockfish (the full NNUE build) as a child process.
describe("WASM Stockfish (integration)", () => {
  const engine = createWasmEngine({ threads: 2 });
  afterAll(() => engine.quit());

  it("analyzes a London position and returns legal-looking lines", async () => {
    // 1.d4 Nf6 2.Bf4 — Black to move
    const fen = "rnbqkb1r/pppppppp/5n2/8/3P1B2/8/PPP1PPPP/RN1QKBNR b KQkq - 2 2";
    const analysis = await engine.analyze(fen, { depth: 12, multiPv: 3 });

    expect(analysis.lines).toHaveLength(3);
    expect(analysis.depth).toBeGreaterThanOrEqual(12);
    for (const line of analysis.lines) expect(line.moves[0]).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
    // The opening is roughly level.
    const top = analysis.lines[0]!.score;
    expect(top.kind).toBe("cp");
    expect(Math.abs(top.value)).toBeLessThan(150);
  }, 30_000);

  it("plays at reduced strength", async () => {
    const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(await engine.bestMove(fen, { elo: 1400, movetimeMs: 200 })).toMatch(/^[a-h][1-8][a-h][1-8]$/);
  }, 30_000);
});
