// Game state for the board UI: a pure reducer plus selectors, no DOM. FR-1, FR-4, IR-5.
// The server's GameView is the truth; the client only adds an optimistic position while a
// move request is in flight, a selected square, a busy flag and the last error.
// Ordering (#23): an HTTP reply can arrive after SSE events caused by the same request. SSE is
// the newer source, so once an SSE event arrives during a request, that request's reply only
// clears busy and pendingFen and keeps the SSE-derived game and error.
// Tutor (#7: FR-8, FR-11, FR-12, NFR-1, NFR-9): GameView.tutor is the truth. The tutor_* events
// patch it between "state" events, and `tutor` keeps what only the browser holds: the progress
// label, the last question (still shown after it closes), its reveal, the attempt result, a
// failure message and a notice from a refused Hint or Show me.
import type { GameEvent, GameView, MoveView } from "@chess-tutor/chess-core";
import { sideToMove } from "./chess-rules.ts";
import type { TutorQuestion, TutorReveal, TutorStatus } from "./tutor-types.ts";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface TutorAttemptResult {
  questionId: string;
  move: MoveView;
  correct: boolean;
  cpLoss: number;
}

export interface TutorPanelState {
  /** The last question shown; kept after it closes so its result and reveal still make sense. */
  question: TutorQuestion | null;
  /** The question is still open on the server (attempts count, Show me works, arrows drawn). */
  open: boolean;
  /** Latest tutor_progress label while the tutor is thinking. */
  progress: string | null;
  /** The reveal for `question`, from POST /tutor/reveal or a "tutor_reveal" event. */
  reveal: TutorReveal | null;
  attempt: TutorAttemptResult | null;
  /** tutor_failed message. */
  failed: string | null;
  /** A refused Hint or Show me (409, 503, network). */
  notice: string | null;
}

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
  /** A tutor_* event arrived since the current request started, so the reply's tutor is older. */
  tutorSinceRequest: boolean;
  tutor: TutorPanelState;
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
  | { type: "select"; square: string | null }
  /** The 200 TutorReveal from POST /tutor/reveal ("Show me"). */
  | { type: "tutor_reveal_received"; reveal: TutorReveal }
  /** A refused Hint or Show me; null clears it. */
  | { type: "tutor_notice"; message: string | null };

export const emptyTutorPanel: TutorPanelState = {
  question: null,
  open: false,
  progress: null,
  reveal: null,
  attempt: null,
  failed: null,
  notice: null,
};

export const initialGameState: GameState = {
  game: null,
  pendingFen: null,
  busy: false,
  error: null,
  selected: null,
  sseSinceRequest: false,
  tutorSinceRequest: false,
  tutor: emptyTutorPanel,
};

/** For a GameView without `tutor` (a server from before #7): no coaching, no reason given. */
const NO_TUTOR: TutorStatus = { available: false, reason: null, thinking: false, question: null };

/** The server's tutor status for the current game (patched by live tutor events). */
export function tutorStatusOf(state: GameState): TutorStatus {
  return state.game?.tutor ?? NO_TUTOR;
}

/** Brings the browser-side panel in line with a TutorStatus from the server. */
function syncTutor(panel: TutorPanelState, status: TutorStatus | undefined): TutorPanelState {
  const t = status ?? NO_TUTOR;
  const progress = t.thinking ? panel.progress : null;
  const q = t.question;
  if (!q) return panel.open || progress !== panel.progress ? { ...panel, open: false, progress } : panel;
  if (panel.question?.id === q.id) return { ...panel, question: q, open: true, progress };
  return { ...emptyTutorPanel, question: q, open: true, progress };
}

/** A GameView from an HTTP reply; keeps the newer tutor state when a tutor event came first. */
function applyReplyGame(state: GameState, game: GameView): Pick<GameState, "game" | "tutor"> {
  if (state.tutorSinceRequest && state.game) return { game: { ...game, tutor: state.game.tutor }, tutor: state.tutor };
  return { game, tutor: syncTutor(state.tutor, game.tutor) };
}

function patchTutor(game: GameView, patch: Partial<TutorStatus>): GameView {
  return { ...game, tutor: { ...(game.tutor ?? NO_TUTOR), ...patch } };
}

/** Same result for the HTTP reply and the "tutor_reveal" event, in either order. */
function applyReveal(state: GameState, reveal: TutorReveal): GameState {
  const t = state.tutor;
  if (!t.question || t.question.id !== reveal.questionId) return state;
  if (t.reveal?.questionId === reveal.questionId) return state;
  return { ...state, tutor: { ...t, reveal, notice: null } };
}

type TutorEvent = Exclude<GameEvent, { game: GameView } | { type: "error" }>;

function tutorEvent(state: GameState, game: GameView, event: TutorEvent): GameState {
  const t = state.tutor;
  const live = { ...state, tutorSinceRequest: true };
  switch (event.type) {
    case "tutor_thinking":
      return { ...live, game: patchTutor(game, { thinking: true }), tutor: { ...t, progress: null, failed: null, notice: null } };
    case "tutor_progress":
      return { ...live, tutor: { ...t, progress: event.label } };
    case "tutor_reply": {
      const q = event.question;
      const tutor: TutorPanelState =
        t.question?.id === q.id ? { ...t, question: q, open: true, progress: null } : { ...emptyTutorPanel, question: q, open: true };
      return { ...live, game: patchTutor(game, { thinking: false, question: q }), tutor };
    }
    case "tutor_failed":
      return { ...live, game: patchTutor(game, { thinking: false }), tutor: { ...t, progress: null, failed: event.message } };
    case "tutor_reveal": {
      const next = applyReveal(state, event.reveal);
      return next === state ? state : { ...next, tutorSinceRequest: true };
    }
    case "tutor_attempt": {
      if (!t.question || t.question.id !== event.questionId) return state;
      const { questionId, move, correct, cpLoss } = event;
      const closed = game.tutor?.question?.id === questionId ? patchTutor(game, { question: null }) : game;
      return { ...live, game: closed, tutor: { ...t, open: false, attempt: { questionId, move, correct, cpLoss }, notice: null } };
    }
  }
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "request_started":
      return { ...state, busy: true, error: null, sseSinceRequest: false, tutorSinceRequest: false };

    case "game_started":
      return { ...initialGameState, game: action.game, tutor: syncTutor(emptyTutorPanel, action.game.tutor) };

    case "move_attempted":
      return {
        ...state,
        busy: true,
        error: null,
        selected: null,
        pendingFen: action.fen,
        sseSinceRequest: false,
        tutorSinceRequest: false,
      };

    case "move_accepted": {
      if (!state.game || state.game.id !== action.game.id) return state; // late reply from an old game
      // SSE (a bot_move, or state + error from a bot failure) may overtake this response; keep it then.
      if (state.sseSinceRequest) return { ...state, busy: false, pendingFen: null };
      return { ...state, ...applyReplyGame(state, action.game), busy: false, pendingFen: null };
    }

    case "move_rejected":
      // Snap back: drop the optimistic position, the board shows the server's FEN again.
      return { ...state, busy: false, pendingFen: null, selected: null, error: action.message };

    case "request_succeeded":
      if (state.game && state.game.id !== action.game.id) return state;
      if (state.sseSinceRequest) return { ...state, busy: false, pendingFen: null, selected: null };
      return { ...state, ...applyReplyGame(state, action.game), busy: false, pendingFen: null, selected: null, error: null };

    case "request_failed":
      return { ...state, busy: false, pendingFen: null, error: action.message };

    case "connection_lost":
      return { ...state, error: action.message };

    case "select":
      return { ...state, selected: action.square };

    case "tutor_reveal_received":
      return applyReveal(state, action.reveal);

    case "tutor_notice":
      return state.tutor.notice === action.message ? state : { ...state, tutor: { ...state.tutor, notice: action.message } };

    case "server_event": {
      const event = action.event;
      // The controller only forwards events from the current game's stream.
      if (event.type === "error") return { ...state, error: event.message, sseSinceRequest: true };
      if (!state.game) return state;
      if (event.type !== "state" && event.type !== "bot_move" && event.type !== "game_over") {
        return tutorEvent(state, state.game, event);
      }
      if (state.game.id !== event.game.id) return state;
      const overtakesPending = state.pendingFen !== null && event.game.moves.length > state.game.moves.length;
      return {
        ...state,
        game: event.game,
        tutor: syncTutor(state.tutor, event.game.tutor),
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

/** Hint (FR-12): whenever the player may move and coaching is available and idle. */
export function canHint(state: GameState): boolean {
  const t = tutorStatusOf(state);
  return isPlayersTurn(state) && t.available && !t.thinking;
}

/** "Show me": an open question that holds a reveal not yet shown. */
export function canReveal(state: GameState): boolean {
  const t = state.tutor;
  return t.open && t.question !== null && t.question.canReveal && t.reveal?.questionId !== t.question.id;
}

export interface BoardArrow {
  from: string;
  to: string;
  kind: "question" | "reveal";
}

const MAX_ARROWS = 3;

/**
 * Tutor arrows for the board (FR-8, FR-11): the open question's, or once revealed the reveal's
 * arrows plus its move. None once the question closes. At most 3.
 */
export function tutorArrows(state: GameState): BoardArrow[] {
  const t = state.tutor;
  if (!t.open || !t.question) return [];
  const out: BoardArrow[] = [];
  const add = (from: string, to: string, kind: BoardArrow["kind"]) => {
    if (out.length < MAX_ARROWS && !out.some((a) => a.from === from && a.to === to)) out.push({ from, to, kind });
  };
  const r = t.reveal?.questionId === t.question.id ? t.reveal : null;
  if (r) {
    for (const a of r.arrows) add(a.from, a.to, "reveal");
    if (r.move) add(r.move.uci.slice(0, 2), r.move.uci.slice(2, 4), "reveal");
  } else {
    for (const a of t.question.arrows) add(a.from, a.to, "question");
  }
  return out;
}

/** The graded attempt for the shown question, as one line; null when there is none. */
export function tutorAttemptText(state: GameState): string | null {
  const a = state.tutor.attempt;
  if (!a) return null;
  if (a.correct) return `Correct: ${a.move.san} is a good move.`;
  return `Not quite: ${a.move.san} loses ${a.cpLoss} centipawns against the best move.`;
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
