import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Real Models page and production connect components, with synthetic auth only.
// Run with models-page-preview.vite.config.ts. No requests reach Claude.
const base = `${process.env.OPENGENI_MODELS_PREVIEW_URL ?? "http://127.0.0.1:4297"}/test/fixtures/models-page-preview/`;
const output = process.env.OPENGENI_MODELS_PREVIEW_OUTPUT ?? "/tmp/claude-connect-preview";
const before = process.env.OPENGENI_CLAUDE_BEFORE === "1";
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
await mkdir(output, { recursive: true });
let browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const log: string[] = [];

  async function buttons(page: Page) {
    return page.evaluate(() =>
      [...document.querySelectorAll("main button, main a[role=button], main a[href^='https']")]
        .filter((el) => (el as HTMLElement).offsetParent)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${(el.textContent ?? "").trim().slice(0, 40)}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}${(el as HTMLButtonElement).disabled ? " disabled" : ""}`;
        }),
    );
  }

  for (const [width, theme] of [
    [1100, "light"],
    [1100, "dark"],
    [390, "light"],
    [390, "dark"],
    // Either side of where the footer stacks: three actions must not wrap the primary.
    [430, "light"],
    [520, "dark"],
  ] as const) {
    for (const flow of ["org", "workspace"] as const) {
      if (
        process.env.OPENGENI_PREVIEW_CASE &&
        process.env.OPENGENI_PREVIEW_CASE !== `${flow}-${width}-${theme}`
      )
        continue;
      const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
      await ctx.route("https://claude.com/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Claude sign-in (preview stub)</h1>" }),
      );
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
        console.error(`${flow}-${width}-${theme}: ${error.stack}`);
      });
      let n = 0;
      const tag = `${flow}-${width}-${theme}`;
      const primary = page.locator('button[type="submit"]');
      // Account for Playwright scrolling the page to reach a control.
      const primaryPosition = () =>
        primary.evaluate((el) => ({
          top: el.getBoundingClientRect().top + scrollY,
          left: el.getBoundingClientRect().left,
          width: el.getBoundingClientRect().width,
        }));
      const shot = async (name: string) => {
        n += 1;
        await page.waitForTimeout(250);
        await page.screenshot({
          path: `${output}/${tag}-${String(n).padStart(2, "0")}-${name}.png`,
          fullPage: true,
        });
        log.push(`${tag} ${name}: ${(await buttons(page)).join(" | ")}`);
        assert(
          !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
          `${tag}: horizontal overflow in ${name}`,
        );
      };
      const view =
        flow === "org" ? "connect-org:claude_subscription" : "connect:claude_subscription";
      const open = (extra = "") =>
        page.goto(`${base}?claude=1&theme=${theme}&view=${view}${extra}`, {
          waitUntil: "networkidle",
        });
      await open("&slow=1");
      await page.getByRole("heading", { name: /Connect Claude/ }).waitFor();
      await shot("open");
      // The choice above the sign-in.
      const choice = flow === "org" ? /Only selected workspaces/ : /Only me/;
      await page.getByText(choice).first().click();
      if (flow === "org") await page.getByLabel("Design").first().check();
      await shot("choice");
      // The setup-token disclosure.
      if (before) await page.getByText("Use a setup token").click();
      else
        await page
          .locator('[data-slot="segmented-control-item"]')
          .filter({ hasText: "Setup token" })
          .click();
      await shot("token-open");
      if (before) await page.getByText("Use a setup token").click();
      else
        await page
          .locator('[data-slot="segmented-control-item"]')
          .filter({ hasText: "Browser" })
          .click();
      await shot("token-closed");
      const initialPosition = before ? undefined : await primaryPosition();
      // Start sign-in: a popup opens on the (stubbed) Claude page.
      const popup = page.waitForEvent("popup");
      await page.getByRole("button", { name: /Sign in to Claude|Continue/ }).click();
      const authWindow = await popup;
      await shot("starting-sign-in");
      await page.getByRole("button", { name: "Complete sign-in", exact: true }).waitFor();
      await authWindow.close();
      await page.getByLabel(/authorization code/i).waitFor({ state: "visible" });
      const stable = async () => (before ? undefined : primaryPosition());
      const waitingPosition = await stable();
      assert(
        JSON.stringify(waitingPosition) === JSON.stringify(initialPosition),
        `${tag}: action moved when sign-in started: ${JSON.stringify(waitingPosition)} vs ${JSON.stringify(initialPosition)}`,
      );
      const assertStable = async (step: string) => {
        if (before) return;
        const position = await stable();
        assert(
          JSON.stringify(position) === JSON.stringify(waitingPosition),
          `${tag}: action moved during ${step}: ${JSON.stringify(position)} vs ${JSON.stringify(waitingPosition)}`,
        );
      };
      await shot("waiting-for-code");
      await page.getByLabel(/authorization code/i).fill("pasted-wrong-code");
      await shot("code-pasted");
      await assertStable("paste");
      await page
        .getByRole("button", { name: /Complete sign-in|Connect/ })
        .last()
        .click();
      await page.waitForTimeout(400);
      await shot("submitting");
      await assertStable("submitting");
      await page.waitForTimeout(1600);
      await shot("error");
      await assertStable("error");
      // Cancel the attempt.
      await page.getByRole("button", { name: /Start again|Start over/ }).click();
      await shot("start-again");
      if (!before) {
        assert((await page.locator('[role="alert"]').count()) === 0, "reset clears the old error");
        await assertStable("reset");
      }
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await shot("cancel");
      await open("&slow=1");
      await page.getByRole("heading", { name: /Connect Claude/ }).waitFor();
      // Success.
      const popup2 = page.waitForEvent("popup");
      await page.getByRole("button", { name: /Sign in to Claude|Continue/ }).click();
      const authWindow2 = await popup2;
      await page.getByRole("button", { name: "Complete sign-in", exact: true }).waitFor();
      await authWindow2.close();
      await page.getByLabel(/authorization code/i).fill("preview-code");
      await page
        .getByRole("button", { name: /Complete sign-in|Connect/ })
        .last()
        .click();
      await page.waitForTimeout(2500);
      await shot("success");
      assert(
        (await page.getByRole("heading", { name: "ada.claude@acme.example" }).count()) === 1,
        `${tag}: saved account opens after success`,
      );
      assert(errors.length === 0, `${tag}: page errors ${errors.join("; ")}`);
      await ctx.close();
      await browser.close();
      browser = await chromium.launch({ args: ["--no-sandbox"] });
    }
  }
  console.log(log.join("\n"));
} catch (error) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      console.error(
        "Failed page",
        page.url(),
        (await page.locator("body").innerText()).slice(0, 1200),
      );
      await page.screenshot({ path: `${output}/failure.png`, fullPage: true });
    }
  }
  throw error;
} finally {
  await browser.close();
}
