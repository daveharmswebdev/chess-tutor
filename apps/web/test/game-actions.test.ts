// The action buttons under the move list, including "Retry bot move" (#23, FR-1, FR-4).
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GameActions, type GameActionHandlers } from "../src/GameActions.tsx";
import { gameReducer, initialGameState, type GameState } from "../src/game-state.ts";
import { AFTER_D4_D5_FEN, AFTER_D4_FEN, D4, D5, view } from "./fixtures.ts";

function started(overrides: Parameters<typeof view>[0] = {}): GameState {
  return gameReducer(initialGameState, { type: "game_started", game: view(overrides) });
}

function handlers(log: string[]): GameActionHandlers {
  return {
    takeback: async () => void log.push("takeback"),
    resign: async () => void log.push("resign"),
    retryBot: async () => void log.push("retryBot"),
  };
}

function html(state: GameState): string {
  return renderToStaticMarkup(createElement(GameActions, { state, controller: handlers([]) }));
}

/** Finds the element with a data-testid in the tree GameActions returns (it uses no hooks). */
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

function button(out: string, id: string): string {
  return out.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
}

describe("game actions", () => {
  it("shows Retry bot move after a bot failure (fresh Black game, zero moves)", () => {
    const out = html(started({ playerColor: "b" }));
    expect(button(out, "retry-bot")).not.toBe("");
    expect(button(out, "retry-bot")).not.toContain("disabled");
    expect(out).toContain("Retry bot move");
  });

  it("hides Retry bot move on the player's turn, while the bot thinks, and after the game", () => {
    expect(html(started({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }))).not.toContain("retry-bot");
    expect(html(started({ fen: AFTER_D4_FEN, moves: [D4], botThinking: true }))).not.toContain("retry-bot");
    expect(html(started({ playerColor: "b", status: "abandoned", endReason: "abandoned" }))).not.toContain("retry-bot");
    expect(html(initialGameState)).not.toContain("retry-bot");
  });

  it("keeps Takeback and Resign as before", () => {
    const out = html(started({ fen: AFTER_D4_D5_FEN, moves: [D4, D5] }));
    expect(out).toContain(">Takeback</button>");
    expect(out).toContain(">Resign</button>");
    expect(button(out, "takeback")).not.toContain("disabled");
    expect(button(out, "resign")).not.toContain("disabled");
    expect(button(html(started()), "takeback")).toContain("disabled");
  });

  it("wires each button to its controller action", () => {
    const log: string[] = [];
    const tree = GameActions({ state: started({ fen: AFTER_D4_FEN, moves: [D4] }), controller: handlers(log) });
    for (const id of ["retry-bot", "takeback", "resign"]) {
      const el = byTestId(tree, id);
      expect(el, id).not.toBeNull();
      (el!.props["onClick"] as () => void)();
    }
    expect(log).toEqual(["retryBot", "takeback", "resign"]);
  });
});
