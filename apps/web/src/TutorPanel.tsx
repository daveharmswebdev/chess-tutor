// Tutor panel (#7: FR-8, FR-11, FR-12, NFR-1, NFR-9): thinking and progress, the question,
// "Show me" and its reveal, the attempt result, failures, and why coaching is off.
// No hooks, so tests can render it on the server or call it directly. Everything shown comes
// from the server (GameView.tutor and tutor_* events); nothing here invents a move.
import type { Arrow } from "react-chessboard";
import type { GameController } from "./controller.ts";
import { canHint, canReveal, tutorArrows, tutorAttemptText, tutorStatusOf, type GameState } from "./game-state.ts";

export type TutorPanelHandlers = Pick<GameController, "hint" | "reveal">;

const QUESTION_ARROW = "rgba(33, 150, 243, 0.8)";
const REVEAL_ARROW = "rgba(76, 175, 80, 0.85)";

/** The tutor's arrows in react-chessboard's shape (`options.arrows`); at most 3. */
export function chessboardArrows(state: GameState): Arrow[] {
  return tutorArrows(state).map((a) => ({
    startSquare: a.from,
    endSquare: a.to,
    color: a.kind === "reveal" ? REVEAL_ARROW : QUESTION_ARROW,
  }));
}

export function TutorPanel({ state, controller }: { state: GameState; controller: TutorPanelHandlers }) {
  const game = state.game;
  const status = tutorStatusOf(state);
  const t = state.tutor;
  const attempt = tutorAttemptText(state);
  const reveal = t.question && t.reveal?.questionId === t.question.id ? t.reveal : null;
  const idle = status.available && !status.thinking && !t.question && !t.failed && !t.notice;

  return (
    <div className="panel tutor" data-testid="tutor-panel">
      <h2>Tutor</h2>
      {!game && <p className="muted">The tutor comments on key moments of your game once it starts.</p>}
      {game && !status.available && (
        <p className="muted" data-testid="tutor-unavailable">
          {status.reason ?? "Coaching is not available for this game."}
        </p>
      )}
      {game && idle && <p className="muted">The tutor will comment on key moments of your game here.</p>}
      {status.thinking && (
        <div className="tutor-thinking" data-testid="tutor-thinking" aria-live="polite">
          <p>Tutor is thinking...</p>
          {t.progress && (
            <p className="muted" data-testid="tutor-progress">
              {t.progress}
            </p>
          )}
        </div>
      )}
      {t.failed && (
        <p className="error" data-testid="tutor-failed">
          {t.failed}
        </p>
      )}
      {t.question && (
        <p className="tutor-question" data-testid="tutor-question">
          {t.question.message}
        </p>
      )}
      {attempt && (
        <p className={t.attempt?.correct ? "tutor-attempt good" : "tutor-attempt bad"} data-testid="tutor-attempt">
          {attempt}
        </p>
      )}
      {reveal && (
        <div className="tutor-reveal" data-testid="tutor-reveal">
          <p>{reveal.text}</p>
          {reveal.move && (
            <p>
              Answer: <strong>{reveal.move.san}</strong>
            </p>
          )}
        </div>
      )}
      {t.notice && (
        <p className="muted" data-testid="tutor-notice">
          {t.notice}
        </p>
      )}
      {game && (
        <div className="actions">
          {t.open && t.question && (
            <button type="button" data-testid="tutor-show-me" disabled={!canReveal(state)} onClick={() => void controller.reveal()}>
              Show me
            </button>
          )}
          <button type="button" data-testid="tutor-hint" disabled={!canHint(state)} onClick={() => void controller.hint()}>
            Hint
          </button>
        </div>
      )}
    </div>
  );
}
