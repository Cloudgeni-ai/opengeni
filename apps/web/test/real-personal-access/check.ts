import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import path from "node:path";

const output = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "dist"));
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(Bun.file(path.join(output, "index.html"))),
});
const browser = await chromium.launch({
  executablePath: process.env.PREVIEW_CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  const network: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith(server.url.origin) && !request.url().startsWith("data:"))
      network.push(request.url());
  });
  await page.addInitScript(() => {
    for (const key of ["localStorage", "sessionStorage"])
      Object.defineProperty(window, key, {
        get() {
          throw new DOMException("Storage unavailable", "SecurityError");
        },
      });
  });
  await page.goto(server.url.toString());
  await page.getByRole("button", { name: "Proposed change", exact: true }).waitFor();
  await page.waitForTimeout(600); // Let the production layout animations settle before screenshots.
  await page.screenshot({ path: path.join(output, "current-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Proposed change", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(output, "proposed-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Personal access", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Ongoing work in this chat" }).click();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Ongoing access enabled" }).waitFor();
  assert.match(
    await page.getByRole("button", { name: "Personal access", exact: true }).innerText(),
    /Ongoing/,
  );
  assert.equal(
    await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Model and effort", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(output, "model-picker.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Session tools", exact: true }).click();
  await page.getByRole("menu").waitFor();
  await page.keyboard.press("Escape");
  for (const width of [640, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(600);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `overflow at ${width}`,
    );
    const access = await page
      .getByRole("button", { name: "Personal access", exact: true })
      .boundingBox();
    const send = await page
      .getByRole("button", { name: "Send message", exact: true })
      .boundingBox();
    assert.ok(
      access && send && (access.x + access.width <= send.x || access.y + access.height <= send.y),
      `overlap at ${width}`,
    );
    await page.getByRole("button", { name: "Personal access", exact: true }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const bounds = await menu.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
    await page.keyboard.press("Escape");
    if (width === 375)
      await page.screenshot({ path: path.join(output, "proposed-mobile.png"), fullPage: true });
  }
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(output, "proposed-mobile-dark.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  console.log(
    "PASS: real components, menus, simulated send, mobile layout, light/dark, no storage, no network, no browser errors",
  );
} finally {
  await browser.close();
  server.stop(true);
}
