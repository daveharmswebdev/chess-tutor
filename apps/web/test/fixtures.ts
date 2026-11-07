import type { GameView, MoveView } from "@chess-tutor/chess-core";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const AFTER_D4_FEN = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
export const AFTER_D4_D5_FEN = "rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2";

export const D4: MoveView = { uci: "d2d4", san: "d4", by: "player" };
export const D5: MoveView = { uci: "d7d5", san: "d5", by: "bot" };

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
    ...overrides,
  };
}
