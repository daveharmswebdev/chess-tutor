import type { GameView, MoveView } from "@chess-tutor/chess-core";
import type { TutorQuestion, TutorReveal, TutorStatus } from "../src/tutor-types.ts";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const AFTER_D4_FEN = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
export const AFTER_D4_D5_FEN = "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2";

export const D4: MoveView = { uci: "d2d4", san: "d4", by: "player" };
export const D5: MoveView = { uci: "d7d5", san: "d5", by: "bot" };
export const BF4: MoveView = { uci: "c1f4", san: "Bf4", by: "player" };
export const NF3: MoveView = { uci: "g1f3", san: "Nf3", by: "player" };

/** Coaching available and idle: the default for games in tests. */
export function tutorStatus(overrides: Partial<TutorStatus> = {}): TutorStatus {
  return { available: true, reason: null, thinking: false, question: null, ...overrides };
}

export function question(overrides: Partial<TutorQuestion> = {}): TutorQuestion {
  return {
    id: "q1",
    kind: "opponent_left_book",
    message: "Your opponent left the book. Which piece wants to come out next?",
    arrows: [{ from: "c1", to: "f4" }],
    attemptFen: AFTER_D4_D5_FEN,
    canReveal: true,
    ...overrides,
  };
}

export function reveal(overrides: Partial<TutorReveal> = {}): TutorReveal {
  return {
    questionId: "q1",
    text: "Bf4 is the London move: the bishop comes out before e3.",
    move: BF4,
    arrows: [{ from: "c1", to: "f4" }],
    ...overrides,
  };
}

export function view(overrides: Partial<GameView> = {}): GameView {
  return {
    id: "g1",
    playerColor: "w",
    fen: START_FEN,
    moves: [],
    status: "playing",
    result: "*",
    endReason: null,
    botThinking: false,
    tutor: tutorStatus(),
    ...overrides,
  };
}
