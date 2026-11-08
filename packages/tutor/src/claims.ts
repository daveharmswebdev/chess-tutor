import { boardOf, isUci, normalizeSan, playSan, playUci } from "./chess-util.ts";
import type { TutorReply } from "./contract.ts";
import type { Evidence } from "./evidence.ts";

/**
 * The FR-10 check: the tutor may only name moves that a tool result, the key-moment data or the
 * game's history gave it.
 *
 * What counts as a move token: piece moves (Nf3, Bxe5, Nbd7, R1e2, Qh4xe1), pawn captures (exd5),
 * promotions (e8=Q, b1N, dxc8=Q+) and castling (O-O, O-O-O, 0-0, 0-0-0), with an optional + or #.
 * A bare square ("e4", "the a4 square") is NOT a token, so plain pawn pushes are not checked:
 * in prose they cannot be told apart from squares, and checking them would flag every mention of
 * a square. The answer itself is still checked through revealMove. A token must stand alone: a
 * letter, digit or hyphen directly before or after it means it is part of a longer word (UCI
 * like g1f3, "O-Oh", "10-0").
 */
const MOVE_TOKEN =
  /(?<![A-Za-z0-9-])(?:O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][18]=?[QRBN])[+#]?(?![A-Za-z0-9-])/g;

export function extractMoveTokens(text: string): string[] {
  return text.match(MOVE_TOKEN) ?? [];
}

/** SANs (canonical, from chess.js) that `token` stands for in any of `positions`. */
function resolve(token: string, positions: string[]): string[] {
  const sans = new Set<string>();
  for (const fen of positions) {
    const chess = boardOf(fen);
    const move = chess && playSan(chess, token);
    if (move) sans.add(move.san);
  }
  return [...sans];
}

/**
 * Returns the problems with a schema-valid reply; empty means it passes FR-10 (and the FR-8 rule
 * that message must not give the answer away). `revealFen` is where revealMove must be legal:
 * attemptFen for a key moment, fen for a hint.
 */
export function checkClaims(reply: TutorReply, evidence: Evidence, revealFen: string): string[] {
  const problems: string[] = [];
  const positions = evidence.positionList();
  const seen = new Set<string>();

  for (const [field, text] of [
    ["message", reply.message],
    ["reveal", reply.reveal ?? ""],
  ] as const) {
    for (const token of extractMoveTokens(text)) {
      const key = `${field}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sans = resolve(token, positions);
      if (sans.length === 0) {
        problems.push(`${field} mentions ${token}, which is not legal in any position you were shown.`);
      } else if (!sans.some((san) => evidence.backs(san))) {
        problems.push(`${field} mentions ${token}, which does not appear in this turn's tool results or the key-moment data.`);
      }
    }
  }

  if (reply.revealMove !== null) {
    const uci = reply.revealMove;
    const chess = boardOf(revealFen);
    const move = isUci(uci) && chess ? playUci(chess, uci) : null;
    if (!isUci(uci)) {
      problems.push(`revealMove "${uci}" is not a legal UCI move (use from-square + to-square, e.g. "g1f3").`);
    } else if (!move) {
      problems.push(`revealMove "${uci}" is not a legal move in the position where the player moves.`);
    } else {
      if (!evidence.backs(move.san)) {
        problems.push(`revealMove "${uci}" (${move.san}) is not backed by this turn's tool results or the key-moment data.`);
      }
      const answer = normalizeSan(move.san);
      const givenAway = extractMoveTokens(reply.message).some((t) => {
        const board = boardOf(revealFen);
        const m = board && playSan(board, t);
        return m !== null && normalizeSan(m.san) === answer;
      });
      if (givenAway) problems.push(`message names ${move.san}, which gives the answer away: keep it for reveal.`);
    }
  }

  return problems;
}
