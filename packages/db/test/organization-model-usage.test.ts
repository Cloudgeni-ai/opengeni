import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationModelUsage,
  getOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";

setDefaultTimeout(180_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) return await acquireSharedTestDatabase("organization-model-usage");
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 2 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("0520 is additive and reuses the audited fact capability instead of widening a policy", async () => {
  const candidate = await Bun.file(
    new URL("../drizzle/0520_organization_model_usage.sql", import.meta.url),
  ).text();
  expect(candidate).toStartWith("-- deployment-mode: rolling");
  expect(candidate.match(/CREATE FUNCTION/g)).toHaveLength(1);
  expect(candidate).not.toContain("POLICY");
  expect(candidate).not.toContain("ALTER TABLE");
  expect(candidate).not.toContain("CREATE OR REPLACE");
  expect(candidate).toContain("'model_call_facts',");
  expect(candidate).toContain("list_organization_workspace_ids");
});

test("organization model usage splits billing paths and aggregates Personal workspaces without naming them", async () => {
  if (!shared || !client) throw new Error("PostgreSQL test database unavailable");
  const userId = `org-model-usage-${crypto.randomUUID()}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Organization model usage owner",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await shared.admin<Array<{ personal_workspace_id: string }>>`
    select personal_workspace_id from organization_memberships
    where account_id = ${accountId} and subject_id = ${ownerSubjectId}`;
  const personalWorkspaceId = membership!.personal_workspace_id;
  const sharedWorkspaceId = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId && candidate.workspaceId !== personalWorkspaceId,
  )!.workspaceId!;
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test') on conflict (account_id) do nothing`;
  const privateSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: ownerSubjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: ownerSubjectId,
    enabled: true,
    expectedVersion: privateSettings.version,
    operationId: crypto.randomUUID(),
  });
  const session = (workspaceId: string) =>
    withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
      createSession(client!.db, {
        accountId,
        workspaceId,
        initialMessage: "organization model usage",
        resources: [],
        metadata: {},
        model: "fixture-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: ownerSubjectId },
        createdByContext: {},
      }),
    );
  const sharedSession = await session(sharedWorkspaceId);
  const privateSession = await session(sharedWorkspaceId);
  const personalSession = await session(personalWorkspaceId);
  await transitionSessionVisibility(client.db, {
    workspaceId: sharedWorkspaceId,
    sessionId: privateSession.id,
    actorSubjectId: ownerSubjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  const occurredAt = "2026-09-14T03:00:00.000Z";
  const fact = (
    workspaceId: string,
    sessionId: string,
    billingPath: string,
    priced: number,
    estimated: number | null,
    tokens: number,
  ) => shared!.admin`
    insert into model_call_facts (
      account_id, workspace_id, session_id, turn_id, source_key, provider, provider_api, model,
      billing_path, input_tokens, output_tokens, cached_tokens, total_tokens,
      priced_cost_micros, estimated_provider_cost_micros, pricing_source, occurred_at
    ) values (
      ${accountId}, ${workspaceId}, ${sessionId}, gen_random_uuid(), ${crypto.randomUUID()},
      'openai', 'responses', ${billingPath === "external" ? "gpt-external" : "gpt-credits"},
      ${billingPath}, ${tokens - 10}, 10, ${Math.floor((tokens - 10) / 2)}, ${tokens},
      ${priced}, ${estimated}, ${estimated === null ? null : "configured_list_price"}, ${occurredAt}
    )`;
  await fact(sharedWorkspaceId, sharedSession.id, "opengeni_credits", 100, 80, 110);
  await fact(sharedWorkspaceId, sharedSession.id, "external", 0, 50, 210);
  await fact(sharedWorkspaceId, privateSession.id, "opengeni_credits", 300, null, 310);
  await fact(personalWorkspaceId, personalSession.id, "opengeni_credits", 200, 150, 410);

  const now = new Date("2026-09-14T12:00:00.000Z");
  const read = (subjectId: string) =>
    withSessionRlsActorContext({ subjectId }, () =>
      getOrganizationModelUsage(client!.db, { accountId, period: "today" }, now),
    );
  const credits = (rows: Array<{ billingPath: string; calls: string; creditMicros: string }>) =>
    rows.find((row) => row.billingPath === "opengeni_credits");

  const owner = await read(ownerSubjectId);
  expect(credits(owner.billing)).toMatchObject({
    calls: "3",
    creditMicros: "600",
    estimatedProviderMicros: "230",
    estimatedProviderKnownCalls: "2",
    totalTokens: "830",
  });
  expect(owner.billing.find((row) => row.billingPath === "external")).toMatchObject({
    calls: "1",
    creditMicros: "0",
    estimatedProviderMicros: "50",
  });
  expect(owner.workspaces.map((row) => row.workspaceId)).toEqual([sharedWorkspaceId]);
  expect(credits(owner.workspaces[0]!.billing)).toMatchObject({ calls: "2", creditMicros: "400" });
  expect(owner.personal.workspacesWithUsage).toBe("1");
  expect(credits(owner.personal.billing)).toMatchObject({ calls: "1", creditMicros: "200" });
  expect(owner.models.map((row) => `${row.model}:${row.totals.billingPath}`).sort()).toEqual([
    "gpt-credits:opengeni_credits",
    "gpt-external:external",
  ]);
  expect(owner.modelsTruncated).toBe(false);

  // An outsider loses exactly the owner-only private session, and whatever the
  // Personal workspace's own session visibility withholds.
  const [personalVisibility] = await shared.admin<Array<{ visibility: string }>>`
    select visibility from sessions where id = ${personalSession.id}`;
  const outsider = await read(`user:${crypto.randomUUID()}`);
  const personalVisible = personalVisibility?.visibility === "workspace_shared";
  expect(credits(outsider.billing)).toMatchObject({
    calls: personalVisible ? "2" : "1",
    creditMicros: personalVisible ? "300" : "100",
  });
  expect(credits(outsider.workspaces[0]!.billing)).toMatchObject({
    calls: "1",
    creditMicros: "100",
  });

  const [leftover] = await shared.admin<Array<{ count: string }>>`
    select count(*)::text as count from opengeni_private.insights_fact_read_runtime_capabilities`;
  expect(leftover?.count).toBe("0");
});

test("organization model usage refuses a workspace-bound context", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const app = postgres(shared.appUrl, { max: 1, prepare: false });
  try {
    const accountId = crypto.randomUUID();
    await expect(
      app.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
        await transaction`select set_config('opengeni.workspace_id', ${crypto.randomUUID()}, true)`;
        await transaction`select opengeni_private.organization_model_usage_summary(
          ${accountId}::uuid, now() - interval '1 day', now(), null)`;
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|55000)$/) });
  } finally {
    await app.end();
  }
});
