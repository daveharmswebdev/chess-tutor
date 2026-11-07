import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepertoire, parseRepertoirePgn, type Color, type Repertoire } from "@chess-tutor/chess-core";

export const DEFAULT_REPERTOIRE_DIR = fileURLToPath(new URL("../../../repertoire/", import.meta.url));

export class RepertoireLoadError extends Error {
  override name = "RepertoireLoadError";
}

export interface RepertoireFile {
  path: string;
  color: Color;
}

/** london.pgn (White) and kid.pgn (Black) in `dir`. */
export function defaultRepertoireFiles(dir: string = DEFAULT_REPERTOIRE_DIR): RepertoireFile[] {
  return [
    { path: join(dir, "london.pgn"), color: "w" },
    { path: join(dir, "kid.pgn"), color: "b" },
  ];
}

/**
 * Reads and validates every repertoire file at startup (#6; used by FR-6a/FR-19 later).
 * Throws RepertoireLoadError naming the file when one is missing or does not parse.
 */
export function loadRepertoire(files: RepertoireFile[]): Repertoire {
  const lines = files.flatMap(({ path, color }) => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new RepertoireLoadError(
        code === "ENOENT"
          ? `repertoire file ${path} is missing`
          : `repertoire file ${path} could not be read: ${(err as Error).message}`,
      );
    }
    try {
      const parsed = parseRepertoirePgn(text, color);
      buildRepertoire(parsed); // validates every move with chess.js
      return parsed;
    } catch (err) {
      throw new RepertoireLoadError(
        `repertoire file ${path} does not parse: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  return buildRepertoire(lines);
}
