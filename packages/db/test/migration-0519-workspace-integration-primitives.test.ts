import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  claimWorkspaceWebhookDeliveries,
  createDb,
  createSession,
  createWorkspaceWebhook,
  deleteWorkspaceWebhook,
  getWorkspaceCredentialProvider,
  listWorkspaceWebhookDeliveries,
  migrate,
  provisionRoles,
  pruneWorkspaceWebhookDeliveries,
  redeliverWorkspaceWebhookDelivery,
  settleWorkspaceWebhookDelivery,
  updateWorkspaceWebhook,
  upsertWorkspaceCredentialProvider,
  WORKSPACE_WEBHOOK_LIMIT,
  WorkspaceWebhookLimitError,
} from "../src/index";

const MIGRATION = "0519_workspace_integration_primitives.sql";

setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0515");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  app = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function workspaceWithSession(label: string) {
  const subjectId = `subject:${label}:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "migration-0515",
    accountExternalId: `account:${label}:${crypto.randomUUID()}`,
    accountName: `Integration ${label}`,
    workspaceExternalSource: "migration-0515",
    workspaceExternalId: `workspace:${label}:${crypto.randomUUID()}`,
    workspaceName: `Integration ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(app.db, {
    ...scope,
    initialMessage: `initial ${label}`,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId, label: `User ${label}` },
    createdByContext: { label: `User ${label}` },
  });
  return { scope, session, subjectId };
}

describe("0519 workspace integration primitives", () => {
  test("is a rolling, additive migration", async () => {
    const source = await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    expect(source).not.toMatch(/\bALTER TABLE\s+"?session_events"?/i);
  });

  test("routines are owner-run, fixed-path, and not PUBLIC-executable", async () => {
    const rows = await shared!.admin<
      Array<{
        name: string;
        securityDefiner: boolean;
        config: string[] | null;
        publicExecute: boolean;
      }>
    >`
      select procedure.proname as name,
        procedure.prosecdef as "securityDefiner",
        procedure.proconfig as config,
        exists (
          select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname in (
          'enqueue_workspace_webhook_deliveries_v1',
          'claim_workspace_webhook_deliveries_v1',
          'settle_workspace_webhook_delivery_v1',
          'prune_workspace_webhook_deliveries_v1'
        )
      order by procedure.proname`;
    expect(rows.map((row) => [row.name, row.securityDefiner, row.publicExecute])).toEqual([
      ["claim_workspace_webhook_deliveries_v1", true, false],
      ["enqueue_workspace_webhook_deliveries_v1", false, false],
      ["prune_workspace_webhook_deliveries_v1", true, false],
      ["settle_workspace_webhook_delivery_v1", true, false],
    ]);
    for (const row of rows) {
      expect(row.config?.some((entry) => entry.startsWith("search_path="))).toBe(true);
    }
  });

  test("credential provider is one row per workspace and keeps its secret on partial update", async () => {
    const { scope } = await workspaceWithSession("provider");
    await expect(
      upsertWorkspaceCredentialProvider(app.db, {
        ...scope,
        url: "https://host.example/credentials",
        enabled: true,
        timeoutMs: 5000,
        createdBySubjectId: null,
      }),
    ).rejects.toThrow("signing secret is required");
    const created = await upsertWorkspaceCredentialProvider(app.db, {
      ...scope,
      url: "https://host.example/credentials",
      secretEncrypted: "sealed-1",
      enabled: true,
      timeoutMs: 5000,
      createdBySubjectId: "subject:admin",
    });
    const updated = await upsertWorkspaceCredentialProvider(app.db, {
      ...scope,
      url: "https://host.example/v2/credentials",
      enabled: false,
      timeoutMs: 8000,
      createdBySubjectId: null,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.secretEncrypted).toBe("sealed-1");
    expect(updated.enabled).toBe(false);
    const other = await workspaceWithSession("provider-other");
    expect(await getWorkspaceCredentialProvider(app.db, other.scope)).toBeNull();
    await expect(
      (async () =>
        await shared!.admin`insert into workspace_credential_providers
          (account_id, workspace_id, url, secret_encrypted, timeout_ms)
          values (${other.scope.accountId}, ${other.scope.workspaceId}, 'ftp://nope', 'x', 5000)`)(),
    ).rejects.toThrow("workspace_credential_providers_url_chk");
  });

  test("terminal events enqueue thin deliveries in the writer's transaction", async () => {
    const { scope, session } = await workspaceWithSession("enqueue");
    const all = await createWorkspaceWebhook(app.db, {
      ...scope,
      url: "https://receiver.example/all",
      secretEncrypted: "sealed",
      eventTypes: ["session.status.changed", "turn.failed"],
      enabled: true,
      description: null,
      createdBySubjectId: null,
    });
    const disabled = await createWorkspaceWebhook(app.db, {
      ...scope,
      url: "https://receiver.example/disabled",
      secretEncrypted: "sealed",
      eventTypes: ["session.status.changed"],
      enabled: false,
      description: null,
      createdBySubjectId: null,
    });
    const other = await workspaceWithSession("enqueue-other");
    const foreign = await createWorkspaceWebhook(app.db, {
      ...other.scope,
      url: "https://receiver.example/foreign",
      secretEncrypted: "sealed",
      eventTypes: ["session.status.changed"],
      enabled: true,
      description: null,
      createdBySubjectId: null,
    });

    const [statusEvent, ignored] = await appendSessionEvents(
      app.db,
      scope.workspaceId,
      session.id,
      [
        {
          type: "session.status.changed",
          payload: {
            status: "idle",
            reason: "turn_completed",
            secret: "never-copied",
          },
        },
        {
          type: "agent.message.completed",
          payload: { text: "not a webhook type" },
        },
      ],
    );
    expect(ignored).toBeDefined();

    const deliveries = await listWorkspaceWebhookDeliveries(app.db, {
      ...scope,
      webhookId: all.id,
    });
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect(delivery.eventId).toBe(statusEvent!.id);
    expect(delivery.eventType).toBe("session.status.changed");
    expect(delivery.payload).toMatchObject({
      id: statusEvent!.id,
      type: "session.status.changed",
      workspaceId: scope.workspaceId,
      sessionId: session.id,
      turnId: null,
      data: { status: "idle", reason: "turn_completed" },
    });
    expect(JSON.stringify(delivery.payload)).not.toContain("never-copied");
    expect(
      await listWorkspaceWebhookDeliveries(app.db, {
        ...scope,
        webhookId: disabled.id,
      }),
    ).toEqual([]);
    expect(
      await listWorkspaceWebhookDeliveries(app.db, {
        ...other.scope,
        webhookId: foreign.id,
      }),
    ).toEqual([]);
    // RLS: a workspace cannot read another workspace's deliveries by id.
    expect(
      await listWorkspaceWebhookDeliveries(app.db, {
        ...other.scope,
        webhookId: all.id,
      }),
    ).toEqual([]);
  });

  test("claim, backoff, terminal failure, redelivery, and prune", async () => {
    const { scope, session } = await workspaceWithSession("dispatch");
    const webhook = await createWorkspaceWebhook(app.db, {
      ...scope,
      url: "https://receiver.example/dispatch",
      secretEncrypted: "sealed-dispatch",
      eventTypes: ["session.status.changed"],
      enabled: true,
      description: "dispatch",
      createdBySubjectId: null,
    });
    await appendSessionEvents(app.db, scope.workspaceId, session.id, [
      { type: "session.status.changed", payload: { status: "failed" } },
    ]);
    const claimId = crypto.randomUUID();
    const claimed = (await claimWorkspaceWebhookDeliveries(app.db, { claimId, limit: 100 })).filter(
      (row) => row.webhookId === webhook.id,
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      workspaceId: scope.workspaceId,
      url: "https://receiver.example/dispatch",
      secretEncrypted: "sealed-dispatch",
      attempts: 1,
    });
    // A claimed row is invisible to a competing claim.
    const competing = await claimWorkspaceWebhookDeliveries(app.db, {
      claimId: crypto.randomUUID(),
      limit: 100,
    });
    expect(competing.some((row) => row.webhookId === webhook.id)).toBe(false);
    // Only the exact claim holder settles.
    expect(
      await settleWorkspaceWebhookDelivery(app.db, {
        deliveryId: claimed[0]!.deliveryId,
        claimId: crypto.randomUUID(),
        status: 200,
        error: null,
      }),
    ).toBe(false);
    expect(
      await settleWorkspaceWebhookDelivery(app.db, {
        deliveryId: claimed[0]!.deliveryId,
        claimId,
        status: 500,
        error: "HTTP 500",
        maxAttempts: 2,
      }),
    ).toBe(true);
    let [row] = await listWorkspaceWebhookDeliveries(app.db, {
      ...scope,
      webhookId: webhook.id,
    });
    expect(row!.failedAt).toBeNull();
    expect(row!.lastStatus).toBe(500);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await shared!.admin`update workspace_webhook_deliveries set next_attempt_at = now()
      where id = ${row!.id}`;
    const secondClaim = crypto.randomUUID();
    const retried = (await claimWorkspaceWebhookDeliveries(app.db, { claimId: secondClaim })).find(
      (candidate) => candidate.deliveryId === row!.id,
    );
    expect(retried?.attempts).toBe(2);
    expect(
      await settleWorkspaceWebhookDelivery(app.db, {
        deliveryId: row!.id,
        claimId: secondClaim,
        status: null,
        error: "connection refused",
        maxAttempts: 2,
      }),
    ).toBe(true);
    [row] = await listWorkspaceWebhookDeliveries(app.db, {
      ...scope,
      webhookId: webhook.id,
    });
    expect(row!.failedAt).not.toBeNull();
    expect(row!.lastError).toBe("connection refused");

    const requeued = await redeliverWorkspaceWebhookDelivery(app.db, {
      ...scope,
      webhookId: webhook.id,
      deliveryId: row!.id,
    });
    expect(requeued).toMatchObject({
      attempts: 0,
      failedAt: null,
      deliveredAt: null,
    });
    const thirdClaim = crypto.randomUUID();
    const again = (await claimWorkspaceWebhookDeliveries(app.db, { claimId: thirdClaim })).find(
      (candidate) => candidate.deliveryId === row!.id,
    );
    expect(again).toBeDefined();
    expect(
      await settleWorkspaceWebhookDelivery(app.db, {
        deliveryId: row!.id,
        claimId: thirdClaim,
        status: 204,
        error: null,
      }),
    ).toBe(true);
    [row] = await listWorkspaceWebhookDeliveries(app.db, {
      ...scope,
      webhookId: webhook.id,
    });
    expect(row!.deliveredAt).not.toBeNull();

    await shared!.admin`update workspace_webhook_deliveries
      set created_at = now() - interval '30 days' where id = ${row!.id}`;
    expect(
      await pruneWorkspaceWebhookDeliveries(app.db, {
        retentionSeconds: 86_400,
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await listWorkspaceWebhookDeliveries(app.db, {
        ...scope,
        webhookId: webhook.id,
      }),
    ).toEqual([]);
  });

  test("disabled endpoints are not claimed and deleting a webhook drops its queue", async () => {
    const { scope, session } = await workspaceWithSession("disable");
    const webhook = await createWorkspaceWebhook(app.db, {
      ...scope,
      url: "https://receiver.example/disable",
      secretEncrypted: "sealed",
      eventTypes: ["session.status.changed"],
      enabled: true,
      description: null,
      createdBySubjectId: null,
    });
    await appendSessionEvents(app.db, scope.workspaceId, session.id, [
      { type: "session.status.changed", payload: { status: "idle" } },
    ]);
    await updateWorkspaceWebhook(app.db, {
      ...scope,
      webhookId: webhook.id,
      enabled: false,
    });
    const claimed = await claimWorkspaceWebhookDeliveries(app.db, {
      claimId: crypto.randomUUID(),
      limit: 100,
    });
    expect(claimed.some((row) => row.webhookId === webhook.id)).toBe(false);
    expect(await deleteWorkspaceWebhook(app.db, { ...scope, webhookId: webhook.id })).toBe(true);
    const [count] = await shared!.admin<Array<{ count: number }>>`
      select count(*)::integer as count from workspace_webhook_deliveries where webhook_id = ${webhook.id}`;
    expect(count!.count).toBe(0);
  });

  test("a workspace is limited to a bounded number of webhooks", async () => {
    const { scope } = await workspaceWithSession("limit");
    for (let index = 0; index < WORKSPACE_WEBHOOK_LIMIT; index += 1) {
      await createWorkspaceWebhook(app.db, {
        ...scope,
        url: `https://receiver.example/${index}`,
        secretEncrypted: "sealed",
        eventTypes: ["turn.completed"],
        enabled: true,
        description: null,
        createdBySubjectId: null,
      });
    }
    await expect(
      createWorkspaceWebhook(app.db, {
        ...scope,
        url: "https://receiver.example/over",
        secretEncrypted: "sealed",
        eventTypes: ["turn.completed"],
        enabled: true,
        description: null,
        createdBySubjectId: null,
      }),
    ).rejects.toBeInstanceOf(WorkspaceWebhookLimitError);
  });
});

test("the dispatcher sees every workspace when migrations run as a non-superuser owner", async () => {
  const owner = await acquireOwnerMigratedTestDatabase("migration-0515-owner");
  if (!owner) throw new Error("PostgreSQL test database unavailable");
  const ownerSql = postgres(owner.ownerUrl, { max: 1 });
  try {
    await migrate(owner.ownerUrl);
    await provisionRoles(owner.adminUrl, {
      appRole: "opengeni_app",
      appPassword: owner.appPassword,
      rlsStrategy: "force",
    });
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const webhookId = crypto.randomUUID();
    await owner.admin`insert into managed_accounts (id, name) values (${accountId}, 'owner test')`;
    await owner.admin`insert into workspaces (id, account_id, name) values (${workspaceId}, ${accountId}, 'owner test')`;
    await owner.admin`insert into workspace_webhooks (id, account_id, workspace_id, url, secret_encrypted, event_types)
      values (${webhookId}, ${accountId}, ${workspaceId}, 'https://receiver.example/owner', 'sealed', array['turn.completed'])`;
    await owner.admin`insert into workspace_webhook_deliveries (account_id, workspace_id, webhook_id, event_id, event_type, payload)
      values (${accountId}, ${workspaceId}, ${webhookId}, ${crypto.randomUUID()}, 'turn.completed', '{}'::jsonb)`;
    // The owner is not a superuser: an unscoped direct read is policy-bound.
    const [direct] = await ownerSql<Array<{ count: number }>>`
      select count(*)::integer as count from workspace_credential_providers`;
    expect(direct!.count).toBe(0);
    const appUrl = owner.adminUrl.replace(
      /^postgres:\/\/postgres:[^@]+@/,
      `postgres://opengeni_app:${owner.appPassword}@`,
    );
    const ownerApp = postgres(appUrl, { max: 1 });
    try {
      const [unscoped] = await ownerApp<Array<{ count: number }>>`
        select count(*)::integer as count from workspace_webhook_deliveries`;
      expect(unscoped!.count).toBe(0);
      const claimed = await ownerApp<Array<{ workspace_id: string; url: string }>>`
        select workspace_id, url from opengeni_private.claim_workspace_webhook_deliveries_v1(
          ${crypto.randomUUID()}::uuid, 10, 30)`;
      expect([...claimed]).toEqual([
        { workspace_id: workspaceId, url: "https://receiver.example/owner" },
      ]);
    } finally {
      await ownerApp.end();
    }
  } finally {
    await ownerSql.end();
    await owner.release();
  }
}, 240_000);
