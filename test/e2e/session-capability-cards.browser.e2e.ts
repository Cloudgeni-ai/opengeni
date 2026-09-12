import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
const fixturePath = "/test/session-capability-cards.html";
const evidenceDir = new URL("../../.agent/evidence/session-capability-cards/", import.meta.url)
  .pathname;
const scenarios = [
  {
    id: "oauth",
    name: "PostHog",
    open: "Connect PostHog",
    submit: "Continue authorization",
    action: "oauth",
  },
  {
    id: "api-key",
    name: "Example API",
    open: "Add API key",
    submit: "Verify & connect",
    action: "api_key",
  },
  {
    id: "skill",
    name: "Writing style",
    open: "Review skill",
    submit: "Install & use",
    action: "install_skill",
  },
] as const;

describe("session capability preview parity in Chromium", () => {
  let browser: Browser;
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await mkdir(evidenceDir, { recursive: true });
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        "dev",
        ".",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${repoRoot}/apps/web`,
        ready: async () =>
          (
            await fetch(`${baseUrl}${fixturePath}`, { signal: AbortSignal.timeout(2_000) }).catch(
              () => null,
            )
          )?.ok === true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch(
      existsSync("/usr/local/bin/chromium")
        ? { executablePath: "/usr/local/bin/chromium" }
        : undefined,
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  for (const width of [1280, 390, 320]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${theme} ${width}px: actual components and explicit state transitions`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
          hasTouch: width < 600,
          isMobile: width < 600,
        });
        const page = await context.newPage();
        const errors: string[] = [];
        const externalRequests: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", async (route) => {
          if (new URL(route.request().url()).origin !== baseUrl) {
            externalRequests.push(route.request().url());
            await route.abort();
          } else await route.continue();
        });
        try {
          await page.goto(`${baseUrl}${fixturePath}?theme=${theme}`, { waitUntil: "networkidle" });
          await page
            .getByRole("heading", { name: "Session capability cards", exact: true })
            .waitFor();
          const headers = new Map<string, string>();
          for (const scenario of scenarios) {
            const card = page.getByRole("region", { name: `${scenario.name} setup` });
            headers.set(scenario.id, await card.locator(":scope > div").first().innerText());
            await assertBounds(page, card, width);
            const note = (await card
              .getByText(
                scenario.id === "skill"
                  ? "Guidance only · no account access"
                  : "You choose what to authorize",
                { exact: true },
              )
              .boundingBox())!;
            const action = (await card
              .getByRole("button", { name: scenario.open, exact: true })
              .boundingBox())!;
            expect(
              width > 600
                ? Math.abs(note.y + note.height / 2 - action.y - action.height / 2)
                : Math.abs(action.y - note.y - note.height - 6),
            ).toBeLessThanOrEqual(1);
            if (scenario.id === "skill") {
              expect(
                await card
                  .locator(":scope > div")
                  .first()
                  .locator('[aria-hidden="true"]')
                  .first()
                  .innerText(),
              ).toBe("W");
              expect(await card.locator("img").count()).toBe(0);
            }
          }
          await page.screenshot({
            path: `${evidenceDir}${theme}-${width}-suggested.png`,
            fullPage: true,
          });
          expect(
            (await new AxeBuilder({ page }).include('[data-testid$="-fixture"] section').analyze())
              .violations,
          ).toEqual([]);
          for (const scenario of scenarios) {
            const fixture = page.getByTestId(`${scenario.id}-fixture`);
            const card = page.getByRole("region", { name: `${scenario.name} setup` });
            const opener = card.getByRole("button", { name: scenario.open, exact: true });
            const assertHeader = async () => {
              expect(
                await card.getByRole("heading", { name: scenario.name, exact: true }).count(),
              ).toBe(1);
              expect(await card.locator(":scope > div").first().innerText()).toBe(
                headers.get(scenario.id)!,
              );
            };
            await opener.focus();
            await page.keyboard.press("Enter");
            await card.getByRole("button", { name: scenario.submit, exact: true }).waitFor();
            await assertHeader();
            await assertBounds(page, card, width);
            await page.screenshot({
              path: `${evidenceDir}${theme}-${width}-${scenario.id}-expanded.png`,
              fullPage: true,
            });
            await card.getByRole("button", { name: "Cancel", exact: true }).click();
            await page.waitForFunction(
              (label) => document.activeElement?.textContent?.trim() === label,
              scenario.open,
            );
            await opener.press("Enter");
            if (scenario.id === "api-key") {
              const workspaceChoice = card.getByRole("radio", { name: "Workspace", exact: true });
              await workspaceChoice.focus();
              await page.keyboard.press("ArrowRight");
              expect(
                await card.getByRole("radio", { name: "Only me", exact: true }).isChecked(),
              ).toBe(true);
              await page.keyboard.press("ArrowLeft");
              expect(await workspaceChoice.isChecked()).toBe(true);
              expect(
                await card.getByRole("button", { name: scenario.submit, exact: true }).isDisabled(),
              ).toBe(true);
              await card.locator('input[type="password"]').fill("fixture-only-not-a-real-secret");
            }
            if (scenario.id === "skill") {
              await card
                .getByText(
                  "This library skill can currently be installed for the workspace only.",
                  { exact: true },
                )
                .waitFor();
              expect(await card.getByRole("radio").count()).toBe(0);
            }
            await card.getByRole("button", { name: scenario.submit, exact: true }).press("Enter");
            await expectReceipt(page, scenario.id, {
              action: scenario.action,
              attempts: 1,
              ownership: "workspace",
              busy: true,
              complete: false,
            });
            expect(
              await card.getByRole("button", { name: "Cancel", exact: true }).isDisabled(),
            ).toBe(true);
            await fixture.getByRole("button", { name: "Fixture fail", exact: true }).click();
            await card
              .getByText("Fixture provider rejected this attempt. Review your input and retry.", {
                exact: true,
              })
              .waitFor();
            await assertHeader();
            await assertBounds(page, card, width);
            await page.screenshot({
              path: `${evidenceDir}${theme}-${width}-${scenario.id}-error.png`,
              fullPage: true,
            });
            await card.getByRole("button", { name: scenario.submit, exact: true }).press("Enter");
            await expectReceipt(page, scenario.id, { attempts: 2, busy: true, complete: false });
            await fixture.getByRole("button", { name: "Fixture succeed", exact: true }).click();
            await card.getByRole("status").waitFor();
            await page.waitForFunction(
              (name) => document.activeElement?.getAttribute("aria-label") === `${name} setup`,
              scenario.name,
            );
            await assertHeader();
            await assertBounds(page, card, width);
            expect(await card.getByRole("button").count()).toBe(0);
            expect(await card.locator('input[type="password"]').count()).toBe(0);
            await page.screenshot({
              path: `${evidenceDir}${theme}-${width}-${scenario.id}-complete.png`,
              fullPage: true,
            });
          }
          expect(
            await page.evaluate(() => ({
              local: localStorage.length,
              session: sessionStorage.length,
            })),
          ).toEqual({ local: 0, session: 0 });
          expect(externalRequests).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }, 90_000);
    }
  }
});

async function assertBounds(page: Page, card: Locator, viewportWidth: number) {
  const box = (await card.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(540);
  if (viewportWidth === 1280) expect(box.width).toBe(540);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
  expect(
    await card.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

async function expectReceipt(page: Page, id: string, expected: Record<string, unknown>) {
  await page.waitForFunction(
    ({ id: scenarioId, expected: expectedReceipt }) => {
      const text = document.querySelector(`[data-testid="${scenarioId}-receipt"]`)?.textContent;
      if (!text) return false;
      const receipt = JSON.parse(text);
      return Object.entries(expectedReceipt).every(([key, value]) => receipt[key] === value);
    },
    { id, expected },
  );
}
