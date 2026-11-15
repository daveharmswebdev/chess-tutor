// "Reconnecting…" while the server is unreachable, or "Game not found." with a New game action
// after a 404 (#47: NFR-14, NFR-9). Shown in the status panel, where errors go. No hooks.
import type { GameState } from "./game-state.ts";

export function ConnectionNotice({
  state,
  onNewGame,
}: {
  state: Pick<GameState, "reconnecting" | "notFound">;
  onNewGame: () => void;
}) {
  if (state.notFound) {
    return (
      <div className="error" data-testid="game-not-found">
        <p>Game not found.</p>
        <button type="button" className="primary" data-testid="not-found-new-game" onClick={onNewGame}>
          New game
        </button>
      </div>
    );
  }
  if (state.reconnecting) {
    return (
      <p className="notice" data-testid="reconnecting">
        Reconnecting…
      </p>
    );
  }
  return null;
}
