// The tutor panel and the board arrows (#7: FR-8, FR-11, FR-12, NFR-1, NFR-9).
import type { GameEvent, GameView } from "@chess-tutor/chess-core";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chessboardArrows, TutorPanel, type TutorPanelHandlers } from "../src/TutorPanel.tsx";
import { gameReducer, initialGameState, type GameAction, type GameState } from "../src/game-state.ts";
import { AFTER_D4_D5_FEN, AFTER_D4_FEN, BF4, D4, D5, NF3, question, reveal, tutorStatus, view } from "./fixtures.ts";

const afterD5 = (overrides: Partial<GameView> = {}) => view({ fen: AFTER_D4_D5_FEN, moves: [D4, D5], ...overrides });
const ev = (event: GameEvent): GameAction => ({ type: "server_event", event });

function at(game: GameView, ...actions: GameAction[]): GameState {
  return [{ type: "game_started", game } as GameAction, ...actions].reduce(gameReducer, initialGameState);
}

function handlers(log: string[] = []): TutorPanelHandlers {
  return { hint: async () => void log.push("hint"), reveal: async () => void log.push("reveal") };
}

function html(state: GameState): string {
  return renderToStaticMarkup(createElement(TutorPanel, { state, controller: handlers() }));
}

function button(out: string, id: string): string {
  return out.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
}

function byTestId(node: ReactNode, id: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = byTestId(child, id);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.props["data-testid"] === id) return node;
  return byTestId(node.props["children"] as ReactNode, id);
}

describe("tutor panel", () => {
  it("before a game: an intro line, no buttons", () => {
    const out = html(initialGameState);
    expect(out).toContain('data-testid="tutor-panel"');
    expect(out).not.toContain("tutor-hint");
  });

  it("shows the reason when coaching is unavailable, with Hint disabled (NFR-9)", () => {
    const out = html(at(afterD5({ tutor: tutorStatus({ available: false, reason: "Coaching is off: no API key is set." }) })));
    expect(out).toContain('data-testid="tutor-unavailable"');
    expect(out).toContain("Coaching is off: no API key is set.");
    expect(button(out, "tutor-hint")).toContain("disabled");
  });

  it("shows a fallback reason when the server gives none", () => {
    const { tutor: _t, ...legacy } = afterD5();
    const out = html(at(legacy as GameView));
    expect(out).toContain('data-testid="tutor-unavailable"');
    expect(out).toContain("Coaching is not available for this game.");
  });

  it("enables Hint on the player's turn with coaching available, and calls the controller", () => {
    const s = at(afterD5());
    expect(button(html(s), "tutor-hint")).not.toContain("disabled");
    expect(button(html(at(view({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true }))), "tutor-hint")).toContain("disabled");
    const log: string[] = [];
    const el = byTestId(TutorPanel({ state: s, controller: handlers(log) }), "tutor-hint");
    (el!.props["onClick"] as () => void)();
    expect(log).toEqual(["hint"]);
  });

  it("shows thinking at once, then the latest progress label (NFR-1)", () => {
    let s = at(afterD5(), ev({ type: "tutor_thinking", kind: "opponent_left_book" }));
    expect(html(s)).toContain('data-testid="tutor-thinking"');
    expect(html(s)).toContain("Tutor is thinking");
    s = gameReducer(s, ev({ type: "tutor_progress", label: "Tutor is looking at the position…" }));
    s = gameReducer(s, ev({ type: "tutor_progress", label: "Checking Bf4…" }));
    const out = html(s);
    expect(out).toContain("Checking Bf4…");
    expect(out).not.toContain("Tutor is looking at the position…");
    expect(button(out, "tutor-hint")).toContain("disabled");
  });

  it("shows the question and an enabled Show me that calls the controller", () => {
    const s = at(afterD5(), ev({ type: "tutor_reply", question: question() }));
    const out = html(s);
    expect(out).toContain(question().message);
    expect(button(out, "tutor-show-me")).not.toContain("disabled");
    const log: string[] = [];
    const el = byTestId(TutorPanel({ state: s, controller: handlers(log) }), "tutor-show-me");
    (el!.props["onClick"] as () => void)();
    expect(log).toEqual(["reveal"]);
  });

  it("disables Show me when the question holds no reveal", () => {
    const out = html(at(afterD5(), ev({ type: "tutor_reply", question: question({ canReveal: false }) })));
    expect(button(out, "tutor-show-me")).toContain("disabled");
  });

  it("shows the reveal text and the answer move after Show me", () => {
    const out = html(at(afterD5(), ev({ type: "tutor_reply", question: question() }), { type: "tutor_reveal_received", reveal: reveal() }));
    expect(out).toContain('data-testid="tutor-reveal"');
    expect(out).toContain(reveal().text);
    expect(out).toContain("Bf4");
    expect(button(out, "tutor-show-me")).toContain("disabled");
  });

  it("shows the attempt result: correct, or not quite with the cp loss", () => {
    const q = ev({ type: "tutor_reply", question: question() });
    const good = html(at(afterD5(), q, ev({ type: "tutor_attempt", questionId: "q1", move: BF4, correct: true, cpLoss: 0 })));
    expect(good).toContain('data-testid="tutor-attempt"');
    expect(good).toContain("Correct: Bf4 is a good move.");
    expect(good).not.toContain("tutor-show-me");
    const bad = html(at(afterD5(), q, ev({ type: "tutor_attempt", questionId: "q1", move: NF3, correct: false, cpLoss: 85 })));
    expect(bad).toContain("Not quite: Nf3 loses 85 centipawns against the best move.");
  });

  it("shows tutor_failed and a refused-request notice as plain messages", () => {
    const failed = html(at(afterD5(), ev({ type: "tutor_failed", message: "The tutor could not answer this time." })));
    expect(failed).toContain('data-testid="tutor-failed"');
    expect(failed).toContain("The tutor could not answer this time.");
    const notice = html(at(afterD5(), { type: "tutor_notice", message: "Not possible right now: the tutor is busy" }));
    expect(notice).toContain('data-testid="tutor-notice"');
    expect(notice).toContain("the tutor is busy");
  });
});

describe("board arrows", () => {
  it("maps the question's arrows to react-chessboard arrows", () => {
    const s = at(afterD5(), ev({ type: "tutor_reply", question: question() }));
    const arrows = chessboardArrows(s);
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toMatchObject({ startSquare: "c1", endSquare: "f4" });
    expect(typeof arrows[0]?.color).toBe("string");
  });

  it("passes at most 3 arrows, and a different color once revealed", () => {
    const many = ["a3", "b3", "c3", "d3"].map((to, i) => ({ from: `${"abcd"[i]}2`, to }));
    const s = at(afterD5(), ev({ type: "tutor_reply", question: question({ arrows: many }) }));
    expect(chessboardArrows(s)).toHaveLength(3);
    const r = gameReducer(s, { type: "tutor_reveal_received", reveal: reveal() });
    expect(chessboardArrows(r)).toHaveLength(1);
    expect(chessboardArrows(r)[0]?.color).not.toBe(chessboardArrows(s)[0]?.color);
  });

  it("passes none without an open question", () => {
    expect(chessboardArrows(initialGameState)).toEqual([]);
    expect(chessboardArrows(at(afterD5()))).toEqual([]);
  });
});
