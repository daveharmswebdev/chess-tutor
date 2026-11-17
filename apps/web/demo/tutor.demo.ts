// Guided demo (#59: FR-27, FR-28, FR-10): a short London game as White against the sparring bot,
// recorded as video. The opening moves are legal whatever the bot replies (checked with chess.js
// against the real move list), the mistake is chosen by Stockfish from the actual position
// (demo/mistake.ts; never hard-coded, never by Claude), then the tutor's question, Hint and Show me.
// Every wait is on page state (test IDs); the only fixed waits are the named reading pauses.
// See demo/playwright.config.ts for how to run it.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createEngineFromEnv } from "@chess-tutor/engine";
import { demoTokenHeaders } from "./demo-token.ts";
import { pickMistake, type Mistake } from "./mistake.ts";
import { FALLBACK_MOVES, OPENING_PLAN, fenFromSans, firstLegal, type PlannedMove } from "./opening.ts";

// Reading pauses (the only fixed waits).
const INTRO_PAUSE_MS = 4_000;
const MOVE_PAUSE_MS = 1_500;
const STEP_PAUSE_MS = 4_000;
const READ_PAUSE_MS = 6_000;
const OUTRO_PAUSE_MS = 4_000;

// Waits on page state.
const PAGE_MS = 15_000;
const BOT_REPLY_MS = 20_000;
const TUTOR_MS = 90_000; // a Claude call with tool rounds can take 10-40 s, more on a cold server

/** At least this loss for the mistake: a margin over the server's blunderCp (150), whose deeper search may differ. */
const MIN_LOSS_CP = 250;
/** Extra developing moves to try when no mistake qualifies yet. */
const MAX_EXTRA_MOVES = 2;

const VIDEO_OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../demo-output/demo.webm");

// Fixed captions.
const CAPTIONS = {
  intro: "Chess Tutor: a sparring bot and a tutor that asks before it tells.",
  newGame: "We play White, with the London System.",
  opening: "The London: d4, then Bf4.",
  mistake: "Now a real mistake. Stockfish chose it from this position: it loses about two pawns.",
  thinking: "The tutor saw the mistake. It checks the position with Stockfish before it speaks.",
  question: "Instead of the answer, the tutor asks a question.",
  hint: "Stuck? Hint gives a nudge, still without the answer.",
  showMe: "Show me gives the answer the engine found, with the reason.",
  outro: "Moves and evaluations come from Stockfish. Claude only explains.",
} as const;

async function caption(page: Page, text: string) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      Object.assign(el.style, {
        position: "fixed",
        left: "50%",
        bottom: "24px",
        transform: "translateX(-50%)",
        maxWidth: "80%",
        padding: "12px 20px",
        background: "rgba(0, 0, 0, 0.78)",
        color: "#fff",
        font: "600 22px/1.35 system-ui, sans-serif",
        borderRadius: "8px",
        textAlign: "center",
        zIndex: "2147483647",
        pointerEvents: "none",
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

function square(page: Page, sq: string) {
  return page.locator(`[data-square="${sq}"]`);
}

async function sansOnPage(page: Page): Promise<string[]> {
  return (await page.getByTestId("move-item").allTextContents()).map((s) => s.trim());
}

/** Plays a White move by clicking source then target, then waits for the bot's reply. */
async function playAndWaitForBot(page: Page, move: PlannedMove | Mistake, before: number) {
  await square(page, move.from).click();
  await square(page, move.to).click();
  const moves = page.getByTestId("move-item");
  await expect(moves.nth(before)).toHaveText(move.san, { timeout: PAGE_MS });
  await expect(moves).toHaveCount(before + 2, { timeout: BOT_REPLY_MS });
  await expect(page.getByTestId("status")).toHaveText("Your move.", { timeout: PAGE_MS });
}

/** Waits for `target`, failing with the panel's text if the tutor failed or coaching is off. */
async function waitForTutor(page: Page, target: Locator, step: string) {
  const failed = page.getByTestId("tutor-failed");
  const unavailable = page.getByTestId("tutor-unavailable");
  await expect(target.or(failed).or(unavailable)).toBeVisible({ timeout: TUTOR_MS });
  for (const [what, loc] of [
    ["tutor-failed", failed],
    ["tutor-unavailable", unavailable],
  ] as const) {
    if (await loc.isVisible()) {
      throw new Error(`demo stopped at ${step}: ${what}: ${(await loc.textContent())?.trim()}`);
    }
  }
}

test("guided demo: the tutor catches a mistake (FR-27)", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const token = process.env["DEMO_TOKEN"];
  if (token) {
    // FR-28: only the new-game request carries the token (demo-token.ts decides which).
    await page.route("**/api/games", async (route) => {
      const req = route.request();
      const headers = demoTokenHeaders(req.method(), req.url(), req.headers(), token);
      await (headers ? route.continue({ headers }) : route.continue());
    });
  } else {
    console.warn("DEMO_TOKEN is not set: the demo game is recorded as a player game (FR-28).");
  }

  const engine = createEngineFromEnv();
  try {
    await page.goto("/");
    await expect(page.getByTestId("new-game")).toBeVisible({ timeout: PAGE_MS });
    await caption(page, CAPTIONS.intro);
    await page.waitForTimeout(INTRO_PAUSE_MS);

    await caption(page, CAPTIONS.newGame);
    await page.getByTestId("color-white").check();
    await page.getByTestId("new-game").click();
    await expect(page.getByTestId("status")).toHaveText("Your move.", { timeout: PAGE_MS });
    await expect(page.getByTestId("move-item")).toHaveCount(0);
    await page.waitForTimeout(STEP_PAUSE_MS);

    await caption(page, CAPTIONS.opening);
    for (const step of OPENING_PLAN) {
      const sans = await sansOnPage(page);
      const move = firstLegal(sans, step) ?? firstLegal(sans, FALLBACK_MOVES);
      if (!move) throw new Error(`no scripted or fallback move is legal after ${sans.join(" ")}`);
      await playAndWaitForBot(page, move, sans.length);
      await page.waitForTimeout(MOVE_PAUSE_MS);
    }

    // The mistake: Stockfish evaluates every legal White move in the position on the page.
    let mistake: Mistake | null = null;
    for (let extra = 0; ; extra++) {
      const sans = await sansOnPage(page);
      mistake = await pickMistake(engine, fenFromSans(sans), { minLossCp: MIN_LOSS_CP, skipKingMoves: true });
      if (mistake) break;
      if (extra >= MAX_EXTRA_MOVES) {
        throw new Error(`no move losing >= ${MIN_LOSS_CP} cp (and leaving White <= +500) after ${sans.join(" ")}`);
      }
      const move = firstLegal(sans, FALLBACK_MOVES);
      if (!move) throw new Error(`no fallback move is legal after ${sans.join(" ")}`);
      await playAndWaitForBot(page, move, sans.length);
    }
    console.log(
      `demo mistake: ${mistake.san} (${mistake.uci}), best ${mistake.bestCp} cp, after it ${mistake.playedCp} cp, loss ${mistake.lossCp} cp`,
    );
    await caption(page, CAPTIONS.mistake);
    await page.waitForTimeout(STEP_PAUSE_MS);
    await playAndWaitForBot(page, mistake, (await sansOnPage(page)).length);

    // The tutor's question (FR-8, FR-11).
    const question = page.getByTestId("tutor-question");
    await caption(page, CAPTIONS.thinking);
    await waitForTutor(page, question, "the tutor's question");
    await caption(page, CAPTIONS.question);
    await page.waitForTimeout(READ_PAUSE_MS);

    // Hint (FR-12): the reply replaces the question text.
    const asked = (await question.textContent()) ?? "";
    const hint = page.getByTestId("tutor-hint");
    await expect(hint).toBeEnabled({ timeout: PAGE_MS });
    await caption(page, CAPTIONS.hint);
    await hint.click();
    await waitForTutor(page, question.filter({ hasNotText: asked }), "Hint");
    await page.waitForTimeout(READ_PAUSE_MS);

    // Show me (FR-11): the answer comes from the engine, shown as "Answer: <san>".
    const showMe = page.getByTestId("tutor-show-me");
    await expect(showMe).toBeEnabled({ timeout: PAGE_MS });
    await caption(page, CAPTIONS.showMe);
    await showMe.click();
    const reveal = page.getByTestId("tutor-reveal");
    await waitForTutor(page, reveal, "Show me");
    await page.waitForTimeout(READ_PAUSE_MS);

    await caption(page, CAPTIONS.outro);
    await page.waitForTimeout(OUTRO_PAUSE_MS);
  } finally {
    await engine.quit();
    const video = page.video();
    await page.close();
    if (video) {
      await mkdir(dirname(VIDEO_OUT), { recursive: true });
      await video.saveAs(VIDEO_OUT); // waits until the closed page's video is fully written
      console.log(`demo video: ${VIDEO_OUT}`);
    }
  }
});
