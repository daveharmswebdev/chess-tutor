import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. A relative WEB_DIST resolves here, since pnpm --filter starts the server in apps/server. */
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export class WebDistError extends Error {
  override name = "WebDistError";
}

/**
 * WEB_DIST (architecture §6.1, NFR-13): unset or blank means no static serving (null).
 * Otherwise the absolute directory of the built web app; throws WebDistError when it is
 * not a directory or has no index.html, so a bad deploy fails at startup.
 */
export function resolveWebDist(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const dir = isAbsolute(value) ? resolve(value) : resolve(REPO_ROOT, value);
  checkWebDist(dir);
  return dir;
}

/** Throws WebDistError unless `dir` is a directory holding index.html. */
export function checkWebDist(dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new WebDistError(`WEB_DIST ${dir} is not a directory (build the web app or unset WEB_DIST)`);
  }
  const index = join(dir, "index.html");
  if (!existsSync(index) || !statSync(index).isFile()) {
    throw new WebDistError(`WEB_DIST ${dir} has no index.html (build the web app or unset WEB_DIST)`);
  }
}

/** True for /api, /api/... and /api?...: those never fall back to index.html. */
export function isApiPath(url: string): boolean {
  return /^\/api(?:[/?#]|$)/.test(url);
}
