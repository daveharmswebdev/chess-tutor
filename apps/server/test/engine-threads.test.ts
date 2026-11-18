import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEngineThreads } from "../src/config.ts";

describe("loadEngineThreads: ENGINE_THREADS override (NFR-2, NFR-3, #36)", () => {
  let dir: string;
  let withThreads: string;
  let withoutThreads: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chess-tutor-threads-"));
    withThreads = join(dir, "with.json");
    withoutThreads = join(dir, "without.json");
    writeFileSync(withThreads, JSON.stringify({ engine: { threads: 4 } }));
    writeFileSync(withoutThreads, JSON.stringify({ engine: {} }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a positive integer in ENGINE_THREADS wins over the config", () => {
    expect(loadEngineThreads(withThreads, { ENGINE_THREADS: "2" })).toBe(2);
    expect(loadEngineThreads(withThreads, { ENGINE_THREADS: " 1 " })).toBe(1);
    expect(loadEngineThreads(withoutThreads, { ENGINE_THREADS: "8" })).toBe(8);
  });

  it("unset or blank falls back to config engine.threads", () => {
    expect(loadEngineThreads(withThreads, {})).toBe(4);
    expect(loadEngineThreads(withThreads, { ENGINE_THREADS: "" })).toBe(4);
    expect(loadEngineThreads(withThreads, { ENGINE_THREADS: "   " })).toBe(4);
    expect(loadEngineThreads(withThreads, { ENGINE_THREADS: undefined })).toBe(4);
    expect(loadEngineThreads(withoutThreads, {})).toBeUndefined();
  });

  it("any other value throws a clear error naming ENGINE_THREADS", () => {
    for (const bad of ["0", "abc", "1.5", "-2", "2x", "1e2", "+3", "0x4"]) {
      expect(() => loadEngineThreads(withThreads, { ENGINE_THREADS: bad }), bad).toThrow(/ENGINE_THREADS/);
      expect(() => loadEngineThreads(withThreads, { ENGINE_THREADS: bad }), bad).toThrow(JSON.stringify(bad));
    }
  });

  it("the default path still reads config/tutor.json", () => {
    expect(loadEngineThreads(undefined, {})).toBe(4);
  });
});
