import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  grantWorkspaceAccess,
  listSessionDiscoverySummaries,
  nestedPostgresSqlState,
  releaseWorkClaim,
  setSessionGoalStatusWithEvent,
  transitionSessionVisibility,
  updateSessionTitle,
  updateOrganizationPrivateSessionSettings,
  upsertSessionGoalWithEvent,
  upsertWorkClaim,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

setDefaultTimeout(180_000);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("work-claims-postgres");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[work-claims-postgres] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 600_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 120_000);

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

async function fixture(options: { privateSession?: boolean; goal?: boolean } = {}) {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const ownerUserId = `work-claim-owner-${suffix}`;
  const ownerSubjectId = `user:${ownerUserId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Work claim owner",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;

  if (options.privateSession) {
    const settings = await getOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: ownerSubjectId,
    });
    if (!settings.enabled) {
      await updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: grant.accountId,
        actorSubjectId: ownerSubjectId,
        enabled: true,
        expectedVersion: settings.version,
        operationId: crypto.randomUUID(),
      });
    }
  }

  const session = await createOwnedSession(
    { grant, ownerSubjectId },
    `Work claim fixture ${suffix}`,
  );
  if (options.privateSession) {
    await transitionSessionVisibility(client.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actorSubjectId: ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `work-claim-private-${suffix}`,
    });
  }
  if (options.goal) {
    await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
      upsertSessionGoalWithEvent(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        text: "Complete the work claim lifecycle proof",
        createdBy: "api",
        actor: "api",
      }),
    );
  }
  return { grant, ownerSubjectId, session };
}

async function createOwnedSession(
  input: {
    grant: { accountId: string; workspaceId: string };
    ownerSubjectId: string;
  },
  initialMessage: string,
) {
  return await withSessionRlsActorContext({ subjectId: input.ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      initialMessage,
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: input.ownerSubjectId },
      createdByContext: {},
    }),
  );
}

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  initiatorSubjectId: string;
  initiatingHumanSubjectId?: string | null;
  generation?: number;
  turnId?: string;
}) {
  const turnId = input.turnId ?? crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const generation = input.generation ?? 1;
  await shared!.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    if (input.turnId) {
      await sql`
        update session_turn_attempts
        set state = 'closed', outcome = 'interrupted_recoverable', closed_at = now()
        where workspace_id = ${input.workspaceId} and turn_id = ${turnId}
          and state in ('claimed', 'running')
      `;
      await sql`
        update session_turns set execution_generation = ${generation},
          active_attempt_id = null, status = 'recovering'
        where workspace_id = ${input.workspaceId} and id = ${turnId}
      `;
    } else {
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, execution_generation,
          initiator_kind, initiator_subject_id, initiator_context,
          initiating_human_subject_id
        ) values (
          ${turnId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
          ${crypto.randomUUID()}, ${`work-claim-${turnId}`}, 'running', 'user', 1,
          'work claim fixture', 'test-model', 'medium', 'none', ${generation},
          'subject', ${input.initiatorSubjectId}, '{}'::jsonb,
          ${input.initiatingHumanSubjectId ?? input.initiatorSubjectId}
        )
      `;
    }
    await sql`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
    `;
    await sql`
      update session_turns set active_attempt_id = ${attemptId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${turnId}
    `;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${turnId}, ${generation}, 'running', ${`work-claim-${turnId}`},
        ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )
    `;
  });
  return { ...input, turnId, attemptId, executionGeneration: generation };
}

function attemptClaims(attempt: Awaited<ReturnType<typeof seedAttempt>>) {
  return {
    accountId: attempt.accountId,
    workspaceId: attempt.workspaceId,
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
  };
}

function claimInput(
  attempt: Awaited<ReturnType<typeof seedAttempt>>,
  input: {
    operationId: string;
    expectedRevision: number;
    canonicalKey?: string;
    displayLabel?: string;
    versionValue?: string;
  },
) {
  return {
    ...attemptClaims(attempt),
    operationId: input.operationId,
    expectedRevision: input.expectedRevision,
    subjectNamespace: "github",
    subjectType: "pull_request" as const,
    canonicalKey: input.canonicalKey ?? "Cloudgeni-ai/opengeni#384",
    displayLabel: input.displayLabel ?? "OpenGeni discovery coordination",
    role: "working" as const,
    version: input.versionValue
      ? ({ kind: "pull_request_head" as const, value: input.versionValue } as const)
      : null,
  };
}

async function activityRevision(workspaceId: string): Promise<bigint> {
  const [row] = await shared!.admin<Array<{ revision: string }>>`
    select revision::text as revision
    from workspace_session_activity_revisions
    where workspace_id = ${workspaceId}`;
  if (!row) throw new Error(`missing activity revision for ${workspaceId}`);
  return BigInt(row.revision);
}

async function claimHead(claimId: string) {
  const [row] = await shared!.admin<
    Array<{ state: string; revision: number; settledAt: Date | null }>
  >`
    select state, revision, settled_at as "settledAt"
    from session_work_claims where id = ${claimId}`;
  if (!row) throw new Error(`missing work claim ${claimId}`);
  return row;
}

describe("durable advisory work claims", () => {
  test("installs valid and ready discovery indexes", async () => {
    if (!shared) return;
    const indexes = await shared.admin<
      Array<{ name: string; valid: boolean; ready: boolean; definition: string }>
    >`
      select class.relname as name,
        index.indisvalid as valid,
        index.indisready as ready,
        pg_get_indexdef(index.indexrelid)::text as definition
      from pg_class class
      join pg_index index on index.indexrelid = class.oid
      join pg_namespace namespace on namespace.oid = class.relnamespace
      where namespace.nspname = current_schema()
        and class.relname in (
          'sessions_discovery_title_fts_idx',
          'session_goals_discovery_active_text_fts_idx',
          'session_work_claims_discovery_text_fts_idx',
          'session_work_claims_subject_state_idx'
        )
      order by class.relname
    `;
    expect(indexes).toHaveLength(4);
    expect(indexes.every((index) => index.valid && index.ready)).toBe(true);
    expect(Object.fromEntries(indexes.map((index) => [index.name, index.definition]))).toEqual({
      session_goals_discovery_active_text_fts_idx: expect.stringContaining(
        "to_tsvector('simple'::regconfig, text)",
      ),
      session_work_claims_discovery_text_fts_idx: expect.stringContaining(
        "to_tsvector('simple'::regconfig, ((canonical_key || ' '::text) || COALESCE(display_label, ''::text)))",
      ),
      session_work_claims_subject_state_idx: expect.stringContaining(
        "workspace_id, subject_namespace, subject_type, subject_digest, state",
      ),
      sessions_discovery_title_fts_idx: expect.stringContaining(
        "to_tsvector('simple'::regconfig, title)",
      ),
    });
    expect(
      indexes.find((index) => index.name === "sessions_discovery_title_fts_idx")?.definition,
    ).toContain("WHERE (title IS NOT NULL)");
    expect(
      indexes.find((index) => index.name === "session_goals_discovery_active_text_fts_idx")
        ?.definition,
    ).toContain("WHERE (status = 'active'::text)");
  });

  test("creates, updates, replays, releases, recreates, and advances activity exactly once", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
      initiatorSubjectId: f.ownerSubjectId,
    });
    const before = await activityRevision(f.grant.workspaceId);
    const createOperationId = crypto.randomUUID();
    const createRequest = claimInput(attempt, {
      operationId: createOperationId,
      expectedRevision: 0,
      versionValue: "head-1",
    });

    const created = await upsertWorkClaim(client.db, createRequest);
    expect(created).toMatchObject({
      mutation: "created",
      replayed: false,
      claim: {
        state: "active",
        revision: 1,
        provenance: "explicit_agent",
        subject: {
          namespace: "github",
          type: "pull_request",
          canonicalKey: "Cloudgeni-ai/opengeni#384",
        },
      },
    });
    const replay = await upsertWorkClaim(client.db, createRequest);
    expect(replay).toEqual({ ...created, replayed: true });
    await expectSqlState(
      () =>
        upsertWorkClaim(client!.db, {
          ...createRequest,
          displayLabel: "Conflicting operation reuse",
        }),
      "23505",
    );

    const updated = await upsertWorkClaim(
      client.db,
      claimInput(attempt, {
        operationId: crypto.randomUUID(),
        expectedRevision: 1,
        displayLabel: "OpenGeni overlap discovery",
        versionValue: "head-2",
      }),
    );
    expect(updated).toMatchObject({
      mutation: "updated",
      replayed: false,
      claim: { id: created.claim.id, state: "active", revision: 2 },
    });
    await expectSqlState(
      () =>
        upsertWorkClaim(
          client!.db,
          claimInput(attempt, {
            operationId: crypto.randomUUID(),
            expectedRevision: 1,
            versionValue: "stale-writer",
          }),
        ),
      "40001",
    );

    const releaseOperationId = crypto.randomUUID();
    const releaseRequest = {
      ...attemptClaims(attempt),
      operationId: releaseOperationId,
      claimId: created.claim.id,
      expectedRevision: 2,
      reason: "no_longer_active",
    };
    const released = await releaseWorkClaim(client.db, releaseRequest);
    expect(released).toMatchObject({
      mutation: "released",
      replayed: false,
      claim: { id: created.claim.id, state: "released", revision: 3 },
    });
    expect(await releaseWorkClaim(client.db, releaseRequest)).toEqual({
      ...released,
      replayed: true,
    });

    const recreated = await upsertWorkClaim(
      client.db,
      claimInput(attempt, {
        operationId: crypto.randomUUID(),
        expectedRevision: 0,
        versionValue: "head-3",
      }),
    );
    expect(recreated).toMatchObject({
      mutation: "created",
      claim: { state: "active", revision: 1 },
    });
    expect(recreated.claim.id).not.toBe(created.claim.id);

    const revisions = await shared.admin<
      Array<{ claimId: string; mutationKind: string; resultingRevision: number }>
    >`
      select claim_id as "claimId", mutation_kind as "mutationKind",
        resulting_revision as "resultingRevision"
      from session_work_claim_revisions
      where workspace_id = ${f.grant.workspaceId} and session_id = ${f.session.id}
      order by created_at, id`;
    expect([...revisions]).toEqual([
      { claimId: created.claim.id, mutationKind: "created", resultingRevision: 1 },
      { claimId: created.claim.id, mutationKind: "updated", resultingRevision: 2 },
      { claimId: created.claim.id, mutationKind: "released", resultingRevision: 3 },
      { claimId: recreated.claim.id, mutationKind: "created", resultingRevision: 1 },
    ]);
    expect(await activityRevision(f.grant.workspaceId)).toBe(before + 4n);
  });

  test("replacement attempts replay the same logical-turn receipt while stale attempts fail closed", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const firstAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
      initiatorSubjectId: f.ownerSubjectId,
    });
    const operationId = crypto.randomUUID();
    const firstRequest = claimInput(firstAttempt, { operationId, expectedRevision: 0 });
    const created = await upsertWorkClaim(client.db, firstRequest);

    const replacementAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
      initiatorSubjectId: f.ownerSubjectId,
      turnId: firstAttempt.turnId,
      generation: 2,
    });
    const replay = await upsertWorkClaim(
      client.db,
      claimInput(replacementAttempt, { operationId, expectedRevision: 0 }),
    );
    expect(replay).toEqual({ ...created, replayed: true });

    const updated = await upsertWorkClaim(
      client.db,
      claimInput(replacementAttempt, {
        operationId: crypto.randomUUID(),
        expectedRevision: 1,
        versionValue: "replacement-head",
      }),
    );
    expect(updated.claim.revision).toBe(2);
    const [revision] = await shared.admin<
      Array<{ actorAttemptId: string; actorExecutionGeneration: number }>
    >`
      select actor_attempt_id as "actorAttemptId",
        actor_execution_generation as "actorExecutionGeneration"
      from session_work_claim_revisions
      where claim_id = ${created.claim.id} and resulting_revision = 2`;
    expect(revision).toEqual({
      actorAttemptId: replacementAttempt.attemptId,
      actorExecutionGeneration: 2,
    });

    await expectSqlState(
      () =>
        upsertWorkClaim(
          client!.db,
          claimInput(firstAttempt, {
            operationId: crypto.randomUUID(),
            expectedRevision: 2,
            versionValue: "stale-attempt",
          }),
        ),
      "42501",
    );
  });

  test("the same typed subject remains non-exclusive across sessions", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const sibling = await createOwnedSession(f, "Independent overlapping worker");
    const firstAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
      initiatorSubjectId: f.ownerSubjectId,
    });
    const siblingAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: sibling.id,
      initiatorSubjectId: f.ownerSubjectId,
    });
    const [first, second] = await Promise.all([
      upsertWorkClaim(
        client.db,
        claimInput(firstAttempt, { operationId: crypto.randomUUID(), expectedRevision: 0 }),
      ),
      upsertWorkClaim(
        client.db,
        claimInput(siblingAttempt, { operationId: crypto.randomUUID(), expectedRevision: 0 }),
      ),
    ]);
    expect(first.claim.id).not.toBe(second.claim.id);
    expect(first.claim.subject).toEqual(second.claim.subject);
    const [count] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from session_work_claims
      where workspace_id = ${f.grant.workspaceId}
        and subject_digest = session_work_claim_subject_digest(
          'github', 'pull_request', 'Cloudgeni-ai/opengeni#384'
        ) and state = 'active'`;
    expect(count?.count).toBe(2);
  });

  test("permission-first discovery ranks title, active goal, and claims without searching prompts", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const titleSession = await createOwnedSession(f, "opening prompt without search identity");
    const goalSession = await createOwnedSession(f, "another opening prompt");
    const claimSession = await createOwnedSession(f, "claim-backed opening prompt");
    const promptOnlySession = await createOwnedSession(f, "Permission scoped discovery");
    await updateSessionTitle(client.db, {
      workspaceId: f.grant.workspaceId,
      sessionId: titleSession.id,
      title: "Permission scoped discovery",
      source: "user",
    });
    await withSessionRlsActorContext({ subjectId: f.ownerSubjectId }, async () =>
      upsertSessionGoalWithEvent(client!.db, {
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        sessionId: goalSession.id,
        text: "Permission scoped discovery",
        createdBy: "api",
        actor: "api",
      }),
    );
    const workingAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
      initiatorSubjectId: f.ownerSubjectId,
    });
    const reviewingAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: claimSession.id,
      initiatorSubjectId: f.ownerSubjectId,
    });
    const workingClaim = await upsertWorkClaim(
      client.db,
      claimInput(workingAttempt, {
        operationId: crypto.randomUUID(),
        expectedRevision: 0,
      }),
    );
    const reviewingClaim = await upsertWorkClaim(client.db, {
      ...claimInput(reviewingAttempt, {
        operationId: crypto.randomUUID(),
        expectedRevision: 0,
        displayLabel: "Permission scoped discovery",
      }),
      role: "reviewing",
    });

    const exact = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
      limit: 10,
      subjectId: f.ownerSubjectId,
      subject: {
        namespace: "github",
        type: "pull_request",
        canonicalKey: "Cloudgeni-ai/opengeni#384",
      },
    });
    expect(exact.orderBy).toBe("relevance");
    expect(exact.total).toBe(2);
    expect(new Set(exact.sessions.map((session) => session.id))).toEqual(
      new Set([f.session.id, claimSession.id]),
    );
    expect(
      exact.sessions.map((session) => ({
        id: session.id,
        match: session.workDiscovery.match,
        roles: session.workDiscovery.claims.map((claim) => claim.role),
        advisoryOnly: session.workDiscovery.advisoryOnly,
        noAdditionalAccess: session.workDiscovery.noAdditionalAccess,
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.session.id,
          match: expect.objectContaining({ class: "exact_subject", field: "subject" }),
          roles: ["working"],
          advisoryOnly: true,
          noAdditionalAccess: true,
        }),
        expect.objectContaining({
          id: claimSession.id,
          match: expect.objectContaining({ class: "exact_subject", field: "subject" }),
          roles: ["reviewing"],
          advisoryOnly: true,
          noAdditionalAccess: true,
        }),
      ]),
    );

    const rankedIds: string[] = [];
    const rankedMatches: string[] = [];
    let cursor: (typeof exact)["nextCursor"] = null;
    let firstRelevanceCursor: NonNullable<(typeof exact)["nextCursor"]> | null = null;
    do {
      const page = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
        limit: 1,
        subjectId: f.ownerSubjectId,
        query: "Permission scoped discovery",
        ...(cursor ? { cursor } : {}),
      });
      rankedIds.push(...page.sessions.map((session) => session.id));
      rankedMatches.push(
        ...page.sessions.map((session) => session.workDiscovery.match?.class ?? "none"),
      );
      firstRelevanceCursor ??= page.nextCursor;
      cursor = page.nextCursor;
    } while (cursor);
    expect(rankedIds).toEqual([titleSession.id, goalSession.id, claimSession.id]);
    expect(rankedMatches).toEqual(["title", "goal", "fuzzy"]);
    expect(rankedIds).not.toContain(promptOnlySession.id);
    await upsertWorkClaim(client.db, {
      ...claimInput(reviewingAttempt, {
        operationId: crypto.randomUUID(),
        expectedRevision: 0,
        canonicalKey: "Cloudgeni-ai/opengeni#unrelated-newer",
        displayLabel: "Newer unrelated evidence",
      }),
      role: "working",
    });
    const boundedExact = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
      limit: 10,
      claimLimit: 1,
      subjectId: f.ownerSubjectId,
      subject: {
        namespace: "github",
        type: "pull_request",
        canonicalKey: "Cloudgeni-ai/opengeni#384",
      },
    });
    expect(
      boundedExact.sessions.find((session) => session.id === claimSession.id)?.workDiscovery,
    ).toMatchObject({
      claims: [{ id: reviewingClaim.claim.id }],
      claimsTruncated: true,
      match: { claimId: reviewingClaim.claim.id },
    });
    for (const literalWildcard of ["%", "_"]) {
      const wildcardPage = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
        limit: 10,
        subjectId: f.ownerSubjectId,
        query: literalWildcard,
      });
      expect(wildcardPage.total).toBe(0);
      expect(wildcardPage.sessions).toEqual([]);
    }
    expect(firstRelevanceCursor).not.toBeNull();
    await expect(
      listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
        limit: 1,
        subjectId: f.ownerSubjectId,
        query: "different normalized filters",
        cursor: firstRelevanceCursor!,
      }),
    ).rejects.toThrow("sessions_list cursor relevance filters do not match the request");

    const authorizedOnly = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
      limit: 10,
      subjectId: f.ownerSubjectId,
      query: "Permission scoped discovery",
      authorizationScope: {
        kind: "scoped",
        rootSessionIds: [],
        sessionIds: [goalSession.id],
      },
    });
    expect(authorizedOnly.total).toBe(1);
    expect(authorizedOnly.sessions.map((session) => session.id)).toEqual([goalSession.id]);

    await releaseWorkClaim(client.db, {
      ...attemptClaims(workingAttempt),
      operationId: crypto.randomUUID(),
      claimId: workingClaim.claim.id,
      expectedRevision: 1,
      reason: "no_longer_active",
    });
    const activeExact = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
      limit: 10,
      subjectId: f.ownerSubjectId,
      subject: {
        namespace: "github",
        type: "pull_request",
        canonicalKey: "Cloudgeni-ai/opengeni#384",
      },
    });
    expect(activeExact.sessions.map((session) => session.id)).toEqual([claimSession.id]);
    const recentExact = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
      limit: 10,
      subjectId: f.ownerSubjectId,
      recentHours: 24,
      subject: {
        namespace: "github",
        type: "pull_request",
        canonicalKey: "Cloudgeni-ai/opengeni#384",
      },
    });
    expect(new Set(recentExact.sessions.map((session) => session.id))).toEqual(
      new Set([f.session.id, claimSession.id]),
    );
    expect(
      recentExact.sessions
        .flatMap((session) => session.workDiscovery.claims)
        .find((claim) => claim.id === workingClaim.claim.id),
    ).toMatchObject({ state: "released" });
    expect(reviewingClaim.claim.role).toBe("reviewing");
  });

  test("goal and session lifecycle transitions settle claims without treating pauses as releases", async () => {
    if (!shared || !client) return;
    const goalFixture = await fixture({ goal: true });
    const goalAttempt = await seedAttempt({
      accountId: goalFixture.grant.accountId,
      workspaceId: goalFixture.grant.workspaceId,
      sessionId: goalFixture.session.id,
      initiatorSubjectId: goalFixture.ownerSubjectId,
    });
    const goalClaim = await upsertWorkClaim(
      client.db,
      claimInput(goalAttempt, { operationId: crypto.randomUUID(), expectedRevision: 0 }),
    );
    await withSessionRlsActorContext({ subjectId: goalFixture.ownerSubjectId }, async () => {
      await setSessionGoalStatusWithEvent(
        client!.db,
        goalFixture.grant.workspaceId,
        goalFixture.session.id,
        {
          status: "paused",
          rationale: "operator pause",
          pausedReason: "api",
          event: {
            type: "goal.paused",
            actor: "api",
            reason: "api",
            rationale: "operator pause",
          },
        },
      );
    });
    expect(await claimHead(goalClaim.claim.id)).toMatchObject({ state: "active", revision: 1 });
    await withSessionRlsActorContext({ subjectId: goalFixture.ownerSubjectId }, async () => {
      await setSessionGoalStatusWithEvent(
        client!.db,
        goalFixture.grant.workspaceId,
        goalFixture.session.id,
        { status: "active", event: { type: "goal.resumed", actor: "api" } },
      );
      await setSessionGoalStatusWithEvent(
        client!.db,
        goalFixture.grant.workspaceId,
        goalFixture.session.id,
        {
          status: "completed",
          evidence: "Lifecycle settlement is proven",
          event: { type: "goal.completed", evidence: "Lifecycle settlement is proven" },
        },
      );
    });
    expect(await claimHead(goalClaim.claim.id)).toMatchObject({
      state: "released",
      revision: 2,
      settledAt: expect.any(Date),
    });
    const [goalSettlement] = await shared.admin<
      Array<{ mutationKind: string; actorKind: string; reason: string }>
    >`
      select mutation_kind as "mutationKind", actor_kind as "actorKind", reason
      from session_work_claim_revisions
      where claim_id = ${goalClaim.claim.id} and resulting_revision = 2`;
    expect(goalSettlement).toEqual({
      mutationKind: "released",
      actorKind: "system",
      reason: "completed",
    });
    await expectSqlState(
      () =>
        upsertWorkClaim(
          client!.db,
          claimInput(goalAttempt, {
            operationId: crypto.randomUUID(),
            expectedRevision: 0,
          }),
        ),
      "42501",
    );

    for (const terminal of ["cancelled", "failed"] as const) {
      const terminalFixture = await fixture();
      const terminalAttempt = await seedAttempt({
        accountId: terminalFixture.grant.accountId,
        workspaceId: terminalFixture.grant.workspaceId,
        sessionId: terminalFixture.session.id,
        initiatorSubjectId: terminalFixture.ownerSubjectId,
      });
      const claim = await upsertWorkClaim(
        client.db,
        claimInput(terminalAttempt, {
          operationId: crypto.randomUUID(),
          expectedRevision: 0,
        }),
      );
      await shared.admin`
        update sessions set status = ${terminal}
        where workspace_id = ${terminalFixture.grant.workspaceId}
          and id = ${terminalFixture.session.id}`;
      expect(await claimHead(claim.claim.id)).toMatchObject({
        state: terminal === "cancelled" ? "released" : "stale",
        revision: 2,
        settledAt: expect.any(Date),
      });
      const [settlement] = await shared.admin<Array<{ mutationKind: string; reason: string }>>`
        select mutation_kind as "mutationKind", reason
        from session_work_claim_revisions
        where claim_id = ${claim.claim.id} and resulting_revision = 2`;
      expect(settlement).toEqual({
        mutationKind: terminal === "cancelled" ? "released" : "stale",
        reason: terminal,
      });
    }
  });

  test("private visibility, immutable history, and least-privilege grants fail closed", async () => {
    if (!shared || !client) return;
    const f = await fixture({ privateSession: true });
    const outsiderSubjectId = `user:work-claim-outsider-${crypto.randomUUID()}`;
    await grantWorkspaceAccess(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      subjectId: outsiderSubjectId,
      permissions: ["sessions:read", "sessions:control"],
    });
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.session.id,
      initiatorSubjectId: f.ownerSubjectId,
    });
    const created = await upsertWorkClaim(
      client.db,
      claimInput(attempt, { operationId: crypto.randomUUID(), expectedRevision: 0 }),
    );
    const exactSubject = {
      namespace: "github",
      type: "pull_request" as const,
      canonicalKey: "Cloudgeni-ai/opengeni#384",
    };
    const ownerDiscovery = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
      limit: 10,
      subjectId: f.ownerSubjectId,
      subject: exactSubject,
    });
    expect(ownerDiscovery.sessions.map((session) => session.id)).toEqual([f.session.id]);
    const outsiderDiscovery = await listSessionDiscoverySummaries(client.db, f.grant.workspaceId, {
      limit: 10,
      subjectId: outsiderSubjectId,
      subject: exactSubject,
    });
    expect(outsiderDiscovery.total).toBe(0);
    expect(outsiderDiscovery.sessions).toEqual([]);
    const app = postgres(shared.appUrl, {
      max: 1,
      prepare: false,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    const visibleCount = async (subjectId: string) =>
      await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        await sql`select set_config('opengeni.initiating_human_subject_id', ${subjectId}, true)`;
        const [row] = await sql<Array<{ count: number }>>`
          select count(*)::int as count from session_work_claims
          where workspace_id = ${f.grant.workspaceId} and id = ${created.claim.id}`;
        return row?.count ?? -1;
      });
    try {
      expect(await visibleCount(f.ownerSubjectId)).toBe(1);
      expect(await visibleCount(outsiderSubjectId)).toBe(0);
      const [privileges] = await shared.admin<
        Array<{
          headSelect: boolean;
          headInsert: boolean;
          headUpdate: boolean;
          headDelete: boolean;
          revisionSelect: boolean;
          capabilitySelect: boolean;
        }>
      >`
        select
          has_table_privilege('opengeni_app', 'session_work_claims', 'SELECT') as "headSelect",
          has_table_privilege('opengeni_app', 'session_work_claims', 'INSERT') as "headInsert",
          has_table_privilege('opengeni_app', 'session_work_claims', 'UPDATE') as "headUpdate",
          has_table_privilege('opengeni_app', 'session_work_claims', 'DELETE') as "headDelete",
          has_table_privilege('opengeni_app', 'session_work_claim_revisions', 'SELECT') as "revisionSelect",
          has_table_privilege('opengeni_app', 'session_work_claim_write_capabilities', 'SELECT') as "capabilitySelect"`;
      expect(privileges).toEqual({
        headSelect: true,
        headInsert: false,
        headUpdate: false,
        headDelete: false,
        revisionSelect: false,
        capabilitySelect: false,
      });
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
            await sql`
              update session_work_claims set display_label = 'forged'
              where workspace_id = ${f.grant.workspaceId} and id = ${created.claim.id}`;
          }),
        "42501",
      );
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select * from session_work_claim_revisions limit 1`;
          }),
        "42501",
      );
    } finally {
      await app.end();
    }

    await expectSqlState(
      () =>
        shared!.admin`
          update session_work_claim_revisions set reason = 'other'
          where claim_id = ${created.claim.id} and resulting_revision = 1`,
      "42501",
    );
    await expectSqlState(
      () =>
        shared!.admin`
          delete from session_work_claims where id = ${created.claim.id}`,
      "42501",
    );

    const routines = await shared.admin<
      Array<{ schemaName: string; name: string; securityDefiner: boolean; settings: string[] }>
    >`
      select namespace.nspname as "schemaName", procedure.proname as name,
        procedure.prosecdef as "securityDefiner", procedure.proconfig as settings
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where procedure.proname in (
        'session_work_claim_capability_active',
        'resolve_session_work_claim_attempt_authority',
        'upsert_session_work_claim_for_attempt',
        'release_session_work_claim_for_attempt',
        'settle_active_session_work_claims'
      )
      order by namespace.nspname, procedure.proname`;
    expect(routines).toHaveLength(5);
    for (const routine of routines) {
      expect(routine.securityDefiner).toBe(true);
      expect(routine.settings).toContain("search_path=public, pg_catalog");
    }
  });
});
