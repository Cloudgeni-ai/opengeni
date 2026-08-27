import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  allWorkspacePermissions,
  createDb,
  ensureManagedAccessForUser,
  listSelfOrganizationMemberships,
  provisionRoles,
  synchronizeCanonicalHumanLoginBindings,
  type DbClient,
  updateOrganizationMember,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireOwnerMigratedTestDatabase,
  freePort,
  MemoryEventBus,
  testSettings,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import { createApp } from "../../apps/api/src/app";
import {
  dispatchOrganizationRecoveryNotifications,
  InMemoryOrganizationRecoveryNotificationTransport,
} from "../../apps/api/src/organization-recovery-notifications";

const repoRoot = new URL("../..", import.meta.url).pathname;
const RUN_ID = crypto.randomUUID();
const PASSWORD = "Recovery-browser-password-1234";
const EVIDENCE_DIR =
  process.env.OPENGENI_RECOVERY_EVIDENCE_DIR ?? "/tmp/opengeni-recovery-evidence";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const ownerAccount = {
  name: "Recovery Owner",
  email: `recovery-owner-${RUN_ID}@example.test`,
};
const members = [
  {
    membershipId: "22222222-2222-4222-8222-222222222222",
    name: "Custodian Ada",
    email: `recovery-ada-${RUN_ID}@example.test`,
  },
  {
    membershipId: "33333333-3333-4333-8333-333333333333",
    name: "Custodian Grace",
    email: `recovery-grace-${RUN_ID}@example.test`,
  },
  {
    membershipId: "44444444-4444-4444-8444-444444444444",
    name: "Custodian Katherine",
    email: `recovery-katherine-${RUN_ID}@example.test`,
  },
  {
    membershipId: "55555555-5555-4555-8555-555555555555",
    name: "Recovery Target",
    email: `recovery-target-${RUN_ID}@example.test`,
  },
] as const;

type ActorKey = "owner" | "custodian-1" | "custodian-2" | "custodian-3";
type ActorAccount = {
  key: ActorKey;
  name: string;
  email: string;
  userId: string;
  membershipId: string;
};
type ActorBrowser = ActorAccount & {
  context: BrowserContext;
  page: Page;
};

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let ownerClient: DbClient | null = null;
let browser: Browser | null = null;
let edge: ReturnType<typeof Bun.serve> | null = null;
let publicOrigin = "";
let organizationId = "";
let workspaceId = "";
let ownerUserId = "";
let ownerMembershipId = "";
const actorBrowsers = new Map<ActorKey, ActorBrowser>();
let mutationBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
const recoveryReadActorEpochs: Array<{
  actor: ActorKey;
  actorEpoch: string | null;
}> = [];
const externalRequests: string[] = [];
const browserProblems: string[] = [];
const fakeProvider = new InMemoryOrganizationRecoveryNotificationTransport();

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

function appDatabaseUrl(fixture: OwnerMigratedTestDatabase): string {
  const value = new URL(fixture.ownerUrl);
  value.username = "opengeni_app";
  value.password = fixture.appPassword;
  return value.toString();
}

async function refresh(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("heading", { name: "Recovery custody" }).waitFor();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function accountMenuTrigger(page: Page, displayName: string) {
  return page.getByRole("button", {
    name: new RegExp(`^Account menu\\. ${escapeRegExp(displayName)} is active\\.$`),
  });
}

async function waitForSelectedAccount(
  page: Page,
  account: Pick<ActorAccount, "name">,
  timeout = 30_000,
): Promise<Locator> {
  const trigger = accountMenuTrigger(page, account.name);
  const continueAs = page.getByRole("button", {
    name: `Continue as ${account.name}`,
  });
  const deadline = Date.now() + timeout;
  let visibleSince: number | null = null;
  while (Date.now() < deadline) {
    if ((await continueAs.isVisible()) && (await continueAs.isEnabled())) {
      await continueAs.click();
      visibleSince = null;
      await page.waitForTimeout(100);
      continue;
    }
    if (await trigger.isVisible()) {
      visibleSince ??= Date.now();
      if (Date.now() - visibleSince >= 250) return trigger;
    } else {
      visibleSince = null;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(
    `account selection did not settle for ${account.name}: url=${page.url()} body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2_000))}`,
  );
}

async function completeEmailPopup(popup: Page, account: Pick<ActorAccount, "email" | "name">) {
  await popup.getByRole("heading", { name: "Authenticate this account" }).waitFor();
  await popup.getByLabel("Email").fill(account.email);
  await popup.getByLabel("Password").fill(PASSWORD);
  await Promise.all([
    popup.waitForEvent("close"),
    popup.getByRole("button", { name: "Continue" }).click(),
  ]);
}

function waitForSessionSetReconciliation(page: Page): Promise<void> {
  return new Promise((resolve, reject) => {
    let reads = 0;
    const timeout = setTimeout(() => {
      page.off("response", observe);
      reject(new Error("browser account authority reconciliation did not finish"));
    }, 30_000);
    function observe(response: import("playwright").Response) {
      const url = new URL(response.url());
      if (
        response.request().method() !== "GET" ||
        url.pathname !== "/v1/auth/session-set" ||
        !response.ok()
      ) {
        return;
      }
      reads += 1;
      if (reads < 2) return;
      clearTimeout(timeout);
      page.off("response", observe);
      resolve();
    }
    page.on("response", observe);
  });
}

async function reauthenticateAccount(
  page: Page,
  account: Pick<ActorAccount, "email" | "name">,
): Promise<void> {
  let lastBootstrapError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout(100);
    }
    const accountTrigger = await waitForSelectedAccount(page, account);
    await accountTrigger.click();
    const accountMenu = page
      .locator('[data-slot="dropdown-menu-content"][data-state="open"]')
      .filter({ hasText: "Browser accounts" })
      .last();
    const slot = accountMenu.getByRole("menuitem", {
      name: new RegExp(escapeRegExp(account.name)),
    });
    await slot.hover();
    const reauthenticate = page.getByRole("menuitem", {
      name: "Re-authenticate",
    });
    await reauthenticate.waitFor();
    await page.waitForFunction(() => {
      const candidates = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const item = candidates.find(
        (candidate) =>
          candidate.textContent?.trim() === "Re-authenticate" && candidate.offsetParent,
      );
      return (
        item !== undefined &&
        !item.hasAttribute("data-disabled") &&
        item.getAttribute("aria-disabled") !== "true"
      );
    });
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      reauthenticate.click({ force: true }),
    ]);
    try {
      await popup.getByRole("heading", { name: "Authenticate this account" }).waitFor();
    } catch (error) {
      lastBootstrapError = error;
      await popup.close().catch(() => undefined);
      continue;
    }
    const reconciliation = waitForSessionSetReconciliation(page);
    await completeEmailPopup(popup, account);
    await reconciliation;
    return;
  }
  throw new Error(
    `re-authentication popup did not bootstrap for ${account.name}: main=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2_000))}`,
    { cause: lastBootstrapError },
  );
}

async function signInAndReauthenticate(account: ActorAccount): Promise<ActorBrowser> {
  if (!browser) throw new Error("browser unavailable");
  const actorOctet = (
    {
      owner: 40,
      "custodian-1": 41,
      "custodian-2": 42,
      "custodian-3": 43,
    } as const
  )[account.key];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${actorOctet}` },
  });
  const page = await context.newPage();
  await page.goto(publicOrigin, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Sign in to OpenGeni" }).waitFor();
  const [initialPopup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Continue with email" }).click(),
  ]);
  await completeEmailPopup(initialPopup, account);
  await waitForSelectedAccount(page, account);

  // The selected actor transition commits before the account trigger mounts,
  // but its final finite access reads can still replace the menu tree once.
  // Let that settled render win before opening the re-authentication submenu.
  await page.waitForTimeout(1_000);
  await reauthenticateAccount(page, account);
  await waitForSelectedAccount(page, account);
  await page.waitForTimeout(100);

  observeRecoveryPage(page, account.key);
  return { ...account, context, page };
}

function observeRecoveryPage(page: Page, actor: ActorKey): void {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== publicOrigin && !["data:", "blob:"].includes(url.protocol)) {
      externalRequests.push(`${actor}:${request.url()}`);
    }
    if (
      request.method() !== "GET" &&
      /^\/v1\/organizations\/[^/]+\/recovery(?:\/|$)/u.test(url.pathname)
    ) {
      try {
        const body = request.postDataJSON() as Record<string, unknown>;
        mutationBodies.push({ path: url.pathname, body });
      } catch (error) {
        browserProblems.push(`${actor}: unreadable recovery body: ${String(error)}`);
      }
    } else if (
      request.method() === "GET" &&
      /^\/v1\/organizations\/[^/]+\/recovery$/u.test(url.pathname)
    ) {
      recoveryReadActorEpochs.push({
        actor,
        actorEpoch: request.headers()["x-opengeni-actor-epoch"] ?? null,
      });
    }
  });
  page.on("pageerror", (error) => browserProblems.push(`${actor}: pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      browserProblems.push(`${actor}: console: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    browserProblems.push(
      `${actor}: requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.includes("/recovery") && response.status() >= 400) {
      browserProblems.push(`${actor}: recovery response ${response.status()} ${url.pathname}`);
    } else if (
      url.pathname.startsWith("/v1/") &&
      response.status() >= 400 &&
      // An unprovisioned workspace has no machine resource, and a finite
      // get-session request admitted before re-authentication must reconcile
      // through the broker's actor-change conflict.
      !(
        (response.status() === 404 && /\/workspaces\/[^/]+\/machines$/u.test(url.pathname)) ||
        (response.status() === 409 && url.pathname === "/v1/auth/get-session")
      )
    ) {
      browserProblems.push(`${actor}: API response ${response.status()} ${url.pathname}`);
    }
  });
}

async function openRecovery(actor: ActorKey): Promise<Page> {
  const fixture = actorBrowsers.get(actor);
  if (!fixture) throw new Error(`${actor} browser unavailable`);
  await fixture.page.goto(
    `${publicOrigin}/workspaces/${workspaceId}/organization?section=recovery`,
    { waitUntil: "domcontentloaded" },
  );
  try {
    await fixture.page.getByRole("heading", { name: "Recovery custody" }).waitFor();
  } catch (error) {
    throw new Error(
      `${actor} did not reach recovery: url=${fixture.page.url()} body=${JSON.stringify((await fixture.page.locator("body").innerText()).slice(0, 4_000))} problems=${JSON.stringify(browserProblems.slice(-20))}`,
      { cause: error },
    );
  }
  try {
    await fixture.page.getByText("Recent re-authentication verified").waitFor();
  } catch (error) {
    const authority = (await fixture.context.cookies(publicOrigin)).find(
      (cookie) => cookie.name === "opengeni.session_set",
    )?.value;
    const actorEpoch = recoveryReadActorEpochs.findLast(
      (entry) => entry.actor === actor,
    )?.actorEpoch;
    const authorityHash = authority ? createHash("sha256").update(authority).digest("hex") : null;
    const [diagnostic] =
      owned && authorityHash && actorEpoch
        ? await owned.admin<
            Array<{
              generation: string;
              actorEpoch: string;
              authSessionId: string;
              proof: unknown;
              operations: unknown;
            }>
          >`
            select session_set.generation::text as generation,
              session_set.actor_epoch::text as "actorEpoch",
              slot.auth_session_id as "authSessionId",
              organization_recovery_resolve_recent_reauth(
                jsonb_build_object(
                  'authorityHash', ${authorityHash}::text,
                  'actorEpoch', ${actorEpoch}::text
                ),
                ${`user:${fixture.userId}`}::text, slot.auth_session_id,
                ${fixture.userId}::text
              ) as proof,
              (select jsonb_agg(jsonb_build_object(
                'type', operation.operation_type,
                'target', operation.target_slot_id,
                'generation', operation.result_generation,
                'actorEpoch', operation.result_actor_epoch,
                'createdAt', operation.created_at
              ) order by operation.created_at desc)
                from managed_auth_session_set_operations operation
                where operation.session_set_id = session_set.id) as operations
            from managed_auth_session_sets session_set
            inner join managed_auth_login_slots slot
              on slot.id = session_set.selected_slot_id
            where session_set.authority_hash = ${authorityHash}::text`
        : [];
    throw new Error(
      `${actor} recovery lacked recent proof: body=${JSON.stringify((await fixture.page.locator("body").innerText()).slice(0, 4_000))} recoveryEpochs=${JSON.stringify(recoveryReadActorEpochs.slice(-10))} diagnostic=${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
  return fixture.page;
}

async function signUpAccount(input: {
  name: string;
  email: string;
  forwardedFor: string;
}): Promise<string> {
  if (!owned || !client) throw new Error("database fixture unavailable");
  const signup = await fetch(`${publicOrigin}/v1/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": input.forwardedFor,
    },
    body: JSON.stringify({
      name: input.name,
      email: input.email,
      password: PASSWORD,
    }),
  });
  expect(signup.status).toBeLessThan(300);
  const [user] = await owned.admin<{ id: string }[]>`
    update auth_users set email_verified = true where email = ${input.email}
    returning id`;
  if (!user) throw new Error(`signed-up user missing for ${input.email}`);
  await synchronizeCanonicalHumanLoginBindings(client.db, user.id);
  await ensureManagedAccessForUser(client.db, {
    userId: user.id,
    email: input.email,
    name: input.name,
    emailVerified: true,
  });
  return user.id;
}

async function elapseCooldown(operationId: string): Promise<void> {
  if (!owned) throw new Error("database fixture unavailable");
  await owned.admin.begin(async (transactionSql) => {
    await transactionSql`select set_config('opengeni.organization_recovery_lifecycle', 'active', true)`;
    await transactionSql`update organization_recovery_operations set
      quorum_at = now() - interval '7 days', executable_at = now(),
      revision = revision + 1, updated_at = now()
      where id = ${operationId}::uuid`;
  });
}

async function axe(page: Page): Promise<void> {
  const report = await new AxeBuilder({ page })
    .include("body")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    report.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

async function bounded(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const overflow = await page.locator("button, input, select").evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      })
      .map((element) => element.outerHTML.slice(0, 160)),
  );
  expect(overflow).toEqual([]);
  expect(page.viewportSize()?.width).toBe(width);
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("organization-recovery-browser-acceptance");
  if (!owned) {
    throw new Error(
      requireRealDatabase
        ? "Organization recovery browser acceptance requires PostgreSQL"
        : "Organization recovery browser acceptance is opt-in and never skips PostgreSQL",
    );
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const databaseUrl = appDatabaseUrl(owned);
  client = createDb(databaseUrl, { max: 16, rlsStrategy: "force" });
  ownerClient = createDb(owned.ownerUrl, { max: 8, rlsStrategy: "force" });
  publicOrigin = `http://127.0.0.1:${await freePort()}`;
  const api = createApp({
    settings: testSettings({
      environment: "test",
      productAccessMode: "managed",
      managedAuthSessionSetMode: "broker",
      databaseUrl,
      rlsStrategy: "force",
      runtimeDatabaseRole: "opengeni_app",
      publicBaseUrl: publicOrigin,
      betterAuthSecret: "recovery-browser-secret-at-least-32-bytes",
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: workflowStub(),
  });

  const extensionBuild = Bun.spawn(["bun", "run", "build"], {
    cwd: `${repoRoot}/apps/browser-extension`,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await extensionBuild.exited) !== 0) {
    throw new Error(await new Response(extensionBuild.stderr).text());
  }
  const webBuild = Bun.spawn(["bun", "run", "vite", "build"], {
    cwd: `${repoRoot}/apps/web`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      VITE_API_BASE_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await webBuild.exited) !== 0) {
    throw new Error(await new Response(webBuild.stderr).text());
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

  ownerUserId = await signUpAccount({
    ...ownerAccount,
    forwardedFor: "198.51.100.30",
  });
  const memberUserIds: string[] = [];
  for (const [index, member] of members.entries()) {
    memberUserIds.push(
      await signUpAccount({
        name: member.name,
        email: member.email,
        forwardedFor: `198.51.100.${31 + index}`,
      }),
    );
  }

  const ownerMemberships = await listSelfOrganizationMemberships(client.db, `user:${ownerUserId}`);
  const ownerMembership = ownerMemberships.find((membership) => membership.status === "active");
  if (!ownerMembership?.personalWorkspaceId) {
    throw new Error("owner fallback organization was not provisioned");
  }
  organizationId = ownerMembership.organizationId;
  ownerMembershipId = ownerMembership.id;
  workspaceId = crypto.randomUUID();
  await owned.admin.begin(async (transactionSql) => {
    await transactionSql`
      update managed_accounts set name = 'Recovery Acceptance Organization', updated_at = now()
      where id = ${organizationId}::uuid`;
    await transactionSql`
      insert into workspaces (id, account_id, name)
      values (${workspaceId}::uuid, ${organizationId}::uuid, 'Recovery Acceptance Workspace')`;
    await transactionSql`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspaceId}::uuid, ${organizationId}::uuid)`;
    await transactionSql`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${organizationId}::uuid, ${workspaceId}::uuid, ${`user:${ownerUserId}`},
        ${ownerAccount.email}, 'admin', ${JSON.stringify(allWorkspacePermissions)}::jsonb
      )`;

    for (const [index, member] of members.entries()) {
      const userId = memberUserIds[index]!;
      const subjectId = `user:${userId}`;
      const personalWorkspaceId = crypto.randomUUID();
      await transactionSql`
        insert into workspaces (id, account_id, name)
        values (
          ${personalWorkspaceId}::uuid, ${organizationId}::uuid,
          ${`${member.name} Personal`}
        )`;
      await transactionSql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${personalWorkspaceId}::uuid, ${organizationId}::uuid)`;
      await transactionSql`
        insert into organization_memberships (
          id, account_id, subject_id, role, status, personal_workspace_id
        ) values (
          ${member.membershipId}::uuid, ${organizationId}::uuid, ${subjectId},
          'member', 'active', ${personalWorkspaceId}::uuid
        )`;
      if (index < 3) {
        await transactionSql`
          insert into workspace_memberships (
            account_id, workspace_id, subject_id, subject_label, role, permissions
          ) values (
            ${organizationId}::uuid, ${workspaceId}::uuid, ${subjectId},
            ${member.email}, 'member', ${JSON.stringify(allWorkspacePermissions)}::jsonb
          )`;
      }
    }
  });

  const projectedAccounts = [
    {
      name: ownerAccount.name,
      email: ownerAccount.email,
      userId: ownerUserId,
      shared: true,
    },
    ...members.map((member, index) => ({
      name: member.name,
      email: member.email,
      userId: memberUserIds[index]!,
      shared: index < 3,
    })),
  ];
  for (const account of projectedAccounts) {
    const access = await ensureManagedAccessForUser(client.db, {
      userId: account.userId,
      email: account.email,
      name: account.name,
      emailVerified: true,
    });
    expect(
      access.workspaceGrants.some((grant) => grant.workspaceId === workspaceId),
      `${account.name} shared-workspace projection`,
    ).toBe(account.shared);
  }

  const accounts: ActorAccount[] = [
    {
      key: "custodian-3",
      name: members[2].name,
      email: members[2].email,
      userId: memberUserIds[2]!,
      membershipId: members[2].membershipId,
    },
    {
      key: "custodian-2",
      name: members[1].name,
      email: members[1].email,
      userId: memberUserIds[1]!,
      membershipId: members[1].membershipId,
    },
    {
      key: "custodian-1",
      name: members[0].name,
      email: members[0].email,
      userId: memberUserIds[0]!,
      membershipId: members[0].membershipId,
    },
    {
      key: "owner",
      name: ownerAccount.name,
      email: ownerAccount.email,
      userId: ownerUserId,
      membershipId: ownerMembershipId,
    },
  ];
  for (const account of accounts) {
    actorBrowsers.set(account.key, await signInAndReauthenticate(account));
    const [proof] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from managed_auth_session_set_operations operation
      inner join managed_auth_session_sets session_set
        on session_set.id = operation.session_set_id
      inner join managed_auth_login_slots slot
        on slot.id = operation.target_slot_id
       and slot.session_set_id = session_set.id
      where slot.auth_user_id = ${account.userId}
        and operation.operation_type = 'complete_reauth'
        and operation.outcome in ('applied', 'converged')
        and operation.target_slot_id = session_set.selected_slot_id
        and operation.result_generation = session_set.generation
        and operation.result_actor_epoch = session_set.actor_epoch`;
    expect(proof?.count, `${account.name} current complete_reauth proof`).toBe(1);
  }
}, 900_000);

afterAll(async () => {
  edge?.stop(true);
  for (const actor of actorBrowsers.values()) {
    await actor.context.close().catch(() => undefined);
  }
  await browser?.close().catch(() => undefined);
  await ownerClient?.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("organization recovery same-origin Chromium acceptance", () => {
  test("completes enrollment, cancellation, quorum, cooling, fake delivery, and execution by keyboard", async () => {
    if (!owned || !ownerClient) throw new Error("acceptance harness unavailable");
    const ownerPage = await openRecovery("owner");
    await ownerPage.getByText("Policy: not configured").waitFor();
    await ownerPage.getByText("Exact promotion consequence").waitFor();

    expect(await ownerPage.getByRole("checkbox").count()).toBe(4);
    for (const member of members.slice(0, 3)) {
      const checkbox = ownerPage.getByRole("checkbox", {
        name: new RegExp(member.name),
      });
      await checkbox.focus();
      await ownerPage.keyboard.press("Space");
    }
    const save = ownerPage.getByRole("button", { name: "Save custody policy" });
    await save.focus();
    await ownerPage.keyboard.press("Enter");
    await ownerPage.getByText("Custodians accepted: 0/3", { exact: true }).waitFor();

    for (const [actor, acceptedCount] of [
      ["custodian-1", 1],
      ["custodian-2", 2],
      ["custodian-3", 3],
    ] as const) {
      const actorPage = await openRecovery(actor);
      const accept = actorPage.getByRole("button", { name: "Accept custody" });
      await accept.focus();
      await actorPage.keyboard.press("Enter");
      await actorPage
        .getByText(`Custodians accepted: ${acceptedCount}/3`, { exact: true })
        .waitFor();
    }

    const custodianOnePage = await openRecovery("custodian-1");
    await custodianOnePage.getByText("Custodians accepted: 3/3", { exact: true }).waitFor();
    await custodianOnePage.getByLabel("Target member").selectOption(members[3].membershipId);
    await custodianOnePage.getByRole("button", { name: "Start seven-day recovery" }).click();
    await custodianOnePage.getByText(/collecting · revision/u).waitFor();

    await refresh(ownerPage);
    const cancel = ownerPage.getByRole("button", { name: "Cancel recovery" });
    await cancel.focus();
    await ownerPage.keyboard.press("Enter");
    await ownerPage.getByRole("heading", { name: "Cancel this recovery operation?" }).waitFor();
    await ownerPage.keyboard.press("Escape");
    expect(await cancel.evaluate((element) => element === document.activeElement)).toBe(true);
    await ownerPage.keyboard.press("Enter");
    const confirmCancel = ownerPage.getByRole("button", {
      name: "Cancel recovery operation",
    });
    await confirmCancel.focus();
    await ownerPage.keyboard.press("Enter");
    await ownerPage.getByText(/cancelled · revision/u).waitFor();

    await refresh(custodianOnePage);
    await custodianOnePage.getByLabel("Target member").selectOption(members[3].membershipId);
    await custodianOnePage.getByRole("button", { name: "Start seven-day recovery" }).click();
    await custodianOnePage.getByRole("button", { name: "Approve recovery" }).click();
    await custodianOnePage.getByText("1/2 approvals").waitFor();
    const custodianTwoPage = await openRecovery("custodian-2");
    await custodianTwoPage.getByRole("button", { name: "Approve recovery" }).click();
    await custodianTwoPage.getByText("cooling", { exact: false }).first().waitFor();
    await custodianTwoPage.getByText("Journaled", { exact: true }).waitFor();
    await custodianTwoPage.getByText("2/2 approvals").waitFor();

    const [coolingOperation] = await owned.admin<
      Array<{ id: string; state: string; revision: number }>
    >`
      select id, state, revision
      from organization_recovery_operations
      where account_id = ${organizationId}::uuid
      order by created_at desc, id desc
      limit 1`;
    expect(coolingOperation?.state).toBe("cooling");
    if (!coolingOperation) throw new Error("cooling recovery operation missing");
    const settlements = await dispatchOrganizationRecoveryNotifications({
      db: ownerClient.db,
      transport: fakeProvider,
      claimOwner: "recovery-browser-acceptance",
    });
    expect(settlements).toHaveLength(5);
    expect(settlements.every((settlement) => settlement.phase === "sent")).toBe(true);
    expect(fakeProvider.attempts).toHaveLength(5);
    expect(new Set(fakeProvider.attempts.map((delivery) => delivery.idempotencyKey)).size).toBe(5);
    expect(fakeProvider.logicalDeliveryCount()).toBe(5);

    const [targetBefore] = await owned.admin<
      Array<{ role: string; personalWorkspaceId: string; sharedGrants: number }>
    >`
      select membership.role,
        membership.personal_workspace_id as "personalWorkspaceId",
        (select count(*)::int from workspace_memberships access
          where access.subject_id = membership.subject_id
            and access.workspace_id = ${workspaceId}::uuid) as "sharedGrants"
      from organization_memberships membership
      where membership.id = ${members[3].membershipId}::uuid`;
    expect(targetBefore).toMatchObject({ role: "member", sharedGrants: 0 });

    await elapseCooldown(coolingOperation.id);
    await refresh(custodianOnePage);
    const execute = custodianOnePage.getByRole("button", {
      name: "Execute promotion",
    });
    await execute.focus();
    await custodianOnePage.keyboard.press("Enter");
    await custodianOnePage.getByText(/executed · revision/u).waitFor();
    await custodianOnePage.getByText("including organization administration and").waitFor();
    await custodianOnePage.getByText("billing management").waitFor();
    await custodianOnePage.getByText(/No Personal content, workspace ownership/u).waitFor();

    const [targetAfter] = await owned.admin<
      Array<{
        role: string;
        personalWorkspaceId: string;
        sharedGrants: number;
        originalOwnerRole: string;
        operationState: string;
      }>
    >`
      select membership.role,
        membership.personal_workspace_id as "personalWorkspaceId",
        (select count(*)::int from workspace_memberships access
          where access.subject_id = membership.subject_id
            and access.workspace_id = ${workspaceId}::uuid) as "sharedGrants",
        (select role from organization_memberships where id = ${ownerMembershipId}::uuid)
          as "originalOwnerRole",
        (select state from organization_recovery_operations
          where id = ${coolingOperation.id}::uuid) as "operationState"
      from organization_memberships membership
      where membership.id = ${members[3].membershipId}::uuid`;
    expect(targetAfter).toEqual({
      role: "owner",
      personalWorkspaceId: targetBefore?.personalWorkspaceId,
      sharedGrants: 0,
      originalOwnerRole: "owner",
      operationState: "executed",
    });

    await axe(custodianOnePage);
    await bounded(custodianOnePage, 1440);
    await custodianOnePage.screenshot({
      path: `${EVIDENCE_DIR}/recovery-1440.png`,
      fullPage: true,
    });
    expect(externalRequests).toEqual([]);
    expect(mutationBodies.length).toBeGreaterThanOrEqual(10);
    expect(
      mutationBodies.every(
        ({ body }) =>
          !("authSessionId" in body) &&
          !("authUserId" in body) &&
          !("reauthOperationId" in body) &&
          !("actorFence" in body) &&
          !("accountId" in body),
      ),
    ).toBe(true);
    expect(browserProblems).toEqual([]);
  }, 300_000);

  test("renders degraded and disabled safety states at 390 and 320 without overflow", async () => {
    if (!client || !owned) throw new Error("acceptance harness unavailable");
    const [custodian] = await owned.admin<Array<{ authorizationRevision: number }>>`
      select authorization_revision as "authorizationRevision"
      from organization_memberships
      where id = ${members[1].membershipId}::uuid`;
    if (!custodian) throw new Error("custodian membership missing");
    await updateOrganizationMember(client.db, {
      organizationId,
      actorSubjectId: `user:${ownerUserId}`,
      operationId: crypto.randomUUID(),
      membershipId: members[1].membershipId,
      transition: {
        kind: "suspend",
        expectedAuthorizationRevision: Number(custodian.authorizationRevision),
        reason: "Exercise real degraded recovery projection",
      },
    });

    const ownerPage = actorBrowsers.get("owner")?.page;
    if (!ownerPage) throw new Error("owner browser unavailable");
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await ownerPage.goto(
      `${publicOrigin}/workspaces/${workspaceId}/organization?section=recovery`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await ownerPage.getByRole("heading", { name: "Recovery custody" }).waitFor();
    await ownerPage.getByText("Policy: degraded").waitFor();
    await ownerPage.getByText("Recovery unavailable", { exact: true }).waitFor();
    await ownerPage
      .getByText(
        "A custodian or stamped identity is no longer eligible. A current owner must rotate the policy.",
        { exact: true },
      )
      .waitFor();
    await axe(ownerPage);
    await bounded(ownerPage, 390);
    await ownerPage.screenshot({
      path: `${EVIDENCE_DIR}/recovery-390-degraded.png`,
      fullPage: true,
    });
    await ownerPage.goto(`${publicOrigin}/workspaces/${workspaceId}/settings?section=members`, {
      waitUntil: "domcontentloaded",
    });
    await ownerPage.getByText("permanently owned by its organization").waitFor();
    await ownerPage.getByText(/Cross-organization transfer/u).waitFor();
    await bounded(ownerPage, 390);

    await ownerPage.setViewportSize({ width: 320, height: 844 });
    await ownerPage.goto(
      `${publicOrigin}/workspaces/${workspaceId}/organization?section=recovery`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await ownerPage.getByText("Policy: degraded").waitFor();
    await ownerPage.getByRole("button", { name: "Disable policy" }).click();
    await ownerPage.getByRole("heading", { name: "Disable organization recovery?" }).waitFor();
    await ownerPage.getByRole("button", { name: "Disable recovery policy" }).click();
    const disabledToast = ownerPage
      .locator('[data-sonner-toast][data-type="success"]')
      .filter({ hasText: "Recovery policy disabled." });
    await disabledToast.waitFor();
    await ownerPage.getByText("Policy: disabled").waitFor();
    await ownerPage
      .getByText("A current owner disabled the custody policy.", {
        exact: true,
      })
      .waitFor();
    // Axe must inspect either the fully rendered toast or the stable page, not
    // colors blended mid-opacity during Sonner's removal transition.
    await disabledToast.waitFor({ state: "hidden", timeout: 10_000 });
    await axe(ownerPage);
    await bounded(ownerPage, 320);
    await ownerPage.screenshot({
      path: `${EVIDENCE_DIR}/recovery-320-disabled.png`,
      fullPage: true,
    });
    await ownerPage.goto(`${publicOrigin}/workspaces/${workspaceId}/settings?section=members`, {
      waitUntil: "domcontentloaded",
    });
    await ownerPage.getByText("permanently owned by its organization").waitFor();
    await ownerPage.getByText(/Cross-organization transfer/u).waitFor();
    await bounded(ownerPage, 320);
    expect(externalRequests).toEqual([]);
    expect(browserProblems).toEqual([]);
  }, 300_000);
});
