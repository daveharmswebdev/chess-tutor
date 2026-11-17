// Pure helpers for the guided demo's steps (#59: FR-27): each failure says exactly why the demo
// stopped, and teardown keeps the video even when quitting the engine fails.

/** Text of the panel's failure-like elements that are visible (null or absent: not shown). */
export interface TutorPanelProblems {
  /** tutor-failed: the tutor's call failed. */
  failed?: string | null;
  /** tutor-unavailable: coaching is off for this game. */
  unavailable?: string | null;
  /** tutor-notice: a refused Hint or Show me (409, 503, network). */
  notice?: string | null;
}

/** The reason the demo must stop at `step`, or null when the panel shows no problem. */
export function tutorProblem(step: string, p: TutorPanelProblems): string | null {
  const parts: string[] = [];
  if (p.failed != null) parts.push(`tutor-failed: ${p.failed}`);
  if (p.unavailable != null) parts.push(`tutor-unavailable: ${p.unavailable}`);
  if (p.notice != null) parts.push(`tutor-notice: ${p.notice}`);
  return parts.length === 0 ? null : `demo stopped at ${step}: ${parts.join("; ")}`;
}

/** Why Show me cannot be clicked after the hint reply, or null when it can. */
export function showMeProblem(s: { visible: boolean; enabled: boolean }): string | null {
  if (!s.visible) return "demo stopped at Show me: Show me is not shown: no open question after the hint reply";
  if (!s.enabled) return "demo stopped at Show me: Show me is disabled: the hint reply holds no reveal (canReveal is false)";
  return null;
}

/** Saves the video first, then quits the engine in its own try; returns what went wrong. */
export async function teardown(steps: { saveVideo: () => Promise<void>; quitEngine: () => Promise<void> }): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await steps.saveVideo();
  } catch (e) {
    errors.push(e);
  }
  try {
    await steps.quitEngine();
  } catch (e) {
    errors.push(e);
  }
  return errors;
}
