// Action buttons under the move list: Retry bot move (#23), Takeback, Resign. FR-1, FR-4.
// No hooks, so tests can render it on the server or call it directly.
import type { GameController } from "./controller.ts";
import { canResign, canRetryBot, canTakeback, type GameState } from "./game-state.ts";

export type GameActionHandlers = Pick<GameController, "takeback" | "resign" | "retryBot">;

export function GameActions({ state, controller }: { state: GameState; controller: GameActionHandlers }) {
  return (
    <div className="actions">
      {canRetryBot(state) && (
        <button type="button" className="primary" data-testid="retry-bot" onClick={() => void controller.retryBot()}>
          Retry bot move
        </button>
      )}
      <button type="button" data-testid="takeback" disabled={!canTakeback(state)} onClick={() => void controller.takeback()}>
        Takeback
      </button>
      <button type="button" data-testid="resign" disabled={!canResign(state)} onClick={() => void controller.resign()}>
        Resign
      </button>
    </div>
  );
}
