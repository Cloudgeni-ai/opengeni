import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const output = resolve(import.meta.dirname, "../dist-settings-preview");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(Bun.file(resolve(output, "index.html"))),
});
const browser = await chromium.launch({ headless: true });
const failures: string[] = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("pageerror", (error) => failures.push(error.message));
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
try {
  await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "General", exact: true }).waitFor();
  const accessibility = await new AxeBuilder({ page }).analyze();
  check(
    accessibility.violations.filter(
      (issue) => issue.impact === "serious" || issue.impact === "critical",
    ).length === 0,
    `Accessibility violations: ${accessibility.violations.map((issue) => issue.id).join(", ")}`,
  );
  await mkdir(resolve(output, "qa"), { recursive: true });
  await page.screenshot({ path: resolve(output, "qa/desktop-general.png") });
  const voice = page.getByRole("switch", { name: "Voice input", exact: true });
  await voice.click();
  check((await voice.getAttribute("aria-checked")) === "false", "Voice toggle did not update");
  await page.getByLabel("Workspace name", { exact: true }).fill("Preview team");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Members", exact: true })
    .click();
  await page.getByRole("searchbox").fill("Jordan");
  check(
    (await page.getByText("Jordan Lee", { exact: true }).count()) === 1,
    "Search did not retain matching row",
  );
  check(
    (await page.getByText("Alex Morgan", { exact: true }).count()) === 0,
    "Search did not filter other rows",
  );
  await page.getByRole("searchbox").fill("no-match");
  await page.getByText("No matching results", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("button", { name: "Invite person", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("Name", { exact: true }).fill("Taylor Chen");
  await page.getByRole("button", { name: "Add to preview", exact: true }).click();
  await page.getByText("Taylor Chen", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Actions for Taylor Chen", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove from preview", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove from preview", exact: true })
    .click();
  check(
    (await page.getByText("Taylor Chen", { exact: true }).count()) === 0,
    "Removal did not update preview",
  );
  await page.screenshot({ path: resolve(output, "qa/desktop-members.png") });
  let routeChecks = 0;
  for (const scope of ["workspace", "organization", "personal", "patterns"]) {
    await page.getByLabel("Settings scope", { exact: true }).selectOption(scope);
    const names = await page
      .getByRole("navigation", { name: "Settings pages" })
      .getByRole("button")
      .allTextContents();
    for (const name of names) {
      await page
        .getByRole("navigation", { name: "Settings pages" })
        .getByRole("button", { name, exact: true })
        .click();
      await page.getByRole("heading", { name, exact: true, level: 1 }).waitFor();
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `Desktop overflow: ${scope}/${name}`,
      );
      routeChecks++;
    }
  }
  await page.getByRole("tab", { name: "Error", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("searchbox").waitFor();
  await page.screenshot({ path: resolve(output, "qa/desktop-patterns.png") });
  await page.getByRole("button", { name: "Light appearance", exact: true }).click();
  await page.screenshot({ path: resolve(output, "qa/light-patterns.png") });
  await page.getByRole("button", { name: "Dark appearance", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open settings navigation", exact: true }).click();
  await page.getByLabel("Settings scope", { exact: true }).selectOption("workspace");
  await page.getByRole("heading", { name: "General", exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, "qa/mobile-general.png") });
  for (const name of ["Members", "Models", "Agent learning", "Capabilities", "Danger zone"]) {
    await page.getByRole("button", { name: "Open settings navigation", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings pages" })
      .getByRole("button", { name, exact: true })
      .click();
    await page.getByRole("heading", { name, exact: true, level: 1 }).waitFor();
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `Mobile overflow: ${name}`,
    );
  }
  await page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: resolve(output, "qa/mobile-dialog.png") });
  await page.keyboard.press("Escape");
  check((await page.getByRole("dialog").count()) === 0, "Escape did not dismiss dialog");
  check(failures.length === 0, `Browser errors: ${failures.join("; ")}`);
  console.log(
    JSON.stringify({
      desktopRoutes: routeChecks,
      mobileRoutes: 6,
      interactions:
        "toggle, save, search, empty, clear, add, menu, remove, tabs, retry, theme, navigation, dialog, Escape",
      consoleErrors: failures,
    }),
  );
} finally {
  await browser.close();
  server.stop(true);
}
