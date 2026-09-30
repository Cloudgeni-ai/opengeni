// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { parseClaudeUsageHeaders, parseModelProvidersJson } from "@opengeni/config";
import {
  createDb,
  encryptEnvironmentValue,
  readClaudeSubscriptionUsage,
  loadClaudeSubscriptionUsageCredential,
  recordClaudeSubscriptionUsage,
  upsertWorkspaceProviderApiKeyConnection,
  rotateWorkspaceProviderApiKeyConnection,
  revokeWorkspaceProviderApiKeyConnections,
  type ClaudeUsageScope,
  type DbClient,
} from "../src";
import { prepareClaudeSubscriptionCredential } from "../../../apps/api/src/claude-workspace-connection";
import { refreshClaudeSubscriptionUsage } from "../../../apps/api/src/claude-subscription-usage";
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

async function fixture() {
  const [account] = await shared.admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('Claude usage test') returning id`;
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${account!.id}, 'Claude usage workspace') returning id`;
  const scope: ClaudeUsageScope = {
    accountId: account!.id,
    workspaceId: workspace!.id,
    scope: "workspace",
  };
  const bundle = prepareClaudeSubscriptionCredential(
    settings,
    "workspace:" + workspace!.id,
    setupToken,
  );
  const credentialEncrypted = encryptEnvironmentValue(key, JSON.stringify({ apiKey: bundle }));
  const row = await upsertWorkspaceProviderApiKeyConnection(client.db, "claude_subscription", {
    accountId: scope.accountId,
    workspaceId: workspace!.id,
    credentialEncrypted,
    operationId: crypto.randomUUID(),
    requestDigest: "fixture-create",
    updatedBySubjectId: "test:claude-usage",
  });
  expect(row).not.toBeNull();
  return { scope, row: row!, credentialEncrypted };
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
  const { scope, row, credentialEncrypted } = await fixture();
  const latest = new Map<"workspace" | "organization", CapturedClaudeUsage>();
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
    () => loadClaudeSubscriptionUsageCredential(client.db, settings, scope),
  );
  await rotateWorkspaceProviderApiKeyConnection(client.db, "claude_subscription", {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId!,
    connectionId: row.id,
    expectedVersion: row.version,
    credentialEncrypted,
    operationId: crypto.randomUUID(),
    requestDigest: "worker-response-rotation",
    updatedBySubjectId: "test:claude-usage",
  });
  observe(
    "workspace-claude-subscription",
    new Response(null, {
      status: 429,
      headers: { "anthropic-ratelimit-unified-5h-utilization": "1" },
    }),
  );
  const snapshot = latest.get("workspace")!;
  expect(snapshot.expectedConnectionId).toBe(row.id);
  expect(snapshot.expectedCredentialVersion).toBe(row.version);
  expect(await recordClaudeSubscriptionUsage(client.db, settings, scope, snapshot)).toBeNull();
  expect((await readClaudeSubscriptionUsage(client.db, scope)).windows).toEqual([]);
});

test("real app-role observations persist exact windows without changing credential or admission state", async () => {
  const { scope, row } = await fixture();
  const [before] =
    await shared.admin`select version, updated_at, authority_generation, access_policy_version from connections where id = ${row.id}`;
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
    await shared.admin`select version, updated_at, authority_generation, access_policy_version from connections where id = ${row.id}`;
  expect(after).toEqual(before);
});
test("credential mismatch, replacement and revocation reject late observations", async () => {
  const { scope, row, credentialEncrypted } = await fixture();
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
  const rotated = await rotateWorkspaceProviderApiKeyConnection(client.db, "claude_subscription", {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId!,
    connectionId: row.id,
    expectedVersion: row.version,
    credentialEncrypted,
    operationId: crypto.randomUUID(),
    requestDigest: "fixture-replace",
    updatedBySubjectId: "test:claude-usage",
  });
  expect(rotated?.id).not.toBe(row.id);
  expect((await readClaudeSubscriptionUsage(client.db, scope)).windows).toEqual([]);
  expect(
    await recordClaudeSubscriptionUsage(client.db, settings, scope, {
      token: setupToken,
      expectedConnectionId: row.id,
      expectedCredentialVersion: row.version,
      observation: observation(),
    }),
  ).toBeNull();
  await revokeWorkspaceProviderApiKeyConnections(client.db, "claude_subscription", {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId!,
    connectionId: rotated!.id,
    expectedVersion: rotated!.version,
    updatedBySubjectId: "test:claude-usage",
  });
  expect((await readClaudeSubscriptionUsage(client.db, scope)).connected).toBe(false);
  expect(
    await recordClaudeSubscriptionUsage(client.db, settings, scope, {
      token: setupToken,
      observation: observation(),
    }),
  ).toBeNull();
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
test("inference-only scope errors retain header readings and suppress repeated unsupported lookups", async () => {
  const { scope } = await fixture();
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
  const result = await refreshClaudeSubscriptionUsage(client.db, settings, scope, fetcher);
  expect(result.refreshStatus).toBe("scope_required");
  expect(result.windows.map((window) => window.usedPercent)).toEqual([100, 50]);
  expect(await refreshClaudeSubscriptionUsage(client.db, settings, scope, fetcher)).toEqual(result);
  expect(requests).toBe(1);
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
    const result = await refreshClaudeSubscriptionUsage(client.db, settings, scope, (async () =>
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
  const encrypted = encryptEnvironmentValue(
    key,
    prepareClaudeSubscriptionCredential(
      settings,
      "organization:" + workspaceScope.accountId,
      setupToken,
    ),
  );
  await shared.admin`insert into organization_model_provider_connections (account_id, provider_kind, credential_encrypted, operation_id, request_hash, updated_by_subject_id) values (${workspaceScope.accountId}, 'claude_subscription', ${encrypted}, ${crypto.randomUUID()}, ${"a".repeat(64)}, ${owner})`;
  const runtime: ClaudeUsageScope = { ...workspaceScope, scope: "organization" };
  await recordClaudeSubscriptionUsage(client.db, settings, runtime, {
    token: setupToken,
    observation: observation(),
  });
  const admin: ClaudeUsageScope = { ...runtime, workspaceId: null, actorSubjectId: owner };
  expect(
    (await readClaudeSubscriptionUsage(client.db, admin)).windows.map(
      (window) => window.usedPercent,
    ),
  ).toEqual([100, 50]);
  await expect(
    readClaudeSubscriptionUsage(client.db, { ...admin, actorSubjectId: member }),
  ).rejects.toThrow();
  await expect(
    readClaudeSubscriptionUsage(client.db, {
      accountId: admin.accountId,
      workspaceId: null,
      scope: "organization",
    }),
  ).rejects.toThrow("administrator");
});
