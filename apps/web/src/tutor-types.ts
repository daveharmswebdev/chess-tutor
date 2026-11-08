// Tutor types from the api.ts contract (#7). packages/chess-core's index exports GameView and
// GameEvent but not TutorStatus, TutorQuestion or TutorReveal, so they are derived here from the
// exported types. Once the index re-exports them, this file can re-export them instead.
import type { GameEvent, GameView } from "@chess-tutor/chess-core";

export type TutorStatus = GameView["tutor"];
export type TutorQuestion = NonNullable<TutorStatus["question"]>;
export type TutorReveal = Extract<GameEvent, { type: "tutor_reveal" }>["reveal"];
export type TutorArrow = TutorQuestion["arrows"][number];
