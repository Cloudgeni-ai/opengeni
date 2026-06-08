import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Frame, type Page } from "playwright";

interface Args {
  checkoutUrl: string;
  successUrlPrefix: string;
  screenshotPath: string;
  timeoutSeconds: number;
  executablePath: string | null;
}

const args = parseArgs(process.argv.slice(2));
const browser = await chromium.launch({
  headless: true,
  ...(args.executablePath ? { executablePath: args.executablePath } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let timeout: ReturnType<typeof setTimeout> | undefined;

try {
  await Promise.race([
    runCheckout(page),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Stripe Checkout smoke exceeded ${args.timeoutSeconds} seconds`));
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

async function runCheckout(page: Page): Promise<void> {
  log("open_checkout");
  await page.goto(args.checkoutUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutSeconds * 1000 });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);

  log("fill_email");
  await fillIfPresent(page, [
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="email"]',
  ], "opengeni-staging-checkout@example.com");
  log("fill_card_number");
  await fillRequired(page, [
    'input[name="cardNumber"]',
    'input[autocomplete="cc-number"]',
    'input[placeholder*="1234"]',
  ], "4242424242424242");
  log("fill_expiry");
  await fillRequired(page, [
    'input[name="cardExpiry"]',
    'input[autocomplete="cc-exp"]',
    'input[placeholder*="MM"]',
  ], "1234");
  log("fill_cvc");
  await fillRequired(page, [
    'input[name="cardCvc"]',
    'input[autocomplete="cc-csc"]',
    'input[placeholder*="CVC"]',
    'input[placeholder*="CVV"]',
  ], "123");
  log("fill_name");
  await fillIfPresent(page, [
    'input[name="billingName"]',
    'input[autocomplete="cc-name"]',
    'input[autocomplete="name"]',
  ], "OpenGeni Staging");
  log("select_country");
  await selectIfPresent(page, [
    'select[name="billingCountry"]',
    'select[autocomplete="billing country"]',
    'select[autocomplete="country"]',
    'select',
  ], "US");
  log("fill_address");
  await fillIfPresent(page, [
    'input[name="billingAddressLine1"]',
    'input[autocomplete="billing address-line1"]',
    'input[autocomplete="address-line1"]',
  ], "354 Oyster Point Blvd");
  await fillIfPresent(page, [
    'input[name="billingLocality"]',
    'input[autocomplete="billing address-level2"]',
    'input[autocomplete="address-level2"]',
  ], "South San Francisco");
  await fillIfPresent(page, [
    'input[name="billingAdministrativeArea"]',
    'input[autocomplete="billing address-level1"]',
    'input[autocomplete="address-level1"]',
  ], "CA");
  await fillIfPresent(page, [
    'input[name="billingPostalCode"]',
    'input[autocomplete="billing postal-code"]',
    'input[autocomplete="postal-code"]',
  ], "94080");
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(250);

  log("submit");
  await clickPay(page);
  log("wait_success");
  await page.waitForURL((url) => url.href.startsWith(args.successUrlPrefix), { timeout: args.timeoutSeconds * 1000 });
  await mkdir(dirname(args.screenshotPath), { recursive: true });
  await page.screenshot({ path: args.screenshotPath, fullPage: true });
  console.log(JSON.stringify({ ok: true, finalUrl: page.url(), screenshotPath: args.screenshotPath }, null, 2));
}

async function fillRequired(page: Page, selectors: string[], value: string): Promise<void> {
  if (await fillIfPresent(page, selectors, value)) {
    return;
  }
  throw new Error(`Could not find required Stripe Checkout field for selectors: ${selectors.join(", ")}`);
}

async function fillIfPresent(page: Page, selectors: string[], value: string): Promise<boolean> {
  const target = await firstVisible(page, selectors);
  if (!target) {
    return false;
  }
  await target.fill(value);
  return true;
}

async function selectIfPresent(page: Page, selectors: string[], value: string): Promise<boolean> {
  const target = await firstVisible(page, selectors);
  if (!target) {
    return false;
  }
  try {
    await target.selectOption(value);
    return true;
  } catch {
    return false;
  }
}

async function clickPay(page: Page): Promise<void> {
  const exactPay = await firstVisibleRole(page, /^Pay$/);
  if (exactPay) {
    await exactPay.click({ timeout: 15_000 });
    await page.waitForTimeout(1_000);
    if (await exactPay.isVisible().catch(() => false)) {
      await exactPay.click({ timeout: 15_000 });
    }
    return;
  }
  const candidates = [
    'button:has-text("Pay")',
    'button:has-text("Subscribe")',
    'button[type="submit"]',
    'button:has-text("Continue")',
  ];
  const target = await firstVisible(page, candidates);
  if (!target) {
    throw new Error("Could not find Stripe Checkout submit button");
  }
  await target.click({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  if (await target.isVisible().catch(() => false)) {
    await target.click({ timeout: 15_000 });
  }
}

async function firstVisibleRole(page: Page, name: RegExp) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const roots: Array<Page | Frame> = [page, ...page.frames()];
    for (const root of roots) {
      const locator = root.getByRole("button", { name }).first();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function firstVisible(page: Page, selectors: string[]) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const roots: Array<Page | Frame> = [page, ...page.frames()];
    for (const root of roots) {
      for (const selector of selectors) {
        const locator = root.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
          return locator;
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
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
  }, null, 2));
}

function replaceSuffix(path: string, suffix: string): string {
  const index = path.lastIndexOf(".");
  if (index <= path.lastIndexOf("/")) {
    return `${path}${suffix}`;
  }
  return `${path.slice(0, index)}${suffix}`;
}

function log(step: string): void {
  console.error(JSON.stringify({ step, url: page.url() }));
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    checkoutUrl: process.env.OPENGENI_STRIPE_CHECKOUT_URL ?? "",
    successUrlPrefix: process.env.OPENGENI_STRIPE_CHECKOUT_SUCCESS_PREFIX ?? "https://staging.app.opengeni.ai/billing?checkout=success",
    screenshotPath: process.env.OPENGENI_STRIPE_CHECKOUT_SCREENSHOT ?? ".agent/generated/staging/stripe-checkout-final.png",
    timeoutSeconds: Number(process.env.OPENGENI_STRIPE_CHECKOUT_TIMEOUT_SECONDS ?? 180),
    executablePath: process.env.OPENGENI_PLAYWRIGHT_EXECUTABLE_PATH ?? null,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--checkout-url") {
      out.checkoutUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--success-url-prefix") {
      out.successUrlPrefix = requiredNext(values, ++index, value);
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
    if (value.startsWith("--checkout-url=")) {
      out.checkoutUrl = value.slice("--checkout-url=".length);
      continue;
    }
    if (value.startsWith("--executable-path=")) {
      out.executablePath = value.slice("--executable-path=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!out.checkoutUrl) {
    throw new Error("Set --checkout-url or OPENGENI_STRIPE_CHECKOUT_URL");
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
