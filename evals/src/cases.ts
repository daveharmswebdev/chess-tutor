import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "./types.ts";

/** Files in evals/cases/ that are not cases. */
const NOT_CASES = new Set(["sequences.json"]);

export const KINDS = ["opponent_left_book", "player_blunder", "missed_win", "punish_opponent", "hint"] as const;

export function loadCases(dir: string): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !NOT_CASES.has(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalCase);
}

/**
 * --cases: a kind ("hint"), an id glob ("pb-kid-*", "*qd6*"), or a comma-separated list of
 * either. Undefined selects every case.
 */
export function selectCases(cases: EvalCase[], filter: string | undefined): EvalCase[] {
  if (!filter) return cases;
  const parts = filter.split(",").map((p) => p.trim()).filter(Boolean);
  const globs = parts.map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`));
  return cases.filter((c) => parts.includes(c.kind) || globs.some((g) => g.test(c.id)));
}
