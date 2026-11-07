import { Chess } from "chess.js";
import { playUci, sanOf } from "./moves.ts";
import { MATE_CP, scoreToCp } from "./score.ts";
import type { Color, DetectorInput, KeyMoment } from "./types.ts";

/**
 * Decides whether the move just played is a key moment (FR-6) or not (FR-7: null).
 * Pure: no I/O. Throws when `move` is not legal in `fenBefore` (a caller bug).
 */
export function detect(input: DetectorInput): KeyMoment | null {
  const { before, after, thresholds, playerColor } = input;

  const board = new Chess(input.fenBefore);
  const mover: Color = board.turn();
  const played = playUci(board, input.move); // throws on an illegal move
  const afterFen = board.fen();

  const bestLine = before.lines[0];
  if (!bestLine) return null;
  const bestEval = scoreToCp(bestLine.score, mover, mover);

  let playedEval: number;
  const afterLine = after.lines[0];
  if (afterLine) {
    playedEval = scoreToCp(afterLine.score, mover, board.turn());
  } else if (board.isCheckmate()) {
    playedEval = MATE_CP;
  } else if (board.isGameOver()) {
    playedEval = 0; // stalemate or another draw
  } else {
    return null; // no evaluation of a live position: nothing can be claimed
  }

  const loss = Math.max(0, bestEval - playedEval);

  if (mover === playerColor) {
    const best = sanOf(input.fenBefore, before.bestMove);
    if (bestEval >= thresholds.missedWinCp && playedEval >= 0 && loss >= thresholds.missedWinCp) {
      return { kind: "missed_win", played: played.san, best, gainCp: loss };
    }
    if (loss >= thresholds.blunderCp) {
      return { kind: "player_blunder", played: played.san, cpLoss: loss, best };
    }
    return null;
  }

  // Opponent move. A finished game has no refutation to show.
  if (loss >= thresholds.punishCp && afterLine) {
    return {
      kind: "punish_opponent",
      opponentMove: played.san,
      refutation: sanOf(afterFen, after.bestMove),
      gainCp: loss,
    };
  }

  const book = input.repertoire?.continuations(input.history, playerColor) ?? null;
  if (book && book.moves.length > 0 && !book.moves.some((m) => m.uci === input.move)) {
    return {
      kind: "opponent_left_book",
      line: book.line,
      expected: book.moves.map((m) => m.san),
      played: played.san,
    };
  }
  return null;
}
