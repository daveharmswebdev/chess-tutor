// Web addresses (#47: NFR-14): a game lives at /games/<id>; "/" (or any other path) is the
// new-game page. No router library: the controller pushes, App listens to popstate.

export function gamePath(id: string): string {
  return `/games/${encodeURIComponent(id)}`;
}

/** The game id in a pathname like "/games/<id>", or null for any other path. */
export function gameIdFromPath(pathname: string): string | null {
  const m = /^\/games\/([^/]+)\/?$/.exec(pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
