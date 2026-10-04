import { TurnExecutionPolicyV1, TURN_EXECUTION_POLICY_METADATA_KEY } from "@opengeni/contracts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { emptyClaudeUsage, getSettings } from "@opengeni/config";
import { sql } from "drizzle-orm";
import {
  createDb,
  withSessionActivityRlsContext,
  armClaudeCapacityWait,
  getClaudeCapacityWaitForSession,
  reconcileClaudeCapacityWait,
  peekSessionWork,
  type DbClient,
} from "../src";
import {
  createClaudeSubscriptionAccount,
  upsertClaudeSubscriptionAccount,
  listClaudeSubscriptionAccountsMetadata,
  getClaudeRotationSettings,
  setInitialActiveClaudeCredential,
  setActiveClaudeCredential,
  updateClaudeRotationSettings,
  selectClaudeCredentialForUse,
  acquireClaudeCredentialLease,
  releaseClaudeCredentialLease,
  materializeClaudeSubscriptionAccountForRun,
  refreshClaudeSubscriptionAccountSerialized,
  renameClaudeSubscriptionAccount,
  type ClaudeAccountSecret,
} from "../src/claude-subscription-accounts";
import { resolveClaudeAccountCredential } from "../src/claude-subscription-account-tokens";
import {
  recordClaudeAccountUsage,
  listClaudeAccountUsage,
} from "../src/claude-subscription-account-usage";

let shared: SharedTestDatabase;
let client: DbClient;
const encryptionKey = Buffer.alloc(32, 41);
const authoritySnapshot = { version: 1, scope: "workspace" } as const;
const tokenSettings = getSettings({
  OPENGENI_ENVIRONMENT: "test",
  OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED: "true",
  OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY: encryptionKey.toString("base64"),
});
beforeAll(async () => {
  const databaseFixture = await acquireSharedTestDatabase("claude-account-pools");
  if (!databaseFixture) throw new Error("Real PostgreSQL required");
  shared = databaseFixture;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const [organization] = await shared.admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('Subscription fixture') returning id`;
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${organization!.id}, 'Account fixture') returning id`;
  const subjects = ["user:" + randomUUID(), "user:" + randomUUID()];
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${organization!.id})`;
  for (const subjectId of subjects) {
    const [personal] = await shared.admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${organization!.id}, 'Personal fixture') returning id`;
    await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions) values (${organization!.id}, ${workspace!.id}, ${subjectId}, 'owner', '[]'::jsonb)`;
    await shared.admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${organization!.id}, ${subjectId}, 'active', ${personal!.id})`;
  }
  return {
    accountId: organization!.id,
    workspaceId: workspace!.id,
    subjectId: subjects[0]!,
    otherSubjectId: subjects[1]!,
    authoritySnapshot,
  };
}
function secret(): ClaudeAccountSecret {
  return {
    version: 1,
    token: "sk-ant-oat01-fixture-" + randomUUID(),
    identity: { accountUuid: randomUUID(), deviceId: "a".repeat(64) },
    oauth: {
      refreshToken: "fixture-refresh-" + randomUUID(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ["user:inference", "user:profile"],
    },
  };
}
async function account(
  input: Awaited<ReturnType<typeof fixture>>,
  scope: "workspace" | "user" = "workspace",
) {
  const credential = secret();
  return createClaudeSubscriptionAccount(client.db, {
    ...input,
    scope,
    encryptionKey,
    secret: credential,
    providerAccountId: credential.identity.accountUuid,
    label: null,
    accountEmail: "account@example.test",
    planType: "claude_max",
    expiresAt: new Date(credential.oauth!.expiresAt),
  });
}
async function pool(input: Awaited<ReturnType<typeof fixture>>) {
  const a = await account(input),
    b = await account(input);
  await setInitialActiveClaudeCredential(client.db, { ...input, credentialId: a.account.id });
  const settings = (await getClaudeRotationSettings(client.db, input))!;
  await updateClaudeRotationSettings(client.db, {
    ...input,
    expectedVersion: settings.version,
    rotationEnabled: true,
  });
  return { a, b };
}
async function rejectOpus(
  input: Awaited<ReturnType<typeof fixture>>,
  id: string,
  version: number,
  now = new Date(),
) {
  const snapshot = {
    ...emptyClaudeUsage(version),
    windows: [
      {
        id: "seven_day_opus",
        usedPercent: 100,
        status: "rejected",
        resetsAt: new Date(now.getTime() + 3600_000).toISOString(),
        observedAt: now.toISOString(),
      },
    ],
    observedAt: now.toISOString(),
    source: "response_headers",
  };
  await shared.admin`insert into claude_subscription_account_usage (credential_id, account_id, credential_version, snapshot) values (${id}, ${input.accountId}, ${version}, ${JSON.stringify(snapshot)}::jsonb) on conflict (credential_id) do update set snapshot = excluded.snapshot, credential_version = excluded.credential_version`;
}
async function turn(input: Awaited<ReturnType<typeof fixture>>) {
  const policy = TurnExecutionPolicyV1.parse({
    schemaVersion: 1,
    productModelId: "fixture-model",
    requestedModelId: "fixture-model",
    modelSource: "explicit",
    reasoningEffort: "high",
    reasoningSource: "explicit",
    providerId: "fixture-claude",
    upstreamModelId: "claude-opus-fixture",
    wireApi: "anthropic-messages",
    credentialSource: { kind: "workspace_connection", mechanism: "api_key" },
    billing: { upstreamPayer: "workspace", metering: "external" },
    definitionVersion: "sha256:" + "1".repeat(64),
  });
  const metadata = { [TURN_EXECUTION_POLICY_METADATA_KEY]: policy };
  const sessionId = randomUUID(),
    turnId = randomUUID(),
    attemptId = randomUUID(),
    workflowId = "fixture-" + sessionId;
  await withSessionActivityRlsContext(client.db, input, async (tx) => {
    await tx.execute(
      sql`insert into sessions (id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, status, temporal_workflow_id, tool_policy) values (${sessionId}, ${input.accountId}, ${input.workspaceId}, 'Fixture', 'fixture-model', 'high', 'standard', 'none', ${sessionId}, 'running', ${workflowId}, '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb)`,
    );
    await tx.execute(
      sql`insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status, source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, execution_generation, active_attempt_id, metadata, initiating_human_subject_id, claude_provider_account_authority_snapshot) values (${turnId}, ${input.accountId}, ${input.workspaceId}, ${sessionId}, ${randomUUID()}, ${workflowId}, 'running', 'user', 1, 'Fixture', 'fixture-model', 'high', 'standard', 'none', 1, ${attemptId}, ${JSON.stringify(metadata)}::jsonb, ${input.subjectId}, ${JSON.stringify(input.authoritySnapshot)}::jsonb)`,
    );
    await tx.execute(sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`);
    await tx.execute(
      sql`insert into session_turn_attempts (id, account_id, workspace_id, session_id, turn_id, execution_generation, state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id, verified_control_revision, mcp_approval_policies) values (${attemptId}, ${input.accountId}, ${input.workspaceId}, ${sessionId}, ${turnId}, 1, 'running', ${workflowId}, ${"fixture-run-" + attemptId}, 'fixture-activity', 0, '{}'::jsonb)`,
    );
  });
  return { sessionId, turnId, attemptId, workflowId };
}

test("forced OAuth renewal serializes rejected tokens without changing account identity or generation", async () => {
  const input = await fixture(),
    connected = await account(input);
  const authority = { ...input, credentialId: connected.account.id };
  const before = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...authority,
    encryptionKey,
  });
  let refreshes = 0;
  const token = "sk-ant-oat01-renewed-" + randomUUID();
  const fetchImpl = (async (_url: unknown, request?: RequestInit) => {
    refreshes++;
    expect(JSON.parse(request!.body as string)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: before.secret.oauth!.refreshToken,
    });
    return Response.json({
      access_token: token,
      refresh_token: "fixture-renewed-refresh",
      expires_in: 7200,
      scope: "user:inference user:profile",
    });
  }) as typeof fetch;
  const options = {
    fetchImpl,
    forceRefresh: true,
    observedAccessToken: before.secret.token,
    expectedCredentialVersion: before.version,
  };
  const results = await Promise.all([
    resolveClaudeAccountCredential(client.db, tokenSettings, authority, options),
    resolveClaudeAccountCredential(client.db, tokenSettings, authority, options),
  ]);
  expect(refreshes).toBe(1);
  for (const result of results) {
    expect(result.version).toBe(before.version);
    expect(result.secret.token).toBe(token);
    expect(result.secret.identity).toEqual(before.secret.identity);
  }
  await resolveClaudeAccountCredential(client.db, tokenSettings, authority, options);
  expect(refreshes).toBe(1);
  expect(
    await recordClaudeAccountUsage(client.db, authority, {
      encryptionKey,
      token: before.secret.token,
      expectedCredentialVersion: before.version,
      refresh: { status: "reconnect", checkedAt: new Date().toISOString() },
    }),
  ).toBeNull();
});

test("setup tokens never refresh and invalid OAuth grants become ineligible", async () => {
  const input = await fixture();
  const bundle = secret();
  delete bundle.oauth;
  const setup = await createClaudeSubscriptionAccount(client.db, {
    ...input,
    encryptionKey,
    secret: bundle,
    providerAccountId: bundle.identity.accountUuid,
  });
  const setupAuthority = { ...input, credentialId: setup.account.id };
  let refreshes = 0;
  const fetchImpl = (async () => {
    refreshes++;
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }) as unknown as typeof fetch;
  const result = await resolveClaudeAccountCredential(client.db, tokenSettings, setupAuthority, {
    fetchImpl,
    forceRefresh: true,
  });
  expect(result.secret.token).toBe(bundle.token);
  expect(refreshes).toBe(0);
  const connected = await account(input);
  const authority = { ...input, credentialId: connected.account.id };
  await setActiveClaudeCredential(client.db, { ...input, credentialId: connected.account.id });
  const rotation = (await getClaudeRotationSettings(client.db, input))!;
  await updateClaudeRotationSettings(client.db, {
    ...input,
    expectedVersion: rotation.version,
    rotationEnabled: false,
  });
  const rejected = await resolveClaudeAccountCredential(client.db, tokenSettings, authority, {
    fetchImpl,
    forceRefresh: true,
  });
  expect(rejected).toHaveProperty("reconnectRequired", true);
  expect(refreshes).toBe(1);
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...input,
        shardKey: randomUUID(),
        upstreamModelId: "claude-opus-fixture",
      })
    ).credentialId,
  ).toBeNull();
  await resolveClaudeAccountCredential(client.db, tokenSettings, authority, {
    fetchImpl,
    forceRefresh: true,
  });
  expect(refreshes).toBe(1);
});

test("local model backpressure preserves reported usage and cannot cross account or token fences", async () => {
  const input = await fixture(),
    { a, b } = await pool(input);
  const authority = { ...input, credentialId: a.account.id };
  const credential = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...authority,
    encryptionKey,
  });
  const now = new Date(),
    until = new Date(now.getTime() + 120_000);
  const receipt = {
    encryptionKey,
    expectedCredentialVersion: credential.version,
    token: credential.secret.token,
  };
  await recordClaudeAccountUsage(client.db, authority, {
    ...receipt,
    observation: {
      source: "response_headers",
      observedAt: now.toISOString(),
      windows: [
        {
          id: "five_hour",
          usedPercent: 23,
          status: "allowed",
          observedAt: now.toISOString(),
          resetsAt: new Date(now.getTime() + 3600_000).toISOString(),
        },
      ],
    },
  });
  const before = (await listClaudeAccountUsage(client.db, input, [a.account])).get(a.account.id)!;
  await recordClaudeAccountUsage(client.db, authority, {
    ...receipt,
    modelCooldown: { upstreamModelId: "claude-opus-fixture", until },
  });
  expect((await listClaudeAccountUsage(client.db, input, [a.account])).get(a.account.id)).toEqual(
    before,
  );
  expect(
    await recordClaudeAccountUsage(
      client.db,
      { ...authority, credentialId: b.account.id },
      { ...receipt, modelCooldown: { upstreamModelId: "claude-opus-fixture", until } },
    ),
  ).toBeNull();
  const request = {
    ...input,
    shardKey: randomUUID(),
    pinnedCredentialId: a.account.id,
    pinSource: "policy" as const,
    upstreamModelId: "claude-opus-fixture",
    now,
  };
  expect((await selectClaudeCredentialForUse(client.db, request)).credentialId).toBe(b.account.id);
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...request,
        upstreamModelId: "claude-sonnet-fixture",
      })
    ).credentialId,
  ).toBe(a.account.id);
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...request,
        now: new Date(until.getTime() + 1),
      })
    ).credentialId,
  ).toBe(a.account.id);
});

test("concurrent sign-ins converge on one provider identity within its exact owner pool", async () => {
  const input = await fixture(),
    bundle = secret();
  const request = {
    ...input,
    encryptionKey,
    secret: bundle,
    providerAccountId: bundle.identity.accountUuid,
  };
  const [first, second] = await Promise.all([
    upsertClaudeSubscriptionAccount(client.db, request),
    upsertClaudeSubscriptionAccount(client.db, request),
  ]);
  expect(first.account.id).toBe(second.account.id);
  expect(await listClaudeSubscriptionAccountsMetadata(client.db, input)).toHaveLength(1);
  const privateAccount = await upsertClaudeSubscriptionAccount(client.db, {
    ...request,
    scope: "user",
  });
  expect(privateAccount.account.id).not.toBe(first.account.id);
  const other = await upsertClaudeSubscriptionAccount(client.db, {
    ...request,
    scope: "user",
    subjectId: input.otherSubjectId,
  });
  expect(other.account.id).not.toBe(privateAccount.account.id);
});

test("multiple subscriptions preserve separate identity, email and encrypted secrets", async () => {
  const input = await fixture(),
    { a, b } = await pool(input);
  const listed = await listClaudeSubscriptionAccountsMetadata(client.db, input);
  expect(listed.map((row) => row.id)).toEqual([a.account.id, b.account.id]);
  expect(
    listed.every(
      (row) => row.accountEmail === "account@example.test" && row.planType === "claude_max",
    ),
  ).toBe(true);
  expect(JSON.stringify(listed)).not.toContain("sk-ant-");
  const first = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...input,
    credentialId: a.account.id,
    encryptionKey,
  });
  const second = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...input,
    credentialId: b.account.id,
    encryptionKey,
  });
  expect(first.secret.token).not.toBe(second.secret.token);
  expect(a.account.providerAccountId).toBe(first.secret.identity.accountUuid);
  expect(b.account.providerAccountId).toBe(second.secret.identity.accountUuid);
});

test("an Opus quota does not exhaust Sonnet; manual pin never borrows another account", async () => {
  const input = await fixture(),
    { a, b } = await pool(input),
    now = new Date();
  await rejectOpus(input, a.account.id, a.account.version, now);
  const selection = {
    ...input,
    shardKey: randomUUID(),
    now,
    pinnedCredentialId: a.account.id,
    pinSource: "manual" as const,
  };
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...selection,
        upstreamModelId: "claude-opus-fixture",
      })
    ).credentialId,
  ).toBeNull();
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...selection,
        upstreamModelId: "claude-sonnet-fixture",
      })
    ).credentialId,
  ).toBe(a.account.id);
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...input,
        shardKey: selection.shardKey,
        now,
        upstreamModelId: "claude-opus-fixture",
      })
    ).credentialId,
  ).toBe(b.account.id);
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...selection,
        now: new Date(now.getTime() + 3600_001),
        upstreamModelId: "claude-opus-fixture",
      })
    ).credentialId,
  ).toBe(a.account.id);
});

test("primary-only selection waits instead of borrowing a second subscription", async () => {
  const input = await fixture(),
    { a } = await pool(input);
  const settings = (await getClaudeRotationSettings(client.db, input))!;
  await updateClaudeRotationSettings(client.db, {
    ...input,
    expectedVersion: settings.version,
    rotationEnabled: false,
  });
  await rejectOpus(input, a.account.id, a.account.version);
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...input,
        shardKey: randomUUID(),
        upstreamModelId: "claude-opus-fixture",
      })
    ).credentialId,
  ).toBeNull();
});

test("a retained lease rechecks capacity and keeps exact holder-generation fencing", async () => {
  const input = await fixture(),
    { a, b } = await pool(input),
    accepted = await turn(input);
  const request = {
    ...input,
    ...accepted,
    holderId: "fixture-holder-a",
    upstreamModelId: "claude-opus-fixture",
    pinnedCredentialId: a.account.id,
    pinSource: "policy" as const,
  };
  const lease = await acquireClaudeCredentialLease(client.db, request);
  expect(lease.credentialId).toBe(a.account.id);
  const takeover = await acquireClaudeCredentialLease(client.db, {
    ...request,
    holderId: "fixture-holder-b",
  });
  expect(takeover.generation).toBe(lease.generation! + 1);
  await releaseClaudeCredentialLease(client.db, { ...request, generation: lease.generation! });
  const retained = await acquireClaudeCredentialLease(client.db, {
    ...request,
    holderId: "fixture-holder-b",
  });
  expect(retained.reused).toBe(true);
  await rejectOpus(input, a.account.id, a.account.version);
  const rotated = await acquireClaudeCredentialLease(client.db, {
    ...request,
    holderId: "fixture-holder-b",
  });
  expect(rotated.credentialId).toBe(b.account.id);
  expect(rotated.reused).toBe(false);
});

test("token renewal preserves generation; explicit replacement advances it; naming preserves quotas", async () => {
  const input = await fixture(),
    connected = await account(input),
    credentialId = connected.account.id;
  const current = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...input,
    credentialId,
    encryptionKey,
  });
  let refreshes = 0;
  const renew = async () => {
    refreshes++;
    return {
      secret: {
        ...current.secret,
        token: "sk-ant-oat01-renewed-fixture",
        oauth: { ...current.secret.oauth!, refreshToken: "renewed-fixture-refresh" },
      },
      expiresAt: new Date(Date.now() + 7200_000),
    };
  };
  const request = {
    ...input,
    credentialId,
    encryptionKey,
    observedAccessToken: current.secret.token,
    observedRefreshToken: current.secret.oauth!.refreshToken,
    refresh: renew,
  };
  const [first, second] = await Promise.all([
    refreshClaudeSubscriptionAccountSerialized(client.db, request),
    refreshClaudeSubscriptionAccountSerialized(client.db, request),
  ]);
  expect(refreshes).toBe(1);
  expect(first.credential.version).toBe(current.version);
  expect(second.credential.version).toBe(current.version);
  expect(
    (await renameClaudeSubscriptionAccount(client.db, {
      ...input,
      credentialId,
      label: "Named account",
    }))!.version,
  ).toBe(current.version);
  const replaced = await upsertClaudeSubscriptionAccount(client.db, {
    ...input,
    credentialId,
    encryptionKey,
    secret: secret(),
    providerAccountId: current.providerAccountId,
    label: "Named account",
    accountEmail: current.accountEmail,
    planType: current.planType,
    expiresAt: new Date(Date.now() + 7200_000),
  });
  expect(replaced.account.id).toBe(credentialId);
  expect(replaced.account.version).toBe(current.version + 1);
});

test("another user cannot read or materialize a private subscription", async () => {
  const input = await fixture(),
    connected = await account(input, "user");
  const other = { ...input, subjectId: input.otherSubjectId };
  expect(await listClaudeSubscriptionAccountsMetadata(client.db, other)).toEqual([]);
  await expect(
    materializeClaudeSubscriptionAccountForRun(client.db, {
      ...other,
      credentialId: connected.account.id,
      encryptionKey,
      authoritySnapshot: connected.authoritySnapshot,
    }),
  ).rejects.toThrow();
  const credential = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...input,
    credentialId: connected.account.id,
    encryptionKey,
    authoritySnapshot: connected.authoritySnapshot,
  });
  expect(credential.id).toBe(connected.account.id);
});

test("usage binds the exact account, token and generation across renewal and replacement", async () => {
  const input = await fixture(),
    { a, b } = await pool(input);
  const current = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...input,
    credentialId: a.account.id,
    encryptionKey,
  });
  const authority = { ...input, credentialId: a.account.id };
  const now = new Date();
  const receipt = {
    encryptionKey,
    expectedCredentialVersion: current.version,
    token: current.secret.token,
    observation: {
      observedAt: now.toISOString(),
      source: "response_headers" as const,
      windows: [
        {
          id: "seven_day_opus" as const,
          usedPercent: 100,
          status: "rejected" as const,
          observedAt: now.toISOString(),
          resetsAt: new Date(now.getTime() + 3600_000).toISOString(),
        },
      ],
    },
  };
  expect(
    (await recordClaudeAccountUsage(client.db, authority, receipt))?.windows[0]?.usedPercent,
  ).toBe(100);
  expect(
    await recordClaudeAccountUsage(
      client.db,
      { ...authority, credentialId: b.account.id },
      receipt,
    ),
  ).toBeNull();
  expect(
    (await listClaudeAccountUsage(client.db, input, [a.account, b.account])).get(b.account.id)
      ?.windows,
  ).toEqual([]);
  const renewed = await refreshClaudeSubscriptionAccountSerialized(client.db, {
    ...input,
    credentialId: current.id,
    encryptionKey,
    observedAccessToken: current.secret.token,
    observedRefreshToken: current.secret.oauth!.refreshToken,
    refresh: async () => ({
      secret: { ...current.secret, token: "sk-ant-oat01-fixture-renewed-" + randomUUID() },
      expiresAt: new Date(Date.now() + 7200_000),
    }),
  });
  expect(await recordClaudeAccountUsage(client.db, authority, receipt)).toBeNull();
  expect(
    (await listClaudeAccountUsage(client.db, input, [a.account])).get(a.account.id)?.windows[0]
      ?.usedPercent,
  ).toBe(100);
  expect(
    await recordClaudeAccountUsage(client.db, authority, {
      ...receipt,
      token: renewed.credential.secret.token,
      observation: {
        ...receipt.observation,
        observedAt: new Date(now.getTime() - 1000).toISOString(),
        windows: [],
      },
    }),
  ).not.toBeNull();
  const replaced = await upsertClaudeSubscriptionAccount(client.db, {
    ...input,
    credentialId: current.id,
    encryptionKey,
    secret: secret(),
    providerAccountId: current.providerAccountId,
    expiresAt: new Date(Date.now() + 7200_000),
  });
  expect(
    await recordClaudeAccountUsage(client.db, authority, {
      ...receipt,
      token: renewed.credential.secret.token,
    }),
  ).toBeNull();
  const latest = (await listClaudeAccountUsage(client.db, input, [replaced.account])).get(
    current.id,
  )!;
  expect(latest.credentialVersion).toBe(current.version + 1);
  expect(latest.windows).toEqual([]);
});

test("usage bulk reads do not reveal another user's private account", async () => {
  const input = await fixture(),
    connected = await account(input, "user");
  const current = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...input,
    credentialId: connected.account.id,
    authoritySnapshot: connected.authoritySnapshot,
    encryptionKey,
  });
  await recordClaudeAccountUsage(
    client.db,
    { ...input, credentialId: current.id, authoritySnapshot: connected.authoritySnapshot },
    {
      encryptionKey,
      token: current.secret.token,
      expectedCredentialVersion: current.version,
      refresh: { status: "available", checkedAt: new Date().toISOString() },
    },
  );
  expect(
    (
      await listClaudeAccountUsage(client.db, { ...input, subjectId: input.otherSubjectId }, [
        connected.account,
      ])
    ).size,
  ).toBe(0);
  await expect(
    recordClaudeAccountUsage(
      client.db,
      {
        ...input,
        subjectId: input.otherSubjectId,
        credentialId: current.id,
        authoritySnapshot: connected.authoritySnapshot,
      },
      { encryptionKey, token: current.secret.token, expectedCredentialVersion: current.version },
    ),
  ).rejects.toThrow();
});

test("model policy targets one subscription, preserves optimistic concurrency and rejects foreign private ownership", async () => {
  const { getModelConnectionAccess, updateModelConnectionAccess } = await import("../src");
  const input = await fixture(),
    { a, b } = await pool(input);
  const target = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    kind: "claude_subscription" as const,
    connectionId: a.account.id,
  };
  const original = (await getModelConnectionAccess(client.db, target))!;
  const restricted = {
    ...original,
    allowedModels: ["workspace-claude-subscription/claude-sonnet-fixture"],
  };
  const saved = await updateModelConnectionAccess(client.db, target, restricted);
  expect(saved?.version).toBe(original.version + 1);
  expect(saved?.allowedModels).toEqual(restricted.allowedModels);
  expect(await updateModelConnectionAccess(client.db, target, restricted)).toBeNull();
  expect(
    (await getModelConnectionAccess(client.db, { ...target, connectionId: b.account.id }))
      ?.allowedModels,
  ).toBeNull();
  const privateAccount = await account(input, "user");
  const foreign = {
    ...target,
    subjectId: input.otherSubjectId,
    connectionId: privateAccount.account.id,
  };
  expect(await getModelConnectionAccess(client.db, foreign)).toBeNull();
  expect(await updateModelConnectionAccess(client.db, foreign, restricted)).toBeNull();
});

test("model admission uses the exact frozen Claude account and keeps exhausted models in the catalog", async () => {
  const {
    assertModelConnectionAllowsTurn,
    getWorkspaceConnectionModelRestrictions,
    updateModelConnectionAccess,
    getModelConnectionAccess,
  } = await import("../src");
  const input = await fixture(),
    { a, b } = await pool(input);
  const sonnet = "workspace-claude-subscription/claude-sonnet-fixture";
  const opus = "workspace-claude-subscription/claude-opus-fixture";
  const target = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    kind: "claude_subscription" as const,
    connectionId: a.account.id,
  };
  const policy = (await getModelConnectionAccess(client.db, target))!;
  await updateModelConnectionAccess(client.db, target, { ...policy, allowedModels: [sonnet] });
  const modelTurn = {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    modelId: opus,
    claudeCredentialId: a.account.id,
    claudeAuthoritySnapshot: authoritySnapshot,
  };
  await expect(assertModelConnectionAllowsTurn(client.db, modelTurn)).rejects.toThrow("disabled");
  await expect(
    assertModelConnectionAllowsTurn(client.db, { ...modelTurn, claudeCredentialId: b.account.id }),
  ).resolves.toBeUndefined();
  await expect(
    assertModelConnectionAllowsTurn(client.db, { ...modelTurn, modelId: sonnet }),
  ).resolves.toBeUndefined();
  await expect(
    assertModelConnectionAllowsTurn(client.db, {
      ...modelTurn,
      claudeAuthoritySnapshot: { version: 1, scope: "organization" },
    }),
  ).rejects.toThrow("accepted");
  const settings = (await getClaudeRotationSettings(client.db, input))!;
  await updateClaudeRotationSettings(client.db, {
    ...input,
    expectedVersion: settings.version,
    rotationEnabled: false,
  });
  await rejectOpus(input, a.account.id, a.account.version);
  const restrictions = await getWorkspaceConnectionModelRestrictions(
    client.db,
    input.workspaceId,
    input.subjectId,
    undefined,
    authoritySnapshot,
  );
  expect(restrictions["workspace-claude-subscription/"]).toEqual([sonnet]);
  expect(restrictions["organization-claude-subscription/"]).toEqual([]);
});

test("capacity deadlines respect a manual pin instead of another account's earlier reset", async () => {
  const input = await fixture(),
    { a, b } = await pool(input),
    now = new Date();
  await rejectOpus(input, a.account.id, a.account.version, now);
  await rejectOpus(input, b.account.id, b.account.version, new Date(now.getTime() - 1800_000));
  const selection = {
    ...input,
    shardKey: randomUUID(),
    now,
    upstreamModelId: "claude-opus-fixture",
  };
  const pinned = await selectClaudeCredentialForUse(client.db, {
    ...selection,
    pinnedCredentialId: a.account.id,
    pinSource: "manual",
  });
  expect(pinned.credentialId).toBeNull();
  expect(pinned.nextCheckAt?.getTime()).toBe(now.getTime() + 3600_000);
  const rotating = await selectClaudeCredentialForUse(client.db, selection);
  expect(rotating.nextCheckAt?.getTime()).toBe(now.getTime() + 1800_000);
  const sonnet = await selectClaudeCredentialForUse(client.db, {
    ...selection,
    upstreamModelId: "claude-sonnet-fixture",
  });
  expect(sonnet.credentialId).not.toBeNull();
  expect(sonnet.nextCheckAt).toBeNull();
});

test("a retained lease obeys a changed manual pin and primary-only account", async () => {
  const input = await fixture(),
    { a, b } = await pool(input),
    accepted = await turn(input);
  const request = {
    ...input,
    ...accepted,
    holderId: "fixture-pin-change",
    upstreamModelId: "claude-sonnet-fixture",
    pinSource: "manual" as const,
  };
  const initial = await acquireClaudeCredentialLease(client.db, {
    ...request,
    pinnedCredentialId: a.account.id,
  });
  expect(initial.credentialId).toBe(a.account.id);
  const pinned = await acquireClaudeCredentialLease(client.db, {
    ...request,
    pinnedCredentialId: b.account.id,
  });
  expect(pinned.credentialId).toBe(b.account.id);
  expect(pinned.reused).toBe(false);
  const settings = (await getClaudeRotationSettings(client.db, input))!;
  await updateClaudeRotationSettings(client.db, {
    ...input,
    expectedVersion: settings.version,
    rotationEnabled: false,
  });
  await setActiveClaudeCredential(client.db, { ...input, credentialId: a.account.id });
  const primary = await acquireClaudeCredentialLease(client.db, {
    ...request,
    pinnedCredentialId: null,
    pinSource: null,
  });
  expect(primary.credentialId).toBe(a.account.id);
  expect(primary.reused).toBe(false);
});

test("accepted private authority survives disconnect while catalog access closes that exact pool", async () => {
  const {
    getSessionTurnClaudeProviderAccountAuthoritySnapshot,
    getWorkspaceConnectionModelRestrictions,
  } = await import("../src");
  const { disconnectClaudeSubscriptionAccountAndRepick } =
    await import("../src/claude-subscription-accounts");
  const input = await fixture(),
    connected = await account(input, "user");
  const acceptedInput = { ...input, authoritySnapshot: connected.authoritySnapshot };
  const accepted = await turn(acceptedInput as typeof input);
  await disconnectClaudeSubscriptionAccountAndRepick(client.db, {
    ...acceptedInput,
    credentialId: connected.account.id,
  });
  expect(
    await getSessionTurnClaudeProviderAccountAuthoritySnapshot(
      client.db,
      input.workspaceId,
      accepted.sessionId,
      accepted.turnId,
    ),
  ).toEqual(connected.authoritySnapshot);
  const restrictions = await getWorkspaceConnectionModelRestrictions(
    client.db,
    input.workspaceId,
    input.subjectId,
    undefined,
    connected.authoritySnapshot,
  );
  expect(restrictions["workspace-claude-subscription/"]).toEqual([]);
  expect(restrictions["organization-claude-subscription/"]).toEqual([]);
});

test("same-generation renewal clears obsolete reconnect evidence and fences old refusals", async () => {
  const input = await fixture(),
    { a } = await pool(input),
    running = await turn(input);
  const authority = { ...input, credentialId: a.account.id };
  const original = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...authority,
    encryptionKey,
  });
  const holderId = "fixture-holder-" + randomUUID();
  const lease = await acquireClaudeCredentialLease(client.db, {
    ...input,
    ...running,
    holderId,
    upstreamModelId: "claude-opus-fixture",
    pinnedCredentialId: a.account.id,
    pinSource: "manual",
  });
  await rejectOpus(input, a.account.id, original.version);
  const cooldown = new Date(Date.now() + 120_000);
  await recordClaudeAccountUsage(client.db, authority, {
    encryptionKey,
    token: original.secret.token,
    expectedCredentialVersion: original.version,
    refresh: { status: "reconnect", checkedAt: new Date().toISOString() },
    modelCooldown: { upstreamModelId: "claude-sonnet-fixture", until: cooldown },
  });
  const before = await listClaudeAccountUsage(client.db, input, [a.account]);
  const renewed = await refreshClaudeSubscriptionAccountSerialized(client.db, {
    ...authority,
    encryptionKey,
    observedAccessToken: original.secret.token,
    observedRefreshToken: original.secret.oauth!.refreshToken,
    refresh: async () => ({
      secret: { ...original.secret, token: "sk-ant-oat01-fixture-" + randomUUID() },
      expiresAt: new Date(original.secret.oauth!.expiresAt),
    }),
  });
  expect(renewed.credential.version).toBe(original.version);
  const after = (await listClaudeAccountUsage(client.db, input, [a.account])).get(a.account.id)!;
  expect(after.refreshStatus).toBe("not_checked");
  expect(after.refreshCheckedAt).toBeNull();
  expect(after.windows).toEqual(before.get(a.account.id)!.windows);
  const [retained] =
    await shared.admin`select model_cooldowns from claude_subscription_account_usage where credential_id = ${a.account.id}`;
  expect(retained!.model_cooldowns["claude-sonnet-fixture"]).toBe(cooldown.toISOString());
  const wait = {
    ...input,
    ...running,
    earliestResetAt: null,
    failurePayload: { code: "claude_relogin_required" },
    leaseFence: { holderId, generation: lease.generation! },
    expectedCredentialVersion: original.version,
    credentialQuarantine: {
      kind: "status" as const,
      status: "needs_relogin" as const,
      lastError: "Synthetic refusal",
    },
  };
  expect(
    await armClaudeCapacityWait(client.db, {
      ...wait,
      credentialTokenFence: { encryptionKey, observedAccessToken: original.secret.token },
    }),
  ).toMatchObject({ action: "stale" });
  expect(
    await getClaudeCapacityWaitForSession(client.db, input.workspaceId, running.sessionId),
  ).toBeNull();
  expect(
    (await listClaudeSubscriptionAccountsMetadata(client.db, input)).find(
      (value) => value.id === a.account.id,
    )?.status,
  ).toBe("active");
  expect(
    await armClaudeCapacityWait(client.db, {
      ...wait,
      credentialTokenFence: { encryptionKey, observedAccessToken: renewed.credential.secret.token },
    }),
  ).toMatchObject({ action: "waiting" });
});

test("an old attempt cannot quarantine a replaced subscription generation", async () => {
  const input = await fixture(),
    { a } = await pool(input),
    running = await turn(input);
  const holderId = "fixture-holder-" + randomUUID();
  const lease = await acquireClaudeCredentialLease(client.db, {
    ...input,
    ...running,
    holderId,
    upstreamModelId: "claude-opus-fixture",
    pinnedCredentialId: a.account.id,
    pinSource: "manual",
  });
  const credential = secret();
  const original = await materializeClaudeSubscriptionAccountForRun(client.db, {
    ...input,
    credentialId: a.account.id,
    encryptionKey,
  });
  const replacement = await upsertClaudeSubscriptionAccount(client.db, {
    ...input,
    credentialId: a.account.id,
    encryptionKey,
    secret: credential,
    providerAccountId: credential.identity.accountUuid,
    expectedCredentialVersion: a.account.version,
  });
  expect(
    await armClaudeCapacityWait(client.db, {
      ...input,
      ...running,
      earliestResetAt: null,
      failurePayload: { code: "claude_relogin_required" },
      leaseFence: { holderId, generation: lease.generation! },
      expectedCredentialVersion: a.account.version,
      credentialTokenFence: { encryptionKey, observedAccessToken: original.secret.token },
      credentialQuarantine: {
        kind: "status",
        status: "needs_relogin",
        lastError: "Synthetic refusal",
      },
    }),
  ).toMatchObject({ action: "stale" });
  const accounts = await listClaudeSubscriptionAccountsMetadata(client.db, input);
  expect(accounts.find((value) => value.id === replacement.account.id)).toMatchObject({
    status: "active",
    version: a.account.version + 1,
  });
  expect(
    await getClaudeCapacityWaitForSession(client.db, input.workspaceId, running.sessionId),
  ).toBeNull();
});

test.each(["workspace", "user"] as const)(
  "setup-token replacement is fenced to the selected %s account",
  async (scope) => {
    const input = await fixture();
    const connected = await account(input, scope);
    const replacement = secret();
    delete replacement.oauth;
    replacement.identity.accountUuid = "";
    const expected = {
      ...input,
      credentialId: connected.account.id,
      scope,
      authoritySnapshot: connected.authoritySnapshot,
      encryptionKey,
      expectedCredentialVersion: connected.account.version,
      expectedProviderAccountId: connected.account.providerAccountId,
      providerAccountId: "setup:" + randomUUID(),
      secret: replacement,
      label: connected.account.label,
      accountEmail: null,
      planType: null,
    };
    const updated = await upsertClaudeSubscriptionAccount(client.db, expected);
    expect(updated.account).toMatchObject({
      id: connected.account.id,
      scope,
      version: connected.account.version + 1,
      accountEmail: null,
      planType: null,
    });
    expect(
      (
        await materializeClaudeSubscriptionAccountForRun(client.db, {
          ...input,
          credentialId: updated.account.id,
          authoritySnapshot: updated.authoritySnapshot,
          encryptionKey,
        })
      ).secret,
    ).toEqual(replacement);
    await expect(upsertClaudeSubscriptionAccount(client.db, expected)).rejects.toThrow();
    expect(
      (await listClaudeSubscriptionAccountsMetadata(client.db, input)).filter(
        (candidate) => candidate.id === updated.account.id,
      ),
    ).toHaveLength(1);
  },
);

test("Claude capacity waits preserve the accepted turn and recheck the exact model windows", async () => {
  const input = await fixture(),
    { a, b } = await pool(input),
    running = await turn(input),
    now = new Date();
  await rejectOpus(input, a.account.id, a.account.version, now);
  await rejectOpus(input, b.account.id, b.account.version, now);
  const armed = await armClaudeCapacityWait(client.db, {
    ...input,
    ...running,
    earliestResetAt: new Date(now.getTime() + 3600_000),
    failurePayload: {
      code: "claude_capacity_unavailable",
      error: "Synthetic capacity unavailable",
    },
    now,
  });
  expect(armed.action).toBe("waiting");
  if (armed.action !== "waiting") throw Error("Expected capacity waiter");
  expect(
    armed.events.find((event) => event.type === "turn.capacity_waiting")?.payload,
  ).toMatchObject({ provider: "claude-subscription", recovery: "provider_capacity" });
  expect(
    await getClaudeCapacityWaitForSession(client.db, input.workspaceId, running.sessionId),
  ).toMatchObject({ id: armed.waiter.id, blockedTurnId: running.turnId });
  expect(await peekSessionWork(client.db, input.workspaceId, running.sessionId)).toMatchObject({
    kind: "capacity-wait",
    ref: { provider: "claude", waiterId: armed.waiter.id },
  });
  const reconcile = {
    ...input,
    sessionId: running.sessionId,
    waiterId: armed.waiter.id,
    generation: armed.waiter.generation,
  };
  expect(await reconcileClaudeCapacityWait(client.db, { ...reconcile, now })).toMatchObject({
    action: "waiting",
    waiter: { blockedTurnId: running.turnId },
  });
  // A model-specific allowance is independent: Sonnet availability cannot
  // release an Opus turn. Only the accepted model's reset does so.
  expect(
    (
      await selectClaudeCredentialForUse(client.db, {
        ...input,
        shardKey: running.sessionId,
        upstreamModelId: "claude-sonnet-fixture",
        now,
      })
    ).credentialId,
  ).not.toBeNull();
  const resumed = await reconcileClaudeCapacityWait(client.db, {
    ...reconcile,
    now: new Date(now.getTime() + 3600_001),
  });
  expect(resumed).toMatchObject({
    action: "resumed",
    waiter: { blockedTurnId: running.turnId, status: "resumed" },
  });
  const [stored] = await shared.admin<
    { turn_id: string; turn_status: string; attempt_id: string | null; generation: number }[]
  >`select session.active_turn_id as turn_id,work.status as turn_status,work.active_attempt_id as attempt_id,work.execution_generation as generation from sessions session join session_turns work on work.id=session.active_turn_id where session.id=${running.sessionId}`;
  expect(stored).toEqual({
    turn_id: running.turnId,
    turn_status: "recovering",
    attempt_id: null,
    generation: 1,
  });
  expect(
    await getClaudeCapacityWaitForSession(client.db, input.workspaceId, running.sessionId),
  ).toBeNull();
});

test("Claude waiter keeps a manual pin binding and resumes after the explicit pin change", async () => {
  const { setClaudeSessionAccountPin } = await import("../src/claude-subscription-accounts");
  const input = await fixture(),
    { a, b } = await pool(input),
    running = await turn(input),
    now = new Date();
  await rejectOpus(input, a.account.id, a.account.version, now);
  const pin = await setClaudeSessionAccountPin(client.db, {
    ...input,
    sessionId: running.sessionId,
    credentialId: a.account.id,
    pinSource: "manual",
    expectedVersion: null,
  });
  const armed = await armClaudeCapacityWait(client.db, {
    ...input,
    ...running,
    earliestResetAt: new Date(now.getTime() + 3600_000),
    failurePayload: { code: "claude_capacity_unavailable" },
    now,
  });
  if (armed.action !== "waiting") throw Error("Expected capacity waiter");
  const reconcile = {
    ...input,
    sessionId: running.sessionId,
    waiterId: armed.waiter.id,
    generation: armed.waiter.generation,
    now,
  };
  expect(await reconcileClaudeCapacityWait(client.db, reconcile)).toMatchObject({
    action: "waiting",
  });
  await setClaudeSessionAccountPin(client.db, {
    ...input,
    sessionId: running.sessionId,
    credentialId: b.account.id,
    pinSource: "manual",
    expectedVersion: pin.version,
  });
  expect(await reconcileClaudeCapacityWait(client.db, reconcile)).toMatchObject({
    action: "resumed",
  });
});

test.each(["pool", "credential", "without quarantine"])(
  "capacity settlement rejects a lease expiring during %s contention",
  async (contention) => {
    const input = await fixture(),
      { a } = await pool(input),
      running = await turn(input);
    const holderId = "fixture-holder-" + randomUUID();
    const lease = await acquireClaudeCredentialLease(client.db, {
      ...input,
      ...running,
      holderId,
      upstreamModelId: "claude-opus-fixture",
      pinnedCredentialId: a.account.id,
      pinSource: "manual",
    });
    const credential = await materializeClaudeSubscriptionAccountForRun(client.db, {
      ...input,
      credentialId: a.account.id,
      encryptionKey,
    });
    let unlock!: () => void, locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holding = shared.admin.begin(async (tx) => {
      if (contention === "credential")
        await tx`select id from claude_subscription_credentials where id = ${a.account.id} for update`;
      else
        await tx`select id from claude_rotation_settings where workspace_id = ${input.workspaceId} for update`;
      locked();
      await release;
    });
    await ready;
    try {
      await shared.admin`update claude_credential_leases set leased_until = clock_timestamp() + interval '300 milliseconds' where turn_id = ${running.turnId}`;
      const pending = armClaudeCapacityWait(client.db, {
        ...input,
        ...running,
        earliestResetAt: null,
        now: new Date(),
        failurePayload: { code: "claude_relogin_required" },
        leaseFence: { holderId, generation: lease.generation! },
        expectedCredentialVersion: credential.version,
        ...(contention === "without quarantine"
          ? {}
          : {
              credentialTokenFence: { encryptionKey, observedAccessToken: credential.secret.token },
              credentialQuarantine: {
                kind: "status" as const,
                status: "needs_relogin" as const,
                lastError: "Synthetic refusal",
              },
            }),
      });
      await Bun.sleep(700);
      unlock();
      await holding;
      expect(await pending).toMatchObject({ action: "stale" });
      expect(
        await getClaudeCapacityWaitForSession(client.db, input.workspaceId, running.sessionId),
      ).toBeNull();
      expect(
        (await listClaudeSubscriptionAccountsMetadata(client.db, input)).find(
          (value) => value.id === a.account.id,
        )?.status,
      ).toBe("active");
      const [attempt] =
        await shared.admin`select state from session_turn_attempts where id = ${running.attemptId}`;
      expect(attempt!.state).toBe("running");
    } finally {
      unlock();
      await holding;
    }
  },
);

test("pool lock contention does not consume lease TTL and expired holders advance generation", async () => {
  const input = await fixture(),
    { a } = await pool(input),
    accepted = await turn(input);
  const request = {
    ...input,
    ...accepted,
    holderId: "fixture-retained-holder",
    upstreamModelId: "claude-opus-fixture",
    pinnedCredentialId: a.account.id,
    pinSource: "policy" as const,
    leaseTtlMs: 5000,
  };
  const first = await acquireClaudeCredentialLease(client.db, request);
  let unlock!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const holding = shared.admin.begin(async (tx) => {
    await tx`SELECT id FROM claude_rotation_settings WHERE workspace_id = ${input.workspaceId} FOR UPDATE`;
    locked();
    await release;
    await tx`UPDATE claude_credential_leases SET leased_until = clock_timestamp() - interval '1 second' WHERE turn_id = ${accepted.turnId}`;
  });
  await ready;
  const acquiring = acquireClaudeCredentialLease(client.db, request);
  // Deliberately hold the pool while acquisition is queued; TTL starts at admission.
  await Bun.sleep(150);
  const releasedAt = Date.now();
  unlock();
  await holding;
  const next = await acquiring;
  expect(next.reused).toBe(false);
  expect(next.generation).toBe(first.generation! + 1);
  expect(next.leasedUntil!.getTime()).toBeGreaterThanOrEqual(releasedAt + request.leaseTtlMs - 30);
  await releaseClaudeCredentialLease(client.db, { ...request, generation: first.generation! });
  const stillHeld = await acquireClaudeCredentialLease(client.db, request);
  expect(stillHeld.reused).toBe(true);
  expect(stillHeld.generation).toBe(next.generation);
});

test("cleanup skips another turn's locked expired lease instead of blocking a live holder", async () => {
  const input = await fixture(),
    { a } = await pool(input);
  const accepted = await turn(input),
    other = await turn(input);
  const request = {
    ...input,
    ...accepted,
    holderId: "fixture-live-holder",
    upstreamModelId: "claude-opus-fixture",
    pinnedCredentialId: a.account.id,
    pinSource: "policy" as const,
    leaseTtlMs: 5000,
  };
  const lease = await acquireClaudeCredentialLease(client.db, request);
  await acquireClaudeCredentialLease(client.db, {
    ...request,
    ...other,
    holderId: "fixture-expired-holder",
  });
  await shared.admin`UPDATE claude_credential_leases SET leased_until = clock_timestamp() - interval '1 second' WHERE turn_id = ${other.turnId}`;
  let locked!: () => void, unlock!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const holding = shared.admin.begin(async (tx) => {
    await tx`SELECT id FROM claude_credential_leases WHERE turn_id = ${other.turnId} FOR UPDATE`;
    locked();
    await release;
  });
  await ready;
  try {
    const outcome = await Promise.race([
      acquireClaudeCredentialLease(client.db, request),
      Bun.sleep(1000).then(() => {
        throw new Error("Unrelated lease blocked acquisition");
      }),
    ]);
    expect(outcome.reused).toBe(true);
    expect(outcome.generation).toBe(lease.generation);
    expect(outcome.leasedUntil!.getTime()).toBeGreaterThan(Date.now());
  } finally {
    unlock();
    await holding;
  }
});

test("expiry during a quota read advances the holder generation at the lease update", async () => {
  const input = await fixture(),
    { a } = await pool(input),
    accepted = await turn(input);
  const request = {
    ...input,
    ...accepted,
    holderId: "fixture-delayed-read-holder",
    upstreamModelId: "claude-opus-fixture",
    pinnedCredentialId: a.account.id,
    pinSource: "policy" as const,
    leaseTtlMs: 1500,
  };
  const first = await acquireClaudeCredentialLease(client.db, request);
  let locked!: () => void, unlock!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const holding = shared.admin.begin(async (tx) => {
    await tx`LOCK TABLE claude_subscription_account_usage IN ACCESS EXCLUSIVE MODE`;
    locked();
    await release;
  });
  await ready;
  const acquiring = acquireClaudeCredentialLease(client.db, request);
  try {
    let blocked = false;
    for (let retry = 0; retry < 100; retry++) {
      const [row] =
        await shared.admin`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%claude_subscription_account_usage%') AS blocked`;
      if (row!.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    await Bun.sleep(Math.max(0, first.leasedUntil!.getTime() - Date.now()) + 30);
  } finally {
    unlock();
    await holding;
  }
  const next = await acquiring;
  expect(next.generation).toBe(first.generation! + 1);
  expect(next.leasedUntil!.getTime()).toBeGreaterThan(Date.now());
  await releaseClaudeCredentialLease(client.db, { ...request, generation: first.generation! });
  const retained = await acquireClaudeCredentialLease(client.db, request);
  expect(retained.generation).toBe(next.generation);
});
