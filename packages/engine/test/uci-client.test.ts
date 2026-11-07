import { describe, expect, it } from "vitest";
import type { Transport } from "../src/transport.ts";
import { StockfishEngine } from "../src/stockfish-engine.ts";

/** A scripted fake engine: answers each command from a lookup function. */
function fakeTransport(respond: (cmd: string) => string[]) {
  const sent: string[] = [];
  let listener: (line: string) => void = () => {};
  let exitListener: (code: number | null) => void = () => {};
  const transport: Transport = {
    send: (cmd) => {
      sent.push(cmd);
      for (const line of respond(cmd)) queueMicrotask(() => listener(line));
    },
    onLine: (l) => (listener = l),
    onExit: (l) => (exitListener = l),
    close: () => {},
  };
  return { transport, sent, exit: (code: number) => exitListener(code) };
}

const handshake = (cmd: string): string[] =>
  cmd === "uci" ? ["id name Fake", "uciok"] : cmd === "isready" ? ["readyok"] : [];

const BLACK_TO_MOVE = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";

describe("StockfishEngine over a fake transport", () => {
  it("collects multipv lines, skips bound lines, and normalizes scores to White", async () => {
    const { transport, sent } = fakeTransport((cmd) => {
      if (cmd.startsWith("go")) {
        return [
          "info depth 10 multipv 1 score cp 30 pv g8f6",
          "info depth 12 multipv 1 score cp 25 upperbound pv g8f6", // must be ignored
          "info depth 12 multipv 1 score cp 20 pv d7d5 c2c4",
          "info depth 12 multipv 2 score cp -15 pv g8f6 c1f4",
          "bestmove d7d5 ponder c2c4",
        ];
      }
      return handshake(cmd);
    });
    const engine = new StockfishEngine(transport);
    const analysis = await engine.analyze(BLACK_TO_MOVE, { depth: 12, multiPv: 2 });

    expect(analysis.bestMove).toBe("d7d5");
    expect(analysis.depth).toBe(12);
    // Black to move: +20 for Black is -20 from White's point of view.
    expect(analysis.lines).toEqual([
      { rank: 1, moves: ["d7d5", "c2c4"], score: { kind: "cp", value: -20 }, depth: 12 },
      { rank: 2, moves: ["g8f6", "c1f4"], score: { kind: "cp", value: 15 }, depth: 12 },
    ]);
    expect(sent).toContain("setoption name MultiPV value 2");
    expect(sent).toContain(`position fen ${BLACK_TO_MOVE}`);
    expect(sent).toContain("go depth 12 movetime 1000");
  });

  it("runs concurrent requests one at a time, in order", async () => {
    let n = 0;
    const { transport, sent } = fakeTransport((cmd) =>
      cmd.startsWith("go") ? [`info depth 1 score cp ${++n} pv e2e4`, "bestmove e2e4"] : handshake(cmd),
    );
    const engine = new StockfishEngine(transport);
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const [a, b] = await Promise.all([engine.analyze(start, { depth: 1 }), engine.analyze(start, { depth: 1 })]);

    expect(a.lines[0]!.score.value).toBe(1);
    expect(b.lines[0]!.score.value).toBe(2);
    const gos = sent.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith("go"));
    expect(gos).toHaveLength(2);
  });

  it("sets UCI_LimitStrength and UCI_Elo for reduced-strength play", async () => {
    const { transport, sent } = fakeTransport((cmd) =>
      cmd.startsWith("go") ? ["bestmove b8c6"] : handshake(cmd),
    );
    const engine = new StockfishEngine(transport);
    expect(await engine.bestMove(BLACK_TO_MOVE, { elo: 1400, movetimeMs: 100 })).toBe("b8c6");
    expect(sent).toContain("setoption name UCI_LimitStrength value true");
    expect(sent).toContain("setoption name UCI_Elo value 1400");
  });

  it("rejects a pending search when the engine process dies", async () => {
    const fake = fakeTransport(handshake); // never answers "go"
    const engine = new StockfishEngine(fake.transport);
    const pending = engine.analyze(BLACK_TO_MOVE, { depth: 5 });
    await new Promise((r) => setTimeout(r, 10));
    fake.exit(1);
    await expect(pending).rejects.toThrow(/exited/);
  });
});
