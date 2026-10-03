import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { workspaceKeyPermissions } from "../src/lib/api-key-presets";

const output = process.env.OPENGENI_API_KEYS_PREVIEW_OUTPUT ?? "/tmp/opengeni-api-keys-preview";
const baseUrl = process.env.OPENGENI_API_KEYS_PREVIEW_URL ?? "http://127.0.0.1:4336";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.OPENGENI_API_KEYS_PREVIEW_CHROMIUM
    ? { executablePath: process.env.OPENGENI_API_KEYS_PREVIEW_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/test/workspace-api-keys-preview.html`, {
      waitUntil: "networkidle",
    });
    await page.getByLabel("Name", { exact: true }).fill("CI pipeline");
    await page.getByRole("combobox", { name: "Access" }).click();
    await page.getByRole("option", { name: /^All permissions/ }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/access-menu-${width}.png`, animations: "disabled" });
    await page.getByRole("option", { name: /^All permissions/ }).click();
    await page.screenshot({
      path: `${output}/all-permissions-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("combobox", { name: "Access" }).click();
    await page.getByRole("option", { name: /^Custom/ }).click();
    const checked = await page.locator("input[type=checkbox]:checked").count();
    if (checked !== workspaceKeyPermissions().length)
      throw new Error(`Expected full selection, got ${checked}`);
    await page.getByLabel("Read secret values", { exact: true }).uncheck();
    await page.screenshot({
      path: `${output}/custom-narrowed-${width}.png`,
      animations: "disabled",
    });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error(`Overflow at ${width}px`);
    await page.getByRole("button", { name: "Create API key", exact: true }).click();
    await page.getByText("API key created", { exact: true }).waitFor();
    const submitted = await page.evaluate(
      () =>
        (window as unknown as { submittedRequests: { permissions: string[] }[] })
          .submittedRequests[0]!.permissions,
    );
    const expected = workspaceKeyPermissions()
      .filter((permission) => permission !== "secrets:read")
      .sort();
    if (JSON.stringify(submitted.sort()) !== JSON.stringify(expected))
      throw new Error("Incorrect create payload");
    await page.goto(`${baseUrl}/test/workspace-api-keys-preview.html?restricted`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("combobox", { name: "Access" }).click();
    const all = page.getByRole("option", { name: /^All permissions/ });
    if ((await all.getAttribute("aria-disabled")) !== "true")
      throw new Error("All permissions must be disabled");
    await all.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/restricted-${width}.png`, animations: "disabled" });
    if (errors.length) throw new Error(errors.join("; "));
    await page.close();
  }
  console.log(
    "Production component verified at desktop/mobile: preset, Custom narrowing, exact payload, restricted access, no overflow or browser errors.",
  );
} finally {
  await browser.close();
}
