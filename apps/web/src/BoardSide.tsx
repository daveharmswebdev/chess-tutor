// The 'Bot' row above the board and the 'You' row below it, each with the pieces that side has
// captured and, for the side ahead only, '+N' material (#42, FR-20, FR-4). A piece count, labelled
// so it can't be read as an engine evaluation (FR-10). Uses no hooks.
import type { Color } from "@chess-tutor/chess-core";
import { materialFromFen, type CapturablePiece } from "./material.ts";

const GLYPH: Record<Color, Record<CapturablePiece, string>> = {
  w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕" },
  b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛" },
};
const NAME: Record<CapturablePiece, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };

export interface BoardSideProps {
  /** The position on the board: boardFen(state). */
  fen: string;
  playerColor: Color;
  /** The top row is the bot's, the bottom row the player's. */
  side: "top" | "bottom";
}

export function BoardSide({ fen, playerColor, side }: BoardSideProps) {
  const who = side === "bottom" ? "you" : "bot";
  const color: Color = side === "bottom" ? playerColor : playerColor === "w" ? "b" : "w";
  const opponent: Color = color === "w" ? "b" : "w";
  const mine = materialFromFen(fen)[color];
  const label = `Material: +${mine.lead} (piece count, not an engine evaluation)`;
  return (
    <div className={`board-side ${side}`} data-testid={`side-${who}`} data-color={color}>
      <span className="side-name">{who === "you" ? "You" : "Bot"}</span>
      <span className="captured" data-testid={`captured-${who}`} aria-label={`Captured by ${who === "you" ? "you" : "the bot"}`}>
        {mine.captured.map(({ type, count }) => (
          <span key={type} className="captured-group" data-piece={type} data-count={count} title={`${count} ${NAME[type]}${count > 1 ? "s" : ""}`}>
            {GLYPH[opponent][type].repeat(count)}
          </span>
        ))}
      </span>
      {mine.lead > 0 && (
        <span className="material-lead" data-testid={`material-${who}`} title={label} aria-label={label}>
          +{mine.lead}
        </span>
      )}
    </div>
  );
}
