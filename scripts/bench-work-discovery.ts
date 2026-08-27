#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionDiscoverySummaries,
  updateSessionTitle,
  upsertSessionGoalWithEvent,
  upsertWorkClaim,
  withSessionRlsActorContext,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";

type EvalFixture = {
  schemaVersion: 1;
  textQuery: string;
  expectedTextOrder: Array<{
    label: "title" | "goal" | "claim";
    matchClass: "title" | "goal" | "fuzzy";
  }>;
  promptOnlyLabel: "prompt_only";
  exactSubject: {
    namespace: string;
    type: "pull_request";
    canonicalKey: string;
  };
};

const sessionCount = integerArgument("--sessions", 10_000);
const sampleCount = integerArgument("--samples", 20);
if (sessionCount < 1_000 || sessionCount > 50_000) {
  throw new Error("--sessions must be between 1000 and 50000");
}
if (sampleCount < 5 || sampleCount > 1_000) {
  throw new Error("--samples must be between 5 and 1000");
}
const outputPath = resolve(
  stringArgument("--output") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/work-discovery-${sessionCount}.json`,
);
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/work-discovery-eval.json", import.meta.url), "utf8"),
) as EvalFixture;
if (fixture.schemaVersion !== 1 || fixture.expectedTextOrder.length !== 3) {
  throw new Error("Unsupported work-discovery evaluation fixture");
}

const shared = await acquireSharedTestDatabase(`work-discovery-bench-${sessionCount}`);
if (!shared) {
  throw new Error("PostgreSQL is unavailable for the work-discovery benchmark");
}
let client: ReturnType<typeof createDb> | null = null;
let raw: ReturnType<typeof postgres> | null = null;

try {
  client = createDb(shared.appUrl, { max: 12 });
  raw = postgres(shared.appUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const ownerSubjectId = `benchmark:${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "work-discovery-benchmark",
    accountExternalId: `account-${suffix}`,
    accountName: "Work discovery benchmark",
    workspaceExternalSource: "work-discovery-benchmark",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Work discovery benchmark",
    subjectId: ownerSubjectId,
  });
  const grant = access.workspaceGrants[0];
  if (!grant?.workspaceId) throw new Error("Benchmark workspace bootstrap failed");

  const create = (initialMessage: string) =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage,
      resources: [],
      metadata: {},
      model: "benchmark-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    });

  const titleSession = await create("title target prompt");
  const goalSession = await create("goal target prompt");
  const claimSession = await create("claim target prompt");
  const promptOnlySession = await create(fixture.textQuery);
  await updateSessionTitle(client.db, {
    workspaceId: grant.workspaceId,
    sessionId: titleSession.id,
    title: fixture.textQuery,
    source: "user",
  });
  await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    upsertSessionGoalWithEvent(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: goalSession.id,
      text: fixture.textQuery,
      createdBy: "api",
      actor: "api",
    }),
  );
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: claimSession.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  if (!started.turn) throw new Error("Benchmark claim turn was not initialized");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: claimSession.id,
    workflowId: `session-${claimSession.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Benchmark claim turn was not claimed");
  const claim = await upsertWorkClaim(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: claimSession.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    subjectNamespace: fixture.exactSubject.namespace,
    subjectType: fixture.exactSubject.type,
    canonicalKey: fixture.exactSubject.canonicalKey,
    displayLabel: fixture.textQuery,
    role: "working",
    version: { kind: "pull_request_head", value: "benchmark-head" },
  });

  const generatedCount = sessionCount - 4;
  if (generatedCount > 0) {
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (scopedDb) =>
      scopedDb.execute(sql`
        with generated as materialized (
          select source.i, gen_random_uuid() as id
          from generate_series(1, ${generatedCount}) as source(i)
        )
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, title,
          resources, tools, metadata, model, reasoning_effort, latency_mode,
          sandbox_backend, sandbox_group_id, temporal_workflow_id, tool_policy
        )
        select
          generated.id,
          ${grant.accountId}::uuid,
          ${grant.workspaceId}::uuid,
          'idle',
          'unrelated benchmark prompt ' || generated.i,
          'Unrelated benchmark session ' || generated.i,
          '[]'::jsonb,
          '[]'::jsonb,
          jsonb_build_object('bench_index', generated.i),
          'benchmark-model',
          'medium',
          'standard',
          'none',
          generated.id,
          'session-' || generated.id::text,
          jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
        from generated
      `),
    );

    await shared.admin`
      insert into session_goals (
        account_id, workspace_id, session_id, status, text, created_by, metadata
      )
      select
        session.account_id,
        session.workspace_id,
        session.id,
        'active',
        'Unrelated benchmark goal ' || (session.metadata ->> 'bench_index'),
        'api',
        jsonb_build_object('workDiscoveryBenchmark', true)
      from sessions session
      where session.workspace_id = ${grant.workspaceId}::uuid
        and session.metadata ? 'bench_index'
    `;

    const fillerCapabilityId = crypto.randomUUID();
    await shared.admin.begin(async (transaction) => {
      await transaction`
        insert into session_work_claim_write_capabilities (
          backend_pid, transaction_id, capability_id
        ) values (
          pg_backend_pid(), pg_current_xact_id(), ${fillerCapabilityId}::uuid
        )
      `;
      await transaction`select set_config(
        'opengeni.session_work_claim_write_capability',
        ${fillerCapabilityId},
        true
      )`;
      await transaction`
        insert into session_work_claims (
          id, account_id, workspace_id, session_id, root_session_id,
          subject_namespace, subject_type, canonical_key, subject_digest,
          display_label, role, state, revision, provenance,
          version_kind, version_value, observed_at, created_at, updated_at, settled_at
        )
        select
          gen_random_uuid(),
          session.account_id,
          session.workspace_id,
          session.id,
          session.root_session_id,
          'benchmark',
          'other',
          'benchmark://unrelated/' || (session.metadata ->> 'bench_index'),
          session_work_claim_subject_digest(
            'benchmark',
            'other',
            'benchmark://unrelated/' || (session.metadata ->> 'bench_index')
          ),
          'Unrelated benchmark work ' || (session.metadata ->> 'bench_index'),
          'monitoring',
          'active',
          1,
          'trusted_integration',
          null,
          null,
          transaction_timestamp(),
          transaction_timestamp(),
          transaction_timestamp(),
          null
        from sessions session
        where session.workspace_id = ${grant.workspaceId}::uuid
          and session.metadata ? 'bench_index'
      `;
      await transaction`
        insert into session_work_claim_revisions (
          account_id, workspace_id, claim_id, session_id, root_session_id,
          operation_id, input_hash, mutation_kind, prior_revision, resulting_revision,
          subject_namespace, subject_type, canonical_key, subject_digest, display_label,
          role, state, provenance, version_kind, version_value, observed_at,
          claim_created_at, claim_updated_at, settled_at, actor_kind, actor_subject_id,
          actor_session_id, actor_turn_id, actor_attempt_id, actor_execution_generation,
          reason
        )
        select
          claim.account_id,
          claim.workspace_id,
          claim.id,
          claim.session_id,
          claim.root_session_id,
          gen_random_uuid(),
          encode(sha256(convert_to(
            'work-discovery-benchmark:' || claim.id::text,
            'UTF8'
          )), 'hex'),
          'created',
          null,
          1,
          claim.subject_namespace,
          claim.subject_type,
          claim.canonical_key,
          claim.subject_digest,
          claim.display_label,
          claim.role,
          claim.state,
          claim.provenance,
          claim.version_kind,
          claim.version_value,
          claim.observed_at,
          claim.created_at,
          claim.updated_at,
          claim.settled_at,
          'integration',
          'work-discovery-benchmark',
          null,
          null,
          null,
          null,
          null
        from session_work_claims claim
        where claim.workspace_id = ${grant.workspaceId}::uuid
          and claim.provenance = 'trusted_integration'
          and claim.canonical_key like 'benchmark://unrelated/%'
      `;
      await transaction`
        delete from session_work_claim_write_capabilities capability
        where capability.backend_pid = pg_backend_pid()
          and capability.transaction_id = pg_current_xact_id()
          and capability.capability_id = ${fillerCapabilityId}::uuid
      `;
    });
  }
  await shared.admin`analyze sessions`;
  await shared.admin`analyze session_goals`;
  await shared.admin`analyze session_work_claims`;
  const [corpus] = await shared.admin<
    Array<{
      sessions: number;
      active_goals: number;
      active_claims: number;
      claim_revisions: number;
    }>
  >`
    select
      (select count(*)::integer from sessions
        where workspace_id = ${grant.workspaceId}::uuid) as sessions,
      (select count(*)::integer from session_goals
        where workspace_id = ${grant.workspaceId}::uuid and status = 'active') as active_goals,
      (select count(*)::integer from session_work_claims
        where workspace_id = ${grant.workspaceId}::uuid and state = 'active') as active_claims,
      (select count(*)::integer from session_work_claim_revisions
        where workspace_id = ${grant.workspaceId}::uuid) as claim_revisions
  `;
  if (!corpus) throw new Error("Benchmark corpus counts were unavailable");
  const expectedCorpus = {
    sessions: sessionCount,
    activeGoals: generatedCount + 1,
    activeClaims: generatedCount + 1,
    claimRevisions: generatedCount + 1,
  };
  const corpusFailures = [
    ...(corpus.sessions === expectedCorpus.sessions
      ? []
      : [`session corpus mismatch: ${corpus.sessions} != ${expectedCorpus.sessions}`]),
    ...(corpus.active_goals === expectedCorpus.activeGoals
      ? []
      : [`active-goal corpus mismatch: ${corpus.active_goals} != ${expectedCorpus.activeGoals}`]),
    ...(corpus.active_claims === expectedCorpus.activeClaims
      ? []
      : [
          `active-claim corpus mismatch: ${corpus.active_claims} != ${expectedCorpus.activeClaims}`,
        ]),
    ...(corpus.claim_revisions === expectedCorpus.claimRevisions
      ? []
      : [
          `claim-revision corpus mismatch: ${corpus.claim_revisions} != ${expectedCorpus.claimRevisions}`,
        ]),
  ];

  const labelsById = new Map([
    [titleSession.id, "title"],
    [goalSession.id, "goal"],
    [claimSession.id, "claim"],
    [promptOnlySession.id, "prompt_only"],
  ] as const);
  const textRead = () =>
    listSessionDiscoverySummaries(client!.db, grant.workspaceId!, {
      limit: 20,
      subjectId: ownerSubjectId,
      query: fixture.textQuery,
    });
  const exactRead = () =>
    listSessionDiscoverySummaries(client!.db, grant.workspaceId!, {
      limit: 20,
      subjectId: ownerSubjectId,
      subject: fixture.exactSubject,
    });
  const browseRead = () =>
    listSessionDiscoverySummaries(client!.db, grant.workspaceId!, {
      limit: 20,
      subjectId: ownerSubjectId,
      orderBy: "updatedAt",
    });

  for (let index = 0; index < 3; index += 1) {
    await textRead();
    await exactRead();
    await browseRead();
  }
  const textPage = await textRead();
  const exactPage = await exactRead();
  const scopedPage = await listSessionDiscoverySummaries(client.db, grant.workspaceId, {
    limit: 20,
    subjectId: ownerSubjectId,
    query: fixture.textQuery,
    authorizationScope: {
      kind: "scoped",
      rootSessionIds: [],
      sessionIds: [goalSession.id],
    },
  });
  const textActual = textPage.sessions.map((session) => ({
    label: labelsById.get(session.id) ?? "unexpected",
    matchClass: session.workDiscovery.match?.class ?? "none",
  }));
  const exactActual = exactPage.sessions.map(
    (session) => labelsById.get(session.id) ?? "unexpected",
  );
  const evaluationFailures: string[] = [];
  if (JSON.stringify(textActual) !== JSON.stringify(fixture.expectedTextOrder)) {
    evaluationFailures.push(`text ranking mismatch: ${JSON.stringify(textActual)}`);
  }
  if (textActual.some((entry) => entry.label === fixture.promptOnlyLabel)) {
    evaluationFailures.push("prompt-only text entered discovery results");
  }
  if (JSON.stringify(exactActual) !== JSON.stringify(["claim"])) {
    evaluationFailures.push(`exact subject mismatch: ${JSON.stringify(exactActual)}`);
  }
  if (scopedPage.total !== 1 || scopedPage.sessions[0]?.id !== goalSession.id) {
    evaluationFailures.push("authorization scope was not applied before discovery counts");
  }
  if (
    !textPage.sessions.every(
      (session) =>
        session.workDiscovery.advisoryOnly === true &&
        session.workDiscovery.noAdditionalAccess === true,
    )
  ) {
    evaluationFailures.push("advisory/no-additional-access literals were not preserved");
  }

  const textMs = await samples(sampleCount, textRead);
  const exactMs = await samples(sampleCount, exactRead);
  const browseMs = await samples(sampleCount, browseRead);
  const subjectDigest = createHash("sha256")
    .update(
      `${fixture.exactSubject.namespace}\u001f${fixture.exactSubject.type}\u001f${fixture.exactSubject.canonicalKey}`,
      "utf8",
    )
    .digest("hex");
  const matchingIndexPlans = {
    title: await explain(
      shared.admin,
      grant.accountId,
      grant.workspaceId,
      ownerSubjectId,
      true,
      `
      select id from sessions
      where workspace_id = $1::uuid and title is not null
        and to_tsvector('simple', title) @@ websearch_to_tsquery('simple', $2::text)
      limit 20`,
      [grant.workspaceId, fixture.textQuery],
    ),
    goal: await explain(
      shared.admin,
      grant.accountId,
      grant.workspaceId,
      ownerSubjectId,
      true,
      `
      select session_id from session_goals
      where workspace_id = $1::uuid and status = 'active'
        and to_tsvector('simple', text) @@ websearch_to_tsquery('simple', $2::text)
      limit 20`,
      [grant.workspaceId, fixture.textQuery],
    ),
    claim: await explain(
      shared.admin,
      grant.accountId,
      grant.workspaceId,
      ownerSubjectId,
      true,
      `
      select session_id from session_work_claims
      where workspace_id = $1::uuid
        and to_tsvector('simple', canonical_key || ' ' || coalesce(display_label, ''))
          @@ websearch_to_tsquery('simple', $2::text)
      limit 20`,
      [grant.workspaceId, fixture.textQuery],
    ),
    exactSubject: await explain(
      shared.admin,
      grant.accountId,
      grant.workspaceId,
      ownerSubjectId,
      true,
      `
      select session_id from session_work_claims
      where workspace_id = $1::uuid and subject_namespace = $2::text
        and subject_type = $3::text and subject_digest = $4::text and state = 'active'
      limit 20`,
      [grant.workspaceId, fixture.exactSubject.namespace, fixture.exactSubject.type, subjectDigest],
    ),
  };
  const authorizationPlans = {
    title: await explain(
      raw,
      grant.accountId,
      grant.workspaceId,
      ownerSubjectId,
      false,
      `
      select id from sessions
      where workspace_id = $1::uuid and title is not null
        and to_tsvector('simple', title) @@ websearch_to_tsquery('simple', $2::text)
      limit 20`,
      [grant.workspaceId, fixture.textQuery],
    ),
  };
  const expectedIndexes = {
    title: "sessions_discovery_title_fts_idx",
    goal: "session_goals_discovery_active_text_fts_idx",
    claim: "session_work_claims_discovery_text_fts_idx",
    exactSubject: "session_work_claims_subject_state_idx",
  } as const;
  const planFailures = Object.entries(expectedIndexes).flatMap(([key, indexName]) =>
    JSON.stringify(matchingIndexPlans[key as keyof typeof matchingIndexPlans]).includes(indexName)
      ? []
      : [`${key} plan did not use ${indexName}`],
  );
  const thresholds = {
    p95Ms: numberEnvironment("OPENGENI_BENCH_WORK_DISCOVERY_P95_MS", 2_000),
    responseBytes: numberEnvironment("OPENGENI_BENCH_WORK_DISCOVERY_RESPONSE_BYTES", 128_000),
  };
  const metrics = {
    sessionCount,
    sampleCount,
    textMs: distribution(textMs),
    exactSubjectMs: distribution(exactMs),
    browseMs: distribution(browseMs),
    responseBytes: {
      text: Buffer.byteLength(JSON.stringify(textPage), "utf8"),
      exactSubject: Buffer.byteLength(JSON.stringify(exactPage), "utf8"),
    },
  };
  const thresholdFailures = [
    ...check(metrics.textMs.p95, thresholds.p95Ms, "text discovery p95"),
    ...check(metrics.exactSubjectMs.p95, thresholds.p95Ms, "exact subject p95"),
    ...check(metrics.browseMs.p95, thresholds.p95Ms, "browse p95"),
    ...check(metrics.responseBytes.text, thresholds.responseBytes, "text response bytes"),
    ...check(
      metrics.responseBytes.exactSubject,
      thresholds.responseBytes,
      "exact-subject response bytes",
    ),
  ];
  const failures = [
    ...corpusFailures,
    ...evaluationFailures,
    ...planFailures,
    ...thresholdFailures,
  ];
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      postgres: (await shared.admin`show server_version`)[0]?.server_version,
    },
    fixture,
    claimId: claim.claim.id,
    corpus,
    expectedCorpus,
    evaluation: {
      textActual,
      exactActual,
      scopedTotal: scopedPage.total,
      promptOnlyExcluded: !textActual.some((entry) => entry.label === fixture.promptOnlyLabel),
    },
    metrics,
    thresholds,
    expectedIndexes,
    plans: {
      authorization: authorizationPlans,
      matchingIndexes: matchingIndexPlans,
    },
    failures,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, metrics, failures })}\n`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await raw?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared.release();
}

async function explain(
  rawSql: postgres.Sql,
  accountId: string,
  workspaceId: string,
  subjectId: string,
  forceIndex: boolean,
  statement: string,
  parameters: string[],
) {
  return await rawSql.begin(async (transaction) => {
    await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
    await transaction`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
    await transaction`select set_config('opengeni.subject_id', ${subjectId}, true)`;
    await transaction`select set_config(
      'opengeni.initiating_human_subject_id',
      ${subjectId},
      true
    )`;
    await transaction`select set_config(
      'opengeni.session_variable_set_attachments_v1',
      '1',
      true
    )`;
    if (forceIndex) await transaction.unsafe("set local enable_seqscan = off");
    return await transaction.unsafe(
      `explain (analyze, buffers, format json) ${statement}`,
      parameters,
    );
  });
}

async function samples(count: number, run: () => Promise<unknown>): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await run();
    values.push(performance.now() - started);
  }
  return values;
}

function distribution(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: ordered.at(-1)!,
  };
}

function check(actual: number, maximum: number, label: string): string[] {
  return actual <= maximum ? [] : [`${label}: ${actual.toFixed(2)} > ${maximum.toFixed(2)}`];
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function numberEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}
