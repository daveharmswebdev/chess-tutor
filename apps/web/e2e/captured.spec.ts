// Captured pieces appear on the capturing side (#42, FR-20, FR-4), against the real sparring bot.
// The bot's replies vary, so the test reads the board's FEN (data-fen) each turn and plays the
// first legal capture it finds, steering towards contact with central pawn moves until then.
import { expect, test, type Page } from "@playwright/test";
import { Chess, type Move } from "chess.js";

const BOT_REPLY_MS = 10_000;
const MAX_TURNS = 20;
const STEER = ["e2e4", "d2d4", "g1f3", "b1c3", "f1c4", "c1f4", "d1d3", "f1d3", "c1g5"];

function square(page: Page, sq: string) {
  return page.locator(`[data-square="${sq}"]`);
}

async function capturedTotal(page: Page): Promise<number> {
  const counts = await page
    .getByTestId("captured-you")
    .locator("[data-piece]")
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-count"))));
  return counts.reduce((a, b) => a + b, 0);
}

function pick(fen: string): Move {
  const legal = new Chess(fen).moves({ verbose: true }).filter((m) => !m.promotion && !m.isKingsideCastle() && !m.isQueensideCastle());
  const capture = legal.find((m) => m.captured !== undefined && m.captured !== "k");
  if (capture) return capture;
  for (const uci of STEER) {
    const m = legal.find((l) => l.from + l.to === uci);
    if (m) return m;
  }
  const quiet = legal.find((m) => m.piece !== "k");
  if (!quiet) throw new Error(`no move to play in ${fen}`);
  return quiet;
}

test("a capture shows the captured piece on the capturing side", async ({ page }) => {
  await page.goto("/");
  const status = page.getByTestId("status");
  const board = page.getByTestId("board");

  await page.getByTestId("color-white").check();
  await page.getByTestId("new-game").click();
  await expect(status).toHaveText("Your move.");
  await expect(page.getByTestId("side-bot")).toContainText("Bot");
  await expect(page.getByTestId("side-you")).toContainText("You");
  await expect(page.getByTestId("captured-you").locator("[data-piece]")).toHaveCount(0);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    await expect(status).toHaveText("Your move.", { timeout: BOT_REPLY_MS });
    const fen = (await board.getAttribute("data-fen")) ?? "";
    const move = pick(fen);
    const before = await capturedTotal(page);

    await square(page, move.from).click();
    await square(page, move.to).click();

    if (move.captured) {
      const group = page.getByTestId("captured-you").locator(`[data-piece="${move.captured}"]`);
      await expect(group).toBeVisible();
      await expect.poll(() => capturedTotal(page)).toBe(before + 1);
      // The lead, when there is one, is labelled as a piece count, not an evaluation.
      const lead = page.getByTestId("material-you");
      if ((await lead.count()) > 0) {
        await expect(lead).toHaveAttribute("title", /piece count, not an engine evaluation/);
      }
      return;
    }
    await expect(status).not.toHaveText("Your move.");
  }
  throw new Error(`no capture became available in ${MAX_TURNS} turns`);
});
