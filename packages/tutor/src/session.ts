import type { TutorDeps, TutorGame, TutorSession } from "./contract.ts";

/** Placeholder until #7 lands: the tool loop goes here (tutor-agent). */
export function createTutorSession(_deps: TutorDeps, _game: TutorGame): TutorSession {
  return {
    async ask() {
      throw new Error("tutor not implemented yet (#7)");
    },
  };
}
