import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

const compiledCss = await readFile(
  new URL("../../packages/react/styles/compiled.css", import.meta.url),
  "utf8",
);

describe("@opengeni/react compiled CSS in Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(`
      <style>${compiledCss}</style>
      <div class="og-root" id="standalone">
        <div class="-translate-x-1/2" id="transform"></div>
        <div class="-translate-x-1/2" id="transform-parent">
          <div id="transform-child"></div>
        </div>
        <div class="shadow-lg" id="shadow"></div>
        <div class="ring-2 ring-og-accent" id="ring"></div>
        <div class="blur" id="blur"></div>
        <div class="border border-og-border" id="border"></div>
        <div class="bg-og-bg text-og-menu" id="defaults"></div>
      </div>
      <div style="--og-color-bg: rgb(1, 2, 3); --og-font-size-menu: 22px">
        <div class="og-root bg-og-bg text-og-menu" id="host-themed"></div>
      </div>
      <div data-og-theme="light" style="--og-color-bg: rgb(4, 5, 6); --og-color-accent-soft: rgb(11, 12, 13)">
        <div class="og-root bg-og-bg" id="ancestor-theme-override"></div>
        <div class="og-root bg-og-accent-soft" id="ancestor-derived-override"></div>
      </div>
      <div data-og-density="compact" style="--og-font-size-menu: 23px">
        <div class="og-root text-og-menu" id="ancestor-density-override"></div>
      </div>
      <div class="og-root bg-og-bg" data-og-theme="light" id="root-theme-override" style="--og-color-bg: rgb(7, 8, 9)"></div>
      <div class="og-root text-og-menu" data-og-density="compact" id="root-density-override" style="--og-font-size-menu: 24px"></div>
      <div
        class="og-root"
        id="derived-root"
        style="--og-color-accent: rgb(10, 20, 30); --og-radius-lg: 17px; --og-motion-inspect-scale: 1; --og-color-surface-2: rgb(40, 50, 60)"
      >
        <div class="bg-og-accent-soft" id="derived-accent"></div>
        <div class="animate-og-enter" id="derived-motion"></div>
        <div
          id="derived-chrome"
          style="border-radius: var(--_og-session-chrome-radius); background: var(--_og-session-chrome-surface)"
        ></div>
      </div>
      <div class="border blur shadow-lg" id="outside"></div>
    `);
  });

  afterAll(async () => {
    await browser?.close();
  });

  test("transform, shadow, ring, blur, and border utilities keep valid computed styles", async () => {
    const styles = await page.evaluate(() => {
      const computed = (id: string) => getComputedStyle(document.getElementById(id)!);
      return {
        transform: computed("transform").translate,
        childTranslateVariable: computed("transform-child").getPropertyValue("--tw-translate-x"),
        shadow: computed("shadow").boxShadow,
        ring: computed("ring").boxShadow,
        blur: computed("blur").filter,
        borderStyle: computed("border").borderTopStyle,
        borderWidth: computed("border").borderTopWidth,
      };
    });

    expect(styles.transform).not.toBe("none");
    expect(styles.childTranslateVariable.trim()).toBe("0");
    expect(styles.shadow).not.toBe("none");
    expect(styles.ring).not.toBe("none");
    expect(styles.blur).toContain("blur(8px)");
    expect(styles.borderStyle).toBe("solid");
    expect(styles.borderWidth).toBe("1px");
  });

  test("package defaults apply while inherited host tokens remain authoritative", async () => {
    const styles = await page.evaluate(() => {
      const defaults = getComputedStyle(document.getElementById("defaults")!);
      const themed = getComputedStyle(document.getElementById("host-themed")!);
      const outside = getComputedStyle(document.getElementById("outside")!);
      return {
        defaultBackground: defaults.backgroundColor,
        defaultFontSize: defaults.fontSize,
        defaultToken: defaults.getPropertyValue("--og-color-bg"),
        themedBackground: themed.backgroundColor,
        themedFontSize: themed.fontSize,
        ancestorTheme: getComputedStyle(document.getElementById("ancestor-theme-override")!)
          .backgroundColor,
        ancestorThemeColorScheme: getComputedStyle(
          document.getElementById("ancestor-theme-override")!,
        ).colorScheme,
        ancestorDerived: getComputedStyle(document.getElementById("ancestor-derived-override")!)
          .backgroundColor,
        ancestorDensity: getComputedStyle(document.getElementById("ancestor-density-override")!)
          .fontSize,
        rootTheme: getComputedStyle(document.getElementById("root-theme-override")!)
          .backgroundColor,
        rootDensity: getComputedStyle(document.getElementById("root-density-override")!).fontSize,
        outsideBorder: outside.borderTopWidth,
        outsideFilter: outside.filter,
        outsideShadow: outside.boxShadow,
      };
    });

    expect(styles.defaultToken.trim()).toBe("oklch(0.155 0.012 260)");
    expect(styles.defaultBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(styles.defaultFontSize).toBe("14px");
    expect(styles.themedBackground).toBe("rgb(1, 2, 3)");
    expect(styles.themedFontSize).toBe("22px");
    expect(styles.ancestorTheme).toBe("rgb(4, 5, 6)");
    expect(styles.ancestorThemeColorScheme).toBe("light");
    expect(styles.ancestorDerived).toBe("rgb(11, 12, 13)");
    expect(styles.ancestorDensity).toBe("23px");
    expect(styles.rootTheme).toBe("rgb(7, 8, 9)");
    expect(styles.rootDensity).toBe("24px");
    expect(styles.outsideBorder).toBe("0px");
    expect(styles.outsideFilter).toBe("none");
    expect(styles.outsideShadow).toBe("none");
  });

  test("accent, radius, motion, and surface derivations stay live", async () => {
    const readDerived = () =>
      page.evaluate(() => {
        const accent = getComputedStyle(document.getElementById("derived-accent")!);
        const motion = getComputedStyle(document.getElementById("derived-motion")!);
        const chrome = getComputedStyle(document.getElementById("derived-chrome")!);
        return {
          accent: accent.backgroundColor,
          radius: chrome.borderRadius,
          motion: motion.animationDuration,
          surface: chrome.backgroundColor,
        };
      });

    const before = await readDerived();
    await page.evaluate(() => {
      const root = document.getElementById("derived-root")!;
      root.style.setProperty("--og-color-accent", "rgb(100, 110, 120)");
      root.style.setProperty("--og-radius-lg", "31px");
      root.style.setProperty("--og-motion-inspect-scale", "2");
      root.style.setProperty("--og-color-surface-2", "rgb(130, 140, 150)");
    });
    const after = await readDerived();

    expect(after.accent).not.toBe(before.accent);
    expect(after.radius).toBe("31px");
    expect(after.motion).toBe("0.36s");
    expect(after.surface).not.toBe(before.surface);
  });
});
