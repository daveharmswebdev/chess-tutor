// Game state for the board UI: a pure reducer plus selectors, no DOM. FR-1, FR-4, IR-5.
// The server's GameView is the truth; the client only adds an optimistic position while a
// move request is in flight, a selected square, a busy flag and the last error.
// Ordering (#23): an HTTP reply can arrive after SSE events caused by the same request. SSE is
// the newer source, so once an SSE event arrives during a request, that request's reply only
// clears busy and pendingFen and keeps the SSE-derived game and error.
// Tutor (#7: FR-8, FR-11, FR-12, NFR-1, NFR-9): GameView.tutor is the truth. The tutor_* events
// patch it between "state" events, and `tutor` keeps what only the browser holds: the progress
// label, the question, its reveal, a failure message and a notice from a refused Hint or Show me.
// Try result (#52: FR-24, FR-8, FR-10): a graded try ("tutor_attempt") is not panel text but a
// short pop-up near the board, `tryResult`. It comes only from live events (never from a GameView,
// so opening or reloading a game shows none), names the best move only from the server's
// "tutor_reveal" for the same question, and closes at the player's next move (move_attempted) or
// when the controller's timer dispatches try_result_expired with its seq.
// Panel follows the board (#51: FR-24, FR-8): the player's move (move_attempted) clears the panel
// at once, keeping only the tutor's progress. The question it left is never shown again (late
// tutor_attempt / tutor_reveal, or a later GameView still carrying it as shown); the panel shows a
// question again only from the server: a new tutor_reply, or a GameView (a takeback) with another
// question. A move the server rejects restores the panel as it was before the attempt.
// A tutor_reply or tutor_failed that arrives while the move is in flight is about the position
// being left, so it is tentative: the move's GameView (state or reply) keeps it only when it still
// holds that question. A GameView without a question takes a closed question's text off the panel.
// Survival (#47: NFR-14, NFR-9): `loading` while a game opened from /games/<id> is fetched,
// `reconnecting` while the server is unreachable (the board stays visible but locked), and
// `notFound` only after a 404. The browser keeps no copy of the moves.
import type { GameEvent, GameView, MoveView } from "@chess-tutor/chess-core";
import { fenAfter, sideToMove } from "./chess-rules.ts";
import type { TutorQuestion, TutorReveal, TutorStatus } from "./tutor-types.ts";

type TutorKind = TutorQuestion["kind"];

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** A graded try, shown as a pop-up near the board (#52, FR-24). */
export interface TryResult {
  questionId: string;
  move: MoveView;
  correct: boolean;
  cpLoss: number;
  /** The best move from the "tutor_reveal" for the same question (FR-10); null until then, or when it has none. */
  best: MoveView | null;
  /** Tells this pop-up from the one before it, so a stale timer closes nothing. */
  seq: number;
}

export interface TutorPanelState {
  /** The question shown for the position on the board; cleared by the player's move (#51). */
  question: TutorQuestion | null;
  /** The question is still open on the server (attempts count, Show me works, arrows drawn). */
  open: boolean;
  /** Latest tutor_progress label while the tutor is thinking. */
  progress: string | null;
  /** The reveal for `question`, from POST /tutor/reveal or a "tutor_reveal" event. */
  reveal: TutorReveal | null;
  /** tutor_failed message. */
  failed: string | null;
  /** A refused Hint or Show me (409, 503, network). */
  notice: string | null;
  /** Id of the question the player's last move left (#51); the panel never shows it again. */
  left: string | null;
  /** The question or failure shown arrived while the player's move was in flight (#51). */
  tentative: boolean;
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
  /** GET /api/games/:id for a game opened from its address is in flight. */
  loading: boolean;
  /** The server cannot be reached (network error, 5xx or a dropped stream); retrying. */
  reconnecting: boolean;
  /** GET /api/games/:id (or a move or action) answered 404. */
  notFound: boolean;
  /** A move whose request failed unreachable: it may still have been applied (cleared on reconnect). */
  unconfirmedMove: { uci: string; ply: number } | null;
  /** The panel as it was before the move in flight, restored if the server rejects it (#51). */
  tutorBeforeMove: TutorPanelState | null;
  /** The graded try's pop-up (#52); only from live events, closed by the next move or its timer. */
  tryResult: TryResult | null;
  /** seq of the latest try result, kept after it closes. */
  trySeq: number;
  /** The latest "tutor_reveal" answer move, for a try graded after its reveal arrived. */
  lastRevealMove: { questionId: string; move: MoveView | null } | null;
}

export type GameAction =
  | { type: "request_started" }
  | { type: "game_started"; game: GameView }
  | { type: "move_attempted"; uci: string; fen: string }
  | { type: "move_accepted"; game: GameView }
  | { type: "move_rejected"; message: string; unconfirmed?: { uci: string; ply: number } }
  | { type: "request_succeeded"; game: GameView }
  | { type: "request_failed"; message: string }
  | { type: "server_event"; event: GameEvent }
  /** Opening /games/<id>: the GET is in flight. */
  | { type: "game_opening" }
  /** Back to "/": no game shown. */
  | { type: "game_closed" }
  | { type: "game_not_found" }
  /** The server is unreachable; `message` is shown when a request was lost (null keeps the error). */
  | { type: "reconnecting"; message: string | null }
  /** A fresh GameView from GET after reconnecting. */
  | { type: "reconnected"; game: GameView }
  | { type: "select"; square: string | null }
  /** The 200 TutorReveal from POST /tutor/reveal ("Show me"). */
  | { type: "tutor_reveal_received"; reveal: TutorReveal }
  /** A refused Hint or Show me; null clears it. */
  | { type: "tutor_notice"; message: string | null }
  /** The try result's timer ran out (#52); closes it only if it is still the one with `seq`. */
  | { type: "try_result_expired"; seq: number };

export const emptyTutorPanel: TutorPanelState = {
  question: null,
  open: false,
  progress: null,
  reveal: null,
  failed: null,
  notice: null,
  left: null,
  tentative: false,
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
  loading: false,
  reconnecting: false,
  notFound: false,
  unconfirmedMove: null,
  tutorBeforeMove: null,
  tryResult: null,
  trySeq: 0,
  lastRevealMove: null,
};

/** For a GameView without `tutor` (a server from before #7): no coaching, no reason given. */
const NO_TUTOR: TutorStatus = { available: false, reason: null, thinking: false, question: null };

/** The server's tutor status for the current game (patched by live tutor events). */
export function tutorStatusOf(state: GameState): TutorStatus {
  return state.game?.tutor ?? NO_TUTOR;
}

/** The player's own lessons: shown one takeback away, so the player can try again (FR-8). */
const LESSON_KINDS: ReadonlySet<TutorKind> = new Set(["player_blunder", "missed_win"]);

/** Same position: placement, side to move, castling and en passant; the move counters are ignored. */
function samePosition(a: string, b: string): boolean {
  return a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");
}

/** FEN before the player's last move (GameView.moves start at the start position), or null. */
function fenBeforeLastPlayerMove(game: GameView): string | null {
  const last = game.moves.findLastIndex((m) => m.by === "player");
  if (last === -1) return null;
  let fen: string | null = START_FEN;
  for (let i = 0; i < last && fen !== null; i++) fen = fenAfter(fen, game.moves[i]!.uci);
  return fen;
}

/**
 * FR-24 guard (#51): a GameView question belongs on the panel only while it is about the board:
 * its attemptFen is the current position, or, for an open lesson (no reveal shown yet), the
 * position one takeback away, the offer to try again. Anything else (e.g. a page reloaded after a
 * wrong try, on a server that still keeps the shown question) is treated as left.
 */
function onBoard(q: TutorQuestion, status: TutorStatus, game: GameView): boolean {
  if (samePosition(q.attemptFen, game.fen)) return true;
  if (!LESSON_KINDS.has(q.kind) || status.reveal?.questionId === q.id) return false;
  const before = fenBeforeLastPlayerMove(game);
  return before !== null && samePosition(q.attemptFen, before);
}

/** Brings the browser-side panel in line with a GameView's TutorStatus from the server. */
function syncTutor(panel: TutorPanelState, game: GameView | null | undefined): TutorPanelState {
  const t = game?.tutor ?? NO_TUTOR;
  const progress = t.thinking ? panel.progress : null;
  // The question the player's move left stays out of the panel (#51), e.g. a wrong try's shown reveal,
  // and so does one about a position that is not on the board.
  const q = t.question && t.question.id !== panel.left && game && onBoard(t.question, t, game) ? t.question : null;
  if (!q) {
    // Closed on the server: its text (question, reveal, try result) leaves the panel too (#51).
    if (!panel.question && !panel.open && !panel.tentative && progress === panel.progress) return panel;
    const left = panel.question?.id ?? panel.left;
    return { ...panel, question: null, open: false, reveal: null, progress, left, tentative: false };
  }
  // A reveal already shown (#47): a refreshed page shows it again.
  const shown = t.reveal && t.reveal.questionId === q.id ? t.reveal : null;
  if (panel.question?.id === q.id) return { ...panel, question: q, open: true, progress, reveal: panel.reveal ?? shown };
  return { ...emptyTutorPanel, question: q, open: true, progress, reveal: shown, left: panel.left };
}

/** The panel once the player moves (#51, FR-24): empty but for the progress; the question is left. */
function leavePanel(state: GameState): TutorPanelState {
  const t = state.tutor;
  const left = t.question?.id ?? state.game?.tutor?.question?.id ?? t.left;
  return { ...emptyTutorPanel, progress: t.progress, left };
}

/**
 * The move's GameView arrived (#51): a tentative question stays only if the server still holds it;
 * a tentative failure was about the position that was left.
 */
function settleTentative(panel: TutorPanelState, status: TutorStatus | undefined): TutorPanelState {
  if (!panel.tentative) return panel;
  const id = panel.question?.id;
  if (id !== undefined && status?.question?.id === id) return { ...panel, failed: null, tentative: false };
  return {
    ...panel,
    question: null,
    open: false,
    reveal: null,
    failed: null,
    notice: null,
    tentative: false,
    left: id ?? panel.left,
  };
}

/**
 * A move the server rejected (or that was never sent): the panel as it was before the attempt
 * (#51). When events arrived meanwhile, the live panel wins for what they brought (a new question,
 * a tutor_failed, the progress label) and the result is brought in line with the server.
 */
function panelAfterRejection(state: GameState): TutorPanelState {
  const before = state.tutorBeforeMove;
  if (!before) return state.tutor;
  if (!state.sseSinceRequest && !state.tutorSinceRequest) return before;
  const live = state.tutor;
  const base: TutorPanelState = live.question
    ? { ...live, left: before.left, tentative: false }
    : {
        ...before,
        progress: live.progress,
        failed: state.tutorSinceRequest ? live.failed : before.failed,
        notice: state.tutorSinceRequest ? live.notice : before.notice,
        tentative: false,
      };
  return syncTutor(base, state.game);
}

/** A GameView from an HTTP reply; keeps the newer tutor state when a tutor event came first. */
function applyReplyGame(state: GameState, game: GameView): { game: GameView; tutor: TutorPanelState } {
  if (state.tutorSinceRequest && state.game) return { game: { ...game, tutor: state.game.tutor }, tutor: state.tutor };
  return { game, tutor: syncTutor(state.tutor, game) };
}

function patchTutor(game: GameView, patch: Partial<TutorStatus>): GameView {
  return { ...game, tutor: { ...(game.tutor ?? NO_TUTOR), ...patch } };
}

/** A wrong try's pop-up with the reveal's move for the same question as its best move (#52, FR-10). */
function bestFromReveal(r: TryResult | null, questionId: string, move: MoveView | null): TryResult | null {
  if (!r || r.correct || r.questionId !== questionId || r.best?.uci === move?.uci) return r;
  return { ...r, best: move };
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
        t.question?.id === q.id
          ? { ...t, question: q, open: true, progress: null }
          : { ...emptyTutorPanel, question: q, open: true, left: t.left };
      // While the player's move is in flight the reply may be about the position being left (#51).
      if (state.tutorBeforeMove) tutor.tentative = true;
      return { ...live, game: patchTutor(game, { thinking: false, question: q }), tutor };
    }
    case "tutor_failed":
      return {
        ...live,
        game: patchTutor(game, { thinking: false }),
        tutor: { ...t, progress: null, failed: event.message, tentative: t.tentative || state.tutorBeforeMove !== null },
      };
    case "tutor_reveal": {
      const r = event.reveal;
      // A wrong try names the best move only from the server's reveal for the same question (#52, FR-10).
      const seen = state.lastRevealMove;
      const tryResult = bestFromReveal(state.tryResult, r.questionId, r.move);
      const same = seen?.questionId === r.questionId && seen.move?.uci === r.move?.uci && tryResult === state.tryResult;
      const withBest: GameState = same
        ? state
        : { ...state, lastRevealMove: { questionId: r.questionId, move: r.move }, tryResult };
      const next = applyReveal(withBest, r);
      return next === withBest ? withBest : { ...next, tutorSinceRequest: true };
    }
    case "tutor_attempt": {
      const { questionId, move, correct, cpLoss } = event;
      // A question this page knows: on the panel, left by the player's move (#51), or held by the server.
      const known = t.question?.id === questionId || t.left === questionId || game.tutor?.question?.id === questionId;
      if (!known) return state;
      const closed = game.tutor?.question?.id === questionId ? patchTutor(game, { question: null }) : game;
      const seq = state.trySeq + 1;
      const fresh: TryResult = { questionId, move, correct, cpLoss, best: null, seq };
      const r = state.lastRevealMove;
      const tryResult = r ? bestFromReveal(fresh, r.questionId, r.move) : fresh;
      const base = { ...live, game: closed, tryResult, trySeq: seq };
      // The result is the pop-up's, never the panel's (#52, FR-24); the panel's question just closes.
      if (!t.question || t.question.id !== questionId) return base;
      return { ...base, tutor: { ...t, open: false, notice: null } };
    }
  }
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "request_started":
      return { ...state, busy: true, error: null, sseSinceRequest: false, tutorSinceRequest: false, tutorBeforeMove: null };

    case "game_started":
      return { ...initialGameState, game: action.game, tutor: syncTutor(emptyTutorPanel, action.game) };

    case "move_attempted":
      return {
        ...state,
        busy: true,
        error: null,
        selected: null,
        pendingFen: action.fen,
        unconfirmedMove: null,
        sseSinceRequest: false,
        tutorSinceRequest: false,
        // FR-24: whatever the panel showed leaves it with the position (#51).
        tutor: leavePanel(state),
        tutorBeforeMove: state.tutor,
        // The next move closes the try result's pop-up at once (#52).
        tryResult: null,
      };

    case "move_accepted": {
      if (!state.game || state.game.id !== action.game.id) return state; // late reply from an old game
      // SSE (a bot_move, or state + error from a bot failure) may overtake this response; keep it then.
      const kept: Pick<GameState, "tutor"> & { game: GameView } = state.sseSinceRequest
        ? { game: state.game, tutor: state.tutor }
        : applyReplyGame(state, action.game);
      // The move's reply settles a reply or failure that arrived while it was in flight (#51).
      const tutor = settleTentative(kept.tutor, action.game.tutor);
      const dropped = kept.tutor.question !== null && tutor.question === null ? kept.tutor.question.id : null;
      const game =
        dropped !== null && kept.game.tutor?.question?.id === dropped
          ? patchTutor(kept.game, { question: null, reveal: null })
          : kept.game;
      return { ...state, game, tutor, busy: false, pendingFen: null, tutorBeforeMove: null };
    }

    case "move_rejected":
      // Snap back: drop the optimistic position, the board shows the server's FEN again.
      return {
        ...state,
        busy: false,
        pendingFen: null,
        selected: null,
        error: action.message,
        unconfirmedMove: action.unconfirmed ?? null,
        tutor: panelAfterRejection(state),
        tutorBeforeMove: null,
      };

    case "request_succeeded":
      // A late reply for a game no longer shown (#47) is dropped, also when no game is shown.
      if (!state.game || state.game.id !== action.game.id) return state;
      if (state.sseSinceRequest) return { ...state, busy: false, pendingFen: null, selected: null, tutorBeforeMove: null };
      return {
        ...state,
        ...applyReplyGame(state, action.game),
        busy: false,
        pendingFen: null,
        selected: null,
        error: null,
        tutorBeforeMove: null,
      };

    case "request_failed":
      return { ...state, busy: false, pendingFen: null, error: action.message, tutor: panelAfterRejection(state), tutorBeforeMove: null };

    case "game_opening":
      return { ...initialGameState, loading: true };

    case "game_closed":
      return initialGameState;

    case "game_not_found":
      return { ...initialGameState, notFound: true };

    case "reconnecting":
      return {
        ...state,
        loading: false,
        reconnecting: true,
        busy: false,
        pendingFen: null,
        selected: null,
        error: action.message ?? state.error,
      };

    case "reconnected": {
      if (state.game && state.game.id !== action.game.id) return state;
      // A move that may not have arrived: the fresh view settles it when it holds the move.
      const u = state.unconfirmedMove;
      const applied = u !== null && action.game.moves[u.ply]?.uci === u.uci;
      return {
        ...state,
        error: applied ? null : state.error,
        unconfirmedMove: null,
        game: action.game,
        // A move that did arrive left the panel's question with its position (#51).
        // A reconnect ends any move in flight, so nothing shown is tentative any more (#51).
        tutor: syncTutor({ ...(applied ? leavePanel(state) : state.tutor), tentative: false }, action.game),
        tutorBeforeMove: null,
        loading: false,
        reconnecting: false,
        busy: false,
        pendingFen: null,
        selected: null,
        // A request still in flight is older than this view.
        sseSinceRequest: true,
        tutorSinceRequest: true,
      };
    }

    case "select":
      return { ...state, selected: action.square };

    case "tutor_reveal_received":
      return applyReveal(state, action.reveal);

    case "try_result_expired":
      return state.tryResult?.seq === action.seq ? { ...state, tryResult: null } : state;

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
      const advanced = event.game.moves.length > state.game.moves.length;
      const overtakesPending = state.pendingFen !== null && advanced;
      // The player's move in flight is applied: settle what arrived meanwhile (#51); no rejection follows.
      const moveApplied = state.tutorBeforeMove !== null && advanced;
      const panel = moveApplied ? settleTentative(state.tutor, event.game.tutor) : state.tutor;
      return {
        ...state,
        game: event.game,
        tutor: syncTutor(panel, event.game),
        tutorBeforeMove: moveApplied ? null : state.tutorBeforeMove,
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
    !state.reconnecting &&
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
    !state.reconnecting &&
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
    !state.reconnecting &&
    g.status === "playing" &&
    !g.botThinking &&
    !state.busy &&
    state.pendingFen === null &&
    sideToMove(g.fen) !== g.playerColor
  );
}

export function canResign(state: GameState): boolean {
  const g = state.game;
  return g !== null && g.status === "playing" && !state.busy && !state.reconnecting;
}

/** Hint (FR-12): whenever the player may move and coaching is available and idle. */
export function canHint(state: GameState): boolean {
  const t = tutorStatusOf(state);
  return isPlayersTurn(state) && t.available && !t.thinking;
}

/** "Show me": an open question that holds a reveal not yet shown. */
export function canReveal(state: GameState): boolean {
  const t = state.tutor;
  return (
    !state.reconnecting && t.open && t.question !== null && t.question.canReveal && t.reveal?.questionId !== t.question.id
  );
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

/**
 * The try result's line (#52, FR-24), without the check or cross mark: "Nf3, correct. Only 0.1 off
 * the best move" (cpLoss in pawns, one decimal), "Nf3, correct. The best move" at cpLoss 0, and
 * "Be2, not quite. Best was h3", where the best move is the server's reveal move (FR-10); without
 * one, no best move is named.
 */
export function tryResultText(r: TryResult): string {
  if (r.correct) {
    if (r.cpLoss <= 0) return `${r.move.san}, correct. The best move`;
    const pawns = (r.cpLoss / 100).toFixed(1);
    // A loss that rounds to 0.0 is still not the best move.
    if (pawns === "0.0") return `${r.move.san}, correct. Less than 0.1 off the best move`;
    return `${r.move.san}, correct. Only ${pawns} off the best move`;
  }
  return r.best ? `${r.move.san}, not quite. Best was ${r.best.san}` : `${r.move.san}, not quite.`;
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
  if (!g) {
    if (state.notFound) return "Game not found.";
    if (state.loading || state.reconnecting) return "Loading the game…";
    return "Choose a color and start a new game.";
  }
  if (g.status === "abandoned") return "Game abandoned.";
  if (g.status === "finished") return resultText(g);
  if (g.botThinking || state.pendingFen !== null) return "Bot is thinking...";
  if (isPlayersTurn(state)) return "Your move.";
  if (canRetryBot(state)) return "The bot did not move. Retry the bot move.";
  return "Waiting for the server...";
}
