/**
 * Nango integrations (migration 1406) against real PostgreSQL with FORCE RLS:
 *
 * - the backend switch is append-only, written only through the owner-only
 *   setter and read (newest revision per key) by the runtime role;
 * - usage events are scoped to their organization and summarized into
 *   connection time, traffic and compute with cost estimates;
 * - the owner-only export lists native and Nango connections across
 *   organizations.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createIntegrationBackendSettingsCache,
  insertNangoUsageEvent,
  listNangoAffectedConnections,
  readIntegrationBackendSettings,
  summarizeNangoUsage,
  withAccountRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let adminClient: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("nango-integrations");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
  adminClient = createDb(db.adminUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await adminClient?.close();
  await shared?.release();
}, 60_000);

async function organization(name: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: name,
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: `${name} workspace`,
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

test("the backend switch is owner-written, append-only and runtime-readable", async () => {
  const key = `t${crypto.randomUUID().slice(0, 8)}`;
  await shared.admin`select set_integration_backend(${key}, 'nango', 'google-mail', true,
    ${shared.admin.json({ tools: { source: "nango", allow: ["create-post"] } })},
    'test operator', 'Route through Nango for test')`;
  await shared.admin`select set_integration_backend(${key}, 'native', null, true, null,
    'test operator', 'Flip back to native for test')`;
  const settings = await readIntegrationBackendSettings(client.db);
  const current = settings.find((setting) => setting.integrationKey === key);
  expect(current).toMatchObject({ backend: "native", enabled: true, providerConfigKey: null });

  await expect(
    (async () =>
      await client.db.execute(
        sql`select set_integration_backend(${key}, 'nango', 'x', true, null, 'app', 'Forbidden for app')`,
      ))(),
  ).rejects.toThrow();
  await expect(
    (async () =>
      await client.db.execute(sql`insert into integration_backend_revisions
        (integration_key, backend, enabled, changed_by, reason) values (${key}, 'native', true, 'app', 'Forbidden for app')`))(),
  ).rejects.toThrow();
  // Nango without a provider config key, and malformed definitions, are refused.
  await expect(
    (async () =>
      await shared.admin`select set_integration_backend(${key}, 'nango', null, true, null, 'op', 'Missing provider key')`)(),
  ).rejects.toThrow();
  await expect(
    (async () =>
      await shared.admin`select set_integration_backend(${key}, 'nango', 'k', true, '{"unknown":1}'::jsonb, 'op', 'Unknown definition field')`)(),
  ).rejects.toThrow();
  await expect(
    (async () =>
      await shared.admin`select set_integration_backend(${key}, 'nango', 'k', true, '{"ownership":"workspace"}'::jsonb, 'op', 'Workspace ownership')`)(),
  ).rejects.toThrow();

  const cache = createIntegrationBackendSettingsCache({ ttlMs: 60_000 });
  const first = await cache.get(client.db);
  await shared.admin`select set_integration_backend(${key}, 'nango', 'google-mail', true, null,
    'test operator', 'Route through Nango again')`;
  expect(await cache.get(client.db)).toBe(first);
  cache.invalidate();
  expect(
    (await cache.get(client.db)).find((setting) => setting.integrationKey === key)?.backend,
  ).toBe("nango");
});

test("usage events stay inside their organization and summarize into estimates", async () => {
  const a = await organization("Usage A");
  const b = await organization("Usage B");
  const start = new Date("2026-10-01T00:00:00.000Z");
  const base = {
    accountId: a.accountId,
    workspaceId: a.workspaceId,
    subjectId: a.subjectId,
    integrationKey: "gmail",
    providerConfigKey: "google-mail",
    nangoConnectionId: "nango-a",
  };
  await insertNangoUsageEvent(client.db, {
    ...base,
    kind: "connection_created",
    occurredAt: new Date("2026-09-20T00:00:00Z"),
  });
  await insertNangoUsageEvent(client.db, {
    ...base,
    kind: "connection_deleted",
    occurredAt: new Date("2026-10-16T00:00:00Z"),
  });
  await insertNangoUsageEvent(client.db, {
    ...base,
    kind: "proxy_request",
    httpMethod: "get",
    httpStatus: 200,
    requestBytes: 100,
    responseBytes: 900,
    occurredAt: new Date("2026-10-02T00:00:00Z"),
  });
  await insertNangoUsageEvent(client.db, {
    ...base,
    integrationKey: "linkedin",
    providerConfigKey: "linkedin",
    kind: "tool_call",
    toolName: "create-post",
    durationMs: 1200,
    occurredAt: new Date("2026-10-03T00:00:00Z"),
  });
  await insertNangoUsageEvent(client.db, {
    ...base,
    accountId: b.accountId,
    workspaceId: b.workspaceId,
    subjectId: b.subjectId,
    nangoConnectionId: "nango-b",
    kind: "connection_created",
    occurredAt: new Date("2026-10-01T00:00:00Z"),
  });
  // A usage event may not claim another organization's workspace.
  await expect(
    insertNangoUsageEvent(client.db, {
      ...base,
      workspaceId: b.workspaceId,
      kind: "proxy_request",
    }),
  ).rejects.toThrow();

  const summary = await withAccountRls(client.db, a.accountId, (scoped) =>
    summarizeNangoUsage(scoped, { since: start, until: new Date("2026-11-01T00:00:00Z") }),
  );
  expect(summary.rows.every((row) => row.accountId === a.accountId)).toBe(true);
  const gmail = summary.rows.find((row) => row.integrationKey === "gmail")!;
  expect(gmail.connectionDays).toBe(15);
  expect(gmail.proxyRequests).toBe(1);
  expect(gmail.requestBytes + gmail.responseBytes).toBe(1000);
  const linkedin = summary.rows.find((row) => row.integrationKey === "linkedin")!;
  expect(linkedin.toolCalls).toBe(1);
  expect(linkedin.computeSeconds).toBe(2);
  expect(summary.totals.estimatedCostUsd.connections).toBeCloseTo((15 / 30) * 0.29, 5);

  const operator = await summarizeNangoUsage(adminClient.db, {
    since: start,
    until: new Date("2026-11-01T00:00:00Z"),
    accountId: b.accountId,
  });
  expect(operator.rows.map((row) => row.accountId)).toEqual([b.accountId]);
});

test("the operator export lists native and Nango connections of an integration", async () => {
  const org = await organization("Export org");
  const nativeId = crypto.randomUUID();
  const nangoId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const [id, domain] of [
      [nativeId, "gmailmcp.googleapis.com"],
      [nangoId, "nango:gmail"],
    ] as const) {
      await tx`insert into connections (id, account_id, workspace_id, provider_domain, kind, credential_encrypted,
          origin_workspace_id, metadata)
        values (${id}, ${org.accountId}, ${org.workspaceId}, ${domain}, 'oauth2', 'x', ${org.workspaceId},
          ${tx.json({ accountEmail: "person@example.com" })})`;
    }
  });
  const rows = (await listNangoAffectedConnections(adminClient.db, "gmail")).filter(
    (row) => row.organizationId === org.accountId,
  );
  expect(rows.map((row) => [row.connectionId, row.backend]).sort()).toEqual(
    [
      [nativeId, "native"],
      [nangoId, "nango"],
    ].sort(),
  );
  expect(rows[0]).toMatchObject({
    organizationName: "Export org",
    accountLabel: "person@example.com",
  });
  await expect(listNangoAffectedConnections(client.db, "gmail")).rejects.toThrow();
});

test("the operator export lists native X social accounts for x", async () => {
  const org = await organization("Export X org");
  const socialId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into social_connections (id, account_id, workspace_id, provider, account_handle)
      values (${socialId}, ${org.accountId}, ${org.workspaceId}, 'x', 'opengeni')`;
  });
  const rows = (await listNangoAffectedConnections(adminClient.db, "x")).filter(
    (row) => row.organizationId === org.accountId,
  );
  expect(
    rows.map((row) => [row.connectionId, row.backend, row.providerDomain, row.accountLabel]),
  ).toEqual([[socialId, "native", "x.com", "opengeni"]]);
  expect(
    (await listNangoAffectedConnections(adminClient.db, "gmail")).some(
      (row) => row.connectionId === socialId,
    ),
  ).toBe(false);
});
