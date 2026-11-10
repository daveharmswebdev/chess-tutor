import type Anthropic from "@anthropic-ai/sdk";
import { MATE_CP, scoreToCp, type Analysis, type Color, type Repertoire, type Score } from "@chess-tutor/chess-core";
import { z } from "zod";
import {
  boardOf,
  colorName,
  historyPositions,
  parseMove,
  playUci,
  samePosition,
  sideToMove,
  uciOf,
  type MovePair,
} from "./chess-util.ts";
import type { TutorConfig, TutorEngine, TutorExplorer } from "./contract.ts";
import type { Evidence } from "./evidence.ts";

/**
 * The tutor's four tools (FR-16 to FR-19). Definitions are fixed in name, order and schema:
 * they sit at the front of every request, so any change invalidates the prompt cache (IR-6)
 * and the strict-tool grammar cache (spike 003). Results are compact JSON with moves in SAN
 * and UCI. Every move a tool reports is also recorded in the request's Evidence (FR-10).
 */

const fenProp = { type: "string", description: "Position in FEN." } as const;

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "analyze_position",
    description:
      "Stockfish analysis of a position: the evaluation and the best lines, moves in SAN and UCI. " +
      "eval_cp and mate_in are from White's point of view. Use it to find the best move or plan before you explain one.",
    input_schema: {
      type: "object",
      properties: {
        fen: fenProp,
        depth: { type: "integer", description: "Search depth; capped by the server. Leave out for the default." },
        multi_pv: { type: "integer", description: "Number of lines (1-3); capped by the server." },
      },
      required: ["fen"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "evaluate_move",
    description:
      "How good one move is in a position: centipawn loss against the engine's best move (for the side that moves), " +
      "the best move, and the engine's reply. The move may be SAN (Nf3) or UCI (g1f3). Use it before you judge a move.",
    input_schema: {
      type: "object",
      properties: { fen: fenProp, move: { type: "string", description: "The move, SAN or UCI." } },
      required: ["fen", "move"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "opening_explorer",
    description:
      "What human players at the player's level usually play in this position (Lichess games): moves with how often " +
      "they are played and their results. Use it for opening questions and to name the usual plan or deviation.",
    input_schema: { type: "object", properties: { fen: fenProp }, required: ["fen"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_repertoire_context",
    description:
      "Whether a position from this game is still in the player's repertoire (London System with White, King's Indian " +
      "with Black), the line's name and the repertoire's next moves, or where the game left it.",
    input_schema: { type: "object", properties: { fen: fenProp }, required: ["fen"], additionalProperties: false },
    strict: true,
  },
];

export interface ToolContext {
  engine: TutorEngine;
  explorer: TutorExplorer;
  repertoire: Repertoire | null;
  config: TutorConfig;
  playerColor: Color;
  /** UCI history of the current request, from the start position (for the repertoire). */
  history: string[];
  evidence: Evidence;
  /** The ask's AbortSignal: a tool checks it between engine searches. */
  signal?: AbortSignal;
}

function throwIfAborted(ctx: ToolContext): void {
  if (ctx.signal?.aborted) throw new Error("aborted");
}

const FenInput = z.object({ fen: z.string() });
const AnalyzeInput = FenInput.extend({ depth: z.number().int().nullish(), multi_pv: z.number().int().nullish() });
const EvaluateInput = FenInput.extend({ move: z.string() });

/** Shown in the browser while the tool runs (NFR-1). */
export function toolLabel(name: string, input: unknown): string {
  switch (name) {
    case "evaluate_move": {
      const i = input as { fen?: unknown; move?: unknown };
      const move = String(i?.move ?? "the move");
      const san = typeof i?.fen === "string" ? parseMove(i.fen, move)?.san : undefined;
      return `Checking ${san ?? move}…`;
    }
    case "analyze_position":
      return "Looking at the engine lines…";
    case "opening_explorer":
      return "Checking what players usually play…";
    case "get_repertoire_context":
      return "Checking your repertoire…";
    default:
      return "Thinking…";
  }
}

/** Runs one tool. Throws for bad input, an illegal move or a failing dependency; the loop turns that into is_error. */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
  switch (name) {
    case "analyze_position":
      return analyzePosition(parse(AnalyzeInput, input, name), ctx);
    case "evaluate_move":
      return evaluateMove(parse(EvaluateInput, input, name), ctx);
    case "opening_explorer":
      return openingExplorer(parse(FenInput, input, name), ctx);
    case "get_repertoire_context":
      return repertoireContext(parse(FenInput, input, name), ctx);
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown, name: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new Error(`bad input for ${name}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

function requireFen(fen: string): void {
  if (!boardOf(fen)) throw new Error(`invalid FEN: ${fen}`);
}

const MAX_LINE_PLIES = 8;

function engineOpts(config: TutorConfig, depth?: number | null, multiPv?: number | null) {
  const e = config.engine;
  return {
    depth: Math.max(1, Math.min(depth ?? e.depth, e.depth)),
    multiPv: Math.max(1, Math.min(multiPv ?? e.multiPv, e.multiPv)),
    movetimeMs: e.movetimeCapMs,
  };
}

/** A score for the model: centipawns or mate in N, from `pov`'s point of view. */
function describe(score: Score, pov: Color): { eval_cp: number | null; mate_in: number | null } {
  const sign = pov === "w" ? 1 : -1;
  if (score.kind === "mate") return { eval_cp: null, mate_in: sign * score.value || 0 };
  return { eval_cp: sign * score.value || 0, mate_in: null };
}

async function analyzePosition(input: z.infer<typeof AnalyzeInput>, ctx: ToolContext) {
  requireFen(input.fen);
  const analysis = await ctx.engine.analyze(input.fen, engineOpts(ctx.config, input.depth, input.multi_pv));
  return {
    fen: input.fen,
    side_to_move: colorName(sideToMove(input.fen)),
    depth: analysis.depth,
    lines: analysis.lines.map((line) => {
      ctx.evidence.addScore(line.score);
      return {
        rank: line.rank,
        ...describe(line.score, "w"),
        moves: ctx.evidence.addLine(input.fen, line.moves.slice(0, MAX_LINE_PLIES)),
      };
    }),
  };
}

/** Centipawns for `pov` after the analysed position; a finished game is scored from the board. */
function cpFor(analysis: Analysis, fen: string, pov: Color): number {
  const top = analysis.lines[0];
  if (top) return scoreToCp(top.score, pov, sideToMove(fen));
  const board = boardOf(fen);
  if (board?.isCheckmate()) return sideToMove(fen) === pov ? -MATE_CP : MATE_CP;
  return 0;
}

async function evaluateMove(input: z.infer<typeof EvaluateInput>, ctx: ToolContext) {
  requireFen(input.fen);
  const played = parseMove(input.fen, input.move);
  if (!played) throw new Error(`illegal move "${input.move}" in this position`);
  const mover = sideToMove(input.fen);
  const opts = engineOpts(ctx.config, null, 1);

  const before = await ctx.engine.analyze(input.fen, opts);
  throwIfAborted(ctx); // do not queue a second search for an aborted ask
  const bestUci = before.lines[0]?.moves[0] ?? before.bestMove;
  const best = ctx.evidence.addMove(input.fen, bestUci);
  ctx.evidence.addMove(input.fen, played.uci);

  const board = boardOf(input.fen)!;
  playUci(board, played.uci);
  const afterFen = board.fen();
  const after = await ctx.engine.analyze(afterFen, opts);
  const replyLine = ctx.evidence.addLine(afterFen, (after.lines[0]?.moves ?? []).slice(0, MAX_LINE_PLIES));

  const bestCp = before.lines[0] ? scoreToCp(before.lines[0].score, mover, mover) : 0;
  const playedCp = cpFor(after, afterFen, mover);
  const cpLoss = played.uci === best?.uci ? 0 : Math.min(9999, Math.max(0, bestCp - playedCp));
  if (before.lines[0]) ctx.evidence.addScore(before.lines[0].score);
  if (after.lines[0]) ctx.evidence.addScore(after.lines[0].score);
  // No line after the move (the game ended): played_eval shows playedCp from the mover's view,
  // so back that number, White-relative (review 047).
  else ctx.evidence.addScore({ kind: "cp", value: (mover === "w" ? playedCp : -playedCp) + 0 });
  ctx.evidence.addDelta(cpLoss); // a change, not a standing (#26)

  return {
    move: played,
    best,
    cp_loss: cpLoss,
    best_eval: before.lines[0] ? describe(before.lines[0].score, mover) : null,
    played_eval: after.lines[0] ? describe(after.lines[0].score, mover) : { eval_cp: playedCp, mate_in: null },
    eval_pov: colorName(mover),
    reply: replyLine[0] ?? null,
    reply_line: replyLine,
    game_over_after_move: board.isGameOver(),
  };
}

const EXPLORER_MOVES = 8;

const pct = (n: number, total: number) => (total > 0 ? Math.round((100 * n) / total) : 0);

async function openingExplorer(input: z.infer<typeof FenInput>, ctx: ToolContext) {
  requireFen(input.fen);
  const result = await ctx.explorer.lookup(input.fen, ctx.config.explorer);
  if (result.unavailable) return { available: false, reason: result.unavailable };
  const moves: (MovePair & Record<string, number | string>)[] = [];
  for (const m of result.moves) {
    if (moves.length >= EXPLORER_MOVES) break;
    // Third-party data: re-derive SAN from our own board, and drop anything illegal.
    const pair = ctx.evidence.addMove(input.fen, m.uci);
    if (!pair) continue;
    moves.push({
      ...pair,
      games: m.games,
      share_pct: pct(m.games, result.totalGames),
      white_pct: pct(m.white, m.games),
      draw_pct: pct(m.draws, m.games),
      black_pct: pct(m.black, m.games),
    });
  }
  return {
    total_games: result.totalGames,
    opening: result.opening ? `${result.opening.eco} ${result.opening.name}` : null,
    ratings: ctx.config.explorer.ratings,
    speeds: ctx.config.explorer.speeds,
    moves,
  };
}

/** The UCI history that leads to `fen` in this game (latest occurrence), or one move beyond its end. */
function historyFor(fen: string, history: string[]): string[] | null {
  const { fens } = historyPositions(history);
  for (let i = fens.length - 1; i >= 0; i--) if (samePosition(fens[i]!, fen)) return history.slice(0, i);
  const last = boardOf(fens[fens.length - 1]!)!;
  for (const move of last.moves({ verbose: true })) {
    last.move(move);
    const reached = last.fen();
    last.undo();
    if (samePosition(reached, fen)) return [...history.slice(0, fens.length - 1), uciOf(move)];
  }
  return null;
}

async function repertoireContext(input: z.infer<typeof FenInput>, ctx: ToolContext) {
  requireFen(input.fen);
  if (!ctx.repertoire) return { repertoire_loaded: false, note: "no repertoire loaded" };
  const color = colorName(ctx.playerColor);
  const hist = historyFor(input.fen, ctx.history);
  if (!hist) {
    return { in_game: false, note: "This position is not from this game; only game positions can be checked against the repertoire." };
  }
  const cont = ctx.repertoire.continuations(hist, ctx.playerColor);
  if (cont) {
    const next = cont.moves.map((m) => ctx.evidence.addMove(input.fen, m.uci)).filter((m): m is MovePair => m !== null);
    return { color, in_repertoire: true, line: cont.line, next_moves: next, end_of_line: cont.moves.length === 0 };
  }
  for (let k = hist.length - 1; k >= 0; k--) {
    const earlier = ctx.repertoire.continuations(hist.slice(0, k), ctx.playerColor);
    if (!earlier) continue;
    const { fens, moves } = historyPositions(hist.slice(0, k + 1));
    const left = moves[k] ?? null;
    if (left) ctx.evidence.addMove(fens[k]!, left.uci);
    return { color, in_repertoire: false, last_book_line: earlier.line, left_book_with: left, move_number: Math.floor(k / 2) + 1 };
  }
  return { color, in_repertoire: false, last_book_line: null, left_book_with: null };
}
