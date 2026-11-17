// The move list with the tutor's notes (#54: FR-25, NFR-14, FR-10). Both layouts are in the
// markup; styles.css picks one by the list's own width (a container query), not the viewport:
//   wide:   a third "Tutor" column, each note shortened to one line, "▸ more" expands it in place;
//   narrow: no Tutor column; a row with a note gets a ❝ button that opens the full note under it.
// Notes arrive only inside GameView, so a refresh shows them again (NFR-14). The text comes from
// move-notes.ts, which uses only the note's own fields (FR-10).
// "▸ more" is offered when the note says more than its message, or when the browser finds the
// one-line message cut off (measured after each render and on resize; review 095).
import type { MoveView, TutorNote } from "@chess-tutor/chess-core";
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { moveRows, noteHasMore, noteLabel, noteParts, toggleKey, type MoveRow } from "./move-notes.ts";

/**
 * A note's key for its open state: its question and ply. A note that replaces a taken-back one
 * comes from a new question, so it never inherits the old one's state (review 095).
 */
export function noteKey(note: TutorNote): string {
  return `${note.questionId}@${note.ply}`;
}

/**
 * A row's key for its ❝ state: the move number plus the notes on it, so a row whose notes changed
 * (a takeback removed one, a new one arrived) starts closed (review 095).
 */
export function rowKey(row: MoveRow): string {
  return `${row.n}:${row.notes.map(noteKey).join(",")}`;
}

export interface MoveListViewProps {
  moves: MoveView[];
  notes: readonly TutorNote[];
  /** Notes (noteKey) expanded with "▸ more" in the wide layout. */
  expanded: ReadonlySet<string>;
  /** Rows (rowKey) opened with ❝ in the narrow layout. */
  openRows: ReadonlySet<string>;
  /** Notes (noteKey) whose one-line message the browser found cut off. */
  cut: ReadonlySet<string>;
  onToggleNote: (key: string) => void;
  onToggleRow: (key: string) => void;
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

function noteView(note: TutorNote, p: MoveListViewProps): ReactNode {
  const key = noteKey(note);
  const expanded = p.expanded.has(key);
  const more = noteHasMore(note) || p.cut.has(key) || expanded;
  return (
    <div
      key={key}
      className={expanded ? "move-note expanded" : "move-note"}
      data-testid="move-note"
      data-ply={note.ply}
      data-note-key={key}
    >
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
          onClick={() => p.onToggleNote(key)}
        >
          {expanded ? "▾ less" : "▸ more"}
        </button>
      )}
    </div>
  );
}

function rowView(row: MoveRow, p: MoveListViewProps): ReactNode {
  const hasNote = row.notes.length > 0;
  const key = rowKey(row);
  const open = hasNote && p.openRows.has(key);
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
          onClick={() => p.onToggleRow(key)}
        >
          ❝
        </button>
      )}
      {hasNote && (
        <div className="move-tutor" id={id}>
          {row.notes.map((note) => noteView(note, p))}
        </div>
      )}
    </li>
  );
}

/** The list for given open/expanded/cut state; no hooks, so tests can call it and press its buttons. */
export function MoveListView(p: MoveListViewProps): ReactNode {
  const rows = moveRows(p.moves, p.notes);
  if (rows.length === 0) return <p className="muted">No moves yet.</p>;
  return (
    <div className="move-list">
      <div className="moves-head" aria-hidden="true">
        <span>#</span>
        <span>White</span>
        <span>Black</span>
        <span className="moves-head-tutor">Tutor</span>
      </div>
      <ol className="moves" data-testid="move-list">
        {rows.map((row) => rowView(row, p))}
      </ol>
    </div>
  );
}

/** Keys of the notes whose visible one-line message is wider than its box. */
function measureCut(root: HTMLElement): Set<string> {
  const out = new Set<string>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-note-key]"))) {
    const short = el.querySelector<HTMLElement>(".note-short");
    // A hidden line (narrow layout, or expanded) has clientWidth 0: nothing to measure there.
    if (short && short.clientWidth > 0 && short.scrollWidth > short.clientWidth) out.add(el.dataset["noteKey"]!);
  }
  return out;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((k) => b.has(k));
}

export function MoveList({ moves, notes }: { moves: MoveView[]; notes: readonly TutorNote[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const [cut, setCut] = useState<ReadonlySet<string>>(() => new Set());
  const ref = useRef<HTMLDivElement>(null);

  // After every render and on resize: which one-line messages are cut off. A note keeps the cut
  // mark while it is expanded (its line is hidden then), so "▾ less" stays until it is closed.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => {
      const measured = measureCut(root);
      setCut((prev) => {
        const next = new Set(measured);
        for (const k of prev) {
          const el = root.querySelector<HTMLElement>(`[data-note-key="${CSS.escape(k)}"] .note-short`);
          if (el && el.clientWidth === 0) next.add(k); // hidden now: keep the last measurement
        }
        return sameSet(prev, next) ? prev : next;
      });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  });

  return (
    <div ref={ref} className="move-list-root">
      <MoveListView
        moves={moves}
        notes={notes}
        expanded={expanded}
        openRows={openRows}
        cut={cut}
        onToggleNote={(key) => setExpanded((s) => toggleKey(s, key))}
        onToggleRow={(key) => setOpenRows((s) => toggleKey(s, key))}
      />
    </div>
  );
}
