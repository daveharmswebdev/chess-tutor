import { describe, expect, it } from "vitest";
import { gameReducer, initialGameState } from "../src/game-state.ts";
import { createStore } from "../src/store.ts";
import { view } from "./fixtures.ts";

describe("store", () => {
  it("applies actions synchronously and notifies subscribers until they unsubscribe", () => {
    const store = createStore(gameReducer, initialGameState);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.dispatch({ type: "game_started", game: view() });
    expect(store.getState().game?.id).toBe("g1");
    expect(calls).toBe(1);
    off();
    store.dispatch({ type: "select", square: "e2" });
    expect(store.getState().selected).toBe("e2");
    expect(calls).toBe(1);
  });

  it("does not notify when the reducer returns the same state", () => {
    const store = createStore(gameReducer, initialGameState);
    let calls = 0;
    store.subscribe(() => calls++);
    store.dispatch({ type: "server_event", event: { type: "state", game: view() } }); // no game yet: ignored
    expect(calls).toBe(0);
  });
});
