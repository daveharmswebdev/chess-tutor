/**
 * The numbers for /retro, computed the same way every time from .claude/orchestration/log.jsonl.
 *
 *   node --no-warnings .claude/scripts/retro-stats.ts                 # whole log
 *   node --no-warnings .claude/scripts/retro-stats.ts --since <iso>   # only entries after a timestamp
 *   node --no-warnings .claude/scripts/retro-stats.ts --json          # machine-readable
 *
 * The previous retro's window end is recorded in the cycle ledger ("Window end: <iso>").
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..", "..");
const { values } = parseArgs({ options: { since: { type: "string" }, json: { type: "boolean", default: false } } });

type Entry = Record<string, unknown> & { ts: string; event: string };
const all = readFileSync(join(ROOT, ".claude", "orchestration", "log.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Entry);
const entries = values.since ? all.filter((e) => e.ts > values.since!) : all;

const count = <T extends string>(xs: T[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});

/** Why a return was rejected, by class: the thing a template or rule would have to fix. */
function errorClass(err: string): string {
  if (/gate' check failed/.test(err)) return "gate failed (real catch)";
  if (/is not an agent in ownership/.test(err)) return "unknown owner name";
  if (/must be equal to one of the allowed values/.test(err)) return "enum spelling";
  if (/must have required property/.test(err)) return "missing field";
  if (/must NOT have additional properties/.test(err)) return "extra field";
  if (/must commit|head_sha/.test(err)) return "no commit / head_sha";
  if (/fence|json block|outside the/.test(err)) return "fencing";
  return "other";
}

const verdicts = entries.filter((e) => e.event === "coordinator_verdict");
const invalid = entries.filter((e) => e.event === "return_invalid" || e.event === "contract_failed");
const valid = entries.filter((e) => e.event === "return_valid");
const decided = verdicts.filter((v) => v.verdict !== "review");
const withCost = verdicts.filter((v) => typeof v.tokens === "number");

// One rejected return can carry several errors of the same class; count classes once per return.
const invalidClasses = invalid.flatMap((e) => [...new Set(((e.errors as string[]) ?? []).map(errorClass))]);

const stats = {
  window: { since: values.since ?? entries[0]?.ts ?? null, until: entries.at(-1)?.ts ?? null, entries: entries.length },
  dispatches: entries.filter((e) => e.event === "dispatch" && e.spoke).length,
  shipped: entries.filter((e) => e.event === "shipped").map((e) => `#${e.issue} → PR #${e.pr}`),
  verdicts: count(decided.map((v) => String(v.verdict))),
  firstRoundAcceptance: (() => {
    const r1 = decided.filter((v) => /-r1$/.test(String(v.brief_id)));
    const ok = r1.filter((v) => v.verdict === "accepted").length;
    return r1.length ? `${ok}/${r1.length}` : "n/a";
  })(),
  redelegations: decided.filter((v) => v.verdict === "re-delegated").map((v) => `${v.brief_id}: ${v.reason}`),
  returns: { valid: valid.length, rejected: invalid.length, byClass: count(invalidClasses) },
  rejectedByAgent: count(invalid.map((e) => String(e.agent_type))),
  editDenied: entries.filter((e) => e.event === "edit_denied").length,
  dispatchDenied: entries.filter((e) => e.event === "dispatch_denied").length,
  cost: {
    roundsWithCost: withCost.length,
    roundsWithoutCost: verdicts.length - withCost.length,
    byAgent: Object.fromEntries(
      Object.entries(
        withCost.reduce<Record<string, { n: number; tokens: number; ms: number }>>((a, v) => {
          const k = String(v.agent ?? "unknown");
          a[k] ??= { n: 0, tokens: 0, ms: 0 };
          a[k].n++;
          a[k].tokens += v.tokens as number;
          a[k].ms += typeof v.duration_ms === "number" ? v.duration_ms : 0;
          return a;
        }, {}),
      ).map(([k, a]) => [k, { rounds: a.n, avgTokens: Math.round(a.tokens / a.n), avgSeconds: Math.round(a.ms / a.n / 1000) }]),
    ),
  },
};

if (values.json) {
  console.log(JSON.stringify(stats, null, 2));
} else {
  const s = stats;
  console.log(`Window: ${s.window.since} → ${s.window.until} (${s.window.entries} log entries)`);
  console.log(`Spoke dispatches: ${s.dispatches} · shipped: ${s.shipped.join(", ") || "none"}`);
  console.log(`Verdicts: ${JSON.stringify(s.verdicts)} · first-round acceptance: ${s.firstRoundAcceptance}`);
  console.log(`Returns: ${s.returns.valid} valid, ${s.returns.rejected} rejected · by class: ${JSON.stringify(s.returns.byClass)}`);
  console.log(`Rejected by agent: ${JSON.stringify(s.rejectedByAgent)} · edits denied: ${s.editDenied} · dispatches denied: ${s.dispatchDenied}`);
  console.log(`Cost: ${s.cost.roundsWithCost} rounds with figures, ${s.cost.roundsWithoutCost} without · ${JSON.stringify(s.cost.byAgent)}`);
  console.log("Re-delegations:");
  for (const r of s.redelegations) console.log(`  - ${r}`);
}
