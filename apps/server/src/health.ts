import type { AnalyzeOptions } from "@chess-tutor/engine";
import type { GameStore } from "./store.ts";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const DEFAULT_HEALTH_TIMEOUT_MS = 5000;

export type HealthStatus = { ok: true; engine: "ready" } | { ok: false; reason: string };

/** Answers GET /api/health. Never rejects. */
export type HealthProbe = () => Promise<HealthStatus>;

/** The slice of the engine the probe uses (StockfishEngine fits). */
export interface HealthEngine {
  analyze(fen: string, opts?: AnalyzeOptions): Promise<unknown>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Health probe (architecture §6.1, NFR-13): the store answers a trivial read, then the
 * engine answers a depth-1 search on the start position within `timeoutMs`. The search
 * goes through the engine's normal queue, so it stays cheap: concurrent probes share one
 * search, and a search that timed out but is still queued is reused rather than stacked
 * behind (a stuck engine never gets more than one health search queued).
 */
export function createHealthProbe(deps: {
  engine: HealthEngine;
  store: Pick<GameStore, "get">;
  timeoutMs?: number;
}): HealthProbe {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  let inFlight: Promise<void> | null = null;

  function search(): Promise<void> {
    if (inFlight) return inFlight;
    let p: Promise<void>;
    try {
      p = deps.engine.analyze(START_FEN, { depth: 1 }).then(() => undefined);
    } catch (err) {
      p = Promise.reject(err);
    }
    const current = p.finally(() => {
      if (inFlight === current) inFlight = null;
    });
    inFlight = current;
    return current;
  }

  return async () => {
    try {
      deps.store.get("__health__");
    } catch (err) {
      return { ok: false, reason: `store not open: ${message(err)}` };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([search().then(() => "ready" as const), timeout]);
      if (outcome === "timeout") {
        return { ok: false, reason: `engine did not answer a depth-1 search within ${timeoutMs} ms` };
      }
      return { ok: true, engine: "ready" };
    } catch (err) {
      return { ok: false, reason: `engine error: ${message(err)}` };
    } finally {
      clearTimeout(timer);
    }
  };
}
