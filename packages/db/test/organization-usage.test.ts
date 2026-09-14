import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { OrganizationUsageQuery, OrganizationUsageSummary } from "@opengeni/contracts";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationUsageSummary,
  organizationUsageWindow,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";

describe("organization usage windows and wire quantities", () => {
  const now = new Date("2024-03-01T12:34:56.789Z");
  test.each([
    ["today", "2024-03-01T00:00:00.000Z", "hour"],
    ["week", "2024-02-24T00:00:00.000Z", "day"],
    ["month", "2024-03-01T00:00:00.000Z", "day"],
    ["ytd", "2024-01-01T00:00:00.000Z", "day"],
  ] as const)("%s uses UTC calendar bounds", (period, since, granularity) => {
    expect(organizationUsageWindow(period, now)).toEqual({
      since,
      until: now.toISOString(),
      granularity,
    });
  });
  test("rejects unbounded periods and malformed workspace cursors", () => {
    expect(OrganizationUsageQuery.safeParse({ period: "all" }).success).toBe(false);
    expect(OrganizationUsageQuery.safeParse({ afterWorkspaceId: "bad" }).success).toBe(false);
  });
  test("preserves quantities beyond safe JS integers", () => {
    const result = OrganizationUsageSummary.parse({
      accountId: crypto.randomUUID(),
      period: "today",
      ...organizationUsageWindow("today", now),
      totals: [
        {
          eventType: "model.cost",
          unit: "usd_micros",
          quantity: "9007199254740993",
          eventCount: "101",
        },
      ],
      buckets: [],
      workspaces: [],
      nextWorkspaceCursor: null,
    });
    expect(result.totals[0]!.quantity).toBe("9007199254740993");
  });
});

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-usage");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

test("private-session totals stay actor-visible under the application RLS role", async () => {
  if (!shared || !client) {
    console.warn(
      "SKIPPED organization usage private-session assertions: PostgreSQL fixture unavailable",
    );
    return;
  }
  const userId = `org-usage-private-${crypto.randomUUID()}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Private usage",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test') on conflict (account_id) do nothing`;
  const settings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
    enabled: true,
    expectedVersion: settings.version,
    operationId: crypto.randomUUID(),
  });
  const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Private usage fixture",
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
  await transitionSessionVisibility(client.db, {
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    actorSubjectId: ownerSubjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  await shared.admin`insert into usage_events (account_id, workspace_id, session_id, event_type, quantity, unit, idempotency_key, occurred_at)
    values (${grant.accountId}, ${grant.workspaceId!}, ${session.id}, 'model.cost', 321, 'usd_micros', ${crypto.randomUUID()}, '2026-09-14T01:00:00Z')`;
  const input = { accountId: grant.accountId, period: "today" as const };
  const now = new Date("2026-09-14T12:00:00Z");
  const owner = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    getOrganizationUsageSummary(client!.db, input, now),
  );
  expect(owner.totals.find((total) => total.eventType === "model.cost")?.quantity).toBe("321");
  const outsider = await withSessionRlsActorContext({ subjectId: "user:unrelated" }, () =>
    getOrganizationUsageSummary(client!.db, input, now),
  );
  expect(outsider.totals).toEqual([]);
  expect(outsider.buckets).toEqual([]);
  expect(outsider.workspaces).toEqual([]);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("real RLS query totals all events, separates units, excludes other accounts and half-open bounds", async () => {
  if (!shared || !client) {
    console.warn(
      "SKIPPED real organization usage PostgreSQL assertions: Docker/PostgreSQL fixture unavailable",
    );
    return;
  }
  const makeAccount = async () => {
    const userId = `org-usage-${crypto.randomUUID()}`;
    return await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Usage fixture",
    });
  };
  const access = await makeAccount();
  const other = await makeAccount();
  const grant = access.workspaceGrants[0]!;
  const otherGrant = other.workspaceGrants[0]!;
  const insert = async (
    accountId: string,
    workspaceId: string,
    at: string,
    quantity: string,
    unit = "usd_micros",
  ) => {
    await shared!
      .admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit, idempotency_key, occurred_at)
      values (${accountId}, ${workspaceId}, 'model.cost', ${quantity}, ${unit}, ${crypto.randomUUID()}, ${at})`;
  };
  for (let i = 0; i < 125; i++)
    await insert(grant.accountId, grant.workspaceId!, "2026-09-01T00:00:00Z", "1");
  await insert(grant.accountId, grant.workspaceId!, "2026-09-10T00:00:00Z", "9007199254740993");
  await insert(grant.accountId, grant.workspaceId!, "2026-09-10T00:00:00Z", "7", "other_unit");
  await insert(grant.accountId, grant.workspaceId!, "2026-08-31T23:59:59Z", "999999");
  await insert(grant.accountId, grant.workspaceId!, "2026-09-14T12:00:00Z", "999999");
  await insert(otherGrant.accountId, otherGrant.workspaceId!, "2026-09-10T00:00:00Z", "999999");
  const result = await getOrganizationUsageSummary(
    client.db,
    { accountId: grant.accountId, period: "month" },
    new Date("2026-09-14T12:00:00Z"),
  );
  const total = result.totals.find((row) => row.unit === "usd_micros")!;
  expect(total.quantity).toBe("9007199254741118");
  expect(total.eventCount).toBe("126");
  expect(result.totals.find((row) => row.unit === "other_unit")!.quantity).toBe("7");
  expect(result.workspaces).toHaveLength(1);
  expect(result.workspaces[0]!.workspaceId).toBe(grant.workspaceId!);
  expect(result.workspaces[0]!.totals).toEqual(result.totals);
  expect(result.nextWorkspaceCursor).toBeNull();
  expect(result.buckets.map((bucket) => bucket.bucket)).toEqual(["2026-09-01", "2026-09-10"]);

  // The response is bounded by workspaces, never by usage events. Paging must
  // not change the organization totals or overlap workspace ids.
  for (let i = 0; i < 51; i++) {
    const workspaceId = crypto.randomUUID();
    await shared.admin`insert into workspaces (id, account_id, name)
      values (${workspaceId}, ${grant.accountId}, ${`Usage workspace ${i}`})`;
    await insert(grant.accountId, workspaceId, "2026-09-10T00:00:00Z", "1");
  }
  const pageOne = await getOrganizationUsageSummary(
    client.db,
    { accountId: grant.accountId, period: "month" },
    new Date("2026-09-14T12:00:00Z"),
  );
  expect(pageOne.workspaces).toHaveLength(50);
  expect(pageOne.nextWorkspaceCursor).not.toBeNull();
  const pageTwo = await getOrganizationUsageSummary(
    client.db,
    { accountId: grant.accountId, period: "month", afterWorkspaceId: pageOne.nextWorkspaceCursor! },
    new Date("2026-09-14T12:00:00Z"),
  );
  expect(pageTwo.workspaces).toHaveLength(2);
  expect(pageTwo.nextWorkspaceCursor).toBeNull();
  expect(pageTwo.totals).toEqual(pageOne.totals);
  expect(
    new Set(
      [...pageOne.workspaces, ...pageTwo.workspaces].map((workspace) => workspace.workspaceId),
    ).size,
  ).toBe(52);
}, 180_000);
