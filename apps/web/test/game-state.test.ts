import { describe, expect, it } from "vitest";
import {
  boardFen,
  canResign,
  canTakeback,
  gameReducer,
  initialGameState,
  isPlayersTurn,
  statusText,
  type GameState,
} from "../src/game-state.ts";
import { AFTER_D4_D5_FEN, AFTER_D4_FEN, D4, D5, START_FEN, view } from "./fixtures.ts";

function started(overrides: Parameters<typeof view>[0] = {}): GameState {
  return gameReducer(initialGameState, { type: "game_started", game: view(overrides) });
}

const thinkingAfterD4 = view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true });
const afterD5 = view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] });

describe("game reducer: before a game", () => {
  it("shows the start position, locked, with a prompt to start", () => {
    expect(boardFen(initialGameState)).toBe(START_FEN);
    expect(isPlayersTurn(initialGameState)).toBe(false);
    expect(canTakeback(initialGameState)).toBe(false);
    expect(canResign(initialGameState)).toBe(false);
    expect(statusText(initialGameState)).toBe("Choose a color and start a new game.");
  });
});

describe("game reducer: server events", () => {
  it("replaces the game on a state event", () => {
    const s = gameReducer(started(), { type: "server_event", event: { type: "state", game: afterD5 } });
    expect(s.game).toEqual(afterD5);
  });

  it("replaces the game on a bot_move event and unlocks the board", () => {
    let s = gameReducer(started(), { type: "move_accepted", game: thinkingAfterD4 });
    expect(isPlayersTurn(s)).toBe(false);
    s = gameReducer(s, { type: "server_event", event: { type: "bot_move", move: D5, game: afterD5 } });
    expect(s.game?.moves).toEqual([D4, D5]);
    expect(isPlayersTurn(s)).toBe(true);
    expect(statusText(s)).toBe("Your move.");
  });

  it("replaces the game on game_over and shows result and reason", () => {
    const over = view({ status: "finished", result: "0-1", endReason: "checkmate", moves: [D4, D5] });
    const s = gameReducer(started(), { type: "server_event", event: { type: "game_over", game: over } });
    expect(s.game).toEqual(over);
    expect(isPlayersTurn(s)).toBe(false);
    expect(canTakeback(s)).toBe(false);
    expect(canResign(s)).toBe(false);
    expect(statusText(s)).toBe("Checkmate. The bot wins (0-1).");
  });

  it("shows an error event without dropping the game", () => {
    const s = gameReducer(started(), { type: "server_event", event: { type: "error", message: "engine crashed" } });
    expect(s.error).toBe("engine crashed");
    expect(s.game?.id).toBe("g1");
  });

  it("clears a previous error when a new position arrives", () => {
    let s = gameReducer(started(), { type: "server_event", event: { type: "error", message: "x" } });
    s = gameReducer(s, { type: "server_event", event: { type: "state", game: afterD5 } });
    expect(s.error).toBeNull();
  });

  it("ignores events that belong to another game", () => {
    const other = view({ id: "old", fen: AFTER_D4_D5_FEN, moves: [D4, D5] });
    const before = started();
    const s = gameReducer(before, { type: "server_event", event: { type: "state", game: other } });
    expect(s).toBe(before);
  });
});

describe("game reducer: locking", () => {
  it("is the player's turn only when playing, not thinking, and their color is to move", () => {
    expect(isPlayersTurn(started())).toBe(true);
    expect(isPlayersTurn(started({ botThinking: true }))).toBe(false);
    expect(isPlayersTurn(started({ playerColor: "b" }))).toBe(false);
    expect(isPlayersTurn(started({ status: "abandoned" }))).toBe(false);
  });

  it("says the bot is thinking while botThinking", () => {
    expect(statusText(started({ playerColor: "b", botThinking: true }))).toBe("Bot is thinking...");
  });

  it("locks the board and buttons while a request is in flight", () => {
    const s = gameReducer(started({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }), { type: "request_started" });
    expect(isPlayersTurn(s)).toBe(false);
    expect(canTakeback(s)).toBe(false);
    expect(canResign(s)).toBe(false);
  });

  it("allows takeback only once the player has a move and the bot is not thinking", () => {
    expect(canTakeback(started())).toBe(false);
    expect(canTakeback(started({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true }))).toBe(false);
    expect(canTakeback(started({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }))).toBe(true);
    // Player is Black and only the bot has moved: nothing of the player's to undo.
    expect(canTakeback(started({ playerColor: "b", fen: AFTER_D4_FEN, moves: [{ ...D4, by: "bot" }] }))).toBe(false);
  });
});

describe("game reducer: moves and snap-back", () => {
  it("shows the attempted move at once and locks the board", () => {
    const s = gameReducer(started(), { type: "move_attempted", uci: "d2d4", fen: AFTER_D4_FEN });
    expect(boardFen(s)).toBe(AFTER_D4_FEN);
    expect(isPlayersTurn(s)).toBe(false);
    expect(statusText(s)).toBe("Bot is thinking...");
  });

  it("snaps back to the server's FEN after an illegal move and shows the reason", () => {
    let s = started();
    s = gameReducer(s, { type: "select", square: "d2" });
    s = gameReducer(s, { type: "move_attempted", uci: "d2d5", fen: "bogus" });
    s = gameReducer(s, { type: "move_rejected", message: "That move was not accepted: illegal" });
    expect(boardFen(s)).toBe(START_FEN);
    expect(s.error).toBe("That move was not accepted: illegal");
    expect(s.selected).toBeNull();
    expect(isPlayersTurn(s)).toBe(true);
  });

  it("takes the server's view when the move is accepted", () => {
    let s = gameReducer(started(), { type: "move_attempted", uci: "d2d4", fen: AFTER_D4_FEN });
    s = gameReducer(s, { type: "move_accepted", game: thinkingAfterD4 });
    expect(s.game).toEqual(thinkingAfterD4);
    expect(s.pendingFen).toBeNull();
    expect(boardFen(s)).toBe(AFTER_D4_FEN);
  });

  it("keeps the bot's reply when the SSE bot_move overtakes the move response", () => {
    let s = gameReducer(started(), { type: "move_attempted", uci: "d2d4", fen: AFTER_D4_FEN });
    s = gameReducer(s, { type: "server_event", event: { type: "bot_move", move: D5, game: afterD5 } });
    s = gameReducer(s, { type: "move_accepted", game: thinkingAfterD4 });
    expect(s.game).toEqual(afterD5);
    expect(boardFen(s)).toBe(AFTER_D4_D5_FEN);
    expect(isPlayersTurn(s)).toBe(true);
  });

  it("ignores a late move response from a previous game", () => {
    const s0 = started({ id: "g2" });
    const s = gameReducer(s0, { type: "move_accepted", game: thinkingAfterD4 });
    expect(s.game?.id).toBe("g2");
    expect(s.game?.moves).toEqual([]);
  });

  it("applies a takeback result even though it has fewer moves", () => {
    let s = started({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] });
    s = gameReducer(s, { type: "request_started" });
    s = gameReducer(s, { type: "request_succeeded", game: view() });
    expect(s.game?.moves).toEqual([]);
    expect(isPlayersTurn(s)).toBe(true);
  });

  it("shows a failed request's message and unlocks", () => {
    let s = gameReducer(started(), { type: "request_started" });
    s = gameReducer(s, { type: "request_failed", message: "Cannot reach the game server." });
    expect(s.error).toBe("Cannot reach the game server.");
    expect(s.busy).toBe(false);
  });

  it("starting a new game resets selection, error and pending move", () => {
    let s = gameReducer(started(), { type: "move_attempted", uci: "d2d4", fen: AFTER_D4_FEN });
    s = gameReducer(s, { type: "request_failed", message: "x" });
    s = gameReducer(s, { type: "game_started", game: view({ id: "g2", playerColor: "b", botThinking: true }) });
    expect(s).toEqual({ ...initialGameState, game: view({ id: "g2", playerColor: "b", botThinking: true }) });
  });
});

describe("game reducer: result texts", () => {
  const cases: Array<[Parameters<typeof view>[0], string]> = [
    [{ status: "finished", result: "1-0", endReason: "checkmate" }, "Checkmate. You win (1-0)."],
    [{ status: "finished", result: "1-0", endReason: "checkmate", playerColor: "b" }, "Checkmate. The bot wins (1-0)."],
    [{ status: "finished", result: "0-1", endReason: "resigned" }, "You resigned. The bot wins (0-1)."],
    [{ status: "finished", result: "1/2-1/2", endReason: "stalemate" }, "Draw by stalemate (1/2-1/2)."],
    [{ status: "finished", result: "1/2-1/2", endReason: "threefold_repetition" }, "Draw by threefold repetition (1/2-1/2)."],
    [{ status: "finished", result: "1/2-1/2", endReason: "insufficient_material" }, "Draw by insufficient material (1/2-1/2)."],
    [{ status: "finished", result: "1/2-1/2", endReason: "fifty_moves" }, "Draw by the fifty-move rule (1/2-1/2)."],
    [{ status: "abandoned", endReason: "abandoned" }, "Game abandoned."],
  ];
  it.each(cases)("%o -> %s", (overrides, text) => {
    expect(statusText(started(overrides))).toBe(text);
  });
});
