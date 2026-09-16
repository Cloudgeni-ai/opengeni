import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
const output = resolve(import.meta.dirname, "../dist-component-gallery");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(Bun.file(resolve(output, "index.html"))),
});
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const check = (condition: unknown, message: string) => {
  if (!condition) throw Error(message);
};
const navigate = (name: string) =>
  page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name, exact: true })
    .click();
const design = (name: string) =>
  page
    .getByRole("navigation", { name: "Design alternatives" })
    .getByRole("button", { name: new RegExp(name) })
    .click();
try {
  await mkdir(resolve(output, "qa"), { recursive: true });
  await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const direction of ["A · Soft modules", "B · Quiet index", "C · Overview"]) {
      await design(direction);
      for (const section of ["General", "Models & subscriptions", "Members", "API keys"]) {
        await navigate(section);
        check(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${direction}/${section}/${width} overflow`,
        );
        const a11y = await new AxeBuilder({ page }).analyze();
        check(
          !a11y.violations.some((v) => v.impact === "serious" || v.impact === "critical"),
          `A11y ${direction}/${section}: ${a11y.violations.map((v) => v.id)}`,
        );
      }
      await navigate("General");
      await page.screenshot({
        path: resolve(output, `qa/settings-${direction[0]}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await design("A · Soft modules");
  await page.getByRole("textbox", { name: "Workspace name" }).fill("Product studio");
  const voice = page.getByRole("switch", { name: "Voice input", exact: true });
  await voice.click();
  check((await voice.getAttribute("aria-checked")) === "false", "Voice toggle");
  await design("C · Overview");
  await page.getByRole("button", { name: "Edit Voice input", exact: true }).click();
  await page.getByRole("dialog").getByRole("switch").click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await design("A · Soft modules");
  await navigate("Models & subscriptions");
  await page.getByRole("button", { name: "Manage Codex subscription", exact: true }).click();
  await page.getByRole("button", { name: /Subscription source/ }).click();
  await page.getByLabel("Use subscriptions from").selectOption("organization");
  check(await page.getByRole("radio").isDisabled(), "Workspace account disabled with org source");
  await page.getByLabel("Use subscriptions from").selectOption("automatic");
  await page.getByRole("button", { name: "Rename Team subscription" }).click();
  await page.getByRole("textbox", { name: "Name for Team subscription" }).fill("Design team");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Connect another account", exact: true }).click();
  await page.getByText("PREVIEW-CODE", { exact: true }).waitFor();
  await page.getByLabel("Preview authorization state").selectOption("expired");
  await page
    .getByText("The code expired before it was authorized. Try again.", { exact: true })
    .waitFor();
  await page.getByLabel("Preview authorization state").selectOption("error");
  await page
    .getByText("Failed to verify Codex authorization. Try again.", { exact: true })
    .waitFor();
  await page.screenshot({
    path: resolve(output, "qa/settings-codex-details-mobile.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await navigate("Members");
  check(await page.getByLabel("Role for Alex Morgan").isDisabled(), "Self role disabled");
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await page.getByLabel("Organization member", { exact: true }).selectOption("Grace Lee");
  await page.getByLabel("Workspace role", { exact: true }).selectOption("viewer");
  await page.getByRole("button", { name: "Add member to preview" }).click();
  check((await page.getByLabel("Role for Grace Lee").inputValue()) === "viewer", "Add member role");
  await page.getByLabel("Search members").fill("Grace");
  check((await page.locator(".setting-item").count()) === 1, "Search");
  await navigate("API keys");
  await page.getByRole("button", { name: "Create API key", exact: true }).click();
  check(
    await page.getByRole("button", { name: "Create preview key" }).isDisabled(),
    "Empty key disabled",
  );
  await page.getByLabel("Name", { exact: true }).fill("Design sample");
  check(
    await page.getByLabel("workspace:admin", { exact: true }).isDisabled(),
    "Cannot delegate admin",
  );
  await page.getByLabel("sessions:read", { exact: true }).check();
  await page.getByRole("button", { name: "Create preview key" }).click();
  await page.getByText("PREVIEW_ONLY_NOT_A_REAL_KEY", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page
    .locator(".setting-item")
    .filter({ hasText: "Design sample" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await page.getByRole("button", { name: "Revoke preview key" }).click();
  check(
    await page
      .locator(".setting-item")
      .filter({ hasText: "Design sample" })
      .getByRole("button", { name: "Revoked", exact: true })
      .isDisabled(),
    "Revocation",
  );
  await page.getByRole("button", { name: "Choose this layout", exact: true }).click();
  await page.getByRole("button", { name: "Review choices" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download choices" }).click();
  check((await download).suggestedFilename() === "settings-design-choices.json", "Export");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await navigate("General");
  const light = await new AxeBuilder({ page }).analyze();
  check(
    !light.violations.some((v) => v.impact === "serious" || v.impact === "critical"),
    "Light a11y",
  );
  check(errors.length === 0, errors.join("\n"));
  console.log(
    JSON.stringify({
      layouts: 3,
      pages: 4,
      widths: [1440, 390],
      seriousAccessibilityViolations: 0,
      pageErrors: errors,
      interactions:
        "general, focused editor, Codex source/rename/device states, member role/search/add, API grant/create/revoke, choices/download, theme",
    }),
  );
} finally {
  await browser.close();
  server.stop(true);
}
