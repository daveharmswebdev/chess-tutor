import type Anthropic from "@anthropic-ai/sdk";
import type { Color, KeyMoment } from "@chess-tutor/chess-core";
import { colorName, historyPositions, parseMove, sideToMove, type MovePair } from "./chess-util.ts";
import type { TutorGame, TutorRequest } from "./contract.ts";
import { Evidence } from "./evidence.ts";

/**
 * The per-game second system block (cached, IR-6): the player profile and the repertoire for the
 * player's colour. It is fixed for the whole game, so it never breaks the cache mid-game. The
 * game's exact repertoire line is not known when the session starts; get_repertoire_context
 * gives it per position.
 */
export function playerBlock(game: TutorGame, hasRepertoire: boolean): string {
  const side = game.playerColor === "w" ? "White" : "Black";
  const opening = game.playerColor === "w" ? "the London System" : "the King's Indian Defence";
  const repertoire = hasRepertoire
    ? `Their repertoire with ${side} is ${opening}; get_repertoire_context tells you the exact line for a position.`
    : "No repertoire is loaded for this game.";
  return `<player>\nProfile: ${game.playerProfile}\nIn this game the player has ${side}. ${repertoire}\n</player>`;
}

/** Positions a key-moment move may have been played in: before the last move, the attempt position, the current one. */
function momentFens(request: TutorRequest): string[] {
  const { fens } = historyPositions(request.history);
  const before = fens.length >= 2 ? fens[fens.length - 2]! : null;
  const list = [before, request.kind === "key_moment" ? request.attemptFen : null, request.fen];
  return list.filter((f): f is string => f !== null);
}

function pair(san: string, fens: string[]): MovePair | { san: string; uci: null } {
  for (const fen of fens) {
    const m = parseMove(fen, san);
    if (m) return m;
  }
  return { san, uci: null };
}

function momentData(moment: KeyMoment, fens: string[]) {
  const p = (san: string) => pair(san, fens);
  switch (moment.kind) {
    case "opponent_left_book":
      return { line: moment.line, expected: moment.expected.map(p), played: p(moment.played) };
    case "player_blunder":
      return { played: p(moment.played), cp_loss: moment.cpLoss, best: p(moment.best) };
    case "missed_win":
      return { played: p(moment.played), best: p(moment.best), gain_cp: moment.gainCp };
    case "punish_opponent":
      return { opponent_move: p(moment.opponentMove), refutation: p(moment.refutation), gain_cp: moment.gainCp };
  }
}

/**
 * Key-moment moves with the position each was played from: played / best / expected /
 * opponentMove at fenBefore (the position before the triggering move), refutation at fen.
 */
function momentMoves(moment: KeyMoment): { san: string; at: "before" | "after" }[] {
  switch (moment.kind) {
    case "opponent_left_book":
      return [...moment.expected, moment.played].map((san) => ({ san, at: "before" as const }));
    case "player_blunder":
    case "missed_win":
      return [
        { san: moment.played, at: "before" },
        { san: moment.best, at: "before" },
      ];
    case "punish_opponent":
      return [
        { san: moment.opponentMove, at: "before" },
        { san: moment.refutation, at: "after" },
      ];
  }
}

function momentScores(moment: KeyMoment): number[] {
  switch (moment.kind) {
    case "player_blunder":
      return [moment.cpLoss];
    case "missed_win":
    case "punish_opponent":
      return [moment.gainCp];
    case "opponent_left_book":
      return [];
  }
}

/** The new user turn: the request data as JSON inside <key_moment> or <hint_request> tags (moves in SAN and UCI). */
export function requestTurn(request: TutorRequest, playerColor: Color): Anthropic.MessageParam {
  const history = historyPositions(request.history).moves;
  const common = { fen: request.fen, side_to_move: colorName(sideToMove(request.fen)), player_color: colorName(playerColor) };
  let tag: string;
  let data: Record<string, unknown>;
  if (request.kind === "key_moment") {
    tag = "key_moment";
    data = {
      kind: request.moment.kind,
      ...common,
      attempt_fen: request.attemptFen,
      moment: momentData(request.moment, momentFens(request)),
      history,
    };
  } else {
    tag = "hint_request";
    data = { ...common, history };
  }
  return { role: "user", content: [{ type: "text", text: `<${tag}>\n${JSON.stringify(data)}\n</${tag}>` }] };
}

/**
 * What the model has been shown before any tool runs (FR-10): the request positions (focus),
 * every position and move of the game so far (history: each move keyed by the position it was
 * played in), and the key-moment moves and scores (backed where they were played).
 */
export function buildEvidence(request: TutorRequest): Evidence {
  const evidence = new Evidence();
  const { fens, moves } = historyPositions(request.history);
  for (const fen of fens) evidence.addPosition(fen);
  moves.forEach((m, i) => evidence.addHistoryMove(fens[i]!, m.uci));
  evidence.addFocus(request.fen);
  if (request.kind === "key_moment") {
    evidence.addFocus(request.attemptFen);
    const fenBefore = fens.length >= 2 ? fens[fens.length - 2]! : request.attemptFen;
    for (const { san, at } of momentMoves(request.moment)) {
      const candidates = at === "before" ? [fenBefore, request.attemptFen] : [request.fen];
      for (const fen of candidates) {
        const move = parseMove(fen, san);
        if (move) {
          evidence.addMove(fen, move.uci);
          break;
        }
      }
    }
    for (const cp of momentScores(request.moment)) evidence.addDelta(cp); // cpLoss / gainCp are changes, not standings (#26)
  }
  return evidence;
}
