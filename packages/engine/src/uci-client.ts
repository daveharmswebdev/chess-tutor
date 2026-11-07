import type { Transport } from "./transport.ts";
import { parseBestMove, parseInfo, type UciInfo } from "./uci-parser.ts";

export interface SearchResult {
  bestMove: string;
  /** The last complete (non-bound) info line for each multipv rank. */
  lines: Map<number, UciInfo>;
  timeMs: number;
}

/**
 * Talks UCI over a Transport. A UCI engine can run only one search at a time,
 * so every command goes through a FIFO queue. Callers simply await.
 */
export class UciClient {
  private readonly transport: Transport;
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: { match: (line: string) => boolean; resolve: () => void } | null = null;
  private lineHandler: ((line: string) => void) | null = null;
  private exited = false;
  private failCurrent: ((err: Error) => void) | null = null;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onLine((line) => {
      this.lineHandler?.(line);
      if (this.waiter?.match(line)) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve();
      }
    });
    transport.onExit((code) => {
      this.exited = true;
      this.failCurrent?.(new Error(`Engine process exited (code ${code})`));
    });
  }

  /** Handshake: `uci` → `uciok`, then the given options, then `isready` → `readyok`. */
  init(options: Record<string, string | number | boolean> = {}): Promise<void> {
    return this.enqueue(async () => {
      await this.sendAndWait("uci", (l) => l === "uciok");
      for (const [name, value] of Object.entries(options)) {
        this.transport.send(`setoption name ${name} value ${value}`);
      }
      await this.sendAndWait("isready", (l) => l === "readyok");
    });
  }

  setOptions(options: Record<string, string | number | boolean>): Promise<void> {
    return this.enqueue(async () => {
      for (const [name, value] of Object.entries(options)) {
        this.transport.send(`setoption name ${name} value ${value}`);
      }
      await this.sendAndWait("isready", (l) => l === "readyok");
    });
  }

  /** Run `position fen <fen>` + `go <goArgs>`, collecting info lines until `bestmove`. */
  search(fen: string, goArgs: string, preOptions: Record<string, string | number | boolean> = {}): Promise<SearchResult> {
    return this.enqueue(async () => {
      for (const [name, value] of Object.entries(preOptions)) {
        this.transport.send(`setoption name ${name} value ${value}`);
      }
      await this.sendAndWait("isready", (l) => l === "readyok");

      const lines = new Map<number, UciInfo>();
      let bestMove = "";
      const started = performance.now();
      this.lineHandler = (line) => {
        const info = parseInfo(line);
        if (info?.pv && info.score && !info.bound) lines.set(info.multipv ?? 1, info);
        const bm = parseBestMove(line);
        if (bm) bestMove = bm.move;
      };
      try {
        this.transport.send(`position fen ${fen}`);
        await this.sendAndWait(`go ${goArgs}`, (l) => l.startsWith("bestmove"));
      } finally {
        this.lineHandler = null;
      }
      return { bestMove, lines, timeMs: Math.round(performance.now() - started) };
    });
  }

  quit(): void {
    if (!this.exited) this.transport.send("quit");
    this.transport.close();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private sendAndWait(command: string, match: (line: string) => boolean): Promise<void> {
    if (this.exited) return Promise.reject(new Error("Engine process has exited"));
    return new Promise<void>((resolve, reject) => {
      this.waiter = { match, resolve };
      this.failCurrent = (err) => {
        this.waiter = null;
        reject(err);
      };
      this.transport.send(command);
    });
  }
}
