import { Chess } from "chess.js";
import type { BotMove, GameEvent, GameView, SparringBot } from "@chess-tutor/chess-core";

/**
 * Deterministic fake sparring bot. Plays the next scripted UCI move if it is legal,
 * else the first legal move in chess.js order. Optional delay, or a gate the test
 * releases by hand to hold the bot "thinking".
 */
export interface FakeBot extends SparringBot {
  calls: string[];
  /** Hold every search until release() is called. */
  hold(): void;
  release(): void;
  failNext(message: string): void;
  /** The next search returns this UCI as-is, without checking it (to test FR-10 handling). */
  illegalNext(uci: string): void;
}

export function createFakeBot(script: string[] = [], delayMs = 0): FakeBot {
  const queue = [...script];
  const calls: string[] = [];
  let held = false;
  let waiters: (() => void)[] = [];
  let failure: string | null = null;
  let illegal: string | null = null;
  return {
    calls,
    hold() {
      held = true;
    },
    release() {
      held = false;
      const w = waiters;
      waiters = [];
      for (const fn of w) fn();
    },
    failNext(message) {
      failure = message;
    },
    illegalNext(uci) {
      illegal = uci;
    },
    async chooseMove(fen): Promise<BotMove> {
      calls.push(fen);
      if (failure !== null) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      if (illegal !== null) {
        const uci = illegal;
        illegal = null;
        return { uci, san: "??", source: "engine", fallbackReason: "unavailable" };
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (held) await new Promise<void>((r) => waiters.push(r));
      const chess = new Chess(fen);
      const legal = chess.moves({ verbose: true });
      let move = legal[0]!;
      const next = queue.shift();
      if (next !== undefined) {
        const scripted = legal.find((m) => m.from + m.to + (m.promotion ?? "") === next);
        if (scripted) move = scripted;
      }
      return {
        uci: move.from + move.to + (move.promotion ?? ""),
        san: move.san,
        source: "engine",
        fallbackReason: "unavailable",
      };
    },
  };
}

/** Collects events for one game and lets a test wait for a given type. */
export function eventCollector() {
  const events: GameEvent[] = [];
  let waiters: { type: GameEvent["type"]; resolve: (e: GameEvent) => void; seen: number }[] = [];
  return {
    events,
    push(e: GameEvent) {
      events.push(e);
      waiters = waiters.filter((w) => {
        const matches = events.filter((x) => x.type === w.type);
        if (matches.length > w.seen) {
          w.resolve(matches[w.seen]!);
          return false;
        }
        return true;
      });
    },
    /** Resolves with the n-th (0-based) event of this type. */
    next(type: GameEvent["type"], n = 0, timeoutMs = 3000): Promise<GameEvent> {
      const matches = events.filter((x) => x.type === type);
      if (matches.length > n) return Promise.resolve(matches[n]!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type} #${n}`)), timeoutMs);
        waiters.push({
          type,
          seen: n,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
  };
}

export function ucis(game: GameView): string[] {
  return game.moves.map((m) => m.uci);
}
