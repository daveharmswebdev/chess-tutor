import type { Color, RepertoireLineInput } from "./types.ts";

/**
 * Parses a multi-game PGN file of repertoire lines (FR-6, BR-1) into inputs for
 * buildRepertoire. Pure: takes the file text, does no I/O.
 *
 * Each game is one line. Its name is the [Line "..."] header, else [Event "..."].
 * Headers, comments ({...} and ;...), NAGs ($n) and result tokens are stripped; the
 * remaining movetext is returned as-is for chess.js to validate. Throws on text with no
 * games, a game with no name or no moves, a variation "(...)", or a duplicate name.
 */
export function parseRepertoirePgn(text: string, color: Color): RepertoireLineInput[] {
  interface Game {
    headers: Map<string, string>;
    tokens: string[];
    ended: boolean; // a result token was seen
  }
  const games: Game[] = [];
  let game: Game | null = null;
  const newGame = (): Game => {
    const g: Game = { headers: new Map(), tokens: [], ended: false };
    games.push(g);
    return g;
  };
  const label = (g: Game) => {
    const name = nameOf(g.headers);
    return name === null ? `game ${games.indexOf(g) + 1}` : `"${name}"`;
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "[") {
      // A header after movetext (or a result) begins the next game.
      if (game === null || game.tokens.length > 0 || game.ended) game = newGame();
      const end = readHeader(text, i, game.headers);
      i = end;
    } else if (ch === "{") {
      const close = text.indexOf("}", i + 1);
      if (close === -1) throw new Error(`repertoire PGN: unclosed comment in ${(game ? label(game) : "game 1")}`);
      i = close + 1;
    } else if (ch === ";") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (ch === "%" && (i === 0 || text[i - 1] === "\n")) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (ch === "(" || ch === ")") {
      throw new Error(
        `repertoire line ${(game ? label(game) : "game 1")}: variations "( ... )" are not supported; ` +
          `write one mainline per game`,
      );
    } else {
      let j = i;
      while (j < n && !/[\s{}();[\]]/.test(text[j]!)) j++;
      const token = text.slice(i, j);
      i = j;
      if (game === null || game.ended) game = newGame();
      if (/^\$\d+$/.test(token)) continue; // NAG
      if (token === "1-0" || token === "0-1" || token === "1/2-1/2" || token === "*") {
        game.ended = true;
        continue;
      }
      game.tokens.push(token);
    }
  }

  if (games.length === 0) throw new Error("repertoire PGN: no games found");

  const seen = new Set<string>();
  return games.map((g) => {
    const name = nameOf(g.headers);
    if (name === null) {
      throw new Error(`repertoire PGN: ${label(g)} has no [Line] or [Event] header to name it`);
    }
    if (g.tokens.length === 0) throw new Error(`repertoire line "${name}": no moves`);
    if (seen.has(name)) throw new Error(`repertoire PGN: duplicate line name "${name}"`);
    seen.add(name);
    return { name, color, pgn: g.tokens.join(" ") };
  });
}

function nameOf(headers: Map<string, string>): string | null {
  for (const tag of ["Line", "Event"]) {
    const v = headers.get(tag)?.trim();
    if (v) return v;
  }
  return null;
}

/** Reads `[Tag "value"]` starting at `start` (the "["). Returns the index after "]". */
function readHeader(text: string, start: number, headers: Map<string, string>): number {
  const m = /^\[\s*([A-Za-z0-9_]+)\s*"/.exec(text.slice(start, start + 256));
  if (!m) throw new Error(`repertoire PGN: malformed header at offset ${start}`);
  let i = start + m[0].length;
  let value = "";
  while (i < text.length && text[i] !== '"') {
    if (text[i] === "\\" && i + 1 < text.length) i++;
    value += text[i];
    i++;
  }
  const close = text.indexOf("]", i);
  if (i >= text.length || close === -1) {
    throw new Error(`repertoire PGN: unterminated header [${m[1]}] at offset ${start}`);
  }
  headers.set(m[1]!, value);
  return close + 1;
}
