import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRepertoire,
  detect,
  scoreToCp,
  type Analysis,
  type DetectorInput,
  type KeyMoment,
  type KeyMomentThresholds,
  type Repertoire,
  type Score,
} from "../src/index.ts";
import {
  AFTER_D4_NF6,
  AFTER_E4,
  AFTER_NC6,
  AFTER_NF3,
  FOOLS,
  KQK,
  PROMO,
  START,
  analysis,
  cp,
  mate,
  play,
  terminal,
} from "./fixtures.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const config = JSON.parse(readFileSync(join(repoRoot, "config", "tutor.json"), "utf8")) as {
  keyMoments: KeyMomentThresholds;
};
const T: KeyMomentThresholds = config.keyMoments;

const repertoire = buildRepertoire([
  { name: "Italian", color: "w", pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4" },
  { name: "KID vs c4", color: "b", pgn: "1. d4 Nf6 2. c4 g6 3. Nc3 Bg7" },
  { name: "KID vs London", color: "b", pgn: "1. d4 Nf6 2. Bf4 g6" },
]);

interface Case {
  name: string;
  playerColor: "w" | "b";
  fen: string;
  move: string;
  history?: string[];
  best: string; // before.bestMove (UCI)
  before: Score;
  reply?: string; // after.bestMove (UCI); omit for a terminal position
  after: Score | "terminal";
  repertoire?: Repertoire | null;
  thresholds?: KeyMomentThresholds;
  /** Extra multi-PV lines in `before` (ranks 2, 3, ...). */
  otherLines?: { move: string; score: Score }[];
  expected: KeyMoment | null;
}

function input(c: Case): DetectorInput {
  const afterFen = play(c.fen, c.move);
  const after: Analysis =
    c.after === "terminal" ? terminal(afterFen) : analysis(afterFen, c.reply ?? "(none)", c.after);
  const before = analysis(c.fen, c.best, c.before);
  (c.otherLines ?? []).forEach((l, i) =>
    before.lines.push({ rank: i + 2, moves: [l.move], score: l.score, depth: 18 }),
  );
  return {
    playerColor: c.playerColor,
    fenBefore: c.fen,
    move: c.move,
    history: c.history ?? [],
    before,
    after,
    repertoire: c.repertoire ?? null,
    thresholds: c.thresholds ?? T,
  };
}

const cases: Case[] = [
  // --- ordinary moves -> null (FR-7)
  {
    name: "ordinary player move (White) is silent",
    playerColor: "w", fen: START, move: "e2e4", best: "e2e4", before: cp(30), reply: "e7e5", after: cp(25),
    expected: null,
  },
  {
    name: "ordinary player move (Black) is silent",
    playerColor: "b", fen: AFTER_E4, move: "e7e5", best: "c7c5", before: cp(30), reply: "g1f3", after: cp(35),
    expected: null,
  },
  {
    name: "ordinary opponent move is silent",
    playerColor: "w", fen: AFTER_E4, move: "e7e5", best: "c7c5", before: cp(30), reply: "g1f3", after: cp(35),
    expected: null,
  },
  {
    name: "a move better than the engine's best never reports a negative loss",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: cp(30), reply: "g8f6", after: cp(500),
    expected: null,
  },

  // --- player_blunder
  {
    name: "player_blunder fires exactly at blunderCp (White)",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(30), reply: "d8g5", after: cp(-120),
    expected: { kind: "player_blunder", played: "Ng5", cpLoss: 150, best: "Bb5" },
  },
  {
    name: "player_blunder does not fire one below blunderCp",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(30), reply: "d8g5", after: cp(-119),
    expected: null,
  },
  {
    name: "player_blunder from Black's point of view",
    playerColor: "b", fen: AFTER_E4, move: "g7g5", best: "e7e5", before: cp(30), reply: "d2d4", after: cp(180),
    expected: { kind: "player_blunder", played: "g5", cpLoss: 150, best: "e5" },
  },
  {
    name: "Black one below blunderCp is silent",
    playerColor: "b", fen: AFTER_E4, move: "g7g5", best: "e7e5", before: cp(30), reply: "d2d4", after: cp(179),
    expected: null,
  },
  {
    name: "player walks into a forced mate",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(30), reply: "d8g5", after: mate(-2),
    expected: { kind: "player_blunder", played: "Ng5", cpLoss: 30 + 99800, best: "Bb5" },
  },

  // --- missed_win and its precedence over player_blunder
  {
    name: "missed_win fires exactly at missedWinCp",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(400), reply: "d8g5", after: cp(250),
    expected: { kind: "missed_win", played: "Ng5", best: "Bb5", gainCp: 150 },
  },
  {
    name: "missed_win does not fire one below missedWinCp",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(400), reply: "d8g5", after: cp(251),
    expected: null,
  },
  {
    name: "missed_win needs bestEval >= missedWinCp: one below falls back to player_blunder",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(149), reply: "d8g5", after: cp(-1),
    expected: { kind: "player_blunder", played: "Ng5", cpLoss: 150, best: "Bb5" },
  },
  {
    name: "missed_win with playedEval exactly 0",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(400), reply: "d8g5", after: cp(0),
    expected: { kind: "missed_win", played: "Ng5", best: "Bb5", gainCp: 400 },
  },
  {
    name: "throwing a win into a losing position is a player_blunder, not missed_win",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(400), reply: "d8g5", after: cp(-1),
    expected: { kind: "player_blunder", played: "Ng5", cpLoss: 401, best: "Bb5" },
  },
  {
    name: "missed_win for Black (mate in 1 missed)",
    playerColor: "b", fen: FOOLS, move: "b8c6", best: "d8h4", before: mate(-1), reply: "d2d3", after: cp(-500),
    expected: { kind: "missed_win", played: "Nc6", best: "Qh4#", gainCp: 99900 - 500 },
  },
  {
    name: "underpromotion instead of queening is a missed_win, promotions in SAN",
    playerColor: "w", fen: PROMO, move: "e7e8n", best: "e7e8q", before: cp(900), reply: "g7f7", after: cp(0),
    expected: { kind: "missed_win", played: "e8=N+", best: "e8=Q", gainCp: 900 },
  },

  // --- mate scores
  {
    name: "mate in 3 to mate in 2 is no loss",
    playerColor: "w", fen: AFTER_NC6, move: "f1b5", best: "f1b5", before: mate(3), reply: "a7a6", after: mate(2),
    expected: null,
  },
  {
    name: "a slower mate (2 -> 4) for the same side is a decided game: silent (decision B)",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: mate(2), reply: "g8f6", after: mate(4),
    expected: null,
  },
  {
    name: "player being mated faster (mate against, 3 -> 1) is silent (decision B)",
    playerColor: "b", fen: AFTER_NC6.replace(" w ", " b "), move: "a7a6", best: "g8f6", before: mate(3), reply: "f1b5", after: mate(1),
    expected: null,
  },
  {
    name: "opponent being mated faster (5 -> 2) is no punish_opponent (decision B)",
    playerColor: "w", fen: AFTER_NF3, move: "a7a6", best: "b8c6", before: mate(5), reply: "f3e5", after: mate(2),
    expected: null,
  },
  {
    name: "opponent_left_book still applies in a decided mate (decision B)",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", history: ["e2e4", "e7e5", "g1f3"], best: "b8c6",
    before: mate(5), reply: "f3e5", after: mate(2), repertoire,
    expected: { kind: "opponent_left_book", line: "Italian", expected: ["Nc6"], played: "f6" },
  },
  {
    name: "own mate turning into mate for the other side still fires",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: mate(2), reply: "d8g5", after: mate(-3),
    expected: { kind: "player_blunder", played: "Ng5", cpLoss: 99800 + 99700, best: "Bb5" },
  },

  // --- decision A: playedEval comes from before.lines when the move is a multi-PV line
  {
    name: "probe A1: the engine-best move is never a missed_win, despite after drifting",
    playerColor: "w", fen: AFTER_NC6, move: "f1b5", best: "f1b5", before: cp(300), reply: "a7a6", after: cp(100),
    expected: null,
  },
  {
    name: "probe A2: the engine-best move is never a player_blunder, despite after drifting",
    playerColor: "w", fen: AFTER_NC6, move: "f1b5", best: "f1b5", before: cp(30), reply: "a7a6", after: cp(-150),
    expected: null,
  },
  {
    name: "the opponent's engine-best move is never punish_opponent",
    playerColor: "w", fen: AFTER_NF3, move: "b8c6", best: "b8c6", before: cp(40), reply: "f1b5", after: cp(400),
    expected: null,
  },
  {
    name: "a rank-2 move is scored from its multi-PV line, not from after",
    playerColor: "w", fen: AFTER_NC6, move: "b1c3", best: "f1b5", before: cp(30), reply: "g8f6", after: cp(-300),
    otherLines: [{ move: "f1c4", score: cp(25) }, { move: "b1c3", score: cp(20) }],
    expected: null,
  },
  {
    name: "a multi-PV line can itself be a blunder",
    playerColor: "w", fen: AFTER_NC6, move: "b1c3", best: "f1b5", before: cp(30), reply: "g8f6", after: cp(0),
    otherLines: [{ move: "b1c3", score: cp(-120) }],
    expected: { kind: "player_blunder", played: "Nc3", cpLoss: 150, best: "Bb5" },
  },
  {
    name: "repertoire probe: the line named is the first one that still continues",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", history: ["e2e4", "e7e5", "g1f3"], best: "b8c6",
    before: cp(40), reply: "f3e5", after: cp(100),
    repertoire: buildRepertoire([
      { name: "Short", color: "w", pgn: "1. e4 e5 2. Nf3" },
      { name: "Italian", color: "w", pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4" },
    ]),
    expected: { kind: "opponent_left_book", line: "Italian", expected: ["Nc6"], played: "f6" },
  },
  {
    name: "delivering checkmate (after has no lines) is silent",
    playerColor: "b", fen: FOOLS, move: "d8h4", best: "d8h4", before: mate(-1), after: "terminal",
    expected: null,
  },
  {
    name: "opponent delivering checkmate is silent",
    playerColor: "w", fen: FOOLS, move: "d8h4", best: "d8h4", before: mate(-1), after: "terminal",
    expected: null,
  },
  {
    name: "stalemating instead of mating is a missed_win (stalemate = 0)",
    playerColor: "w", fen: KQK, move: "c1c7", best: "c1c8", before: mate(1), after: "terminal",
    expected: { kind: "missed_win", played: "Qc7", best: "Qc8#", gainCp: 99900 },
  },

  // --- punish_opponent
  {
    name: "punish_opponent fires exactly at punishCp",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", best: "b8c6", before: cp(40), reply: "f3e5", after: cp(190),
    expected: { kind: "punish_opponent", opponentMove: "f6", refutation: "Nxe5", gainCp: 150 },
  },
  {
    name: "punish_opponent does not fire one below punishCp",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", best: "b8c6", before: cp(40), reply: "f3e5", after: cp(189),
    expected: null,
  },
  {
    name: "punish_opponent when the player is Black",
    playerColor: "b", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(30), reply: "d8g5", after: cp(-300),
    expected: { kind: "punish_opponent", opponentMove: "Ng5", refutation: "Qxg5", gainCp: 330 },
  },
  {
    name: "punish_opponent with a mate refutation",
    playerColor: "b", fen: play(play(START, "f2f3"), "e7e5"), move: "g2g4", best: "e2e4", before: cp(-20), reply: "d8h4", after: mate(-1),
    expected: { kind: "punish_opponent", opponentMove: "g4", refutation: "Qh4#", gainCp: 99900 - 20 },
  },

  // --- opponent_left_book and precedence
  {
    name: "punish_opponent takes precedence over opponent_left_book",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", history: ["e2e4", "e7e5", "g1f3"], best: "b8c6",
    before: cp(40), reply: "f3e5", after: cp(190), repertoire,
    expected: { kind: "punish_opponent", opponentMove: "f6", refutation: "Nxe5", gainCp: 150 },
  },
  {
    name: "opponent_left_book when the deviation is not punishable (one below punishCp)",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", history: ["e2e4", "e7e5", "g1f3"], best: "b8c6",
    before: cp(40), reply: "f3e5", after: cp(189), repertoire,
    expected: { kind: "opponent_left_book", line: "Italian", expected: ["Nc6"], played: "f6" },
  },
  {
    name: "opponent_left_book for a Black repertoire",
    playerColor: "b", fen: AFTER_D4_NF6, move: "g1f3", history: ["d2d4", "g8f6"], best: "c2c4",
    before: cp(30), reply: "g7g6", after: cp(25), repertoire,
    expected: { kind: "opponent_left_book", line: "KID vs c4", expected: ["c4", "Bf4"], played: "Nf3" },
  },
  {
    name: "opponent following the book is silent",
    playerColor: "b", fen: AFTER_D4_NF6, move: "c2c4", history: ["d2d4", "g8f6"], best: "c2c4",
    before: cp(30), reply: "g7g6", after: cp(30), repertoire,
    expected: null,
  },
  {
    name: "history already out of book: no opponent_left_book",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", history: ["e2e4", "e7e5", "g1f3"], best: "b8c6",
    before: cp(40), reply: "f3e5", after: cp(100),
    repertoire: buildRepertoire([{ name: "London", color: "w", pgn: "1. d4 d5 2. Bf4" }]),
    expected: null,
  },
  {
    name: "end of a line is not a deviation",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", history: ["e2e4", "e7e5", "g1f3"], best: "b8c6",
    before: cp(40), reply: "f3e5", after: cp(100),
    repertoire: buildRepertoire([{ name: "Short", color: "w", pgn: "1. e4 e5 2. Nf3" }]),
    expected: null,
  },
  {
    name: "only lines of the player's color count (Black's KID lines ignored when playing White)",
    playerColor: "w", fen: play(START, "d2d4"), move: "d7d5", history: ["d2d4"], best: "g8f6",
    before: cp(30), reply: "c2c4", after: cp(35), repertoire,
    expected: null,
  },
  {
    name: "no repertoire: an opponent deviation is silent",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", history: ["e2e4", "e7e5", "g1f3"], best: "b8c6",
    before: cp(40), reply: "f3e5", after: cp(100), repertoire: null,
    expected: null,
  },
  {
    name: "the player leaving their own book is not a key moment",
    playerColor: "w", fen: AFTER_NC6, move: "f1e2", history: ["e2e4", "e7e5", "g1f3", "b8c6"], best: "f1b5",
    before: cp(40), reply: "g8f6", after: cp(20), repertoire,
    expected: null,
  },

  // --- stillWinningCp (#16): the player's own drops are quiet while still clearly winning after the move
  {
    name: "still-winning probe 1 (#3): +1200 -> +1040 is silent",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: cp(1200), reply: "g8f6", after: cp(1040),
    expected: null,
  },
  {
    name: "still-winning probe 2: crossing the line (+900 -> +400) still fires",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: cp(900), reply: "g8f6", after: cp(400),
    expected: { kind: "missed_win", played: "Bc4", best: "Bb5", gainCp: 500 },
  },
  {
    name: "still-winning probe 3a: after exactly stillWinningCp fires",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: cp(650), reply: "g8f6", after: cp(500),
    expected: { kind: "missed_win", played: "Bc4", best: "Bb5", gainCp: 150 },
  },
  {
    name: "still-winning probe 3b: after one above stillWinningCp is silent",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: cp(651), reply: "g8f6", after: cp(501),
    expected: null,
  },
  {
    name: "still-winning probe 4a: a missed forced mate speaks even above stillWinningCp",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: mate(2), reply: "g8f6", after: cp(800),
    expected: { kind: "missed_win", played: "Bc4", best: "Bb5", gainCp: 99800 - 800 },
  },
  {
    name: "still-winning probe 4b: mate in 2 -> mate in 4 stays silent (decided mate)",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: mate(2), reply: "g8f6", after: mate(4),
    expected: null,
  },
  {
    name: "still-winning probe 5: Black at -1200 -> -1040 (White view) is silent",
    playerColor: "b", fen: AFTER_E4, move: "g7g5", best: "e7e5", before: cp(-1200), reply: "d2d4", after: cp(-1040),
    expected: null,
  },
  {
    name: "still-winning probe 5b: Black crossing the line (-900 -> -400) still fires",
    playerColor: "b", fen: AFTER_E4, move: "g7g5", best: "e7e5", before: cp(-900), reply: "d2d4", after: cp(-400),
    expected: { kind: "missed_win", played: "g5", best: "e5", gainCp: 500 },
  },
  {
    name: "still-winning probe 6: the losing side is unchanged (-800 -> -1000 is player_blunder)",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(-800), reply: "d8g5", after: cp(-1000),
    expected: { kind: "player_blunder", played: "Ng5", cpLoss: 200, best: "Bb5" },
  },
  {
    name: "still-winning probe 7: an opponent blunder with the player at +700 is still punish_opponent",
    playerColor: "w", fen: AFTER_NF3, move: "f7f6", best: "b8c6", before: cp(700), reply: "f3e5", after: cp(850),
    expected: { kind: "punish_opponent", opponentMove: "f6", refutation: "Nxe5", gainCp: 150 },
  },
  {
    name: "stillWinningCp is a parameter: a higher threshold makes +1040 speak",
    playerColor: "w", fen: AFTER_NC6, move: "f1c4", best: "f1b5", before: cp(1200), reply: "g8f6", after: cp(1040),
    thresholds: { ...T, stillWinningCp: 2000 },
    expected: { kind: "missed_win", played: "Bc4", best: "Bb5", gainCp: 160 },
  },

  // --- thresholds are parameters
  {
    name: "custom thresholds change the boundary",
    playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5", before: cp(30), reply: "d8g5", after: cp(-20),
    thresholds: { blunderCp: 50, missedWinCp: 1000, punishCp: 1000, stillWinningCp: 1000 },
    expected: { kind: "player_blunder", played: "Ng5", cpLoss: 50, best: "Bb5" },
  },
];

describe("detect", () => {
  it.each(cases)("$name", (c) => {
    expect(detect(input(c))).toEqual(c.expected);
  });

  it("reads its default thresholds from config/tutor.json", () => {
    expect(T).toEqual({
      blunderCp: expect.any(Number),
      missedWinCp: expect.any(Number),
      punishCp: expect.any(Number),
      stillWinningCp: expect.any(Number),
    });
    const loss = T.blunderCp;
    const result = detect(
      input({
        name: "", playerColor: "w", fen: AFTER_NC6, move: "f3g5", best: "f1b5",
        before: cp(0), reply: "d8g5", after: cp(-loss), expected: null,
      }),
    );
    expect(result).toMatchObject({ kind: "player_blunder", cpLoss: loss });
  });

  it("returns null when before has no lines", () => {
    const i = input(cases[0]!);
    expect(detect({ ...i, before: terminal(START) })).toBeNull();
  });

  it("throws on an illegal move", () => {
    const i = input(cases[0]!);
    expect(() => detect({ ...i, move: "e2e5" })).toThrow(/illegal/i);
    expect(() => detect({ ...i, move: "zz" })).toThrow();
  });

  it("throws on a promotion suffix for a move that is not a promotion", () => {
    const i = input(cases[0]!);
    expect(() => detect({ ...i, move: "e2e4q" })).toThrow(/illegal/i);
  });

  it("puts SAN, never UCI, in every string field", () => {
    const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
    for (const c of cases) {
      const km = detect(input(c));
      if (!km) continue;
      const strings = Object.entries(km)
        .filter(([k]) => k !== "kind" && k !== "line")
        .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
        .filter((v): v is string => typeof v === "string");
      for (const s of strings) expect(s, `${c.name}: ${s}`).not.toMatch(uci);
    }
  });

  it("src/ hard-codes no threshold value", () => {
    const srcDir = join(import.meta.dirname, "..", "src");
    for (const f of readdirSync(srcDir)) {
      const text = readFileSync(join(srcDir, f), "utf8");
      expect(text, f).not.toMatch(/\b150\b/);
    }
  });
});

describe("scoreToCp", () => {
  it.each([
    [cp(35), "w", 35],
    [cp(35), "b", -35],
    [mate(1), "w", 99900],
    [mate(1), "b", -99900],
    [mate(-3), "w", -99700],
    [mate(-3), "b", 99700],
  ] as const)("%o for %s is %d", (score, pov, expected) => {
    expect(scoreToCp(score, pov)).toBe(expected);
  });

  it("mate 0 is signed by the side to move, and 0 without it", () => {
    expect(scoreToCp(mate(0), "w", "w")).toBe(-100000);
    expect(scoreToCp(mate(0), "b", "w")).toBe(100000);
    expect(scoreToCp(mate(0), "w", "b")).toBe(100000);
    expect(scoreToCp(mate(0), "b", "b")).toBe(-100000);
    expect(Object.is(scoreToCp(mate(0), "w"), 0)).toBe(true);
    expect(Object.is(scoreToCp(mate(0), "b"), 0)).toBe(true);
  });

  it("never returns -0", () => {
    expect(Object.is(scoreToCp(cp(0), "b"), 0)).toBe(true);
    expect(Object.is(scoreToCp(cp(0), "w"), 0)).toBe(true);
  });
});
