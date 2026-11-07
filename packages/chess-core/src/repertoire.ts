import { Chess } from "chess.js";
import { toUci } from "./moves.ts";
import type { Color, Continuations, Repertoire, RepertoireLineInput } from "./types.ts";

interface ParsedLine {
  name: string;
  color: Color;
  moves: { uci: string; san: string }[];
}

function parseLine(input: RepertoireLineInput): ParsedLine {
  const chess = new Chess();
  try {
    chess.loadPgn(input.pgn);
  } catch (err) {
    throw new Error(`repertoire line "${input.name}": cannot parse PGN (${(err as Error).message})`);
  }
  const history = chess.history({ verbose: true });
  if (history.length === 0) {
    throw new Error(`repertoire line "${input.name}": PGN is empty`);
  }
  return {
    name: input.name,
    color: input.color,
    moves: history.map((m) => ({ uci: toUci(m), san: m.san })),
  };
}

/** Builds a Repertoire from mainline PGN strings. Throws on unparseable or empty lines. */
export function buildRepertoire(lines: RepertoireLineInput[]): Repertoire {
  const parsed = lines.map(parseLine);

  return {
    continuations(history: string[], color: Color): Continuations | null {
      let name: string | null = null;
      const moves: { uci: string; san: string }[] = [];
      for (const line of parsed) {
        if (line.color !== color || history.length > line.moves.length) continue;
        if (!history.every((uci, i) => line.moves[i]?.uci === uci)) continue;
        name ??= line.name;
        const next = line.moves[history.length];
        if (next && !moves.some((m) => m.uci === next.uci)) moves.push(next);
      }
      return name === null ? null : { line: name, moves };
    },
  };
}
