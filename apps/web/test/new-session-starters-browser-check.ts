import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { parseSync } from "oxc-parser";

// Parse approved data only. Never execute the preview or its resolver.
const sourcePath =
  process.env.STARTERS_APPROVED_SOURCE ?? "/workspace/approved-starters-source.json";
const bundle = await Bun.file(sourcePath).json();
const source = parseSync(
  "approved.ts",
  bundle.files.find((f: { path: string }) => f.path === "starters.ts").content,
);
const declaration = (source.program.body[0] as any).declaration.declarations[0];
const array = declaration.init.expression;
const approved = array.elements.map((element: any) =>
  Object.fromEntries(
    element.properties.map((property: any) => {
      assert(property.type === "Property" && typeof property.value.value === "string");
      return [property.key.name, property.value.value];
    }),
  ),
);
const out = `${import.meta.dirname}/new-session-starters-evidence`;
await mkdir(out, { recursive: true });
const base =
  process.env.STARTERS_QA_URL ?? "http://127.0.0.1:4317/test/new-session-starters-qa.html";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  args: ["--no-sandbox"],
});
const results: unknown[] = [];
try {
  for (const width of [1280, 390, 320])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 720 },
        hasTouch: width < 600,
        reducedMotion: "reduce",
      });
      const errors: string[] = [],
        external: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(base).origin) {
          external.push(url.origin);
          return route.abort();
        }
        return route.continue();
      });
      await page.addInitScript(() => {
        const original = HTMLElement.prototype.focus;
        Object.assign(window, { focusCalls: [] });
        HTMLElement.prototype.focus = function (options) {
          if (this.tagName === "TEXTAREA") (window as any).focusCalls.push(options ?? null);
          return original.call(this, options);
        };
      });
      await page.goto(`${base}?theme=${theme}`);
      const suggestions = page.getByRole("region", { name: "Starter suggestions" });
      const cards = suggestions.getByRole("button");
      const input = page.getByRole("textbox", { name: "Message the agent" });
      const owner = page.locator('[data-workspace-scroll-owner="self-managed"]');
      await cards.last().waitFor();
      await page.waitForFunction(() => !document.querySelector("textarea")?.disabled);
      assert.equal(await cards.count(), 6);
      assert.equal(await page.getByText(/^QA recent session \d$/).count(), 6);
      const sizes = await cards.evaluateAll((elements) =>
        elements.map((el) => {
          const box = el.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
          };
        }),
      );
      assert(
        sizes.every(
          (s) =>
            Math.abs(s.height - sizes[0]!.height) < 1 &&
            Math.abs(s.width - sizes[0]!.width) < 1 &&
            !s.clipped,
        ),
        JSON.stringify(sizes),
      );
      const iconSizes = await cards.evaluateAll((elements) =>
        elements.map((el) => el.querySelector("img,svg")!.getBoundingClientRect().width),
      );
      assert.deepEqual(iconSizes, [32, 32, 32, 20, 20, 20]);
      assert(
        await suggestions
          .locator("img")
          .evaluateAll((images) => images.every((img) => img.complete && img.naturalWidth > 0)),
      );
      assert(
        await page.evaluate(() => {
          const recent = [...document.querySelectorAll("h2")]
            .find((el) => el.textContent?.trim() === "Recent sessions")!
            .closest("section")!;
          return Boolean(
            recent.compareDocumentPosition(
              document.querySelector('[aria-label="Starter suggestions"]')!,
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      );
      const sizing = () =>
        input.evaluate((el) => ({
          height: el.getBoundingClientRect().height,
          line: parseFloat(getComputedStyle(el).lineHeight),
          padding:
            parseFloat(getComputedStyle(el).paddingTop) +
            parseFloat(getComputedStyle(el).paddingBottom),
        }));
      const initial = await sizing();
      assert(
        Math.abs(initial.height - (2 * initial.line + initial.padding)) <= 2,
        JSON.stringify(initial),
      );
      const controls = async () =>
        page
          .locator("button[aria-label]")
          .evaluateAll((elements) => elements.map((el) => el.getAttribute("aria-label")));
      const initialControls = await controls();
      for (const name of [
        "Project: Default",
        "More composer actions",
        "Model and effort",
        "Send message",
      ])
        assert(initialControls.includes(name));
      await page.screenshot({ path: `${out}/${width}-${theme}-top.png` });
      await page.mouse.move(width - 10, 350);
      await page.mouse.wheel(0, 10000);
      await page.waitForFunction(
        () => document.querySelector("[data-workspace-scroll-owner]")!.scrollTop > 0,
      );
      await page.waitForTimeout(150);
      const scrollTop = await owner.evaluate((el) => el.scrollTop);
      assert.equal(await page.evaluate(() => window.scrollY), 0);
      await page.screenshot({ path: `${out}/${width}-${theme}-bottom.png` });
      // Keyboard navigation targets the existing focusable scroll owner; no tabindex or CSS overrides.
      await owner.evaluate((el) => el.scrollTo(0, 0));
      await owner.focus();
      await page.keyboard.press("End");
      await page.waitForFunction(
        () => document.querySelector("[data-workspace-scroll-owner]")!.scrollTop > 0,
      );
      let touchScrolled = false;
      if (width < 600) {
        await owner.evaluate((el) => el.scrollTo(0, 0));
        const cdp = await page.context().newCDPSession(page);
        for (let swipe = 0; swipe < 4; swipe++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x: 8, y: 650 }],
          });
          for (const y of [550, 450, 350, 250, 150])
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: 8, y }],
            });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        }
        await page.waitForFunction(
          () => document.querySelector("[data-workspace-scroll-owner]")!.scrollTop > 0,
        );
        touchScrolled = true;
        await cdp.detach();
      }
      for (let index = 0; index < approved.length; index++) {
        const item = approved[index]!;
        assert((await cards.nth(index).innerText()).includes(item.title!));
        assert((await cards.nth(index).innerText()).includes(item.description!));
        await cards.nth(index).scrollIntoViewIfNeeded();
        const focusCount = await page.evaluate(() => (window as any).focusCalls.length);
        await cards.nth(index).click();
        assert.equal(await input.inputValue(), item.prompt);
        assert(await input.evaluate((el) => el === document.activeElement));
        assert.deepEqual(
          await page.evaluate((count) => (window as any).focusCalls.slice(count), focusCount),
          [{ preventScroll: true }],
        );
        assert.equal(await page.evaluate(() => (window as any).starterQa.sends.length), 0);
        assert.equal(await page.getByRole("dialog").count(), 0);
      }
      await input.fill("A natural wrapping custom draft. ".repeat(100));
      const long = await sizing();
      assert(long.height > initial.height && long.height <= 221, JSON.stringify(long));
      await input.fill("");
      assert.equal((await sizing()).height, initial.height);
      // Growth can move scrollTop through normal browser anchoring. Re-select the
      // same draft to isolate focus from autosizing and require exact stability.
      await input.fill("Short existing draft");
      await cards.nth(4).scrollIntoViewIfNeeded();
      const beforeFocusScroll = await owner.evaluate((el) => el.scrollTop);
      await cards.nth(4).click();
      const afterFocusScroll = await owner.evaluate((el) => el.scrollTop);
      assert(afterFocusScroll > 0, "Starter focus jumped to the composer");
      await cards.nth(4).click();
      assert.equal(await owner.evaluate((el) => el.scrollTop), afterFocusScroll);
      assert.deepEqual(await controls(), initialControls);
      await cards.nth(2).click();
      const edited = "Connect Notion and analyze my project notes. Do not change anything yet.";
      await input.fill(edited);
      if (theme === "light") await input.press("Enter");
      else await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.waitForFunction(() => (window as any).starterQa.sends.length === 1);
      const sends = await page.evaluate(() => (window as any).starterQa.sends);
      assert.equal(sends[0][1].text, edited);
      assert.equal(await owner.count(), 1);
      assert(await owner.evaluate((el) => el.scrollWidth <= el.clientWidth));
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      results.push({
        width,
        theme,
        sizes,
        iconSizes,
        initial,
        long,
        scrollTop,
        keyboardScrolled: true,
        touchScrolled,
        beforeFocusScroll,
        afterFocusScroll,
        initialControls,
        allSixExactDrafts: true,
        focusPreventScroll: true,
        editedSend: sends[0][1].text,
        errors,
        external,
      });
      await page.close();
    }
  await writeFile(`${out}/results.json`, JSON.stringify({ status: "passed", results }, null, 2));
  console.log(JSON.stringify({ status: "passed", cases: results.length, out }));
} finally {
  await browser.close();
}
