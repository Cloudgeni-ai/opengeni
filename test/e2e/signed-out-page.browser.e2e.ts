import AxeBuilder from "@axe-core/playwright";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { freePort, startProcess, type StartedProcess } from "@opengeni/testing";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

describe("signed-out homepage on the real app route", () => {
  let browser: Browser;
  let web: StartedProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    web = await startProcess(
      [
        "bun",
        "run",
        "vite",
        process.env.OPENGENI_SIGNED_OUT_TEST_BUILT === "1" ? "preview" : "dev",
        ".",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: `${new URL("../..", import.meta.url).pathname}/apps/web`,
        env: { VITE_API_BASE_URL: "" },
        ready: async () =>
          (await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) }).catch(() => null))?.ok ===
          true,
        timeoutMs: 45_000,
      },
    );
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([browser?.close(), web?.stop()]);
  }, 30_000);

  async function installApi(context: BrowserContext, mode: "legacy" | "broker") {
    const posts: string[] = [];
    await context.route("**/v1/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST") posts.push(pathname);
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          headers: { "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION },
          body: JSON.stringify(body),
        });
      if (pathname === "/v1/config/client")
        return json({
          apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
          defaultModel: "gpt-5.6-sol",
          allowedModels: ["gpt-5.6-sol"],
          models: [],
          defaultReasoningEffort: "low",
          allowedReasoningEfforts: ["low"],
          mcpServers: [],
          fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
          productAccessMode: "managed",
          managedAuthSessionSetMode: mode,
          auth: {
            mode: "managedSession",
            socialProviders: ["google", "github"],
            emailVerificationRequired: true,
          },
          structuredServices: { fileSystem: false, git: false, terminalEvents: false },
        });
      if (pathname === "/v1/auth/get-session") return json(null);
      if (pathname === "/v1/auth/session-set")
        return json({
          mode: "broker",
          generation: "1",
          actorEpoch: "1",
          csrfToken: "c".repeat(43),
          selectedSlotId: null,
          state: "ready",
          slots: [],
        });
      if (pathname === "/v1/auth/session-set/transactions" && request.method() === "POST")
        return json({
          id: "00000000-0000-4000-8000-000000000001",
          kind: "add",
          returnIntentId: null,
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      if (
        pathname === "/v1/auth/sign-in/social" ||
        pathname === "/v1/auth/session-set/transactions/social"
      ) {
        return json({ message: "Test provider unavailable" }, 503);
      }
      if (pathname === "/v1/auth/request-password-reset") return json({ status: true });
      return json({ message: `Unexpected test request: ${pathname}` }, 404);
    });
    return posts;
  }

  async function chooseTheme(page: Page, theme: "Light" | "Dark" | "System") {
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("menuitemradio", { name: theme, exact: true }).click();
    await page.keyboard.press("Escape");
    if (theme !== "System")
      await page.waitForFunction(
        (value) => document.documentElement.dataset.ogTheme === value,
        theme.toLowerCase(),
      );
  }

  test("approved layout, appearance, social actions and recovery survive desktop/mobile", async () => {
    const context = await browser.newContext();
    try {
      const posts = await installApi(context, "legacy");
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(baseUrl);
      await page.getByRole("heading", { name: "Open-source cloud agents" }).waitFor();
      expect(await page.locator("h1").count()).toBe(1);
      expect(await page.locator("main ul li").count()).toBe(3);
      expect(await page.getByRole("button", { name: "Continue with Google" }).isVisible()).toBe(
        true,
      );
      expect(await page.getByRole("button", { name: "Continue with GitHub" }).isVisible()).toBe(
        true,
      );
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ["Light", "Dark"] as const) {
          await chooseTheme(page, theme);
          const submit = page.locator('button[type="submit"]');
          await submit.scrollIntoViewIfNeeded();
          const box = (await submit.boundingBox())!;
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(900);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          const accessibility = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa"])
            .analyze();
          expect(accessibility.violations).toEqual([]);
          await page.screenshot({ path: `/tmp/opengeni-signed-out-${width}-${theme}.png` });
        }
      }
      await chooseTheme(page, "System");
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForFunction(() => document.documentElement.dataset.ogTheme === "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => document.documentElement.dataset.ogTheme === "dark");
      for (const provider of ["Google", "GitHub"]) {
        await page.getByRole("button", { name: `Continue with ${provider}` }).click();
        await page
          .getByText(`Couldn't continue with ${provider}. Try again.`, { exact: true })
          .waitFor();
      }
      expect(posts.filter((path) => path === "/v1/auth/sign-in/social")).toHaveLength(2);
      await page.getByRole("button", { name: "Forgot password?" }).click();
      expect(await page.getByRole("button", { name: "Continue with Google" }).count()).toBe(0);
      await page.getByLabel("Email", { exact: true }).fill("member@example.test");
      await page.getByRole("button", { name: "Send reset link" }).click();
      await page.getByText("Check your email", { exact: true }).waitFor();
      expect(posts).toContain("/v1/auth/request-password-reset");
      await page.goto(`${baseUrl}/reset-password`);
      await page.getByRole("heading", { name: "Reset password", exact: true }).waitFor();
      expect(await page.getByRole("heading", { name: "Open-source cloud agents" }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  test("broker registration stays embedded and social providers remain in the isolated popup", async () => {
    const context = await browser.newContext();
    try {
      await installApi(context, "broker");
      const page = await context.newPage();
      await page.goto(baseUrl);
      await page.getByRole("button", { name: "Continue with email", exact: true }).waitFor();
      expect(await page.locator("h1").count()).toBe(1);
      await page.getByRole("button", { name: "Create an account", exact: true }).click();
      await page.getByLabel("Name", { exact: true }).waitFor();
      expect(await page.getByRole("heading", { name: "Open-source cloud agents" }).count()).toBe(1);
      await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
      const popupPromise = page.waitForEvent("popup");
      await page.getByRole("button", { name: "Continue with email", exact: true }).click();
      const popup = await popupPromise;
      await popup.getByRole("button", { name: "Continue with Google" }).waitFor();
      expect(await popup.getByRole("button", { name: "Continue with GitHub" }).isVisible()).toBe(
        true,
      );
      expect(await popup.getByRole("heading", { name: "Open-source cloud agents" }).count()).toBe(
        0,
      );
      expect(await page.getByRole("heading", { name: "Open-source cloud agents" }).count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 45_000);
});
