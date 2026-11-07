/** Pure parsing of UCI engine output. No I/O, so it is easy to unit-test. */

export interface UciInfo {
  depth?: number;
  multipv?: number;
  /** Score from the side to move's point of view (raw UCI). */
  score?: { kind: "cp" | "mate"; value: number };
  /** True when the score is only a lowerbound or upperbound (not a final value). */
  bound?: boolean;
  pv?: string[];
  nodes?: number;
  nps?: number;
  timeMs?: number;
}

const INT_FIELDS = {
  depth: "depth",
  multipv: "multipv",
  nodes: "nodes",
  nps: "nps",
  time: "timeMs",
} as const;

/** Parse an `info ...` line. Returns null for anything else, including `info string`. */
export function parseInfo(line: string): UciInfo | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== "info" || tokens[1] === "string") return null;

  const info: UciInfo = {};
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok in INT_FIELDS) {
      const value = Number(tokens[++i]);
      if (Number.isFinite(value)) info[INT_FIELDS[tok as keyof typeof INT_FIELDS]] = value;
    } else if (tok === "score") {
      const kind = tokens[++i];
      const value = Number(tokens[++i]);
      if ((kind === "cp" || kind === "mate") && Number.isFinite(value)) {
        info.score = { kind, value };
      }
      const next = tokens[i + 1];
      if (next === "lowerbound" || next === "upperbound") {
        info.bound = true;
        i++;
      }
    } else if (tok === "pv") {
      info.pv = tokens.slice(i + 1);
      break; // pv is always the last field
    }
  }
  return info;
}

/** Parse `bestmove e2e4 [ponder e7e5]`. Returns null for any other line. */
export function parseBestMove(line: string): { move: string; ponder?: string } | null {
  const m = /^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/.exec(line.trim());
  if (!m) return null;
  return m[2] ? { move: m[1]!, ponder: m[2] } : { move: m[1]! };
}

/** The side to move, read from a FEN string. */
export function sideToMove(fen: string): "w" | "b" {
  const field = fen.trim().split(/\s+/)[1];
  if (field !== "w" && field !== "b") throw new Error(`Invalid FEN (side to move): ${fen}`);
  return field;
}
