// Demo games (#59: FR-27, FR-28). The guided demo marks its game as a demo game by sending
// x-demo-token on the new-game request only (POST /api/games). The token comes from env
// DEMO_TOKEN; without it nothing is added and the game is a player game.

/** Same name as apps/server/src/app.ts DEMO_TOKEN_HEADER. */
export const DEMO_TOKEN_HEADER = "x-demo-token";

export function isNewGameRequest(method: string, url: string): boolean {
  return method.toUpperCase() === "POST" && new URL(url).pathname === "/api/games";
}

/** The headers to send instead, or null to send the request unchanged. */
export function demoTokenHeaders(
  method: string,
  url: string,
  headers: Record<string, string>,
  token: string | undefined,
): Record<string, string> | null {
  if (!token || !isNewGameRequest(method, url)) return null;
  return { ...headers, [DEMO_TOKEN_HEADER]: token };
}
