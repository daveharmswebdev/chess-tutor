// The demo's x-demo-token (#59: FR-27, FR-28): added only when DEMO_TOKEN is set, and only to
// the new-game request (POST /api/games), never to moves, events or other requests.
import { describe, expect, it } from "vitest";
import { DEMO_TOKEN_HEADER, demoTokenHeaders, isNewGameRequest } from "../demo/demo-token.ts";

describe("isNewGameRequest", () => {
  it("is POST /api/games only", () => {
    expect(isNewGameRequest("POST", "http://localhost:5173/api/games")).toBe(true);
    expect(isNewGameRequest("post", "https://example.test/api/games?x=1")).toBe(true);
    expect(isNewGameRequest("GET", "http://localhost:5173/api/games")).toBe(false);
    expect(isNewGameRequest("POST", "http://localhost:5173/api/games/abc/moves")).toBe(false);
    expect(isNewGameRequest("POST", "http://localhost:5173/api/games/abc/tutor/hint")).toBe(false);
    expect(isNewGameRequest("GET", "http://localhost:5173/api/games/abc/events")).toBe(false);
    expect(isNewGameRequest("POST", "http://localhost:5173/games")).toBe(false);
  });
});

describe("demoTokenHeaders", () => {
  const base = { "content-type": "application/json" };

  it("adds the header to the new-game POST when DEMO_TOKEN is set", () => {
    expect(DEMO_TOKEN_HEADER).toBe("x-demo-token");
    expect(demoTokenHeaders("POST", "http://h/api/games", base, "t0k")).toEqual({ ...base, "x-demo-token": "t0k" });
  });

  it("leaves every other request alone (null: continue unchanged)", () => {
    expect(demoTokenHeaders("POST", "http://h/api/games/abc/moves", base, "t0k")).toBeNull();
    expect(demoTokenHeaders("GET", "http://h/api/games", base, "t0k")).toBeNull();
  });

  it("adds nothing when DEMO_TOKEN is unset or empty", () => {
    expect(demoTokenHeaders("POST", "http://h/api/games", base, undefined)).toBeNull();
    expect(demoTokenHeaders("POST", "http://h/api/games", base, "")).toBeNull();
  });
});
