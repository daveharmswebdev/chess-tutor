/**
 * Spike 1 (architecture §9): latency of WASM Stockfish in Node, for NFR-2
 * ("analyze_position ≤ 1 s at default depth"). Run with: pnpm spike:engine
 */
import { cpus } from "node:os";
import { createWasmEngine, type WasmFlavor } from "../src/index.ts";

const POSITIONS: Record<string, string> = {
  "London: 1.d4 d5 2.Bf4 c5 (sideline)": "rnbqkbnr/pp2pppp/8/2pp4/3P1B2/8/PPP1PPPP/RN1QKBNR w KQkq - 0 3",
  "London vs KID setup": "rnbq1rk1/ppp1ppbp/3p1np1/8/3P1B2/4PN1P/PPP2PP1/RN1QKB1R w KQ - 0 6",
  "KID main line, move 9": "r1bq1rk1/pppnn1bp/3p2p1/3Pp3/2P1Pp2/2N2N2/PP2BPPP/R2Q1RK1 w - - 0 11",
  "Englund gambit 1.d4 e5": "rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2",
  "Tactical middlegame": "r1b2rk1/pp1nqppp/2p1p3/3pP3/2PP4/2NB1N2/PP3PPP/R2Q1RK1 b - - 0 12",
  "Rook endgame": "8/5pk1/6p1/8/3R4/6PP/r4PK1/8 w - - 0 40",
};

async function measure(flavor: WasmFlavor, threads: number, depth: number) {
  const t0 = performance.now();
  const engine = createWasmEngine({ flavor, threads });
  // First search includes WASM load + NNUE init.
  await engine.analyze(POSITIONS["Englund gambit 1.d4 e5"]!, { depth: 1 });
  const startupMs = Math.round(performance.now() - t0);

  const times: number[] = [];
  const reached: number[] = [];
  for (const fen of Object.values(POSITIONS)) {
    const a = await engine.analyze(fen, { depth, multiPv: 3 });
    times.push(a.timeMs);
    reached.push(a.depth);
  }
  await engine.quit();
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)]!;
  const max = times[times.length - 1]!;
  return { flavor, threads, depth, startupMs, p50, max, minDepthReached: Math.min(...reached) };
}

console.log(`CPU: ${cpus()[0]?.model} (${cpus().length} cores), Node ${process.version}`);
console.log("multiPv 3, 6 positions\n");
const rows = [];
// Default config: depth 18 with a 1000 ms cap (NFR-2).
for (const [flavor, threads] of [["full", 4], ["full", 8], ["lite-single", 1]] as const) {
  rows.push(await measure(flavor, threads, 18));
}
console.table(rows);
