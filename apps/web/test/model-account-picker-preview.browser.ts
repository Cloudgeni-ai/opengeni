import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

// The session-header model-account control, rendered with real components
// against a synthetic client: a private chat (the person's own account can be
// chosen, with the personal-fallback toggle) and a shared chat (it cannot).
const base = process.env.OPENGENI_PICKER_PREVIEW_URL ?? "http://127.0.0.1:4196";
const output = process.env.OPENGENI_PICKER_PREVIEW_OUTPUT ?? "/tmp/opengeni-picker-preview";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_PICKER_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_PICKER_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};

try {
  for (const width of [1100, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 560 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const theme = width === 390 ? "dark" : "light";
    const open = async (session: "private" | "shared") => {
      await page.goto(
        `${base}/test/fixtures/model-account-picker-preview/?session=${session}&theme=${theme}`,
        { waitUntil: "networkidle" },
      );
      await page.getByRole("button", { name: /^Model account/ }).click();
      await page.getByText("Use for next turn").waitFor();
    };
    const shot = (name: string) => page.screenshot({ path: `${output}/${name}-${width}.png` });

    // A private chat: shared accounts, then the person's own, and the fallback toggle.
    await open("private");
    await page.getByRole("menuitemcheckbox", { name: /Fall back to my account/ }).waitFor();
    await shot("private-open");

    // Choosing their own account; the header switches to the personal mark.
    await page.getByRole("menuitem", { name: /My Claude/ }).click();
    await page.getByText("Saved for the next turn.").waitFor();
    await page.getByRole("menuitemcheckbox", { name: /Fall back to my account/ }).click();
    await page.waitForFunction(() =>
      JSON.stringify((window as unknown as { pickerReceipts: unknown[] }).pickerReceipts).includes(
        '"fallback":true',
      ),
    );
    await page
      .getByRole("menuitemcheckbox", { name: /Fall back to my account/, checked: true })
      .waitFor();
    await shot("private-chosen");

    // A shared chat: the person's own account is listed but cannot be chosen.
    await open("shared");
    const mine = page.getByRole("menuitem", { name: /My Claude/ });
    assert((await mine.getAttribute("aria-disabled")) === "true", "personal account choosable");
    await page.getByText("Private chats only").waitFor();
    assert(
      (await page.getByRole("menuitemcheckbox", { name: /Fall back to my account/ }).count()) === 0,
      "fallback offered where no personal account can serve",
    );
    await shot("shared-open");

    assert(errors.length === 0, `page errors: ${errors.join("; ")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
