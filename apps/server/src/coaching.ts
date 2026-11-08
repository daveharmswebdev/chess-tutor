import { Chess } from "chess.js";
import {
  MATE_CP,
  scoreToCp,
  type Analysis,
  type GameEvent,
  type GameView,
  type KeyMomentThresholds,
  type MoveView,
  type Repertoire,
} from "@chess-tutor/chess-core";
import type { TutorFailureReason } from "@chess-tutor/tutor";
import type { TutorFactory } from "./tutor-setup.ts";

/*
 * Pure helpers for the server's coaching (#7). The api.ts tutor types are not re-exported by
 * @chess-tutor/chess-core's index (contract gap reported), so they are derived from GameView
 * and GameEvent here.
 */
export type TutorStatus = GameView["tutor"];
export type TutorQuestion = NonNullable<TutorStatus["question"]>;
export type TutorKind = TutorQuestion["kind"];
export type TutorArrow = TutorQuestion["arrows"][number];
export type TutorReveal = Extract<GameEvent, { type: "tutor_reveal" }>["reveal"];

/** The server's own position analysis (key-moment detection and attempt grading). */
export interface Analyzer {
  analyze(fen: string): Promise<Analysis>;
}

export interface CoachingDeps {
  analyzer: Analyzer;
  /** null when coaching is off (no key, no prompt file); offReason then says why. */
  tutor: TutorFactory | null;
  offReason?: string | null;
  /** Default: config/tutor.json keyMoments. */
  thresholds?: KeyMomentThresholds;
  /** Default: config/tutor.json tutor.attemptToleranceCp. */
  attemptToleranceCp?: number;
  repertoire?: Repertoire | null;
}

/** When the server is built without coaching deps at all. */
export const NOT_CONFIGURED_REASON = "Coaching is off: the tutor is not configured.";
export const AUTH_REASON = "Coaching is off: the API key was rejected.";
export const FIRST_PROGRESS_LABEL = "Tutor is looking at the position…";

/**
 * Plain messages for "tutor_failed". The outcome's own message is logged, never sent:
 * only code-written text reaches the browser on the failure path (NFR-8).
 */
export function failureMessage(reason: TutorFailureReason): string {
  switch (reason) {
    case "auth":
      return `${AUTH_REASON} The game goes on without the tutor.`;
    case "rate_limited":
      return "The tutor is busy right now (rate limited). Try Hint again in a minute.";
    case "api_unavailable":
      return "The tutor could not be reached. The game goes on; try Hint again later.";
    default:
      return "The tutor could not give a reliable answer for this position.";
  }
}

const SQUARE_RE = /^[a-h][1-8]$/;

/** Keeps arrows between real squares, at most 3 (architecture §3.5). */
export function cleanArrows(arrows: readonly { from: string; to: string }[]): TutorArrow[] {
  return arrows
    .filter((a) => SQUARE_RE.test(a.from) && SQUARE_RE.test(a.to) && a.from !== a.to)
    .slice(0, 3)
    .map((a) => ({ from: a.from, to: a.to }));
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** The move as a MoveView by the player if it is legal in `fen` (FR-10), else null. */
export function legalPlayerMove(fen: string, uci: string | null): MoveView | null {
  if (uci === null || !UCI_RE.test(uci)) return null;
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      ...(uci.length === 5 ? { promotion: uci[4] } : {}),
    });
    if (move.from + move.to + (move.promotion ?? "") !== uci) return null;
    return { uci, san: move.san, by: "player" };
  } catch {
    return null;
  }
}

/** The held part of a reply and the question it belongs to. */
export interface HeldQuestion {
  view: TutorQuestion;
  reveal: string | null;
  revealMove: string | null;
}

export function buildReveal(q: HeldQuestion): TutorReveal {
  const move = legalPlayerMove(q.view.attemptFen, q.revealMove);
  const arrows: TutorArrow[] = move ? [{ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4) }] : [];
  for (const a of q.view.arrows) {
    if (!arrows.some((b) => b.from === a.from && b.to === a.to)) arrows.push({ ...a });
  }
  return {
    questionId: q.view.id,
    text: q.reveal ?? q.view.message,
    move,
    arrows: arrows.slice(0, 3),
  };
}

/** Compares positions by placement, side to move, castling and en passant (not the clocks). */
export function samePosition(a: string, b: string): boolean {
  return a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");
}

/**
 * Centipawn loss of `uci` against the best move, from the mover's point of view, the way the
 * detector measures it: the move's own multi-PV line if it has one, else the analysis after
 * the move. null when there is nothing to measure (no evaluation of a live position).
 */
export function moveLoss(fenBefore: string, uci: string, before: Analysis, after: Analysis): number | null {
  const board = new Chess(fenBefore);
  const mover = board.turn();
  if (!legalPlayerMove(fenBefore, uci)) return null;
  board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length === 5 ? { promotion: uci[4] } : {}) });
  const best = before.lines[0];
  if (!best) return null;
  const bestEval = scoreToCp(best.score, mover, mover);
  const pv = before.lines.find((l) => l.moves[0] === uci);
  const afterLine = after.lines[0];
  let played: number;
  if (pv) played = scoreToCp(pv.score, mover, mover);
  else if (afterLine) played = scoreToCp(afterLine.score, mover, board.turn());
  else if (board.isCheckmate()) played = MATE_CP;
  else if (board.isGameOver()) played = 0;
  else return null;
  return Math.max(0, bestEval - played);
}
