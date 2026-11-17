// Tutor notes in the move list (#54: FR-25, NFR-14). e2e runs with no Claude key, so no real note
// can be made end to end (#75 tracks a fake tutor). The API is stubbed with page.route: GET
// /api/games/<id> and its event stream serve a GameView with moves and notes, as the server sends
// them since #53. The real move-on flow that creates notes is covered by the server's tests (#53)
// and the web unit tests (move-notes.test.ts, move-list.test.ts).
import type { GameView, MoveView, TutorNote } from "@chess-tutor/chess-core";
import { expect, test, type Page } from "@playwright/test";

const GAME_ID = "e2e-notes";
const mv = (uci: string, san: string, by: MoveView["by"]): MoveView => ({ uci, san, by });
const MOVES: MoveView[] = [
  mv("d2d4", "d4", "player"),
  mv("g8f6", "Nf6", "bot"),
  mv("c1f4", "Bf4", "player"),
  mv("g7g6", "g6", "bot"),
  mv("e2e3", "e3", "player"),
  mv("f8g7", "Bg7", "bot"),
  mv("g1f3", "Nf3", "player"),
  mv("e8g8", "O-O", "bot"),
  mv("f1e2", "Be2", "player"),
  mv("d7d6", "d6", "bot"),
];
const LONG_REVEAL =
  "The fianchetto bishop on g7 will look down the long diagonal at your queenside, so keep the " +
  "centre closed with c3 and e3, castle short, and only then think about h3 to give the f4 bishop " +
  "a retreat square. Averyveryverylongwordwithoutanyspacesatalltocheckwrapping.";
const NOTES: TutorNote[] = [
  {
    questionId: "q-book",
    kind: "opponent_left_book",
    ply: 4,
    message: "Black left your book. What does ...g6 change about where your pieces belong?",
    reveal: LONG_REVEAL,
    bestMove: mv("g1f3", "Nf3", "player"),
    attempt: null,
  },
  {
    questionId: "q-blunder",
    kind: "player_blunder",
    ply: 8,
    message: "Be2 lets ...Nh5 hit your bishop.",
    reveal: null,
    bestMove: mv("h2h3", "h3", "player"),
    attempt: { move: mv("f1e2", "Be2", "player"), correct: false, cpLoss: 118 },
  },
];
const GAME: GameView = {
  id: GAME_ID,
  playerColor: "w",
  fen: "rnbq1rk1/ppp1ppbp/3p1np1/8/3P1B2/4PN2/PPP1BPPP/RN1QK2R w KQ - 0 6",
  moves: MOVES,
  status: "playing",
  result: "*",
  endReason: null,
  botThinking: false,
  tutor: { available: false, reason: "Coaching is off: no API key is set.", thinking: false, question: null, reveal: null },
  notes: NOTES,
};

/** Serves GAME for GET /api/games/<id>, and a stream with one "state" event. Counts the GETs. */
async function stubGame(page: Page): Promise<{ gets: number }> {
  const seen = { gets: 0 };
  await page.route(`**/api/games/${GAME_ID}/events`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: `event: state\ndata: ${JSON.stringify({ type: "state", game: GAME })}\n\n`,
    }),
  );
  await page.route(`**/api/games/${GAME_ID}`, (route) => {
    seen.gets++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(GAME) });
  });
  return seen;
}

async function noHorizontalScroll(page: Page) {
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    list: document.querySelector('[data-testid="move-list"]')!.scrollWidth,
    listClient: document.querySelector('[data-testid="move-list"]')!.clientWidth,
  }));
  expect(m.scroll, JSON.stringify(m)).toBeLessThanOrEqual(m.client);
  expect(m.list, JSON.stringify(m)).toBeLessThanOrEqual(m.listClient);
}

test("wide screen: the Tutor column shows each note, ▸ more opens it, and it survives a reload", async ({ page }) => {
  const seen = await stubGame(page);
  await page.goto(`/games/${GAME_ID}`);
  await expect(page.getByTestId("move-item")).toHaveCount(10);

  const notes = page.getByTestId("move-note");
  await expect(notes).toHaveCount(2);
  await expect(page.locator(".moves-head-tutor")).toBeVisible();
  await expect(notes.nth(0)).toBeVisible();
  await expect(notes.nth(0)).toHaveAttribute("data-ply", "4");
  await expect(notes.nth(0).locator(".note-short")).toHaveText(NOTES[0]!.message);
  await expect(notes.nth(0).locator(".note-full")).toBeHidden();
  // The ❝ buttons belong to the narrow layout.
  await expect(page.getByTestId("move-note-toggle").first()).toBeHidden();
  // Each note sits on the row of its move: e3 (3.) and Be2 (5.).
  await expect(page.locator(".moves li").nth(2).getByTestId("move-note")).toHaveCount(1);
  await expect(page.locator(".moves li").nth(4).getByTestId("move-note")).toHaveCount(1);
  // The note is one line: no taller than a move.
  const short = await notes.nth(0).locator(".note-short").boundingBox();
  const move = await page.getByTestId("move-item").nth(4).boundingBox();
  expect(short!.height).toBeLessThanOrEqual(move!.height * 1.5);

  const more = notes.nth(0).getByTestId("move-note-more");
  await expect(more).toHaveText("▸ more");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(notes.nth(0).locator(".note-full")).toBeVisible();
  await expect(notes.nth(0).locator(".note-full")).toContainText("Best was Nf3.");
  await expect(notes.nth(0).locator(".note-short")).toBeHidden();
  await noHorizontalScroll(page);
  await more.click();
  await expect(more).toHaveText("▸ more");
  await expect(notes.nth(0).locator(".note-full")).toBeHidden();

  await notes.nth(1).getByTestId("move-note-more").click();
  await expect(notes.nth(1).locator(".note-full")).toHaveText(
    "Be2 lets ...Nh5 hit your bishop. You tried Be2: it lost about 1.2 pawns. Best was h3.",
  );

  // NFR-14 at the client boundary: a reload rebuilds the list, notes included, from the server.
  const getsBefore = seen.gets;
  await page.reload();
  await expect(page.getByTestId("move-item")).toHaveCount(10);
  await expect(page.getByTestId("move-note")).toHaveCount(2);
  await expect(page.getByTestId("move-note").nth(0).locator(".note-short")).toHaveText(NOTES[0]!.message);
  await expect(page.getByTestId("move-note").nth(1)).toBeVisible();
  expect(seen.gets).toBeGreaterThan(getsBefore);
});

for (const width of [375, 320]) {
  test(`narrow screen (${width} px): ❝ opens the note under its move, a second tap closes it`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await stubGame(page);
    await page.goto(`/games/${GAME_ID}`);
    await expect(page.getByTestId("move-item")).toHaveCount(10);

    // No Tutor column: the notes are closed and the heading is gone.
    await expect(page.locator(".moves-head-tutor")).toBeHidden();
    await expect(page.getByTestId("move-note").first()).toBeHidden();
    const toggles = page.getByTestId("move-note-toggle");
    await expect(toggles).toHaveCount(2);
    await expect(page.locator(".moves li").nth(0).getByTestId("move-note-toggle")).toHaveCount(0);
    const toggle = page.getByRole("button", { name: "Tutor note for move 5. Be2" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("❝");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await noHorizontalScroll(page);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const row = page.locator(".moves li").nth(4);
    const note = row.getByTestId("move-note");
    await expect(note).toBeVisible();
    await expect(note.locator(".note-full")).toHaveText("Be2 lets ...Nh5 hit your bishop. You tried Be2: it lost about 1.2 pawns. Best was h3.");
    await expect(note.getByTestId("move-note-more")).toBeHidden();
    // Directly under the move row: below its moves, and the next row below the note.
    const be2 = await row.getByTestId("move-item").first().boundingBox();
    const noteBox = await note.boundingBox();
    expect(noteBox!.y).toBeGreaterThanOrEqual(be2!.y + be2!.height - 0.5);
    // The other note stays closed.
    await expect(page.locator(".moves li").nth(2).getByTestId("move-note")).toBeHidden();

    // The long note: full text, wrapped, still no sideways scrolling.
    await page.getByRole("button", { name: "Tutor note for move 3. e3" }).click();
    await expect(page.locator(".moves li").nth(2).getByTestId("move-note")).toContainText("Best was Nf3.");
    await noHorizontalScroll(page);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(note).toBeHidden();
  });
}
