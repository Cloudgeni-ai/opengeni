/**
 * Proves every fake-login flow (dossier §13B.3) against real Chromium with
 * Playwright, including passkeys through the CDP WebAuthn virtual authenticator.
 * This tests the SUITE (the oracle). The product path through browserd is
 * test/e2e/secrets-fake-login.browser.e2e.ts (W4, BR-7).
 *
 *   bun scripts/run-browser-e2e.ts ./test/e2e/secrets-fake-login-suite.browser.e2e.ts
 *   FAKE_LOGIN_HEADED=1 xvfb-run -a bun --no-env-file test ./test/e2e/secrets-fake-login-suite.browser.e2e.ts
 *
 * FAKE_LOGIN_SHOTS_DIR=<dir> saves one screenshot per step plus state.json.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  startFakeLoginServer,
  totp,
  withFakeMailMcp,
  type FakeLoginServer,
} from "@opengeni/testing/fake-login";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";

const shotsDir = process.env.FAKE_LOGIN_SHOTS_DIR;
const headed = process.env.FAKE_LOGIN_HEADED === "1";
const mode = headed ? "headed" : "headless";

let server: FakeLoginServer;
let browser: Browser;

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${mode}-${name}.png`), fullPage: true });
}

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 900, height: 760 } });
  return { context, page: await context.newPage() };
}

async function expectLoggedIn(page: Page, username: string, flow: string): Promise<void> {
  const status = page.locator("#logged-in");
  await status.waitFor({ timeout: 10_000 });
  expect(await status.getAttribute("data-user")).toBe(username);
  expect(await status.getAttribute("data-flow")).toBe(flow);
  expect(await status.textContent()).toBe(`Logged in as ${username}`);
  const whoami = await page.evaluate(async () => (await fetch("/whoami")).json());
  expect(whoami).toEqual({ loggedIn: true, username, flow });
}

function receivedValues(flow: string, field: string): string[] {
  return server
    .received()
    .filter((entry) => entry.flow === flow && entry.field === field)
    .map((entry) => entry.value);
}

async function passwordLogin(
  page: Page,
  username: string,
  password: string,
  path = "/password",
): Promise<void> {
  await page.goto(`${server.url}${path}`);
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.click("#sign-in");
}

async function addAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

describe(`fake-login suite on real Chromium (${mode})`, () => {
  beforeAll(async () => {
    server = await startFakeLoginServer({
      port: Number(process.env.FAKE_LOGIN_PORT ?? 0),
      iframePort: Number(process.env.FAKE_LOGIN_IFRAME_PORT ?? 0),
      log: () => {},
    });
    browser = await chromium.launch({ headless: !headed });
  }, 60_000);

  afterAll(async () => {
    if (shotsDir && server) {
      writeFileSync(join(shotsDir, `${mode}-state.json`), JSON.stringify(server.state(), null, 2));
    }
    await Promise.allSettled([browser?.close(), server?.close()]);
  });

  test("password login: wrong password is refused, the right one signs in and arrives exactly", async () => {
    const { context, page } = await freshPage();
    await passwordLogin(page, "alice", "not-the-password");
    expect(await page.locator("#error").textContent()).toBe("Wrong username or password.");
    await shot(page, "password-wrong");
    await passwordLogin(page, "alice", "Fake-Login-Alice-Password-1");
    await expectLoggedIn(page, "alice", "password");
    await shot(page, "password-success");
    expect(receivedValues("password", "password")).toEqual([
      "not-the-password",
      "Fake-Login-Alice-Password-1",
    ]);
    const state = server.state();
    expect(JSON.stringify(state)).not.toContain("Fake-Login-Alice-Password-1");
    expect(
      state.attempts.filter((attempt) => attempt.flow === "password").map((attempt) => attempt.ok),
    ).toEqual([false, true]);
    await context.close();
  });

  test("signup enforces the password rules, then creates the account; password change works", async () => {
    const { context, page } = await freshPage();
    await page.goto(`${server.url}/signup`);
    await page.fill("#username", "newbie");
    await page.fill("#password", "short$pw");
    await page.fill("#confirm", "short$pw");
    await page.click("#create-account");
    const errors = await page.locator("#error li").allTextContents();
    expect(errors).toContain("Use at least 16 characters.");
    expect(errors).toContain("Include an uppercase letter.");
    expect(errors).toContain("These characters are not allowed: $");
    await shot(page, "signup-rules");

    const generated = "Gx7-kP2.qR9:mZ4=wT6?";
    await page.fill("#username", "newbie");
    await page.fill("#password", generated);
    await page.fill("#confirm", generated);
    await page.click("#create-account");
    await expectLoggedIn(page, "newbie", "signup");
    await shot(page, "signup-success");
    expect(receivedValues("signup", "password")).toEqual(["short$pw", generated]);

    const changed = "Nw8_vB3+hJ5@cL1#yQ0!";
    await page.goto(`${server.url}/password-change`);
    await page.fill("#current", generated);
    await page.fill("#password", changed);
    await page.fill("#confirm", changed);
    await page.click("#change-password");
    await page.locator("#password-changed").waitFor();
    expect(await page.locator("#password-changed").getAttribute("data-user")).toBe("newbie");
    await shot(page, "password-change-success");
    expect(server.account("newbie")?.password).toBe(changed);
    expect(receivedValues("password-change", "password")).toEqual([changed]);
    await context.close();

    const second = await freshPage();
    await passwordLogin(second.page, "newbie", generated);
    expect(await second.page.locator("#error").textContent()).toBe("Wrong username or password.");
    await passwordLogin(second.page, "newbie", changed);
    await expectLoggedIn(second.page, "newbie", "password");
    await second.context.close();
  });

  test("TOTP enrollment shows a QR code and seed, then TOTP login works in a new session", async () => {
    const { context, page } = await freshPage();
    await passwordLogin(page, "alice", "Fake-Login-Alice-Password-1");
    await page.goto(`${server.url}/totp/enroll`);
    const secret = (await page.locator("#totp-secret").textContent())!;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(await page.locator("#totp-qr svg").count()).toBe(1);
    expect(await page.locator("#otpauth-uri").textContent()).toContain(`secret=${secret}`);
    await shot(page, "totp-enroll");
    await page.fill("#code", "000000" === totp(secret, Date.now()) ? "111111" : "000000");
    await page.click("#verify-code");
    expect(await page.locator("#error").textContent()).toContain("That code is not valid");
    await page.fill("#code", totp(secret, Date.now()));
    await page.click("#verify-code");
    await page.locator("#totp-enabled").waitFor();
    await shot(page, "totp-enroll-success");
    expect(server.account("alice")?.totpSecret).toBe(secret);
    await context.close();

    const second = await freshPage();
    await passwordLogin(second.page, "alice", "Fake-Login-Alice-Password-1", "/totp/login");
    await second.page.locator("#code").waitFor();
    await shot(second.page, "totp-login-code");
    const code = totp(secret, Date.now());
    await second.page.fill("#code", code);
    await second.page.click("#verify-code");
    await expectLoggedIn(second.page, "alice", "totp");
    await shot(second.page, "totp-login-success");
    expect(receivedValues("totp", "code")).toEqual([code]);
    await second.context.close();
  });

  test("email code: the code arrives in the fake mailbox (HTTP and MCP) and signs in", async () => {
    const { context, page } = await freshPage();
    await page.goto(`${server.url}/email-code`);
    await page.fill("#email", "nobody@fake-login.test");
    await page.click("#send-code");
    expect(await page.locator("#error").textContent()).toBe("No account uses that email address.");
    await page.fill("#email", "alice@fake-login.test");
    await page.click("#send-code");
    await page.locator("#sent-to").waitFor();
    await shot(page, "email-code-sent");

    const http = (await (await fetch(`${server.mailApiUrl}?to=alice@fake-login.test`)).json()) as {
      messages: { id: string; body: string }[];
    };
    expect(http.messages).toHaveLength(1);
    const body = await withFakeMailMcp(server.mcpUrl, async (mail) => {
      expect([...mail.toolNames].sort()).toEqual(["get_message", "search_messages"]);
      const [summary] = await mail.search({ to: "alice@", query: "sign-in code" });
      return (await mail.get(summary!.id)).body;
    });
    expect(body).toBe(http.messages[0]!.body);
    const code = /sign-in code is (\d{6})/u.exec(body)![1]!;

    await page.fill("#code", code);
    await page.click("#verify-code");
    await expectLoggedIn(page, "alice", "email-code");
    await shot(page, "email-code-success");
    expect(receivedValues("email-code", "code")).toEqual([code]);
    await context.close();
  });

  test("split OTP boxes reject inserted text and accept key events", async () => {
    const { context, page } = await freshPage();
    await passwordLogin(page, "totp-user", "Fake-Login-Totp-Password-2", "/otp-split");
    await page.locator("#otp-0").waitFor();
    const code = totp("JBSWY3DPEHPK3PXP", Date.now());
    // CDP Input.insertText (what browserd's fill/type use today) fires no key events.
    await page.focus("#otp-0");
    await page.keyboard.insertText(code);
    const afterInsert = await page.$$eval(".otp input", (inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value).join(""),
    );
    expect(afterInsert).toBe("");
    await shot(page, "otp-split-insert-rejected");
    await page.focus("#otp-0");
    for (const digit of code.slice(0, 3)) await page.keyboard.press(digit);
    await shot(page, "otp-split-partial");
    const fresh = totp("JBSWY3DPEHPK3PXP", Date.now());
    const rest = fresh.slice(0, 3) === code.slice(0, 3) ? code.slice(3) : null;
    if (rest === null) {
      // The 30 s window rolled over between digits: clear and type the new code.
      for (let index = 0; index < 3; index += 1) await page.keyboard.press("Backspace");
      await page.focus("#otp-0");
      for (const digit of fresh) await page.keyboard.press(digit);
    } else {
      for (const digit of rest) await page.keyboard.press(digit);
    }
    await expectLoggedIn(page, "totp-user", "otp-split");
    await shot(page, "otp-split-success");
    await context.close();
  });

  test("passkeys: register, log in from a fresh browser, and refuse a stale sign counter", async () => {
    const { context, page } = await freshPage();
    await passwordLogin(page, "alice", "Fake-Login-Alice-Password-1");
    await expectLoggedIn(page, "alice", "password");
    const { cdp, authenticatorId } = await addAuthenticator(page);
    await page.goto(`${server.url}/passkey/register`);
    await shot(page, "passkey-register");
    await page.click("#create-passkey");
    await page.waitForFunction(() =>
      document.getElementById("passkey-status")?.textContent?.startsWith("Passkey saved"),
    );
    await shot(page, "passkey-register-success");
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    expect(credentials).toHaveLength(1);
    const exported = credentials[0]!;
    expect(exported.rpId).toBe("localhost");
    expect(exported.isResidentCredential).toBe(true);
    const registeredCount = server.state().accounts.find((account) => account.username === "alice")!
      .passkeys[0]!.signCount;
    await context.close();

    // A fresh browser has no credential until it is loaded, exactly like a new browserd session.
    const second = await freshPage();
    const loaded = await addAuthenticator(second.page);
    await loaded.cdp.send("WebAuthn.addCredential", {
      authenticatorId: loaded.authenticatorId,
      credential: exported,
    });
    await second.page.goto(`${server.url}/passkey/login`);
    await shot(second.page, "passkey-login");
    await second.page.click("#passkey-login");
    await expectLoggedIn(second.page, "alice", "passkey");
    await shot(second.page, "passkey-login-success");
    const afterLogin = server.state().accounts.find((account) => account.username === "alice")!
      .passkeys[0]!.signCount;
    expect(afterLogin).toBeGreaterThan(registeredCount);
    const { credentials: advanced } = await loaded.cdp.send("WebAuthn.getCredentials", {
      authenticatorId: loaded.authenticatorId,
    });
    expect(advanced[0]!.signCount).toBe(afterLogin);
    await second.context.close();

    // Reloading the stale export (no sign-count write-back) must be refused by the RP.
    const third = await freshPage();
    const stale = await addAuthenticator(third.page);
    await stale.cdp.send("WebAuthn.addCredential", {
      authenticatorId: stale.authenticatorId,
      credential: exported,
    });
    await third.page.goto(`${server.url}/passkey/login`);
    await third.page.fill("#username", "alice");
    await third.page.click("#passkey-login");
    await third.page.waitForFunction(() =>
      document.getElementById("passkey-status")?.textContent?.includes("counter_regression"),
    );
    await shot(third.page, "passkey-stale-counter-refused");
    await third.context.close();
  });

  test("CAPTCHA-like challenge in a cross-origin iframe gates the sign-in", async () => {
    const { context, page } = await freshPage();
    await page.goto(`${server.url}/captcha-iframe`);
    expect(await page.locator("#sign-in").isDisabled()).toBe(true);
    const frameElement = await page.waitForSelector("#captcha-frame");
    const frame = (await frameElement.contentFrame())!;
    expect(new URL(frame.url()).origin).toBe(server.crossOriginUrl);
    expect(new URL(frame.url()).origin).not.toBe(new URL(page.url()).origin);
    await page.fill("#username", "alice");
    await page.fill("#password", "Fake-Login-Alice-Password-1");
    await frame.check("#robot");
    await frame.locator("#challenge").waitFor();
    await shot(page, "captcha-challenge");
    await frame.fill("#answer", "WRONG");
    await frame.click("#verify");
    await frame.locator("#verdict.error").waitFor();
    await frame.waitForFunction(
      () => (document.getElementById("answer") as HTMLInputElement).value === "",
    );
    const answer = server.latestCaptchaAnswer()!;
    expect(answer).toMatch(/^[A-Z2-9]{5}$/);
    await frame.fill("#answer", answer.toLowerCase());
    await frame.click("#verify");
    await page.waitForFunction(
      () => !(document.getElementById("sign-in") as HTMLButtonElement).disabled,
    );
    await shot(page, "captcha-solved");
    await page.click("#sign-in");
    await expectLoggedIn(page, "alice", "captcha");
    await shot(page, "captcha-success");
    expect(
      server
        .state()
        .attempts.filter((attempt) => attempt.flow === "captcha-challenge")
        .map((attempt) => attempt.ok),
    ).toEqual([false, true]);
    await context.close();
  });

  test("login popup on another origin posts back and signs the opener in", async () => {
    const { context, page } = await freshPage();
    await page.goto(`${server.url}/popup-login`);
    await shot(page, "popup-opener");
    const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open-popup")]);
    await popup.waitForLoadState();
    expect(new URL(popup.url()).origin).toBe(server.crossOriginUrl);
    await popup.fill("#username", "alice");
    await popup.fill("#password", "Fake-Login-Alice-Password-1");
    await shot(popup, "popup-idp");
    await Promise.all([popup.waitForEvent("close"), popup.click("#idp-sign-in")]);
    await expectLoggedIn(page, "alice", "popup");
    await shot(page, "popup-success");
    expect(receivedValues("popup", "password")).toEqual(["Fake-Login-Alice-Password-1"]);
    await context.close();
  });

  test("state, received log and success list are machine-checkable", async () => {
    const state = (await (await fetch(`${server.url}/state`)).json()) as {
      successes: { flow: string }[];
    };
    expect(new Set(state.successes.map((success) => success.flow))).toEqual(
      new Set([
        "password",
        "signup",
        "password-change",
        "totp-enroll",
        "totp",
        "email-code",
        "otp-split",
        "passkey-register",
        "passkey",
        "captcha",
        "popup",
      ]),
    );
    const received = (await (await fetch(`${server.url}/__fake/received`)).json()) as {
      received: { value: string }[];
    };
    expect(received.received.some((entry) => entry.value === "Fake-Login-Alice-Password-1")).toBe(
      true,
    );
  });
});
