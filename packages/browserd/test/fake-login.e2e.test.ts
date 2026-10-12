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
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  BrowserPasskeyManager,
  resolvePinnedAgentBrowserBinary,
} from "../src";
import {
  startFakeLoginServer,
  type FakeLoginServer,
} from "../../testing/src/fake-login/server";

// Fake-login suite through the real browserd driver and Chrome: passkeys
// (register, sync-only reload, every tab), a cross-origin CAPTCHA iframe and a
// login popup, all by accessibility ref. Headless with OPENGENI_BROWSERD_E2E=1,
// headed (under xvfb-run) with OPENGENI_BROWSERD_HEADED_E2E=1.
const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";
const enabled = process.env.OPENGENI_BROWSERD_E2E === "1" || headed;
const e2e = enabled ? test : test.skip;
const mode = headed ? "headed" : "headless";
const evidenceDirectory = process.env.OPENGENI_BROWSERD_EVIDENCE_DIR ?? null;
const sitePort = Number(process.env.FAKE_LOGIN_PORT ?? (headed ? 47432 : 47430));

let site: FakeLoginServer;
const siteLog: string[] = [];
const evidence: Record<string, unknown> = { mode };

beforeAll(async () => {
  site = await startFakeLoginServer({
    port: sitePort,
    iframePort: sitePort + 1,
    log: (line) => siteLog.push(line),
  });
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
});

afterAll(async () => {
  await site?.close();
  if (evidenceDirectory && enabled) {
    await writeFile(join(evidenceDirectory, `fake-login-${mode}-site.log`), `${siteLog.join("\n")}\n`);
    await writeFile(
      join(evidenceDirectory, `fake-login-${mode}-summary.json`),
      `${JSON.stringify({ ...evidence, state: site?.state() }, null, 2)}\n`,
    );
  }
});

e2e(
  "registers a passkey, signs in with it, and signs in again in a fresh browser that only got it through sync, in every tab",
  async () => {
    const username = `pk-${randomUUID().slice(0, 8)}`;
    const password = "Passkey-User-Password-1!";
    const itemId = randomUUID();
    let stored: BrowserPasskeyCredential;
    const signCounts: number[] = [];
    // ---- browser 1: sign up, register, sign in ----------------------------------
    const first = await launch("pk1");
    try {
      let page = await first.driver.start(`${site.url}/signup`);
      page = await act(page, fillByRef(page, "textbox", "Username", username));
      page = await act(page, fillByRef(page, "textbox", "Password", password));
      page = await act(page, fillByRef(page, "textbox", "Confirm password", password));
      page = await act(page, clickByRef(page, "button", "Create account"));
      page = await until(first.driver, page.target.id, (o) => hasName(o, `Logged in as ${username}`));
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/register` });
      page = await act(page, clickByRef(page, "button", "Create a passkey"));
      page = await until(first.driver, page.target.id, (o) => hasName(o, `Passkey saved for ${username}`));
      await shot(first.driver, page.target.id, "passkey-registered");
      const registered = await first.sync(null);
      expect(registered.authenticators).toBeGreaterThanOrEqual(1);
      const event = only(registered.events, "registered");
      expect(event.origin).toBe(site.url);
      expect(event.credential.rpId).toBe("localhost");
      expect(event.credential.privateKey.length).toBeGreaterThan(100);
      // The API saves the vault item, acknowledges the event and supplies the item.
      stored = { ...event.credential, itemId };
      expect((await first.sync([stored], [event.eventId])).events).toEqual([]);

      page = await act(page, { type: "navigate", url: `${site.url}/logout` });
      expect(hasName(page, "Not signed in")).toBe(true);
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/login` });
      page = await act(page, clickByRef(page, "button", "Sign in with a passkey"));
      page = await until(first.driver, page.target.id, (o) => hasName(o, `Logged in as ${username}`));
      signCounts.push(await assertedSignCount(first, itemId));
    } finally {
      await first.close();
    }
    stored = { ...stored, signCount: signCounts[0]! };
    expect(await serverSignCount(username)).toBe(signCounts[0]!);

    // ---- browser 2: fresh profile, credential only from sync ----------------------
    const second = await launch("pk2");
    try {
      const loaded = await second.sync([stored], []);
      expect(loaded).toMatchObject({ authenticators: 0, events: [] });
      let page = await second.driver.start(`${site.url}/passkey/login`);
      expect(hasName(page, "Not signed in")).toBe(true);
      page = await act(page, clickByRef(page, "button", "Sign in with a passkey"));
      page = await until(second.driver, page.target.id, (o) => hasName(o, `Logged in as ${username}`));
      await shot(second.driver, page.target.id, "passkey-login-after-sync");
      signCounts.push(await assertedSignCount(second, itemId));

      // A second tab gets its own authenticator with the current counter.
      let tab = await second.driver.openTarget(`${site.url}/passkey/login`);
      tab = await act(tab, clickByRef(tab, "button", "Sign in with a passkey"));
      tab = await until(second.driver, tab.target.id, (o) => hasName(o, `Logged in as ${username}`));
      signCounts.push(await assertedSignCount(second, itemId));
      expect((await second.sync(null)).authenticators).toBeGreaterThanOrEqual(2);

      // Back in the first tab, whose copy must have received the newer counter.
      page = await act(page, { type: "navigate", url: `${site.url}/passkey/login` });
      page = await act(page, clickByRef(page, "button", "Sign in with a passkey"));
      page = await until(second.driver, page.target.id, (o) => hasName(o, `Logged in as ${username}`));
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
      .attempts.filter((attempt) => attempt.flow === "passkey" && !attempt.ok);
    expect(rejected).toEqual([]);
    evidence.passkey = { username, signCounts };
  },
  180_000,
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
        site.state().successes.some((success) => success.flow === "captcha" && success.username === "alice"),
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
      popup = await act(popup, fillByRef(popup, "textbox", "Password", "Fake-Login-Alice-Password-1"));
      await browser.driver
        .dispatch(command(popup, clickByRef(popup, "button", "Sign in")))
        .catch(() => null); // The popup closes itself right after posting the token.
      opener = await until(browser.driver, opener.target.id, (o) => hasName(o, "Logged in as alice"));
      await shot(browser.driver, opener.target.id, "popup-opener-logged-in");
      expect(opener.target.url).toBe(`${site.url}/welcome`);
      expect(
        site.state().successes.some((success) => success.flow === "popup" && success.username === "alice"),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  },
  120_000,
);

// ---- harness --------------------------------------------------------------------

type Browser = {
  driver: AgentBrowserDriver;
  sync(
    credentials: BrowserPasskeyCredential[] | null,
    acknowledgeEventIds?: string[],
  ): ReturnType<BrowserPasskeyManager["sync"]>;
  close(): Promise<void>;
};

async function launch(label: string): Promise<Browser> {
  const directory = await mkdtemp(`/tmp/w4cdp-${label}-`);
  const runner = await AgentBrowserJsonRunner.create({
    namespace: `w4${randomUUID().slice(0, 8)}`,
    sessionName: "s",
    socketDirectory: join(directory, "s"),
    profileDirectory: join(directory, "profile"),
    downloadDirectory: join(directory, "downloads"),
    screenshotDirectory: join(directory, "screenshots"),
    headed,
    ...(process.env.OPENGENI_BROWSER_EXECUTABLE
      ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
      : {}),
    binary: await resolvePinnedAgentBrowserBinary(
      process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
        ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
        : {},
    ),
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
  return `http://127.0.0.1:${sitePort + 1}`;
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
