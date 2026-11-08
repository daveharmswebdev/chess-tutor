import { boardOf, normalizeSan, playUci, uciOf, type MovePair } from "./chess-util.ts";

/**
 * What the tutor was shown in one ask() (FR-10): the positions it may talk about and the moves
 * that came from tool results, the key-moment data or the game's own history. Built fresh per
 * request; tools add to it as they run.
 */
export class Evidence {
  private readonly positions = new Set<string>();
  private readonly backed = new Set<string>();

  addPosition(fen: string): void {
    if (boardOf(fen)) this.positions.add(fen);
  }

  /** Marks a SAN move as backed (position-independent: "Nf3" anywhere backs "Nf3"). */
  addSan(san: string): void {
    this.backed.add(normalizeSan(san));
  }

  /** Plays `uci` in `fen`; records both positions and backs the move. Null when illegal. */
  addMove(fen: string, uci: string): MovePair | null {
    return this.addLine(fen, [uci])[0] ?? null;
  }

  /** Plays a UCI line from `fen`, recording every position reached and backing every move. Stops at an illegal move. */
  addLine(fen: string, line: string[]): MovePair[] {
    const chess = boardOf(fen);
    if (!chess) return [];
    this.positions.add(chess.fen());
    const pairs: MovePair[] = [];
    for (const uci of line) {
      const move = playUci(chess, uci);
      if (!move) break;
      pairs.push({ san: move.san, uci: uciOf(move) });
      this.addSan(move.san);
      this.positions.add(chess.fen());
    }
    return pairs;
  }

  backs(san: string): boolean {
    return this.backed.has(normalizeSan(san));
  }

  positionList(): string[] {
    return [...this.positions];
  }
}
