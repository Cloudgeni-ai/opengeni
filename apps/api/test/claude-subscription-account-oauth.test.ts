import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  listClaudeSubscriptionAccountsMetadata,
  listOrganizationClaudeSubscriptions,
  materializeClaudeSubscriptionAccountForRun,
  upsertClaudeSubscriptionAccount,
  upsertOrganizationClaudeSubscription,
  type DbClient,
} from "@opengeni/db";
import { CLAUDE_OAUTH_TOKEN_URL } from "@opengeni/config";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  startClaudeSubscriptionOAuth,
  completeClaudeSubscriptionOAuth,
  type ClaudeOAuthScope,
} from "../src/claude-subscription-oauth";
let shared: SharedTestDatabase, client: DbClient, deps: ApiRouteDeps;
const encryptionKey = Buffer.alloc(32, 55);
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("claude-account-oauth");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl);
  deps = {
    db: client.db,
    settings: testSettings({
      claudeSubscriptionEnabled: true,
      environmentsEncryptionKey: encryptionKey.toString("base64"),
    }),
  } as ApiRouteDeps;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
async function fixture(organization = false): Promise<ClaudeOAuthScope> {
  const [account] = await shared.admin<
    { id: string }[]
  >`insert into managed_accounts(name) values ('Account OAuth fixture') returning id`;
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces(account_id,name) values (${account!.id},'Account OAuth fixture') returning id`;
  const [personal] = await shared.admin<
    { id: string }[]
  >`insert into workspaces(account_id,name) values (${account!.id},'Personal fixture') returning id`;
  const actorSubjectId = "user:" + randomUUID();
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id) values (${account!.id},${actorSubjectId},'owner','active',${personal!.id})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions) values (${account!.id},${workspace!.id},${actorSubjectId},'owner','[]'::jsonb)`;
  await shared.admin`insert into workspace_inference_controls(account_id,workspace_id) values (${account!.id},${workspace!.id})`;
  return {
    accountId: account!.id,
    workspaceId: organization ? null : workspace!.id,
    actorSubjectId,
    browserSessionHash: "fixture-browser:" + randomUUID(),
  };
}
async function begin(
  scope: ClaudeOAuthScope,
  input: Parameters<typeof startClaudeSubscriptionOAuth>[2] = {},
) {
  const start = await startClaudeSubscriptionOAuth(deps, scope, input);
  return {
    ...start,
    code: "fixture-code#" + new URL(start.authorizationUrl).searchParams.get("state"),
  };
}
function provider(accountUuid = randomUUID(), email = "person@example.test") {
  const calls: string[] = [];
  const token = "sk-ant-oat01-fixture-" + randomUUID();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === CLAUDE_OAUTH_TOKEN_URL)
      return Response.json({
        access_token: token,
        refresh_token: "fixture-refresh-" + randomUUID(),
        expires_in: 3600,
        scope: "user:inference user:profile",
        account: { uuid: accountUuid, email_address: email },
      });
    if (url === "https://api.anthropic.com/api/oauth/profile")
      return Response.json({
        account: { uuid: accountUuid, email_address: email, has_claude_max: true },
        organization: { organization_type: "claude_max" },
      });
    throw new Error("Unexpected provider request; inference forbidden");
  }) as typeof fetch;
  return { fetchImpl, calls, accountUuid, token };
}

test.each([false, true])(
  "browser sign-in upgrades an inference-only account without creating another row (organization=%s)",
  async (organization) => {
    const scope = await fixture(organization);
    const details = {
      encryptionKey,
      secret: {
        version: 1 as const,
        token: "sk-ant-oat01-fixture-" + randomUUID(),
        identity: { accountUuid: "", deviceId: "a".repeat(64) },
      },
      providerAccountId: "setup:" + randomUUID(),
      label: "Existing account",
      accountEmail: null,
      planType: null,
      expiresAt: null,
    };
    const setup = scope.workspaceId
      ? await upsertClaudeSubscriptionAccount(client.db, {
          ...details,
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          subjectId: scope.actorSubjectId,
        })
      : await upsertOrganizationClaudeSubscription(client.db, {
          ...details,
          organizationId: scope.accountId,
          actorSubjectId: scope.actorSubjectId,
        });
    const attempt = await begin(scope, { reconnectAccountId: setup.account.id });
    const mock = provider();
    const connected = await completeClaudeSubscriptionOAuth(
      deps,
      scope,
      attempt,
      async () => {},
      mock.fetchImpl,
    );
    expect(connected).toMatchObject({ accountId: setup.account.id, credentialVersion: 2 });
    const accounts = scope.workspaceId
      ? await listClaudeSubscriptionAccountsMetadata(client.db, {
          workspaceId: scope.workspaceId,
          subjectId: scope.actorSubjectId,
        })
      : (
          await listOrganizationClaudeSubscriptions(client.db, {
            organizationId: scope.accountId,
            actorSubjectId: scope.actorSubjectId,
          })
        ).accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerAccountId: mock.accountUuid,
      accountEmail: "person@example.test",
      label: "Existing account",
    });
  },
);

test.each([false, true])(
  "sign-in adds separate subscriptions with their actual identity, email and plan (organization=%s)",
  async (organization) => {
    const scope = await fixture(organization),
      first = provider(),
      second = provider(randomUUID(), "second@example.test");
    const firstAttempt = await begin(scope),
      secondAttempt = await begin(scope);
    const a = await completeClaudeSubscriptionOAuth(
      deps,
      scope,
      firstAttempt,
      async () => {},
      first.fetchImpl,
    );
    const b = await completeClaudeSubscriptionOAuth(
      deps,
      scope,
      secondAttempt,
      async () => {},
      second.fetchImpl,
    );
    expect(a.accountId).not.toBe(b.accountId);
    const accounts = scope.workspaceId
      ? await listClaudeSubscriptionAccountsMetadata(client.db, {
          workspaceId: scope.workspaceId,
          subjectId: scope.actorSubjectId,
        })
      : (
          await listOrganizationClaudeSubscriptions(client.db, {
            organizationId: scope.accountId,
            actorSubjectId: scope.actorSubjectId,
          })
        ).accounts;
    expect(accounts.map((account) => account.accountEmail)).toEqual([
      "person@example.test",
      "second@example.test",
    ]);
    expect(accounts.every((account) => account.planType === "claude_max")).toBe(true);
    expect(JSON.stringify(accounts)).not.toContain("sk-ant-");
    expect(first.calls).toEqual([
      CLAUDE_OAUTH_TOKEN_URL,
      "https://api.anthropic.com/api/oauth/profile",
    ]);
    expect(
      await completeClaudeSubscriptionOAuth(
        deps,
        scope,
        firstAttempt,
        async () => {},
        first.fetchImpl,
      ),
    ).toEqual(a);
    expect(first.calls).toHaveLength(2);
  },
);

test("reconnect cannot replace an account with a different provider identity", async () => {
  const scope = await fixture(),
    first = provider();
  const connected = await completeClaudeSubscriptionOAuth(
    deps,
    scope,
    await begin(scope),
    async () => {},
    first.fetchImpl,
  );
  const attempted = await begin(scope, { reconnectAccountId: connected.accountId });
  await expect(
    completeClaudeSubscriptionOAuth(deps, scope, attempted, async () => {}, provider().fetchImpl),
  ).rejects.toThrow("same Claude account");
  const original = await materializeClaudeSubscriptionAccountForRun(client.db, {
    workspaceId: scope.workspaceId!,
    subjectId: scope.actorSubjectId,
    credentialId: connected.accountId,
    encryptionKey,
    authoritySnapshot: { version: 1, scope: "workspace" },
  });
  expect(original.secret.token).toBe(first.token);
  expect(original.version).toBe(1);
});

test("an explicit reconnect is fenced against a replacement during token exchange", async () => {
  const scope = await fixture(),
    first = provider();
  const connected = await completeClaudeSubscriptionOAuth(
    deps,
    scope,
    await begin(scope),
    async () => {},
    first.fetchImpl,
  );
  const attempt = await begin(scope, { reconnectAccountId: connected.accountId }),
    next = provider(first.accountUuid);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === CLAUDE_OAUTH_TOKEN_URL) {
      const original = await materializeClaudeSubscriptionAccountForRun(client.db, {
        workspaceId: scope.workspaceId!,
        subjectId: scope.actorSubjectId,
        credentialId: connected.accountId,
        encryptionKey,
        authoritySnapshot: { version: 1, scope: "workspace" },
      });
      await upsertClaudeSubscriptionAccount(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId!,
        subjectId: scope.actorSubjectId,
        credentialId: original.id,
        authoritySnapshot: original.authoritySnapshot,
        encryptionKey,
        secret: original.secret,
        providerAccountId: original.providerAccountId,
      });
    }
    return next.fetchImpl(input, init);
  }) as typeof fetch;
  await expect(
    completeClaudeSubscriptionOAuth(deps, scope, attempt, async () => {}, fetchImpl),
  ).rejects.toThrow();
  const accounts = await listClaudeSubscriptionAccountsMetadata(client.db, {
    workspaceId: scope.workspaceId!,
    subjectId: scope.actorSubjectId,
  });
  expect(accounts[0]?.version).toBe(2);
});

test("a profile outage keeps provider-reported email and a valid sign-in", async () => {
  const scope = await fixture(),
    mock = provider();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/profile")
      ? Response.json({}, { status: 503 })
      : mock.fetchImpl(input, init)) as typeof fetch;
  const saved = await completeClaudeSubscriptionOAuth(
    deps,
    scope,
    await begin(scope),
    async () => {},
    fetchImpl,
  );
  const accounts = await listClaudeSubscriptionAccountsMetadata(client.db, {
    workspaceId: scope.workspaceId!,
    subjectId: scope.actorSubjectId,
  });
  expect(accounts[0]?.id).toBe(saved.accountId);
  expect(accounts[0]?.accountEmail).toBe("person@example.test");
  expect(accounts[0]?.planType).toBeNull();
});
