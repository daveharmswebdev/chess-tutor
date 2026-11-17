// Tutor notes in the move list (#54: FR-25, FR-10, NFR-14). Pure functions: which row a note sits
// on, and what the note says. Notes come only inside GameView (api.ts, #53), so a refreshed page
// shows them again without any storage here. Every move name and number shown comes from the
// note's own fields (bestMove, attempt) or the game's moves: nothing is parsed from text, and no
// evaluation is computed (FR-10).
import type { MoveView, TutorNote } from "@chess-tutor/chess-core";

/** A full move: white ply 2k, black ply 2k + 1, and the notes on either ply, in GameView order. */
export interface MoveRow {
  /** Move number, from 1. */
  n: number;
  /** The white ply of this row (2 * (n - 1)). */
  ply: number;
  white: MoveView | undefined;
  black: MoveView | undefined;
  notes: TutorNote[];
}

/** A message longer than this is shortened in the wide layout even with nothing else to show. */
export const SHORT_NOTE_CHARS = 60;

/**
 * The move list's rows with their notes. A note sits on moves[note.ply]; ply === moves.length
 * means after the last move, so it goes on the last row. A note past that (never sent by the
 * server: a takeback removes it) is dropped rather than given a made-up row.
 */
export function moveRows(moves: MoveView[], notes: readonly TutorNote[] = []): MoveRow[] {
  const rows: MoveRow[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ n: i / 2 + 1, ply: i, white: moves[i], black: moves[i + 1], notes: [] });
  }
  for (const note of notes) {
    if (!Number.isInteger(note.ply) || note.ply < 0 || note.ply > moves.length) continue;
    if (rows.length === 0) rows.push({ n: 1, ply: 0, white: undefined, black: undefined, notes: [] });
    const index = Math.min(Math.floor(note.ply / 2), rows.length - 1);
    rows[index]!.notes.push(note);
  }
  return rows;
}

function pawns(cpLoss: number): string {
  return (Math.max(0, cpLoss) / 100).toFixed(1);
}

function attemptLine(a: NonNullable<TutorNote["attempt"]>): string {
  const p = pawns(a.cpLoss);
  if (a.correct) {
    if (a.cpLoss <= 0) return `You tried ${a.move.san}: correct, the best move.`;
    if (p === "0.0") return `You tried ${a.move.san}: correct, less than 0.1 off the best move.`;
    return `You tried ${a.move.san}: correct, only ${p} off the best move.`;
  }
  if (p === "0.0") return `You tried ${a.move.san}: it lost less than 0.1 pawns.`;
  return `You tried ${a.move.san}: it lost about ${p} ${p === "1.0" ? "pawn" : "pawns"}.`;
}

/**
 * The full note, one part per field: the message; the reveal when not null; the graded try when
 * not null; "Best was <san>." when the engine's best move is known and is not the try.
 */
export function noteParts(note: TutorNote): string[] {
  const parts = [note.message];
  if (note.reveal !== null && note.reveal.trim() !== "") parts.push(note.reveal);
  if (note.attempt !== null) parts.push(attemptLine(note.attempt));
  if (note.bestMove !== null && note.bestMove.uci !== note.attempt?.move.uci) {
    parts.push(`Best was ${note.bestMove.san}.`);
  }
  return parts;
}

export function noteText(note: TutorNote): string {
  return noteParts(note).join(" ");
}

/** True when the full note says more than the short line: "▸ more" is offered then. */
export function noteHasMore(note: TutorNote): boolean {
  return noteParts(note).length > 1 || note.message.length > SHORT_NOTE_CHARS;
}

function moveName(row: MoveRow, ply: number, moves: { white: MoveView | undefined; black: MoveView | undefined }): string {
  const isWhite = ply % 2 === 0;
  const m = isWhite ? moves.white : moves.black;
  return m ? `${row.n}${isWhite ? "." : "..."} ${m.san}` : `${row.n}`;
}

/**
 * The accessible name of a row's ❝ button, e.g. "Tutor note for move 5... O-O". The move named is
 * the one the note sits on; a note after the last move is named by that last move.
 */
export function noteLabel(row: MoveRow): string {
  const names: string[] = [];
  let after = false;
  for (const note of row.notes) {
    const onRow = note.ply - row.ply;
    const sitsOn = onRow === 0 ? row.white : onRow === 1 ? row.black : undefined;
    let name: string;
    if (sitsOn) {
      name = moveName(row, note.ply, row);
    } else {
      // After the last move: name the move before the note's position, if any.
      after = true;
      const last = row.black ?? row.white;
      name = last ? moveName(row, row.black ? row.ply + 1 : row.ply, row) : "the start";
    }
    if (!names.includes(name)) names.push(name);
  }
  const plural = row.notes.length > 1 ? "notes" : "note";
  if (names.length === 0) return "Tutor note";
  if (names[0] === "the start") return `Tutor ${plural} for the start position`;
  const prep = after && names.length === 1 ? "after" : "for";
  return `Tutor ${plural} ${prep} ${names.length > 1 ? "moves" : "move"} ${names.join(" and ")}`;
}

/** A copy of `set` with `key` added, or removed when it was there. */
export function toggleKey<K>(set: ReadonlySet<K>, key: K): Set<K> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
