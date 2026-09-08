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
  await page.getByRole("button", { name: "release-checks · workspace", exact: true }).click();
  const contents = page.getByRole("textbox", { name: "Contents of SKILL.md" });
  await contents.fill(
    "---\nname: release-checks\ndescription: Verify a release before publishing\n---\n# Updated release checks\n\nRun every required check.\n",
  );
  await page.getByRole("button", { name: "New Skill", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  if (!(await contents.inputValue()).includes("Updated release checks"))
    throw new Error("Cancelled discard lost edits");
  await page.getByRole("button", { name: "Save Skill", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Skill saved and active." }).waitFor();
  await page.getByLabel("File", { exact: true }).selectOption("references/checklist.md");
  if (
    !(
      await page.getByRole("textbox", { name: "Contents of references/checklist.md" }).inputValue()
    ).includes("release notes")
  )
    throw new Error("Supporting file lost after save");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow || errors.length) throw new Error(JSON.stringify({ overflow, errors }));
  if (process.env.OPENGENI_SKILLS_SCREENSHOT)
    await page.screenshot({ path: process.env.OPENGENI_SKILLS_SCREENSHOT, fullPage: true });
  console.log(
    "Skills editor desktop browser check passed: edit, cancel discard, save, supporting-file retention, no overflow or page errors.",
  );
} finally {
  await browser.close();
}
