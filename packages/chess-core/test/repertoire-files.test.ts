import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import {
  buildRepertoire,
  detect,
  type Color,
  type DetectorInput,
  type KeyMomentThresholds,
} from "../src/index.ts";
import { parseRepertoirePgn } from "../src/repertoire-pgn.ts";
import { analysis, cp, play } from "./fixtures.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");
const T = (JSON.parse(read("config/tutor.json")) as { keyMoments: KeyMomentThresholds })
  .keyMoments;

const london = parseRepertoirePgn(read("repertoire/london.pgn"), "w");
const kid = parseRepertoirePgn(read("repertoire/kid.pgn"), "b");
const repertoire = buildRepertoire([...london, ...kid]);

/** UCI moves of a mainline movetext, from the start position. */
function uciMoves(pgn: string): string[] {
  const chess = new Chess();
  chess.loadPgn(pgn);
  return chess.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ""));
}

function lineMoves(lines: { name: string; pgn: string }[], name: string): string[] {
  const line = lines.find((l) => l.name === name);
  if (!line) throw new Error(`no line ${name}`);
  return uciMoves(line.pgn);
}

/** Detector input for an opponent move after `history`, with quiet evals (no punish). */
function opponentMove(
  playerColor: Color,
  history: string[],
  move: string,
  best: string,
): DetectorInput {
  const chess = new Chess();
  for (const m of history) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
  const fenBefore = chess.fen();
  return {
    playerColor,
    fenBefore,
    move,
    history,
    before: analysis(fenBefore, best, cp(20)),
    after: analysis(play(fenBefore, move), "(none)", cp(30)),
    repertoire,
    thresholds: T,
  };
}

describe("repertoire files", () => {
  it("london.pgn has the three agreed lines", () => {
    expect(london.map((l) => l.name)).toEqual([
      "London vs 1...d5",
      "London vs 1...Nf6 (g6)",
      "London vs ...c5",
    ]);
  });

  it("kid.pgn has the three agreed lines", () => {
    expect(kid.map((l) => l.name)).toEqual(["KID Classical", "KID vs London", "KID Fianchetto"]);
  });

  it.each([...london, ...kid])("$name is legal and 8-10 full moves deep", (line) => {
    expect(() => buildRepertoire([line])).not.toThrow();
    const plies = uciMoves(line.pgn).length;
    expect(plies).toBeGreaterThanOrEqual(15);
    expect(plies).toBeLessThanOrEqual(20);
  });

  it("every London line starts 1. d4 ... 2. Bf4 and every KID line starts 1. d4 Nf6", () => {
    for (const l of london) {
      const m = uciMoves(l.pgn);
      expect([m[0], m[2]]).toEqual(["d2d4", "c1f4"]);
    }
    for (const l of kid) expect(uciMoves(l.pgn).slice(0, 2)).toEqual(["d2d4", "g8f6"]);
  });

  it("each line can be followed to its end through the combined repertoire", () => {
    for (const [lines, color] of [
      [london, "w"],
      [kid, "b"],
    ] as const) {
      for (const l of lines) {
        const moves = uciMoves(l.pgn);
        moves.forEach((uci, i) => {
          const c = repertoire.continuations(moves.slice(0, i), color);
          expect(c?.moves.map((m) => m.uci)).toContain(uci);
        });
        expect(repertoire.continuations(moves, color)?.moves).toEqual([]);
      }
    }
  });
});

describe("detector with the real repertoire", () => {
  // London vs 1...Nf6 (g6): 1. d4 Nf6 2. Bf4 g6 3. e3 Bg7 4. Nf3 d6 5. h3 O-O 6. Be2 c5
  const g6Line = lineMoves(london, "London vs 1...Nf6 (g6)");
  const historyBeforeC5 = g6Line.slice(0, 11); // through 6. Be2, Black to move

  it("London: 6...Nbd7 instead of 6...c5 is opponent_left_book", () => {
    expect(detect(opponentMove("w", historyBeforeC5, "b8d7", "c7c5"))).toEqual({
      kind: "opponent_left_book",
      line: "London vs 1...Nf6 (g6)",
      expected: ["c5"],
      played: "Nbd7",
    });
  });

  it("London: 6...c5 stays in the line", () => {
    expect(detect(opponentMove("w", historyBeforeC5, "c7c5", "c7c5"))).toBeNull();
  });

  it("London: 2...e6 after 1. d4 d5 2. Bf4 leaves both ...d5 lines", () => {
    const history = ["d2d4", "d7d5", "c1f4"];
    expect(detect(opponentMove("w", history, "e7e6", "g8f6"))).toEqual({
      kind: "opponent_left_book",
      line: "London vs 1...d5",
      expected: ["Nf6", "c5"],
      played: "e6",
    });
  });

  it("London: 2...c5 after 1. d4 d5 2. Bf4 stays in the ...c5 line", () => {
    const history = ["d2d4", "d7d5", "c1f4"];
    expect(detect(opponentMove("w", history, "c7c5", "g8f6"))).toBeNull();
  });

  // KID Classical: 1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2 e5 7. O-O
  const classical = lineMoves(kid, "KID Classical");
  const historyBeforeCastle = classical.slice(0, 12); // through 6...e5, White to move

  it("KID: 7. d5 instead of 7. O-O is opponent_left_book", () => {
    expect(detect(opponentMove("b", historyBeforeCastle, "d4d5", "e1g1"))).toEqual({
      kind: "opponent_left_book",
      line: "KID Classical",
      expected: ["O-O"],
      played: "d5",
    });
  });

  it("KID: 7. O-O stays in the line", () => {
    expect(detect(opponentMove("b", historyBeforeCastle, "e1g1", "e1g1"))).toBeNull();
  });

  it("KID: 2. Nf3 after 1. d4 Nf6 leaves every KID line", () => {
    expect(detect(opponentMove("b", ["d2d4", "g8f6"], "g1f3", "c2c4"))).toEqual({
      kind: "opponent_left_book",
      line: "KID Classical",
      expected: ["c4", "Bf4"],
      played: "Nf3",
    });
  });

  it("KID: 2. Bf4 stays in KID vs London", () => {
    expect(detect(opponentMove("b", ["d2d4", "g8f6"], "c1f4", "c2c4"))).toBeNull();
  });

  it("London lines are not book when the player is Black", () => {
    // 1. d4 d5 is only in london.pgn: for Black it is outside the repertoire, so White's
    // next move is not judged against the London lines.
    expect(detect(opponentMove("b", ["d2d4", "d7d5"], "c1f4", "c1f4"))).toBeNull();
  });
});
