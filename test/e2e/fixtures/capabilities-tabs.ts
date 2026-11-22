import type { Locator, Page } from "playwright";

/** The Capabilities page's tabs. Each is a link to its own `?section=` address. */
export type CapabilitiesTab = "Connections" | "Skills" | "Ready-made";

export function capabilitiesTab(page: Page, name: CapabilitiesTab): Locator {
  return page
    .getByRole("navigation", { name: "Capabilities", exact: true })
    .getByRole("link", { name, exact: true });
}

/** Opens a tab and waits until it is the current page (`aria-current="page"`). */
export async function openCapabilitiesTab(page: Page, name: CapabilitiesTab): Promise<void> {
  const tab = capabilitiesTab(page, name);
  await tab.waitFor({ state: "visible", timeout: 15_000 });
  await tab.click();
  await waitForCapabilitiesTab(page, name);
}

export async function waitForCapabilitiesTab(page: Page, name: CapabilitiesTab): Promise<void> {
  await page
    .getByRole("navigation", { name: "Capabilities", exact: true })
    .locator('a[aria-current="page"]', { hasText: name })
    .waitFor({ state: "visible", timeout: 15_000 });
}

export async function capabilitiesTabIsCurrent(page: Page, name: CapabilitiesTab): Promise<boolean> {
  return (await capabilitiesTab(page, name).getAttribute("aria-current")) === "page";
}

/** The rows of what you already have on a tab, for example "Connected" or "Installed". */
export function installedRows(page: Page, title: string): Locator {
  return page
    .getByRole("region", { name: title, exact: true })
    .locator("button.og-capability-catalog-row");
}
