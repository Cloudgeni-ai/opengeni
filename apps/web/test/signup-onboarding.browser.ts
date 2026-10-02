import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// Drives the production post-signup onboarding (signup-onboarding-fixture.tsx)
// through both paths at 1440 and 390 wide, light and dark: accessibility,
// no horizontal overflow, no browser errors, the exact requests sent, and a
// coding-agent prompt that never carries the key.
// Start `apps/web/node_modules/.bin/vite --config apps/web/test/signup-onboarding.vite.config.ts`
// first. OPENGENI_SIGNUP_ONBOARDING_OUTPUT saves a screenshot of every step,
// and OPENGENI_SIGNUP_ONBOARDING_VIDEO a desktop recording of the embed path.
const output = process.env.OPENGENI_SIGNUP_ONBOARDING_OUTPUT;
const video = process.env.OPENGENI_SIGNUP_ONBOARDING_VIDEO;
const baseUrl = process.env.OPENGENI_SIGNUP_ONBOARDING_URL ?? "http://127.0.0.1:4341";
const KEY = "ogk_Fx7qK2_preview-only-not-a-real-key-9d3c1a";
if (output) await mkdir(output, { recursive: true });
if (video) await mkdir(video, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.OPENGENI_SIGNUP_ONBOARDING_CHROMIUM
    ? { executablePath: process.env.OPENGENI_SIGNUP_ONBOARDING_CHROMIUM }
    : {}),
  args: ["--no-sandbox"],
});

type Theme = "light" | "dark";

/** Human pace for the recording; no wait otherwise. */
async function pace(page: Page, ms = 1_200) {
  if (video) await page.waitForTimeout(ms);
}

async function check(page: Page, name: string, theme: Theme, width: number) {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  if (axe.violations.length) {
    throw new Error(`${name} ${theme} ${width}: ${JSON.stringify(axe.violations, null, 1)}`);
  }
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    throw new Error(`${name} ${theme} ${width}: horizontal overflow`);
  }
  if (output) await shoot(page, `${output}/${name}-${theme}-${width}.png`);
}

/** The whole step: onboarding scrolls inside its own pane, so grow the viewport to fit it. */
async function shoot(page: Page, path: string) {
  const viewport = page.viewportSize()!;
  await page.mouse.move(0, 0);
  const height = await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollHeight,
      ...Array.from(document.querySelectorAll<HTMLElement>("main, main *"), (element) =>
        element.scrollHeight > element.clientHeight
          ? element.scrollHeight + element.getBoundingClientRect().top
          : 0,
      ),
    ),
  );
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(height) });
  await page.screenshot({ path, animations: "disabled" });
  await page.setViewportSize(viewport);
}

async function open(theme: Theme, width: number, record = false) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    colorScheme: theme,
    ...(width < 600 ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
    ...(record && video ? { recordVideo: { dir: video, size: { width, height: 900 } } } : {}),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`${baseUrl}/test/signup-onboarding.html`, { waitUntil: "networkidle" });
  // Switch the theme the way the app does, with transitions off, so the
  // checks never read a color mid-transition.
  await page.locator("html").evaluate(async (node, selectedTheme) => {
    node.setAttribute("data-og-theme-switching", "");
    node.dataset.ogTheme = selectedTheme;
    node.classList.toggle("dark", selectedTheme === "dark");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    node.removeAttribute("data-og-theme-switching");
  }, theme);
  await page.getByRole("heading", { name: "How do you want to use Opengeni?" }).waitFor();
  return { context, page, errors };
}

async function createOrganization(page: Page, theme: Theme, width: number) {
  await page.getByRole("heading", { name: "Create your organization" }).waitFor();
  await pace(page, 500);
  await page
    .getByLabel("Organization name")
    .pressSequentially("Northwind", { delay: video ? 60 : 0 });
  await check(page, "2-organization", theme, width);
  await pace(page, 600);
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.getByRole("heading", { name: "You got $10 in free credits" }).waitFor();
  if (output) {
    // The burst mid-flight, then the settled step for the checks.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${output}/3-credits-burst-${theme}-${width}.png` });
  }
  await page.waitForTimeout(2_600);
  await check(page, "3-credits", theme, width);
}

async function requests(page: Page) {
  return await page.evaluate(
    () =>
      (window as unknown as { onboardingRequests: Array<{ method: string; args: unknown[] }> })
        .onboardingRequests,
  );
}

try {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      // "Add AI agents to my product", then "Let Opengeni implement it".
      {
        const { context, page, errors } = await open(
          theme,
          width,
          theme === "light" && width === 1440,
        );
        await check(page, "1-use-case", theme, width);
        await pace(page);
        await page.getByRole("button", { name: /^Add AI agents to my product/ }).click();
        await createOrganization(page, theme, width);
        await pace(page, 600);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("heading", { name: "Add AI agents to your product" }).waitFor();
        await page.getByText(KEY).waitFor();
        // The actions fade in from disabled once the key exists.
        await page.waitForTimeout(400);
        await check(page, "4-developer-setup", theme, width);
        await pace(page, 1_500);
        // Step 1 copies the key alone; step 2 copies a prompt without it.
        await page.getByRole("button", { name: "Copy key", exact: true }).click();
        if ((await page.evaluate(() => navigator.clipboard.readText())) !== KEY) {
          throw new Error("Copy key did not copy exactly the key");
        }
        await pace(page, 800);
        await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
        await page.getByRole("button", { name: "Prompt copied" }).waitFor();
        const prompt = await page.evaluate(() => navigator.clipboard.readText());
        if (
          prompt.includes(KEY) ||
          !prompt.includes("server-only .env as OPENGENI_API_KEY") ||
          !prompt.includes("opengeni@opengeni")
        ) {
          throw new Error(`Unexpected prompt: ${prompt}`);
        }
        await page.getByRole("button", { name: /^Preview the prompt/ }).click();
        const preview = await page.locator("pre").innerText();
        if (preview.includes(KEY)) throw new Error("The prompt preview shows the key");
        await check(page, "5-prompt-copied", theme, width);
        await pace(page, 2_000);
        await page.getByRole("button", { name: "Let Opengeni implement it" }).click();
        await page.getByTestId("landed").waitFor();
        await pace(page);
        const landed = await page.getByTestId("landed").innerText();
        if (!landed.includes("55555555-5555-4555-8555-555555555555")) {
          throw new Error(`Did not open the setup chat: ${landed}`);
        }
        const sent = await requests(page);
        const methods = sent.map(({ method }) => method);
        if (
          JSON.stringify(methods) !==
          JSON.stringify([
            "createOrganizationApiKey",
            "createWorkspace",
            "createVariableSet",
            "createSession",
          ])
        ) {
          throw new Error(`Unexpected requests: ${JSON.stringify(methods)}`);
        }
        const session = JSON.stringify(sent.at(-1));
        if (session.includes(KEY)) throw new Error("The setup chat request carries the key");
        if (errors.length) throw new Error(errors.join("; "));
        await context.close();
      }
      // "Run agents in the cloud": home, and no key.
      {
        const { context, page, errors } = await open(theme, width);
        await page.getByRole("button", { name: /^Run agents in the cloud/ }).click();
        await createOrganization(page, theme, width);
        await page.getByRole("button", { name: "Use your own subscription or key" }).click();
        await page.getByRole("button", { name: "Connect Codex" }).waitFor();
        await check(page, "6-cloud-credits-options", theme, width);
        await page.getByRole("button", { name: "Start chatting", exact: true }).click();
        await page.getByText("Opened home").waitFor();
        if ((await requests(page)).length) throw new Error("The cloud path created something");
        if (errors.length) throw new Error(errors.join("; "));
        await context.close();
      }
    }
  }
  console.log(
    "Signup onboarding passed both paths at 1440/390, light/dark: accessibility, no overflow or browser errors, exact requests, the key only in its own copy step, never in the prompt.",
  );
} finally {
  await browser.close();
}
