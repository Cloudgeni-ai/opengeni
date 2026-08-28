import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  aggregateWarmSecondsByGroup,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  readWorkspaceInsightsUsageBundle,
  registerDbBinding,
  sumUsageQuantityByDay,
  sumUsageQuantityByHour,
  sumUsageQuantityInRange,
  sumUsageQuantitySinceForInsights,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  type Database,
  type DbClient,
  type WorkspaceInsightsUsageBundle,
  type WorkspaceInsightsUsageBundleInput,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import * as schema from "../src/schema";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("insights-usage-bundle");
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Fixture = {
  workspaceId: string;
  ownerSubjectId: string;
  input: WorkspaceInsightsUsageBundleInput;
};

async function fixture(): Promise<Fixture> {
  if (!shared || !client) throw new Error("PostgreSQL test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `insights-usage-bundle-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Insights usage bundle owner",
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;

  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const privateSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
    enabled: true,
    expectedVersion: privateSettings.version,
    operationId: crypto.randomUUID(),
  });

  const privateSession = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "private usage bundle",
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
    workspaceId,
    sessionId: privateSession.id,
    actorSubjectId: ownerSubjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `insights-usage-bundle-private-${suffix}`,
  });
  const sharedSession = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "shared usage bundle",
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

  const now = new Date();
  const until = new Date(now.getTime() + 60_000);
  const since = new Date(now.getTime() - 60 * 60_000);
  const priorUntil = since;
  const priorSince = new Date(since.getTime() - 60 * 60_000);
  const currentAt = new Date(now.getTime() + 1_000);
  const priorAt = new Date(now.getTime() - 90 * 60_000);
  const monthSince = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const privateGroup = crypto.randomUUID();
  const sharedGroup = crypto.randomUUID();
  const workspaceGroup = crypto.randomUUID();
  const values: Array<[string, number, string, string | null, string | null, Date]> = [];
  const add = (
    eventType: string,
    quantity: number,
    unit: string,
    sessionId: string | null,
    sourceResourceId: string | null,
    occurredAt: Date,
  ) => values.push([eventType, quantity, unit, sessionId, sourceResourceId, occurredAt]);

  for (const [sessionId, factor, groupId] of [
    [privateSession.id, 1, privateGroup],
    [sharedSession.id, 2, sharedGroup],
    [null, 4, workspaceGroup],
  ] as const) {
    add("model.cost", 10 * factor, "micros", sessionId, null, currentAt);
    add("sandbox.warm_seconds", 20 * factor, "seconds", sessionId, `${groupId}:1`, currentAt);
    add("model.cost", factor, "micros", sessionId, null, priorAt);
    add("sandbox.warm_seconds", 2 * factor, "seconds", sessionId, `${groupId}:0`, priorAt);
    add("model.tokens", 100 * factor, "tokens", sessionId, null, currentAt);
    add("agent_run.created", factor, "runs", sessionId, null, currentAt);
  }
  add("sandbox.warm_seconds", 5, "seconds", null, "not-a-uuid:1", currentAt);
  add(
    "sandbox.warm_seconds",
    6,
    "seconds",
    null,
    "77777777-7777-7777-8777-777777777777:1",
    currentAt,
  );
  add("model.tokens", 999, "tokens", null, null, monthSince);
  add("irrelevant.event", 999_999, "units", null, null, currentAt);

  for (const [index, value] of values.entries()) {
    await shared.admin`
      insert into usage_events (
        account_id, workspace_id, event_type, quantity, unit, session_id,
        source_resource_id, idempotency_key, occurred_at
      ) values (
        ${grant.accountId}, ${workspaceId}, ${value[0]}, ${value[1]}, ${value[2]},
        ${value[3]}, ${value[4]}, ${`usage-bundle-${suffix}-${index}`}, ${value[5]}
      )`;
  }

  return {
    workspaceId,
    ownerSubjectId,
    input: {
      workspaceId,
      since,
      until,
      priorSince,
      priorUntil,
      monthSince,
      granularity: "day",
      warmGroupLimit: 24,
    },
  };
}

async function legacyUsageBundle(
  db: Database,
  input: WorkspaceInsightsUsageBundleInput,
): Promise<WorkspaceInsightsUsageBundle> {
  const current = { workspaceId: input.workspaceId, since: input.since, until: input.until };
  const prior = {
    workspaceId: input.workspaceId,
    since: input.priorSince,
    until: input.priorUntil,
  };
  const series = input.granularity === "hour" ? sumUsageQuantityByHour : sumUsageQuantityByDay;
  const [
    workspaceCreditMicros,
    priorWorkspaceCreditMicros,
    warmSeconds,
    priorWarmSeconds,
    costBuckets,
    warmBuckets,
    warmGroups,
    billableTokensUsed,
    agentRunsUsed,
  ] = await Promise.all([
    sumUsageQuantityInRange(db, { ...current, eventType: "model.cost" }),
    sumUsageQuantityInRange(db, { ...prior, eventType: "model.cost" }),
    sumUsageQuantityInRange(db, { ...current, eventType: "sandbox.warm_seconds" }),
    sumUsageQuantityInRange(db, { ...prior, eventType: "sandbox.warm_seconds" }),
    series(db, { ...current, eventType: "model.cost" }),
    series(db, { ...current, eventType: "sandbox.warm_seconds" }),
    aggregateWarmSecondsByGroup(db, { ...current, limit: input.warmGroupLimit ?? 24 }),
    sumUsageQuantitySinceForInsights(db, {
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      since: input.monthSince,
    }),
    sumUsageQuantitySinceForInsights(db, {
      workspaceId: input.workspaceId,
      eventType: "agent_run.created",
      since: input.monthSince,
    }),
  ]);
  const buckets = new Map(
    [...new Set([...costBuckets.keys(), ...warmBuckets.keys()])].map((bucket) => [
      bucket,
      {
        costMicros: costBuckets.has(bucket) ? (costBuckets.get(bucket) ?? 0) : null,
        warmSeconds: warmBuckets.get(bucket) ?? 0,
      },
    ]),
  );
  return {
    workspaceCreditMicros,
    priorWorkspaceCreditMicros,
    warmSeconds,
    priorWarmSeconds,
    buckets,
    warmGroups,
    billableTokensUsed,
    agentRunsUsed,
  };
}

function comparable(bundle: WorkspaceInsightsUsageBundle) {
  return {
    ...bundle,
    buckets: [...bundle.buckets.entries()].sort(([left], [right]) => left.localeCompare(right)),
    warmGroups: [...bundle.warmGroups].sort((left, right) =>
      left.groupId.localeCompare(right.groupId),
    ),
  };
}

function instrumentedDb(statements: string[]): { db: Database; close: () => Promise<void> } {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const raw = postgres(shared.appUrl, {
    max: 8,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    debug: (_connection, query) => statements.push(query),
  });
  const db = drizzle(raw, { schema }) as unknown as Database;
  registerDbBinding(db, { rlsStrategy: "force" });
  return { db, close: () => raw.end() };
}

describe("Workspace Insights usage bundle", () => {
  test("matches the nine legacy reads for shared/private and workspace-level usage", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const cases = [
      { subjectId: seeded.ownerSubjectId, input: seeded.input },
      {
        subjectId: seeded.ownerSubjectId,
        input: { ...seeded.input, granularity: "hour" as const },
      },
      { subjectId: `user:${crypto.randomUUID()}`, input: seeded.input },
    ];
    for (const testCase of cases) {
      const { subjectId, input } = testCase;
      const [legacy, bundled] = await withSessionRlsActorContext({ subjectId }, () =>
        Promise.all([
          legacyUsageBundle(client!.db, input),
          readWorkspaceInsightsUsageBundle(client!.db, input),
        ]),
      );
      expect(comparable(bundled)).toEqual(comparable(legacy));
      const owner = subjectId === seeded.ownerSubjectId;
      expect(bundled.billableTokensUsed).toBe(owner ? 700 : 600);
      expect(bundled.agentRunsUsed).toBe(owner ? 7 : 6);
      expect(bundled.warmGroups.every((group) => group.groupId !== "not-a-uuid")).toBe(true);
      expect(bundled.warmGroups.some((group) => group.groupId.startsWith("77777777-"))).toBe(true);
    }

    const emptyInput = {
      ...seeded.input,
      since: seeded.input.until,
      priorSince: seeded.input.priorUntil,
    };
    const [legacyEmpty, bundledEmpty] = await withSessionRlsActorContext(
      { subjectId: seeded.ownerSubjectId },
      () =>
        Promise.all([
          legacyUsageBundle(client!.db, emptyInput),
          readWorkspaceInsightsUsageBundle(client!.db, emptyInput),
        ]),
    );
    expect(comparable(bundledEmpty)).toEqual(comparable(legacyEmpty));
    expect(bundledEmpty.workspaceCreditMicros).toBe(0);
    expect(bundledEmpty.warmSeconds).toBe(0);
    expect(bundledEmpty.buckets).toEqual(new Map());
    expect(bundledEmpty.warmGroups).toEqual([]);
  });

  test("reduces visible usage source invocations from nine to three exact windows", async () => {
    if (!shared) return;
    const seeded = await fixture();
    const legacyStatements: string[] = [];
    const legacyDb = instrumentedDb(legacyStatements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        legacyUsageBundle(legacyDb.db, seeded.input),
      );
    } finally {
      await legacyDb.close();
    }
    const bundledStatements: string[] = [];
    const bundledDb = instrumentedDb(bundledStatements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        readWorkspaceInsightsUsageBundle(bundledDb.db, seeded.input),
      );
    } finally {
      await bundledDb.close();
    }

    const source = "visible_workspace_insights_usage_events";
    const legacyInvocations = legacyStatements.reduce(
      (total, statement) => total + (statement.match(new RegExp(source, "g"))?.length ?? 0),
      0,
    );
    const bundleQueries = bundledStatements.filter((statement) => statement.includes(source));
    const bundledInvocations = bundleQueries.reduce(
      (total, statement) => total + (statement.match(new RegExp(source, "g"))?.length ?? 0),
      0,
    );
    expect(legacyInvocations).toBe(9);
    expect(bundleQueries).toHaveLength(1);
    expect(bundledInvocations).toBe(3);
    expect(bundleQueries[0]).toContain("array['model.cost', 'sandbox.warm_seconds']::text[]");
    expect(bundleQueries[0]).toContain("array['model.tokens', 'agent_run.created']::text[]");
  });
});
