import { Chess } from "chess.js";
import type { GameView, TutorNote } from "@chess-tutor/chess-core";

export const PLAYER_NAME = "Player";
export const BOT_NAME = "Sparring bot";

function pgnDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

/** One line of plain text that cannot end a PGN comment: no braces, no line breaks. */
function commentSafe(text: string): string {
  return text
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

/** A tutor note as PGN comment text (#53, FR-5), from the note's fields only. */
export function noteComment(note: TutorNote): string {
  const parts = [`Tutor: ${note.message}`];
  if (note.reveal !== null) parts.push(`Answer: ${note.reveal}`);
  if (note.bestMove) parts.push(`Best was ${note.bestMove.san}.`);
  if (note.attempt) {
    const { move, correct, cpLoss } = note.attempt;
    parts.push(`Your try ${move.san}: ${correct ? "correct" : "not it"} (${cpLoss} cp off).`);
  }
  return commentSafe(parts.join(" "));
}

/**
 * PGN of a game (FR-5): Seven Tag Roster plus Termination (the endReason).
 * Moves are replayed through chess.js, so the movetext is always legal.
 * Tutor notes (#53) are {...} comments after the move they sit on (moves[ply]), or after the
 * last move when ply === moves.length; notes on the same move share one comment.
 */
export function toPgn(game: GameView, date: Date): string {
  const chess = new Chess();
  /** Comment texts by the number of moves played when they are written. */
  const byPlayed = new Map<number, string[]>();
  for (const note of game.notes ?? []) {
    if (!Number.isInteger(note.ply) || note.ply < 0 || note.ply > game.moves.length) continue;
    const at = Math.min(note.ply + 1, game.moves.length);
    byPlayed.set(at, [...(byPlayed.get(at) ?? []), noteComment(note)]);
  }
  const comment = (played: number) => {
    const texts = byPlayed.get(played);
    if (texts) chess.setComment(texts.join(" "));
  };
  comment(0);
  game.moves.forEach((m, i) => {
    chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), ...(m.uci.length === 5 ? { promotion: m.uci[4] } : {}) });
    comment(i + 1);
  });
  const playerWhite = game.playerColor === "w";
  chess.setHeader("Event", "Sparring game");
  chess.setHeader("Site", "Chess Tutor");
  chess.setHeader("Date", pgnDate(date));
  chess.setHeader("Round", "-");
  chess.setHeader("White", playerWhite ? PLAYER_NAME : BOT_NAME);
  chess.setHeader("Black", playerWhite ? BOT_NAME : PLAYER_NAME);
  chess.setHeader("Result", game.result);
  if (game.endReason !== null) chess.setHeader("Termination", game.endReason);
  return chess.pgn() + "\n";
}
