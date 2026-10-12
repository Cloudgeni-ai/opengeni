import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  automaticSessionTitleFanoutDue,
  bootstrapWorkspace,
  browserDeadlineCheckpointDue,
  claimAutomaticSessionTitleFanout,
  claimKnowledgeIndexJobs,
  claimPendingSessionWorkflowWakes,
  claimSiteAuthMaintenance,
  createDb,
  createSession,
  createSiteAuthConnection,
  enqueueSessionWorkflowWake,
  initializeSessionStartAtomically,
  knowledgeIndexDue,
  listIdleCheckpointCandidates,
  reapExpiredSessionListSnapshots,
  sandboxIdleCheckpointDue,
  sandboxLeaseReaperDue,
  sandboxMaintenanceDue,
  saveKnowledgeEntry,
  sessionWorkflowWakesDue,
  siteAuthMaintenanceDue,
  workspacePauseTimerDue,
  type KnowledgeContext,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("maintenance-work-probes");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const embedding = { model: "test-embedding", dimensions: 3 };
const SITE_AUTH_CLAIM_TIMEOUT_MS = 10 * 60 * 1_000;
const CHECKPOINT_ARTIFACT_CLAIM_TTL_MS = 15 * 60 * 1_000;

async function allProbes() {
  return {
    wakes: await sessionWorkflowWakesDue(client.db),
    titles: await automaticSessionTitleFanoutDue(client.db),
    pauseTimers: await workspacePauseTimerDue(client.db),
    knowledge: await knowledgeIndexDue(client.db, embedding),
    siteAuth: await siteAuthMaintenanceDue(client.db, {
      claimTimeoutMs: SITE_AUTH_CLAIM_TIMEOUT_MS,
    }),
    sandboxLeaseReaper: await sandboxLeaseReaperDue(client.db),
    sandboxIdleCheckpoint: await sandboxIdleCheckpointDue(client.db, { intervalMs: 1 }),
    browserDeadlineCheckpoint: await browserDeadlineCheckpointDue(client.db),
    sandboxMaintenance: await sandboxMaintenanceDue(client.db, {
      checkpointArtifactClaimTtlMs: CHECKPOINT_ARTIFACT_CLAIM_TTL_MS,
    }),
  };
}

async function sessionFixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `probe-account-${suffix}`,
    accountName: "Maintenance probes",
    workspaceExternalSource: "test",
    workspaceExternalId: `probe-workspace-${suffix}`,
    workspaceName: "Maintenance probes",
    subjectId: `user:probe-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    actorSubjectId: grant.subjectId,
    sessionId: session.id,
  };
}

/** Settle everything the fixtures themselves enqueued, as a drained deployment would. */
async function drainAll() {
  await shared.admin`UPDATE session_workflow_wake_outbox SET delivered_revision = wake_revision`;
  await shared.admin`UPDATE opengeni_private.automatic_session_title_fanout_outbox_v1
    SET delivered_at = now() WHERE delivered_at IS NULL`;
}

describe("maintenance work probes", () => {
  test("an idle deployment has no due maintenance work", async () => {
    await drainAll();
    expect(await allProbes()).toEqual({
      wakes: false,
      titles: false,
      pauseTimers: false,
      knowledge: false,
      siteAuth: false,
      sandboxLeaseReaper: false,
      sandboxIdleCheckpoint: false,
      browserDeadlineCheckpoint: false,
      sandboxMaintenance: false,
    });
  });

  test("a warm sandbox makes the reaper, its maintenance and the idle checkpoint due", async () => {
    const scope = await sessionFixture();
    await drainAll();
    const instanceId = `box-${crypto.randomUUID()}`;
    const [lease] = await shared.admin<{ id: string }[]>`
      INSERT INTO sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
        turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
        resume_state, expires_at)
      VALUES (${scope.accountId}, ${scope.workspaceId}, ${crypto.randomUUID()}, 'warm', 1, 0, 1,
        ${instanceId}, 'modal', 1, 'modal',
        ${JSON.stringify({ backendId: "modal", sessionState: { providerState: { sandboxId: instanceId } } })}::text::jsonb,
        now() + interval '10 minutes')
      RETURNING id`;
    try {
      expect(await sandboxLeaseReaperDue(client.db)).toBe(true);
      expect(
        await sandboxMaintenanceDue(client.db, {
          checkpointArtifactClaimTtlMs: CHECKPOINT_ARTIFACT_CLAIM_TTL_MS,
        }),
      ).toBe(true);
      // Superset of the inventory it previews: whenever the inventory lists
      // this box, the check said yes.
      expect(await sandboxIdleCheckpointDue(client.db, { intervalMs: 1 })).toBe(true);
      const listed = (await listIdleCheckpointCandidates(client.db, { limit: 10, intervalMs: 1 }))
        .length;
      if (listed > 0)
        expect(await sandboxIdleCheckpointDue(client.db, { intervalMs: 1 })).toBe(true);
      // Recently checkpointed: not due until the snapshot interval passes.
      await shared.admin`UPDATE sandbox_leases SET idle_checkpoint_attempted_at = now()
        WHERE id = ${lease!.id}`;
      expect(await sandboxIdleCheckpointDue(client.db, { intervalMs: 3_600_000 })).toBe(false);
      expect(
        await listIdleCheckpointCandidates(client.db, { limit: 10, intervalMs: 3_600_000 }),
      ).toEqual([]);
      // No browser is held on the box, so the browser sweep has nothing to do.
      expect(await browserDeadlineCheckpointDue(client.db)).toBe(false);
      // A cold box with no holders is not the reaper's work.
      await shared.admin`UPDATE sandbox_leases SET liveness = 'cold', refcount = 0,
        viewer_holders = 0, instance_id = NULL WHERE id = ${lease!.id}`;
      expect(await allProbes()).toMatchObject({
        sandboxLeaseReaper: false,
        sandboxIdleCheckpoint: false,
        sandboxMaintenance: false,
      });
    } finally {
      await shared.admin`DELETE FROM sandbox_leases WHERE id = ${lease!.id}`;
    }
  });

  test("an expired session-list snapshot is maintenance work until it is reaped", async () => {
    const scope = await sessionFixture();
    await drainAll();
    const due = () =>
      sandboxMaintenanceDue(client.db, {
        checkpointArtifactClaimTtlMs: CHECKPOINT_ARTIFACT_CLAIM_TTL_MS,
      });
    await shared.admin`INSERT INTO session_list_snapshots (account_id, workspace_id, subject_id,
        expires_at) VALUES (${scope.accountId}, ${scope.workspaceId}, ${scope.actorSubjectId},
        now() + interval '5 minutes')`;
    expect(await due()).toBe(false);
    await shared.admin`UPDATE session_list_snapshots SET expires_at = now() - interval '1 second'
      WHERE workspace_id = ${scope.workspaceId}`;
    expect(await due()).toBe(true);
    expect(await reapExpiredSessionListSnapshots(client.db, 500)).toBeGreaterThan(0);
    expect(await due()).toBe(false);
    await expect(
      sandboxMaintenanceDue(client.db, { checkpointArtifactClaimTtlMs: 10 }),
    ).rejects.toThrow();
    await expect(sandboxIdleCheckpointDue(client.db, { intervalMs: 0 })).rejects.toThrow();
  });

  test("a committed workflow wake is due until it is delivered or backing off", async () => {
    const scope = await sessionFixture();
    await drainAll();
    expect(await sessionWorkflowWakesDue(client.db)).toBe(false);
    await enqueueSessionWorkflowWake(client.db, {
      ...scope,
      temporalWorkflowId: `session-${scope.sessionId}`,
      reason: "probe",
    });
    expect(await sessionWorkflowWakesDue(client.db)).toBe(true);
    expect((await claimPendingSessionWorkflowWakes(client.db, 10)).length).toBeGreaterThan(0);
    await shared.admin`UPDATE session_workflow_wake_outbox
      SET next_attempt_at = now() + interval '1 minute' WHERE session_id = ${scope.sessionId}`;
    expect(await sessionWorkflowWakesDue(client.db)).toBe(false);
    expect(await claimPendingSessionWorkflowWakes(client.db, 10)).toEqual([]);
    await drainAll();
    expect(await sessionWorkflowWakesDue(client.db)).toBe(false);
  });

  test("an undelivered automatic-title event is due until delivered", async () => {
    const scope = await sessionFixture();
    await drainAll();
    const [event] = await shared.admin<{ id: string }[]>`
      SELECT id FROM session_events WHERE session_id = ${scope.sessionId} ORDER BY sequence LIMIT 1`;
    await shared.admin`INSERT INTO opengeni_private.automatic_session_title_fanout_outbox_v1
      (account_id, workspace_id, session_id, event_id)
      VALUES (${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, ${event!.id})`;
    expect(await automaticSessionTitleFanoutDue(client.db)).toBe(true);
    expect((await claimAutomaticSessionTitleFanout(client.db, 10)).length).toBe(1);
    await drainAll();
    expect(await automaticSessionTitleFanoutDue(client.db)).toBe(false);
    expect(await claimAutomaticSessionTitleFanout(client.db, 10)).toEqual([]);
  });

  test("a Knowledge index job is due exactly when the claim could lease it", async () => {
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Probe')`;
    await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Probe')`;
    const context: KnowledgeContext = {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: `user:${crypto.randomUUID()}`,
        writeScopes: ["workspace", "personal"],
        settingsScopes: ["workspace", "personal"],
        review: true,
      },
    };
    await saveKnowledgeEntry(client.db, context, {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "workspace",
      entry: {
        kind: "fact",
        title: "Probe",
        content: "A fact to index.",
        groupIds: [],
        evidence: [],
        relationships: [],
      },
    });
    expect(await knowledgeIndexDue(client.db, embedding)).toBe(true);
    const claims = await claimKnowledgeIndexJobs(client.db, { ...embedding, limit: 20 });
    expect(claims.length).toBeGreaterThan(0);
    // Leased by a live claim: nothing for another sweep to take.
    expect(await knowledgeIndexDue(client.db, embedding)).toBe(false);
    expect(await claimKnowledgeIndexJobs(client.db, { ...embedding, limit: 20 })).toEqual([]);
    // An expired lease is claimable again.
    await shared.admin`UPDATE knowledge_index_jobs SET lease_until = now() - interval '1 second'`;
    expect(await knowledgeIndexDue(client.db, embedding)).toBe(true);
    await shared.admin`UPDATE knowledge_index_jobs
      SET state = 'ready', model = ${embedding.model}, dimensions = ${embedding.dimensions},
        lease_until = NULL`;
    expect(await knowledgeIndexDue(client.db, embedding)).toBe(false);
    expect(await claimKnowledgeIndexJobs(client.db, { ...embedding, limit: 20 })).toEqual([]);
    // A different embedding model makes ready projections due for rebuild.
    expect(await knowledgeIndexDue(client.db, { model: "next-embedding", dimensions: 3 })).toBe(
      true,
    );
    await expect(knowledgeIndexDue(client.db, { model: "", dimensions: 3 })).rejects.toThrow();
  });

  test("a maintained site-auth connection is due until a live claim holds it", async () => {
    const scope = await sessionFixture();
    const operationId = crypto.randomUUID();
    await createSiteAuthConnection(client.db, {
      ...scope,
      operationId,
      name: `Probe ${operationId.slice(0, 8)}`,
      accountLabel: "test@example.com",
      origins: ["https://example.com"],
      loginUrl: "https://example.com/login",
      verificationUrlPrefixes: ["https://example.com/app"],
      authorities: [
        {
          id: "human",
          kind: "human" as const,
          label: "Ask the user",
          fields: [
            { id: "email", purpose: "identifier" as const },
            { id: "password", purpose: "password" as const },
          ],
        },
      ],
      methods: [
        {
          id: "password",
          kind: "password" as const,
          label: "Email and password",
          authorityIds: ["human"],
        },
      ],
      preferredIdentityId: null,
      preferredPlacement: null,
      preferredNetworkRouteId: null,
      healthPolicy: { mode: "maintained", intervalSeconds: 120, automaticRepair: true },
    });
    const due = { claimTimeoutMs: SITE_AUTH_CLAIM_TIMEOUT_MS };
    expect(await siteAuthMaintenanceDue(client.db, due)).toBe(true);
    expect(
      await claimSiteAuthMaintenance(client.db, {
        claimTimeoutMs: SITE_AUTH_CLAIM_TIMEOUT_MS,
        limit: 5,
      }),
    ).toHaveLength(1);
    expect(await siteAuthMaintenanceDue(client.db, due)).toBe(false);
    expect(
      await claimSiteAuthMaintenance(client.db, {
        claimTimeoutMs: SITE_AUTH_CLAIM_TIMEOUT_MS,
        limit: 5,
      }),
    ).toEqual([]);
    // A claim older than the timeout may be reclaimed, so it is due again.
    expect(await siteAuthMaintenanceDue(client.db, { claimTimeoutMs: 0 })).toBe(true);
    await expect(siteAuthMaintenanceDue(client.db, { claimTimeoutMs: -1 })).rejects.toThrow();
  });

  test("each probe runs with its claim's owner and grants, and only reads", async () => {
    const rows = await shared.admin<
      {
        probe: string;
        same_owner: boolean;
        definer: boolean;
        volatility: string;
        public_execute: boolean;
        app_execute: boolean;
        config: string[] | null;
      }[]
    >`
      SELECT probe.signature AS probe,
        p.proowner = c.proowner AS same_owner,
        p.prosecdef AS definer,
        p.provolatile::text AS volatility,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') AS app_execute,
        p.proconfig AS config
      FROM (VALUES
        ('opengeni_private.session_workflow_wakes_due_v1()',
          'opengeni_private.claim_session_workflow_wakes(integer)'),
        ('opengeni_private.automatic_session_title_fanout_due_v1()',
          'opengeni_private.claim_automatic_session_title_fanout_v1(integer)'),
        ('opengeni_private.knowledge_index_due_v1(text,integer)',
          current_schema() || '.knowledge_index_claim(text,integer,integer)'),
        ('opengeni_private.site_auth_maintenance_due_v1(bigint)',
          'opengeni_private.claim_site_auth_maintenance(bigint,integer)'),
        ('opengeni_private.sandbox_lease_reaper_due_v1()',
          'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'),
        ('opengeni_private.sandbox_idle_checkpoint_due_v1(bigint)',
          'opengeni_private.list_idle_checkpoint_candidates(integer,bigint)'),
        ('opengeni_private.browser_deadline_checkpoint_due_v1()',
          'opengeni_private.list_browser_deadline_checkpoints(integer)'),
        ('opengeni_private.session_system_update_outbox_due_v1()',
          'opengeni_private.claim_session_system_update_outbox_v2(integer)'),
        ('opengeni_private.session_list_snapshots_expired_v1()',
          'opengeni_private.reap_expired_session_list_snapshots(integer)'),
        ('opengeni_private.connected_command_reconciliation_due_v1()',
          'opengeni_private.claim_connected_machine_background_commands(uuid,integer,bigint,timestamp with time zone)'),
        ('opengeni_private.connected_command_output_release_due_v1()',
          'opengeni_private.claim_connected_command_output_releases(uuid,integer,bigint,timestamp with time zone)'),
        ('opengeni_private.terminal_retained_processes_due_v1()',
          'opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint)'),
        ('opengeni_private.sandbox_ended_epoch_blockers_due_v1()',
          'opengeni_private.list_sandbox_ended_epoch_blockers(integer)'),
        ('opengeni_private.sandbox_checkpoint_artifact_gc_due_v1(bigint)',
          'opengeni_private.claim_sandbox_checkpoint_artifacts(uuid,integer,bigint)')
      ) AS probe(signature, claim)
      JOIN pg_proc p ON p.oid = probe.signature::regprocedure
      JOIN pg_proc c ON c.oid = probe.claim::regprocedure
      ORDER BY probe.signature`;
    expect(rows).toHaveLength(14);
    for (const row of rows) {
      expect(row).toMatchObject({
        same_owner: true,
        definer: true,
        volatility: "s",
        public_execute: false,
        app_execute: true,
        config: ["search_path=pg_catalog"],
      });
    }
  });
});
