// Game survival across a page refresh (#47: NFR-14, FR-4, IR-5): the game lives at /games/<id>,
// and reloading that address rebuilds the board and move list from the server.
import { expect, test, type Page } from "@playwright/test";

const BOT_REPLY_MS = 10_000;

async function clickMove(page: Page, from: string, to: string) {
  await page.locator(`[data-square="${from}"]`).click();
  await page.locator(`[data-square="${to}"]`).click();
}

test("a reload keeps the game: same moves, and the next move works", async ({ page }) => {
  await page.goto("/");
  const status = page.getByTestId("status");
  const moves = page.getByTestId("move-item");

  await page.getByTestId("color-white").check();
  await page.getByTestId("new-game").click();
  await expect(status).toHaveText("Your move.");
  await expect(page).toHaveURL(/\/games\/[^/]+$/);
  const gameUrl = page.url();

  await clickMove(page, "d2", "d4");
  await expect(moves).toHaveCount(2, { timeout: BOT_REPLY_MS });
  await expect(status).toHaveText("Your move.");
  const before = await moves.allTextContents();

  await page.reload();
  expect(page.url()).toBe(gameUrl);
  await expect(moves).toHaveCount(2);
  expect(await moves.allTextContents()).toEqual(before);
  await expect(status).toHaveText("Your move.");
  await expect(page.getByTestId("reconnecting")).toHaveCount(0);
  await expect(page.getByTestId("game-not-found")).toHaveCount(0);

  // Bf4 is legal whatever the bot replied to d4.
  await clickMove(page, "c1", "f4");
  await expect(moves.nth(2)).toHaveText("Bf4");
  await expect(moves).toHaveCount(4, { timeout: BOT_REPLY_MS });
  await expect(status).toHaveText("Your move.");

  // Back goes to the new-game page, forward reopens the game.
  await page.goBack();
  await expect(status).toHaveText("Choose a color and start a new game.");
  await page.goForward();
  await expect(moves).toHaveCount(4);
});

test("an unknown game address offers a new game", async ({ page }) => {
  await page.goto("/games/no-such-game");
  await expect(page.getByTestId("game-not-found")).toBeVisible();
  await expect(page.getByTestId("reconnecting")).toHaveCount(0);
  await page.getByTestId("not-found-new-game").click();
  await expect(page.getByTestId("status")).toHaveText("Your move.");
  await expect(page).toHaveURL(/\/games\/[^/]+$/);
  await expect(page).not.toHaveURL(/no-such-game/);
});
