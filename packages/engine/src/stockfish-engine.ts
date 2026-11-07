import { createRequire } from "node:module";
import { spawnTransport, type Transport } from "./transport.ts";
import { UciClient } from "./uci-client.ts";
import { sideToMove } from "./uci-parser.ts";
import type { Analysis, AnalysisLine, AnalyzeOptions, BestMoveOptions, Engine } from "./types.ts";

export interface StockfishOptions {
  threads?: number;
  hashMb?: number;
}

const DEFAULT_DEPTH = 18;
/** NFR-2: a single analysis returns within about 1 s. */
const DEFAULT_MOVETIME_CAP_MS = 1000;

/** An Engine backed by any UCI Stockfish (WASM or native) behind a Transport. */
export class StockfishEngine implements Engine {
  private readonly client: UciClient;
  private readonly ready: Promise<void>;

  constructor(transport: Transport, opts: StockfishOptions = {}) {
    this.client = new UciClient(transport);
    this.ready = this.client.init({
      Threads: opts.threads ?? 4,
      Hash: opts.hashMb ?? 64,
    });
  }

  async analyze(fen: string, opts: AnalyzeOptions = {}): Promise<Analysis> {
    await this.ready;
    const multiPv = opts.multiPv ?? 1;
    // Depth target plus a time cap: the engine stops at whichever comes first.
    const depth = opts.depth ?? DEFAULT_DEPTH;
    const cap = opts.movetimeMs ?? DEFAULT_MOVETIME_CAP_MS;
    const go = `depth ${depth} movetime ${cap}`;
    const result = await this.client.search(fen, go, { UCI_LimitStrength: false, MultiPV: multiPv });

    // UCI scores are from the side to move; normalize to White's point of view.
    const sign = sideToMove(fen) === "w" ? 1 : -1;
    const lines: AnalysisLine[] = [...result.lines.entries()]
      .sort(([a], [b]) => a - b)
      .map(([rank, info]) => ({
        rank,
        moves: info.pv ?? [],
        score: { kind: info.score!.kind, value: info.score!.value * sign },
        depth: info.depth ?? 0,
      }));

    return {
      fen,
      depth: Math.max(0, ...lines.map((l) => l.depth)),
      lines,
      bestMove: result.bestMove,
      timeMs: result.timeMs,
    };
  }

  async bestMove(fen: string, opts: BestMoveOptions = {}): Promise<string> {
    await this.ready;
    const limited = opts.elo !== undefined;
    const go = opts.depth ? `depth ${opts.depth}` : `movetime ${opts.movetimeMs ?? 500}`;
    const result = await this.client.search(fen, go, {
      MultiPV: 1,
      UCI_LimitStrength: limited,
      ...(limited ? { UCI_Elo: opts.elo! } : {}),
    });
    return result.bestMove;
  }

  async quit(): Promise<void> {
    this.client.quit();
  }
}

export type WasmFlavor = "full" | "single" | "lite" | "lite-single";

/** WASM Stockfish from the pinned `stockfish` npm package, run as a Node child process. */
export function createWasmEngine(opts: StockfishOptions & { flavor?: WasmFlavor } = {}): StockfishEngine {
  const require = createRequire(import.meta.url);
  const stockfish = require("stockfish") as { findEngine(flavor: string): string };
  const enginePath = stockfish.findEngine(opts.flavor ?? "full");
  return new StockfishEngine(spawnTransport(process.execPath, [enginePath]), opts);
}

/** A native Stockfish binary, e.g. from Homebrew. */
export function createNativeEngine(binaryPath: string, opts: StockfishOptions = {}): StockfishEngine {
  return new StockfishEngine(spawnTransport(binaryPath), opts);
}

/** Uses native Stockfish when STOCKFISH_PATH is set, otherwise WASM. */
export function createEngineFromEnv(opts: StockfishOptions = {}): StockfishEngine {
  const path = process.env.STOCKFISH_PATH;
  return path ? createNativeEngine(path, opts) : createWasmEngine(opts);
}
