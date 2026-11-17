// Demo step helpers (#59: FR-27): every failure names a specific reason, and the video is saved
// even when quitting the engine fails.
import { describe, expect, it } from "vitest";
import { showMeProblem, teardown, tutorProblem } from "../demo/steps.ts";

describe("tutorProblem", () => {
  it("is null when the panel shows no failure, refusal or 'coaching off'", () => {
    expect(tutorProblem("Hint", {})).toBeNull();
    expect(tutorProblem("Hint", { failed: null, unavailable: null, notice: null })).toBeNull();
  });

  it("names the step and every visible reason with its text", () => {
    expect(tutorProblem("the tutor's question", { unavailable: "Coaching is off: no API key is set." })).toBe(
      "demo stopped at the tutor's question: tutor-unavailable: Coaching is off: no API key is set.",
    );
    // A rejected key shows both tutor-failed and tutor-unavailable.
    expect(tutorProblem("Hint", { failed: "The key was rejected.", unavailable: "Coaching is off." })).toBe(
      "demo stopped at Hint: tutor-failed: The key was rejected.; tutor-unavailable: Coaching is off.",
    );
  });

  it("reports a refused Hint or Show me (tutor-notice)", () => {
    expect(tutorProblem("Show me", { notice: "The tutor is busy right now." })).toBe(
      "demo stopped at Show me: tutor-notice: The tutor is busy right now.",
    );
  });
});

describe("showMeProblem", () => {
  it("is null when Show me is there and enabled", () => {
    expect(showMeProblem({ visible: true, enabled: true })).toBeNull();
  });

  it("explains a missing or disabled Show me", () => {
    expect(showMeProblem({ visible: false, enabled: false })).toMatch(/Show me is not shown: no open question/);
    expect(showMeProblem({ visible: true, enabled: false })).toMatch(/Show me is disabled: the hint reply holds no reveal/);
  });
});

describe("teardown", () => {
  it("saves the video before quitting the engine", async () => {
    const order: string[] = [];
    const errors = await teardown({
      saveVideo: async () => void order.push("video"),
      quitEngine: async () => void order.push("quit"),
    });
    expect(order).toEqual(["video", "quit"]);
    expect(errors).toEqual([]);
  });

  it("keeps the video when engine.quit() rejects, and reports the quit error", async () => {
    let saved = false;
    const errors = await teardown({
      saveVideo: async () => {
        saved = true;
      },
      quitEngine: async () => {
        throw new Error("engine gone");
      },
    });
    expect(saved).toBe(true);
    expect(errors.map(String)).toEqual(["Error: engine gone"]);
  });

  it("still quits the engine when saving the video fails", async () => {
    let quit = false;
    const errors = await teardown({
      saveVideo: async () => {
        throw new Error("disk full");
      },
      quitEngine: async () => {
        quit = true;
      },
    });
    expect(quit).toBe(true);
    expect(errors.map(String)).toEqual(["Error: disk full"]);
  });
});
