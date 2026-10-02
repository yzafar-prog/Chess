import { expect, test } from "@playwright/test";

test("analyzes the sample game with Stockfish and shows coaching", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Load a sample game" }).click();
  await page.locator("#depth").selectOption("12");
  await page.getByRole("button", { name: "Analyze game" }).click();

  await expect(page.locator("#results")).toBeVisible({ timeout: 150_000 });
  await expect(page.locator("#engine-status")).toContainText("Stockfish");

  // Reviewing as Black: the final mate and the blunders that led to it.
  await expect(page.locator("#coaching .headline")).toContainText("Accuracy");
  await expect(page.locator("#coaching")).toContainText("Turning point");
  await expect(page.locator(".move-list .mv[data-index]")).toHaveCount(33);

  // Jump to a mistake and check the detail panel shows engine lines.
  await page.locator("#next-mistake").click();
  await expect(page.locator("#move-detail .badge")).toBeVisible();
  await expect(page.locator("#move-detail")).toContainText("Engine's best move");
  await page.locator("#move-detail .line .chip").first().click();
  await expect(page.locator("#variation-banner")).toBeVisible();

  // Deeper verification of the decision.
  await page.locator("#variation-exit").click();
  await page.locator("#deep-btn").click();
  await expect(page.locator("#move-detail .deep")).toBeVisible({ timeout: 120_000 });

  await page.screenshot({ path: "test-results/app.png", fullPage: true });
  expect(errors).toEqual([]);
});
