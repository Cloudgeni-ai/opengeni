import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";

interface Args {
  baseUrl: string;
  cookieHeader: string;
  expectedEmail: string | null;
  screenshotPath: string;
  timeoutSeconds: number;
  executablePath: string | null;
}

const args = parseArgs(process.argv.slice(2));
const base = new URL(args.baseUrl);
const browser = await chromium.launch({
  headless: true,
  ...(args.executablePath ? { executablePath: args.executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const pageErrors: string[] = [];
const badResponses: Array<{ url: string; status: number }> = [];

page.on("pageerror", (error) => {
  pageErrors.push(error.message);
});
page.on("response", (response) => {
  const url = response.url();
  if (url.startsWith(base.origin) && response.status() >= 500) {
    badResponses.push({ url, status: response.status() });
  }
});

let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    runSmoke(page),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`managed web smoke exceeded ${args.timeoutSeconds} seconds`));
      }, args.timeoutSeconds * 1000);
    }),
  ]);
} catch (error) {
  await writeFailureArtifacts(page, error);
  throw error;
} finally {
  if (timeout) {
    clearTimeout(timeout);
  }
  await browser.close();
}

async function runSmoke(page: Page): Promise<void> {
  const context = page.context();
  await context.addCookies(cookieHeaderToPlaywrightCookies(args.cookieHeader, base));

  await page.goto(base.href, { waitUntil: "domcontentloaded", timeout: args.timeoutSeconds * 1000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

  await expectVisibleText(page, "What should the agent do?");
  await expectVisibleText(page, "Start a durable sandbox session");
  if (await page.getByRole("heading", { name: "Sign in" }).isVisible().catch(() => false)) {
    throw new Error("managed web smoke saw sign-in panel despite supplied session cookie");
  }

  await page.getByRole("button", { name: /^Account$/ }).click();
  await expectVisibleText(page, "Credits");
  await expectVisibleText(page, "API keys");
  await expectVisibleText(page, "Workspace-scoped keys for calling OpenGeni from another product.");
  await expectVisibleText(page, "Create");
  if (args.expectedEmail) {
    await expectVisibleText(page, args.expectedEmail);
  }

  const accountText = await page.locator("body").innerText();
  if (!/available/i.test(accountText)) {
    throw new Error("account console did not render a billing balance");
  }
  if (pageErrors.length > 0 || badResponses.length > 0) {
    throw new Error(`browser smoke saw runtime errors: ${JSON.stringify({ pageErrors, badResponses })}`);
  }

  await mkdir(dirname(args.screenshotPath), { recursive: true });
  await page.screenshot({ path: args.screenshotPath, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    baseUrl: base.origin,
    screenshotPath: args.screenshotPath,
  }, null, 2));
}

async function expectVisibleText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
}

async function writeFailureArtifacts(page: Page, error: unknown): Promise<void> {
  const screenshotPath = replaceSuffix(args.screenshotPath, "-failure.png");
  const htmlPath = replaceSuffix(args.screenshotPath, "-failure.html");
  await mkdir(dirname(args.screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await writeFile(htmlPath, await page.content()).catch(() => undefined);
  console.error(JSON.stringify({
    ok: false,
    currentUrl: page.url(),
    error: error instanceof Error ? error.message : String(error),
    failureScreenshotPath: screenshotPath,
    failureHtmlPath: htmlPath,
    pageErrors,
    badResponses,
  }, null, 2));
}

type PlaywrightCookie = Parameters<BrowserContext["addCookies"]>[0][number];

function cookieHeaderToPlaywrightCookies(header: string, url: URL): PlaywrightCookie[] {
  return header.split(/;\s*/g)
    .map((part) => {
      const index = part.indexOf("=");
      if (index <= 0) {
        return null;
      }
      const name = part.slice(0, index);
      const value = part.slice(index + 1);
      return {
        name,
        value,
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        secure: url.protocol === "https:",
        sameSite: "Lax" as const,
      };
    })
    .filter((cookie): cookie is PlaywrightCookie => cookie !== null);
}

function replaceSuffix(path: string, suffix: string): string {
  const index = path.lastIndexOf(".");
  if (index <= path.lastIndexOf("/")) {
    return `${path}${suffix}`;
  }
  return `${path.slice(0, index)}${suffix}`;
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    baseUrl: process.env.OPENGENI_MANAGED_WEB_BASE_URL ?? process.env.OPENGENI_CONFORMANCE_BASE_URL ?? "",
    cookieHeader: process.env.OPENGENI_MANAGED_WEB_COOKIE ?? process.env.OPENGENI_MANAGED_LIVE_COOKIE ?? "",
    expectedEmail: process.env.OPENGENI_MANAGED_WEB_EXPECTED_EMAIL ?? process.env.OPENGENI_MANAGED_LIVE_EMAIL ?? null,
    screenshotPath: process.env.OPENGENI_MANAGED_WEB_SCREENSHOT ?? ".agent/generated/staging/managed-web-smoke.png",
    timeoutSeconds: Number(process.env.OPENGENI_MANAGED_WEB_TIMEOUT_SECONDS ?? 120),
    executablePath: process.env.OPENGENI_PLAYWRIGHT_EXECUTABLE_PATH ?? null,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--base-url") {
      out.baseUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--cookie") {
      out.cookieHeader = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--expected-email") {
      out.expectedEmail = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--screenshot") {
      out.screenshotPath = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--timeout-seconds") {
      out.timeoutSeconds = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--executable-path") {
      out.executablePath = requiredNext(values, ++index, value);
      continue;
    }
    if (value.startsWith("--base-url=")) {
      out.baseUrl = value.slice("--base-url=".length);
      continue;
    }
    if (value.startsWith("--screenshot=")) {
      out.screenshotPath = value.slice("--screenshot=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!out.baseUrl) {
    throw new Error("Set --base-url, OPENGENI_MANAGED_WEB_BASE_URL, or OPENGENI_CONFORMANCE_BASE_URL");
  }
  if (!out.cookieHeader) {
    throw new Error("Set --cookie, OPENGENI_MANAGED_WEB_COOKIE, or OPENGENI_MANAGED_LIVE_COOKIE");
  }
  if (!Number.isFinite(out.timeoutSeconds) || out.timeoutSeconds <= 0) {
    throw new Error("--timeout-seconds must be positive");
  }
  return out;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}
