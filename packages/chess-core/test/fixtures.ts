import { Chess } from "chess.js";
import type { Analysis, Score } from "../src/index.ts";

export const cp = (value: number): Score => ({ kind: "cp", value });
export const mate = (value: number): Score => ({ kind: "mate", value });

/** A hand-built single-line analysis, the way the engine would report it. */
export function analysis(fen: string, bestMove: string, score: Score): Analysis {
  return {
    fen,
    depth: 18,
    lines: [{ rank: 1, moves: [bestMove], score, depth: 18 }],
    bestMove,
    timeMs: 0,
  };
}

/** Analysis of a finished game (checkmate or stalemate): no lines. */
export function terminal(fen: string): Analysis {
  return { fen, depth: 0, lines: [], bestMove: "(none)", timeMs: 0 };
}

/** FEN after playing a UCI move, for realistic fixtures. */
export function play(fen: string, uci: string): string {
  const chess = new Chess(fen);
  chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci.slice(4) } : {}),
  });
  return chess.fen();
}

export const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** 1. e4 (Black to move) */
export const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
/** 1. e4 e5 2. Nf3 (Black to move) */
export const AFTER_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";
/** 1. e4 e5 2. Nf3 Nc6 (White to move) */
export const AFTER_NC6 = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
/** 1. f3 e5 2. g4 (Black to move, Qh4# available) */
export const FOOLS = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
/** K+Q vs K, White to move: Qc8# mates, Qc7 stalemates. */
export const KQK = "k7/8/1K6/8/8/8/8/2Q5 w - - 0 1";
/** 1. d4 Nf6 (White to move) */
export const AFTER_D4_NF6 = "rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 1 2";
/** White pawn on e7 about to promote, White to move. */
export const PROMO = "8/4P1k1/8/8/8/8/8/4K3 w - - 0 1";
