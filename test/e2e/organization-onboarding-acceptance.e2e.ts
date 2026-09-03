import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type {
  ManagedEmailDeliveryResult,
  ManagedEmailMessage,
  ManagedEmailTransport,
  SessionWorkflowClient,
} from "@opengeni/core";
import { createDb, provisionRoles, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  previewOrganizationUserSetup,
  retryOrganizationUserSetupDelivery,
} from "@opengeni/sdk/organization-user-setup";
import {
  acquireOwnerMigratedTestDatabase,
  freePort,
  MemoryEventBus,
  testSettings,
  waitFor,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import { createApp } from "../../apps/api/src/app";
import {
  InMemoryManagedEmailTransport,
  type CapturedManagedEmail,
} from "../../apps/api/src/auth/managed-email";
import {
  isExpectedDisabledMachinesConsoleError,
  isExpectedDisabledMachinesResponse,
} from "./knowledge-surfaces.diagnostics";

const repoRoot = new URL("../..", import.meta.url).pathname;
const RUN_ID = crypto.randomUUID();
const EVIDENCE_DIR =
  process.env.OPENGENI_ONBOARDING_EVIDENCE_DIR ?? "/tmp/opengeni-onboarding-evidence";
const PASSWORD = "Onboarding-password-1234";
const RESET_PASSWORD = "Onboarding-reset-password-5678";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

type ScriptedOutcome = Exclude<ManagedEmailDeliveryResult, { status: "sent" }>;

class ScriptableManagedEmailTransport implements ManagedEmailTransport {
  readonly sender = "OpenGeni Acceptance <acceptance@example.test>";
  readonly idempotency = {
    scope: "opengeni-onboarding-acceptance-v1",
    retentionSeconds: 86_400,
  } as const;
  private readonly capture = new InMemoryManagedEmailTransport({
    maxMessages: 80,
    ttlMs: 10 * 60_000,
    sender: this.sender,
    idempotency: this.idempotency,
  });
  private readonly outcomes: ScriptedOutcome[] = [];
  readonly attempts: Array<{
    kind: ManagedEmailMessage["kind"];
    to: string;
    idempotencyKey: string | null;
    outcome: ManagedEmailDeliveryResult["status"];
  }> = [];

  enqueue(...outcomes: ScriptedOutcome[]): void {
    this.outcomes.push(...outcomes);
  }

  async send(message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult> {
    const scripted = this.outcomes.shift();
    const result = scripted ?? (await this.capture.send(message));
    this.attempts.push({
      kind: message.kind,
      to: message.to,
      idempotencyKey: message.idempotencyKey ?? null,
      outcome: result.status,
    });
    return result;
  }

  take(kind: ManagedEmailMessage["kind"], to: string): CapturedManagedEmail | null {
    return this.capture.take((message) => message.kind === kind && message.to === to);
  }

  size(): number {
    return this.capture.size();
  }
}

type BrowserProblems = {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
};

type OnboardingState = {
  ownerEmail: string;
  ownerUserId: string;
  ownerCookie: string;
  ownerSubjectId: string;
  organizationId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
  sharedWorkspaceUpdatedAt: string;
  invitationId: string;
  invitationRevision: number;
  invitedEmail: string;
  invitedUserId: string;
  invitedCookie: string;
  invitedSubjectId: string;
  invitedMembershipId: string;
  invitedPersonalWorkspaceId: string;
  setupToken: string;
};

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let browser: Browser | null = null;
let edge: ReturnType<typeof Bun.serve> | null = null;
let publicOrigin = "";
let transport: ScriptableManagedEmailTransport;
let state: Partial<OnboardingState> = {};

function requiredState<K extends keyof OnboardingState>(key: K): OnboardingState[K] {
  const value = state[key];
  if (value === undefined || value === "") throw new Error(`missing onboarding state: ${key}`);
  return value as OnboardingState[K];
}

function appDatabaseUrl(fixture: OwnerMigratedTestDatabase): string {
  const value = new URL(fixture.ownerUrl);
  value.username = "opengeni_app";
  value.password = fixture.appPassword;
  return value.toString();
}

function workflowStub(): SessionWorkflowClient {
  const noop = async () => undefined;
  return {
    signalUserMessage: noop,
    wakeSessionWorkflow: noop,
    requestSessionWorkflowWakeDispatch: noop,
    signalApprovalDecision: noop,
    signalSessionControl: noop,
    syncScheduledTask: noop,
    deleteScheduledTaskSchedule: noop,
    triggerScheduledTask: noop,
  } as unknown as SessionWorkflowClient;
}

function observeBrowser(page: Page): BrowserProblems {
  const problems: BrowserProblems = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };
  const expectedDisabledMachinesResponseUrls = new Set<string>();
  page.on("response", (response) => {
    if (
      isExpectedDisabledMachinesResponse(
        {
          status: response.status(),
          method: response.request().method(),
          url: response.url(),
        },
        false,
      )
    ) {
      expectedDisabledMachinesResponseUrls.add(response.url());
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const locationUrl = message.location().url;
    if (
      isExpectedDisabledMachinesConsoleError(
        { text: message.text(), locationUrl },
        false,
        expectedDisabledMachinesResponseUrls,
      )
    ) {
      expectedDisabledMachinesResponseUrls.delete(locationUrl);
      return;
    }
    problems.consoleErrors.push(`${message.text()}${locationUrl ? ` @ ${locationUrl}` : ""}`);
  });
  page.on("pageerror", (error) => problems.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    problems.failedRequests.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
    );
  });
  return problems;
}

function isExpectedNavigationReadCancellation(problem: string): boolean {
  const match = /^GET (https?:\/\/[^/]+)(\/[^:]*): net::ERR_ABORTED$/u.exec(problem);
  if (!match || match[1] !== publicOrigin) return false;
  const pathname = new URL(`${match[1]}${match[2]}`).pathname;
  return (
    pathname === "/v1/config/client" ||
    pathname === "/v1/auth/get-session" ||
    /^\/v1\/workspaces\/[0-9a-f-]+\/(?:realtime-)?model-catalog$/u.test(pathname) ||
    /^\/v1\/workspaces\/[0-9a-f-]+\/(?:sessions|machines|new-session-draft)$/u.test(pathname) ||
    /^\/v1\/workspaces\/[0-9a-f-]+\/live-events\/stream$/u.test(pathname)
  );
}

function expectNoBrowserProblems(problems: BrowserProblems): void {
  const failedRequests = problems.failedRequests.filter(
    (problem) => !isExpectedNavigationReadCancellation(problem),
  );
  expect({ ...problems, failedRequests }).toEqual({
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  });
}

async function expectNoAxeViolations(page: Page, include = "body"): Promise<void> {
  const report = await new AxeBuilder({ page })
    .include(include)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    report.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

async function settleDocumentAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextFrame = async () =>
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    for (let pass = 0; pass < 8; pass += 1) {
      await nextFrame();
      const running = document
        .getAnimations()
        .filter((animation) => animation.playState === "running");
      if (running.length > 0) {
        await Promise.all(
          running.map(async (animation) => {
            try {
              await animation.finished;
            } catch {
              // A replaced animation is already settled for this visual gate.
            }
          }),
        );
        continue;
      }
      await nextFrame();
      await nextFrame();
      if (document.getAnimations().every((animation) => animation.playState !== "running")) return;
    }
    throw new Error("document animations did not settle");
  });
}

async function cookieHeader(context: BrowserContext): Promise<string> {
  return (await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function sdk(cookie: string, clientIp?: string): OpenGeniClient {
  return new OpenGeniClient({
    baseUrl: publicOrigin,
    headers: {
      cookie,
      ...(clientIp ? { "x-forwarded-for": clientIp } : {}),
    },
  });
}

async function takeEmail(
  kind: ManagedEmailMessage["kind"],
  to: string,
): Promise<CapturedManagedEmail> {
  let captured: CapturedManagedEmail | null = null;
  await waitFor(
    async () => {
      captured = transport.take(kind, to);
      return captured !== null;
    },
    { timeoutMs: 20_000, intervalMs: 25 },
  );
  if (!captured) throw new Error(`missing ${kind} email for ${to}`);
  return captured;
}

function firstUrl(message: CapturedManagedEmail): string {
  const match = message.text.match(/https?:\/\/[^\s<]+/);
  if (!match) throw new Error(`email did not contain a URL: ${message.subject}`);
  return match[0]!;
}

function setupToken(message: CapturedManagedEmail): string {
  const url = new URL(firstUrl(message));
  const token =
    url.searchParams.get("token") ?? new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("organization setup URL did not contain a token");
  return token;
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(publicOrigin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
}

async function signUpAndVerify(page: Page, input: { name: string; email: string }): Promise<void> {
  await page.goto(publicOrigin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByLabel("Name").fill(input.name);
  await page.getByLabel("Email").fill(input.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByText(`We sent a verification link to ${input.email}.`).waitFor();
  const verification = await takeEmail("email_verification", input.email);
  const verificationUrl = firstUrl(verification);
  expect(verificationUrl.startsWith(`${publicOrigin}/v1/auth/verify-email?`)).toBe(true);
  await page.goto(verificationUrl, { waitUntil: "domcontentloaded" });
  const authOrOnboarding = page
    .locator("h1")
    .filter({ hasText: /^(Sign in|Create your organization)$/ })
    .first();
  await authOrOnboarding.waitFor();
  if ((await authOrOnboarding.textContent())?.trim() === "Sign in") {
    await signIn(page, input.email, PASSWORD);
  }
}

async function databaseUserId(email: string): Promise<string> {
  if (!owned) throw new Error("test database unavailable");
  const [row] = await owned.admin<Array<{ id: string }>>`
    select id from auth_users where lower(email) = lower(${email})`;
  if (!row) throw new Error(`auth user missing for ${email}`);
  return row.id;
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("organization-onboarding-acceptance");
  if (!owned) {
    throw new Error(
      requireRealDatabase
        ? "Organization onboarding acceptance requires PostgreSQL"
        : "Organization onboarding acceptance is opt-in and never skips a missing PostgreSQL fixture",
    );
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const databaseUrl = appDatabaseUrl(owned);
  client = createDb(databaseUrl, { max: 16, rlsStrategy: "force" });

  // A committed product witness makes the following account lifecycle truly
  // greenfield for 0349. It contains no human identity or workspace grant.
  const witnessAccountId = crypto.randomUUID();
  await owned.admin`
    insert into managed_accounts (id, name)
    values (${witnessAccountId}, 'Onboarding committed activation witness')`;
  await owned.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest,
      activated_by, backfill_receipt_ids
    ) values (
      ${witnessAccountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)},
      'test:onboarding-committed-product-witness', array[]::uuid[]
    )`;

  publicOrigin = `http://127.0.0.1:${await freePort()}`;
  transport = new ScriptableManagedEmailTransport();
  const settings = testSettings({
    environment: "test",
    productAccessMode: "managed",
    databaseUrl,
    rlsStrategy: "force",
    runtimeDatabaseRole: "opengeni_app",
    publicBaseUrl: publicOrigin,
    betterAuthSecret: "onboarding-browser-better-auth-secret-at-least-32-bytes",
    organizationUserSetupEmailTokenTransport: "query",
    sandboxBackend: "none",
  });
  const api = createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: workflowStub(),
    managedEmailTransport: transport,
  });

  const extensionBuild = Bun.spawn(["bun", "run", "build"], {
    cwd: `${repoRoot}/apps/browser-extension`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await extensionBuild.exited) !== 0) {
    throw new Error(
      `Onboarding browser extension build failed: ${await new Response(extensionBuild.stderr).text()}`,
    );
  }
  const build = Bun.spawn(["bun", "run", "vite", "build"], {
    cwd: `${repoRoot}/apps/web`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      VITE_API_BASE_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    throw new Error(`Onboarding web build failed: ${await new Response(build.stderr).text()}`);
  }
  const webDist = `${repoRoot}/apps/web/dist`;
  edge = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(new URL(publicOrigin).port),
    idleTimeout: 60,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
        return await api.fetch(request);
      }
      const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const requested = safePath.includes("..") ? null : Bun.file(`${webDist}/${safePath}`);
      const asset =
        requested && (await requested.exists()) ? requested : Bun.file(`${webDist}/index.html`);
      return new Response(asset, { headers: { "content-type": asset.type } });
    },
  });
  browser = await chromium.launch(
    process.env.OPENGENI_BROWSER_BIN
      ? { executablePath: process.env.OPENGENI_BROWSER_BIN }
      : undefined,
  );
  await mkdir(EVIDENCE_DIR, { recursive: true });
}, 900_000);

afterAll(async () => {
  edge?.stop(true);
  await browser?.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("organization onboarding with real Better Auth / Hono / SDK / PostgreSQL", () => {
  test("named signup creates only owner + Personal, activates private sessions, and administers shared workspaces", async () => {
    if (!browser || !owned) throw new Error("acceptance harness unavailable");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    const page = await context.newPage();
    const problems = observeBrowser(page);
    const ownerEmail = `onboarding-owner-${RUN_ID}@example.test`;

    await signUpAndVerify(page, { name: "Onboarding Owner", email: ownerEmail });
    await page.getByRole("heading", { name: "Create your organization" }).waitFor();
    expect(await page.getByLabel("Organization name").count()).toBe(1);
    expect(await page.getByLabel(/workspace/i).count()).toBe(0);
    expect(await page.getByText(/create another organization/i).count()).toBe(0);
    await page.getByLabel("Organization name").fill("Onboarding Greenfield Org");
    const setupSettled = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/v1/auth/organization-onboarding",
    );
    await page.getByRole("button", { name: "Create organization" }).click();
    expect((await setupSettled).ok()).toBe(true);

    const ownerCookie = await cookieHeader(context);
    const owner = sdk(ownerCookie);
    const memberships = await owner.listOrganizationMemberships();
    expect(memberships.memberships).toHaveLength(1);
    const organizationId = memberships.memberships[0]!.organizationId;
    const personalWorkspaceId = memberships.memberships[0]!.personalWorkspaceId;
    const ownerUserId = await databaseUserId(ownerEmail);
    const ownerSubjectId = `user:${ownerUserId}`;
    state = {
      ...state,
      ownerEmail,
      ownerUserId,
      ownerCookie,
      ownerSubjectId,
      organizationId,
      personalWorkspaceId,
    };

    const [graph] = await owned.admin<
      Array<{
        memberships: number;
        personalWorkspaces: number;
        workspaceMemberships: number;
        controls: number;
        activations: number;
        evidence: number;
        privateSettings: number;
      }>
    >`
      select
        (select count(*)::int from organization_memberships where account_id = ${organizationId}) as memberships,
        (select count(*)::int from workspaces where account_id = ${organizationId} and id = ${personalWorkspaceId}) as "personalWorkspaces",
        (select count(*)::int from workspace_memberships where account_id = ${organizationId}) as "workspaceMemberships",
        (select count(*)::int from workspace_inference_controls where account_id = ${organizationId}) as controls,
        (select count(*)::int from session_tenancy_activations where account_id = ${organizationId}) as activations,
        (select count(*)::int from session_tenancy_greenfield_activation_evidence where account_id = ${organizationId}) as evidence,
        (select count(*)::int from organization_private_session_settings where account_id = ${organizationId} and enabled) as "privateSettings"`;
    expect(graph).toEqual({
      memberships: 1,
      personalWorkspaces: 1,
      workspaceMemberships: 0,
      controls: 1,
      activations: 1,
      evidence: 1,
      privateSettings: 1,
    });

    const session = await owner.createSession(personalWorkspaceId, {
      initialMessage: "Onboarding immediate private session",
      visibility: "private",
      idempotencyKey: crypto.randomUUID(),
      sandboxBackend: "none",
    });
    const sessionDetail = await owner.getSession(personalWorkspaceId, session.id);
    expect(sessionDetail.tenancy).toMatchObject({
      visibility: "private",
      authorityEpoch: 1,
      ownedByCurrentUser: true,
    });
    const [privateSession] = await owned.admin<Array<{ visibility: string }>>`
      select visibility from sessions where id = ${session.id}`;
    expect(privateSession?.visibility).toBe("user_private");

    await page.goto(
      `${publicOrigin}/workspaces/${personalWorkspaceId}/organization?section=overview`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByRole("heading", { name: "Workspaces & access" }).waitFor();
    await page.getByRole("button", { name: "Create new workspace" }).click();
    await page.getByLabel("New workspace name").fill("Launch Room");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.getByText("Launch Room created").waitFor();
    const launchDetails = page.locator("details", { hasText: "Launch Room" }).first();
    await launchDetails.locator("summary").click();
    await page.getByLabel("Workspace name for Launch Room").fill("Launch Operations");
    await launchDetails.getByRole("button", { name: "Save name" }).click();
    await page.getByText("Workspace name updated").waitFor();

    const overview = await owner.getOrganizationAdministrationOverview(organizationId);
    expect(overview.workspaces).toHaveLength(1);
    expect(overview.workspaces[0]!.name).toBe("Launch Operations");
    state = {
      ...state,
      sharedWorkspaceId: overview.workspaces[0]!.id,
      sharedWorkspaceUpdatedAt: overview.workspaces[0]!.updatedAt,
    };

    const peopleUrl = `${publicOrigin}/workspaces/${personalWorkspaceId}/organization?section=people`;
    await page.goto(peopleUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "People", exact: true }).waitFor();
    const soleOwnerRole = page.getByLabel("Organization role for Onboarding Owner (you)");
    expect(await soleOwnerRole.isDisabled()).toBe(true);
    expect(await soleOwnerRole.getAttribute("aria-describedby")).toMatch(/^sole-owner-reason-/);
    await page.getByText(/Assign another active owner/i).waitFor();
    expect(await page.getByText("Personal content stays personal").count()).toBe(1);
    await expectNoAxeViolations(page, "body");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `${EVIDENCE_DIR}/onboarding-owner-desktop-1440.png`,
      fullPage: true,
    });
    expectNoBrowserProblems(problems);
    await context.close();
  }, 180_000);

  test("unregistered invitation previews exact grants, scrubs its bearer, and joins without a redundant organization", async () => {
    if (!browser || !owned) throw new Error("acceptance harness unavailable");
    const organizationId = requiredState("organizationId");
    const personalWorkspaceId = requiredState("personalWorkspaceId");
    const sharedWorkspaceId = requiredState("sharedWorkspaceId");
    const ownerContext = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
    await ownerContext.addCookies([
      {
        name: "better-auth.session_token",
        value: new URLSearchParams(requiredState("ownerCookie").replaceAll("; ", "&")).get(
          "better-auth.session_token",
        )!,
        url: publicOrigin,
        sameSite: "Lax",
      },
    ]);
    const ownerPage = await ownerContext.newPage();
    const ownerProblems = observeBrowser(ownerPage);
    const invitedEmail = `onboarding-invited-${RUN_ID}@example.test`;
    await ownerPage.goto(
      `${publicOrigin}/workspaces/${personalWorkspaceId}/organization?section=people`,
      { waitUntil: "domcontentloaded" },
    );
    await ownerPage.getByRole("heading", { name: "People & invitations", level: 2 }).waitFor();
    await ownerPage.getByRole("button", { name: "Invite person", exact: true }).click();
    await ownerPage.getByLabel("Email address").fill(invitedEmail);
    await ownerPage.getByLabel("Name", { exact: true }).fill("Onboarding Invited");
    await ownerPage.getByText("Workspace access", { exact: true }).click();
    await ownerPage.getByLabel("Launch Operations", { exact: true }).check();
    await ownerPage.getByRole("button", { name: "Send invitation", exact: true }).click();
    await ownerPage.getByText("Invitation sent", { exact: true }).waitFor();

    const setupEmail = await takeEmail("organization_user_setup", invitedEmail);
    const token = setupToken(setupEmail);
    expect(setupEmail.text).toContain("Launch Operations: Member");
    expect(setupEmail.text).toContain("never shares anyone's Personal workspace");
    const invitations = await sdk(
      requiredState("ownerCookie"),
    ).listOrganizationInvitationsForOrganization(organizationId, { limit: 50 });
    const invitation = invitations.invitations.find((item) => item.targetEmail === invitedEmail);
    expect(invitation?.initialWorkspaceIds).toEqual([sharedWorkspaceId]);
    expect(invitation?.delivery?.state).toBe("sent");
    if (!invitation) throw new Error("unregistered invitation was not durably listed");
    state = {
      ...state,
      invitationId: invitation.id,
      invitationRevision: invitation.revision,
      invitedEmail,
      setupToken: token,
    };
    expect(
      await previewOrganizationUserSetup(sdk(requiredState("ownerCookie")), {
        token,
      }),
    ).toMatchObject({
      state: "pending",
      organizationId,
      organizationName: "Onboarding Greenfield Org",
      targetEmail: invitedEmail,
      organizationRole: "member",
      sharedWorkspaceAccess: [
        { workspaceId: sharedWorkspaceId, workspaceName: "Launch Operations", role: "member" },
      ],
    });

    const signedOut = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const setupPage = await signedOut.newPage();
    const setupProblems = observeBrowser(setupPage);
    await setupPage.goto(firstUrl(setupEmail), {
      waitUntil: "domcontentloaded",
    });
    await setupPage.getByRole("heading", { name: "Join Onboarding Greenfield Org" }).waitFor();
    let observedSetupCopy = "";
    await waitFor(
      async () => {
        const copy = (await setupPage.locator("body").textContent()) ?? "";
        observedSetupCopy = copy;
        return (
          copy.includes("Launch Operations") ||
          copy.includes("couldn't check") ||
          copy.includes("setup link") ||
          copy.includes("invitation was revoked")
        );
      },
      {
        timeoutMs: 30_000,
        intervalMs: 50,
        describe: () =>
          JSON.stringify({
            copy: observedSetupCopy,
            url: setupPage.url(),
            problems: setupProblems,
          }),
      },
    );
    expect(setupPage.url()).toBe(`${publicOrigin}/setup-account`);
    expect(await setupPage.locator("body").textContent()).not.toContain(token);
    const setupCopy = await setupPage.locator("body").textContent();
    expect(setupCopy).toContain("Launch Operations: Member");
    expect(setupCopy).toContain("Onboarding Greenfield Org");
    expect(setupCopy).toContain(invitedEmail);
    await setupPage.getByText("This does not share anyone's Personal workspace.").waitFor();
    await expectNoAxeViolations(setupPage, "body");
    expect(await setupPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await setupPage.screenshot({
      path: `${EVIDENCE_DIR}/onboarding-setup-mobile-390.png`,
      fullPage: true,
    });
    await setupPage.getByLabel("Your name").fill("Onboarding Invited");
    await setupPage.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await setupPage.getByLabel("Confirm password").fill(PASSWORD);
    await setupPage.getByRole("button", { name: "Create account and join" }).click();
    await setupPage
      .getByText("Your email is verified and your organization access is ready.")
      .waitFor();
    await expectNoAxeViolations(setupPage, "body");
    expect(await setupPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await setupPage.getByRole("link", { name: "Sign in" }).click();
    await signIn(setupPage, invitedEmail, PASSWORD);
    await setupPage.waitForURL(/\/workspaces\//, { timeout: 20_000 });

    const invitedCookie = await cookieHeader(signedOut);
    const invited = sdk(invitedCookie);
    const memberships = await invited.listOrganizationMemberships();
    expect(memberships.memberships).toHaveLength(1);
    expect(memberships.memberships[0]!.organizationId).toBe(organizationId);
    const invitedPersonalWorkspaceId = memberships.memberships[0]!.personalWorkspaceId;
    const invitedUserId = await databaseUserId(invitedEmail);
    const invitedSubjectId = `user:${invitedUserId}`;
    const members = await sdk(requiredState("ownerCookie")).listOrganizationAdministrationMembers(
      organizationId,
    );
    const invitedMember = members.members.find((member) => member.subjectId === invitedSubjectId);
    if (!invitedMember) throw new Error("invited member missing after account setup");
    state = {
      ...state,
      invitedCookie,
      invitedUserId,
      invitedSubjectId,
      invitedMembershipId: invitedMember.id,
      invitedPersonalWorkspaceId,
    };

    const [joined] = await owned.admin<
      Array<{
        organizations: number;
        personalWorkspaces: number;
        initialSharedMemberships: number;
        otherPersonalMemberships: number;
        completedIntents: number;
        deliveryAttempts: number;
      }>
    >`
      select
        (select count(*)::int from organization_memberships where subject_id = ${invitedSubjectId}) as organizations,
        (select count(*)::int from workspaces where account_id = ${organizationId} and id = ${invitedPersonalWorkspaceId}) as "personalWorkspaces",
        (select count(*)::int from workspace_memberships where subject_id = ${invitedSubjectId} and workspace_id = ${sharedWorkspaceId}) as "initialSharedMemberships",
        (select count(*)::int from workspace_memberships membership where membership.subject_id = ${invitedSubjectId} and membership.workspace_id in (select personal_workspace_id from organization_memberships where personal_workspace_id is not null)) as "otherPersonalMemberships",
        (select count(*)::int from organization_user_setup_intents where invitation_id = ${invitation.id} and status = 'completed') as "completedIntents",
        (select count(*)::int from organization_user_setup_delivery_attempts attempt join organization_user_setup_deliveries delivery on delivery.id = attempt.delivery_id where delivery.invitation_id = ${invitation.id}) as "deliveryAttempts"`;
    expect(joined).toEqual({
      organizations: 1,
      personalWorkspaces: 1,
      initialSharedMemberships: 1,
      otherPersonalMemberships: 0,
      completedIntents: 1,
      deliveryAttempts: expect.any(Number),
    });
    expect(joined!.deliveryAttempts).toBeGreaterThan(0);

    const [completion] = await owned.admin<Array<{ operationId: string }>>`
      select completion_operation_id as "operationId"
      from organization_user_setup_intents
      where invitation_id = ${invitation.id}`;
    if (!completion) throw new Error("completed setup operation was not retained");
    const replayHeaders = {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.40",
    };
    const exactCompletionReplay = await fetch(`${publicOrigin}/v1/auth/organization-setup`, {
      method: "POST",
      headers: replayHeaders,
      body: JSON.stringify({
        token,
        name: "Onboarding Invited",
        password: PASSWORD,
        operationId: completion.operationId,
      }),
    });
    expect(exactCompletionReplay.status).toBe(200);
    const changedCompletionReplay = await fetch(`${publicOrigin}/v1/auth/organization-setup`, {
      method: "POST",
      headers: replayHeaders,
      body: JSON.stringify({
        token,
        name: "Changed invited identity",
        password: PASSWORD,
        operationId: completion.operationId,
      }),
    });
    expect(changedCompletionReplay.status).toBe(409);

    expectNoBrowserProblems(ownerProblems);
    expectNoBrowserProblems(setupProblems);
    expect(transport.size()).toBeLessThanOrEqual(80);
    await ownerContext.close();
    await signedOut.close();
  }, 180_000);

  test("covers SDK grant/revoke, registered invite, password reset, retry/replay fences, direct RLS, and 320px UI", async () => {
    if (!browser || !owned) throw new Error("acceptance harness unavailable");
    const organizationId = requiredState("organizationId");
    const sharedWorkspaceId = requiredState("sharedWorkspaceId");
    const invitedMembershipId = requiredState("invitedMembershipId");
    const owner = sdk(requiredState("ownerCookie"));
    const setupPreviewClient = sdk(requiredState("ownerCookie"), "198.51.100.41");
    const invited = sdk(requiredState("invitedCookie"));
    const admittedSharedSession = await invited.createSession(sharedWorkspaceId, {
      initialMessage: "Onboarding authority-revocation fence",
      idempotencyKey: crypto.randomUUID(),
      sandboxBackend: "none",
    });

    const secondWorkspace = await owner.createOrganizationWorkspace(organizationId, {
      name: "Security Review",
      operationId: crypto.randomUUID(),
    });
    const concurrentGrants = await Promise.allSettled([
      owner.putOrganizationWorkspaceMember(
        organizationId,
        secondWorkspace.id,
        invitedMembershipId,
        {
          role: "viewer",
          expectedUpdatedAt: null,
          operationId: crypto.randomUUID(),
        },
      ),
      owner.putOrganizationWorkspaceMember(
        organizationId,
        secondWorkspace.id,
        invitedMembershipId,
        {
          role: "member",
          expectedUpdatedAt: null,
          operationId: crypto.randomUUID(),
        },
      ),
    ]);
    expect(concurrentGrants.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentGrants.filter((result) => result.status === "rejected")).toHaveLength(1);
    const grantedResult = concurrentGrants.find((result) => result.status === "fulfilled");
    const rejectedGrant = concurrentGrants.find((result) => result.status === "rejected");
    if (grantedResult?.status !== "fulfilled")
      throw new Error("concurrent workspace grant did not commit a winner");
    const granted = grantedResult.value;
    expect(rejectedGrant).toMatchObject({
      status: "rejected",
      reason: { status: 409 },
    });
    expect(["viewer", "member"]).toContain(granted.role);
    const revoked = await owner.revokeOrganizationWorkspaceMember(
      organizationId,
      secondWorkspace.id,
      invitedMembershipId,
      {
        expectedUpdatedAt: granted.updatedAt,
        operationId: crypto.randomUUID(),
      },
    );
    expect(revoked.removed).toBe(true);

    const exactOperationId = crypto.randomUUID();
    const exactRequest = {
      email: `onboarding-replay-${RUN_ID}@example.test`,
      name: "Replay Target",
      role: "member" as const,
      initialWorkspaceIds: [sharedWorkspaceId],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operationId: exactOperationId,
    };
    const [first, exactReplay] = await Promise.all([
      owner.createOrganizationInvitation(organizationId, exactRequest),
      owner.createOrganizationInvitation(organizationId, exactRequest),
    ]);
    expect(exactReplay.id).toBe(first.id);
    await expect(
      owner.createOrganizationInvitation(organizationId, {
        ...exactRequest,
        name: "Changed Replay Target",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const replacement = await owner.createOrganizationInvitation(organizationId, {
      ...exactRequest,
      operationId: crypto.randomUUID(),
    });
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.status).toBe("pending");
    const replayHistory = await owner.listOrganizationInvitationsForOrganization(organizationId, {
      limit: 50,
    });
    expect(
      replayHistory.invitations.find((invitation) => invitation.id === first.id),
    ).toMatchObject({ status: "revoked", revision: first.revision + 1 });

    transport.enqueue({ status: "failed", errorClass: "injected_refusal" });
    const failed = await owner.createOrganizationInvitation(organizationId, {
      email: `onboarding-failed-${RUN_ID}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operationId: crypto.randomUUID(),
    });
    expect(failed.delivery?.state).toBe("failed");
    const retried = await retryOrganizationUserSetupDelivery(owner, organizationId, failed.id, {
      operationId: crypto.randomUUID(),
    });
    expect(retried.state).toBe("sent");
    const retryAttempts = transport.attempts.filter(
      (attempt) => attempt.to === failed.targetEmail && attempt.kind === "organization_user_setup",
    );
    expect(retryAttempts).toHaveLength(2);
    expect(new Set(retryAttempts.map((attempt) => attempt.idempotencyKey)).size).toBe(1);

    transport.enqueue({
      status: "outcome_unknown",
      errorClass: "injected_timeout",
    });
    const uncertain = await owner.createOrganizationInvitation(organizationId, {
      email: `onboarding-unknown-${RUN_ID}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operationId: crypto.randomUUID(),
    });
    expect(uncertain.delivery?.state).toBe("outcome_unknown");

    const revokedInvite = await owner.revokeOrganizationInvitation(organizationId, replacement.id, {
      expectedRevision: replacement.revision,
      operationId: crypto.randomUUID(),
    });
    expect(revokedInvite.status).toBe("revoked");
    const replayEmail = await takeEmail("organization_user_setup", exactRequest.email);
    expect(
      (
        await previewOrganizationUserSetup(setupPreviewClient, {
          token: setupToken(replayEmail),
        })
      ).state,
    ).toBe("revoked");
    const replacementEmail = await takeEmail("organization_user_setup", exactRequest.email);
    expect(
      (
        await previewOrganizationUserSetup(setupPreviewClient, {
          token: setupToken(replacementEmail),
        })
      ).state,
    ).toBe("revoked");

    const expiredEmail = `onboarding-expired-${RUN_ID}@example.test`;
    const expiredInvite = await owner.createOrganizationInvitation(organizationId, {
      email: expiredEmail,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operationId: crypto.randomUUID(),
    });
    const expiredSetup = await takeEmail("organization_user_setup", expiredEmail);
    await owned.admin`
      update organization_membership_invitations set expires_at = clock_timestamp() - interval '1 minute'
      where id = ${expiredInvite.id}`;
    await owned.admin`
      update organization_user_setup_intents set expires_at = clock_timestamp() - interval '1 minute'
      where invitation_id = ${expiredInvite.id}`;
    expect(
      (
        await previewOrganizationUserSetup(setupPreviewClient, {
          token: setupToken(expiredSetup),
        })
      ).state,
    ).toBe("expired");

    await expect(
      owner.updateOrganizationWorkspace(organizationId, sharedWorkspaceId, {
        name: "Stale write",
        expectedUpdatedAt: new Date(0).toISOString(),
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      owner.getOrganizationAdministrationOverview(crypto.randomUUID()),
    ).rejects.toMatchObject({ status: 404 });

    const alternateOwnerEmail = `onboarding-alternate-owner-${RUN_ID}@example.test`;
    const alternateContext = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      extraHTTPHeaders: { "x-forwarded-for": "198.51.100.50" },
    });
    const alternatePage = await alternateContext.newPage();
    const alternateProblems = observeBrowser(alternatePage);
    await signUpAndVerify(alternatePage, {
      name: "Onboarding Alternate Owner",
      email: alternateOwnerEmail,
    });
    await alternatePage.getByRole("heading", { name: "Create your organization" }).waitFor();
    const alternateOwner = sdk(await cookieHeader(alternateContext));
    const alternateCreated = await alternateOwner.createOrganization({
      name: "Onboarding Alternate Org",
      operationId: crypto.randomUUID(),
    });
    expect(alternateCreated.organization.name).toBe("Onboarding Alternate Org");
    const alternateMemberships = await alternateOwner.listOrganizationMemberships();
    expect(alternateMemberships.memberships).toHaveLength(1);
    const alternateOrganizationId = alternateCreated.organization.id;
    expect(alternateMemberships.memberships[0]!.organizationId).toBe(alternateOrganizationId);
    await expect(
      owner.getOrganizationAdministrationOverview(alternateOrganizationId),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      alternateOwner.getOrganizationAdministrationOverview(organizationId),
    ).rejects.toMatchObject({ status: 403 });

    const registeredEmail = `onboarding-registered-${RUN_ID}@example.test`;
    const registeredContext = await browser.newContext({
      viewport: { width: 320, height: 780 },
      extraHTTPHeaders: { "x-forwarded-for": "198.51.100.51" },
    });
    const registeredPage = await registeredContext.newPage();
    const registeredProblems = observeBrowser(registeredPage);
    await signUpAndVerify(registeredPage, {
      name: "Onboarding Registered",
      email: registeredEmail,
    });
    await registeredPage.getByRole("heading", { name: "Create your organization" }).waitFor();
    const registeredInvite = await owner.createOrganizationInvitation(organizationId, {
      email: registeredEmail,
      name: "Onboarding Registered",
      role: "member",
      initialWorkspaceIds: [sharedWorkspaceId],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      operationId: crypto.randomUUID(),
    });
    expect(registeredInvite.targetEmail).toBe(registeredEmail);
    const alternateInvite = await alternateOwner.createOrganizationInvitation(
      alternateOrganizationId,
      {
        email: registeredEmail,
        name: "Onboarding Registered",
        role: "member",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        operationId: crypto.randomUUID(),
      },
    );
    expect(alternateInvite.targetEmail).toBe(registeredEmail);
    const registeredInvitationEmails = [
      await takeEmail("organization_user_setup", registeredEmail),
      await takeEmail("organization_user_setup", registeredEmail),
    ];
    const alternateSetupEmail = registeredInvitationEmails.find((message) =>
      message.text.includes("Onboarding Alternate Org"),
    );
    if (!alternateSetupEmail) throw new Error("alternate invitation email was not captured");
    await registeredPage.reload({ waitUntil: "domcontentloaded" });
    await registeredPage.getByRole("heading", { name: "Invitation pending" }).waitFor();
    await registeredPage.getByText("Onboarding Greenfield Org").waitFor();
    await registeredPage.getByText("Onboarding Alternate Org").waitFor();
    const invitationChoices = registeredPage.locator("article");
    expect(await invitationChoices.count()).toBe(2);
    expect(
      await registeredPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expectNoAxeViolations(registeredPage, "body");
    await registeredPage.screenshot({
      path: `${EVIDENCE_DIR}/onboarding-registered-mobile-320.png`,
      fullPage: true,
    });
    await invitationChoices
      .filter({ hasText: "Onboarding Greenfield Org" })
      .getByRole("button", { name: "Join organization" })
      .click();
    await registeredPage.waitForURL(/\/workspaces\//, { timeout: 20_000 });
    const registeredCookie = await cookieHeader(registeredContext);
    const registeredMemberships = await sdk(registeredCookie).listOrganizationMemberships();
    expect(registeredMemberships.memberships).toHaveLength(1);
    expect(registeredMemberships.memberships[0]!.organizationId).toBe(organizationId);
    const remainingInvitations = await sdk(registeredCookie).listOrganizationInvitations({
      limit: 20,
    });
    expect(
      remainingInvitations.invitations.find((invitation) => invitation.id === alternateInvite.id),
    ).toMatchObject({
      organizationId: alternateOrganizationId,
      status: "pending",
    });
    await alternatePage.goto(firstUrl(alternateSetupEmail), { waitUntil: "domcontentloaded" });
    await alternatePage.getByRole("heading", { name: "Join Onboarding Alternate Org" }).waitFor();
    await alternatePage.getByRole("link", { name: `Sign in as ${registeredEmail}` }).click();
    await alternatePage
      .getByRole("heading", { name: `This invitation is for ${registeredEmail}` })
      .waitFor();
    await alternatePage.getByText(`You're signed in as ${alternateOwnerEmail}`).waitFor();
    await alternatePage.getByRole("button", { name: "Switch account" }).click();
    await alternatePage.getByRole("heading", { name: "Sign in" }).waitFor();
    const invitedEmailInput = alternatePage.getByLabel("Email");
    expect(await invitedEmailInput.inputValue()).toBe(registeredEmail);
    expect(await invitedEmailInput.isEditable()).toBe(false);
    await alternatePage.getByLabel("Password").fill(PASSWORD);
    await alternatePage.getByRole("button", { name: "Sign in", exact: true }).last().click();
    await alternatePage.getByRole("heading", { name: "Join Onboarding Alternate Org" }).waitFor();
    await alternatePage
      .getByRole("button", { name: "Accept invitation to Onboarding Alternate Org" })
      .waitFor();
    await settleDocumentAnimations(alternatePage);
    await expectNoAxeViolations(alternatePage, "body");
    await alternatePage.screenshot({
      path: `${EVIDENCE_DIR}/onboarding-existing-account-invitations-desktop-1024.png`,
      fullPage: true,
    });
    await alternatePage
      .getByRole("button", { name: "Accept invitation to Onboarding Alternate Org" })
      .click();
    await alternatePage.getByRole("button", { name: "Account menu" }).waitFor();
    const resignedCookie = await cookieHeader(alternateContext);
    const joinedMemberships = await sdk(resignedCookie).listOrganizationMemberships();
    expect(joinedMemberships.memberships).toHaveLength(2);
    expect(joinedMemberships.memberships.map((membership) => membership.organizationId)).toEqual(
      expect.arrayContaining([organizationId, alternateOrganizationId]),
    );
    const acceptedInvitationHistory = await sdk(resignedCookie).listOrganizationInvitations({
      limit: 20,
    });
    expect(
      acceptedInvitationHistory.invitations.find(
        (invitation) => invitation.id === alternateInvite.id,
      ),
    ).toMatchObject({
      organizationId: alternateOrganizationId,
      status: "accepted",
    });
    expectNoBrowserProblems(alternateProblems);
    await alternateContext.close();

    const forget = await fetch(`${publicOrigin}/v1/auth/request-password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: registeredEmail,
        redirectTo: "/reset-password",
      }),
    });
    expect(forget.status).toBe(200);
    const resetEmail = await takeEmail("password_reset", registeredEmail);
    const resetUrl = new URL(firstUrl(resetEmail));
    expect(resetUrl.pathname.startsWith("/v1/auth/reset-password/")).toBe(true);
    await registeredContext.clearCookies();
    await registeredPage.goto(resetUrl.toString(), {
      waitUntil: "domcontentloaded",
    });
    await registeredPage.waitForURL(/\/reset-password\?token=/);
    await registeredPage.getByRole("heading", { name: "Reset password" }).waitFor();
    await registeredPage.getByLabel("New password").fill(RESET_PASSWORD);
    await registeredPage.getByLabel("Confirm password").fill(RESET_PASSWORD);
    await registeredPage.getByRole("button", { name: "Reset password" }).click();
    await registeredPage.getByText("Your password has been changed.").waitFor();
    await registeredPage.getByRole("link", { name: "Continue to sign in" }).click();
    // Password reset is a sensitive Better Auth operation. Let its bounded
    // per-client window elapse before proving the new credential so the final
    // UI evidence contains no expected 429 console noise.
    await Bun.sleep(10_500);
    await signIn(registeredPage, registeredEmail, RESET_PASSWORD);
    let postResetCopy = "";
    await waitFor(
      async () => {
        postResetCopy = (await registeredPage.locator("body").textContent()) ?? "";
        return /\/workspaces\//.test(registeredPage.url()) || postResetCopy.includes("Couldn't");
      },
      {
        timeoutMs: 20_000,
        intervalMs: 50,
        describe: () =>
          JSON.stringify({
            copy: postResetCopy,
            url: registeredPage.url(),
            problems: registeredProblems,
          }),
      },
    );
    if (!/\/workspaces\//.test(registeredPage.url())) {
      throw new Error(
        `post-reset sign-in did not reach a workspace: ${JSON.stringify({
          copy: postResetCopy,
          url: registeredPage.url(),
        })}`,
      );
    }
    expect(
      await registeredPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await expectNoAxeViolations(registeredPage, "body");
    expectNoBrowserProblems(registeredProblems);

    const currentOverview = await owner.getOrganizationAdministrationOverview(organizationId);
    const initialWorkspace = currentOverview.workspaces.find(
      (workspace) => workspace.id === sharedWorkspaceId,
    );
    const invitedAccess = initialWorkspace?.members.find(
      (member) => member.organizationMembershipId === invitedMembershipId,
    );
    if (!invitedAccess) throw new Error("initial shared-workspace grant was not projected");
    const authorityRevocation = await owner.revokeOrganizationWorkspaceMember(
      organizationId,
      sharedWorkspaceId,
      invitedMembershipId,
      {
        expectedUpdatedAt: invitedAccess.updatedAt,
        operationId: crypto.randomUUID(),
      },
    );
    expect(authorityRevocation.removed).toBe(true);
    await expect(
      invited.getSession(sharedWorkspaceId, admittedSharedSession.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      invited.createSession(sharedWorkspaceId, {
        initialMessage: "must fail after immediate revocation",
        idempotencyKey: crypto.randomUUID(),
        sandboxBackend: "none",
      }),
    ).rejects.toMatchObject({ status: 403 });

    const [runtime] = await owned.admin<
      Array<{
        superuser: boolean;
        bypassRls: boolean;
        activationForced: boolean;
        setupForced: boolean;
        directActivationDml: boolean;
        directIntentDml: boolean;
        publicSetupExecute: boolean;
        privateActivationExecute: boolean;
      }>
    >`
      select
        (select rolsuper from pg_roles where rolname = 'opengeni_app') as superuser,
        (select rolbypassrls from pg_roles where rolname = 'opengeni_app') as "bypassRls",
        (select relforcerowsecurity from pg_class where oid = 'session_tenancy_activations'::regclass) as "activationForced",
        (select relforcerowsecurity from pg_class where oid = 'organization_user_setup_intents'::regclass) as "setupForced",
        has_table_privilege('opengeni_app', 'session_tenancy_activations', 'INSERT,UPDATE,DELETE') as "directActivationDml",
        has_table_privilege('opengeni_app', 'organization_user_setup_intents', 'INSERT,UPDATE,DELETE') as "directIntentDml",
        has_function_privilege('opengeni_app', 'preview_organization_user_setup(text)', 'EXECUTE') as "publicSetupExecute",
        has_function_privilege('opengeni_app', 'activate_greenfield_session_tenancy_from_setup(text)', 'EXECUTE') as "privateActivationExecute"`;
    expect(runtime).toEqual({
      superuser: false,
      bypassRls: false,
      activationForced: true,
      setupForced: true,
      directActivationDml: false,
      directIntentDml: false,
      publicSetupExecute: true,
      privateActivationExecute: false,
    });
    const bearer = requiredState("setupToken");
    const [leak] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from organization_user_setup_intents intent
      left join organization_user_setup_deliveries delivery on delivery.setup_intent_id = intent.id
      left join organization_user_setup_delivery_attempts attempt on attempt.delivery_id = delivery.id
      where row_to_json(intent)::text like ${`%${bearer}%`}
         or row_to_json(delivery)::text like ${`%${bearer}%`}
         or row_to_json(attempt)::text like ${`%${bearer}%`}`;
    expect(leak?.count).toBe(0);

    await writeFile(
      `${EVIDENCE_DIR}/organization-onboarding-evidence.json`,
      `${JSON.stringify(
        {
          runId: RUN_ID,
          productionWebBuild: true,
          sameOrigin: true,
          ownerMigratedPostgres: true,
          runtimeRole: "opengeni_app",
          requireRealDatabase,
          externalEmailCalls: 0,
          capturedEmailCountBound: 80,
          screenshots: [
            "onboarding-owner-desktop-1440.png",
            "onboarding-setup-mobile-390.png",
            "onboarding-registered-mobile-320.png",
            "onboarding-existing-account-invitations-desktop-1024.png",
          ],
        },
        null,
        2,
      )}\n`,
    );
    await registeredContext.close();
  }, 240_000);
});
