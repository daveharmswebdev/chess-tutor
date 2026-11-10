import { describe, expect, it } from "vitest";
import { computeMetrics, gateDecision, gateMisses } from "../src/report.ts";
import type { RunMetrics } from "../src/types.ts";

/** The --gate decision of `pnpm eval` (NFR-6, NFR-7, NFR-10; #29). */

const metrics = (over: Partial<RunMetrics>): RunMetrics => ({ ...computeMetrics([]), graded: 40, moveLegalPct: 1, evalMatchPct: 1, noGiveAwayPct: 0.95, ...over });

describe("gateMisses", () => {
  it("is empty when every threshold is met", () => {
    expect(gateMisses(metrics({}))).toEqual([]);
    expect(gateMisses(metrics({ noGiveAwayPct: 0.9 }))).toEqual([]);
  });

  it("names a move legality below 100%", () => {
    const misses = gateMisses(metrics({ moveLegalPct: 0.97 }));
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatch(/NFR-6 move legality 97% < 100%/);
  });

  it("names an eval match below 100%", () => {
    const misses = gateMisses(metrics({ evalMatchPct: 0.975 }));
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatch(/NFR-6 eval match 97\.5% < 100%/);
  });

  it("names NFR-7 below its 90% target", () => {
    const misses = gateMisses(metrics({ noGiveAwayPct: 0.875 }));
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatch(/NFR-7 no give-away 87\.5% < 90%/);
  });

  it("names every missed threshold, one line each", () => {
    expect(gateMisses(metrics({ moveLegalPct: 0.9, evalMatchPct: 0.8, noGiveAwayPct: 0.5 }))).toHaveLength(3);
  });

  it("counts a null metric with zero graded replies as a miss", () => {
    const misses = gateMisses(computeMetrics([]));
    expect(misses).toHaveLength(3);
    for (const m of misses) expect(m).toMatch(/n\/a \(0 graded replies\)/);
  });
});

describe("gateDecision", () => {
  const failing = metrics({ moveLegalPct: 0.97, noGiveAwayPct: 0.8 });

  it("with --gate exits 1 and prints one line per missed threshold", () => {
    const d = gateDecision(failing, true);
    expect(d.exitCode).toBe(1);
    expect(d.lines).toHaveLength(2);
    expect(d.lines.join("\n")).toMatch(/NFR-6 move legality/);
    expect(d.lines.join("\n")).toMatch(/NFR-7 no give-away/);
  });

  it("with --gate exits 0 when all thresholds are met", () => {
    expect(gateDecision(metrics({}), true)).toEqual({ exitCode: 0, lines: [] });
  });

  it("without --gate leaves the exit code and output unchanged", () => {
    expect(gateDecision(failing, false)).toEqual({ exitCode: 0, lines: [] });
    expect(gateDecision(computeMetrics([]), false)).toEqual({ exitCode: 0, lines: [] });
  });
});
