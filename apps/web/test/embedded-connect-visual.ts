// Targeted UI smoke, not provider/auth integration proof. Uses the actual native
// dialog and shared React components against deterministic credential-free data.
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
const output = process.env.EMBED_VISUAL_OUTPUT ?? "/workspace/.agent/embedding-native-ui";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.EMBED_CHROMIUM ?? "/usr/local/bin/chromium",
  headless: true,
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const state of [
      "preview",
      "pending",
      "error",
      "loading",
      "consent",
      "links",
      "empty",
      "device",
      "credentials",
    ]) {
      await page.goto(`http://127.0.0.1:3103/test/embedded-connect.html?state=${state}`);
      // Modal intentionally makes the page landmark inert to accessibility.
      await page
        .locator("h1")
        .filter({ hasText: "Product access and connection setup" })
        .waitFor({ state: "attached" });
      const expected =
        state === "device"
          ? "Waiting for authorization…"
          : state === "credentials"
            ? "Service account (optional for public services)"
            : state === "preview"
              ? "List calendar events"
              : state === "pending"
                ? "Connect a different account"
                : state === "error"
                  ? "Could not start setup."
                  : state === "loading"
                    ? "Preparing account setup…"
                    : state === "consent"
                      ? "Allow selected access"
                      : state === "empty"
                        ? "No products have linked access to this account."
                        : "Revoke access";
      await page
        .getByText(expected, { exact: !["error", "preview", "credentials"].includes(state) })
        .first()
        .waitFor();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
        throw new Error(`${state}/${width} horizontal overflow`);
      const accessibility = await new AxeBuilder({ page }).analyze();
      const serious = accessibility.violations.filter((value) =>
        ["critical", "serious"].includes(value.impact ?? ""),
      );
      if (serious.length)
        throw new Error(
          `${state}/${width} accessibility: ${serious.map((value) => value.id).join(", ")}`,
        );
      await page.screenshot({ path: `${output}/${state}-${width}.png`, fullPage: true });
    }
  }
  await page.goto("http://127.0.0.1:3103/test/embedded-connect.html?state=preview");
  await page.getByRole("checkbox", { name: /List calendar events/ }).check();
  await page.getByRole("button", { name: /Install selected/ }).click();
  await page.getByText("Account setup finished.", { exact: true }).waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "NATIVE_CONNECT_UI_PASS: 18 screenshots, desktop/mobile states, device authorization, account choices, axe serious/critical checks, explicit operation selection",
  );
} finally {
  await browser.close();
}
