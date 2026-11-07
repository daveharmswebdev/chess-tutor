// Game state for the board UI: a pure reducer plus selectors, no DOM. FR-1, FR-4, IR-5.
// The server's GameView is the truth; the client only adds an optimistic position while a
// move request is in flight, a selected square, a busy flag and the last error.
// Ordering (#23): an HTTP reply can arrive after SSE events caused by the same request. SSE is
// the newer source, so once an SSE event arrives during a request, that request's reply only
// clears busy and pendingFen and keeps the SSE-derived game and error.
import type { GameEvent, GameView } from "@chess-tutor/chess-core";
import { sideToMove } from "./chess-rules.ts";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface GameState {
  game: GameView | null;
  /** Position shown while the player's move is in flight; null otherwise. */
  pendingFen: string | null;
  /** A request (new game, move, takeback, resign, bot retry) is in flight. */
  busy: boolean;
  /** Last error for the status line; cleared by the next successful update. */
  error: string | null;
  /** Square selected for click-to-move. */
  selected: string | null;
  /** An SSE event for this game arrived since the current request started (#23). */
  sseSinceRequest: boolean;
}

export type GameAction =
  | { type: "request_started" }
  | { type: "game_started"; game: GameView }
  | { type: "move_attempted"; uci: string; fen: string }
  | { type: "move_accepted"; game: GameView }
  | { type: "move_rejected"; message: string }
  | { type: "request_succeeded"; game: GameView }
  | { type: "request_failed"; message: string }
  | { type: "server_event"; event: GameEvent }
  | { type: "connection_lost"; message: string }
  | { type: "select"; square: string | null };

export const initialGameState: GameState = {
  game: null,
  pendingFen: null,
  busy: false,
  error: null,
  selected: null,
  sseSinceRequest: false,
};

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "request_started":
      return { ...state, busy: true, error: null, sseSinceRequest: false };

    case "game_started":
      return { ...initialGameState, game: action.game };

    case "move_attempted":
      return { ...state, busy: true, error: null, selected: null, pendingFen: action.fen, sseSinceRequest: false };

    case "move_accepted": {
      if (!state.game || state.game.id !== action.game.id) return state; // late reply from an old game
      // SSE (a bot_move, or state + error from a bot failure) may overtake this response; keep it then.
      if (state.sseSinceRequest) return { ...state, busy: false, pendingFen: null };
      return { ...state, game: action.game, busy: false, pendingFen: null };
    }

    case "move_rejected":
      // Snap back: drop the optimistic position, the board shows the server's FEN again.
      return { ...state, busy: false, pendingFen: null, selected: null, error: action.message };

    case "request_succeeded":
      if (state.game && state.game.id !== action.game.id) return state;
      if (state.sseSinceRequest) return { ...state, busy: false, pendingFen: null, selected: null };
      return { ...state, game: action.game, busy: false, pendingFen: null, selected: null, error: null };

    case "request_failed":
      return { ...state, busy: false, pendingFen: null, error: action.message };

    case "connection_lost":
      return { ...state, error: action.message };

    case "select":
      return { ...state, selected: action.square };

    case "server_event": {
      const event = action.event;
      // The controller only forwards events from the current game's stream.
      if (event.type === "error") return { ...state, error: event.message, sseSinceRequest: true };
      if (!state.game || state.game.id !== event.game.id) return state;
      const overtakesPending = state.pendingFen !== null && event.game.moves.length > state.game.moves.length;
      return {
        ...state,
        game: event.game,
        error: null,
        pendingFen: overtakesPending ? null : state.pendingFen,
        selected: event.game.fen === state.game.fen ? state.selected : null,
        sseSinceRequest: true,
      };
    }
  }
}

/** The position to draw. */
export function boardFen(state: GameState): string {
  return state.pendingFen ?? state.game?.fen ?? START_FEN;
}

/** True when the board should accept a move from the player. */
export function isPlayersTurn(state: GameState): boolean {
  const g = state.game;
  return (
    g !== null &&
    g.status === "playing" &&
    !g.botThinking &&
    !state.busy &&
    state.pendingFen === null &&
    sideToMove(g.fen) === g.playerColor
  );
}

export function canTakeback(state: GameState): boolean {
  const g = state.game;
  return (
    g !== null &&
    g.status === "playing" &&
    !g.botThinking &&
    !state.busy &&
    state.pendingFen === null &&
    g.moves.some((m) => m.by === "player")
  );
}

/**
 * True when the bot should move but is not thinking: the state a bot failure leaves behind
 * (#23). The player can then ask the server to retry (POST /api/games/:id/bot-retry).
 */
export function canRetryBot(state: GameState): boolean {
  const g = state.game;
  return (
    g !== null &&
    g.status === "playing" &&
    !g.botThinking &&
    !state.busy &&
    state.pendingFen === null &&
    sideToMove(g.fen) !== g.playerColor
  );
}

export function canResign(state: GameState): boolean {
  const g = state.game;
  return g !== null && g.status === "playing" && !state.busy;
}

function resultText(game: GameView): string {
  const r = game.result;
  const playerWon = (r === "1-0" && game.playerColor === "w") || (r === "0-1" && game.playerColor === "b");
  switch (game.endReason) {
    case "checkmate":
      return playerWon ? `Checkmate. You win (${r}).` : `Checkmate. The bot wins (${r}).`;
    case "resigned":
      return playerWon ? `The bot resigned. You win (${r}).` : `You resigned. The bot wins (${r}).`;
    case "stalemate":
      return `Draw by stalemate (${r}).`;
    case "threefold_repetition":
      return `Draw by threefold repetition (${r}).`;
    case "insufficient_material":
      return `Draw by insufficient material (${r}).`;
    case "fifty_moves":
      return `Draw by the fifty-move rule (${r}).`;
    case "abandoned":
      return "Game abandoned.";
    case null:
      return `Game over (${r}).`;
  }
}

/** The status line: whose move it is, or the result and its reason. */
export function statusText(state: GameState): string {
  const g = state.game;
  if (!g) return "Choose a color and start a new game.";
  if (g.status === "abandoned") return "Game abandoned.";
  if (g.status === "finished") return resultText(g);
  if (g.botThinking || state.pendingFen !== null) return "Bot is thinking...";
  if (isPlayersTurn(state)) return "Your move.";
  if (canRetryBot(state)) return "The bot did not move. Retry the bot move.";
  return "Waiting for the server...";
}
