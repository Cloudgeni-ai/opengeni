import type { Locator } from "playwright";

/**
 * Choose one answer in an agent question card the way a person does. The
 * whole row is the target and its radio or checkbox is visually hidden (so
 * Markdown links in the row stay clickable), so `check()` on the input itself
 * lands on the row and Playwright reports the row as intercepting the click.
 * Click the row instead, then confirm the input took the choice.
 */
export async function chooseAnswerRow(choice: Locator, timeoutMs = 5_000): Promise<void> {
  await choice.locator("xpath=ancestor::label[1]").click();
  const deadline = Date.now() + timeoutMs;
  while (!(await choice.isChecked())) {
    if (Date.now() > deadline) throw new Error("The answer row did not take the choice.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
