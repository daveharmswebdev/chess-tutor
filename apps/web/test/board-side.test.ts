// The 'You' / 'Bot' rows above and below the board, with captured pieces and the material
// lead (#42, FR-20, FR-4). The lead is a piece count, labelled so it can't pass for an eval (FR-10).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardSide } from "../src/BoardSide.tsx";
import { boardFen, gameReducer, initialGameState } from "../src/game-state.ts";
import { START_FEN, view } from "./fixtures.ts";

// Black's b8 knight and White's e-pawn are gone: White is +2.
const WHITE_UP_KNIGHT_FOR_PAWN = "r1bqkbnr/pppppppp/8/8/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";

function html(fen: string, playerColor: "w" | "b", side: "top" | "bottom"): string {
  return renderToStaticMarkup(createElement(BoardSide, { fen, playerColor, side }));
}

function advantage(out: string): string | null {
  return out.match(/data-testid="material-(?:you|bot)"[^>]*>([^<]*)</)?.[1] ?? null;
}

describe("BoardSide", () => {
  it("labels the top row Bot and the bottom row You", () => {
    expect(html(START_FEN, "w", "top")).toContain('data-testid="side-bot"');
    expect(html(START_FEN, "w", "top")).toContain(">Bot<");
    expect(html(START_FEN, "w", "bottom")).toContain('data-testid="side-you"');
    expect(html(START_FEN, "w", "bottom")).toContain(">You<");
  });

  it("shows nothing for material when level", () => {
    for (const side of ["top", "bottom"] as const) {
      const out = html(START_FEN, "w", side);
      expect(advantage(out)).toBeNull();
      expect(out).not.toContain("data-piece=");
    }
  });

  it("+N only on the side ahead, labelled as a piece count, not an engine evaluation", () => {
    const you = html(WHITE_UP_KNIGHT_FOR_PAWN, "w", "bottom");
    const bot = html(WHITE_UP_KNIGHT_FOR_PAWN, "w", "top");
    expect(advantage(you)).toBe("+2");
    expect(advantage(bot)).toBeNull();
    expect(you).toContain('aria-label="Material: +2 (piece count, not an engine evaluation)"');
    expect(you).toContain('title="Material: +2 (piece count, not an engine evaluation)"');
  });

  it("captured pieces sit on the capturing side, as the opponent's glyphs", () => {
    const you = html(WHITE_UP_KNIGHT_FOR_PAWN, "w", "bottom");
    const bot = html(WHITE_UP_KNIGHT_FOR_PAWN, "w", "top");
    expect(you).toMatch(/data-piece="n"[^>]*data-count="1"[^>]*>♞</);
    expect(bot).toMatch(/data-piece="p"[^>]*data-count="1"[^>]*>♙</);
    expect(you).not.toContain('data-piece="p"');
  });

  it("follows orientation: as Black, the bottom row (You) is Black's", () => {
    const you = html(WHITE_UP_KNIGHT_FOR_PAWN, "b", "bottom");
    const bot = html(WHITE_UP_KNIGHT_FOR_PAWN, "b", "top");
    expect(you).toContain('data-testid="side-you"');
    expect(advantage(you)).toBeNull();
    expect(you).toContain('data-piece="p"');
    expect(advantage(bot)).toBe("+2");
    expect(bot).toContain('data-piece="n"');
  });

  it("a takeback (an earlier FEN from the server) clears the capture again", () => {
    const after = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
    const before = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    let state = gameReducer(initialGameState, { type: "game_started", game: view({ fen: before }) });
    // The optimistic board (pendingFen) already shows the capture.
    state = gameReducer(state, { type: "move_attempted", uci: "e4d5", fen: after });
    expect(advantage(html(boardFen(state), "w", "bottom"))).toBe("+1");
    state = gameReducer(state, { type: "move_accepted", game: view({ fen: after }) });
    expect(advantage(html(boardFen(state), "w", "bottom"))).toBe("+1");
    state = gameReducer(state, { type: "request_started" });
    state = gameReducer(state, { type: "request_succeeded", game: view({ fen: before }) });
    const out = html(boardFen(state), "w", "bottom");
    expect(advantage(out)).toBeNull();
    expect(out).not.toContain("data-piece=");
  });
});
