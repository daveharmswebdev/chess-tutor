import { Chess } from "chess.js";
import type { Analysis, BotMove, Color, GameEvent, GameView, SparringBot } from "@chess-tutor/chess-core";
import type {
  TutorFailureReason,
  TutorOutcome,
  TutorReply,
  TutorRequest,
  TutorSession,
  TutorUsage,
} from "@chess-tutor/tutor";

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

// ---------------------------------------------------------------------------
// Coaching fakes (#7): an analyzer with scripted evaluations and a scripted TutorSession.

/** FEN after playing these UCI moves from the start position. */
export function fenAfter(moves: string[]): string {
  const chess = new Chess();
  for (const uci of moves) {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length === 5 ? { promotion: uci[4] } : {}) });
  }
  return chess.fen();
}

export interface FakeAnalyzer {
  analyze(fen: string): Promise<Analysis>;
  calls: string[];
  /** White-relative centipawns for a position (default 0), and optionally its best move. */
  set(fen: string, cp: number, bestMove?: string): void;
  hold(): void;
  release(): void;
}

/**
 * Every position scores 0 cp with the first legal move as best, unless set() says otherwise.
 * One line per analysis, so the detector compares the best line with the analysis after the move.
 */
export function createFakeAnalyzer(): FakeAnalyzer {
  const scores = new Map<string, { cp: number; best: string | undefined }>();
  const calls: string[] = [];
  let held = false;
  let waiters: (() => void)[] = [];
  return {
    calls,
    set(fen, cp, best) {
      scores.set(fen, { cp, best });
    },
    hold() {
      held = true;
    },
    release() {
      held = false;
      const w = waiters;
      waiters = [];
      for (const fn of w) fn();
    },
    async analyze(fen) {
      calls.push(fen);
      if (held) await new Promise<void>((r) => waiters.push(r));
      const chess = new Chess(fen);
      const legal = chess.moves({ verbose: true });
      const entry = scores.get(fen);
      const first = legal[0];
      if (!first) return { fen, depth: 0, lines: [], bestMove: "", timeMs: 0 };
      const bestMove = entry?.best ?? first.from + first.to + (first.promotion ?? "");
      return {
        fen,
        depth: 10,
        lines: [{ rank: 1, moves: [bestMove], score: { kind: "cp", value: entry?.cp ?? 0 }, depth: 10 }],
        bestMove,
        timeMs: 1,
      };
    },
  };
}

export const NO_USAGE: TutorUsage = {
  requests: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export function okOutcome(reply: Partial<TutorReply> = {}): TutorOutcome {
  return {
    ok: true,
    reply: {
      schemaVersion: 1,
      kind: "player_blunder",
      message: "What does your move leave undefended?",
      reveal: null,
      revealMove: null,
      arrows: [],
      ...reply,
    },
    usage: NO_USAGE,
    ms: 5,
  };
}

export function failOutcome(reason: TutorFailureReason, message = "raw failure text"): TutorOutcome {
  return { ok: false, reason, message, usage: NO_USAGE, ms: 5 };
}

export interface FakeAsk {
  request: TutorRequest;
  signal: AbortSignal | undefined;
  progress(label: string): void;
  resolve(outcome: TutorOutcome): void;
  reject(err: unknown): void;
}

export interface FakeTutor {
  createSession(game: { id: string; playerColor: Color }): TutorSession;
  sessions: { id: string; playerColor: Color }[];
  asks: FakeAsk[];
  /** Resolves with the n-th (0-based) ask once it has been made. */
  ask(n: number, timeoutMs?: number): Promise<FakeAsk>;
  /** When set, every ask resolves at once with this (after the autoProgress labels). */
  auto: ((request: TutorRequest) => TutorOutcome) | null;
  autoProgress: string[];
}

/** A scripted tutor: asks wait for the test to resolve them, unless `auto` is set. */
export function createFakeTutor(): FakeTutor {
  const asks: FakeAsk[] = [];
  const tutor: FakeTutor = {
    sessions: [],
    asks,
    auto: null,
    autoProgress: [],
    createSession(game) {
      tutor.sessions.push(game);
      return {
        ask(request, onProgress, signal) {
          return new Promise<TutorOutcome>((resolve, reject) => {
            const ask: FakeAsk = { request, signal, progress: (label) => onProgress({ label }), resolve, reject };
            asks.push(ask);
            if (tutor.auto) {
              for (const label of tutor.autoProgress) ask.progress(label);
              resolve(tutor.auto(request));
            }
          });
        },
      };
    },
    async ask(n, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (asks.length <= n) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ask #${n} (have ${asks.length})`);
        await new Promise((r) => setTimeout(r, 5));
      }
      return asks[n]!;
    },
  };
  return tutor;
}
