import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  BrowserPasskeyCredential,
  BrowserPasskeyEvent,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner, BrowserPasskeyManager } from "../src";
import type { BrowserCdpConnection } from "../src/cdp-driver";
import { CdpConnection } from "../src/cdp";
import { startFakeLoginServer, type FakeLoginServer } from "../../testing/src/fake-login/server";
import { encryptString, generateSymmetricKey } from "../../vaults-bitwarden/src/crypto";
import { cipherPasskeys } from "../../vaults-bitwarden/src/mapping";

// Fake-login suite through the real browserd driver and Chrome: passkeys
// (register, sync-only reload, every tab), a cross-origin CAPTCHA iframe and a
// login popup, all by accessibility ref. Headless with OPENGENI_BROWSERD_E2E=1,
// headed (under xvfb-run) with OPENGENI_BROWSERD_HEADED_E2E=1.
const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";
const enabled = process.env.OPENGENI_BROWSERD_E2E === "1" || headed;
const e2e = enabled ? test : test.skip;
const mode = headed ? "headed" : "headless";
const evidenceDirectory = process.env.OPENGENI_BROWSERD_EVIDENCE_DIR ?? null;
// The OS picks free ports unless FAKE_LOGIN_PORT pins them. A fixed default
// sits in Linux's ephemeral range (32768-60999), where any concurrent client
// socket can already hold it.
const sitePort = Number(process.env.FAKE_LOGIN_PORT ?? 0);

let site: FakeLoginServer;
const siteLog: string[] = [];
const evidence: Record<string, unknown> = { mode };

beforeAll(async () => {
  // A skipped suite (every unit-shard run) starts no server.
  if (!enabled) return;
  site = await startFakeLoginServer({
    port: sitePort,
    iframePort: sitePort ? sitePort + 1 : 0,
    log: (line) => siteLog.push(line),
  });
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
});

afterAll(async () => {
  await site?.close();
  if (evidenceDirectory && enabled) {
    await writeFile(
      join(evidenceDirectory, `fake-login-${mode}-site.log`),
      `${siteLog.join("\n")}\n`,
    );
    await writeFile(
      join(evidenceDirectory, `fake-login-${mode}-summary.json`),
      `${JSON.stringify({ ...evidence, state: site?.state() }, null, 2)}\n`,
    );
  }
});

e2e.each(["device-bound", "backed-up", "bitwarden", "legacy-missing-flags"] as const)(
  "vault passkey registration and fresh-browser import: %s",
  async (source) => {
    const backedUp = source !== "device-bound";
    const username = `pk-${randomUUID().slice(0, 8)}`;
    const password = "Passkey-User-Password-1!";
    const itemId = randomUUID();
    let stored: BrowserPasskeyCredential;
    const signCounts: number[] = [];
    // ---- browser 1: sign up, register, sign in ----------------------------------
    const first = await launch("pk1", backedUp);
    try {
      let page = await first.driver.start(`${site.url}/signup`);
      page = await act(page, fillByRef(page, "textbox", "Username", username));
      page = await act(page, fillByRef(page, "textbox", "Password", password));
      page = await act(page, fillByRef(page, "textbox", "Confirm password", password));
      page = await act(page, clickByRef(page, "button", "Create account"));
      page = await until(first.driver, page.target.id, (o) =>
        hasName(o, `Logged in as ${username}`),
      );
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/register` });
      page = await act(page, clickByRef(page, "button", "Create a passkey"));
      page = await until(first.driver, page.target.id, (o) =>
        hasName(o, `Passkey saved for ${username}`),
      );
      await shot(first.driver, page.target.id, "passkey-registered");
      const registered = await first.sync(null);
      expect(registered.authenticators).toBeGreaterThanOrEqual(1);
      const event = only(registered.events, "registered");
      expect(event.origin).toBe(site.url);
      expect(event.credential.rpId).toBe("localhost");
      expect(event.credential.privateKey.length).toBeGreaterThan(100);
      expect(event.credential).toMatchObject({
        backupEligibility: backedUp,
        backupState: backedUp,
      });
      // The API saves the vault item, acknowledges the event and supplies the item.
      stored = { ...event.credential, itemId };
      expect((await first.sync([stored], [event.eventId])).events).toEqual([]);

      page = await act(page, { type: "navigate", url: `${site.url}/logout` });
      expect(hasName(page, "Not signed in")).toBe(true);
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/login` });
      page = await act(page, clickByRef(page, "button", "Sign in with a passkey"));
      page = await until(first.driver, page.target.id, (o) =>
        hasName(o, `Logged in as ${username}`),
      );
      signCounts.push(await assertedSignCount(first, itemId));
    } finally {
      await first.close();
    }
    stored = { ...stored, signCount: signCounts[0]! };
    if (source === "bitwarden") stored = throughBitwarden(stored);
    if (source === "legacy-missing-flags") {
      // Reproduce the old import without changing the key, RP id, handle or
      // counter. The verifier checks the signature before rejecting BE.
      const { backupEligibility: _be, backupState: _bs, ...legacy } = stored;
      stored = legacy;
    }
    expect(await serverSignCount(username)).toBe(signCounts[0]!);

    // ---- browser 2: fresh profile, credential only from sync ----------------------
    const second = await launch("pk2");
    try {
      const loaded = await second.sync([stored], []);
      expect(loaded).toMatchObject({ authenticators: 0, events: [] });
      let page = await second.driver.start(`${site.url}/passkey/login`);
      expect(hasName(page, "Not signed in")).toBe(true);
      page = await act(page, clickByRef(page, "button", "Sign in with a passkey"));
      if (source === "legacy-missing-flags") {
        page = await until(second.driver, page.target.id, (o) =>
          names(o).some((name) =>
            name.includes("backup_eligibility_mismatch: BE changed since registration"),
          ),
        );
        expect(hasName(page, "Not signed in")).toBe(true);
        expect(await assertedSignCount(second, itemId)).toBeGreaterThan(signCounts[0]!);
        expect(site.state().attempts.at(-1)).toMatchObject({
          username,
          ok: false,
          reason: "backup_eligibility_mismatch",
        });
        return;
      }
      page = await until(second.driver, page.target.id, (o) =>
        hasName(o, `Logged in as ${username}`),
      );
      await shot(second.driver, page.target.id, "passkey-login-after-sync");
      signCounts.push(await assertedSignCount(second, itemId));

      // A second tab gets its own authenticator with the current counter.
      let tab = await second.driver.openTarget(`${site.url}/passkey/login`);
      tab = await act(tab, clickByRef(tab, "button", "Sign in with a passkey"));
      tab = await until(second.driver, tab.target.id, (o) =>
        hasName(o, `Logged in as ${username}`),
      );
      signCounts.push(await assertedSignCount(second, itemId));
      expect((await second.sync(null)).authenticators).toBeGreaterThanOrEqual(2);

      // Back in the first tab, whose copy must have received the newer counter.
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/login` });
      page = await act(page, clickByRef(page, "button", "Sign in with a passkey"));
      page = await until(second.driver, page.target.id, (o) =>
        hasName(o, `Logged in as ${username}`),
      );
      signCounts.push(await assertedSignCount(second, itemId));
    } finally {
      await second.close();
    }
    for (let index = 1; index < signCounts.length; index += 1) {
      expect(signCounts[index]!).toBeGreaterThan(signCounts[index - 1]!);
    }
    expect(await serverSignCount(username)).toBe(signCounts.at(-1)!);
    const rejected = site
      .state()
      .attempts.filter(
        (attempt) => attempt.flow === "passkey" && attempt.username === username && !attempt.ok,
      );
    expect(rejected).toEqual([]);
    evidence[`passkey-${source}`] = { username, signCounts };
  },
  180_000,
);

e2e(
  "a fresh browser holding another browser's passkey only through sync starts signed out, autofill never signs it in, and signing out sticks",
  async () => {
    const username = `pk-autofill-${randomUUID().slice(0, 8)}`;
    const password = "Passkey-Autofill-Password-1!";
    const itemId = randomUUID();
    let stored: BrowserPasskeyCredential;
    // ---- browser 1: sign up and register a passkey, as another identity did --------
    const first = await launch("pk-autofill-1");
    try {
      let page = await first.driver.start(`${site.url}/signup`);
      page = await act(page, fillByRef(page, "textbox", "Username", username));
      page = await act(page, fillByRef(page, "textbox", "Password", password));
      page = await act(page, fillByRef(page, "textbox", "Confirm password", password));
      page = await act(page, clickByRef(page, "button", "Create account"));
      page = await until(first.driver, page.target.id, (o) =>
        hasName(o, `Logged in as ${username}`),
      );
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/register` });
      page = await act(page, clickByRef(page, "button", "Create a passkey"));
      page = await until(first.driver, page.target.id, (o) =>
        hasName(o, `Passkey saved for ${username}`),
      );
      const event = only((await first.sync(null)).events, "registered");
      stored = { ...event.credential, itemId };
      await first.sync([stored], [event.eventId]);
    } finally {
      await first.close();
    }
    const passkeySignIns = () =>
      site
        .state()
        .attempts.filter((attempt) => attempt.flow === "passkey" && attempt.username === username);

    // ---- browser 2: a fresh, empty profile that holds the passkey only via sync ----
    const second = await launch("pk-autofill-2");
    try {
      await second.sync([stored], []);
      // Nothing of the other browser's sign-in is here.
      let page = await second.driver.start(`${site.url}/welcome`);
      expect(hasName(page, "Not signed in")).toBe(true);
      expect(await cookieNames(second)).toEqual([]);
      // The identifier page asks for a passkey through autofill on load. Nobody
      // picked one, so it must not sign in: it shows its username field.
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/autofill` });
      page = await until(second.driver, page.target.id, (o) =>
        names(o).some((name) => name.startsWith("Passkey autofill")),
      );
      await Bun.sleep(1_500);
      page = await second.driver.observe(page.target.id);
      expect(hasName(page, `Logged in as ${username}`)).toBe(false);
      expect(nodes(page).some((node) => node.role === "textbox" && node.name === "Username")).toBe(
        true,
      );
      expect(passkeySignIns()).toEqual([]);
      expect(await cookieNames(second)).toEqual([]);
      await shot(second.driver, page.target.id, "passkey-autofill-not-answered");

      // Asked for in the open, the same passkey still signs in.
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/login` });
      page = await act(page, clickByRef(page, "button", "Sign in with a passkey"));
      page = await until(second.driver, page.target.id, (o) =>
        hasName(o, `Logged in as ${username}`),
      );
      expect(passkeySignIns().filter((attempt) => attempt.ok)).toHaveLength(1);
      expect(await cookieNames(second)).toEqual(["fl_session"]);

      // Signing out sticks: the autofill page does not sign the passkey back in.
      page = await act(page, { type: "navigate", url: `${site.url}/logout` });
      expect(hasName(page, "Not signed in")).toBe(true);
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/autofill` });
      page = await until(second.driver, page.target.id, (o) =>
        names(o).some((name) => name.startsWith("Passkey autofill")),
      );
      await Bun.sleep(1_500);
      page = await act(page, { type: "navigate", url: `${site.url}/welcome` });
      expect(hasName(page, "Not signed in")).toBe(true);
      expect(passkeySignIns().filter((attempt) => attempt.ok)).toHaveLength(1);
      expect(await cookieNames(second)).toEqual([]);
    } finally {
      await second.close();
    }
  },
  120_000,
);

e2e(
  "a cross-origin frame, which shares its tab's authenticator, is offered no passkey autofill either",
  async () => {
    // The frame asks for a passkey through autofill and reports to its page.
    // A request the authenticator answers settles at once (here with no
    // credential: NotAllowedError); a withdrawn one stays pending.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        const body =
          url.pathname === "/frame"
            ? `<script>(async () => {
  const report = (text) => parent.postMessage(text, "*");
  report("autofill " + (await PublicKeyCredential.isConditionalMediationAvailable() ? "offered" : "not available"));
  navigator.credentials.get({ mediation: "conditional", publicKey: { challenge: new Uint8Array(32), rpId: location.hostname, allowCredentials: [] } })
    .then(() => report("request answered"), (error) => report("request answered: " + error.name));
  setTimeout(() => report("request still pending"), 1000);
})();</script>`
            : `<ul id="frame-log" aria-label="Frame log"></ul>
<script>addEventListener("message", (event) => { const item = document.createElement("li"); item.textContent = "frame: " + event.data; document.getElementById("frame-log").append(item); });</script>
<iframe title="Embedded sign-in" allow="publickey-credentials-get *" src="http://embedded.localhost:${url.port}/frame"></iframe>`;
        return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
      },
    });
    const browser = await launch("pk-autofill-frame");
    try {
      let page = await browser.driver.start(`http://localhost:${server.port}/`);
      page = await until(browser.driver, page.target.id, (o) =>
        names(o).some((name) => name.startsWith("frame: request")),
      );
      await Bun.sleep(1_200);
      page = await browser.driver.observe(page.target.id);
      const log = names(page).filter((name) => name.startsWith("frame: "));
      expect(log).toEqual(["frame: autofill not available", "frame: request still pending"]);
    } finally {
      await browser.close();
      await server.stop(true);
    }
  },
  60_000,
);

e2e(
  "solves the cross-origin CAPTCHA iframe by ref and signs in",
  async () => {
    const browser = await launch("captcha");
    try {
      let page = await browser.driver.start(`${site.url}/captcha-iframe`);
      page = await until(browser.driver, page.target.id, (o) =>
        nodes(o).some((node) => node.role === "checkbox" && node.name === "I'm not a robot"),
      );
      const frameDocument = nodes(page).find(
        (node) =>
          node.description === `Cross-origin frame ${crossOrigin()}` &&
          descendants(node).some((child) => child.name === "I'm not a robot"),
      );
      expect(frameDocument).toBeDefined();
      page = await act(page, clickByRef(page, "checkbox", "I'm not a robot"));
      page = await until(browser.driver, page.target.id, (o) =>
        nodes(o).some((node) => node.role === "textbox" && node.name === "Characters in the image"),
      );
      await shot(browser.driver, page.target.id, "captcha-challenge");
      const { answer } = (await (await fetch(`${site.url}/__fake/captcha/latest`)).json()) as {
        answer: string;
      };
      expect(answer).toMatch(/^[A-Z0-9]{5}$/u);
      page = await act(page, fillByRef(page, "textbox", "Characters in the image", answer));
      page = await act(page, clickByRef(page, "button", "Verify"));
      page = await until(browser.driver, page.target.id, (o) => hasName(o, "Challenge solved."));
      page = await act(page, fillByRef(page, "textbox", "Username", "alice"));
      page = await act(page, fillByRef(page, "textbox", "Password", "Fake-Login-Alice-Password-1"));
      page = await act(page, clickByRef(page, "button", "Sign in"));
      page = await until(browser.driver, page.target.id, (o) => hasName(o, "Logged in as alice"));
      await shot(browser.driver, page.target.id, "captcha-logged-in");
      expect(page.target.url).toBe(`${site.url}/welcome`);
      expect(
        site
          .state()
          .successes.some((success) => success.flow === "captcha" && success.username === "alice"),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  },
  120_000,
);

e2e(
  "signs in through a login popup that appears as a target",
  async () => {
    const browser = await launch("popup");
    try {
      let opener = await browser.driver.start(`${site.url}/popup-login`);
      opener = await act(opener, clickByRef(opener, "button", "Sign in with FakeID"));
      const deadline = Date.now() + 15_000;
      let popupId: string | null = null;
      while (!popupId && Date.now() < deadline) {
        const targets = await browser.driver.listTargets();
        popupId =
          targets.find((target) => target.kind === "popup" && target.url.includes("/idp/authorize"))
            ?.id ?? null;
        if (!popupId) await Bun.sleep(100);
      }
      expect(popupId).not.toBeNull();
      let popup = await until(browser.driver, popupId!, (o) =>
        nodes(o).some((node) => node.role === "button" && node.name === "Sign in"),
      );
      await shot(browser.driver, popup.target.id, "popup-idp");
      popup = await act(popup, fillByRef(popup, "textbox", "Username", "alice"));
      popup = await act(
        popup,
        fillByRef(popup, "textbox", "Password", "Fake-Login-Alice-Password-1"),
      );
      await browser.driver
        .dispatch(command(popup, clickByRef(popup, "button", "Sign in")))
        .catch(() => null); // The popup closes itself right after posting the token.
      opener = await until(browser.driver, opener.target.id, (o) =>
        hasName(o, "Logged in as alice"),
      );
      await shot(browser.driver, opener.target.id, "popup-opener-logged-in");
      expect(opener.target.url).toBe(`${site.url}/welcome`);
      expect(
        site
          .state()
          .successes.some((success) => success.flow === "popup" && success.username === "alice"),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  },
  120_000,
);

// ---- harness --------------------------------------------------------------------

/** Only freshly generated fixture material; no account or remote vault access. */
function throughBitwarden(credential: BrowserPasskeyCredential): BrowserPasskeyCredential {
  const key = generateSymmetricKey();
  const enc = (value: string) => encryptString(value, key);
  const [imported] = cipherPasskeys(
    {
      type: 1,
      login: {
        fido2Credentials: [
          {
            credentialId: enc(
              `b64.${Buffer.from(credential.credentialId, "base64").toString("base64url")}`,
            ),
            rpId: enc(credential.rpId),
            userHandle: enc(credential.userHandle ?? ""),
            userName: enc(credential.userName ?? ""),
            userDisplayName: enc(credential.userDisplayName ?? ""),
            keyValue: enc(credential.privateKey),
            keyAlgorithm: enc("ECDSA"),
            keyCurve: enc("P-256"),
            counter: enc(String(credential.signCount)),
          },
        ],
      },
    },
    key,
  );
  expect(imported).toBeDefined();
  return { ...imported!, itemId: credential.itemId };
}

type Browser = {
  driver: AgentBrowserDriver;
  sync(
    credentials: BrowserPasskeyCredential[] | null,
    acknowledgeEventIds?: string[],
  ): ReturnType<BrowserPasskeyManager["sync"]>;
  close(): Promise<void>;
};

async function launch(label: string, backedUp = false): Promise<Browser> {
  const directory = await mkdtemp(`/tmp/w4cdp-${label}-`);
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed,
    ...(process.env.OPENGENI_BROWSER_EXECUTABLE
      ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
      : {}),
  });
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const passkeys = new BrowserPasskeyManager({ browserSessionId, controllerGeneration });
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
    runner,
    focusEmulation: true,
    passkeys,
    // Simulate a password manager at registration only. The fresh browser's
    // imports use the production defaults, never these registrar defaults.
    ...(backedUp
      ? {
          connect: async (endpoint: string) => {
            const connection = await CdpConnection.connect(endpoint);
            const send = connection.send.bind(connection);
            connection.send = (method, params, options) =>
              send(
                method,
                method === "WebAuthn.addVirtualAuthenticator"
                  ? {
                      ...params,
                      options: {
                        ...(params?.options as Record<string, unknown>),
                        defaultBackupEligibility: true,
                        defaultBackupState: true,
                      },
                    }
                  : params,
                options,
              );
            return connection;
          },
        }
      : {}),
  });
  drivers.set(browserSessionId, driver);
  return {
    driver,
    sync: async (credentials, acknowledgeEventIds = []) =>
      await passkeys.sync({
        protocolVersion: 1,
        browserSessionId,
        controllerGeneration,
        credentials,
        acknowledgeEventIds,
      }),
    close: async () => {
      try {
        await driver.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

async function act(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
  driver?: AgentBrowserDriver,
): Promise<BrowserObservation> {
  return await (driver ?? currentDriver(observation)).dispatch(command(observation, action));
}

const drivers = new Map<string, AgentBrowserDriver>();
function currentDriver(observation: BrowserObservation): AgentBrowserDriver {
  const driver = drivers.get(observation.browserSessionId);
  if (!driver) throw new Error("unknown browser session");
  return driver;
}

function command(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "browserd-fake-login-e2e" },
    action,
  };
}

function ref(observation: BrowserObservation, role: string, name: string): string {
  const matches = nodes(observation).filter(
    (node) => node.role.toLowerCase() === role && node.name === name,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one ${role} "${name}", found ${matches.length}`);
  }
  return matches[0]!.ref;
}

function fillByRef(
  observation: BrowserObservation,
  role: string,
  name: string,
  value: string,
): BrowserActionCommand["action"] {
  return { type: "fill", locator: { kind: "ref", ref: ref(observation, role, name) }, value };
}

function clickByRef(
  observation: BrowserObservation,
  role: string,
  name: string,
): BrowserActionCommand["action"] {
  return { type: "click", locator: { kind: "ref", ref: ref(observation, role, name) } };
}

async function until(
  driver: AgentBrowserDriver,
  targetId: string,
  predicate: (observation: BrowserObservation) => boolean,
  timeoutMs = 15_000,
): Promise<BrowserObservation> {
  const deadline = Date.now() + timeoutMs;
  let last: BrowserObservation | null = null;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      last = await driver.observe(targetId);
      if (predicate(last)) return last;
    } catch (error) {
      lastError = error; // Mid-navigation reads can fail; keep polling.
    }
    await Bun.sleep(150);
  }
  throw new Error(
    `condition not reached; last names: ${last ? names(last).slice(0, 40).join(" | ") : String(lastError)}`,
  );
}

async function assertedSignCount(browser: Browser, itemId: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { events } = await browser.sync(null);
    const asserted = events.filter(
      (event): event is Extract<BrowserPasskeyEvent, { type: "asserted" }> =>
        event.type === "asserted",
    );
    if (asserted.length > 0) {
      expect(asserted).toHaveLength(1);
      expect(asserted[0]!.itemId).toBe(itemId);
      expect(asserted[0]!.rpId).toBe("localhost");
      await browser.sync(null, [asserted[0]!.eventId]);
      return asserted[0]!.signCount;
    }
    await Bun.sleep(100);
  }
  throw new Error("no passkey assertion event");
}

/** Every cookie the browser holds, by name. */
async function cookieNames(browser: Browser): Promise<string[]> {
  const connection = (browser.driver as unknown as { connection: BrowserCdpConnection | null })
    .connection;
  if (!connection) throw new Error("the browser is not running");
  const { cookies } = await connection.send<{ cookies: Array<{ name: string }> }>(
    "Storage.getCookies",
    {},
  );
  return cookies.map((cookie) => cookie.name).sort();
}

async function serverSignCount(username: string): Promise<number> {
  const account = (await (await fetch(`${site.url}/__fake/accounts/${username}`)).json()) as {
    passkeys: Array<{ signCount: number }>;
  };
  expect(account.passkeys).toHaveLength(1);
  return account.passkeys[0]!.signCount;
}

function only<T extends BrowserPasskeyEvent["type"]>(
  events: readonly BrowserPasskeyEvent[],
  type: T,
): Extract<BrowserPasskeyEvent, { type: T }> {
  expect(events).toHaveLength(1);
  expect(events[0]!.type).toBe(type);
  return events[0] as Extract<BrowserPasskeyEvent, { type: T }>;
}

async function shot(driver: AgentBrowserDriver, targetId: string, name: string): Promise<void> {
  if (!evidenceDirectory) return;
  const image = await driver.captureScreenshot(targetId);
  await writeFile(join(evidenceDirectory, `fake-login-${mode}-${name}.png`), image.data);
}

function crossOrigin(): string {
  return site.crossOriginUrl;
}

function nodes(observation: BrowserObservation): InteractionSemanticNodeValue[] {
  if (observation.semantic?.kind !== "snapshot") return [];
  return observation.semantic.roots.flatMap(descendantsAndSelf);
}

function descendantsAndSelf(node: InteractionSemanticNodeValue): InteractionSemanticNodeValue[] {
  return [node, ...descendants(node)];
}

function descendants(node: InteractionSemanticNodeValue): InteractionSemanticNodeValue[] {
  return (node.children ?? []).flatMap(descendantsAndSelf);
}

function names(observation: BrowserObservation): string[] {
  return nodes(observation).flatMap((node) => (node.name ? [node.name] : []));
}

function hasName(observation: BrowserObservation, name: string): boolean {
  return names(observation).includes(name);
}
