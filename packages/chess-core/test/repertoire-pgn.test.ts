import { describe, expect, it } from "vitest";
import { buildRepertoire } from "../src/index.ts";
import { parseRepertoirePgn } from "../src/repertoire-pgn.ts";

const TWO_GAMES = `[Event "Repertoire"]
[Site "?"]
[Date "????.??.??"]
[Round "-"]
[White "?"]
[Black "?"]
[Result "*"]
[Line "First"]

1. d4 d5 2. Bf4 *

[Event "Repertoire"]
[Result "*"]
[Line "Second"]

1. d4 Nf6 2. Bf4 g6 *
`;

describe("parseRepertoirePgn", () => {
  it("splits games, takes names from [Line], strips headers and the result token", () => {
    expect(parseRepertoirePgn(TWO_GAMES, "w")).toEqual([
      { name: "First", color: "w", pgn: "1. d4 d5 2. Bf4" },
      { name: "Second", color: "w", pgn: "1. d4 Nf6 2. Bf4 g6" },
    ]);
  });

  it("passes the color through", () => {
    expect(parseRepertoirePgn(TWO_GAMES, "b").map((l) => l.color)).toEqual(["b", "b"]);
  });

  it("falls back to [Event] when [Line] is missing", () => {
    expect(parseRepertoirePgn(`[Event "Only event"]\n\n1. d4 d5 *\n`, "w")).toEqual([
      { name: "Only event", color: "w", pgn: "1. d4 d5" },
    ]);
  });

  it("prefers [Line] over [Event] regardless of header order", () => {
    const text = `[Line "The line"]\n[Event "The event"]\n\n1. d4 d5 *\n`;
    expect(parseRepertoirePgn(text, "w")[0]?.name).toBe("The line");
  });

  it("strips brace comments (including multi-line), semicolon comments and NAGs", () => {
    const text = `[Line "Commented"]
[Result "*"]

1. d4 {the London starts} d5 $1 2. Bf4 {a comment
over two lines} Nf6 $14 ; rest of line comment
3. e3 *
`;
    expect(parseRepertoirePgn(text, "w")).toEqual([
      { name: "Commented", color: "w", pgn: "1. d4 d5 2. Bf4 Nf6 3. e3" },
    ]);
  });

  it("strips each result token form", () => {
    for (const result of ["1-0", "0-1", "1/2-1/2", "*"]) {
      const text = `[Line "R"]\n[Result "${result}"]\n\n1. d4 d5 ${result}\n`;
      expect(parseRepertoirePgn(text, "w")[0]?.pgn).toBe("1. d4 d5");
    }
  });

  it("produces movetext that buildRepertoire accepts", () => {
    const rep = buildRepertoire(parseRepertoirePgn(TWO_GAMES, "w"));
    expect(rep.continuations(["d2d4"], "w")?.moves.map((m) => m.san)).toEqual(["d5", "Nf6"]);
  });

  it("rejects variations with a clear error naming the line", () => {
    const text = `[Line "Branchy"]\n\n1. d4 d5 (1... Nf6 2. Bf4) 2. Bf4 *\n`;
    expect(() => parseRepertoirePgn(text, "w")).toThrow(/"Branchy".*variation/);
  });

  it("does not mistake parentheses inside comments for variations", () => {
    const text = `[Line "Paren comment"]\n\n1. d4 {(main idea)} d5 *\n`;
    expect(parseRepertoirePgn(text, "w")[0]?.pgn).toBe("1. d4 d5");
  });

  it("throws when a game has neither [Line] nor [Event]", () => {
    expect(() => parseRepertoirePgn(`[Site "?"]\n\n1. d4 d5 *\n`, "w")).toThrow(
      /no \[Line\] or \[Event\]/,
    );
  });

  it("throws on a game without headers", () => {
    expect(() => parseRepertoirePgn(`1. d4 d5 *\n`, "w")).toThrow(/no \[Line\] or \[Event\]/);
  });

  it("throws on duplicate line names", () => {
    const text = `[Line "Same"]\n\n1. d4 d5 *\n\n[Line "Same"]\n\n1. d4 Nf6 *\n`;
    expect(() => parseRepertoirePgn(text, "w")).toThrow(/duplicate line name "Same"/);
  });

  it("throws on a game with headers but no moves", () => {
    expect(() => parseRepertoirePgn(`[Line "Empty"]\n\n*\n`, "w")).toThrow(/"Empty".*no moves/);
  });

  it("throws on empty or whitespace-only text", () => {
    expect(() => parseRepertoirePgn("", "w")).toThrow(/no games/);
    expect(() => parseRepertoirePgn("  \n\n \t\n", "w")).toThrow(/no games/);
  });

  it("throws on a stray '}' in movetext, naming the character and the line", () => {
    expect(() => parseRepertoirePgn('[Line "X"] 1. d4 } d5 *', "w")).toThrow(
      /unexpected '\}'.*"X"/,
    );
  });

  it("throws on a stray ']' in movetext, naming the character and the line", () => {
    expect(() => parseRepertoirePgn('[Line "X"] 1. d4 ] d5 *', "w")).toThrow(
      /unexpected '\]'.*"X"/,
    );
  });

  it("a game with headers but no moves and no result is not merged into the next game", () => {
    expect(() => parseRepertoirePgn('[Line "A"]\n\n[Line "B"]\n\n1. d4 d5 *', "w")).toThrow(
      /"A".*no moves/,
    );
  });

  it("a repeated [Event] in a header block also starts a new game", () => {
    expect(() =>
      parseRepertoirePgn('[Event "A"]\n[Event "B"]\n\n1. d4 d5 *', "w"),
    ).toThrow(/"A".*no moves/);
  });

  it("a new game may follow movetext or a result without a blank line", () => {
    const text = '[Line "A"]\n1. d4 d5\n[Line "B"]\n1. d4 Nf6 *\n[Line "C"]\n1. d4 e6 *';
    expect(parseRepertoirePgn(text, "w").map((l) => l.name)).toEqual(["A", "B", "C"]);
  });

  it("passes a '3...' continuation marker through to a valid line", () => {
    const text = `[Line "Cont"]\n\n1. d4 d5 2. Bf4 Nf6 3. e3 {idea} 3... e6 4. Nf3 *\n`;
    const lines = parseRepertoirePgn(text, "w");
    expect(lines[0]?.pgn).toBe("1. d4 d5 2. Bf4 Nf6 3. e3 3... e6 4. Nf3");
    const rep = buildRepertoire(lines);
    expect(
      rep.continuations(["d2d4", "d7d5", "c1f4", "g8f6", "e2e3", "e7e6"], "w")?.moves.map(
        (m) => m.san,
      ),
    ).toEqual(["Nf3"]);
  });

  it("handles CRLF line endings and escaped quotes in header values", () => {
    const text = `[Line "London \\"main\\""]\r\n[Result "*"]\r\n\r\n1. d4 d5 *\r\n`;
    expect(parseRepertoirePgn(text, "w")).toEqual([
      { name: 'London "main"', color: "w", pgn: "1. d4 d5" },
    ]);
  });
});
