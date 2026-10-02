import type { Page } from "playwright";

/** The fixture's real Close window button destroys its own action target. */
export async function clickSelfClosingPopup(popup: Page, owner: Page): Promise<void> {
  const ownerAlive = () => !owner.isClosed() && owner.context().browser()?.isConnected() === true;
  await Promise.all([
    popup.waitForEvent("close"),
    popup
      .getByRole("button", { name: "Close window", exact: true })
      .click()
      .catch((error: unknown) => {
        // Chromium can destroy the click's target before Playwright receives
        // its action acknowledgement. This is expected only for this fixture.
        if (
          error instanceof Error &&
          /^(?:locator\.)?click: Target page, context or browser has been closed(?:\n|$)/.test(
            error.message,
          ) &&
          popup.isClosed() &&
          ownerAlive()
        ) {
          return;
        }
        throw error;
      }),
  ]);
  if (!popup.isClosed() || !ownerAlive()) {
    throw new Error("Self-closing popup did not preserve its owner/browser");
  }
}
