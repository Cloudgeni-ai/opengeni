import { chromium } from "playwright";

const baseUrl = process.env.OPENGENI_SKILLS_FIXTURE_URL ?? "http://127.0.0.1:4179";
const browser = await chromium.launch({
  executablePath: process.env.OPENGENI_TEST_CHROMIUM ?? "/usr/local/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.goto(`${baseUrl}/test/skills-panel.html`);
  const row = page.getByRole("button", { name: /release-checks.*Installed/ });
  await row.waitFor();
  if (
    await row.evaluate(
      (element) => !["flex", "inline-flex"].includes(getComputedStyle(element).display),
    )
  )
    throw new Error("Shared catalog styles are missing when Skills is loaded directly");
  await row.click();
  const editor = page.getByRole("dialog", { name: "release-checks", exact: true });
  await editor.waitFor();
  const bounds = await editor.boundingBox();
  if (!bounds || Math.abs(bounds.x + bounds.width / 2 - 720) > 2 || bounds.width > 680)
    throw new Error(`Editor is not centered and bounded: ${JSON.stringify(bounds)}`);
  const contents = page.getByRole("textbox", { name: "Contents of SKILL.md" });
  await contents.fill(
    "---\nname: release-checks\ndescription: Verify a release before publishing\n---\n# Updated release checks\n\nRun every required check.\n",
  );
  await page.keyboard.press("Escape");
  const discard = page.getByRole("dialog", { name: "Discard unsaved Skill changes?" });
  await discard.waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  if (!(await contents.inputValue()).includes("Updated release checks"))
    throw new Error("Cancelled discard lost edits");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await discard.waitFor();
  await discard.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.mouse.click(20, 20);
  await discard.waitFor();
  await discard.getByRole("button", { name: "Cancel", exact: true }).click();
  if (!(await contents.inputValue()).includes("Updated release checks"))
    throw new Error("Close or backdrop cancellation lost edits");
  await page.getByRole("button", { name: "Save Skill", exact: true }).click();
  await editor.getByRole("status").filter({ hasText: "Skill saved and active." }).waitFor();
  await page.getByLabel("File", { exact: true }).selectOption("references/checklist.md");
  if (
    !(
      await page.getByRole("textbox", { name: "Contents of references/checklist.md" }).inputValue()
    ).includes("release notes")
  )
    throw new Error("Supporting file lost after save");
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "hidden" });
  if (!(await row.evaluate((element) => element === document.activeElement)))
    throw new Error("Clean close did not restore focus to the catalog row");
  await page.keyboard.press("Enter");
  await editor.waitFor();
  await contents.fill("Unsaved changes to discard");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  if (!(await row.evaluate((element) => element === document.activeElement)))
    throw new Error("Discard close did not restore focus to the catalog row");
  await row.click();
  if (!(await contents.inputValue()).includes("Updated release checks"))
    throw new Error("Discard changed the saved content");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New skill", exact: true }).click();
  await page.getByRole("menuitem", { name: "Create manually" }).click();
  const newEditor = page.getByRole("dialog", { name: "New skill", exact: true });
  await newEditor.waitFor();
  await newEditor.getByRole("button", { name: "Close", exact: true }).click();
  await newEditor.waitFor({ state: "hidden" });
  if (
    !(await page
      .getByRole("button", { name: "New skill", exact: true })
      .evaluate((element) => element === document.activeElement))
  )
    throw new Error("New editor close did not restore focus to New skill");
  await row.click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow || errors.length) throw new Error(JSON.stringify({ overflow, errors }));
  if (process.env.OPENGENI_SKILLS_SCREENSHOT)
    await page.screenshot({ path: process.env.OPENGENI_SKILLS_SCREENSHOT, fullPage: true });
  console.log(
    "Skills editor desktop browser check passed: centered modal, edit, Escape/close/backdrop discard cancellation, save, supporting-file retention, confirmed discard, keyboard reopen, row/new-skill focus restoration, no overflow or page errors.",
  );
} finally {
  await browser.close();
}
