import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  claimOrganizationWebhookDeliveries,
  createDb,
  createSession,
  createWorkspaceWebhook,
  createOrganizationWebhook,
  deleteOrganizationWebhook,
  enqueueSessionTurn,
  migrate,
  nestedPostgresSqlState,
  provisionRoles,
  assertRuntimeDatabasePosture,
  getOrganizationCredentialProvider,
  listOrganizationWebhookDeliveries,
  listWorkspaceWebhookDeliveries,
  redeliverOrganizationWebhookDelivery,
  resolveInitiatingHuman,
  resolveWorkspaceCredentialProvider,
  settleOrganizationWebhookDelivery,
  updateOrganizationWebhook,
  upsertOrganizationCredentialProvider,
  upsertWorkspaceCredentialProvider,
  withAccountRls,
  withRlsContext,
  type DbClient,
} from "../src";
import { ensureExternalIdentity } from "../src/external-identities";

setDefaultTimeout(60_000);

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

let shared: SharedTestDatabase | null;
let client: DbClient;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0542");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(label: string) {
  const source = "org-integration-test";
  const externalId = crypto.randomUUID();
  const subjectId = `subject:${label}:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: source,
    accountExternalId: crypto.randomUUID(),
    accountName: label,
    workspaceExternalSource: source,
    workspaceExternalId: externalId,
    workspaceName: label,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: label,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
  });
  return { scope, session, subjectId, source, externalId };
}
test("0542 is additive rolling storage without external-identity runtime grants", async () => {
  const source = await Bun.file(
    new URL("../drizzle/0542_organization_integration_primitives.sql", import.meta.url),
  ).text();
  expect(source).toStartWith("-- deployment-mode: rolling");
  expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
  expect(source).not.toMatch(/GRANT\s+SELECT[^;]*\bexternal_identities\b/i);
  expect(source).toContain("DO $integration_search_paths$");
  expect(source).toContain("SET search_path = pg_catalog, %I, pg_temp");
  for (const table of [
    "organization_credential_providers",
    "organization_webhooks",
    "organization_webhook_deliveries",
  ]) {
    expect(source).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
});

test("0542 owner migration and custom runtime preserve FORCE-RLS dispatcher posture", async () => {
  const owner = await acquireOwnerMigratedTestDatabase("migration-0542-owner");
  if (!owner) throw new Error("PostgreSQL test database unavailable");
  const ownerSql = postgres(owner.ownerUrl, { max: 1 });
  let runtime: DbClient | undefined;
  try {
    await migrate(owner.ownerUrl);
    const appRole = "organization_integration_custom_app";
    await provisionRoles(owner.adminUrl, {
      appRole,
      appPassword: owner.appPassword,
      rlsStrategy: "force",
    });
    const runtimeUrl = new URL(owner.adminUrl);
    runtimeUrl.username = appRole;
    runtimeUrl.password = owner.appPassword;
    runtime = createDb(runtimeUrl.toString());
    const [ownerPosture] = await ownerSql<Array<{ superuser: boolean; bypass: boolean }>>`
      select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = current_user`;
    expect(ownerPosture).toEqual({ superuser: false, bypass: false });
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const webhookId = crypto.randomUUID();
    await owner.admin`insert into managed_accounts(id, name) values (${accountId}, 'owner integration')`;
    await owner.admin`insert into workspaces(id, account_id, name) values (${workspaceId}, ${accountId}, 'owner integration')`;
    await owner.admin`insert into organization_webhooks(id, account_id, url, secret_encrypted, event_types)
      values (${webhookId}, ${accountId}, 'https://receiver.example', 'sealed', array['turn.completed'])`;
    await owner.admin`insert into organization_credential_providers(account_id, url, secret_encrypted)
      values (${accountId}, 'https://provider.example', 'provider-sealed')`;
    await owner.admin`insert into organization_webhook_deliveries(account_id, workspace_id, webhook_id, event_id, event_type, payload)
      values (${accountId}, ${workspaceId}, ${webhookId}, ${crypto.randomUUID()}, 'turn.completed', '{}'::jsonb)`;
    const [direct] = await ownerSql<Array<{ count: number }>>`
      select count(*)::integer as count from organization_credential_providers`;
    expect(direct!.count).toBe(0);
    expect(
      (await resolveWorkspaceCredentialProvider(runtime.db, { accountId, workspaceId }))
        ?.secretEncrypted,
    ).toBe("provider-sealed");
    expect(
      await runtime.db.execute(sql`select * from organization_webhook_deliveries`),
    ).toHaveLength(0);
    const claims = await claimOrganizationWebhookDeliveries(runtime.db, {
      claimId: crypto.randomUUID(),
    });
    expect(claims.map((row) => row.workspaceId)).toEqual([workspaceId]);
    await assertRuntimeDatabasePosture(runtime.db, { rlsStrategy: "force", expectedRole: appRole });
  } finally {
    await runtime?.close();
    await ownerSql.end();
    await owner.release();
  }
}, 240_000);
describe("0542 organization integration primitives (PostgreSQL)", () => {
  test("provider precedence is workspace enabled, then enabled matching organization", async () => {
    const { scope } = await fixture("provider");
    const input = {
      accountId: scope.accountId,
      url: "https://product.example/credentials",
      enabled: true,
      timeoutMs: 5000,
      secretEncrypted: "org-secret",
      workspaceFilter: { externalSource: "org-integration-test" },
      createdBySubjectId: null,
    };
    const organization = await upsertOrganizationCredentialProvider(client.db, input);
    expect((await resolveWorkspaceCredentialProvider(client.db, scope))?.id).toBe(organization.id);
    const workspace = await upsertWorkspaceCredentialProvider(client.db, {
      ...scope,
      url: "https://workspace.example/credentials",
      enabled: true,
      timeoutMs: 5000,
      secretEncrypted: "workspace-secret",
      createdBySubjectId: null,
    });
    expect((await resolveWorkspaceCredentialProvider(client.db, scope))?.id).toBe(workspace.id);
    await upsertWorkspaceCredentialProvider(client.db, {
      ...scope,
      url: workspace.url,
      enabled: false,
      timeoutMs: 5000,
      createdBySubjectId: null,
    });
    expect((await resolveWorkspaceCredentialProvider(client.db, scope))?.id).toBe(organization.id);
    await upsertOrganizationCredentialProvider(client.db, {
      ...input,
      workspaceFilter: { externalSource: "other" },
    });
    expect(await resolveWorkspaceCredentialProvider(client.db, scope)).toBeNull();
    const other = await fixture("other");
    expect(await getOrganizationCredentialProvider(client.db, other.scope)).toBeNull();
    expect(
      await resolveWorkspaceCredentialProvider(client.db, {
        ...scope,
        accountId: other.scope.accountId,
      }),
    ).toBeNull();
  });

  test("organization filtering does not affect workspace registrations; attribution is account-fenced", async () => {
    const { scope, session, source, externalId } = await fixture("events");
    const identity = await ensureExternalIdentity(client.db, {
      accountId: scope.accountId,
      source: "product",
      externalId: "alice",
    });
    expect(await resolveInitiatingHuman(client.db, scope, identity.subjectId)).toEqual({
      subjectId: identity.subjectId,
      externalIdentity: { source: "product", externalId: "alice" },
    });
    const other = await fixture("other-human");
    expect(await resolveInitiatingHuman(client.db, other.scope, identity.subjectId)).toEqual({
      subjectId: identity.subjectId,
      externalIdentity: null,
    });
    expect(await resolveInitiatingHuman(client.db, scope, null)).toBeNull();
    const org = await createOrganizationWebhook(client.db, {
      accountId: scope.accountId,
      url: "https://receiver.example/org",
      secretEncrypted: "sealed",
      enabled: true,
      eventTypes: ["turn.completed"],
      description: null,
      workspaceFilter: { externalSource: source },
      createdBySubjectId: null,
    });
    const filtered = await createOrganizationWebhook(client.db, {
      accountId: scope.accountId,
      url: "https://receiver.example/filtered",
      secretEncrypted: "sealed",
      enabled: true,
      eventTypes: ["turn.completed"],
      description: null,
      workspaceFilter: { externalSource: "other" },
      createdBySubjectId: null,
    });
    const workspace = await createWorkspaceWebhook(client.db, {
      ...scope,
      url: "https://receiver.example/workspace",
      secretEncrypted: "sealed",
      enabled: true,
      eventTypes: ["turn.completed"],
      description: null,
      createdBySubjectId: null,
    });
    const [trigger] = await appendSessionEvents(client.db, scope.workspaceId, session.id, [
      { type: "user.message", payload: { text: "test" } },
    ]);
    const turn = await enqueueSessionTurn(client.db, {
      ...scope,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "test",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: identity.subjectId },
    });
    await appendSessionEvents(client.db, scope.workspaceId, session.id, [
      {
        type: "turn.completed",
        turnId: turn.id,
        payload: { status: "idle", initiatingHumanSubjectId: "spoof", secret: "never-copy" },
      },
    ]);
    const deliveries = await listOrganizationWebhookDeliveries(client.db, {
      accountId: scope.accountId,
      webhookId: org.id,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.payload).toMatchObject({
      workspace: { id: scope.workspaceId, externalSource: source, externalId },
      initiatingHuman: {
        subjectId: identity.subjectId,
        externalIdentity: { source: "product", externalId: "alice" },
      },
    });
    expect(JSON.stringify(deliveries[0]!.payload)).not.toContain("never-copy");
    expect(
      await listOrganizationWebhookDeliveries(client.db, {
        accountId: scope.accountId,
        webhookId: filtered.id,
      }),
    ).toEqual([]);
    expect(
      await listWorkspaceWebhookDeliveries(client.db, { ...scope, webhookId: workspace.id }),
    ).toHaveLength(1);
    expect(
      await listOrganizationWebhookDeliveries(client.db, {
        accountId: other.scope.accountId,
        webhookId: org.id,
      }),
    ).toEqual([]);
    // Wrong account/workspace parameters cannot widen the private identity seam.
    await expectSqlState(
      async () =>
        await withRlsContext(
          client.db,
          other.scope,
          async (tx) =>
            await tx.execute(sql`select opengeni_private.resolve_integration_initiating_human_v1(
        ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${identity.subjectId})`),
        ),
      "42501",
    );
  });

  test("claim leases, disabled queue, exact settlement, redelivery and deletion", async () => {
    const { scope, session } = await fixture("dispatch");
    const webhook = await createOrganizationWebhook(client.db, {
      accountId: scope.accountId,
      url: "https://receiver.example/dispatch",
      secretEncrypted: "sealed",
      eventTypes: ["session.status.changed"],
      enabled: true,
      description: null,
      workspaceFilter: null,
      createdBySubjectId: null,
    });
    await appendSessionEvents(client.db, scope.workspaceId, session.id, [
      { type: "session.status.changed", payload: { status: "idle" } },
    ]);
    const [delivery] = await listOrganizationWebhookDeliveries(client.db, {
      accountId: scope.accountId,
      webhookId: webhook.id,
    });
    expect(delivery).toBeDefined();
    await updateOrganizationWebhook(client.db, {
      accountId: scope.accountId,
      webhookId: webhook.id,
      enabled: false,
    });
    const claimId = crypto.randomUUID();
    expect(
      (await claimOrganizationWebhookDeliveries(client.db, { claimId, limit: 100 })).some(
        (row) => row.deliveryId === delivery!.id,
      ),
    ).toBe(false);
    await updateOrganizationWebhook(client.db, {
      accountId: scope.accountId,
      webhookId: webhook.id,
      enabled: true,
    });
    const claims = await claimOrganizationWebhookDeliveries(client.db, { claimId, limit: 100 });
    expect(claims.some((row) => row.deliveryId === delivery!.id)).toBe(true);
    expect(
      await settleOrganizationWebhookDelivery(client.db, {
        deliveryId: delivery!.id,
        claimId: crypto.randomUUID(),
        status: 200,
        error: null,
      }),
    ).toBe(false);
    expect(
      await settleOrganizationWebhookDelivery(client.db, {
        deliveryId: delivery!.id,
        claimId,
        status: 200,
        error: null,
      }),
    ).toBe(true);
    expect(
      (
        await redeliverOrganizationWebhookDelivery(client.db, {
          accountId: scope.accountId,
          webhookId: webhook.id,
          deliveryId: delivery!.id,
        })
      )?.attempts,
    ).toBe(0);
    expect(
      await deleteOrganizationWebhook(client.db, {
        accountId: scope.accountId,
        webhookId: webhook.id,
      }),
    ).toBe(true);
    expect(
      await listOrganizationWebhookDeliveries(client.db, {
        accountId: scope.accountId,
        webhookId: webhook.id,
      }),
    ).toEqual([]);
  });

  test("runtime cannot directly read external identities and unscoped tables are invisible", async () => {
    await expectSqlState(
      async () => await client.db.execute(sql`select * from external_identities`),
      "42501",
    );
    const rows = await client.db.execute(sql`select * from organization_webhooks`);
    expect(rows).toHaveLength(0);
    const { scope } = await fixture("rls");
    await upsertOrganizationCredentialProvider(client.db, {
      accountId: scope.accountId,
      url: "https://example.test/credentials",
      secretEncrypted: "secret",
      enabled: true,
      timeoutMs: 5000,
      workspaceFilter: null,
      createdBySubjectId: null,
    });
    await withRlsContext(client.db, scope, async (tx) => {
      expect(
        await tx.execute(sql`select secret_encrypted from organization_credential_providers`),
      ).toHaveLength(0);
    });
    const other = await fixture("rls-other");
    await expectSqlState(
      async () =>
        await withRlsContext(
          client.db,
          other.scope,
          async (tx) =>
            await tx.execute(sql`select * from opengeni_private.resolve_organization_credential_provider_v1(
        ${scope.accountId}::uuid, ${scope.workspaceId}::uuid
      )`),
        ),
      "42501",
    );
    await expectSqlState(
      async () =>
        await withAccountRls(
          client.db,
          scope.accountId,
          async (tx) =>
            await tx.execute(sql`insert into organization_credential_providers(account_id, url, secret_encrypted, workspace_filter)
        values (${scope.accountId}::uuid, 'https://example.test', 'sealed', '{"externalSource":null}'::jsonb)`),
        ),
      "23514",
    );
  });
});
