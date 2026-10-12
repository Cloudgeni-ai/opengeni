/**
 * BR-7: every fake-login flow through the PRODUCT path with `{{secret:…}}`
 * references (dossier §10B.4). The test plays the API's part exactly as the
 * Browser routes do for an agent attempt: it resolves the references in the
 * action with `resolveInteractionSecretValues`, sends the plaintext to the real
 * browserd HTTP server only in the private `secretValues` side map, and syncs
 * agent-owned passkeys with `syncBrowserPasskeys` around every action. The
 * agent-visible action only ever carries references.
 *
 *   bun scripts/run-browser-e2e.ts ./test/e2e/secrets-fake-login.browser.e2e.ts
 *   FAKE_LOGIN_HEADED=1 xvfb-run -a bun --no-env-file test ./test/e2e/secrets-fake-login.browser.e2e.ts
 *
 * FAKE_LOGIN_SHOTS_DIR=<dir> saves a screenshot per step (taken through
 * browserd), the site's state and the leak-scan report.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  type AccessGrant,
  type BrowserAction,
  type BrowserActionCommand,
  type BrowserObservation,
  type BrowserPasskeyCredential,
  type BrowserPasskeySyncRequest,
  type BrowserPasskeySyncResponse,
  type InteractionSemanticNodeValue,
  browserActionSecretTexts,
  parseTotpInput,
  totpCodeSync,
} from "@opengeni/contracts";
import { BrowserControlServer, BrowserSupervisor } from "@opengeni/browserd";
import { startFakeLoginServer, type FakeLoginServer } from "@opengeni/testing/fake-login";

import {
  type InteractionPasskeyStore,
  type InteractionSecretsPort,
  resolveInteractionSecretValues,
  syncBrowserPasskeys,
} from "../../apps/api/src/interaction-secrets";
import { createStaticSecretResolver } from "../../packages/vaults/src/testing/static-resolver";
import { type Hit, needlesFor, scanBuffer } from "../../scripts/verify/secrets-e2e/scan";

const shotsDir = process.env.FAKE_LOGIN_SHOTS_DIR;
const headed = process.env.FAKE_LOGIN_HEADED === "1";
const mode = headed ? "headed" : "headless";

const ALICE_PASSWORD = "Fake-Login-Alice-Password-1";
const TOTP_PASSWORD = "Fake-Login-Totp-Password-2";
const TOTP_SEED = "JBSWY3DPEHPK3PXP";
const SIGNUP_PASSWORD = "Gx7-kP2.qR9:mZ4=wT6?";
const CHANGED_PASSWORD = "Nw8_vB3+hJ5@cL1#yQ0!";
const ECHO_CANARY = "OGCANARY-echo-7Qx2Lm9Pz";

const ACCOUNT = "0e8c3b52-0000-4000-8000-000000000001";
const WORKSPACE = "0e8c3b52-0000-4000-8000-000000000002";
const SESSION = "0e8c3b52-0000-4000-8000-000000000003";
const TURN = "0e8c3b52-0000-4000-8000-000000000004";
const ATTEMPT = "0e8c3b52-0000-4000-8000-000000000005";

const grant: AccessGrant = {
  accountId: ACCOUNT,
  workspaceId: WORKSPACE,
  subjectId: "worker:first-party-mcp",
  permissions: [],
  principalKind: "agent_attempt",
  metadata: {
    sessionId: SESSION,
    turnId: TURN,
    attemptId: ATTEMPT,
    executionGeneration: 1,
  },
};
const actor = {
  kind: "agent" as const,
  subjectId: "worker:first-party-mcp",
  sessionId: SESSION,
  turnId: TURN,
  attemptId: ATTEMPT,
  executionGeneration: 1,
};

/** The vault, as the static stub resolver sees it. Tests add items the way an
 * agent saves them (TOTP seed from an enrollment page, a generated password). */
const vault: Record<string, string> = {
  "Fake Alice/password": ALICE_PASSWORD,
  "Fake TOTP/password": TOTP_PASSWORD,
  "Fake TOTP": TOTP_SEED,
  "Echo/value": ECHO_CANARY,
};
/** Every plaintext that went through the side map, for the leak scan. */
const plaintexts = new Map<string, string>([
  ["alice password", ALICE_PASSWORD],
  ["totp-user password", TOTP_PASSWORD],
  ["totp seed", TOTP_SEED],
  ["signup password", SIGNUP_PASSWORD],
  ["changed password", CHANGED_PASSWORD],
  ["echo canary", ECHO_CANARY],
]);

/** In-memory passkey items with lease and monotonic sign-count semantics. */
class MemoryPasskeyStore implements InteractionPasskeyStore {
  readonly items = new Map<
    string,
    {
      credential: BrowserPasskeyCredential;
      origin: string | null;
      holder: string | null;
    }
  >();
  readonly signCountWrites: Array<{ itemId: string; signCount: number }> = [];
  async lease(_principal: unknown, holder: string): Promise<BrowserPasskeyCredential[]> {
    const out: BrowserPasskeyCredential[] = [];
    for (const item of this.items.values()) {
      if (item.holder !== null && item.holder !== holder) continue;
      item.holder = holder;
      out.push(item.credential);
    }
    return out;
  }
  async saveRegistered(
    _principal: unknown,
    input: {
      credential: Omit<BrowserPasskeyCredential, "itemId">;
      origin: string | null;
    },
  ): Promise<{ itemId: string }> {
    const itemId = randomUUID();
    this.items.set(itemId, {
      credential: { ...input.credential, itemId } as BrowserPasskeyCredential,
      origin: input.origin,
      holder: null,
    });
    return { itemId };
  }
  async updateSignCount(_principal: unknown, itemId: string, signCount: number): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) return;
    this.signCountWrites.push({ itemId, signCount });
    item.credential = {
      ...item.credential,
      signCount: Math.max(item.credential.signCount, signCount),
    };
  }
  async release(holder: string): Promise<void> {
    for (const item of this.items.values()) if (item.holder === holder) item.holder = null;
  }
}

const passkeys = new MemoryPasskeyStore();
const secretsPort: InteractionSecretsPort = {
  resolverFor: async (principal) => createStaticSecretResolver(vault, { principal }),
  passkeys,
};

let site: FakeLoginServer;
let supervisor: BrowserSupervisor;
let browserd: BrowserControlServer;
let rootDirectory: string;
const adminToken = `admin.${"a".repeat(48)}`;
/** Every browserd response body, to prove no plaintext came back. */
const responses: string[] = [];
const opened: ProductBrowser[] = [];

function flatten(nodes: readonly InteractionSemanticNodeValue[]): InteractionSemanticNodeValue[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function texts(observation: BrowserObservation): string[] {
  const roots = observation.semantic?.kind === "snapshot" ? observation.semantic.roots : [];
  return flatten(roots).flatMap((node) =>
    [node.name, node.value].filter((value): value is string => typeof value === "string"),
  );
}

async function browserdRequest(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return await fetch(`${browserd.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function data<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  responses.push(text);
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 600)}`);
  return (JSON.parse(text) as { data: T }).data;
}

/** One agent BrowserSession: references in, side map to browserd, passkeys synced. */
class ProductBrowser {
  readonly browserSessionId = randomUUID();
  readonly controllerGeneration = `controller-${randomUUID()}`;
  readonly controlToken = `control.${randomUUID().replaceAll("-", "")}${"c".repeat(20)}`;
  readonly viewToken = `view.${randomUUID().replaceAll("-", "")}${"v".repeat(20)}`;
  targetId = "";
  readonly sideMapSizes: number[] = [];

  static async open(url: string): Promise<ProductBrowser> {
    const browser = new ProductBrowser();
    opened.push(browser);
    const created = await data<{ observation: BrowserObservation }>(
      await browserdRequest("POST", "/v1/browser-sessions", adminToken, {
        browserSessionId: browser.browserSessionId,
        controllerGeneration: browser.controllerGeneration,
        tokenGeneration: 1,
        controlToken: browser.controlToken,
        viewToken: browser.viewToken,
        headed,
        initialUrl: url,
      }),
      "create browser session",
    );
    browser.targetId = created.observation.target.id;
    await browser.syncPasskeys();
    return browser;
  }

  private get base(): string {
    return `/v1/browser-sessions/${this.browserSessionId}`;
  }

  async observe(targetId = this.targetId): Promise<BrowserObservation> {
    return await data<BrowserObservation>(
      await browserdRequest(
        "GET",
        `${this.base}/targets/${encodeURIComponent(targetId)}/observation`,
        this.viewToken,
      ),
      "observe",
    );
  }

  async targets(): Promise<Array<{ id: string; url?: string; [key: string]: unknown }>> {
    const listed = await data<{ targets: Array<{ id: string; url?: string }> }>(
      await browserdRequest("GET", `${this.base}/targets`, this.viewToken),
      "targets",
    );
    return listed.targets;
  }

  async syncPasskeys(): Promise<void> {
    await syncBrowserPasskeys({
      port: secretsPort,
      grant,
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      client: {
        passkeySync: async (request: BrowserPasskeySyncRequest) => {
          const response = await browserdRequest(
            "POST",
            `${this.base}/passkeys/sync`,
            this.controlToken,
            request,
          );
          if (response.status === 404 || response.status === 405) {
            throw Object.assign(new Error("passkey sync unsupported"), {
              status: response.status,
            });
          }
          return await data<BrowserPasskeySyncResponse>(response, "passkey sync");
        },
      },
      log: () => {},
    });
  }

  /** What the API Browser `/actions` route does for an agent attempt. */
  async act(action: BrowserAction, targetId = this.targetId): Promise<BrowserObservation> {
    const current = await this.observe(targetId);
    const secretValues = await resolveInteractionSecretValues({
      port: secretsPort,
      grant,
      texts: browserActionSecretTexts(action),
      use: {
        surface: "browser",
        toolName: "browser_act",
        operationId: randomUUID(),
      },
    });
    this.sideMapSizes.push(Object.keys(secretValues ?? {}).length);
    await this.syncPasskeys();
    const command: BrowserActionCommand = {
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      targetId,
      expectedTargetGeneration: current.target.targetGeneration,
      expectedDocumentGeneration: current.target.documentGeneration,
      expectedFrameId: current.frameId,
      actor,
      action,
      ...(secretValues ? { secretValues } : {}),
    };
    try {
      const receipt = await data<{ observation: BrowserObservation | null }>(
        await browserdRequest("POST", `${this.base}/actions`, this.controlToken, command),
        `action ${action.type}`,
      );
      return receipt.observation ?? (await this.observe(targetId));
    } finally {
      await this.syncPasskeys();
    }
  }

  async goto(path: string): Promise<void> {
    await this.act({ type: "navigate", url: `${site.url}${path}` });
  }

  async waitForText(
    predicate: (text: string) => boolean,
    targetId = this.targetId,
    timeoutMs = 15_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last: string[] = [];
    while (Date.now() < deadline) {
      last = texts(await this.observe(targetId));
      const found = last.find(predicate);
      if (found !== undefined) return found;
      await Bun.sleep(150);
    }
    throw new Error(`text not found; last texts: ${JSON.stringify(last.slice(0, 60))}`);
  }

  async shot(name: string, targetId = this.targetId): Promise<void> {
    if (!shotsDir) return;
    const response = await browserdRequest(
      "GET",
      `${this.base}/targets/${encodeURIComponent(targetId)}/screenshot?format=png`,
      this.viewToken,
    );
    if (!response.ok) throw new Error(`screenshot failed (${response.status})`);
    mkdirSync(shotsDir, { recursive: true });
    writeFileSync(
      join(shotsDir, `${mode}-${name}.png`),
      new Uint8Array(await response.arrayBuffer()),
    );
  }

  async end(): Promise<void> {
    const response = await browserdRequest("POST", `${this.base}/end`, this.controlToken, {});
    await response.text();
    await passkeys.release(this.browserSessionId);
  }
}

function css(selector: string) {
  return { kind: "css" as const, selector };
}

async function expectLoggedIn(browser: ProductBrowser, username: string, flow: string) {
  await browser.waitForText((text) => text === `Logged in as ${username}`);
  expect(
    site
      .state()
      .successes.some((success) => success.username === username && success.flow === flow),
  ).toBe(true);
}

function receivedValues(flow: string, field: string): string[] {
  return site
    .received()
    .filter((entry) => entry.flow === flow && entry.field === field)
    .map((entry) => entry.value);
}

async function passwordLogin(
  browser: ProductBrowser,
  username: string,
  passwordReference: string,
  path = "/password",
): Promise<void> {
  await browser.goto(path);
  await browser.act({
    type: "fill",
    locator: css("#username"),
    value: username,
  });
  await browser.act({
    type: "fill",
    locator: css("#password"),
    value: passwordReference,
  });
  await browser.act({ type: "click", locator: css("#sign-in") });
}

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

describe(`fake-login flows through browserd with secret references (${mode})`, () => {
  beforeAll(async () => {
    site = await startFakeLoginServer({
      port: Number(process.env.FAKE_LOGIN_PORT ?? 0),
      iframePort: Number(process.env.FAKE_LOGIN_IFRAME_PORT ?? 0),
      log: () => {},
    });
    rootDirectory = mkdtempSync("/tmp/ogb-w4-fake-login-");
    supervisor = await BrowserSupervisor.open({
      rootDirectory: join(rootDirectory, "state"),
      socketRootDirectory: mkdtempSync("/tmp/ogs-w4-"),
    });
    browserd = BrowserControlServer.start({ supervisor, adminToken, port: 0 });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(opened.map((browser) => browser.end()));
    await browserd?.stop();
    await supervisor?.close();
    if (shotsDir && site) {
      mkdirSync(shotsDir, { recursive: true });
      writeFileSync(join(shotsDir, `${mode}-state.json`), JSON.stringify(site.state(), null, 2));
    }
    await site?.close();
    if (rootDirectory && process.env.FAKE_LOGIN_KEEP_ROOT !== "1") {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  test("password login with a reference; the reply is redacted and the value arrives exactly", async () => {
    const browser = await ProductBrowser.open(`${site.url}/password`);
    await passwordLogin(browser, "alice", "{{secret:Fake Alice/password}}");
    await expectLoggedIn(browser, "alice", "password");
    await browser.shot("password-success");
    expect(receivedValues("password", "password")).toEqual([ALICE_PASSWORD]);
    expect(browser.sideMapSizes).toContain(1);

    // A typo in a reference fails before dispatch with a structured error.
    await browser.goto("/password");
    const error = await browser
      .act({
        type: "fill",
        locator: css("#password"),
        value: "{{secret:Fake Alice/pasword}}",
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({ status: 422 });
    expect(receivedValues("password", "password")).toEqual([ALICE_PASSWORD]);
  }, 90_000);

  test("signup with a generated password that meets the rules, then a password change", async () => {
    vault["Newbie/password"] = SIGNUP_PASSWORD;
    const browser = await ProductBrowser.open(`${site.url}/signup`);
    await browser.act({
      type: "fill",
      locator: css("#username"),
      value: "newbie",
    });
    await browser.act({
      type: "fill",
      locator: css("#password"),
      value: "{{secret:Newbie/password}}",
    });
    await browser.act({
      type: "fill",
      locator: css("#confirm"),
      value: "{{secret:Newbie/password}}",
    });
    await browser.act({ type: "click", locator: css("#create-account") });
    await expectLoggedIn(browser, "newbie", "signup");
    await browser.shot("signup-success");
    expect(receivedValues("signup", "password")).toEqual([SIGNUP_PASSWORD]);

    // Rotate: the vault now holds the new value and keeps the old as #previous.
    vault["Newbie/password#previous"] = SIGNUP_PASSWORD;
    vault["Newbie/password"] = CHANGED_PASSWORD;
    await browser.goto("/password-change");
    await browser.act({
      type: "fill",
      locator: css("#current"),
      value: "{{secret:Newbie/password#previous}}",
    });
    await browser.act({
      type: "fill",
      locator: css("#password"),
      value: "{{secret:Newbie/password}}",
    });
    await browser.act({
      type: "fill",
      locator: css("#confirm"),
      value: "{{secret:Newbie/password}}",
    });
    await browser.act({ type: "click", locator: css("#change-password") });
    await browser.waitForText((text) => text.includes("Password changed"));
    await browser.shot("password-change-success");
    expect(site.account("newbie")?.password).toBe(CHANGED_PASSWORD);
    await browser.end();

    const again = await ProductBrowser.open(`${site.url}/password`);
    await passwordLogin(again, "newbie", "{{secret:Newbie/password}}");
    await expectLoggedIn(again, "newbie", "password");
  }, 120_000);

  test("TOTP enrollment: save the setup key, confirm with a dispatch-time code, then log in", async () => {
    const browser = await ProductBrowser.open(`${site.url}/password`);
    await passwordLogin(browser, "alice", "{{secret:Fake Alice/password}}");
    await expectLoggedIn(browser, "alice", "password");
    await browser.goto("/totp/enroll");
    const seedText = await browser.waitForText((text) => /\b[A-Z2-7]{32}\b/u.test(text));
    const seed = /\b([A-Z2-7]{32})\b/u.exec(seedText)![1]!;
    await browser.shot("totp-enroll");
    // The agent saves the setup key into the vault (secret_save in production).
    // The page itself displays the key, so it is not a leak canary here.
    vault["Fake Alice"] = seed;
    await browser.act({
      type: "fill",
      locator: css("#code"),
      value: "{{secret:Fake Alice/otp}}",
    });
    await browser.act({ type: "click", locator: css("#verify-code") });
    await browser.waitForText((text) => text.toLowerCase().includes("enabled"));
    await browser.shot("totp-enroll-success");
    expect(site.account("alice")?.totpSecret).toBe(seed);
    await browser.end();

    const login = await ProductBrowser.open(`${site.url}/totp/login`);
    await passwordLogin(login, "totp-user", "{{secret:Fake TOTP/password}}", "/totp/login");
    await login.waitForText((text) => /code/iu.test(text));
    await login.shot("totp-login-code");
    await login.act({
      type: "fill",
      locator: css("#code"),
      value: "{{secret:Fake TOTP/otp}}",
    });
    await login.act({ type: "click", locator: css("#verify-code") });
    await expectLoggedIn(login, "totp-user", "totp");
    await login.shot("totp-login-success");
    const [code] = receivedValues("totp", "code");
    expect(code).toMatch(/^\d{6}$/u);
    const now = Date.now();
    expect(
      [-30_000, 0, 30_000].map((skew) => totpCodeSync(parseTotpInput(TOTP_SEED), now + skew)),
    ).toContain(code!);
  }, 120_000);

  test("email code: the code from the fake mailbox signs in", async () => {
    const browser = await ProductBrowser.open(`${site.url}/email-code`);
    await browser.act({
      type: "fill",
      locator: css("#email"),
      value: "alice@fake-login.test",
    });
    await browser.act({ type: "click", locator: css("#send-code") });
    await browser.waitForText((text) => text.includes("alice@fake-login.test"));
    const mail = (await (await fetch(`${site.mailApiUrl}?to=alice@fake-login.test`)).json()) as {
      messages: { body: string }[];
    };
    const code = /sign-in code is (\d{6})/u.exec(mail.messages.at(-1)!.body)![1]!;
    // A one-time emailed code is not a vault secret; the agent types what it read.
    await browser.act({ type: "fill", locator: css("#code"), value: code });
    await browser.act({ type: "click", locator: css("#verify-code") });
    await expectLoggedIn(browser, "alice", "email-code");
    await browser.shot("email-code-success");
    expect(receivedValues("email-code", "code")).toEqual([code]);
  }, 90_000);

  test("split OTP boxes: insert mode is discarded, keys mode with a TOTP reference signs in", async () => {
    const browser = await ProductBrowser.open(`${site.url}/otp-split`);
    await passwordLogin(browser, "totp-user", "{{secret:Fake TOTP/password}}", "/otp-split");
    await browser.waitForText((text) => /digit|code/iu.test(text));
    await browser.act({ type: "click", locator: css("#otp-0") });
    await browser.act({ type: "type", text: "123456" });
    await browser.shot("otp-split-insert-rejected");
    expect(site.state().successes.some((success) => success.flow === "otp-split")).toBe(false);
    await browser.act({ type: "click", locator: css("#otp-0") });
    await browser.act({
      type: "type",
      text: "{{secret:Fake TOTP/otp}}",
      mode: "keys",
    });
    await expectLoggedIn(browser, "totp-user", "otp-split");
    await browser.shot("otp-split-success");
  }, 90_000);

  test("a page that echoes the typed value gets a redacted receipt", async () => {
    const page = `<!doctype html><title>Echo</title>
      <input aria-label="Field"><p id="echo" aria-live="polite"></p>
      <script>document.querySelector('input').addEventListener('input', (event) => {
        document.getElementById('echo').textContent = 'You typed ' + event.target.value;
      });</script>`;
    const browser = await ProductBrowser.open(`data:text/html,${encodeURIComponent(page)}`);
    const receipt = await browser.act({
      type: "fill",
      locator: { kind: "role", role: "textbox", name: "Field" },
      value: "{{secret:Echo/value}}",
    });
    expect(JSON.stringify(receipt)).not.toContain(ECHO_CANARY);
    expect(texts(receipt)).toContain("You typed [secret]");
    // The page itself shows the value; a later plain observation is not
    // redacted, so end the session here without observing again.
    await browser.end();
  }, 60_000);

  test("no plaintext in browserd responses or the browserd state root (journal)", async () => {
    // Dispatch-time TOTP codes went through the side map too. They are too
    // short for the W7 scanner's needles, so they get a plain substring check.
    const codes = new Map<string, string>();
    for (const entry of site.received()) {
      if (
        ["totp", "totp-enroll", "otp-split"].includes(entry.flow) &&
        /^\d{6}$/u.test(entry.value)
      ) {
        codes.set(`${entry.flow} code`, entry.value);
      }
    }
    expect(codes.size).toBe(3);
    const needles = needlesFor([...plaintexts].map(([label, value]) => ({ label, value })));
    const hits: Hit[] = [];
    const codeHits: Array<{ location: string; label: string }> = [];
    const scanCodes = (location: string, body: string) => {
      for (const [label, code] of codes) {
        if (body.includes(`"${code}"`) || body.includes(`value":"${code}`)) {
          codeHits.push({ location, label });
        }
      }
    };
    responses.forEach((body, index) => {
      hits.push(...scanBuffer(`response#${index}`, body, needles));
      scanCodes(`response#${index}`, body);
    });
    const files = walk(join(rootDirectory, "state"));
    const journalFiles = files.filter((path) => !path.includes("/profile/"));
    for (const path of journalFiles) {
      if (statSync(path).size > 64 * 1024 * 1024) continue;
      const bytes = readFileSync(path);
      hits.push(...scanBuffer(path.slice(rootDirectory.length), bytes, needles));
      scanCodes(path.slice(rootDirectory.length), bytes.toString("latin1"));
    }
    const profileHits: Hit[] = [];
    for (const path of files.filter((candidate) => candidate.includes("/profile/"))) {
      if (statSync(path).size > 64 * 1024 * 1024) continue;
      profileHits.push(
        ...scanBuffer(path.slice(rootDirectory.length), readFileSync(path), needles),
      );
    }
    const report = {
      mode,
      responsesScanned: responses.length,
      journalFilesScanned: journalFiles.length,
      // Replies where browserd replaced a side-map value with "[secret]"
      // (e.g. the TOTP code shown as the value of a text box).
      redactedResponses: responses.filter((body) => body.includes("[secret]")).length,
      knownValues: [...plaintexts.keys(), ...codes.keys()],
      hits,
      codeHits,
      // The Chromium profile holds the site's own state (cookies, form history);
      // reported for information, not part of the controller's journal.
      profileHits,
    };
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      writeFileSync(join(shotsDir, `${mode}-leak-scan.json`), JSON.stringify(report, null, 2));
    }
    expect(responses.length).toBeGreaterThan(20);
    expect(journalFiles.length).toBeGreaterThan(0);
    expect(report.redactedResponses).toBeGreaterThan(0);
    expect(hits).toEqual([]);
    expect(codeHits).toEqual([]);
  });
});
