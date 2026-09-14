import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  signDelegatedAccessToken,
  type Permission,
  type OrganizationUsageSummary,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createDb,
  createOrganizationApiKey,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  withSessionRlsActorContext,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { registerBillingRoutes } from "../src/routes/billing";

const secret = "organization-usage-http-actor-regression";
const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const paths = ["usage-summary", "usage-workspaces"] as const;

async function token(
  subjectId: string,
  account = accountId,
  workspace = workspaceId,
  permissions: Permission[] = ["billing:read"],
) {
  return `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: account,
    workspaceId: workspace,
    subjectId,
    principalKind: "human_session",
    permissions,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}
function appFor(db: Database) {
  const app = new Hono();
  registerBillingRoutes(app, {
    db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret: secret }),
  } as ApiRouteDeps);
  return app;
}
function url(path: (typeof paths)[number], account = accountId, until = new Date().toISOString()) {
  return `http://usage.test/v1/billing/${path}?accountId=${account}&period=ytd&until=${encodeURIComponent(until)}`;
}

describe("organization usage HTTP actor binding", () => {
  test("both HTTP reads install only the verified caller in the transaction; query spoofing cannot supply an initiator", async () => {
    const dialect = new PgDialect();
    const observations: Array<{ subject: string; human: string }> = [];
    const db = {
      async transaction(fn: (tx: Database) => Promise<unknown>) {
        let account = "";
        let workspace = "";
        let subject = "";
        let human = "";
        return await fn({
          execute: async (query: SQL) => {
            const { sql, params } = dialect.sqlToQuery(query);
            if (sql.includes("set_config('opengeni.account_id'")) {
              account = String(params[0]);
              workspace = String(params[1]);
            }
            if (sql.includes("set_config('opengeni.subject_id'")) subject = String(params[0]);
            if (sql.includes("opengeni.initiating_human_subject_id")) human = String(params[1]);
            if (sql.includes("current_setting('opengeni.account_id'"))
              return [{ account_id: account, workspace_id: workspace }];
            if (sql.includes("current_setting('opengeni.subject_id'"))
              return [{ subject_id: subject }];
            if (sql.includes("opengeni_private.organization_usage_summary(")) {
              observations.push({ subject, human });
              return [
                { summary: { totals: [], buckets: [], workspaces: [], nextWorkspaceCursor: null } },
              ];
            }
            return [];
          },
        } as unknown as Database);
      },
    } as unknown as Database;
    const app = appFor(db);
    for (const path of paths) {
      for (const subject of ["user:caller-a", "user:caller-b"]) {
        const response = await app.request(
          `${url(path)}&subjectId=user:owner&initiatingHumanSubjectId=user:owner`,
          { headers: { authorization: await token(subject) } },
        );
        expect(response.status).toBe(200);
        expect(observations.at(-1)).toEqual({ subject, human: "" });
      }
    }
    expect(observations).toHaveLength(4);
  });

  test("both endpoints independently deny absent billing authority and cross-account selection before DB access", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("unauthorized billing read reached DB");
        },
      },
    ) as Database;
    const app = appFor(db);
    for (const path of paths) {
      expect(
        (
          await app.request(url(path), {
            headers: {
              authorization: await token("user:denied", accountId, workspaceId, ["workspace:read"]),
            },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(url(path, crypto.randomUUID()), {
            headers: { authorization: await token("user:reader") },
          })
        ).status,
      ).toBe(403);
    }
  });
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-usage-http-actor");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Organization usage HTTP PostgreSQL fixture unavailable");
    console.warn(
      "SKIPPED real organization usage HTTP private visibility assertions: PostgreSQL unavailable",
    );
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("actual HTTP summary and workspace pages preserve owner-private vs other billing reader totals", async () => {
  if (!shared || !client) return;
  const userId = `billing-http-${crypto.randomUUID()}`;
  const owner = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Usage HTTP owner",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test') on conflict (account_id) do nothing`;
  const settings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: owner,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: owner,
    enabled: true,
    expectedVersion: settings.version,
    operationId: crypto.randomUUID(),
  });
  const makeSession = async () =>
    await withSessionRlsActorContext({ subjectId: owner }, () =>
      createSession(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "Usage HTTP visibility",
        resources: [],
        metadata: {},
        model: "fixture-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: owner },
        createdByContext: {},
      }),
    );
  const privateSession = await makeSession();
  const sharedSession = await makeSession();
  await transitionSessionVisibility(client.db, {
    workspaceId: grant.workspaceId!,
    sessionId: privateSession.id,
    actorSubjectId: owner,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  const occurredAt = new Date();
  for (const [sessionId, quantity] of [
    [privateSession.id, 100],
    [sharedSession.id, 20],
    [null, 3],
  ] as const) {
    await shared.admin`insert into usage_events (account_id, workspace_id, session_id, event_type, quantity, unit, idempotency_key, occurred_at)
      values (${grant.accountId}, ${grant.workspaceId!}, ${sessionId}, 'model.cost', ${quantity}, 'usd_micros', ${crypto.randomUUID()}, ${occurredAt})`;
  }
  const app = appFor(client.db);
  // No ambient actor wrapper around HTTP calls: the routes must establish it.
  for (const [subject, expected] of [
    [owner, "123"],
    ["user:other-billing-reader", "23"],
  ]) {
    const authorization = await token(subject!, grant.accountId, grant.workspaceId!);
    const response = await app.request(url("usage-summary", grant.accountId), {
      headers: { authorization },
    });
    expect(response.status).toBe(200);
    const summary = (await response.json()) as OrganizationUsageSummary;
    expect(summary.totals.find((row) => row.eventType === "model.cost")?.quantity).toBe(expected);
    const pageResponse = await app.request(
      url("usage-workspaces", grant.accountId, summary.until),
      { headers: { authorization } },
    );
    expect(pageResponse.status).toBe(200);
    const page = (await pageResponse.json()) as OrganizationUsageSummary;
    expect(
      page.workspaces
        .find((row) => row.workspaceId === grant.workspaceId)
        ?.totals.find((row) => row.eventType === "model.cost")?.quantity,
    ).toBe(expected);
    expect("totals" in page).toBe(false);
    for (const path of paths) {
      const denied = await app.request(url(path, grant.accountId, summary.until), {
        headers: {
          authorization: await token(subject!, grant.accountId, grant.workspaceId!, [
            "workspace:read",
          ]),
        },
      });
      expect(denied.status).toBe(403);
    }
  }

  // Canonical Personal pointers, not names or currently visible usage, govern
  // organization inventory. Zero-use Personal metadata must never be exposed.
  const personalRows = await shared.admin<Array<{ id: string }>>`select personal_workspace_id as id
    from organization_memberships where account_id = ${grant.accountId} and personal_workspace_id is not null`;
  expect(personalRows.length).toBeGreaterThan(0);
  const personalIds = personalRows.map((row) => row.id);
  for (const id of personalIds) {
    await shared.admin`update workspaces set name = 'SECRET PERSONAL WORKSPACE' where id = ${id}`;
  }
  const sharedIds = [grant.workspaceId!];
  for (let i = 0; i < 51; i++) {
    const id = crypto.randomUUID();
    sharedIds.push(id);
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${grant.accountId}, ${`Shared HTTP workspace ${i}`})`;
  }
  const rawKey = `og_usage_http_${crypto.randomUUID()}`;
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Usage inventory HTTP key",
    prefix: rawKey.slice(0, 12),
    keyHash: createHash("sha256").update(rawKey).digest("hex"),
    permissions: ["billing:read"],
  });
  for (const authorization of [
    await token("user:other-billing-reader", grant.accountId, grant.workspaceId!),
    `Bearer ${rawKey}`,
  ]) {
    const response = await app.request(url("usage-summary", grant.accountId), {
      headers: { authorization },
    });
    expect(response.status).toBe(200);
    const first = (await response.json()) as OrganizationUsageSummary;
    expect(first.workspaces).toHaveLength(50);
    expect(first.nextWorkspaceCursor).not.toBeNull();
    expect(sharedIds).toContain(first.nextWorkspaceCursor!);
    const continuation = await app.request(
      `${url("usage-workspaces", grant.accountId, first.until)}&afterWorkspaceId=${first.nextWorkspaceCursor}`,
      { headers: { authorization } },
    );
    expect(continuation.status).toBe(200);
    const second = (await continuation.json()) as OrganizationUsageSummary;
    expect(second.workspaces).toHaveLength(2);
    expect(second.nextWorkspaceCursor).toBeNull();
    expect(
      new Set([...first.workspaces, ...second.workspaces].map((row) => row.workspaceId)),
    ).toEqual(new Set(sharedIds));
    for (const result of [first, second]) {
      const wire = JSON.stringify(result);
      expect(wire).not.toContain("SECRET PERSONAL WORKSPACE");
      for (const id of personalIds) expect(wire).not.toContain(id);
    }
  }
  // Accounting remains complete for visible sessionless facts even when their
  // Personal workspace metadata is deliberately absent from the shared table.
  await shared.admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit, idempotency_key, occurred_at)
    values (${grant.accountId}, ${personalIds[0]!}, 'model.cost', 7, 'usd_micros', ${crypto.randomUUID()}, ${new Date()})`;
  const reconciled = await app.request(url("usage-summary", grant.accountId), {
    headers: { authorization: `Bearer ${rawKey}` },
  });
  expect(reconciled.status).toBe(200);
  const accounting = (await reconciled.json()) as OrganizationUsageSummary;
  expect(accounting.totals.find((row) => row.eventType === "model.cost")?.quantity).toBe("30");
  expect(JSON.stringify(accounting)).not.toContain(personalIds[0]!);
}, 180_000);
