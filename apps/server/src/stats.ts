import type { DailyStats, UsageCounts } from "@chess-tutor/chess-core";
import type { ModelPrice } from "./config.ts";
import type { GameSource, UsageEvent, UsageLedger } from "./store.ts";

/*
 * GET /ops/daily-stats roll-up (FR-29, #60; NFR-5, NFR-15, FR-28). Pure functions over the
 * stored usage ledger, so the counting rules are tested without HTTP.
 */

export type { DailyStats, UsageCounts };

/** USD per million tokens by model id (config/models.json pricingPerMTok). */
export type Pricing = Record<string, ModelPrice>;

export const BOT_FAILED = "bot_failed";
/** Same value as games.ts CANCELLED_REASON: a ledger row for an ask the server cancelled. */
export const CANCELLED = "cancelled";

/** Nearest-rank percentile: the value at rank ceil(p * n) of the sorted values; null when empty. */
export function nearestRank(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The `date` query parameter: a real UTC day YYYY-MM-DD, not after today (UTC). Omitted means
 * yesterday (UTC). Anything else (malformed, impossible like 2026-02-30, repeated, future) is an error.
 */
export function parseStatsDate(value: unknown, now: Date): { date: string } | { error: string } {
  if (value === undefined) return { date: utcDay(new Date(now.getTime() - DAY_MS)) };
  if (typeof value !== "string" || !DATE_RE.test(value)) return { error: "date must be a UTC day, YYYY-MM-DD" };
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || utcDay(parsed) !== value) return { error: `date ${value} is not a real day` };
  if (value > utcDay(now)) return { error: `date ${value} is in the future` };
  return { date: value };
}

/** The half-open ISO range [start of day, start of next day) for a UTC day YYYY-MM-DD. */
export function dayRange(date: string): { from: string; to: string } {
  const from = new Date(`${date}T00:00:00.000Z`);
  return { from: from.toISOString(), to: new Date(from.getTime() + DAY_MS).toISOString() };
}

function emptyCounts(gamesStarted: number): UsageCounts {
  return {
    gamesStarted,
    tutorReplies: 0,
    tutorLatencyMs: { p50: null, p95: null },
    errors: {},
    claude: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, spendUsd: 0 },
  };
}

export interface DailyStatsInput {
  date: string;
  generatedAt: string;
  /** The day's ledger rows (any order). */
  events: readonly UsageEvent[];
  gamesStarted: Record<GameSource, number>;
  pricing: Pricing;
  /** Called once per call for each model with no price (null: rows with no model recorded); their tokens add 0 spend. */
  warnUnknownModel?: (model: string | null) => void;
}

/**
 * The counting rules (FR-29): replies are tutor rows with ok true, latency is nearest-rank over
 * their ms, errors are failed tutor rows by reason plus bot_failed rows (zero counts absent),
 * and claude sums every tutor row, failed and dropped asks included (NFR-5). Spend is priced
 * per row's model and rounded to 4 decimals at the end. Never copies a game id or any text.
 */
export function computeDailyStats(input: DailyStatsInput): DailyStats {
  const counts: Record<GameSource, UsageCounts> = {
    player: emptyCounts(input.gamesStarted.player),
    demo: emptyCounts(input.gamesStarted.demo),
  };
  const latencies: Record<GameSource, number[]> = { player: [], demo: [] };
  const spend: Record<GameSource, number> = { player: 0, demo: 0 };
  const unknown = new Set<string | null>();

  for (const e of input.events) {
    const source: GameSource = e.source === "demo" ? "demo" : "player";
    const c = counts[source];
    if (e.kind === BOT_FAILED) {
      c.errors[BOT_FAILED] = (c.errors[BOT_FAILED] ?? 0) + 1;
      continue;
    }
    if (e.ok) {
      c.tutorReplies++;
      latencies[source].push(e.ms);
    } else if (e.reason !== CANCELLED) {
      // An ask the server cancelled itself is not an error; its tokens still count below (review 088).
      const reason = e.reason ?? "unknown";
      c.errors[reason] = (c.errors[reason] ?? 0) + 1;
    }
    c.claude.requests += e.requests;
    c.claude.inputTokens += e.inputTokens;
    c.claude.outputTokens += e.outputTokens;
    c.claude.cacheReadInputTokens += e.cacheReadInputTokens;
    c.claude.cacheCreationInputTokens += e.cacheCreationInputTokens;
    const price = e.model === null ? undefined : Object.hasOwn(input.pricing, e.model) ? input.pricing[e.model] : undefined;
    if (!price) {
      unknown.add(e.model);
      continue;
    }
    spend[source] +=
      (e.inputTokens * price.input +
        e.outputTokens * price.output +
        e.cacheReadInputTokens * price.cacheRead +
        e.cacheCreationInputTokens * price.cacheWrite) /
      1e6;
  }

  for (const source of ["player", "demo"] as const) {
    counts[source].tutorLatencyMs = { p50: nearestRank(latencies[source], 0.5), p95: nearestRank(latencies[source], 0.95) };
    counts[source].claude.spendUsd = Math.round(spend[source] * 1e4) / 1e4;
  }
  for (const model of unknown) input.warnUnknownModel?.(model);

  return { version: 1, date: input.date, generatedAt: input.generatedAt, player: counts.player, demo: counts.demo };
}

/** The day's stats straight from the ledger (SQLite, IR-7). */
export function dailyStatsFromLedger(
  ledger: UsageLedger,
  opts: { date: string; now: Date; pricing: Pricing; warnUnknownModel?: (model: string | null) => void },
): DailyStats {
  const { from, to } = dayRange(opts.date);
  return computeDailyStats({
    date: opts.date,
    generatedAt: opts.now.toISOString(),
    events: ledger.usageBetween(from, to),
    gamesStarted: ledger.gamesStartedBetween(from, to),
    pricing: opts.pricing,
    ...(opts.warnUnknownModel ? { warnUnknownModel: opts.warnUnknownModel } : {}),
  });
}
