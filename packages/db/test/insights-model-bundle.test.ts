import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  aggregateModelCallFacts,
  aggregateModelCallFactsByDay,
  aggregateModelCallFactsByHour,
  aggregateModelContextContributions,
  aggregateRootSessionDrivers,
  aggregateScheduleFacts,
  backfillModelCallFactsFromSessionEvents,
  createChannel,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  listModelCallFacets,
  listRecentModelCalls,
  INSIGHTS_RECENT_CALL_LIMIT,
  INSIGHTS_PROJECT_LIMIT,
  INSIGHTS_ROOT_DRIVER_LIMIT,
  readWorkspaceInsightsModelBundle,
  reconcileModelCallFacts,
  registerDbBinding,
  setSessionChannel,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  type Database,
  type DbClient,
  type WorkspaceInsightsModelBundle,
  type WorkspaceInsightsModelBundleInput,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import * as schema from "../src/schema";
import { reconcileModelCallFactPage } from "../src/model-call-fact-reconciliation";

setDefaultTimeout(120_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) return await acquireSharedTestDatabase("insights-model-bundle");
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Fixture = {
  accountId: string;
  workspaceId: string;
  ownerSubjectId: string;
  sharedSessionId: string;
  privateSessionId: string;
  input: WorkspaceInsightsModelBundleInput;
};

async function fixture(): Promise<Fixture> {
  if (!shared || !client) throw new Error("PostgreSQL test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `insights-model-bundle-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Insights model bundle owner",
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
      initialMessage: "private model bundle",
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
    operationKey: `insights-model-bundle-private-${suffix}`,
  });
  const sharedSession = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "shared model bundle",
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
  await shared.admin`
    update sessions
    set title = case
      when id = ${privateSession.id} then 'Private model root'
      when id = ${sharedSession.id} then 'Shared model root'
      else title
    end
    where id in (${privateSession.id}, ${sharedSession.id})`;

  const privateTaskId = crypto.randomUUID();
  const sharedTaskId = crypto.randomUUID();
  const priorSince = new Date("2026-08-01T00:00:00.000Z");
  const priorUntil = new Date("2026-08-10T00:00:00.000Z");
  const since = new Date("2026-08-10T00:00:00.000Z");
  const until = new Date("2026-08-20T00:00:00.000Z");
  await shared.admin`
    insert into model_call_facts (
      account_id, workspace_id, session_id, turn_id, source_key, provider,
      provider_api, model, billing_path, scheduled_task_id,
      input_tokens, output_tokens, cached_tokens, cache_write_tokens,
      reasoning_tokens, total_tokens, priced_cost_micros,
      estimated_provider_cost_micros, equivalent_credit_cost_micros,
      pricing_source, context_contributions,
      occurred_at, recorded_at
    ) values
      (
        ${grant.accountId}, ${workspaceId}, ${sharedSession.id}, ${crypto.randomUUID()},
        ${`shared-openai-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'external',
        ${sharedTaskId}, 100, 50, 20, null, 5, 150, 0, 25, 27, 'gateway_reported',
        ${shared.admin.json([{ source: "company_profile", items: 1, utf8Bytes: 80, estimatedTokens: 20 }])},
        '2026-08-11T09:15:00.000Z', '2026-08-11T09:15:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${sharedSession.id}, ${crypto.randomUUID()},
        ${`shared-azure-${suffix}`}, 'azure', 'responses', 'azure-bundle', 'opengeni_credits',
        ${sharedTaskId}, null, 10, null, null, null, 10, 200, null, null, null, null,
        '2026-08-12T10:30:00.000Z', '2026-08-12T10:30:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${privateSession.id}, ${crypto.randomUUID()},
        ${`private-openai-a-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits',
        ${privateTaskId}, 40, 20, 10, 3, 2, 60, 300, 50, 53, 'configured_list_price',
        ${shared.admin.json([{ source: "workspace_instruction_policy", items: 2, utf8Bytes: 120, estimatedTokens: 30 }])},
        '2026-08-13T11:45:00.000Z', '2026-08-13T11:45:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${privateSession.id}, ${crypto.randomUUID()},
        ${`private-openai-b-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits',
        ${privateTaskId}, 10, 5, null, null, null, 15, 75, null, null, null, '[]'::jsonb,
        '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${sharedSession.id}, ${crypto.randomUUID()},
        ${`prior-shared-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits',
        ${sharedTaskId}, 70, 30, 10, null, null, 100, 100, 20, 21, 'configured_list_price', null,
        '2026-08-02T08:00:00.000Z', '2026-08-02T08:00:01.000Z'
      ),
      (
        ${grant.accountId}, ${workspaceId}, ${privateSession.id}, ${crypto.randomUUID()},
        ${`prior-private-${suffix}`}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits',
        ${privateTaskId}, 10, 10, 5, null, null, 20, 50, 10, 11, 'configured_list_price', null,
        '2026-08-03T08:00:00.000Z', '2026-08-03T08:00:01.000Z'
      )`;

  return {
    accountId: grant.accountId,
    workspaceId,
    ownerSubjectId,
    sharedSessionId: sharedSession.id,
    privateSessionId: privateSession.id,
    input: {
      workspaceId,
      since,
      until,
      priorSince,
      priorUntil,
      granularity: "day",
    },
  };
}

type LegacyComparableBundle = Omit<
  WorkspaceInsightsModelBundle,
  | "dataThrough"
  | "driverGroups"
  | "driversTruncated"
  | "facetsTruncated"
  | "recentCallsTruncated"
  | "projects"
  | "privateChats"
  | "privateChatsTruncated"
>;

async function legacyModelBundle(
  db: Database,
  input: WorkspaceInsightsModelBundleInput,
): Promise<LegacyComparableBundle> {
  const filter = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
  const window = {
    workspaceId: input.workspaceId,
    since: input.since,
    until: input.until,
    ...filter,
  };
  const priorWindow = {
    workspaceId: input.workspaceId,
    since: input.priorSince,
    until: input.priorUntil,
    ...filter,
  };
  const series =
    input.granularity === "hour" ? aggregateModelCallFactsByHour : aggregateModelCallFactsByDay;
  const [
    modelRows,
    priorModelRows,
    factBuckets,
    rootDrivers,
    scheduleFacts,
    facets,
    recentCalls,
    promptContributions,
  ] = await Promise.all([
    aggregateModelCallFacts(db, window),
    aggregateModelCallFacts(db, priorWindow),
    series(db, window),
    aggregateRootSessionDrivers(db, { ...window, limit: 8 }),
    aggregateScheduleFacts(db, window),
    listModelCallFacets(db, window),
    listRecentModelCalls(db, { ...window, limit: 50 }),
    aggregateModelContextContributions(db, window),
  ]);
  const priorRootDrivers = await aggregateRootSessionDrivers(db, {
    ...priorWindow,
    rootSessionIds: rootDrivers.map((row) => row.rootSessionId),
  });
  return {
    modelRows,
    priorModelRows,
    factBuckets,
    rootDrivers,
    priorRootDrivers,
    scheduleFacts,
    facets,
    recentCalls,
    promptContributions,
  };
}

function comparable(input: LegacyComparableBundle | WorkspaceInsightsModelBundle) {
  const {
    dataThrough: _dataThrough,
    driverGroups: _driverGroups,
    driversTruncated: _driversTruncated,
    facetsTruncated: _facetsTruncated,
    recentCallsTruncated: _recentCallsTruncated,
    projects: _projects,
    privateChats: _privateChats,
    privateChatsTruncated: _privateChatsTruncated,
    ...bundle
  } = input as WorkspaceInsightsModelBundle;
  return {
    ...bundle,
    modelRows: [...bundle.modelRows].sort((a, b) =>
      `${a.provider}:${a.model}:${a.billingPath}`.localeCompare(
        `${b.provider}:${b.model}:${b.billingPath}`,
      ),
    ),
    priorModelRows: [...bundle.priorModelRows].sort((a, b) =>
      `${a.provider}:${a.model}:${a.billingPath}`.localeCompare(
        `${b.provider}:${b.model}:${b.billingPath}`,
      ),
    ),
    factBuckets: [...bundle.factBuckets.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
    priorRootDrivers: [...bundle.priorRootDrivers].sort((a, b) =>
      a.rootSessionId.localeCompare(b.rootSessionId),
    ),
    scheduleFacts: [...bundle.scheduleFacts].sort((a, b) =>
      a.scheduledTaskId.localeCompare(b.scheduledTaskId),
    ),
  };
}

type CapturedParameter = string | number | boolean | null;
type CapturedStatement = { query: string; parameters: CapturedParameter[] };

type PlanNode = {
  "Relation Name"?: string;
  "Actual Loops"?: number;
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
};

function planNodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

function capturedParameter(value: unknown): CapturedParameter {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error("Unexpected captured Insights query parameter");
}

function instrumentedDb(statements: CapturedStatement[]): {
  db: Database;
  close: () => Promise<void>;
} {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const raw = postgres(shared.appUrl, {
    max: 8,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    debug: (_connection, query, parameters) =>
      statements.push({ query, parameters: parameters.map(capturedParameter) }),
  });
  const db = drizzle(raw, { schema }) as unknown as Database;
  registerDbBinding(db, { rlsStrategy: "force" });
  return { db, close: () => raw.end() };
}

function sessionRelationLoops(value: unknown, loops: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const item of value) sessionRelationLoops(item, loops);
    return loops;
  }
  if (value === null || typeof value !== "object") return loops;
  const row = value as Record<string, unknown>;
  if (row["Relation Name"] === "sessions" && typeof row["Actual Loops"] === "number") {
    loops.push(row["Actual Loops"]);
  }
  for (const child of Object.values(row)) sessionRelationLoops(child, loops);
  return loops;
}

describe("Workspace Insights model bundle", () => {
  test("incremental queue ingestion and native-adapter maintenance budget", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const turnId = crypto.randomUUID();
    await shared.admin`insert into session_turns (id,account_id,workspace_id,session_id,trigger_event_id,
      temporal_workflow_id,status,position,prompt,model,reasoning_effort,latency_mode,sandbox_backend,resources,tools,metadata)
      values (${turnId},${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},${crypto.randomUUID()},
        ${`session-${seeded.sharedSessionId}`},'completed',100,'ingestion fixture','fixture','medium','standard','none','[]','[]','{}')`;
    const samples = { without: [] as number[], with: [] as number[] };
    const rollback = new Error("rollback ingestion benchmark");
    const ingest = async (tx: postgres.TransactionSql) => {
      await tx`insert into usage_events (account_id,workspace_id,event_type,quantity,unit,
        source_resource_type,source_resource_id,session_id,turn_id,occurred_at,idempotency_key)
        select ${seeded.accountId},${seeded.workspaceId},'model.cost',1,'usd_micros',
          'model_response',${turnId}||':ingest-'||n,${seeded.sharedSessionId},${turnId},'2026-08-15',${turnId}||':ingest-'||n
        from generate_series(1,1000) g(n)`;
      await tx`insert into session_events (account_id,workspace_id,session_id,turn_id,turn_association,
        sequence,type,payload,occurred_at)
        select ${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},${turnId},'current',
          (select coalesce(max(sequence),0) from session_events where session_id=${seeded.sharedSessionId})+n,
          'agent.model.usage',jsonb_build_object('sourceKey','ingest-'||n,'provider','openai',
            'providerApi','responses','model','fixture'),'2026-08-15'
        from generate_series(1,1000) g(n)`;
    };
    for (let trial = 0; trial < 3; trial++)
      for (const enabled of [false, true]) {
        try {
          await shared.admin.begin(async (tx) => {
            if (!enabled) {
              await tx`alter table usage_events disable trigger model_fact_reconciliation_ledger_arrival`;
              await tx`alter table session_events disable trigger model_fact_reconciliation_event_arrival`;
            }
            const start = performance.now();
            await ingest(tx);
            samples[enabled ? "with" : "without"].push(performance.now() - start);
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
      }
    const window = {
      workspaceId: seeded.workspaceId,
      since: new Date("2026-08-15"),
      until: new Date("2026-08-16"),
      limit: 500,
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 180000,
    };
    expect(await reconcileModelCallFacts(client.db, window)).toMatchObject({ truncated: false });
    await shared.admin.begin(ingest);
    await shared.admin`insert into model_call_facts (account_id,workspace_id,session_id,turn_id,source_key,
      provider,provider_api,model,billing_path,priced_cost_micros,occurred_at)
      select ${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},${turnId},'ingest-'||n,
        'openai','responses','fixture','opengeni_credits',1,'2026-08-15' from generate_series(1,1000) g(n)`;
    const start = performance.now();
    let pages = 0;
    for (;;) {
      const result = await reconcileModelCallFacts(client.db, window);
      pages++;
      expect(result.missing).toBe(0);
      if (!result.truncated) break;
      if (pages > 2) throw new Error("Native incremental queue did not drain");
    }
    expect(pages).toBe(2);
    if (process.env.INSIGHTS_EXPLAIN === "1")
      console.log("native incremental and ingestion", {
        newRows: 1000,
        pages,
        wallMs: performance.now() - start,
        ingestionSamplesMs: samples,
      });
  }, 180_000);

  test("an arrival behind a claimed history cursor is reopened, not lost", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const turnId = crypto.randomUUID();
    await shared.admin`insert into session_turns (id,account_id,workspace_id,session_id,trigger_event_id,
      temporal_workflow_id,status,position,prompt,model,reasoning_effort,latency_mode,sandbox_backend,resources,tools,metadata)
      values (${turnId},${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},${crypto.randomUUID()},
        ${`session-${seeded.sharedSessionId}`},'completed',100,'arrival fixture','fixture','medium','standard','none','[]','[]','{}')`;
    const append = async (
      key: string,
      at: string,
      writer: postgres.Sql | postgres.TransactionSql = shared!.admin,
    ) => {
      await writer`insert into session_events
        (account_id,workspace_id,session_id,turn_id,turn_association,sequence,type,payload,occurred_at)
        values (${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},${turnId},'current',
          (select coalesce(max(sequence),0)+1 from session_events where session_id=${seeded.sharedSessionId}),
          'agent.model.usage',${shared!.admin.json({ sourceKey: key, provider: "openai", providerApi: "responses", model: "fixture" })},${at})`;
    };
    for (let n = 1; n <= 3; n++) await append(`unrelated-${n}`, `2026-08-15T00:00:0${n}Z`);
    await shared.admin`insert into usage_events
      (account_id,workspace_id,event_type,quantity,unit,source_resource_type,source_resource_id,session_id,turn_id,occurred_at,idempotency_key)
      values (${seeded.accountId},${seeded.workspaceId},'model.cost',1,'usd_micros','model_response',
        ${turnId + ":delayed"},${seeded.sharedSessionId},${turnId},'2026-08-15',${turnId + ":delayed"})`;
    const window = {
      workspaceId: seeded.workspaceId,
      since: new Date("2026-08-15"),
      until: new Date("2026-08-16"),
      limit: 2,
    };
    expect(await reconcileModelCallFacts(client.db, window)).toMatchObject({
      repaired: 0,
      truncated: true,
    });
    const [claimed] =
      await shared.admin`select batch_id from model_call_fact_reconciliation_candidates where workspace_id=${seeded.workspaceId}`;
    expect(claimed!.batch_id).not.toBeNull();
    await append("delayed", "2026-08-15T00:00:00Z");
    const [reopened] =
      await shared.admin`select batch_id from model_call_fact_reconciliation_candidates where workspace_id=${seeded.workspaceId}`;
    expect(reopened!.batch_id).toBeNull();
    let total = 0;
    for (let n = 0; n < 10; n++) {
      const result = await reconcileModelCallFacts(client.db, window);
      total += result.repaired;
      if (!result.truncated) break;
      if (n === 9) throw new Error("Reopened arrival did not finish");
    }
    expect(total).toBe(1);
    expect(await reconcileModelCallFacts(client.db, window)).toEqual({
      missing: 0,
      repaired: 0,
      unrepaired: 0,
      truncated: false,
    });

    // A source transaction starts before a completed checkpoint and commits
    // afterwards. Neither recorded_at nor occurred_at is a safe watermark.
    let release!: () => void, inserted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const writer = shared.admin.begin(async (tx) => {
      await tx`insert into usage_events
        (account_id,workspace_id,event_type,quantity,unit,source_resource_type,source_resource_id,session_id,turn_id,occurred_at,idempotency_key)
        values (${seeded.accountId},${seeded.workspaceId},'model.cost',1,'usd_micros','model_response',
          ${turnId + ":late-commit"},${seeded.sharedSessionId},${turnId},'2026-08-01',${turnId + ":late-commit"})`;
      inserted();
      await gate;
    });
    try {
      await ready;
      expect(await reconcileModelCallFacts(client.db, window)).toMatchObject({
        missing: 0,
        truncated: false,
      });
    } finally {
      release();
      await writer;
    }
    await append("late-commit", "2026-08-01T00:00:00Z");
    let late = 0;
    for (let n = 0; n < 10; n++) {
      const result = await reconcileModelCallFacts(client.db, window);
      late += result.repaired;
      if (!result.truncated) break;
      if (n === 9) throw new Error("Late commit did not finish");
    }
    expect(late).toBe(1);

    await shared.admin`insert into usage_events
      (account_id,workspace_id,event_type,quantity,unit,source_resource_type,source_resource_id,session_id,turn_id,occurred_at,idempotency_key)
      values (${seeded.accountId},${seeded.workspaceId},'model.cost',1,'usd_micros','model_response',
        ${turnId + ":concurrent"},${seeded.sharedSessionId},${turnId},'2026-08-01',${turnId + ":concurrent"}),
        (${seeded.accountId},${seeded.workspaceId},'model.cost',1,'usd_micros','model_response',
        ${turnId + ":concurrent-wait"},${seeded.sharedSessionId},${turnId},'2026-08-01',${turnId + ":concurrent-wait"})`;
    await append("concurrent", "2026-08-01T00:00:01Z");
    let unlock!: () => void, repairing!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      repairing = resolve;
    });
    const repair = reconcileModelCallFactPage(client.db, { ...window, limit: 100 }, async () => {
      repairing();
      await held;
      return false;
    });
    await Promise.race([
      entered,
      repair.then(() => {
        throw new Error("Expected a claimed repair");
      }),
    ]);
    let writerPid = 0;
    const arrival = shared.admin.begin(async (tx) => {
      const [backend] = await tx`select pg_backend_pid() as pid`;
      writerPid = backend!.pid;
      await append("concurrent-wait", "2026-08-01T00:00:02Z", tx);
    });
    // Observe immediately; finally below still joins and propagates failures.
    void arrival.catch(() => undefined);
    // Observe the actual conflict, rather than guessing that a launched query
    // reached the queue. These are two connections to this isolated fixture.
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (writerPid) {
          const [activity] =
            await shared.admin`select wait_event_type from pg_stat_activity where pid=${writerPid}`;
          if (activity?.wait_event_type === "Lock") {
            waiting = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      unlock();
      await Promise.all([repair, arrival]);
    }
    const [pending] =
      await shared.admin`select batch_id from model_call_fact_reconciliation_candidates
      where workspace_id=${seeded.workspaceId} and source_key='concurrent-wait'`;
    expect(pending).toBeDefined();
    expect(pending!.batch_id).toBeNull();
    expect(await reconcileModelCallFacts(client.db, { ...window, limit: 100 })).toMatchObject({
      repaired: 1,
      truncated: false,
    });
    await shared.admin`insert into usage_events
      (account_id,workspace_id,event_type,quantity,unit,source_resource_type,source_resource_id,occurred_at,idempotency_key)
      values (${seeded.accountId},${seeded.workspaceId},'model.cost',1,'usd_micros','model_response',
        ${turnId + ":attribution"},'2026-08-01',${turnId + ":attribution"})`;
    await append("attribution", "2026-08-01T00:00:03Z");
    expect(await reconcileModelCallFacts(client.db, window)).toMatchObject({
      missing: 0,
      truncated: false,
    });
    // recordUsageEvent's idempotent replay fills nullable attribution this way.
    await shared.admin`update usage_events set session_id=${seeded.sharedSessionId},turn_id=${turnId}
      where workspace_id=${seeded.workspaceId} and idempotency_key=${turnId + ":attribution"}`;
    expect(await reconcileModelCallFacts(client.db, { ...window, limit: 100 })).toMatchObject({
      repaired: 1,
      truncated: false,
    });
  });

  test("one-row ledger and event pages preserve PostgreSQL microseconds and frozen windows", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const turnId = crypto.randomUUID();
    await shared.admin`insert into session_turns (id, account_id, workspace_id, session_id,
      trigger_event_id, temporal_workflow_id, status, position, prompt, model,
      reasoning_effort, latency_mode, sandbox_backend, resources, tools, metadata)
      values (${turnId},${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},
        ${crypto.randomUUID()},${`session-${seeded.sharedSessionId}`},'completed',100,
        'cursor fixture','fixture','medium','standard','none','[]','[]','{}')`;
    await shared.admin`insert into usage_events (account_id,workspace_id,event_type,quantity,unit,
      source_resource_type,source_resource_id,session_id,turn_id,idempotency_key,occurred_at)
      select ${seeded.accountId},${seeded.workspaceId},'model.cost',n,'usd_micros',
        'model_response',${turnId}||':micro-'||n,${seeded.sharedSessionId},${turnId},
        ${turnId}||':micro-'||n,'2026-08-15'::timestamptz+n*interval '1 microsecond'
      from generate_series(1,3) g(n)`;
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into session_events (account_id,workspace_id,session_id,turn_id,
      turn_association,sequence,type,payload,occurred_at)
      select ${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},${turnId},
        'current',100+n,'agent.model.usage',jsonb_build_object('sourceKey','micro-'||n,
          'model','fixture','provider','openai','providerApi','responses','billingPath','opengeni_credits'),
        '2026-08-15'::timestamptz+n*interval '1 microsecond'
      from generate_series(1,3) g(n)`;
    });
    const window = {
      workspaceId: seeded.workspaceId,
      since: new Date("2026-08-15"),
      until: new Date("2026-08-16"),
      limit: 1,
    };
    const first = await reconcileModelCallFacts(client.db, window);
    expect(first).toMatchObject({ repaired: 0, truncated: true });
    let repaired = 0;
    let complete = false;
    for (let page = 0; page < 10; page++) {
      // A later scheduled run must finish the persisted window, even after
      // its original lookback interval has elapsed.
      const next = await reconcileModelCallFacts(client.db, {
        ...window,
        since: new Date("2026-08-18"),
        until: new Date("2026-08-19"),
      });
      repaired += next.repaired;
      if (!next.truncated) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    expect(repaired).toBe(3);
    const [progress] =
      await shared.admin`select checkpoint from model_call_fact_reconciliation_progress where workspace_id=${seeded.workspaceId}`;
    expect(progress?.checkpoint).toMatchObject({
      since: "2026-08-15T00:00:00.000Z",
      until: "2026-08-16T00:00:00.000Z",
      complete: true,
    });
    await reconcileModelCallFacts(client.db, {
      ...window,
      since: new Date("2026-08-18"),
      until: new Date("2026-08-19"),
    });
    const [bridged] =
      await shared.admin`select checkpoint from model_call_fact_reconciliation_progress where workspace_id=${seeded.workspaceId}`;
    expect(bridged?.checkpoint).toMatchObject({
      since: "2026-08-16T00:00:00.000Z",
      until: "2026-08-19T00:00:00.000Z",
    });
  });

  test("reconciliation scales with ledger history under application RLS", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const size = Number(process.env.INSIGHTS_PLAN_ROWS ?? 10000);
    const gaps = Number(process.env.INSIGHTS_PLAN_MISSING ?? 100);
    const backgroundSize = Number(process.env.INSIGHTS_PLAN_BACKGROUND ?? size * 4);
    const pageSize = 500; // The control worker's input-page budget.
    const turnId = crypto.randomUUID();
    const unrelatedTurnId = crypto.randomUUID();
    await shared.admin`
      insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, resources, tools, metadata)
      values (${turnId}, ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
        ${crypto.randomUUID()}, ${`session-${seeded.sharedSessionId}`}, 'completed', 100,
        'scale fixture', 'fixture', 'medium', 'standard', 'none', '[]', '[]', '{}')`;
    await shared.admin.begin(async (tx) => {
      // Synthetic history, not an ingestion benchmark. Skip maintenance triggers
      // while loading; all reads below use the restricted application role/RLS.
      await tx`set local session_replication_role = replica`;
      await tx`
      insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
        source_resource_type, source_resource_id, session_id, turn_id, idempotency_key, occurred_at)
      select ${seeded.accountId}, ${seeded.workspaceId}, 'model.cost', 1, 'usd_micros',
        'model_response', ${turnId} || ':scale-' || n, ${seeded.sharedSessionId}, ${turnId},
        'scale-' || n, '2026-08-15'::timestamptz
      from generate_series(1, ${size}::integer) g(n)`;
      await tx`
      insert into model_call_facts (account_id, workspace_id, session_id, turn_id, source_key,
        provider, provider_api, model, billing_path, priced_cost_micros, occurred_at)
      select ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${turnId},
        'scale-' || n, 'openai', 'responses', 'fixture', 'opengeni_credits', 1,
        '2026-08-15'::timestamptz
      from generate_series(1, ${size}::integer) g(n)`;
    });
    await shared.admin`analyze usage_events`;
    await shared.admin`analyze model_call_facts`;
    const statements: CapturedStatement[] = [];
    const captured = instrumentedDb(statements);
    const started = performance.now();
    try {
      let result;
      let pages = 0;
      do {
        result = await reconcileModelCallFacts(captured.db, {
          limit: pageSize,
          workspaceId: seeded.workspaceId,
          since: new Date("2026-08-15"),
          until: new Date("2026-08-16"),
        });
        expect(result).toMatchObject({ missing: 0, repaired: 0, unrepaired: 0 });
        if (++pages > Math.ceil(size / pageSize) + 1)
          throw new Error("Ledger page did not advance");
      } while (result.truncated);
    } finally {
      await captured.close();
    }
    if (process.env.INSIGHTS_EXPLAIN === "1")
      console.log("reconcile wall ms", performance.now() - started, "rows", size);
    const statement = statements.find((s) => s.query.includes("-- model-fact-ledger-page"))!;
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from model_call_facts where turn_id = ${turnId} and source_key in
        (select 'scale-' || n from generate_series(${size - gaps + 1}::integer, ${size}::integer) g(n))`;
      await tx`
      insert into session_events(account_id, workspace_id, session_id, turn_id, turn_association,
        sequence, type, payload, usage_source_key, occurred_at)
      select ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${turnId},
        'current', 100 + n, 'agent.model.usage',
        jsonb_build_object('sourceKey', 'scale-' || n, 'model', 'fixture', 'provider', 'openai',
          'providerApi', 'responses', 'billingPath', 'opengeni_credits', 'inputTokens', 10),
        case when n % 2 = 0 then null else 'scale-' || n end,
        '2026-08-15'::timestamptz from generate_series(1, ${size}::integer) g(n)`;
      // Old events in other turns must not be read just to rank current gaps.
      await tx`
        insert into session_events(account_id, workspace_id, session_id, turn_id, turn_association,
          sequence, type, payload, occurred_at)
        select ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${unrelatedTurnId},
          'current', ${size + 100} + n, 'agent.model.usage',
          jsonb_build_object('sourceKey', 'unrelated-' || n), '2026-07-01'::timestamptz
        from generate_series(1, ${backgroundSize}::integer) g(n)`;
    });
    await shared.admin`analyze session_events`;
    await shared.admin`analyze model_call_facts`;
    const app = postgres(shared.appUrl, {
      max: 1,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    try {
      await app.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${seeded.accountId}, true),
          set_config('opengeni.workspace_id', ${seeded.workspaceId}, true)`;
        const rows = await tx.unsafe<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>>(
          `explain (analyze, buffers, format json) ${statement.query}`,
          statement.parameters,
        );
        if (process.env.INSIGHTS_EXPLAIN === "1")
          console.log(JSON.stringify(rows[0]?.["QUERY PLAN"], null, 2));
        const plan = rows[0]!["QUERY PLAN"][0]!.Plan;
        expect(plan["Actual Rows"]).toBe(1);
        const eventReads = planNodes(plan).filter(
          (node) => node["Relation Name"] === "session_events",
        );
        expect(eventReads).toHaveLength(0);
        const ledgerReads = planNodes(plan).filter(
          (node) => node["Relation Name"] === "usage_events",
        );
        expect(ledgerReads).toHaveLength(1);
        expect(ledgerReads[0]!["Actual Rows"]).toBeLessThanOrEqual(pageSize + 1);
        const factReads = planNodes(plan).filter(
          (node) => node["Relation Name"] === "model_call_facts",
        );
        expect(factReads).toHaveLength(1);
        expect(factReads[0]!["Actual Rows"]).toBeLessThanOrEqual(1);
        expect(factReads[0]!["Actual Loops"]).toBeLessThanOrEqual(pageSize);
        expect(factReads[0]!["Rows Removed by Filter"] ?? 0).toBeLessThanOrEqual(1);
      });
    } finally {
      await app.end();
    }
    const repairStatements: CapturedStatement[] = [];
    // Simulate an initial upgrade over history with pre-existing gaps. Later
    // normal runs must use the arrival queue, not discover deletions made by
    // this fixture behind the already-completed historical checkpoint.
    await shared.admin`delete from model_call_fact_reconciliation_progress where workspace_id=${seeded.workspaceId}`;
    const repairClient = instrumentedDb(repairStatements);
    const repairStart = performance.now();
    let pages = 0,
      repaired = 0,
      missing = 0;
    const pageTimes: number[] = [];
    try {
      while (true) {
        const pageStart = performance.now();
        const result = await reconcileModelCallFacts(repairClient.db, {
          limit: pageSize,
          workspaceId: seeded.workspaceId,
          since: new Date("2026-08-15"),
          until: new Date("2026-08-16"),
        });
        pageTimes.push(performance.now() - pageStart);
        pages++;
        repaired += result.repaired;
        missing += result.missing;
        if (!result.truncated) break;
        if (pages > Math.ceil(size / pageSize) * 2 + 2)
          throw new Error("Event page did not advance");
      }
    } finally {
      await repairClient.close();
    }
    expect(missing).toBe(gaps);
    expect(repaired).toBe(gaps);
    const eventPages = repairStatements.filter((s) =>
      s.query.includes("payload->>'sourceKey' as source_key,turn_association"),
    );
    expect(eventPages.length).toBeLessThanOrEqual(Math.ceil(size / pageSize));
    expect(eventPages.length).toBeGreaterThan(0);
    if (process.env.INSIGHTS_EXPLAIN === "1")
      console.log("paged reconciliation", {
        rows: size,
        gaps,
        pages,
        eventPages: eventPages.length,
        repaired,
        wallMs: performance.now() - repairStart,
        maxPageMs: Math.max(...pageTimes),
        p95PageMs: [...pageTimes].sort((a, b) => a - b)[Math.floor(pageTimes.length * 0.95)],
        statements: repairStatements.length,
        indexes: Array.from(
          await shared.admin`select relname,pg_relation_size(oid)::text bytes from pg_class
          where relname in ('usage_events_workspace_metric_page_idx','usage_events_workspace_metric_source_idx','session_events_model_fact_page_idx')`,
          (row) => ({ name: row.relname, bytes: row.bytes }),
        ),
      });
    if (process.env.INSIGHTS_EXPLAIN === "1") {
      await shared.admin`delete from model_call_facts where turn_id=${turnId} and source_key in
        (select 'scale-' || n from generate_series(${size - gaps + 1}::integer,${size}::integer) g(n))`;
      await shared.admin`delete from model_call_fact_reconciliation_progress where workspace_id=${seeded.workspaceId}`;
      const start = performance.now();
      const times: number[] = [];
      let total = 0;
      const signal = new AbortController().signal;
      const deadlineAtMs = Date.now() + 180000;
      for (;;) {
        const pageStart = performance.now();
        const result = await reconcileModelCallFacts(client.db, {
          limit: pageSize,
          workspaceId: seeded.workspaceId,
          since: new Date("2026-08-15"),
          until: new Date("2026-08-16"),
          signal,
          deadlineAtMs,
        });
        times.push(performance.now() - pageStart);
        total += result.repaired;
        if (!result.truncated) break;
        if (times.length > Math.ceil(size / pageSize) * 2 + 2)
          throw new Error("Lifetime scan did not advance");
      }
      expect(total).toBe(gaps);
      console.log("production-adapter full repair", {
        rows: size,
        gaps,
        repaired: total,
        pages: times.length,
        wallMs: performance.now() - start,
        maxPageMs: Math.max(...times),
        p95PageMs: [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)],
      });
      const completeStart = performance.now();
      let completePages = 0;
      for (;;) {
        const result = await reconcileModelCallFacts(client.db, {
          limit: pageSize,
          workspaceId: seeded.workspaceId,
          since: new Date("2026-08-15"),
          until: new Date("2026-08-16"),
          signal,
          deadlineAtMs,
        });
        expect(result.repaired).toBe(0);
        completePages++;
        if (!result.truncated) break;
        if (completePages > Math.ceil(size / pageSize) + 1)
          throw new Error("Complete ledger did not advance");
      }
      console.log("production-adapter no-gap sweep", {
        rows: size,
        pages: completePages,
        wallMs: performance.now() - completeStart,
      });
    }
    // A second run sees only newly committed arrivals, even if their logical
    // timestamps are behind the completed checkpoint. Use live triggers here.
    const newRows = 1000;
    const ingestStart = performance.now();
    await shared.admin`insert into usage_events (account_id,workspace_id,event_type,quantity,unit,
      source_resource_type,source_resource_id,session_id,turn_id,idempotency_key,occurred_at)
      select ${seeded.accountId},${seeded.workspaceId},'model.cost',1,'usd_micros',
        'model_response',${turnId}||':incremental-'||n,${seeded.sharedSessionId},${turnId},
        'incremental-'||n,'2026-08-15'::timestamptz from generate_series(1,${newRows}) g(n)`;
    const ingestMs = performance.now() - ingestStart;
    await shared.admin`insert into model_call_facts (account_id,workspace_id,session_id,turn_id,source_key,
      provider,provider_api,model,billing_path,priced_cost_micros,occurred_at)
      select ${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},${turnId},
        'incremental-'||n,'openai','responses','fixture','opengeni_credits',1,'2026-08-15'::timestamptz
      from generate_series(1,${newRows}) g(n)`;
    const incrementalStatements: CapturedStatement[] = [];
    const incrementalClient = instrumentedDb(incrementalStatements);
    const incrementalStart = performance.now();
    let incrementalPages = 0;
    try {
      for (;;) {
        const result = await reconcileModelCallFacts(incrementalClient.db, {
          workspaceId: seeded.workspaceId,
          since: new Date("2026-08-15"),
          until: new Date("2026-08-16"),
          limit: pageSize,
        });
        expect(result.repaired).toBe(0);
        incrementalPages++;
        if (!result.truncated) break;
        if (incrementalPages > 3) throw new Error("Incremental scan revisited history");
      }
    } finally {
      await incrementalClient.close();
    }
    expect(incrementalPages).toBe(2);
    expect(incrementalStatements.some((s) => s.query.includes("-- model-fact-ledger-page"))).toBe(
      false,
    );
    expect(
      incrementalStatements.some((s) =>
        s.query.includes("payload->>'sourceKey' as source_key,turn_association"),
      ),
    ).toBe(false);
    if (process.env.INSIGHTS_EXPLAIN === "1")
      console.log("incremental after 1000 arrivals", {
        historicalRows: size,
        newRows,
        pages: incrementalPages,
        wallMs: performance.now() - incrementalStart,
        ingestMs,
        statements: incrementalStatements.length,
      });
  }, 180_000);

  test("reads each window once through the scoped projection and aggregates in grouping sets", async () => {
    const source = await Bun.file(
      new URL("../src/insights-model-bundle.ts", import.meta.url),
    ).text();
    expect(source).toContain("workspace_insights_amount_fact_rows");
    expect(source).not.toContain("visible_workspace_insights_model_call_facts");
    expect(source.match(/group by grouping sets/g)).toHaveLength(2);
    // Sessions are joined only for grouped roots and the bounded recent-call
    // rows, never across the whole fact window.
    expect(source).not.toContain("selected_sessions");
    expect(source.match(/left join sessions root/g)).toHaveLength(3);
    expect(source.match(/left join sessions session/g)).toHaveLength(1);
    expect(source).not.toContain("count(distinct id)");
    expect(source).toContain("count(*) filter (where first_source)");
  });

  test("counts each fact once per source while preserving sums, including DB-accepted null sources", async () => {
    if (!shared) return;
    const entries = [
      {
        source: "company_profile",
        items: 1,
        utf8Bytes: 80,
        estimatedTokens: 20,
      },
      { source: null, items: 2, utf8Bytes: 40, estimatedTokens: 10 },
      { source: null, items: 3, utf8Bytes: 60, estimatedTokens: 15 },
    ];
    const [valid] = await shared.admin`
      select opengeni_private.model_context_contributions_valid(${shared.admin.json(entries)}) as accepted,
        opengeni_private.model_context_contributions_valid(${shared.admin.json([entries[0]!, entries[0]!])}) as duplicate_named`;
    expect(valid?.accepted).toBe(true);
    expect(valid?.duplicate_named).toBe(false);
    const [constraint] = await shared.admin`
      select convalidated from pg_constraint
      where conrelid = 'model_call_facts'::regclass
        and conname = 'model_call_facts_context_contributions_check'`;
    expect(constraint?.convalidated).toBe(true);

    // Include repeated sources across facts, empty coverage, and unknown coverage.
    const rows = await shared.admin`
      with facts(id, context_contributions) as (values
        (1, ${shared.admin.json(entries)}::jsonb),
        (2, ${shared.admin.json(entries)}::jsonb),
        (3, '[]'::jsonb), (4, null::jsonb)
      ), legacy as (
        select entry->>'source' as source,
          sum((entry->>'items')::bigint)::bigint as items,
          sum((entry->>'utf8Bytes')::bigint)::bigint as utf8_bytes,
          sum((entry->>'estimatedTokens')::bigint)::bigint as estimated_tokens,
          count(distinct id)::bigint as calls
        from facts cross join lateral jsonb_array_elements(context_contributions) entry
        group by entry->>'source'
      ), candidate as (
        select contribution.entry->>'source' as source,
          sum((contribution.entry->>'items')::bigint)::bigint as items,
          sum((contribution.entry->>'utf8Bytes')::bigint)::bigint as utf8_bytes,
          sum((contribution.entry->>'estimatedTokens')::bigint)::bigint as estimated_tokens,
          count(*) filter (where case
            when contribution.entry->>'source' is not null then true
            else not exists (
              select 1 from jsonb_array_elements(context_contributions)
                with ordinality earlier(entry, ordinal)
              where earlier.ordinal < contribution.ordinal
                and earlier.entry->>'source' is null
            ) end)::bigint as calls
        from facts cross join lateral jsonb_array_elements(context_contributions)
          with ordinality contribution(entry, ordinal)
        group by contribution.entry->>'source'
      )
      (select * from legacy except all select * from candidate)
      union all
      (select * from candidate except all select * from legacy)`;
    expect(rows).toHaveLength(0);
  });

  test("matches the legacy helpers for shared/private visibility, filters, and UTC buckets", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const cases: Array<{
      subjectId: string;
      input: WorkspaceInsightsModelBundleInput;
      expectedDataThrough: string;
    }> = [
      {
        subjectId: seeded.ownerSubjectId,
        input: seeded.input,
        expectedDataThrough: "2026-08-14T12:00:01.000Z",
      },
      {
        subjectId: seeded.ownerSubjectId,
        input: {
          ...seeded.input,
          granularity: "hour",
          provider: "openai",
          model: "gpt-bundle",
        },
        expectedDataThrough: "2026-08-14T12:00:01.000Z",
      },
      {
        subjectId: `user:${crypto.randomUUID()}`,
        input: seeded.input,
        expectedDataThrough: "2026-08-12T10:30:01.000Z",
      },
    ];
    for (const testCase of cases) {
      const [legacy, bundled] = await withSessionRlsActorContext(
        { subjectId: testCase.subjectId },
        async () =>
          await Promise.all([
            legacyModelBundle(client!.db, testCase.input),
            readWorkspaceInsightsModelBundle(client!.db, testCase.input),
          ]),
      );
      const complete = await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        legacyModelBundle(client!.db, testCase.input),
      );
      expect(comparable(bundled)).toEqual(
        comparable({
          ...legacy,
          modelRows: complete.modelRows,
          priorModelRows: complete.priorModelRows,
          factBuckets: complete.factBuckets,
        }),
      );
      expect(bundled.driverGroups).toBe(legacy.rootDrivers.length);
      expect(bundled.driversTruncated).toBe(false);
      expect(bundled.facetsTruncated).toBe(false);
      expect(bundled.recentCallsTruncated).toBe(false);
      expect(bundled.dataThrough?.toISOString()).toBe(testCase.expectedDataThrough);
      if (testCase.input.provider || testCase.input.model) {
        expect(bundled.facets).toEqual([
          { provider: "azure", model: "azure-bundle" },
          { provider: "openai", model: "gpt-bundle" },
        ]);
      }
    }
  });

  test("scopes a session drilldown while keeping facets and freshness workspace-wide", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const bundled = await withSessionRlsActorContext(
      { subjectId: seeded.ownerSubjectId },
      async () =>
        await readWorkspaceInsightsModelBundle(client!.db, {
          ...seeded.input,
          sessionId: seeded.sharedSessionId,
        }),
    );
    expect(bundled.recentCalls).toHaveLength(2);
    expect(bundled.recentCalls.every((call) => call.sessionId === seeded.sharedSessionId)).toBe(
      true,
    );
    expect(bundled.rootDrivers.length).toBeGreaterThan(0);
    expect(
      bundled.rootDrivers.every((driver) => driver.rootSessionId === seeded.sharedSessionId),
    ).toBe(true);
    expect(bundled.facets).toEqual([
      { provider: "azure", model: "azure-bundle" },
      { provider: "openai", model: "gpt-bundle" },
    ]);
    expect(bundled.dataThrough?.toISOString()).toBe("2026-08-14T12:00:01.000Z");
  });

  test("scopes a root drilldown through the same private-session visibility", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const scoped = (subjectId: string) =>
      withSessionRlsActorContext(
        { subjectId },
        async () =>
          await readWorkspaceInsightsModelBundle(client!.db, {
            ...seeded.input,
            rootSessionId: seeded.privateSessionId,
          }),
      );
    const owner = await scoped(seeded.ownerSubjectId);
    expect(owner.recentCalls.map((call) => call.sessionId)).toEqual([
      seeded.privateSessionId,
      seeded.privateSessionId,
    ]);
    expect(owner.rootDrivers.map((driver) => driver.rootSessionId)).toEqual([
      seeded.privateSessionId,
    ]);
    expect(owner.priorRootDrivers.map((driver) => driver.totalTokens)).toEqual([20]);

    const outsider = await scoped(`user:${crypto.randomUUID()}`);
    expect(outsider.recentCalls).toEqual([]);
    expect(outsider.rootDrivers).toEqual([]);
    expect(outsider.modelRows).toEqual([]);
    expect(outsider.priorModelRows).toEqual([]);
    // Facets stay workspace-wide but still exclude the outsider's invisible session.
    expect(outsider.facets).toEqual([
      { provider: "azure", model: "azure-bundle" },
      { provider: "openai", model: "gpt-bundle" },
    ]);
  });

  test("groups every root by its current project and folds the tail exactly", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const fileInNewProject = async (name: string, sessionId: string) => {
      const channel = await createChannel(client!.db, {
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
        name,
      });
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        setSessionChannel(client!.db, {
          workspaceId: seeded.workspaceId,
          sessionId,
          channelId: channel.id,
        }),
      );
    };
    await fileInNewProject("Billing", seeded.sharedSessionId);
    const read = (subjectId: string) =>
      withSessionRlsActorContext({ subjectId }, () =>
        readWorkspaceInsightsModelBundle(client!.db, seeded.input),
      );

    const owner = await read(seeded.ownerSubjectId);
    expect(
      owner.projects.map((row) => [
        row.kind,
        row.name,
        row.rootSessions,
        row.calls,
        row.totalTokens,
      ]),
    ).toEqual([
      ["project", "Billing", 1, 2, 160],
      ["unfiled", null, 1, 2, 75],
    ]);
    expect(owner.projects.map((row) => row.pricedCostMicros)).toEqual([200, 375]);

    const outsider = await read(`user:${crypto.randomUUID()}`);
    expect(outsider.projects.map((row) => [row.kind, row.name, row.calls])).toEqual([
      ["project", "Billing", 2],
      ["unavailable", null, 2],
    ]);

    // One more filed root than the named limit leaves two projects in `other`.
    for (let index = 0; index < INSIGHTS_PROJECT_LIMIT + 1; index += 1) {
      const session = await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        createSession(client!.db, {
          accountId: seeded.accountId,
          workspaceId: seeded.workspaceId,
          initialMessage: `project ${index}`,
          resources: [],
          metadata: {},
          model: "fixture-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: seeded.ownerSubjectId },
          createdByContext: {},
        }),
      );
      await fileInNewProject(`Project ${index}`, session.id);
      await shared.admin`
        insert into model_call_facts (
          account_id, workspace_id, session_id, turn_id, source_key, provider,
          provider_api, model, billing_path, input_tokens, output_tokens,
          cached_tokens, total_tokens, priced_cost_micros, occurred_at
        ) values (
          ${seeded.accountId}, ${seeded.workspaceId}, ${session.id}, ${crypto.randomUUID()},
          ${`project-${index}-${crypto.randomUUID()}`}, 'openai', 'responses', 'gpt-bundle',
          'opengeni_credits', 10, 1, 4, ${100 + index}, 7, '2026-08-15T00:00:00.000Z'
        )`;
    }
    const folded = await read(seeded.ownerSubjectId);
    const named = folded.projects.filter((row) => row.kind === "project");
    const other = folded.projects.filter((row) => row.kind === "other");
    expect(named).toHaveLength(INSIGHTS_PROJECT_LIMIT);
    expect(folded.projects.map((row) => row.kind).slice(-2)).toEqual(["other", "unfiled"]);
    expect(other).toHaveLength(1);
    expect(other[0]?.projects).toBe(2);
    expect(other[0]?.name).toBeNull();
    const sum = (
      rows: Array<{
        totalTokens: number;
        pricedCostMicros: number;
        calls: number;
      }>,
    ) =>
      rows.reduce(
        (total, row) => ({
          totalTokens: total.totalTokens + row.totalTokens,
          pricedCostMicros: total.pricedCostMicros + row.pricedCostMicros,
          calls: total.calls + row.calls,
        }),
        { totalTokens: 0, pricedCostMicros: 0, calls: 0 },
      );
    expect(sum(folded.projects)).toEqual(sum(folded.modelRows));
  });

  test("backfill preserves free external billing when the live fact write was lost", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const turnId = crypto.randomUUID();
    const secondTurnId = crypto.randomUUID();
    const sourceKey = `free-backfill-a-${crypto.randomUUID()}`;
    const secondSourceKey = `free-backfill-b-${crypto.randomUUID()}`;
    const occurredAt = new Date();
    const sourceResourceId = `${turnId}:${sourceKey}`;
    const secondSourceResourceId = `${secondTurnId}:${secondSourceKey}`;

    await shared.admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, latency_mode, sandbox_backend, resources, tools,
        metadata, started_at, finished_at
      ) values (
        ${turnId}, ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
        ${crypto.randomUUID()}, ${`session-${seeded.sharedSessionId}`}, 'completed', 1,
        'free external model backfill fixture', 'free-deployment-model',
        'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        ${occurredAt}, ${occurredAt}
      ), (
        ${secondTurnId}, ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
        ${crypto.randomUUID()}, ${`session-${seeded.sharedSessionId}`}, 'completed', 2,
        'second free external model backfill fixture', 'free-deployment-model',
        'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        ${occurredAt}, ${occurredAt}
      )`;

    // Absence of the model_call_facts row simulates the worker's intentionally
    // swallowed live fact-write failure. The billing ledger still has both a
    // token-cap row and the zero-cost marker for this deployment-funded call.
    await shared.admin`
      insert into usage_events (
        account_id, workspace_id, event_type, quantity, unit,
        source_resource_type, source_resource_id, session_id, turn_id,
        idempotency_key, occurred_at
      ) values
        (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.tokens', 1500, 'tokens',
          'model_response', ${sourceResourceId}, ${seeded.sharedSessionId}, ${turnId},
          ${`usage:model.tokens:${sourceResourceId}`}, ${occurredAt}
        ),
        (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.cost', 0, 'usd_micros',
          'model_response', ${sourceResourceId}, ${seeded.sharedSessionId}, ${turnId},
          ${`usage:model.cost:${sourceResourceId}`}, ${occurredAt}
        ),
        (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.tokens', 300, 'tokens',
          'model_response', ${secondSourceResourceId}, ${seeded.sharedSessionId}, ${secondTurnId},
          ${`usage:model.tokens:${secondSourceResourceId}`}, ${occurredAt}
        ),
        (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.cost', 0, 'usd_micros',
          'model_response', ${secondSourceResourceId}, ${seeded.sharedSessionId}, ${secondTurnId},
          ${`usage:model.cost:${secondSourceResourceId}`}, ${occurredAt}
        )`;
    await shared.admin`
      insert into session_events (
        account_id, workspace_id, session_id, turn_id, turn_association,
        sequence, type, payload, occurred_at
      ) values (
        ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${turnId},
        'current',
        (
          select coalesce(max(sequence), 0) + 1
          from session_events
          where workspace_id = ${seeded.workspaceId}
            and session_id = ${seeded.sharedSessionId}
        ),
        'agent.model.usage',
        ${shared.admin.json({
          sourceKey,
          provider: "workspace-gateway",
          upstreamProvider: "anthropic",
          providerApi: "responses",
          model: "free-deployment-model",
          billingPath: "external",
          inputTokens: 1000,
          outputTokens: 500,
          timing: {
            preDispatchMs: 12,
            timeToFirstTokenMs: 340,
            timeToFirstTextMs: 910,
            durationMs: 4_200,
          },
        })},
        ${occurredAt}::timestamptz + interval '0.000123 seconds'
      )`;
    await shared.admin`
      insert into session_events (
        account_id, workspace_id, session_id, turn_id, turn_association,
        sequence, type, payload, occurred_at
      ) values (
        ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${secondTurnId},
        'current',
        (
          select coalesce(max(sequence), 0) + 1
          from session_events
          where workspace_id = ${seeded.workspaceId}
            and session_id = ${seeded.sharedSessionId}
        ),
        'agent.model.usage',
        ${shared.admin.json({
          sourceKey: secondSourceKey,
          provider: "openai",
          upstreamProvider: "../../not-a-provider",
          providerApi: "responses",
          model: "free-deployment-model",
          billingPath: "external",
          inputTokens: 200,
          outputTokens: 100,
          // Malformed timing never fails the repair; it is stored as unknown.
          timing: { preDispatchMs: -1, timeToFirstTokenMs: 1.5, durationMs: "slow" },
        })},
        ${occurredAt}::timestamptz + interval '0.000456 seconds'
      )`;

    const result = await backfillModelCallFactsFromSessionEvents(client.db, {
      workspaceId: seeded.workspaceId,
      since: new Date(occurredAt.getTime() - 60_000),
      until: new Date(occurredAt.getTime() + 60_000),
      limit: 10,
      batchSize: 1,
    });
    expect(result).toEqual({ considered: 2, upserted: 2 });

    const rows = await shared.admin<
      Array<{
        sourceKey: string;
        provider: string;
        billingPath: string;
        pricedCostMicros: number;
        totalTokens: number | null;
        timing: Array<number | null>;
      }>
    >`
      select
        source_key as "sourceKey",
        provider,
        billing_path as "billingPath",
        priced_cost_micros::int as "pricedCostMicros",
        total_tokens::int as "totalTokens",
        jsonb_build_array(pre_dispatch_ms, time_to_first_token_ms, time_to_first_text_ms, duration_ms)
          as timing
      from model_call_facts
      where workspace_id = ${seeded.workspaceId}
        and turn_id in (${turnId}, ${secondTurnId})
      order by source_key`;
    expect(Array.from(rows)).toEqual([
      {
        sourceKey,
        provider: "anthropic",
        billingPath: "external",
        pricedCostMicros: 0,
        totalTokens: 1500,
        timing: [12, 340, 910, 4_200],
      },
      {
        sourceKey: secondSourceKey,
        provider: "openai",
        billingPath: "external",
        pricedCostMicros: 0,
        totalTokens: 300,
        timing: [null, null, null, null],
      },
    ]);
  });

  test("reconciler rebuilds exactly the charged ledger calls that lack a fact", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const occurredAt = new Date("2026-08-15T10:00:00.000Z");
    // Source keys are turn-scoped: a mixed-turn queue batch must never consume
    // another turn's key merely because their provider keys happen to match.
    const sharedSourceKey = `reconcile-${crypto.randomUUID()}`;
    const calls = ["with-event", "without-event", "already-faceted"].map((label, index) => ({
      label,
      turnId: crypto.randomUUID(),
      sourceKey: sharedSourceKey,
      costMicros: [1200, 800, 500][index]!,
      // The unrepairable call is oldest. Durable page progress must reach the
      // repairable call behind it without ranking the entire window first.
      position: [2, 1, 3][index]!,
    }));
    for (const call of calls) {
      await shared.admin`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, latency_mode, sandbox_backend, resources, tools,
          metadata, started_at, finished_at
        ) values (
          ${call.turnId}, ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
          ${crypto.randomUUID()}, ${`session-${seeded.sharedSessionId}`}, 'completed',
          ${100 + call.position}, 'reconcile fixture', 'gpt-bundle',
          'medium', 'standard', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
          ${occurredAt}, ${occurredAt}
        )`;
      const sourceResourceId = `${call.turnId}:${call.sourceKey}`;
      await shared.admin`
        insert into usage_events (
          account_id, workspace_id, event_type, quantity, unit,
          source_resource_type, source_resource_id, session_id, turn_id,
          idempotency_key, occurred_at
        ) values (
          ${seeded.accountId}, ${seeded.workspaceId}, 'model.cost', ${call.costMicros}, 'usd_micros',
          'model_response', ${sourceResourceId}, ${seeded.sharedSessionId}, ${call.turnId},
          ${`usage:model.cost:${sourceResourceId}`},
          ${occurredAt}::timestamptz + ${`${call.position} minutes`}::interval
        )`;
      await shared.admin`insert into credit_ledger_entries
        (account_id, workspace_id, type, amount_micros, source_type, source_id, idempotency_key, occurred_at)
        values (${seeded.accountId}, ${seeded.workspaceId}, 'usage_debit', ${-call.costMicros},
          'model_response', ${sourceResourceId}, ${`debit:${sourceResourceId}`}, ${occurredAt})`;
    }
    for (const call of [calls[0]!, calls[2]!]) {
      await shared.admin`
        insert into session_events (
          account_id, workspace_id, session_id, turn_id, turn_association,
          sequence, type, payload, occurred_at
        ) values (
          ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${call.turnId},
          'current',
          (
            select coalesce(max(sequence), 0) + 1
            from session_events
            where workspace_id = ${seeded.workspaceId}
              and session_id = ${seeded.sharedSessionId}
          ),
          'agent.model.usage',
          ${shared.admin.json({
            sourceKey: call.sourceKey,
            provider: "openai",
            providerApi: "responses",
            model: "gpt-bundle",
            billingPath: "opengeni_credits",
            inputTokens: 100,
            outputTokens: 20,
          })},
          ${occurredAt}
        )`;
    }
    await shared.admin`
      insert into model_call_facts (
        account_id, workspace_id, session_id, turn_id, source_key, provider,
        provider_api, model, billing_path, priced_cost_micros, occurred_at
      ) values (
        ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${calls[2]!.turnId},
        ${calls[2]!.sourceKey}, 'openai', 'responses', 'gpt-bundle', 'opengeni_credits', 500,
        ${occurredAt}::timestamptz + interval '3 milliseconds'
      )`;
    const window = {
      workspaceId: seeded.workspaceId,
      since: new Date("2026-08-15T00:00:00.000Z"),
      until: new Date("2026-08-16T00:00:00.000Z"),
    };

    const ledgerState = async () =>
      await shared!.admin`
        select 'usage' as source, count(*)::text as rows,
          md5(coalesce(string_agg(to_jsonb(row)::text, '' order by row.id), '')) as fingerprint
        from usage_events row where account_id = ${seeded.accountId}
        union all
        select 'debits', count(*)::text,
          md5(coalesce(string_agg(to_jsonb(row)::text, '' order by row.id), ''))
        from credit_ledger_entries row where account_id = ${seeded.accountId}
        order by source`;
    const unchanged = await ledgerState();

    const bounded = await reconcileModelCallFacts(client.db, {
      ...window,
      limit: 1,
    });
    expect(bounded).toEqual({
      missing: 0,
      repaired: 0,
      unrepaired: 0,
      truncated: true,
    });

    const stop = new AbortController();
    const stopped = new Error("stop this reconciliation page");
    let settledBeforeStop = 0;
    let interrupted = false;
    for (let attempt = 0; attempt < 10 && !interrupted; attempt++) {
      const before =
        await shared.admin`select checkpoint from model_call_fact_reconciliation_progress where workspace_id=${seeded.workspaceId}`;
      try {
        const result = await reconcileModelCallFactPage(
          client.db,
          { ...window, signal: stop.signal },
          async (scoped, _workspace, event) => {
            await scoped.insert(schema.modelCallFacts).values({
              accountId: event.accountId,
              workspaceId: event.workspaceId,
              sessionId: event.sessionId,
              turnId: event.turnId!,
              sourceKey: (event.payload as { sourceKey: string }).sourceKey,
              provider: "openai",
              providerApi: "responses",
              model: "fixture",
              billingPath: "opengeni_credits",
              pricedCostMicros: 0,
              occurredAt: event.occurredAt,
            });
            stop.abort(stopped);
            return true;
          },
        );
        settledBeforeStop += result.missing;
      } catch (error) {
        expect(error).toBe(stopped);
        interrupted = true;
        expect(
          await shared.admin`select checkpoint from model_call_fact_reconciliation_progress where workspace_id=${seeded.workspaceId}`,
        ).toEqual(before);
      }
    }
    expect(interrupted).toBe(true);
    expect(
      (
        await shared.admin`select id from model_call_facts where workspace_id=${seeded.workspaceId} and turn_id=${calls[0]!.turnId}`
      ).length,
    ).toBe(0);

    const finishSweep = async (db: Database = client!.db) => {
      const total = { missing: 0, repaired: 0, unrepaired: 0, truncated: false };
      for (let page = 0; page < 50; page++) {
        const result = await reconcileModelCallFacts(db, {
          ...window,
          signal: new AbortController().signal,
          deadlineAtMs: Date.now() + 5000,
        });
        total.missing += result.missing;
        total.repaired += result.repaired;
        total.unrepaired += result.unrepaired;
        if (!result.truncated) return total;
      }
      throw new Error("Reconciliation failed to advance");
    };
    // No process-local cursor: a new pool must resume the committed page.
    const restarted = createDb(shared.appUrl, { max: 2 });
    try {
      expect(await finishSweep(restarted.db)).toEqual({
        missing: 2 - settledBeforeStop,
        repaired: 1,
        unrepaired: 1 - settledBeforeStop,
        truncated: false,
      });
    } finally {
      await restarted.close();
    }
    const rebuilt = await shared.admin`
      select priced_cost_micros::text, billing_path, total_tokens::text
      from model_call_facts
      where workspace_id = ${seeded.workspaceId} and turn_id = ${calls[0]!.turnId}`;
    expect([...rebuilt]).toEqual([
      {
        priced_cost_micros: "1200",
        billing_path: "opengeni_credits",
        total_tokens: "120",
      },
    ]);

    const again = await finishSweep();
    expect(again).toEqual({
      missing: 0,
      repaired: 0,
      unrepaired: 0,
      truncated: false,
    });
    expect(await ledgerState()).toEqual(unchanged);

    // No repeated polling of the missing event. Its eventual commit reopens
    // the exact key, even with an old timestamp and a completed checkpoint.
    const delayed = calls[1]!;
    await shared.admin`insert into session_events
      (account_id,workspace_id,session_id,turn_id,turn_association,sequence,type,payload,occurred_at)
      values (${seeded.accountId},${seeded.workspaceId},${seeded.sharedSessionId},${delayed.turnId},
        'current',(select max(sequence)+1 from session_events where session_id=${seeded.sharedSessionId}),
        'agent.model.usage',${shared.admin.json({ sourceKey: delayed.sourceKey, provider: "openai", providerApi: "responses", model: "fixture" })},${occurredAt})`;
    expect(await finishSweep()).toEqual({
      missing: 1,
      repaired: 1,
      unrepaired: 0,
      truncated: false,
    });
    expect(await ledgerState()).toEqual(unchanged);

    // Historical empty source keys are outside the unique current-usage index.
    // Two matching events must still represent only one missing ledger call.
    const emptySource = `${calls[0]!.turnId}:`;
    await shared.admin`
      insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
        source_resource_type, source_resource_id, session_id, turn_id, idempotency_key, occurred_at)
      values (${seeded.accountId}, ${seeded.workspaceId}, 'model.cost', 0, 'usd_micros',
        'model_response', ${emptySource}, ${seeded.sharedSessionId}, ${calls[0]!.turnId},
        ${`empty:${emptySource}`}, ${occurredAt})`;
    for (let n = 0; n < 2; n += 1) {
      await shared.admin`
        insert into session_events (account_id, workspace_id, session_id, turn_id,
          turn_association, sequence, type, payload, occurred_at)
        values (${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
          ${calls[0]!.turnId}, 'current',
          (select coalesce(max(sequence), 0) + 1 from session_events
            where workspace_id = ${seeded.workspaceId} and session_id = ${seeded.sharedSessionId}),
          'agent.model.usage', '{"sourceKey":""}'::jsonb, ${occurredAt})`;
    }
    expect(await finishSweep()).toEqual({
      missing: 1,
      repaired: 0,
      unrepaired: 1,
      truncated: false,
    });
  });

  test("a repaired Codex fact names the attempt's canonical core connection, through its legacy alias", async () => {
    if (!shared || !client) return;
    const seeded = await fixture();
    const occurredAt = new Date("2026-08-20T10:00:00.000Z");
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const sourceKey = `codex-repair-${crypto.randomUUID()}`;
    const legacyId = crypto.randomUUID();
    const [connection] = await shared.admin<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind, provider_account_id
      ) values (
        ${seeded.accountId}, 'codex', 'subscription', 'ciphertext', 'shared', 'organization',
        ${`chatgpt-repair-${crypto.randomUUID()}`}
      ) returning id::text as id`;
    await shared.admin`
      insert into subscription_connection_aliases (account_id, provider, alias_connection_id, connection_id)
      values (${seeded.accountId}, 'codex', ${legacyId}, ${connection!.id})`;
    await shared.admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status,
        position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, resources, tools,
        metadata, started_at, finished_at
      ) values (
        ${turnId}, ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
        ${crypto.randomUUID()}, ${`session-${seeded.sharedSessionId}`}, 'completed', 900,
        'codex repair fixture', 'codex/gpt-5.5', 'medium', 'standard', 'none', '[]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, ${occurredAt}, ${occurredAt}
      )`;
    await shared.admin.begin(async (tx) => {
      await tx`alter table session_turn_attempts disable trigger user`;
      await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation, state,
        temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies, authority_epoch, authority_visibility
      ) select
        ${attemptId}, ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${turnId},
        1, 'running', ${`session-${seeded.sharedSessionId}`}, 'fixture-run', 'fixture-activity', 0,
        '{}'::jsonb, session.authority_epoch, session.visibility
      from sessions session where session.id = ${seeded.sharedSessionId}`;
      await tx`alter table session_turn_attempts enable trigger user`;
    });
    const sourceResourceId = `${turnId}:${sourceKey}`;
    await shared.admin`
      insert into usage_events (
        account_id, workspace_id, event_type, quantity, unit, source_resource_type,
        source_resource_id, session_id, turn_id, idempotency_key, occurred_at
      ) values (
        ${seeded.accountId}, ${seeded.workspaceId}, 'model.cost', 0, 'usd_micros', 'model_response',
        ${sourceResourceId}, ${seeded.sharedSessionId}, ${turnId},
        ${`usage:model.cost:${sourceResourceId}`}, ${occurredAt}
      )`;
    // A historical repair fixture: the attempt closed long ago, so the live
    // attempt-admission triggers are bypassed only for these seeded rows.
    await shared.admin.begin(async (tx) => {
      await tx`alter table session_events disable trigger user`;
      for (const [type, payload, at] of [
        ["codex.credential.selected", { credentialId: legacyId, strategy: "spread" }, occurredAt],
        [
          "agent.model.usage",
          {
            sourceKey,
            provider: "codex-subscription",
            providerApi: "responses",
            model: "codex/gpt-5.5",
            billingPath: "external",
            inputTokens: 10,
            outputTokens: 2,
          },
          new Date(occurredAt.getTime() + 1_000),
        ],
      ] as const) {
        await tx`
        insert into session_events (
          account_id, workspace_id, session_id, turn_id, turn_attempt_id, turn_association,
          sequence, type, payload, occurred_at
        ) values (
          ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId}, ${turnId},
          ${attemptId}, 'current',
          (select coalesce(max(sequence), 0) + 1 from session_events
            where workspace_id = ${seeded.workspaceId} and session_id = ${seeded.sharedSessionId}),
          ${type}, ${tx.json(payload)}, ${at}
        )`;
      }
      await tx`set constraints all immediate`;
      await tx`alter table session_events enable trigger user`;
    });
    const result = await reconcileModelCallFacts(client.db, {
      workspaceId: seeded.workspaceId,
      since: new Date("2026-08-20T00:00:00.000Z"),
      until: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ repaired: 1 });
    const [fact] = await shared.admin`
      select connection_id::text as connection_id, billing_path from model_call_facts
      where turn_id = ${turnId} and source_key = ${sourceKey}`;
    expect(fact).toEqual({
      connection_id: connection!.id,
      billing_path: "external",
    });
  });

  test("reduces model sources from nine legacy reads to two by default and three with filtered facets", async () => {
    if (!shared) return;
    const seeded = await fixture();
    const legacyStatements: CapturedStatement[] = [];
    const legacyDb = instrumentedDb(legacyStatements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        legacyModelBundle(legacyDb.db, seeded.input),
      );
    } finally {
      await legacyDb.close();
    }
    const bundledStatements: CapturedStatement[] = [];
    const bundledDb = instrumentedDb(bundledStatements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        readWorkspaceInsightsModelBundle(bundledDb.db, seeded.input),
      );
    } finally {
      await bundledDb.close();
    }

    const legacySource = "visible_workspace_insights_model_call_facts";
    const source = "workspace_insights_amount_fact_rows";
    const legacyInvocations = legacyStatements.reduce(
      (total, statement) =>
        total + (statement.query.match(new RegExp(legacySource, "g"))?.length ?? 0),
      0,
    );
    const bundleQueries = bundledStatements.filter((statement) => statement.query.includes(source));
    const bundledInvocations = bundleQueries.reduce(
      (total, statement) => total + (statement.query.match(new RegExp(source, "g"))?.length ?? 0),
      0,
    );
    expect(legacyInvocations).toBe(9);
    expect(bundleQueries).toHaveLength(1);
    expect(bundledInvocations).toBe(2);

    const filteredStatements: CapturedStatement[] = [];
    const filteredDb = instrumentedDb(filteredStatements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        readWorkspaceInsightsModelBundle(filteredDb.db, {
          ...seeded.input,
          provider: "openai",
          model: "gpt-bundle",
        }),
      );
    } finally {
      await filteredDb.close();
    }
    const filteredQueries = filteredStatements.filter((statement) =>
      statement.query.includes(source),
    );
    const filteredInvocations = filteredQueries.reduce(
      (total, statement) => total + (statement.query.match(new RegExp(source, "g"))?.length ?? 0),
      0,
    );
    expect(filteredQueries).toHaveLength(1);
    expect(filteredInvocations).toBe(2);
    const visibleFacetInvocations = filteredQueries.reduce(
      (total, statement) =>
        total + (statement.query.match(/visible_workspace_insights_model_fact_rows/g)?.length ?? 0),
      0,
    );
    expect(visibleFacetInvocations).toBe(1);
    expect(filteredQueries[0]?.query).toContain("::text");
  });

  test("bounds outer session-table lookup loops by result limits, not fact rows", async () => {
    if (!shared) return;
    const seeded = await fixture();
    const sourcePrefix = `insights-session-map-${crypto.randomUUID()}-`;
    const factsPerWindow = 512;
    await shared.admin`
      insert into model_call_facts (
        account_id, workspace_id, session_id, turn_id, source_key, provider,
        provider_api, model, billing_path, input_tokens, output_tokens,
        cached_tokens, total_tokens, priced_cost_micros, occurred_at
      )
      select
        ${seeded.accountId}, ${seeded.workspaceId}, ${seeded.sharedSessionId},
        gen_random_uuid(), ${sourcePrefix} || generated.window_name || '-' || generated.n::text,
        'openai', 'responses', 'gpt-bundle', 'opengeni_credits', 10, 5, 2, 15, 1,
        generated.occurred_at
      from (
        select 'current'::text as window_name, n,
          ${seeded.input.since}::timestamp with time zone + interval '1 minute' as occurred_at
        from generate_series(1, ${factsPerWindow}) generated(n)
        union all
        select 'prior'::text as window_name, n,
          ${seeded.input.priorSince}::timestamp with time zone + interval '1 minute' as occurred_at
        from generate_series(1, ${factsPerWindow}) generated(n)
      ) generated`;

    const statements: CapturedStatement[] = [];
    const capturedDb = instrumentedDb(statements);
    try {
      await withSessionRlsActorContext({ subjectId: seeded.ownerSubjectId }, () =>
        readWorkspaceInsightsModelBundle(capturedDb.db, seeded.input),
      );
    } finally {
      await capturedDb.close();
    }
    const statement = statements.find((candidate) =>
      candidate.query.includes("workspace_insights_amount_fact_rows"),
    );
    expect(statement).toBeDefined();
    if (!statement) return;

    const app = postgres(shared.appUrl, {
      max: 1,
      prepare: false,
      connection: {
        application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
      },
    });
    try {
      const plan = await app.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${seeded.accountId}, true)`;
        await transaction`select set_config('opengeni.workspace_id', ${seeded.workspaceId}, true)`;
        await transaction`select set_config('opengeni.subject_id', ${seeded.ownerSubjectId}, true)`;
        await transaction`select set_config('opengeni.initiating_human_subject_id', '', true)`;
        const rows = await transaction.unsafe<Array<{ "QUERY PLAN": unknown }>>(
          `explain (analyze, buffers, format json) ${statement.query}`,
          statement.parameters,
        );
        return rows[0]?.["QUERY PLAN"];
      });
      const loops = sessionRelationLoops(plan);
      expect(loops.length).toBeGreaterThan(0);
      // The project grouping reads each distinct root once; the fixture has two.
      const rootGroups = 2;
      const resultBound =
        INSIGHTS_RECENT_CALL_LIMIT + 1 + 2 * (INSIGHTS_ROOT_DRIVER_LIMIT + 1) + rootGroups;
      expect(loops.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(resultBound);
      expect(factsPerWindow * 2).toBeGreaterThan(resultBound * 10);
    } finally {
      await app.end();
    }
  });
});
