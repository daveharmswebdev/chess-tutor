// Board UI: choose a color, play the sparring bot, take back, resign, retry a failed bot move.
// FR-1, FR-4, IR-5, #23.
import type { Color, MoveView } from "@chess-tutor/chess-core";
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Chessboard, type ChessboardOptions } from "react-chessboard";
import { createApiClient } from "./api.ts";
import { isOwnPiece, legalTargets, moveToUci } from "./chess-rules.ts";
import { createGameController } from "./controller.ts";
import { GameActions } from "./GameActions.tsx";
import { boardFen, gameReducer, initialGameState, isPlayersTurn, statusText } from "./game-state.ts";
import { createStore } from "./store.ts";

const SELECTED: CSSProperties = { background: "rgba(255, 213, 79, 0.55)" };
const LAST_MOVE: CSSProperties = { background: "rgba(155, 199, 0, 0.35)" };
const TARGET: CSSProperties = {
  background: "radial-gradient(circle, rgba(0, 0, 0, 0.25) 22%, transparent 24%)",
};
const CAPTURE_TARGET: CSSProperties = {
  background: "radial-gradient(circle, transparent 58%, rgba(0, 0, 0, 0.25) 60%)",
};

function MoveList({ moves }: { moves: MoveView[] }) {
  const rows: Array<{ n: number; white: MoveView | undefined; black: MoveView | undefined; ply: number }> = [];
  for (let i = 0; i < moves.length; i += 2) {
    rows.push({ n: i / 2 + 1, white: moves[i], black: moves[i + 1], ply: i });
  }
  if (rows.length === 0) return <p className="muted">No moves yet.</p>;
  const cell = (m: MoveView | undefined, ply: number) =>
    m ? (
      <span className={`ply ${m.by}`} data-testid="move-item" data-ply={ply} data-by={m.by} title={m.by === "bot" ? "Bot" : "You"}>
        {m.san}
      </span>
    ) : (
      <span className="ply" />
    );
  return (
    <ol className="moves" data-testid="move-list">
      {rows.map((r) => (
        <li key={r.n}>
          <span className="move-no">{r.n}.</span>
          {cell(r.white, r.ply)}
          {cell(r.black, r.ply + 1)}
        </li>
      ))}
    </ol>
  );
}

export function App() {
  const store = useMemo(() => createStore(gameReducer, initialGameState), []);
  const controller = useMemo(
    () =>
      createGameController({
        api: createApiClient(),
        openEvents: (url) => new EventSource(url),
        dispatch: store.dispatch,
        getState: store.getState,
      }),
    [store],
  );
  useEffect(() => () => controller.dispose(), [controller]);

  const state = useSyncExternalStore(store.subscribe, store.getState);
  const [color, setColor] = useState<Color>("w");

  const game = state.game;
  const fen = boardFen(state);
  const myTurn = isPlayersTurn(state);
  const playerColor = game?.playerColor ?? color;

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};
    const last = game?.moves.at(-1);
    if (last && state.pendingFen === null) {
      styles[last.uci.slice(0, 2)] = LAST_MOVE;
      styles[last.uci.slice(2, 4)] = LAST_MOVE;
    }
    if (state.selected && myTurn) {
      styles[state.selected] = SELECTED;
      const opponent: Color = playerColor === "w" ? "b" : "w";
      for (const t of legalTargets(fen, state.selected)) {
        styles[t] = isOwnPiece(fen, t, opponent) ? CAPTURE_TARGET : TARGET;
      }
    }
    return styles;
  }, [game, state.pendingFen, state.selected, myTurn, fen, playerColor]);

  const options: ChessboardOptions = {
    id: "board",
    position: fen,
    boardOrientation: playerColor === "b" ? "black" : "white",
    allowDragging: myTurn,
    allowDrawingArrows: false,
    squareStyles,
    canDragPiece: ({ piece }) => myTurn && piece.pieceType.startsWith(playerColor),
    onPieceDrop: ({ sourceSquare, targetSquare }) => {
      if (!targetSquare || !moveToUci(fen, sourceSquare, targetSquare)) return false;
      void controller.play(sourceSquare, targetSquare);
      return true;
    },
    onSquareClick: ({ square }) => {
      void controller.clickSquare(square);
    },
  };

  const error = state.error;

  return (
    <div className="app">
      <header>
        <h1>Chess Tutor</h1>
      </header>
      <main>
        <section className="board" data-testid="board" data-locked={myTurn ? "false" : "true"}>
          <Chessboard options={options} />
        </section>
        <aside className="side">
          <div className="panel controls">
            <fieldset disabled={state.busy}>
              <legend>Play as</legend>
              <label>
                <input
                  type="radio"
                  name="color"
                  data-testid="color-white"
                  checked={color === "w"}
                  onChange={() => setColor("w")}
                />
                White
              </label>
              <label>
                <input
                  type="radio"
                  name="color"
                  data-testid="color-black"
                  checked={color === "b"}
                  onChange={() => setColor("b")}
                />
                Black
              </label>
            </fieldset>
            <button type="button" className="primary" data-testid="new-game" disabled={state.busy} onClick={() => void controller.newGame(color)}>
              New game
            </button>
          </div>

          <div className="panel status" role="status" aria-live="polite">
            <p data-testid="status">{statusText(state)}</p>
            {error && (
              <p className="error" data-testid="status-error">
                {error}
              </p>
            )}
          </div>

          <div className="panel">
            <h2>Moves</h2>
            <MoveList moves={game?.moves ?? []} />
            <GameActions state={state} controller={controller} />
          </div>

          <div className="panel tutor" data-testid="tutor-panel">
            <h2>Tutor</h2>
            <p className="muted">The tutor will comment on key moments of your game here. Coming soon.</p>
          </div>
        </aside>
      </main>
    </div>
  );
}
