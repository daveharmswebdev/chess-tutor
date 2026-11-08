// Plays a few moves against the real sparring bot (FR-1, FR-4, IR-5). Moves are made by
// clicking source then target square, so no drag gestures are involved.
import { expect, test, type Page } from "@playwright/test";

const BOT_REPLY_MS = 10_000;

function square(page: Page, sq: string) {
  return page.locator(`[data-square="${sq}"]`);
}

async function clickMove(page: Page, from: string, to: string) {
  await square(page, from).click();
  await square(page, to).click();
}

test("play as White, take back, then start as Black", async ({ page }) => {
  await page.goto("/");
  const status = page.getByTestId("status");
  const moves = page.getByTestId("move-item");

  await page.getByTestId("color-white").check();
  await page.getByTestId("new-game").click();
  await expect(status).toHaveText("Your move.");
  await expect(moves).toHaveCount(0);
  // No ANTHROPIC_API_KEY in e2e: the tutor panel says why coaching is off and Hint is disabled (NFR-9).
  await expect(page.getByTestId("tutor-unavailable")).toBeVisible();
  await expect(page.getByTestId("tutor-hint")).toBeDisabled();

  // 1. d4, wait for the bot's reply.
  await clickMove(page, "d2", "d4");
  await expect(moves.nth(0)).toHaveText("d4");
  await expect(moves).toHaveCount(2, { timeout: BOT_REPLY_MS });
  await expect(status).toHaveText("Your move.");

  // 2. Bf4 (legal whatever the bot replied: d4 opened c1-f4, and no reply blocks it at once).
  await clickMove(page, "c1", "f4");
  await expect(moves.nth(2)).toHaveText("Bf4");
  await expect(moves).toHaveCount(4, { timeout: BOT_REPLY_MS });
  await expect(status).toHaveText("Your move.");

  // Takeback removes the bot's reply and Bf4.
  await page.getByTestId("takeback").click();
  await expect(moves).toHaveCount(2);
  await expect(status).toHaveText("Your move.");

  // New game as Black: the bot moves first.
  await page.getByTestId("color-black").check();
  await page.getByTestId("new-game").click();
  await expect(moves).toHaveCount(1, { timeout: BOT_REPLY_MS });
  await expect(moves.nth(0)).toHaveAttribute("data-by", "bot");
  await expect(status).toHaveText("Your move.");
});
