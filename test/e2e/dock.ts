import type { Page } from "playwright";

/**
 * The app's dock shows only the tabs a chat has content for; the rest sit in
 * its empty view or behind "+". Open a tab whichever way it is offered.
 */
export async function openDockTab(page: Page, name: string): Promise<void> {
  const dock = page.locator("[data-dock-chrome]").filter({ visible: true }).first();
  await dock.waitFor();
  const tab = dock.getByRole("tab", { name, exact: true });
  if (await tab.isVisible()) return tab.click();
  const choice = dock.locator("[data-dock-landing-tab]").filter({ hasText: name });
  if (await choice.isVisible()) return choice.click();
  await dock.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** Desktop hides the dock from the header toggle; a phone's overlay has its own. */
export async function hideWorkspace(page: Page): Promise<void> {
  const hide = { name: "Hide workspace", exact: true } as const;
  const phone = (page.viewportSize()?.width ?? 1280) < 1024;
  const target = phone
    ? page.locator("[data-dock-chrome]").getByRole("button", hide).filter({ visible: true })
    : page.getByRole("button", hide);
  await target.first().click();
}
