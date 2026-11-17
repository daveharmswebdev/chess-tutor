// The graded try as a short pop-up near the board (#52: FR-24, FR-8, FR-10). The text comes only
// from the server's events (tutor_attempt, and tutor_reveal for the best move); nothing is invented.
// The live region is always rendered so screen readers announce the result when it appears.
// Closing (after TRY_RESULT_MS or at the next move) is the controller's and reducer's job. No hooks.
// One line at most (styles.css): a line too long for a narrow screen ends in an ellipsis on screen,
// with the full text in the DOM (live region) and the title. e2e/try-toast-layout.spec.ts measures it.
import { tryResultText, type TryResult } from "./game-state.ts";

export function TryToast({ result }: { result: TryResult | null }) {
  const text = result ? tryResultText(result) : "";
  return (
    <div className="try-toast-region" role="status" aria-live="polite">
      {result && (
        <p
          className={result.correct ? "try-toast good" : "try-toast bad"}
          data-testid="try-toast"
          data-correct={result.correct ? "true" : "false"}
          title={text}
        >
          <span className="try-toast-mark" aria-hidden="true">
            {result.correct ? "✓" : "✗"}
          </span>{" "}
          {text}
        </p>
      )}
    </div>
  );
}
