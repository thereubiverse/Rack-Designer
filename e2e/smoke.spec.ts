import { test, expect } from "@playwright/test";

test("workspace loads and shows the Racks heading and search box", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Racks" })).toBeVisible();
  await expect(page.getByPlaceholder(/search racks/i)).toBeVisible();
});
