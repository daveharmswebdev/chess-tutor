import { describe, expect, it } from "vitest";
import { createShutdown } from "../src/shutdown.ts";

function harness(opts: { appClose?: () => Promise<void>; engineQuit?: () => Promise<void>; cacheClose?: () => void }) {
  const calls: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const shutdown = createShutdown({
    app: {
      close: async () => {
        calls.push("app");
        await opts.appClose?.();
      },
    },
    resources: [
      {
        name: "engine",
        close: async () => {
          calls.push("engine");
          await opts.engineQuit?.();
        },
      },
      {
        name: "explorer cache",
        close: () => {
          calls.push("explorer cache");
          opts.cacheClose?.();
        },
      },
      { name: "game store", close: () => void calls.push("game store") },
    ],
    log: { info() {}, error: (_obj, msg) => void errors.push(msg) },
    exit: (code) => void exits.push(code),
  });
  return { shutdown, calls, errors, exits };
}

describe("createShutdown", () => {
  it("closes the app, then every resource in order, then exits 0", async () => {
    const h = harness({});
    await h.shutdown("SIGTERM");
    expect(h.calls).toEqual(["app", "engine", "explorer cache", "game store"]);
    expect(h.exits).toEqual([0]);
    expect(h.errors).toEqual([]);
  });

  it("still closes the cache and store and exits when engine.quit() rejects", async () => {
    const h = harness({ engineQuit: () => Promise.reject(new Error("engine gone")) });
    await expect(h.shutdown("SIGINT")).resolves.toBeUndefined();
    expect(h.calls).toEqual(["app", "engine", "explorer cache", "game store"]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatch(/engine/);
    expect(h.exits).toEqual([1]);
  });

  it("still closes everything when app.close() and a sync close throw", async () => {
    const h = harness({
      appClose: () => Promise.reject(new Error("close failed")),
      cacheClose: () => {
        throw new Error("db locked");
      },
    });
    await h.shutdown("SIGTERM");
    expect(h.calls).toEqual(["app", "engine", "explorer cache", "game store"]);
    expect(h.errors).toHaveLength(2);
    expect(h.exits).toEqual([1]);
  });

  it("runs once even if signalled twice", async () => {
    const h = harness({});
    await Promise.all([h.shutdown("SIGINT"), h.shutdown("SIGTERM")]);
    expect(h.calls.filter((c) => c === "app")).toHaveLength(1);
    expect(h.exits).toEqual([0]);
  });
});
