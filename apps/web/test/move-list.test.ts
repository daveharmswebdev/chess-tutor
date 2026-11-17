// The move list with tutor notes (#54: FR-25, NFR-14). Both layouts are in the markup and CSS
// picks one by the list's width: the wide one shows a Tutor column with a shortened note and
// "▸ more"; the narrow one hides that column and gives each row with a note a ❝ button that opens
// the full note under the row. MoveListView has no hooks, so its tree is walked to press buttons.
import type { MoveView, TutorNote } from "@chess-tutor/chess-core";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoveList, MoveListView, noteKey, rowKey, type MoveListViewProps } from "../src/MoveList.tsx";
import { moveRows } from "../src/move-notes.ts";
import { BF4, D4, D5 } from "./fixtures.ts";

const G6: MoveView = { uci: "g7g6", san: "g6", by: "bot" };
const E3: MoveView = { uci: "e2e3", san: "e3", by: "player" };
const H3: MoveView = { uci: "h2h3", san: "h3", by: "player" };
const MOVES = [D4, D5, BF4, G6, E3];

const SHORT: TutorNote = {
  questionId: "q1",
  kind: "opponent_left_book",
  ply: 3,
  message: "Black left your book.",
  reveal: null,
  bestMove: null,
  attempt: null,
};
const LONG: TutorNote = {
  questionId: "q2",
  kind: "player_blunder",
  ply: 4,
  message: "e3 lets ...Nh5 hit your bishop.",
  reveal: "The bishop on f4 has no retreat after ...Nh5.",
  bestMove: H3,
  attempt: null,
};
const NOTES = [SHORT, LONG];

function props(overrides: Partial<MoveListViewProps> = {}): MoveListViewProps {
  return {
    moves: MOVES,
    notes: NOTES,
    expanded: new Set(),
    openRows: new Set(),
    cut: new Set(),
    onToggleNote: () => {},
    onToggleRow: () => {},
    ...overrides,
  };
}

const html = (p: MoveListViewProps) => renderToStaticMarkup(createElement(MoveListView, p));

function allByTestId(node: ReactNode, id: string, out: Array<ReactElement<Record<string, unknown>>> = []) {
  if (Array.isArray(node)) {
    for (const child of node) allByTestId(child, id, out);
    return out;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return out;
  if (node.props["data-testid"] === id) out.push(node);
  allByTestId(node.props["children"] as ReactNode, id, out);
  return out;
}

const tree = (p: MoveListViewProps) => MoveListView(p) as ReactNode;

/** The markup of each <li> row, in order. */
const rowsOf = (out: string) => out.match(/<li[^>]*>.*?<\/li>/g) ?? [];

describe("move list: unchanged parts", () => {
  it("keeps move-list and move-item with data-ply and data-by", () => {
    const out = html(props({ notes: [] }));
    expect(out).toContain('data-testid="move-list"');
    expect(out.match(/data-testid="move-item"/g)).toHaveLength(5);
    expect(out).toContain('data-testid="move-item" data-ply="3" data-by="bot"');
    expect(out).not.toContain("move-note");
  });

  it("still says No moves yet. without moves or notes", () => {
    expect(html(props({ moves: [], notes: [] }))).toContain("No moves yet.");
    // The stateful wrapper renders the same list.
    expect(renderToStaticMarkup(createElement(MoveList, { moves: MOVES, notes: NOTES }))).toBe(
      `<div class="move-list-root">${html(props())}</div>`,
    );
  });
});

describe("move list: wide layout, Tutor column (FR-25)", () => {
  it("has a Tutor column heading and one move-note per note on its row", () => {
    const out = html(props());
    expect(out).toContain(">Tutor<");
    const rows = rowsOf(out);
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toContain("move-note");
    expect(rows[1]).toContain('data-testid="move-note" data-ply="3"');
    expect(rows[2]).toContain('data-testid="move-note" data-ply="4"');
    expect(out.match(/data-testid="move-note"/g)).toHaveLength(2);
  });

  it("shows the message as the short line, and ▸ more only when there is more", () => {
    const out = html(props());
    const rows = rowsOf(out);
    expect(rows[1]).toContain('<span class="note-short">Black left your book.</span>');
    expect(rows[1]).not.toContain("move-note-more");
    expect(rows[2]).toContain('<span class="note-short">e3 lets ...Nh5 hit your bishop.</span>');
    expect(rows[2]).toMatch(/<button[^>]*data-testid="move-note-more"[^>]*aria-expanded="false"[^>]*>▸ more<\/button>/);
  });

  it("▸ more expands the full note in place, and pressing it again collapses it", () => {
    const pressed: string[] = [];
    const more = allByTestId(tree(props({ onToggleNote: (k) => pressed.push(k) })), "move-note-more");
    expect(more).toHaveLength(1);
    (more[0]!.props["onClick"] as () => void)();
    expect(pressed).toEqual([noteKey(LONG)]);

    const open = html(props({ expanded: new Set([noteKey(LONG)]) }));
    const row = rowsOf(open)[2]!;
    expect(row).toContain('class="move-note expanded"');
    expect(row).toContain("The bishop on f4 has no retreat after ...Nh5.");
    expect(row).toContain("Best was h3.");
    expect(row).toMatch(/data-testid="move-note-more"[^>]*aria-expanded="true"[^>]*>▾ less<\/button>/);
    // Collapsed again: the class and the control go back.
    const closed = rowsOf(html(props({ expanded: new Set() })))[2]!;
    expect(closed).toContain('class="move-note"');
    expect(closed).toContain(">▸ more</button>");
  });

  it("shows two notes on one row in GameView order", () => {
    const second: TutorNote = { ...SHORT, questionId: "q3", ply: 2, message: "Bf4 is your London bishop." };
    const row = rowsOf(html(props({ notes: [SHORT, second] })))[1]!;
    expect(row.indexOf("Black left your book.")).toBeLessThan(row.indexOf("Bf4 is your London bishop."));
    expect(row.match(/data-testid="move-note"/g)).toHaveLength(2);
  });
});

describe("move list: narrow layout, ❝ button (FR-25)", () => {
  it("puts a ❝ button only on rows with a note, named after the move", () => {
    const out = html(props());
    const rows = rowsOf(out);
    expect(rows[0]).not.toContain("move-note-toggle");
    expect(rows[1]).toMatch(/<button[^>]*aria-label="Tutor note for move 2... g6"[^>]*data-testid="move-note-toggle"[^>]*>❝<\/button>/);
    expect(rows[2]).toContain('aria-label="Tutor note for move 3. e3"');
    expect(out.match(/data-testid="move-note-toggle"/g)).toHaveLength(2);
  });

  it("the ❝ button opens the notes under its own row and says so with aria-expanded", () => {
    const pressed: string[] = [];
    const toggles = allByTestId(tree(props({ onToggleRow: (n) => pressed.push(n) })), "move-note-toggle");
    (toggles[0]!.props["onClick"] as () => void)();
    expect(pressed).toEqual([rowKey(moveRows(MOVES, NOTES)[1]!)]);

    const closed = rowsOf(html(props()))[1]!;
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("note-open");

    const open = rowsOf(html(props({ openRows: new Set([rowKey(moveRows(MOVES, NOTES)[1]!)]) })));
    expect(open[1]).toContain('class="move-row has-note note-open"');
    expect(open[1]).toMatch(/aria-controls="move-notes-2" aria-expanded="true"/);
    // The notes block sits inside that row, after its moves, holding the full text.
    expect(open[1]).toMatch(/data-testid="move-item"[^>]*>g6<\/span>.*id="move-notes-2".*Black left your book\./);
    expect(open[2]).not.toContain("note-open");
  });

  it("a second tap closes it: the row is no longer open", () => {
    const rows = rowsOf(html(props({ openRows: new Set() })));
    expect(rows[1]).toContain('class="move-row has-note"');
  });
});

describe("move list: ▸ more for a cut-off line (review 095)", () => {
  const ONLY: TutorNote = { ...SHORT, questionId: "q9", ply: 2, message: "Why does Bf4 come before e3 here, do you think?" };

  it("offers ▸ more for a message-only note only when the browser found its line cut off", () => {
    const fits = html(props({ notes: [ONLY] }));
    expect(fits).not.toContain("move-note-more");
    expect(fits).toContain(`data-note-key="${noteKey(ONLY)}"`);
    const cut = html(props({ notes: [ONLY], cut: new Set([noteKey(ONLY)]) }));
    expect(cut).toContain(">▸ more</button>");
    const open = html(props({ notes: [ONLY], cut: new Set([noteKey(ONLY)]), expanded: new Set([noteKey(ONLY)]) }));
    expect(open).toContain('class="move-note expanded"');
    expect(open).toContain(">▾ less</button>");
  });
});

describe("move list: no stale open state after a takeback (review 095)", () => {
  it("a new note on a row whose old note was taken back renders closed in both layouts", () => {
    // Before: SHORT on row 2 (ply 3), opened with ❝ and expanded with ▸ more.
    const before = moveRows(MOVES, [SHORT]);
    const openRows = new Set([rowKey(before[1]!)]);
    const expanded = new Set([noteKey(SHORT)]);
    expect(rowsOf(html(props({ notes: [SHORT], openRows, expanded })))[1]).toContain("note-open");
    // Takeback to ply 3 removes SHORT; the next move brings a new question's note on the same ply.
    const fresh: TutorNote = { ...SHORT, questionId: "q-new", message: "A new question.", reveal: "More." };
    const row = rowsOf(html(props({ notes: [fresh], openRows, expanded })))[1]!;
    expect(row).toContain("A new question.");
    expect(row).not.toContain("note-open");
    expect(row).toContain('aria-expanded="false"');
    expect(row).not.toContain("expanded\"");
    expect(row).toContain('class="move-note"');
  });
});
