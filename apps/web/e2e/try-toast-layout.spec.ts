// The try result's pop-up never covers a board square, at phone widths too (#52, FR-24; review 086).
// e2e has no Claude key, so no try can be graded. The page is the real app with its real styles:
// the pop-up's markup (as TryToast renders it) goes into its live region, and its box is measured
// against the board. The full text stays in the DOM for screen readers; only the view can truncate.
import { expect, test } from "@playwright/test";

const WIDTHS = [320, 360, 375, 390, 412];
// The longest lines the pop-up can show (long SAN: promotion with check).
const TEXTS: Array<{ correct: boolean; text: string }> = [
  { correct: true, text: "Nf3, correct. Only 0.1 off the best move" },
  { correct: true, text: "Bf4, correct. Less than 0.1 off the best move" },
  { correct: true, text: "exd8=Q+, correct. Less than 0.1 off the best move" },
  { correct: false, text: "exd8=N+, not quite. Best was exd8=Q+" },
];

for (const width of WIDTHS) {
  test(`the try pop-up covers no board square at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.locator(".try-toast-region")).toHaveCount(1);
    for (const { correct, text } of TEXTS) {
      const box = await page.evaluate(
        ({ correct, text }) => {
          const region = document.querySelector(".try-toast-region")!;
          region.innerHTML =
            `<p class="try-toast ${correct ? "good" : "bad"}" data-testid="try-toast">` +
            `<span class="try-toast-mark" aria-hidden="true">${correct ? "✓" : "✗"}</span> ${text}</p>`;
          const el = region.querySelector(".try-toast")!;
          const toast = el.getBoundingClientRect();
          const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
          const square = document.querySelector('[data-square="a8"], [data-square="h1"]')!.getBoundingClientRect();
          return {
            toastBottom: toast.bottom,
            toastLeft: toast.left,
            toastRight: toast.right,
            boardTop: board.top,
            boardLeft: board.left,
            boardRight: board.right,
            squareTop: square.top,
            fullText: region.textContent,
            truncated: el.scrollWidth > el.clientWidth,
          };
        },
        { correct, text },
      );
      const where = `${width}px "${text}": ${JSON.stringify(box)}`;
      expect(box.toastBottom, where).toBeLessThanOrEqual(box.boardTop);
      expect(box.toastBottom, where).toBeLessThanOrEqual(box.squareTop);
      expect(box.toastLeft, where).toBeGreaterThanOrEqual(box.boardLeft - 0.5);
      expect(box.toastRight, where).toBeLessThanOrEqual(box.boardRight + 0.5);
      expect(box.fullText, where).toContain(text);
      console.log(`layout ${width}px toastBottom=${box.toastBottom.toFixed(1)} boardTop=${box.boardTop.toFixed(1)} truncated=${box.truncated} "${text}"`);
    }
  });
}
