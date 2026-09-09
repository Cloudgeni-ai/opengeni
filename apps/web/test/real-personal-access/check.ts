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
  // Wait for the rendered frame we inspect, not an assumed machine speed.
  const waitForLayout = async (expectedWidth?: number) => {
    await page.waitForFunction(
      async (viewportWidth) => {
        if (
          document.fonts.status !== "loaded" ||
          (viewportWidth !== undefined && innerWidth !== viewportWidth)
        )
          return false;
        const footer = document.querySelector(".og-composer-footer");
        if (!footer || footer.getBoundingClientRect().width === 0) return false;
        const geometry = () =>
          JSON.stringify([
            document.documentElement.scrollWidth,
            ...Array.from(
              document.querySelectorAll(
                '.og-composer-footer, .og-composer-footer button, [data-testid="model-picker-menu"]',
              ),
              (element) => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return [x, y, width, height];
              },
            ),
          ]);
        const before = geometry();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return before === geometry();
      },
      expectedWidth,
      { timeout: 5_000, polling: "raf" },
    );
  };
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
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await send.waitFor();
  await waitForLayout();
  assert.equal(await page.locator("[data-personal-resource-attachment]").count(), 0);
  assert.equal(await page.getByRole("radio").count(), 0);
  await page.screenshot({ path: path.join(output, "implemented-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Test unavailable resource", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(await send.isDisabled(), true);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  assert.equal(await page.locator("[data-personal-resource-attachment]").count(), 0);
  await send.click();
  assert.equal(await send.isDisabled(), true);
  assert.equal(await page.locator("[data-personal-resource-attachment]").count(), 0);
  await page.getByRole("button", { name: "Model and effort", exact: true }).click();
  await page.getByTestId("model-picker-menu").waitFor({ state: "visible" });
  await waitForLayout();
  await page.screenshot({ path: path.join(output, "model-picker.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Session tools", exact: true }).click();
  await page.getByRole("menu").waitFor();
  await page.keyboard.press("Escape");
  for (const width of [640, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await waitForLayout(width);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `overflow at ${width}`,
    );
    const buttons = await page.locator(".og-composer-footer button:visible").all();
    const boxes = await Promise.all(buttons.map((button) => button.boundingBox()));
    for (const [index, box] of boxes.entries()) {
      if (!box) continue;
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
      for (const other of boxes.slice(index + 1)) {
        if (!other) continue;
        const overlap: boolean =
          Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x) > 1 &&
          Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y) > 1;
        assert.equal(overlap, false, `overlapping controls at ${width}`);
      }
    }
    if (width === 375)
      await page.screenshot({ path: path.join(output, "implemented-mobile.png"), fullPage: true });
  }
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.ogTheme === "dark");
  await waitForLayout();
  await page.screenshot({ path: path.join(output, "implemented-mobile-dark.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  console.log(
    "PASS: actual components, menus, simulated send, unavailable/retry, mobile layout, light/dark, no storage, no network, no browser errors",
  );
} finally {
  await browser.close();
  server.stop(true);
}
