// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  claudeSubscriptionCapacity,
  parseClaudeUsageHeaders,
  parseClaudeUsageResponse,
  parseModelProvidersJson,
  emptyClaudeUsage,
  ClaudeSubscriptionCredential,
} from "@opengeni/config";
import {
  createDb,
  createClaudeSubscriptionAccount,
  upsertClaudeSubscriptionAccount,
  upsertOrganizationClaudeSubscription,
  setInitialActiveClaudeCredential,
  disconnectClaudeSubscriptionAccount,
  loadClaudeAccountCredential,
  listClaudeAccountUsage,
  recordClaudeAccountUsage,
  type ClaudeAccountUsageAuthority,
  type DbClient,
} from "../src";
import { prepareClaudeSubscriptionCredential } from "../../../apps/api/src/claude-workspace-connection";
import { refreshClaudeAccountUsage } from "../../../apps/api/src/claude-subscription-account-usage";
import {
  createClaudeUsageObserver,
  type CapturedClaudeUsage,
} from "../../../apps/worker/src/activities/agent-turn/claude-usage-observer";

const key = Buffer.alloc(32, 7);
const settings = testSettings({
  claudeSubscriptionEnabled: true,
  environmentsEncryptionKey: key.toString("base64"),
});
const setupToken = "sk-ant-oat01-fixture";
let shared: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("claude-subscription-usage");
  if (!acquired) throw new Error("Real PostgreSQL required for Claude usage verification");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type UsageAuthority = ClaudeAccountUsageAuthority & { credentialVersion: number };

// Normalize an absent metadata map entry only after the real RLS-scoped read.
async function readClaudeSubscriptionUsage(db: DbClient["db"], scope: UsageAuthority) {
  const values = await listClaudeAccountUsage(db, scope, [
    { id: scope.credentialId, version: scope.credentialVersion },
  ]);
  return values.get(scope.credentialId) ?? emptyClaudeUsage(null);
}
async function recordClaudeSubscriptionUsage(
  db: DbClient["db"],
  _settings: typeof settings,
  scope: UsageAuthority,
  input: {
    token: string;
    observation?: NonNullable<Parameters<typeof recordClaudeAccountUsage>[2]["observation"]>;
    expectedConnectionId?: string;
    expectedCredentialVersion?: number;
    refresh?: NonNullable<Parameters<typeof recordClaudeAccountUsage>[2]["refresh"]>;
  },
) {
  return recordClaudeAccountUsage(
    db,
    { ...scope, credentialId: input.expectedConnectionId ?? scope.credentialId },
    {
      ...input,
      encryptionKey: key,
      expectedCredentialVersion: input.expectedCredentialVersion ?? scope.credentialVersion,
    },
  );
}

async function fixture(fullScope = true) {
  const [account] = await shared.admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('Claude usage test') returning id`;
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${account!.id}, 'Claude usage workspace') returning id`;
  const subjectId = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${account!.id}, ${workspace!.id}, ${subjectId}, 'admin')`;
  const target = { accountId: account!.id, workspaceId: workspace!.id, subjectId };
  const bundle = prepareClaudeSubscriptionCredential(
    settings,
    "workspace:" + workspace!.id,
    setupToken,
  );
  const secret = ClaudeSubscriptionCredential.parse(JSON.parse(bundle));
  if (fullScope)
    secret.oauth = {
      refreshToken: "fixture-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: ["user:inference", "user:profile"],
    };
  const connected = await createClaudeSubscriptionAccount(client.db, {
    ...target,
    secret,
    encryptionKey: key,
    providerAccountId: "fixture:" + workspace!.id,
  });
  await setInitialActiveClaudeCredential(client.db, {
    ...target,
    credentialId: connected.account.id,
    authoritySnapshot: connected.authoritySnapshot,
  });
  const scope: UsageAuthority = {
    ...target,
    credentialId: connected.account.id,
    credentialVersion: connected.account.version,
    authoritySnapshot: connected.authoritySnapshot,
  };
  const [stored] = await shared.admin<
    { updatedAt: Date }[]
  >`select updated_at as "updatedAt" from claude_subscription_credentials where id = ${connected.account.id}`;
  return {
    scope,
    row: { ...connected.account, updatedAt: stored!.updatedAt.toISOString() },
    secret,
  };
}
async function reconnect(
  scope: UsageAuthority,
  secret: Parameters<typeof upsertClaudeSubscriptionAccount>[1]["secret"],
) {
  if (!scope.workspaceId) throw new Error("Workspace fixture required");
  return upsertClaudeSubscriptionAccount(client.db, {
    ...scope,
    workspaceId: scope.workspaceId,
    expectedCredentialVersion: scope.credentialVersion,
    secret,
    encryptionKey: key,
    providerAccountId: "fixture:" + scope.workspaceId,
  });
}
const observation = (time = new Date(), value = ".5") =>
  parseClaudeUsageHeaders(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-5h-reset": "1790785200",
      "anthropic-ratelimit-unified-7d-utilization": value,
      "anthropic-ratelimit-unified-7d-reset": "1791064800",
    }),
    time,
  )!;

test("worker responses received after same-token replacement cannot repopulate the new connection", async () => {
  const { scope, row, secret } = await fixture();
  const latest = new Map<string, CapturedClaudeUsage>();
  const observe = await createClaudeUsageObserver(
    parseModelProvidersJson(
      JSON.stringify([
        {
          id: "workspace-claude-subscription",
          kind: "claude-subscription-workspace",
          api: "anthropic-messages",
          apiKey: setupToken,
          baseUrl: "https://api.anthropic.com",
          models: [
            {
              id: "workspace-claude-subscription/claude-opus-5-5",
              upstreamModelId: "claude-opus-5-5",
            },
          ],
        },
      ]),
    ),
    latest,
    async () => {
      const credential = await loadClaudeAccountCredential(client.db, scope, key);
      return {
        token: credential.secret.token,
        connectionId: credential.id,
        credentialVersion: credential.version,
      };
    },
  );
  const replaced = await reconnect(scope, secret);
  expect(replaced.account.id).toBe(row.id);
  expect(replaced.account.version).toBe(row.version + 1);
  observe(
    "workspace-claude-subscription",
    new Response(null, {
      status: 429,
      headers: { "anthropic-ratelimit-unified-5h-utilization": "1" },
    }),
  );
  const snapshot = [...latest.values()][0]!;
  expect(snapshot.expectedConnectionId).toBe(row.id);
  expect(snapshot.expectedCredentialVersion).toBe(row.version);
  expect(await recordClaudeSubscriptionUsage(client.db, settings, scope, snapshot)).toBeNull();
  expect((await readClaudeSubscriptionUsage(client.db, scope)).windows).toEqual([]);
});

test("real app-role observations persist exact windows without changing credential or admission state", async () => {
  const { scope, row } = await fixture();
  const [before] =
    await shared.admin`select version, updated_at, organization_user_resource_authority_generation, access_policy_version from claude_subscription_credentials where id = ${row.id}`;
  expect((await readClaudeSubscriptionUsage(client.db, scope)).observedAt).toBeNull();
  await recordClaudeSubscriptionUsage(client.db, settings, scope, {
    token: setupToken,
    observation: observation(),
  });
  const value = await readClaudeSubscriptionUsage(client.db, scope);
  expect(value.windows.map((window) => window.usedPercent)).toEqual([100, 50]);
  expect(value.credentialVersion).toBe(row.version);
  expect(JSON.stringify(value)).not.toContain(setupToken);
  expect(JSON.stringify(value)).not.toContain("deviceId");
  const [after] =
    await shared.admin`select version, updated_at, organization_user_resource_authority_generation, access_policy_version from claude_subscription_credentials where id = ${row.id}`;
  expect(after).toEqual(before);
});
test("credential mismatch, replacement and revocation reject late observations", async () => {
  const { scope, row, secret } = await fixture();
  expect(
    await recordClaudeSubscriptionUsage(client.db, settings, scope, {
      token: "sk-ant-oat01-other",
      observation: observation(),
    }),
  ).toBeNull();
  await recordClaudeSubscriptionUsage(client.db, settings, scope, {
    token: setupToken,
    observation: observation(),
  });
  // Canonical reconnect retains account identity but fences the old generation.
  const rotated = await reconnect(scope, secret);
  expect(rotated.account.id).toBe(row.id);
  expect(rotated.account.version).toBe(row.version + 1);
  expect((await readClaudeSubscriptionUsage(client.db, scope)).windows).toEqual([]);
  expect(
    await recordClaudeSubscriptionUsage(client.db, settings, scope, {
      token: setupToken,
      expectedConnectionId: row.id,
      expectedCredentialVersion: row.version,
      observation: observation(),
    }),
  ).toBeNull();
  await disconnectClaudeSubscriptionAccount(client.db, {
    ...scope,
    workspaceId: scope.workspaceId!,
  });
  expect((await readClaudeSubscriptionUsage(client.db, scope)).connected).toBe(false);
  await expect(
    recordClaudeSubscriptionUsage(client.db, settings, scope, {
      token: setupToken,
      observation: observation(),
    }),
  ).rejects.toThrow("authority is no longer active");
});
test("out-of-order responses cannot overwrite a newer provider reading", async () => {
  const { scope } = await fixture();
  const first = new Date();
  await recordClaudeSubscriptionUsage(client.db, settings, scope, {
    token: setupToken,
    observation: observation(new Date(first.getTime() + 1000), ".7"),
  });
  await recordClaudeSubscriptionUsage(client.db, settings, scope, {
    token: setupToken,
    observation: observation(first, ".5"),
  });
  expect((await readClaudeSubscriptionUsage(client.db, scope)).windows[1]?.usedPercent).toBe(70);
});

test("model restrictions and direct-window provenance survive persisted observations", async () => {
  const { scope, row } = await fixture();
  const first = new Date(Math.max(Date.now(), Date.parse(row.updatedAt)) + 10);
  const reset = new Date(first.getTime() + 3_600_000);
  const headers = (status: string) =>
    new Headers({
      "anthropic-ratelimit-unified-status": status,
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(reset.getTime() / 1000),
      "anthropic-ratelimit-unified-5h-utilization": "1",
    });
  for (const [model, status, offset] of [
    ["claude-opus-5-5", "rejected", 0],
    ["claude-sonnet-5-5", "allowed", 1],
  ] as const)
    await recordClaudeSubscriptionUsage(client.db, settings, scope, {
      token: setupToken,
      expectedConnectionId: row.id,
      expectedCredentialVersion: row.version,
      observation: parseClaudeUsageHeaders(
        headers(status),
        new Date(first.getTime() + offset),
        model,
      )!,
    });
  const denied = await readClaudeSubscriptionUsage(client.db, scope);
  expect(denied.windows[0]!.source).toBe("response_headers");
  expect(denied.requestRestrictions).toHaveLength(2);
  expect(claudeSubscriptionCapacity(denied, "claude-opus-5-5", first).available).toBe(false);
  await recordClaudeSubscriptionUsage(client.db, settings, scope, {
    token: setupToken,
    expectedConnectionId: row.id,
    expectedCredentialVersion: row.version,
    observation: parseClaudeUsageResponse(
      { five_hour: { utilization: 20, resets_at: reset.toISOString() } },
      new Date(first.getTime() + 2),
    )!,
  });
  const refreshed = await readClaudeSubscriptionUsage(client.db, scope);
  expect(refreshed.windows[0]!.source).toBe("provider");
  expect(claudeSubscriptionCapacity(refreshed, "claude-opus-5-5", first).available).toBe(true);
  await recordClaudeSubscriptionUsage(client.db, settings, scope, {
    token: setupToken,
    expectedConnectionId: row.id,
    expectedCredentialVersion: row.version,
    observation: parseClaudeUsageHeaders(
      headers("allowed"),
      new Date(first.getTime() + 3),
      "claude-sonnet-5-5",
    )!,
  });
  const later = await readClaudeSubscriptionUsage(client.db, scope);
  expect(later.windows[0]!.source).toBe("response_headers");
  expect(claudeSubscriptionCapacity(later, "claude-opus-5-5", first).available).toBe(true);
});
test("a delayed finalized denial cannot undo a direct refresh in any persistence order", async () => {
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    const { scope, row } = await fixture();
    const first = new Date(Math.max(Date.now(), Date.parse(row.updatedAt)) + 10);
    const reset = new Date(first.getTime() + 3_600_000).toISOString();
    const headers = (status: string) =>
      new Headers({
        "anthropic-ratelimit-unified-status": status,
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-reset": String(Date.parse(reset) / 1000),
        "anthropic-ratelimit-unified-5h-utilization": status === "rejected" ? "1" : ".2",
      });
    const observations = [
      parseClaudeUsageHeaders(headers("rejected"), first, "claude-opus-5-5")!,
      parseClaudeUsageResponse(
        { five_hour: { utilization: 20, resets_at: reset } },
        new Date(first.getTime() + 1),
      )!,
      parseClaudeUsageHeaders(
        headers("allowed"),
        new Date(first.getTime() + 2),
        "claude-sonnet-5-5",
      )!,
    ];
    for (const index of order)
      await recordClaudeSubscriptionUsage(client.db, settings, scope, {
        token: setupToken,
        expectedConnectionId: row.id,
        expectedCredentialVersion: row.version,
        observation: observations[index]!,
      });
    const persisted = await readClaudeSubscriptionUsage(client.db, scope);
    expect(persisted.windows[0]!.source).toBe("response_headers");
    expect(claudeSubscriptionCapacity(persisted, "claude-opus-5-5", first).available).toBe(true);
  }
});

test("foreign account and foreign workspace reads do not reveal saved usage", async () => {
  const { scope } = await fixture();
  const other = await fixture();
  await recordClaudeSubscriptionUsage(client.db, settings, scope, {
    token: setupToken,
    observation: observation(),
  });
  expect(
    (await readClaudeSubscriptionUsage(client.db, { ...scope, accountId: other.scope.accountId }))
      .connected,
  ).toBe(false);
  expect(
    (
      await readClaudeSubscriptionUsage(client.db, {
        ...scope,
        workspaceId: other.scope.workspaceId,
      })
    ).connected,
  ).toBe(false);
  expect(
    await recordClaudeSubscriptionUsage(
      client.db,
      settings,
      { ...scope, accountId: other.scope.accountId },
      { token: setupToken, observation: observation() },
    ),
  ).toBeNull();
});
test("inference-only and provider scope errors retain headers and suppress unsupported lookups", async () => {
  for (const fullScope of [false, true]) {
    const { scope } = await fixture(fullScope);
    await recordClaudeSubscriptionUsage(client.db, settings, scope, {
      token: setupToken,
      observation: observation(),
    });
    let requests = 0;
    const fetcher = (async (url: string, init: RequestInit) => {
      requests++;
      expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
      expect(init.method ?? "GET").toBe("GET");
      expect(init.redirect).toBe("error");
      return Response.json(
        { error: { message: "OAuth token does not meet scope requirement user:profile" } },
        { status: 403 },
      );
    }) as typeof fetch;
    const result = await refreshClaudeAccountUsage(client.db, settings, scope, fetcher);
    expect(result.refreshStatus).toBe("scope_required");
    expect(result.windows.map((window) => window.usedPercent)).toEqual([100, 50]);
    expect(await refreshClaudeAccountUsage(client.db, settings, scope, fetcher)).toEqual(result);
    // Canonical setup tokens have no profile scope: reject locally with zero
    // network requests. Full-scope tokens cache the provider's first 403.
    expect(requests).toBe(fullScope ? 1 : 0);
  }
});
test("full-scope refresh persists genuine provider percentages and bounds malformed/error bodies", async () => {
  for (const [response, expected] of [
    [
      () =>
        Response.json({ five_hour: { utilization: 20, resets_at: "2026-09-30T18:20:00+02:00" } }),
      "available",
    ],
    [() => Response.json({}, { status: 401 }), "reconnect"],
    [() => new Response("x".repeat(65537)), "unavailable"],
    [() => Response.json({}, { status: 429 }), "unavailable"],
    [() => Response.json({ five_hour: { utilization: "bad" } }), "unavailable"],
  ] as const) {
    const { scope } = await fixture();
    const result = await refreshClaudeAccountUsage(client.db, settings, scope, (async () =>
      response()) as unknown as typeof fetch);
    expect(result.refreshStatus).toBe(expected);
    if (expected === "available") expect(result.windows[0]?.usedPercent).toBe(20);
    else expect(result.windows).toEqual([]);
  }
});
test("organization observations reuse administrator and runtime RLS while excluding another member", async () => {
  const { scope: workspaceScope } = await fixture();
  const [personal] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${workspaceScope.accountId}, 'Owner personal') returning id`;
  const owner = `user:${crypto.randomUUID()}`,
    member = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id) values (${workspaceScope.accountId}, ${owner}, 'owner', 'active', ${personal!.id})`;
  const [memberWorkspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${workspaceScope.accountId}, 'Member personal') returning id`;
  await shared.admin`insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id) values (${workspaceScope.accountId}, ${member}, 'member', 'active', ${memberWorkspace!.id})`;
  const secret = ClaudeSubscriptionCredential.parse(
    JSON.parse(
      prepareClaudeSubscriptionCredential(
        settings,
        "organization:" + workspaceScope.accountId,
        setupToken,
      ),
    ),
  );
  const organization = await upsertOrganizationClaudeSubscription(client.db, {
    organizationId: workspaceScope.accountId,
    actorSubjectId: owner,
    encryptionKey: key,
    secret,
    providerAccountId: "organization-fixture",
    label: null,
    accountEmail: null,
    expiresAt: null,
  });
  const runtime: UsageAuthority = {
    ...workspaceScope,
    subjectId: owner,
    credentialId: organization.account.id,
    credentialVersion: organization.account.version,
    authoritySnapshot: { version: 1, scope: "organization" },
  };
  await recordClaudeSubscriptionUsage(client.db, settings, runtime, {
    token: setupToken,
    observation: observation(),
  });
  const admin: UsageAuthority = {
    ...runtime,
    workspaceId: null,
    authoritySnapshot: { version: 1, scope: "organization" },
  };
  expect(
    (await readClaudeSubscriptionUsage(client.db, admin)).windows.map(
      (window) => window.usedPercent,
    ),
  ).toEqual([100, 50]);
  await expect(
    readClaudeSubscriptionUsage(client.db, { ...admin, subjectId: member }),
  ).rejects.toThrow();
  await expect(
    readClaudeSubscriptionUsage(client.db, {
      ...admin,
      subjectId: "",
    }),
  ).rejects.toThrow("setSubjectRlsContext: a non-empty subjectId is required");
});
