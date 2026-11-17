// The move list with the tutor's notes (#54: FR-25, NFR-14, FR-10). Both layouts are in the
// markup; styles.css picks one by the list's own width (a container query), not the viewport:
//   wide:   a third "Tutor" column, each note shortened to one line, "▸ more" expands it in place;
//   narrow: no Tutor column; a row with a note gets a ❝ button that opens the full note under it.
// Notes arrive only inside GameView, so a refresh shows them again (NFR-14). The text comes from
// move-notes.ts, which uses only the note's own fields (FR-10).
import type { MoveView, TutorNote } from "@chess-tutor/chess-core";
import { Fragment, useState, type ReactNode } from "react";
import { moveRows, noteHasMore, noteLabel, noteParts, toggleKey, type MoveRow } from "./move-notes.ts";

/** A note's key for its "▸ more" state: its place in GameView.notes plus its question id. */
export function noteKey(note: TutorNote, index: number): string {
  return `${index}:${note.questionId}`;
}

export interface MoveListViewProps {
  moves: MoveView[];
  notes: readonly TutorNote[];
  /** Notes (noteKey) expanded with "▸ more" in the wide layout. */
  expanded: ReadonlySet<string>;
  /** Rows (move number) opened with ❝ in the narrow layout. */
  openRows: ReadonlySet<number>;
  onToggleNote: (key: string) => void;
  onToggleRow: (n: number) => void;
}

function cell(m: MoveView | undefined, ply: number): ReactNode {
  return m ? (
    <span className={`ply ${m.by}`} data-testid="move-item" data-ply={ply} data-by={m.by} title={m.by === "bot" ? "Bot" : "You"}>
      {m.san}
    </span>
  ) : (
    <span className="ply" />
  );
}

function noteView(note: TutorNote, key: string, expanded: boolean, onToggle: (key: string) => void): ReactNode {
  const more = noteHasMore(note);
  return (
    <div key={key} className={expanded ? "move-note expanded" : "move-note"} data-testid="move-note" data-ply={note.ply}>
      <span className="note-short">{note.message}</span>
      <span className="note-full">
        {noteParts(note).map((part, i) => (
          <Fragment key={i}>
            {i > 0 && " "}
            <span className="note-part">{part}</span>
          </Fragment>
        ))}
      </span>
      {more && (
        <button
          type="button"
          className="note-more"
          data-testid="move-note-more"
          aria-expanded={expanded}
          onClick={() => onToggle(key)}
        >
          {expanded ? "▾ less" : "▸ more"}
        </button>
      )}
    </div>
  );
}

function rowView(row: MoveRow, p: MoveListViewProps, keys: Map<TutorNote, string>): ReactNode {
  const hasNote = row.notes.length > 0;
  const open = hasNote && p.openRows.has(row.n);
  const id = `move-notes-${row.n}`;
  const className = ["move-row", hasNote ? "has-note" : "", open ? "note-open" : ""].filter(Boolean).join(" ");
  return (
    <li key={row.n} className={className}>
      <span className="move-no">{row.n}.</span>
      {cell(row.white, row.ply)}
      {cell(row.black, row.ply + 1)}
      {hasNote && (
        <button
          type="button"
          className="note-toggle"
          aria-label={noteLabel(row)}
          aria-controls={id}
          aria-expanded={open}
          data-testid="move-note-toggle"
          onClick={() => p.onToggleRow(row.n)}
        >
          ❝
        </button>
      )}
      {hasNote && (
        <div className="move-tutor" id={id}>
          {row.notes.map((note) => {
            const key = keys.get(note)!;
            return noteView(note, key, p.expanded.has(key), p.onToggleNote);
          })}
        </div>
      )}
    </li>
  );
}

/** The list for given open/expanded state; no hooks, so tests can call it and press its buttons. */
export function MoveListView(p: MoveListViewProps): ReactNode {
  const rows = moveRows(p.moves, p.notes);
  if (rows.length === 0) return <p className="muted">No moves yet.</p>;
  const keys = new Map<TutorNote, string>();
  p.notes.forEach((note, i) => keys.set(note, noteKey(note, i)));
  return (
    <div className="move-list">
      <div className="moves-head" aria-hidden="true">
        <span>#</span>
        <span>White</span>
        <span>Black</span>
        <span className="moves-head-tutor">Tutor</span>
      </div>
      <ol className="moves" data-testid="move-list">
        {rows.map((row) => rowView(row, p, keys))}
      </ol>
    </div>
  );
}

export function MoveList({ moves, notes }: { moves: MoveView[]; notes: readonly TutorNote[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [openRows, setOpenRows] = useState<ReadonlySet<number>>(() => new Set());
  return (
    <MoveListView
      moves={moves}
      notes={notes}
      expanded={expanded}
      openRows={openRows}
      onToggleNote={(key) => setExpanded((s) => toggleKey(s, key))}
      onToggleRow={(n) => setOpenRows((s) => toggleKey(s, n))}
    />
  );
}
