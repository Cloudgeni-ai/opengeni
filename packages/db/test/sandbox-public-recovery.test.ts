import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acquireLease,
  authorizeAutomaticSandboxCheckpointRecovery,
  authorizeHistoricalSandboxCheckpointRecovery,
  beginSandboxRematerialization,
  bootstrapWorkspace,
  claimSandboxCheckpointArtifactsForGc,
  commitWarmingToWarm,
  consentPublicSandboxRecovery,
  confirmDrainCold,
  createDb,
  createSession,
  claimSessionWorkForAttempt,
  failSandboxRematerialization,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  failWarmingToCold,
  getSandboxRecoveryDiscontinuity,
  markSandboxRestoreVerifying,
  readLease,
  readRecentSandboxRecoveryObservations,
  readPublicSandboxRecovery,
  recordWarmingSandboxCreated,
  registerSandboxCheckpointArtifact,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
  mutateSessionControlInTransaction,
} from "../src/index";
import type { SandboxRecoveryRequest } from "@opengeni/contracts";
import { nestedPostgresSqlState } from "../src/persistence-errors";

async function rejectsWithSqlState(operation: PromiseLike<unknown>, code = "55000") {
  const error = await Promise.resolve(operation).then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(nestedPostgresSqlState(error)).toBe(code);
}

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("public-recovery");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl);
  expect(
    (await shared.admin`select consent_enabled from opengeni_private.sandbox_recovery_rollout`)[0]!
      .consent_enabled,
  ).toBe(false);
  await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true, release_evidence = 'isolated test fixture, not live activation'`;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const unique = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: unique,
    accountName: "recovery",
    workspaceExternalSource: "test",
    workspaceExternalId: unique,
    workspaceName: "recovery",
    subjectId: `subject-${unique}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
  const create = (groupId?: string) =>
    createSession(client.db, {
      ...scope,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
      ...(groupId ? { sandboxGroupId: groupId } : {}),
    });
  const session = await create();
  const leaseId = crypto.randomUUID();
  const selectionTime = "2026-09-16T06:24:07.000Z";
  const archive = Buffer.from(
    `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({ snapshot_id: `im-${unique}`, workspace_persistence: "snapshot_filesystem" })}`,
  ).toString("base64");
  const sha = createHash("sha256").update(Buffer.from(archive, "base64")).digest("hex");
  const descriptor = {
    version: 2 as const,
    kind: "provider_snapshot" as const,
    revision: `wa2:${Date.parse(selectionTime)}:${sha}`,
    capturedAt: selectionTime,
    archiveSha256: sha,
    archiveBytes: Buffer.from(archive, "base64").length,
    provider: "modal_snapshot_filesystem" as const,
    snapshotId: `im-${unique}`,
    workspacePersistence: "snapshot_filesystem",
  };
  const resume = {
    backendId: "modal",
    sessionState: { workspaceArchive: archive, workspaceArchiveMeta: descriptor },
    opengeniRecovery: {
      provider: { status: "missing", instanceId: null, observedAt: "2026-09-17T06:24:31.000Z" },
      restore: { status: "degraded", retryable: false, failureCode: "archive_generation_mismatch" },
      workspace: { status: "degraded" },
    },
  };
  await shared.admin`insert into sandbox_leases(id,account_id,workspace_id,sandbox_group_id,backend,liveness,
    lease_epoch,workspace_generation,archive_generation,resume_backend_id,resume_state,expires_at)
    values(${leaseId},${scope.accountId},${scope.workspaceId},${session.sandboxGroupId},'modal','cold',3,44,10,'modal',${shared.admin.json(resume)},now())`;
  const binding = {
    version: 1,
    serverUrl: "https://modal.test",
    workspaceName: "recovery-fixture",
    environment: "main",
  };
  const artifact = await registerSandboxCheckpointArtifact(client.db, {
    ...scope,
    sandboxGroupId: session.sandboxGroupId,
    sourceLeaseId: leaseId,
    sourceLeaseEpoch: 2,
    sourceInstanceId: "gone-provider",
    sourceWorkspaceGeneration: 10,
    providerBinding: binding,
    providerBindingKey: JSON.stringify(binding),
    workspaceArchive: archive,
    workspaceArchiveMeta: descriptor,
  });
  await shared.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${scope.accountId}, true), set_config('opengeni.workspace_id', ${scope.workspaceId}, true)`;
    await tx`update sandbox_checkpoint_artifacts set state = 'current' where id = ${artifact.id}`;
    await tx`update sandbox_leases set current_checkpoint_artifact_id = ${artifact.id} where id = ${leaseId}`;
  });
  const input = { ...scope, sessionId: session.id };
  const preview = await readPublicSandboxRecovery(client.db, input);
  expect(preview.status).toBe("eligible");
  const request: SandboxRecoveryRequest = {
    operationId: crypto.randomUUID(),
    acceptHistoricalCheckpoint: true,
    selection: preview.checkpoint!,
  };
  const consent = (override: Partial<SandboxRecoveryRequest> = {}) =>
    consentPublicSandboxRecovery(client.db, { ...input, request: { ...request, ...override } });
  return { ...input, session, leaseId, artifact, preview, request, consent, create, scope };
}

async function completeRecovery(f: Awaited<ReturnType<typeof fixture>>, holderId: string) {
  const scope = {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sandboxGroupId: f.session.sandboxGroupId,
  };
  const elected = await acquireLease(client.db, {
    ...scope,
    kind: "viewer",
    holderId,
    backend: "modal",
    leaseTtlMs: 60_000,
  });
  expect(elected.role).toBe("spawner");
  expect(elected.lease.historicalRecoveryAuthorized).toBe(true);
  const attempt = {
    ...scope,
    expectedEpoch: elected.lease.leaseEpoch,
    rematerializationId: crypto.randomUUID(),
  };
  expect(await beginSandboxRematerialization(client.db, attempt)).toMatchObject({
    status: "started",
  });
  await recordWarmingSandboxCreated(client.db, {
    ...attempt,
    instanceId: holderId,
    resumeBackendId: "modal",
    resumeState: { backendId: "modal", sessionState: { providerState: { sandboxId: holderId } } },
    leaseTtlMs: 60_000,
  });
  await markSandboxRestoreVerifying(client.db, attempt);
  expect(
    await commitWarmingToWarm(client.db, {
      ...scope,
      expectedEpoch: attempt.expectedEpoch,
      instanceId: holderId,
      leaseTtlMs: 60_000,
      rematerialization: {
        id: attempt.rematerializationId,
        verifiedRevision: f.request.selection.revision,
      },
    }),
  ).toMatchObject({ committed: true });
}

async function completedRecoveryLostAgain() {
  const f = await fixture();
  await f.consent();
  await completeRecovery(f, "first-public-restore");
  // Simulate a later provider loss after new writes, preserving the completed
  // public projection and its permanent command/audit receipts.
  await shared.admin.begin(async (tx) => {
    await tx`delete from sandbox_lease_holders where lease_id = ${f.leaseId}`;
    await tx`update sandbox_leases set liveness = 'cold', instance_id = null,
      refcount = 0, lease_epoch = lease_epoch + 1, workspace_generation = 50,
      resume_state = jsonb_set(resume_state, '{opengeniRecovery}',
        ${tx.json({
          provider: { status: "missing", instanceId: null },
          restore: {
            status: "degraded",
            retryable: false,
            failureCode: "archive_generation_mismatch",
          },
          workspace: { status: "degraded" },
        })}::jsonb)
      where id = ${f.leaseId}`;
  });
  return f;
}

function operatorAuthorization(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sandboxGroupId: f.session.sandboxGroupId,
    // Warm publication advances 3 -> 4; the subsequent provider loss advances to 5.
    expectedEpoch: 5,
    expectedWorkspaceGeneration: 50,
    expectedArchiveGeneration: 10,
    selectedRevision: f.request.selection.revision,
    operationId: crypto.randomUUID(),
    subjectId: "operator:second-recovery",
    reason: "Explicit acceptance of the later generation gap",
    acceptHistoricalCheckpoint: true as const,
  };
}

describe("explicit singleton checkpoint recovery", () => {
  test("a fresh operator authorization supersedes completed public recovery without losing provenance", async () => {
    const f = await completedRecoveryLostAgain();
    const [before] =
      await shared.admin`select public_recovery from sandbox_leases where id = ${f.leaseId}`;
    expect(before!.public_recovery.status).toBe("verified");
    // A completed consent is not reusable authority for the later loss.
    expect(
      await acquireLease(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sandboxGroupId: f.session.sandboxGroupId,
        kind: "viewer",
        holderId: "before-new-authorization",
        backend: "modal",
        leaseTtlMs: 60_000,
      }),
    ).toMatchObject({ role: "blocked" });
    const authorization = operatorAuthorization(f);
    // Public activation is independent of the existing direct-DB operator lane.
    await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = false`;
    try {
      expect(await authorizeHistoricalSandboxCheckpointRecovery(client.db, authorization)).toEqual({
        authorized: true,
      });
      expect(await authorizeHistoricalSandboxCheckpointRecovery(client.db, authorization)).toEqual({
        authorized: true,
      });
      const [audit] =
        await shared.admin`select metadata, subject_id from audit_events where id = ${authorization.operationId}`;
      expect(audit!.subject_id).toBe(authorization.subjectId);
      expect(audit!.metadata).toMatchObject({
        leaseId: f.leaseId,
        leaseEpoch: 5,
        workspaceGeneration: 50,
        archiveGeneration: 10,
        selectedRevision: f.request.selection.revision,
        supersededPublicRecovery: before!.public_recovery,
      });
      const [after] =
        await shared.admin`select public_recovery, resume_state, current_checkpoint_artifact_id
        from sandbox_leases where id = ${f.leaseId}`;
      expect(after!.public_recovery).toBeNull();
      expect(after!.resume_state.opengeniHistoricalArchiveRecoveryId).toBe(
        authorization.operationId,
      );
      expect(after!.current_checkpoint_artifact_id).toBe(f.artifact.id);
      expect((await f.consent()).outcome).toBe("replayed");
      expect(
        await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id),
      ).toContain(f.request.selection.capturedAt);
      await completeRecovery(f, "second-operator-restore");
      expect(await readLease(client.db, f.workspaceId, f.session.sandboxGroupId)).toMatchObject({
        workspaceGeneration: 50,
        archiveGeneration: 10,
        archiveComplete: false,
      });
    } finally {
      await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true`;
    }
  });

  test("an unresolved holder blocks supersession of completed public recovery", async () => {
    const f = await completedRecoveryLostAgain();
    const authorization = operatorAuthorization(f);
    const [before] =
      await shared.admin`select public_recovery, resume_state from sandbox_leases where id = ${f.leaseId}`;
    // Keep the cached refcount at zero: the durable holder itself must fence
    // authorization even when the lease summary no longer accounts for it.
    await shared.admin`insert into sandbox_lease_holders(account_id,workspace_id,lease_id,kind,holder_id)
      values(${f.accountId},${f.workspaceId},${f.leaseId},'viewer','unresolved-after-loss')`;
    expect(await authorizeHistoricalSandboxCheckpointRecovery(client.db, authorization)).toEqual({
      authorized: false,
    });
    const [blocked] =
      await shared.admin`select public_recovery, resume_state from sandbox_leases where id = ${f.leaseId}`;
    expect(blocked).toEqual(before);
    expect(
      await shared.admin`select id from audit_events where id = ${authorization.operationId}`,
    ).toHaveLength(0);
    expect((await f.consent()).outcome).toBe("replayed");

    await shared.admin`delete from sandbox_lease_holders where lease_id = ${f.leaseId}
      and kind = 'viewer' and holder_id = 'unresolved-after-loss'`;
    expect(await authorizeHistoricalSandboxCheckpointRecovery(client.db, authorization)).toEqual({
      authorized: true,
    });
  });

  test("concurrent identical operator authorizations supersede once and replay across connections", async () => {
    const f = await completedRecoveryLostAgain();
    const authorization = operatorAuthorization(f);
    const [before] =
      await shared.admin`select public_recovery from sandbox_leases where id = ${f.leaseId}`;
    const second = createDb(shared.appUrl);
    try {
      expect(
        await Promise.all([
          authorizeHistoricalSandboxCheckpointRecovery(client.db, authorization),
          authorizeHistoricalSandboxCheckpointRecovery(second.db, authorization),
        ]),
      ).toEqual([{ authorized: true }, { authorized: true }]);
      const audits = await shared.admin`select id, subject_id, metadata from audit_events
        where target_id = ${f.session.sandboxGroupId}
          and action = 'sandbox.historical_checkpoint_recovery.authorized'`;
      // The original consent receipt and exactly one new operator receipt survive.
      expect(audits).toHaveLength(2);
      expect(audits.filter((row) => row.id === f.request.operationId)).toHaveLength(1);
      const operatorAudits = audits.filter((row) => row.id === authorization.operationId);
      expect(operatorAudits).toHaveLength(1);
      expect(operatorAudits[0]).toMatchObject({
        subject_id: authorization.subjectId,
        metadata: {
          leaseId: f.leaseId,
          leaseEpoch: 5,
          workspaceGeneration: 50,
          archiveGeneration: 10,
          selectedRevision: f.request.selection.revision,
          supersededPublicRecovery: before!.public_recovery,
        },
      });
      const [after] =
        await shared.admin`select public_recovery, resume_state, current_checkpoint_artifact_id,
          lease_epoch, workspace_generation, archive_generation from sandbox_leases where id = ${f.leaseId}`;
      expect(after!.public_recovery).toBeNull();
      expect(after!.resume_state.opengeniHistoricalArchiveRecoveryId).toBe(
        authorization.operationId,
      );
      expect(after!.current_checkpoint_artifact_id).toBe(f.artifact.id);
      expect(Number(after!.lease_epoch)).toBe(5);
      expect(Number(after!.workspace_generation)).toBe(50);
      expect(Number(after!.archive_generation)).toBe(10);
      expect((await f.consent()).outcome).toBe("replayed");
    } finally {
      await second.close();
    }
  });

  test("stale operator selection cannot clear a completed public recovery", async () => {
    const f = await completedRecoveryLostAgain();
    const authorization = operatorAuthorization(f);
    for (const stale of [
      { expectedEpoch: 4 },
      { expectedWorkspaceGeneration: 44 },
      { expectedArchiveGeneration: 9 },
      { selectedRevision: "stale-revision" },
    ]) {
      expect(
        await authorizeHistoricalSandboxCheckpointRecovery(client.db, {
          ...authorization,
          ...stale,
        }),
      ).toEqual({ authorized: false });
    }
    const [row] =
      await shared.admin`select public_recovery, resume_state from sandbox_leases where id = ${f.leaseId}`;
    expect(row!.public_recovery.status).toBe("verified");
    expect(row!.resume_state.opengeniHistoricalArchiveRecoveryId).toBe(f.request.operationId);
    expect(
      await shared.admin`select id from audit_events where id = ${authorization.operationId}`,
    ).toHaveLength(0);
  });

  test("a conflicting audit operation cannot partially discard completed public recovery", async () => {
    const f = await completedRecoveryLostAgain();
    await expect(
      authorizeHistoricalSandboxCheckpointRecovery(client.db, {
        ...operatorAuthorization(f),
        operationId: f.request.operationId,
      }),
    ).rejects.toThrow();
    const [row] =
      await shared.admin`select public_recovery, resume_state from sandbox_leases where id = ${f.leaseId}`;
    expect(row!.public_recovery.status).toBe("verified");
    expect(row!.resume_state.opengeniHistoricalArchiveRecoveryId).toBe(f.request.operationId);
  });

  test("completed public recovery still blocks automatic selection after later provider loss", async () => {
    const f = await completedRecoveryLostAgain();
    await enqueue(f);
    const input = claimInput(f);
    expect(
      await claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...input,
        filesystemDiscontinuityProtocol: 2,
      }),
    ).toMatchObject({ action: "claimed" });
    expect(
      await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.session.id,
        attemptId: input.attemptId,
      }),
    ).toEqual({ status: "not_eligible" });
    const [row] =
      await shared.admin`select public_recovery, resume_state from sandbox_leases where id = ${f.leaseId}`;
    expect(row!.public_recovery.status).toBe("verified");
    expect(row!.resume_state.opengeniHistoricalArchiveRecoveryId).toBe(f.request.operationId);
  });

  test("new operator authorization does not override accepted or failed public recovery", async () => {
    for (const status of ["accepted", "failed"] as const) {
      const f = await fixture();
      await f.consent();
      if (status === "failed") {
        await shared.admin`update sandbox_leases set public_recovery = jsonb_set(public_recovery, '{status}', '"failed"'::jsonb) where id = ${f.leaseId}`;
      }
      const authorization = {
        ...operatorAuthorization(f),
        expectedEpoch: 3,
        expectedWorkspaceGeneration: 44,
      };
      expect(await authorizeHistoricalSandboxCheckpointRecovery(client.db, authorization)).toEqual({
        authorized: false,
      });
      const [row] =
        await shared.admin`select public_recovery, resume_state from sandbox_leases where id = ${f.leaseId}`;
      expect(row!.public_recovery.status).toBe(status);
      expect(row!.resume_state.opengeniHistoricalArchiveRecoveryId).toBe(f.request.operationId);
      expect(
        await shared.admin`select id from audit_events where id = ${authorization.operationId}`,
      ).toHaveLength(0);
    }
  });

  test("activation defaults off, app role cannot activate, and disabled DB rejects consent writes", async () => {
    const f = await fixture();
    const [role] = await client.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    await rejectsWithSqlState(
      client.db.execute(
        sql`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true`,
      ),
      "42501",
    );
    await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = false`;
    try {
      // This case tests human consent activation, not the independent,
      // provider-proven system fallback.
      await shared.admin`update sandbox_leases set resume_state =
        jsonb_set(resume_state, '{opengeniRecovery,provider,status}', '"unknown"'::jsonb)
        where id = ${f.leaseId}`;
      expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
        status: "blocked",
        reason: "recovery_not_enabled",
      });
      await expect(f.consent()).rejects.toThrow("eligibility changed");
      await rejectsWithSqlState(
        withWorkspaceRls(client.db, f.workspaceId, (tx) =>
          tx.execute(
            sql`update sandbox_leases set public_recovery = ${JSON.stringify({ version: 1, status: "accepted", sessionId: f.session.id, subjectId: f.subjectId, operationId: f.request.operationId, selection: f.request.selection })}::jsonb where id = ${f.leaseId}`,
          ),
        ),
      );
      expect(
        await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id),
      ).toBeNull();
      await rejectsWithSqlState(
        withWorkspaceRls(client.db, f.workspaceId, (tx) =>
          tx.execute(sql`
        insert into session_command_receipts(account_id, workspace_id, actor_type, actor_subject_id,
          action, target_session_id, operation_key, canonical_request_hash, result)
        values(${f.accountId}, ${f.workspaceId}, 'human', ${f.subjectId}, 'sandbox.recovery.consent',
          ${f.session.id}, ${crypto.randomUUID()}, 'disabled-direct-write', ${JSON.stringify({ operationId: f.request.operationId })}::jsonb)`),
        ),
      );
    } finally {
      await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true`;
    }
  });

  async function enqueue(f: Awaited<ReturnType<typeof fixture>>) {
    return withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...f.scope,
        sessionId: f.session.id,
        actor: { type: "human", subjectId: f.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Inspect current files; do not replay earlier commands",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
  }

  test("disabled activation also rejects accepted lease INSERT and receipt reclassification", async () => {
    const f = await fixture();
    const fresh = await f.create();
    const leaseId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const publicRecovery = {
      version: 1,
      status: "accepted",
      sessionId: fresh.id,
      subjectId: f.subjectId,
      operationId,
      selection: {
        ...f.request.selection,
        sessionId: fresh.id,
        sandboxGroupId: fresh.sandboxGroupId,
        leaseId,
      },
    };
    await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = false`;
    try {
      await rejectsWithSqlState(
        withWorkspaceRls(client.db, f.workspaceId, (tx) =>
          tx.execute(sql`
        insert into sandbox_leases(id, account_id, workspace_id, sandbox_group_id, backend, liveness, expires_at, public_recovery)
        values(${leaseId}, ${f.accountId}, ${f.workspaceId}, ${fresh.sandboxGroupId}, 'modal', 'cold', now(), ${JSON.stringify(publicRecovery)}::jsonb)`),
        ),
      );
      const [ordinary] = await withWorkspaceRls(client.db, f.workspaceId, (tx) =>
        tx.execute<{ id: string }>(sql`
        insert into session_command_receipts(account_id, workspace_id, actor_type, actor_subject_id,
          action, target_session_id, operation_key, canonical_request_hash, result)
        values(${f.accountId}, ${f.workspaceId}, 'human', ${f.subjectId}, 'ordinary.command',
          ${f.session.id}, ${operationId}, 'not-consent', ${JSON.stringify({ operationId })}::jsonb) returning id`),
      );
      await rejectsWithSqlState(
        withWorkspaceRls(client.db, f.workspaceId, (tx) =>
          tx.execute(sql`
        update session_command_receipts set action = 'sandbox.recovery.consent' where id = ${ordinary!.id}`),
        ),
      );
      expect(
        (
          await shared.admin`select action from session_command_receipts where id = ${ordinary!.id}`
        )[0]!.action,
      ).toBe("ordinary.command");
      expect(
        (
          await shared.admin`select count(*)::int as count from sandbox_leases where id = ${leaseId}`
        )[0]!.count,
      ).toBe(0);
    } finally {
      await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true`;
    }
  });
  function claimInput(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      sessionId: f.session.id,
      workflowId: `session-${f.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" as const },
    };
  }
  test("old workers cannot claim or ON CONFLICT reattach; compatible claims do not leak their stamp", async () => {
    const f = await fixture();
    await f.consent();
    await enqueue(f);
    const input = claimInput(f);
    const before =
      await shared.admin`select status, active_turn_id from sessions where id = ${f.session.id}`;
    await rejectsWithSqlState(claimSessionWorkForAttempt(client.db, f.workspaceId, input));
    await rejectsWithSqlState(
      claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...input,
        filesystemDiscontinuityProtocol: 4 as 1 | 2 | 3,
      }),
    );
    expect(
      (
        await shared.admin`select count(*)::int as count from session_turn_attempts where session_id = ${f.session.id}`
      )[0]!.count,
    ).toBe(0);
    expect(
      Array.from(
        await shared.admin`select status, active_turn_id from sessions where id = ${f.session.id}`,
      ),
    ).toEqual(Array.from(before));
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      f.workspaceId,
      f.subjectId,
      async (tx) => {
        expect(
          await claimSessionWorkForAttempt(tx, f.workspaceId, {
            ...input,
            filesystemDiscontinuityProtocol: 1,
          }),
        ).toMatchObject({ action: "claimed" });
        const [stamp] = await tx.execute<{ value: string }>(
          sql`select coalesce(current_setting('opengeni.filesystem_discontinuity_protocol_v1', true), '') as value`,
        );
        expect(stamp!.value).toBe("");
        // An absent capability cannot inherit a nested compatible claim.
        await rejectsWithSqlState(claimSessionWorkForAttempt(tx, f.workspaceId, input));
      },
    );
    await rejectsWithSqlState(claimSessionWorkForAttempt(client.db, f.workspaceId, input));
    expect(
      await claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...input,
        filesystemDiscontinuityProtocol: 1,
      }),
    ).toMatchObject({ action: "claimed" });
    const ordinary = await fixture();
    await enqueue(ordinary);
    expect(
      await claimSessionWorkForAttempt(client.db, ordinary.workspaceId, claimInput(ordinary)),
    ).toMatchObject({ action: "claimed" });
  });

  test("single-connection pool reuse and a returning worker cannot retain the declaration", async () => {
    const f = await fixture();
    await f.consent();
    await enqueue(f);
    const input = claimInput(f);
    const pooled = createDb(shared.appUrl, { max: 1 });
    try {
      expect(
        await claimSessionWorkForAttempt(pooled.db, f.workspaceId, {
          ...input,
          filesystemDiscontinuityProtocol: 1,
        }),
      ).toMatchObject({ action: "claimed" });
      const [stamp] = await pooled.db.execute<{ value: string }>(
        sql`select coalesce(current_setting('opengeni.filesystem_discontinuity_protocol_v1', true), '') as value`,
      );
      expect(stamp!.value).toBe("");
      await rejectsWithSqlState(claimSessionWorkForAttempt(pooled.db, f.workspaceId, input));
    } finally {
      await pooled.close();
    }
    const returned = createDb(shared.appUrl, { max: 1 });
    try {
      await rejectsWithSqlState(claimSessionWorkForAttempt(returned.db, f.workspaceId, input));
    } finally {
      await returned.close();
    }
  });

  test("provider loss selects a verified older checkpoint once and fences workers without the automatic warning", async () => {
    const f = await fixture();
    expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
      status: "eligible",
      automaticAvailable: true,
      checkpoint: { archiveGeneration: 10, workspaceGeneration: 44 },
    });
    await enqueue(f);
    const input = claimInput(f);
    expect(
      await claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...input,
        filesystemDiscontinuityProtocol: 2,
      }),
    ).toMatchObject({ action: "claimed" });
    const scope = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.session.id,
      attemptId: input.attemptId,
    };
    const first = await authorizeAutomaticSandboxCheckpointRecovery(client.db, scope);
    expect(first).toMatchObject({
      status: "authorized",
      selection: {
        sessionId: f.session.id,
        archiveGeneration: 10,
        workspaceGeneration: 44,
        artifactId: f.artifact.id,
      },
    });
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, scope)).toMatchObject({
      status: "already_authorized",
    });
    expect(
      (await readLease(client.db, f.workspaceId, f.session.sandboxGroupId))?.resumeState
        ?.opengeniAutomaticCheckpointRecovery,
    ).toMatchObject({ status: "accepted", sessionId: f.session.id });
    await rejectsWithSqlState(f.create(f.session.sandboxGroupId));
    await rejectsWithSqlState(
      shared.admin`update sandbox_leases set archive_generation = 44 where id = ${f.leaseId}`,
    );
    const [count] = await shared.admin<{ n: number }[]>`select count(*)::int as n
      from session_command_receipts where target_session_id = ${f.session.id}
        and action = 'sandbox.recovery.automatic'`;
    expect(count?.n).toBe(1);
    expect(
      (await readRecentSandboxRecoveryObservations(client.db)).fallbackSelections,
    ).toBeGreaterThanOrEqual(1);
    const warning = await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id);
    expect(warning).toContain(f.request.selection.capturedAt);
    expect(warning).toContain("automatically");
    expect(warning).not.toContain("human explicitly consented");
    await rejectsWithSqlState(
      claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...input,
        filesystemDiscontinuityProtocol: 1,
      }),
    );
    expect(
      await claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...input,
        filesystemDiscontinuityProtocol: 2,
      }),
    ).toMatchObject({ action: "claimed" });
    const elected = await acquireLease(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sandboxGroupId: f.session.sandboxGroupId,
      kind: "viewer",
      holderId: "automatic-fallback",
      backend: "modal",
      leaseTtlMs: 60_000,
    });
    expect(elected.role).toBe("spawner");
    expect(elected.lease.historicalRecoveryAuthorized).toBe(true);
    const rematerializationId = crypto.randomUUID();
    expect(
      await beginSandboxRematerialization(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sandboxGroupId: f.session.sandboxGroupId,
        expectedEpoch: elected.lease.leaseEpoch,
        rematerializationId,
      }),
    ).toMatchObject({ status: "started" });
    const leaseScope = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sandboxGroupId: f.session.sandboxGroupId,
      expectedEpoch: elected.lease.leaseEpoch,
    };
    await recordWarmingSandboxCreated(client.db, {
      ...leaseScope,
      rematerializationId,
      instanceId: "automatic-restored-box",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "automatic-restored-box" } },
      },
      leaseTtlMs: 60_000,
    });
    await markSandboxRestoreVerifying(client.db, { ...leaseScope, rematerializationId });
    expect(
      await commitWarmingToWarm(client.db, {
        ...leaseScope,
        instanceId: "automatic-restored-box",
        leaseTtlMs: 60_000,
        rematerialization: {
          id: rematerializationId,
          verifiedRevision: f.request.selection.revision,
        },
      }),
    ).toMatchObject({ committed: true });
    const restored = await readLease(client.db, f.workspaceId, f.session.sandboxGroupId);
    expect(restored?.resumeState?.opengeniAutomaticCheckpointRecovery).toMatchObject({
      status: "verified",
      sessionId: f.session.id,
    });
    expect(restored?.resumeState?.opengeniHistoricalArchiveRecoveryId).toBeUndefined();
    expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id)).toBe(
      warning,
    );
  });

  test("automatic fallback refuses an archive without definitive provider-loss truth", async () => {
    const f = await fixture();
    await shared.admin`update sandbox_leases set resume_state =
      jsonb_set(resume_state, '{opengeniRecovery,provider,status}', '"unknown"'::jsonb)
      where id = ${f.leaseId}`;
    await enqueue(f);
    const input = claimInput(f);
    expect(
      await claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...input,
        filesystemDiscontinuityProtocol: 2,
      }),
    ).toMatchObject({ action: "claimed" });
    expect(
      await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.session.id,
        attemptId: input.attemptId,
      }),
    ).toEqual({ status: "not_eligible" });
    expect(
      await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id),
    ).toBeNull();
  });

  test("the operator recovery ledger permits only attributed event IDs through its function", async () => {
    const f = await fixture();
    await rejectsWithSqlState(
      withWorkspaceRls(client.db, f.workspaceId, (tx) =>
        tx.execute(sql`insert into opengeni_private.sandbox_recovery_operator_receipts
          (audit_event_id, kind) values (${crypto.randomUUID()}::uuid, 'checkpoint_fallback_selected')`),
      ),
      "42501",
    );
    await rejectsWithSqlState(
      withWorkspaceRls(client.db, f.workspaceId, (tx) =>
        tx.execute(sql`select opengeni_private.record_sandbox_recovery_operator_event(
          ${crypto.randomUUID()}::uuid, 'checkpoint_fallback_selected')`),
      ),
      "42501",
    );
  });

  test("consent requirement survives disable and lease deletion; receipt identity cannot be erased", async () => {
    const f = await fixture();
    await f.consent();
    await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = false`;
    try {
      expect((await f.consent()).outcome).toBe("replayed");
      expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
        status: "consent_accepted",
      });
      for (const assignment of [
        sql`action = 'renamed'`,
        sql`result = '{}'::jsonb`,
        sql`target_session_id = null`,
      ]) {
        await rejectsWithSqlState(
          withWorkspaceRls(client.db, f.workspaceId, (tx) =>
            tx.execute(
              sql`update session_command_receipts set ${assignment} where target_session_id = ${f.session.id} and action = 'sandbox.recovery.consent'`,
            ),
          ),
        );
      }
      await rejectsWithSqlState(
        withWorkspaceRls(client.db, f.workspaceId, (tx) =>
          tx.execute(
            sql`delete from session_command_receipts where target_session_id = ${f.session.id}`,
          ),
        ),
      );
      await shared.admin`delete from sandbox_leases where id = ${f.leaseId}`;
      expect(
        await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id),
      ).toContain(f.request.selection.capturedAt);
      await enqueue(f);
      await rejectsWithSqlState(
        claimSessionWorkForAttempt(client.db, f.workspaceId, claimInput(f)),
      );
    } finally {
      await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true`;
    }
  });

  test("actual session deletion cascades its receipt instead of orphaning the warning", async () => {
    const f = await fixture();
    await f.consent();
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      f.workspaceId,
      f.subjectId,
      async (tx) => {
        await tx.execute(sql`delete from sessions where id = ${f.session.id}`);
      },
    );
    expect(
      (
        await shared.admin`select count(*)::int as count from session_command_receipts where target_session_id = ${f.session.id}`
      )[0]!.count,
    ).toBe(0);
  });

  test("an actor-hidden parent cannot masquerade as a deleted parent for receipt removal", async () => {
    const f = await fixture();
    await f.consent();
    const ownerId = crypto.randomUUID();
    const ownerSubject = `user:hidden-${ownerId}`;
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into organization_memberships(id,account_id,subject_id,status) values(${ownerId},${f.accountId},${ownerSubject},'suspended')`;
      await tx`update sessions set visibility = 'user_private', owner_organization_membership_id = ${ownerId}, owner_subject_id = ${ownerSubject} where id = ${f.session.id}`;
    });
    expect(
      await withWorkspaceSubjectRls(client.db, f.workspaceId, f.subjectId, (tx) =>
        tx.execute(sql`select id from sessions where id = ${f.session.id}`),
      ),
    ).toHaveLength(0);
    const deleted = await withWorkspaceSubjectRls(client.db, f.workspaceId, f.subjectId, (tx) =>
      tx.execute(
        sql`delete from session_command_receipts where target_session_id = ${f.session.id} returning id`,
      ),
    );
    expect(deleted).toHaveLength(0);
    expect(
      (
        await shared.admin`select count(*)::int as count from session_command_receipts where target_session_id = ${f.session.id}`
      )[0]!.count,
    ).toBe(1);
  });

  test("consent cannot pass an already-admitted claim; a later old claim cannot pass consent", async () => {
    const admitted = await fixture();
    await enqueue(admitted);
    const claimReady = Promise.withResolvers<void>();
    const releaseClaim = Promise.withResolvers<void>();
    const oldClaim = withWorkspaceSubjectSessionActivityRls(
      client.db,
      admitted.workspaceId,
      admitted.subjectId,
      async (tx) => {
        expect(
          await claimSessionWorkForAttempt(tx, admitted.workspaceId, claimInput(admitted)),
        ).toMatchObject({ action: "claimed" });
        claimReady.resolve();
        await releaseClaim.promise;
      },
    );
    await claimReady.promise;
    const deniedConsent = admitted.consent().then(
      () => false,
      () => true,
    );
    releaseClaim.resolve();
    await oldClaim;
    expect(await deniedConsent).toBe(true);
    expect(
      await getSandboxRecoveryDiscontinuity(client.db, admitted.workspaceId, admitted.session.id),
    ).toBeNull();

    const consented = await fixture();
    const consentReady = Promise.withResolvers<void>();
    const releaseConsent = Promise.withResolvers<void>();
    const consent = withWorkspaceRls(client.db, consented.workspaceId, async (tx) => {
      await consentPublicSandboxRecovery(tx, { ...consented, request: consented.request });
      consentReady.resolve();
      await releaseConsent.promise;
    });
    await consentReady.promise;
    const laterClaim = enqueue(consented).then(() =>
      claimSessionWorkForAttempt(client.db, consented.workspaceId, claimInput(consented)),
    );
    const rejected = rejectsWithSqlState(laterClaim);
    releaseConsent.resolve();
    await consent;
    await rejected;
    expect(
      (
        await shared.admin`select count(*)::int as count from session_turn_attempts where session_id = ${consented.session.id}`
      )[0]!.count,
    ).toBe(0);
  });

  test("a fresh Modal session without a blocked lease does not suppress ordinary failure remedies", async () => {
    const f = await fixture();
    const fresh = await f.create();
    expect(await readPublicSandboxRecovery(client.db, { ...f, sessionId: fresh.id })).toMatchObject(
      {
        status: "unsupported",
        reason: "historical_checkpoint_not_required",
        checkpoint: null,
      },
    );
  });

  test("preview is bounded and read-only; consent does not replay commands, resume Pause or fabricate readiness", async () => {
    const f = await fixture();
    expect(JSON.stringify(f.preview)).not.toMatch(
      /providerBinding|modal.test|gone-provider|workspaceArchive|snapshotId/,
    );
    const before =
      await shared.admin`select status, active_turn_id from sessions where id = ${f.session.id}`;
    expect(
      await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id),
    ).toBeNull();
    const result = await f.consent();
    expect(result.recovery.status).toBe("consent_accepted");
    expect(
      Array.from(
        await shared.admin`select status, active_turn_id from sessions where id = ${f.session.id}`,
      ),
    ).toEqual(Array.from(before));
    expect(
      (
        await shared.admin`select count(*)::int as count from session_turns where session_id = ${f.session.id}`
      )[0]!.count,
    ).toBe(0);
    expect(
      (
        await shared.admin`select count(*)::int as count from session_system_updates where session_id = ${f.session.id}`
      )[0]!.count,
    ).toBe(0);
    const warning = await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id);
    expect(warning).toContain(f.request.selection.capturedAt);
    expect(warning).toContain("External effects are not undone");
    expect(warning).toContain("Never automatically replay");
    const replacement = createDb(shared.appUrl);
    expect(await getSandboxRecoveryDiscontinuity(replacement.db, f.workspaceId, f.session.id)).toBe(
      warning,
    );
    await replacement.close();
  });

  test("concurrent identical consent replays durably; changed timestamp/payload conflicts even after mutable state changes", async () => {
    const f = await fixture();
    const results = await Promise.all([f.consent(), f.consent()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["accepted", "replayed"]);
    await expect(
      f.consent({ selection: { ...f.request.selection, capturedAt: "2026-09-17T06:24:07.000Z" } }),
    ).rejects.toThrow();
    await shared.admin`update sandbox_leases set liveness = 'warming' where id = ${f.leaseId}`;
    expect((await f.consent()).outcome).toBe("replayed");
    expect((await readPublicSandboxRecovery(client.db, f)).status).toBe("restoring");
  });

  test("stale consent is rejected before writing authorization", async () => {
    const f = await fixture();
    await shared.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${f.accountId}, true), set_config('opengeni.workspace_id', ${f.workspaceId}, true)`;
      await tx`update sandbox_leases set workspace_generation = 45 where id = ${f.leaseId}`;
    });
    await expect(f.consent()).rejects.toThrow("changed");
    expect(
      (
        await shared.admin`select count(*)::int as count from audit_events where id = ${f.request.operationId}`
      )[0]!.count,
    ).toBe(0);
  });

  test("complete group membership rejects a second session; pending consent fences new attachment and route changes", async () => {
    const sharedFixture = await fixture();
    await sharedFixture.create(sharedFixture.session.sandboxGroupId);
    // The provider-proven shared group has a system lane; human consent never
    // widens to it.
    expect(await readPublicSandboxRecovery(client.db, sharedFixture)).toMatchObject({
      status: "eligible",
      automaticAvailable: true,
      automaticLane: "checkpoint",
    });
    await expect(sharedFixture.consent()).rejects.toThrow("changed");
    await shared.admin`update sandbox_leases set resume_state =
      jsonb_set(resume_state, '{opengeniRecovery,provider,status}', '"unknown"'::jsonb)
      where id = ${sharedFixture.leaseId}`;
    expect(await readPublicSandboxRecovery(client.db, sharedFixture)).toMatchObject({
      status: "unsupported",
      reason: "singleton_required",
    });
    await expect(sharedFixture.consent()).rejects.toThrow("changed");
    const f = await fixture();
    await f.consent();
    await expect(f.create(f.session.sandboxGroupId)).rejects.toThrow();
    await expect(
      Promise.resolve(
        shared.admin`update sessions set active_epoch = active_epoch + 1 where id = ${f.session.id}`,
      ),
    ).rejects.toThrow("protects group membership");
  });

  test("an actor-hidden historical group member is counted without disclosing its identity", async () => {
    const f = await fixture();
    const hidden = await f.create(f.session.sandboxGroupId);
    const ownerId = crypto.randomUUID();
    const ownerSubject = `user:hidden-${ownerId}`;
    // Seed a historical private member as the test administrator. Do not mint
    // a lifecycle capability or relax RLS on the app-facing read under test.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into organization_memberships(id,account_id,subject_id,status) values(${ownerId},${f.accountId},${ownerSubject},'suspended')`;
      await tx`update sessions set visibility = 'user_private', owner_organization_membership_id = ${ownerId}, owner_subject_id = ${ownerSubject} where id = ${hidden.id}`;
    });
    const visible = await withWorkspaceSubjectRls(client.db, f.workspaceId, f.subjectId, (tx) =>
      tx.execute(sql`select id from sessions where sandbox_group_id = ${f.session.sandboxGroupId}`),
    );
    expect(visible).toHaveLength(1);
    const automatic = await readPublicSandboxRecovery(client.db, f);
    expect(automatic).toMatchObject({ status: "eligible", automaticLane: "checkpoint" });
    expect(JSON.stringify(automatic)).not.toContain(hidden.id);
    await shared.admin`update sandbox_leases set resume_state =
      jsonb_set(resume_state, '{opengeniRecovery,provider,status}', '"unknown"'::jsonb)
      where id = ${f.leaseId}`;
    const projection = await readPublicSandboxRecovery(client.db, f);
    expect(projection).toMatchObject({
      status: "unsupported",
      reason: "singleton_required",
      checkpoint: null,
    });
    expect(JSON.stringify(projection)).not.toContain(hidden.id);
    await expect(f.consent()).rejects.toThrow("changed");
  });

  test("concurrent attach and consent have one winner under the shared membership fence", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = await fixture();
      const [consent, attach] = await Promise.allSettled([
        f.consent(),
        f.create(f.session.sandboxGroupId),
      ]);
      expect([consent.status, attach.status].filter((value) => value === "fulfilled")).toHaveLength(
        1,
      );
      const projection = await readPublicSandboxRecovery(client.db, f);
      // A winning attach makes a shared group, whose provider-proven loss is
      // then a system Retry lane rather than human consent.
      expect(projection).toMatchObject(
        consent.status === "fulfilled"
          ? { status: "consent_accepted" }
          : { status: "eligible", automaticLane: "checkpoint" },
      );
    }
  });

  test("Pause is preserved and unresolved holders refuse consent", async () => {
    const f = await fixture();
    await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (db) =>
      mutateSessionControlInTransaction(db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.session.id,
        actor: { type: "human", subjectId: f.subjectId },
        action: "pause",
        operationKey: crypto.randomUUID(),
      }),
    );
    await f.consent();
    expect(
      (await shared.admin`select direct_control_state from sessions where id = ${f.session.id}`)[0]!
        .direct_control_state,
    ).toBe("paused");
    const blocked = await fixture();
    await shared.admin`insert into sandbox_lease_holders(account_id,workspace_id,lease_id,kind,holder_id)
      values(${blocked.accountId},${blocked.workspaceId},${blocked.leaseId},'viewer','unsettled-viewer')`;
    expect(await readPublicSandboxRecovery(client.db, blocked)).toMatchObject({
      status: "blocked",
      reason: "execution_unresolved",
    });
    await expect(blocked.consent()).rejects.toThrow("changed");
  });

  test("pending selection stays CURRENT and GC-pinned; late capture cannot replace provenance", async () => {
    const f = await fixture();
    await f.consent();
    await expect(
      Promise.resolve(
        shared.admin`update sandbox_leases set archive_generation = 44 where id = ${f.leaseId}`,
      ),
    ).rejects.toThrow("pins the exact current checkpoint");
    await expect(
      Promise.resolve(
        shared.admin`update sandbox_leases set current_checkpoint_artifact_id = null where id = ${f.leaseId}`,
      ),
    ).rejects.toThrow();
    const claims = await claimSandboxCheckpointArtifactsForGc(client.db, {
      claimId: crypto.randomUUID(),
      limit: 100,
      claimTtlMs: 60_000,
    });
    expect(claims.some((row) => row.id === f.artifact.id)).toBe(false);
  });

  test("supported restore CAS verifies selected CURRENT without rewriting generations; late completion loses", async () => {
    const f = await fixture();
    await f.consent();
    const scope = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sandboxGroupId: f.session.sandboxGroupId,
    };
    const elected = await acquireLease(client.db, {
      ...scope,
      kind: "viewer",
      holderId: "recovery-test",
      backend: "modal",
      leaseTtlMs: 60_000,
    });
    expect(elected.role).toBe("spawner");
    expect(elected.lease.archiveComplete).toBe(false);
    expect(elected.lease.historicalRecoveryAuthorized).toBe(true);
    const id = crypto.randomUUID();
    const expectedEpoch = elected.lease.leaseEpoch;
    expect(
      await beginSandboxRematerialization(client.db, {
        ...scope,
        expectedEpoch,
        rematerializationId: id,
      }),
    ).toMatchObject({ status: "started" });
    expect(
      await commitWarmingToWarm(client.db, {
        ...scope,
        expectedEpoch,
        instanceId: "restored-box",
        leaseTtlMs: 60_000,
      }),
    ).toMatchObject({ committed: false });
    await recordWarmingSandboxCreated(client.db, {
      ...scope,
      expectedEpoch,
      rematerializationId: id,
      instanceId: "restored-box",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "restored-box" } },
      },
      leaseTtlMs: 60_000,
    });
    await markSandboxRestoreVerifying(client.db, {
      ...scope,
      expectedEpoch,
      rematerializationId: id,
    });
    const completion = {
      ...scope,
      expectedEpoch,
      instanceId: "restored-box",
      leaseTtlMs: 60_000,
      rematerialization: { id, verifiedRevision: f.request.selection.revision },
    };
    await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = false`;
    try {
      expect(await commitWarmingToWarm(client.db, completion)).toMatchObject({ committed: true });
      expect(await readLease(client.db, f.workspaceId, f.session.sandboxGroupId)).toMatchObject({
        workspaceGeneration: 44,
        archiveGeneration: 10,
        archiveComplete: false,
      });
      expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({ status: "restored" });
      expect(await commitWarmingToWarm(client.db, completion)).toMatchObject({
        committed: false,
        reason: "stale_epoch",
      });
      expect((await f.consent()).outcome).toBe("replayed");
    } finally {
      await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled = true`;
    }
  });

  test("failed restoration remains blocked, preserves provenance, and cannot silently re-elect", async () => {
    const f = await fixture();
    await f.consent();
    const scope = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sandboxGroupId: f.session.sandboxGroupId,
    };
    const elected = await acquireLease(client.db, {
      ...scope,
      kind: "viewer",
      holderId: "failed-recovery-test",
      backend: "modal",
      leaseTtlMs: 60_000,
    });
    await failWarmingToCold(client.db, { ...scope, expectedEpoch: elected.lease.leaseEpoch });
    expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
      status: "blocked",
      reason: "restore_failed",
    });
    expect(await readLease(client.db, f.workspaceId, f.session.sandboxGroupId)).toMatchObject({
      workspaceGeneration: 44,
      archiveGeneration: 10,
    });
    expect((await f.consent()).outcome).toBe("replayed");
    await expect(
      acquireLease(client.db, {
        ...scope,
        kind: "viewer",
        holderId: "failed-recovery-retry",
        backend: "modal",
        leaseTtlMs: 60_000,
      }),
    ).resolves.toMatchObject({ role: "blocked" });
    expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id)).toContain(
      f.request.selection.capturedAt,
    );
  });

  test("cross-tenant selection and revoked actor cannot authorize or replay", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(f.consent({ selection: other.request.selection })).rejects.toThrow();
    await f.consent();
    await shared.admin`delete from workspace_memberships where workspace_id = ${f.workspaceId} and subject_id = ${f.subjectId}`;
    await expect(f.consent()).rejects.toThrow("authority is unavailable");
    await expect(
      acquireLease(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sandboxGroupId: f.session.sandboxGroupId,
        kind: "viewer",
        holderId: "revoked-recovery",
        backend: "modal",
        leaseTtlMs: 60_000,
      }),
    ).resolves.toMatchObject({ role: "blocked" });
  });
});

type RecoveryFixture = Awaited<ReturnType<typeof fixture>>;

/** A distinct native Modal filesystem-snapshot archive and its v2 descriptor. */
function modalSnapshotSessionState(snapshotId: string, capturedAt = "2026-09-20T03:04:05.000Z") {
  const archive = Buffer.from(
    `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({ snapshot_id: snapshotId, workspace_persistence: "snapshot_filesystem" })}`,
  ).toString("base64");
  const bytes = Buffer.from(archive, "base64");
  const sha = createHash("sha256").update(bytes).digest("hex");
  return {
    workspaceArchive: archive,
    workspaceArchiveMeta: {
      version: 2 as const,
      kind: "provider_snapshot" as const,
      revision: `wa2:${Date.parse(capturedAt)}:${sha}`,
      capturedAt,
      archiveSha256: sha,
      archiveBytes: bytes.length,
      provider: "modal_snapshot_filesystem" as const,
      snapshotId,
      workspacePersistence: "snapshot_filesystem",
    },
  };
}

async function promptSession(f: RecoveryFixture, sessionId: string) {
  return withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (tx) =>
    submitHumanPromptInTransaction(tx, {
      ...f.scope,
      sessionId,
      actor: { type: "human", subjectId: f.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Continue from the current filesystem",
      resources: [],
      reasoningEffortFallback: "medium",
      source: "user",
    }),
  );
}

function attemptClaim(sessionId: string) {
  return {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" as const },
  };
}

/** A running attempt for `sessionId`, claimed by a v3 worker. */
async function claimedAttempt(f: RecoveryFixture, sessionId: string) {
  await promptSession(f, sessionId);
  const input = attemptClaim(sessionId);
  expect(
    await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      ...input,
      filesystemDiscontinuityProtocol: 3,
    }),
  ).toMatchObject({ action: "claimed" });
  return input;
}

/** Parent plus two shared children, all quiescent, lost at the provider deadline. */
async function sharedGroup() {
  const f = await fixture();
  const first = await f.create(f.session.sandboxGroupId);
  const second = await f.create(f.session.sandboxGroupId);
  return { f, members: [f.session.id, first.id, second.id] };
}

/** The exact recovery state current confirmDrainCold writes for a box that
 * vanished before any workspace capture existed. */
async function withoutAnyArchive(f: RecoveryFixture) {
  await shared.admin`update sandbox_leases set current_checkpoint_artifact_id = null,
    archive_generation = null,
    resume_state = ${shared.admin.json({
      backendId: "modal",
      opengeniRecovery: {
        provider: {
          status: "missing",
          instanceId: "lost-box",
          observedAt: "2026-09-17T06:24:31.000Z",
          diagnostic: "provider_not_found_before_workspace_capture",
        },
        archive: { status: "none", current: null, previous: null },
        restore: {
          status: "unrecoverable",
          rematerializationId: null,
          selectedRevision: null,
          startedAt: null,
          completedAt: "2026-09-17T06:24:31.000Z",
          failureCode: "archive_unavailable",
          retryable: false,
        },
        workspace: { status: "unrecoverable", verifiedRevision: null, verifiedAt: null },
      },
    })}::jsonb
    where id = ${f.leaseId}`;
}

async function automaticReceipts(workspaceId: string, action: string, operationId?: string) {
  return await shared.admin<
    { target_session_id: string; actor_type: string; result: Record<string, unknown> }[]
  >`select target_session_id, actor_type, result from session_command_receipts
    where workspace_id = ${workspaceId} and action = ${action}
      ${operationId ? shared.admin`and result->>'operationId' = ${operationId}` : shared.admin``}
    order by target_session_id`;
}

function groupLease(f: RecoveryFixture) {
  return {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sandboxGroupId: f.session.sandboxGroupId,
  };
}

describe("automatic continuity after definitive managed sandbox loss", () => {
  test("a quiescent shared group of three selects its checkpoint once, warns every member, and rematerializes", async () => {
    const { f, members } = await sharedGroup();
    for (const sessionId of members) {
      expect(await readPublicSandboxRecovery(client.db, { ...f, sessionId })).toMatchObject({
        status: "eligible",
        automaticAvailable: true,
        automaticLane: "checkpoint",
        checkpoint: { sessionId, archiveGeneration: 10, workspaceGeneration: 44 },
      });
    }
    const initiator = await claimedAttempt(f, f.session.id);
    const authorization = await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
      ...f.scope,
      sessionId: f.session.id,
      attemptId: initiator.attemptId,
    });
    expect(authorization).toMatchObject({
      status: "authorized",
      lane: "checkpoint",
      groupSessionCount: 3,
      selection: { sessionId: f.session.id, archiveGeneration: 10, artifactId: f.artifact.id },
    });
    const receipts = await automaticReceipts(f.workspaceId, "sandbox.recovery.automatic");
    expect(receipts.map((receipt) => receipt.target_session_id).sort()).toEqual(
      [...members].sort(),
    );
    for (const receipt of receipts) {
      expect(receipt.result).toMatchObject({
        scope: "shared",
        initiatingSessionId: f.session.id,
        checkpoint: { sessionId: receipt.target_session_id, archiveGeneration: 10 },
      });
      expect(receipt.actor_type).toBe(
        receipt.target_session_id === f.session.id ? "agent_attempt" : "service",
      );
      const warning = await getSandboxRecoveryDiscontinuity(
        client.db,
        f.workspaceId,
        receipt.target_session_id,
      );
      expect(warning).toContain(f.request.selection.capturedAt);
      expect(warning).toContain("shares with other sessions");
      expect(warning).toContain("unknown outcomes");
    }
    // Reuse is exact and does not duplicate receipts; the shared membership stays pinned.
    expect(
      await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
        ...f.scope,
        sessionId: f.session.id,
        attemptId: initiator.attemptId,
      }),
    ).toMatchObject({ status: "already_authorized", lane: "checkpoint" });
    expect(await automaticReceipts(f.workspaceId, "sandbox.recovery.automatic")).toHaveLength(3);
    await rejectsWithSqlState(f.create(f.session.sandboxGroupId));
    expect(
      (await readRecentSandboxRecoveryObservations(client.db)).fallbackSelections,
    ).toBeGreaterThanOrEqual(1);

    // The next turn's election restores the exact selection across the group.
    const elected = await acquireLease(client.db, {
      ...groupLease(f),
      kind: "turn",
      holderId: initiator.attemptId,
      backend: "modal",
      leaseTtlMs: 60_000,
    });
    expect(elected).toMatchObject({
      role: "spawner",
      lease: { historicalRecoveryAuthorized: true },
    });
    const rematerializationId = crypto.randomUUID();
    const attempt = {
      ...groupLease(f),
      expectedEpoch: elected.lease.leaseEpoch,
      rematerializationId,
    };
    expect(await beginSandboxRematerialization(client.db, attempt)).toMatchObject({
      status: "started",
    });
    await recordWarmingSandboxCreated(client.db, {
      ...attempt,
      instanceId: "shared-restored-box",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "shared-restored-box" } },
      },
      leaseTtlMs: 60_000,
    });
    await markSandboxRestoreVerifying(client.db, attempt);
    expect(
      await commitWarmingToWarm(client.db, {
        ...groupLease(f),
        expectedEpoch: attempt.expectedEpoch,
        instanceId: "shared-restored-box",
        leaseTtlMs: 60_000,
        rematerialization: {
          id: rematerializationId,
          verifiedRevision: f.request.selection.revision,
        },
      }),
    ).toMatchObject({ committed: true });
    expect(
      (await readLease(client.db, f.workspaceId, f.session.sandboxGroupId))?.resumeState
        ?.opengeniAutomaticCheckpointRecovery,
    ).toMatchObject({ status: "verified", sessionId: f.session.id });
    // Membership is released; a finished child messaged later still reconstructs
    // its warning, and a worker without the automatic warning cannot claim it.
    await f.create(f.session.sandboxGroupId);
    await promptSession(f, members[2]!);
    const child = attemptClaim(members[2]!);
    await rejectsWithSqlState(
      claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...child,
        filesystemDiscontinuityProtocol: 1,
      }),
    );
    expect(
      await claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...child,
        filesystemDiscontinuityProtocol: 3,
      }),
    ).toMatchObject({ action: "claimed" });
    expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, members[2]!)).toContain(
      "shares with other sessions",
    );
  });

  for (const blocker of ["open_attempt", "pending_tool_call", "holder"] as const) {
    test(`one shared member with an unresolved ${blocker} blocks the group decision and explains why`, async () => {
      const { f, members } = await sharedGroup();
      const busy = members[1]!;
      if (blocker === "open_attempt") {
        await claimedAttempt(f, busy);
      } else if (blocker === "pending_tool_call") {
        const claim = await claimedAttempt(f, busy);
        const [row] = await shared.admin<{ turn_id: string }[]>`
          select turn_id from session_turn_attempts where id = ${claim.attemptId}`;
        await shared.admin.begin(async (tx) => {
          await tx`update session_turn_attempts set state = 'closed', outcome = 'requires_action',
            closed_at = now() where id = ${claim.attemptId}`;
          await tx`insert into session_pending_tool_calls (account_id, workspace_id, session_id,
              turn_id, execution_generation, attempt_id, call_id, call_type, call_item,
              call_item_codec_version)
            values (${f.accountId}, ${f.workspaceId}, ${busy}, ${row!.turn_id}, 1,
              ${claim.attemptId}, 'approval-call', 'function_call',
              ${tx.json({ type: "function_call", name: "exec_command", callId: "approval-call", arguments: "{}" })}, 1)`;
        });
      } else {
        await shared.admin`insert into sandbox_lease_holders(account_id,workspace_id,lease_id,kind,holder_id)
          values(${f.accountId},${f.workspaceId},${f.leaseId},'viewer','unsettled-viewer')`;
      }
      expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
        status: "blocked",
        reason: blocker === "holder" ? "execution_unresolved" : "shared_sandbox_member_active",
        checkpoint: { sessionId: f.session.id },
      });
      const initiator = await claimedAttempt(f, f.session.id);
      expect(
        await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
          ...f.scope,
          sessionId: f.session.id,
          attemptId: initiator.attemptId,
        }),
      ).toEqual({ status: "not_eligible" });
      expect(await automaticReceipts(f.workspaceId, "sandbox.recovery.automatic")).toHaveLength(0);
      for (const sessionId of members) {
        expect(
          await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, sessionId),
        ).toBeNull();
      }
    });
  }

  test("a no-archive loss continues every member on an empty workspace and the next turn publishes it", async () => {
    const { f, members } = await sharedGroup();
    await withoutAnyArchive(f);
    expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
      status: "eligible",
      automaticAvailable: true,
      automaticLane: "fresh_workspace",
      checkpoint: null,
    });
    const initiator = await claimedAttempt(f, members[1]!);
    const authorization = await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
      ...f.scope,
      sessionId: members[1]!,
      attemptId: initiator.attemptId,
    });
    expect(authorization).toMatchObject({
      status: "authorized",
      lane: "fresh_workspace",
      reason: "archive_unavailable",
      lostAt: "2026-09-17T06:24:31.000Z",
      groupSessionCount: 3,
    });
    if (authorization.status === "not_eligible" || authorization.lane !== "fresh_workspace")
      throw new Error("expected a fresh-workspace decision");
    const receipts = await automaticReceipts(
      f.workspaceId,
      "sandbox.recovery.fresh_workspace",
      authorization.operationId,
    );
    expect(receipts.map((receipt) => receipt.target_session_id).sort()).toEqual(
      [...members].sort(),
    );
    for (const sessionId of members) {
      const warning = await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, sessionId);
      expect(warning).toContain("lost at 2026-09-17T06:24:31.000Z");
      expect(warning).toContain("new empty workspace");
      expect(warning).toContain("do not assume they exist");
    }
    expect(
      (await readRecentSandboxRecoveryObservations(client.db)).freshWorkspaceSelections,
    ).toBeGreaterThanOrEqual(1);
    const [audit] = await shared.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events where id = ${authorization.operationId}`;
    expect(audit!.metadata).toMatchObject({
      freshWorkspace: true,
      reason: "archive_unavailable",
      restoreStatus: "unrecoverable",
      providerDiagnostic: "provider_not_found_before_workspace_capture",
    });
    // A v2 worker cannot reconstruct the empty-workspace warning.
    await promptSession(f, members[2]!);
    const child = attemptClaim(members[2]!);
    await rejectsWithSqlState(
      claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...child,
        filesystemDiscontinuityProtocol: 2,
      }),
    );
    expect(
      await claimSessionWorkForAttempt(client.db, f.workspaceId, {
        ...child,
        filesystemDiscontinuityProtocol: 3,
      }),
    ).toMatchObject({ action: "claimed" });
    // Retry of the failed parent is now a system lane, not a dead end.
    expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
      status: "eligible",
      automaticLane: "fresh_workspace",
    });

    const elected = await acquireLease(client.db, {
      ...groupLease(f),
      kind: "turn",
      holderId: initiator.attemptId,
      backend: "modal",
      leaseTtlMs: 60_000,
    });
    expect(elected).toMatchObject({
      role: "spawner",
      lease: {
        freshWorkspaceRecoveryId: authorization.operationId,
        historicalRecoveryAuthorized: false,
      },
    });
    const expectedEpoch = elected.lease.leaseEpoch;
    // No archive, including a legacy per-session fallback, can be restored under it.
    expect(
      await beginSandboxRematerialization(client.db, {
        ...groupLease(f),
        expectedEpoch,
        rematerializationId: crypto.randomUUID(),
      }),
    ).toMatchObject({ status: "blocked", code: "fresh_workspace_pending" });
    await recordWarmingSandboxCreated(client.db, {
      ...groupLease(f),
      expectedEpoch,
      rematerializationId: null,
      instanceId: "fresh-box",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "fresh-box" } },
      },
      leaseTtlMs: 60_000,
    });
    expect(
      await commitWarmingToWarm(client.db, {
        ...groupLease(f),
        expectedEpoch,
        instanceId: "fresh-box",
        leaseTtlMs: 60_000,
      }),
    ).toMatchObject({ committed: false, reason: "fresh_workspace_required" });
    expect(
      await commitWarmingToWarm(client.db, {
        ...groupLease(f),
        expectedEpoch,
        instanceId: "fresh-box",
        leaseTtlMs: 60_000,
        freshWorkspace: { operationId: crypto.randomUUID() },
      }),
    ).toMatchObject({ committed: false, reason: "fresh_workspace_mismatch" });
    expect(
      await commitWarmingToWarm(client.db, {
        ...groupLease(f),
        expectedEpoch,
        instanceId: "fresh-box",
        leaseTtlMs: 60_000,
        freshWorkspace: { operationId: authorization.operationId },
      }),
    ).toMatchObject({ committed: true });
    const warm = await readLease(client.db, f.workspaceId, f.session.sandboxGroupId);
    expect(warm).toMatchObject({
      liveness: "warm",
      instanceId: "fresh-box",
      recovery: { restore: { status: "not_required" }, workspace: { status: "ready" } },
    });
    expect(warm?.resumeState?.opengeniFreshWorkspaceRecovery).toMatchObject({
      status: "verified",
      operationId: authorization.operationId,
    });
    // Warm publication is not a new decision; every warning stays.
    expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id)).toContain(
      "new empty workspace",
    );
  });

  test("a failed empty create keeps the decision; the next spawner still publishes an empty box", async () => {
    const f = await fixture();
    await withoutAnyArchive(f);
    const initiator = await claimedAttempt(f, f.session.id);
    const authorization = await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
      ...f.scope,
      sessionId: f.session.id,
      attemptId: initiator.attemptId,
    });
    if (authorization.status === "not_eligible" || authorization.lane !== "fresh_workspace")
      throw new Error("expected a fresh-workspace decision");
    const first = await acquireLease(client.db, {
      ...groupLease(f),
      kind: "viewer",
      holderId: "failed-fresh-create",
      backend: "modal",
      leaseTtlMs: 60_000,
    });
    await failWarmingToCold(client.db, { ...groupLease(f), expectedEpoch: first.lease.leaseEpoch });
    const cold = await readLease(client.db, f.workspaceId, f.session.sandboxGroupId);
    expect(cold?.resumeState?.opengeniFreshWorkspaceRecovery).toMatchObject({
      status: "accepted",
      operationId: authorization.operationId,
    });
    expect(cold?.recovery.restore.status).toBe("unrecoverable");
    expect(
      await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
        ...f.scope,
        sessionId: f.session.id,
        attemptId: initiator.attemptId,
      }),
    ).toMatchObject({ status: "already_authorized", operationId: authorization.operationId });
    expect(await automaticReceipts(f.workspaceId, "sandbox.recovery.fresh_workspace")).toHaveLength(
      1,
    );
    const second = await acquireLease(client.db, {
      ...groupLease(f),
      kind: "viewer",
      holderId: "retried-fresh-create",
      backend: "modal",
      leaseTtlMs: 60_000,
    });
    expect(second).toMatchObject({
      role: "spawner",
      lease: { freshWorkspaceRecoveryId: authorization.operationId },
    });
  });

  test("an unverified archive continues on an empty workspace", async () => {
    const f = await fixture();
    await shared.admin`update sandbox_leases set current_checkpoint_artifact_id = null,
      resume_state = jsonb_set(
        jsonb_set(resume_state #- '{sessionState,workspaceArchiveMeta}',
          '{opengeniRecovery,restore}', ${shared.admin.json({
            status: "degraded",
            retryable: false,
            failureCode: "archive_unverified",
          })}::jsonb),
        '{opengeniRecovery,provider}', ${shared.admin.json({
          status: "missing",
          instanceId: "lost-box",
          observedAt: "2026-09-18T01:02:03.000Z",
        })}::jsonb)
      where id = ${f.leaseId}`;
    expect(
      (await readLease(client.db, f.workspaceId, f.session.sandboxGroupId))?.recovery.archive
        .status,
    ).toBe("unverified");
    const initiator = await claimedAttempt(f, f.session.id);
    expect(
      await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
        ...f.scope,
        sessionId: f.session.id,
        attemptId: initiator.attemptId,
      }),
    ).toMatchObject({
      status: "authorized",
      lane: "fresh_workspace",
      reason: "archive_unverified",
      lostAt: "2026-09-18T01:02:03.000Z",
    });
  });

  test("a definitive automatic restore failure continues on an empty workspace; a transient one retries the checkpoint once", async () => {
    for (const failure of ["definitive", "transient"] as const) {
      const f = await fixture();
      const initiator = await claimedAttempt(f, f.session.id);
      const authorize = () =>
        authorizeAutomaticSandboxCheckpointRecovery(client.db, {
          ...f.scope,
          sessionId: f.session.id,
          attemptId: initiator.attemptId,
        });
      const failRestore = async (retryable: boolean) => {
        const elected = await acquireLease(client.db, {
          ...groupLease(f),
          kind: "turn",
          holderId: initiator.attemptId,
          backend: "modal",
          leaseTtlMs: 60_000,
        });
        expect(elected).toMatchObject({ role: "spawner" });
        const rematerializationId = crypto.randomUUID();
        const attempt = {
          ...groupLease(f),
          expectedEpoch: elected.lease.leaseEpoch,
          rematerializationId,
        };
        expect(await beginSandboxRematerialization(client.db, attempt)).toMatchObject({
          status: "started",
        });
        expect(
          await failSandboxRematerialization(client.db, {
            ...attempt,
            failureCode: retryable
              ? "sandbox_rematerialization_failed"
              : "archive_hydration_failed",
            retryable,
          }),
        ).toMatchObject({ failed: true });
        await shared.admin`delete from sandbox_lease_holders where lease_id = ${f.leaseId}`;
        await shared.admin`update sandbox_leases set refcount = 0, turn_holders = 0 where id = ${f.leaseId}`;
        expect(
          (await readLease(client.db, f.workspaceId, f.session.sandboxGroupId))?.resumeState
            ?.opengeniAutomaticCheckpointRecovery,
        ).toMatchObject({ status: "failed" });
      };
      expect(await authorize()).toMatchObject({ status: "authorized", lane: "checkpoint" });
      if (failure === "definitive") {
        await failRestore(false);
      } else {
        await failRestore(true);
        expect(await authorize()).toMatchObject({ status: "authorized", lane: "checkpoint" });
        expect(
          (await readLease(client.db, f.workspaceId, f.session.sandboxGroupId))?.resumeState
            ?.opengeniAutomaticCheckpointRecovery,
        ).toMatchObject({ status: "accepted", attempt: 2 });
        await failRestore(true);
      }
      const fresh = await authorize();
      expect(fresh).toMatchObject({
        status: "authorized",
        lane: "fresh_workspace",
        reason: "checkpoint_restore_failed",
      });
      // The newest receipt wins: the session is told its workspace is empty.
      expect(
        await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id),
      ).toContain("new empty workspace");
      // The superseded checkpoint decision is retained as audit evidence.
      if (fresh.status !== "not_eligible" && fresh.lane === "fresh_workspace") {
        const [audit] = await shared.admin<{ metadata: Record<string, unknown> }[]>`
          select metadata from audit_events where id = ${fresh.operationId}`;
        expect(audit!.metadata.supersededAutomaticRecovery).toMatchObject({ status: "failed" });
        expect(audit!.metadata.currentCheckpointArtifactId).toBe(f.artifact.id);
      }
    }
  });

  test("ambiguous provider truth, an unresolved create, or a recent late capture are never eligible", async () => {
    const cases: Array<[string, (f: RecoveryFixture) => Promise<void>, string | null]> = [
      [
        "unknown",
        (f) =>
          shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
          '{opengeniRecovery,provider,status}', '"unknown"'::jsonb) where id = ${f.leaseId}`.then(
            () => undefined,
          ),
        null,
      ],
      [
        "creating",
        (f) =>
          shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
          '{opengeniRecovery,provider,status}', '"creating"'::jsonb) where id = ${f.leaseId}`.then(
            () => undefined,
          ),
        null,
      ],
      [
        "not_created",
        (f) =>
          shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
          '{opengeniRecovery,provider,status}', '"not_created"'::jsonb) where id = ${f.leaseId}`.then(
            () => undefined,
          ),
        null,
      ],
      [
        "late_capture",
        (f) =>
          shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
          '{opengeniRecovery,lateArchiveCapture}', ${shared.admin.json({
            version: 1,
            captureId: crypto.randomUUID(),
            providerRequestId: "late-request",
            sourceLeaseId: f.leaseId,
            sourceLeaseEpoch: 2,
            sourceInstanceId: "lost-box",
            sourceWorkspaceGeneration: 44,
            recordedAt: new Date().toISOString(),
          })}::jsonb) where id = ${f.leaseId}`.then(() => undefined),
        "capture_unresolved",
      ],
    ];
    for (const archive of ["checkpoint", "none"] as const) {
      for (const [name, mutate, reason] of cases) {
        // A late capture only defers giving up on files; a registered older
        // checkpoint is still selected immediately (unchanged 0526 behavior).
        if (archive === "checkpoint" && name === "late_capture") continue;
        const f = await fixture();
        if (archive === "none") await withoutAnyArchive(f);
        await mutate(f);
        const projection = await readPublicSandboxRecovery(client.db, f);
        expect(projection.automaticAvailable, `${archive}/${name}`).toBeUndefined();
        if (reason) expect(projection).toMatchObject({ status: "blocked", reason });
        const initiator = await claimedAttempt(f, f.session.id);
        expect(
          await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
            ...f.scope,
            sessionId: f.session.id,
            attemptId: initiator.attemptId,
          }),
          `${archive}/${name}`,
        ).toEqual({ status: "not_eligible" });
        expect(
          await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.session.id),
        ).toBeNull();
      }
    }
  });

  test("a settled late capture window allows the empty workspace; an older checkpoint never waits", async () => {
    for (const archive of ["checkpoint", "none"] as const) {
      const f = await fixture();
      if (archive === "none") await withoutAnyArchive(f);
      await shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
        '{opengeniRecovery,lateArchiveCapture}', ${shared.admin.json({
          version: 1,
          captureId: crypto.randomUUID(),
          providerRequestId: "late-request",
          sourceLeaseId: f.leaseId,
          sourceLeaseEpoch: 2,
          sourceInstanceId: "lost-box",
          sourceWorkspaceGeneration: 44,
          recordedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        })}::jsonb) where id = ${f.leaseId}`;
      const initiator = await claimedAttempt(f, f.session.id);
      expect(
        await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
          ...f.scope,
          sessionId: f.session.id,
          attemptId: initiator.attemptId,
        }),
      ).toMatchObject({
        status: "authorized",
        lane: archive === "none" ? "fresh_workspace" : "checkpoint",
      });
    }
  });

  test("lease rows written by the current confirmDrainCold qualify without any new loss receipt", async () => {
    for (const archive of ["checkpoint", "none"] as const) {
      const f = await fixture();
      const lost = await f.create();
      const children = [await f.create(lost.sandboxGroupId), await f.create(lost.sandboxGroupId)];
      const leaseId = crypto.randomUUID();
      const sessionState = modalSnapshotSessionState(`im-deadline-${leaseId}`);
      await shared.admin`insert into sandbox_leases(id,account_id,workspace_id,sandbox_group_id,backend,
          liveness,instance_id,refcount,lease_epoch,workspace_generation,archive_generation,
          resume_backend_id,resume_state,expires_at)
        values(${leaseId},${f.accountId},${f.workspaceId},${lost.sandboxGroupId},'modal','draining',
          'deadline-killed-box',0,7,44,${archive === "none" ? null : 10},'modal',
          ${shared.admin.json(
            archive === "none"
              ? {
                  backendId: "modal",
                  sessionState: { providerState: { sandboxId: "deadline-killed-box" } },
                }
              : {
                  backendId: "modal",
                  sessionState: {
                    ...sessionState,
                    providerState: { sandboxId: "deadline-killed-box" },
                  },
                },
          )},now() - interval '1 minute')`;
      if (archive === "checkpoint") {
        const binding = {
          version: 1,
          serverUrl: "https://modal.test",
          workspaceName: "recovery-fixture",
          environment: "main",
        };
        const artifact = await registerSandboxCheckpointArtifact(client.db, {
          ...f.scope,
          sandboxGroupId: lost.sandboxGroupId,
          sourceLeaseId: leaseId,
          sourceLeaseEpoch: 6,
          sourceInstanceId: "deadline-killed-box",
          sourceWorkspaceGeneration: 10,
          providerBinding: binding,
          providerBindingKey: JSON.stringify(binding),
          workspaceArchive: sessionState.workspaceArchive as string,
          workspaceArchiveMeta: sessionState.workspaceArchiveMeta as never,
        });
        await shared.admin.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${f.accountId}, true), set_config('opengeni.workspace_id', ${f.workspaceId}, true)`;
          await tx`update sandbox_checkpoint_artifacts set state = 'current' where id = ${artifact.id}`;
          await tx`update sandbox_leases set current_checkpoint_artifact_id = ${artifact.id} where id = ${leaseId}`;
        });
      }
      expect(
        await confirmDrainCold(client.db, {
          ...f.scope,
          sandboxGroupId: lost.sandboxGroupId,
          expectedEpoch: 7,
          providerMissingBeforeCapture: true,
        }),
      ).toEqual({ wentCold: true });
      const cold = await readLease(client.db, f.workspaceId, lost.sandboxGroupId);
      expect(cold?.recovery).toMatchObject({
        provider: { status: "missing", diagnostic: "provider_not_found_before_workspace_capture" },
        restore:
          archive === "none"
            ? { status: "unrecoverable", failureCode: "archive_unavailable", retryable: false }
            : { status: "degraded", failureCode: "archive_generation_mismatch", retryable: false },
      });
      // Exactly the dead end older workers produced for every later turn.
      await expect(
        acquireLease(client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sandboxGroupId: lost.sandboxGroupId,
          kind: "viewer",
          holderId: "older-worker-view",
          backend: "modal",
          leaseTtlMs: 60_000,
        }),
      ).resolves.toMatchObject({ role: "blocked" });
      const initiator = await claimedAttempt(f, lost.id);
      expect(
        await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
          ...f.scope,
          sessionId: lost.id,
          attemptId: initiator.attemptId,
        }),
      ).toMatchObject({
        status: "authorized",
        lane: archive === "none" ? "fresh_workspace" : "checkpoint",
        groupSessionCount: 3,
      });
      for (const child of children) {
        expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, child.id)).toContain(
          archive === "none" ? "new empty workspace" : "shares with other sessions",
        );
      }
      expect(
        await acquireLease(client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sandboxGroupId: lost.sandboxGroupId,
          kind: "turn",
          holderId: initiator.attemptId,
          backend: "modal",
          leaseTtlMs: 60_000,
        }),
      ).toMatchObject({ role: "spawner" });
    }
  });

  /** A turn that failed while its tool call was still pending, exactly as the
   * lost-sandbox failure leaves it: the turn is terminal, the attempt closed. */
  async function failedTurnWithPendingCall(f: RecoveryFixture, sessionId: string) {
    const claim = await claimedAttempt(f, sessionId);
    const [attempt] = await shared.admin<{ turn_id: string }[]>`
      select turn_id from session_turn_attempts where id = ${claim.attemptId}`;
    await shared.admin.begin(async (tx) => {
      await tx`insert into session_pending_tool_calls (account_id, workspace_id, session_id,
          turn_id, execution_generation, attempt_id, call_id, call_type, call_item,
          call_item_codec_version)
        values (${f.accountId}, ${f.workspaceId}, ${sessionId}, ${attempt!.turn_id}, 1,
          ${claim.attemptId}, ${`stranded-${claim.attemptId}`}, 'function_call',
          ${tx.json({ type: "function_call", name: "exec_command", callId: "stranded", arguments: "{}" })}, 1)`;
      await tx`update session_turn_attempts set state = 'closed', outcome = 'failed',
        closed_at = now(), quiesced_at = now() where id = ${claim.attemptId}`;
      await tx`update session_turns set status = 'failed', active_attempt_id = null
        where id = ${attempt!.turn_id}`;
      await tx`update sessions set status = 'failed', active_turn_id = null where id = ${sessionId}`;
    });
    return attempt!.turn_id;
  }

  test("a pending tool call left by a failed turn does not block recovery; projection and turn start agree", async () => {
    const { f, members } = await sharedGroup();
    // A child's failed recovery attempt stranded a pending call.
    await failedTurnWithPendingCall(f, members[1]!);
    // The parent's own earlier failed turn stranded one too.
    await failedTurnWithPendingCall(f, f.session.id);
    // Retry would reopen that exact turn, so the banner points to a new
    // message instead of promising a Retry the server must refuse.
    expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
      status: "blocked",
      reason: "retry_tool_outcome_unresolved",
    });
    // Other members are not blocked by the stranded rows either.
    expect(
      await readPublicSandboxRecovery(client.db, { ...f, sessionId: members[2]! }),
    ).toMatchObject({ status: "eligible", automaticLane: "checkpoint" });
    // A new message recovers the whole group.
    const initiator = await claimedAttempt(f, f.session.id);
    expect(
      await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
        ...f.scope,
        sessionId: f.session.id,
        attemptId: initiator.attemptId,
      }),
    ).toMatchObject({ status: "authorized", lane: "checkpoint", groupSessionCount: 3 });
  });

  test("a live pending tool call in a member still blocks, and the projection says so", async () => {
    const { f, members } = await sharedGroup();
    const claim = await claimedAttempt(f, members[1]!);
    const [attempt] = await shared.admin<{ turn_id: string }[]>`
      select turn_id from session_turn_attempts where id = ${claim.attemptId}`;
    // Waiting for human input: the turn can still resume this exact call.
    await shared.admin.begin(async (tx) => {
      await tx`insert into session_pending_tool_calls (account_id, workspace_id, session_id,
          turn_id, execution_generation, attempt_id, call_id, call_type, call_item,
          call_item_codec_version, interruption_kind)
        values (${f.accountId}, ${f.workspaceId}, ${members[1]!}, ${attempt!.turn_id}, 1,
          ${claim.attemptId}, 'human-input', 'function_call',
          ${tx.json({ type: "function_call", name: "request_human_input", callId: "human-input", arguments: "{}" })}, 1,
          'human_input')`;
      await tx`update session_turn_attempts set state = 'closed', outcome = 'requires_action',
        closed_at = now(), quiesced_at = now() where id = ${claim.attemptId}`;
      await tx`update session_turns set status = 'requires_action', active_attempt_id = null
        where id = ${attempt!.turn_id}`;
    });
    expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
      status: "blocked",
      reason: "shared_sandbox_member_active",
    });
    const initiator = await claimedAttempt(f, f.session.id);
    expect(
      await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
        ...f.scope,
        sessionId: f.session.id,
        attemptId: initiator.attemptId,
      }),
    ).toEqual({ status: "not_eligible" });
  });

  test("every observed lost-lease shape has a forward path", async () => {
    const legacyDescriptor = (meta: {
      archiveSha256: string;
      archiveBytes: number;
      capturedAt: string;
    }) => ({
      version: 1,
      revision: `wa1:${Date.parse(meta.capturedAt)}:${meta.archiveSha256}`,
      archiveSha256: meta.archiveSha256,
      archiveBytes: meta.archiveBytes,
      capturedAt: meta.capturedAt,
      workspace: {
        algorithm: "sha256",
        sha256: "b".repeat(64),
        entryCount: 1,
        fileCount: 1,
        totalFileBytes: 7,
      },
    });
    type Shape = {
      name: string;
      members: number;
      mutate: (f: RecoveryFixture) => Promise<unknown>;
      expected:
        | { lane: "checkpoint" | "fresh_workspace"; reason?: string }
        | { ordinaryRestore: true };
    };
    const setRestore = (f: RecoveryFixture, value: Record<string, string | boolean | null>) =>
      shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
        '{opengeniRecovery,restore}', ${shared.admin.json(value)}::jsonb)
        where id = ${f.leaseId}`;
    const shapes: Shape[] = [
      {
        name: "degraded mismatch, v2 checkpoint, singleton",
        members: 1,
        mutate: async () => undefined,
        expected: { lane: "checkpoint" },
      },
      {
        name: "degraded mismatch, v2 checkpoint, shared",
        members: 3,
        mutate: async () => undefined,
        expected: { lane: "checkpoint" },
      },
      {
        name: "unrecoverable archive_unavailable, shared",
        members: 3,
        mutate: withoutAnyArchive,
        expected: { lane: "fresh_workspace", reason: "archive_unavailable" },
      },
      {
        name: "unrecoverable archive_unavailable, singleton",
        members: 1,
        mutate: withoutAnyArchive,
        expected: { lane: "fresh_workspace", reason: "archive_unavailable" },
      },
      {
        name: "degraded mismatch, legacy v1 descriptor, no registered checkpoint",
        members: 1,
        mutate: async (f) => {
          const [row] = await shared.admin<
            { meta: { archiveSha256: string; archiveBytes: number; capturedAt: string } }[]
          >`
            select resume_state #> '{sessionState,workspaceArchiveMeta}' as meta
            from sandbox_leases where id = ${f.leaseId}`;
          await shared.admin`update sandbox_leases set current_checkpoint_artifact_id = null,
            resume_state = jsonb_set(resume_state, '{sessionState,workspaceArchiveMeta}',
              ${shared.admin.json(legacyDescriptor(row!.meta))}::jsonb)
            where id = ${f.leaseId}`;
        },
        expected: { lane: "fresh_workspace", reason: "checkpoint_unrestorable" },
      },
      {
        name: "pending after a reset, v2 checkpoint older than the workspace",
        members: 1,
        mutate: (f) => setRestore(f, { status: "pending", rematerializationId: null }),
        expected: { lane: "checkpoint" },
      },
      {
        name: "pending with a complete v2 checkpoint",
        members: 1,
        mutate: async (f) => {
          await setRestore(f, { status: "pending", rematerializationId: null });
          await shared.admin`update sandbox_leases set workspace_generation = 10
            where id = ${f.leaseId}`;
        },
        expected: { ordinaryRestore: true },
      },
      {
        name: "degraded sandbox_rematerialization_failed after a system restore",
        members: 1,
        mutate: async (f) => {
          await setRestore(f, {
            status: "degraded",
            failureCode: "sandbox_rematerialization_failed",
            retryable: true,
          });
          await shared.admin`update sandbox_leases set resume_state = resume_state ||
            ${shared.admin.json({
              opengeniHistoricalArchiveRecoveryId: crypto.randomUUID(),
              opengeniAutomaticCheckpointRecovery: {
                operationId: crypto.randomUUID(),
                sessionId: f.session.id,
                status: "failed",
              },
            })}::jsonb where id = ${f.leaseId}`;
        },
        expected: { lane: "checkpoint" },
      },
      {
        name: "degraded sandbox_rematerialization_failed without a system decision",
        members: 1,
        mutate: (f) =>
          setRestore(f, {
            status: "degraded",
            failureCode: "sandbox_rematerialization_failed",
            retryable: true,
          }),
        expected: { lane: "checkpoint" },
      },
    ];
    for (const shape of shapes) {
      const f = await fixture();
      for (let member = 1; member < shape.members; member++)
        await f.create(f.session.sandboxGroupId);
      await shape.mutate(f);
      const initiator = await claimedAttempt(f, f.session.id);
      const decision = await authorizeAutomaticSandboxCheckpointRecovery(client.db, {
        ...f.scope,
        sessionId: f.session.id,
        attemptId: initiator.attemptId,
      });
      if ("ordinaryRestore" in shape.expected) {
        expect(decision, shape.name).toEqual({ status: "not_eligible" });
        const elected = await acquireLease(client.db, {
          ...groupLease(f),
          kind: "turn",
          holderId: initiator.attemptId,
          backend: "modal",
          leaseTtlMs: 60_000,
        });
        expect(elected, shape.name).toMatchObject({
          role: "spawner",
          lease: { archiveComplete: true },
        });
        expect(
          await beginSandboxRematerialization(client.db, {
            ...groupLease(f),
            expectedEpoch: elected.lease.leaseEpoch,
            rematerializationId: crypto.randomUUID(),
          }),
          shape.name,
        ).toMatchObject({ status: "started" });
        continue;
      }
      expect(decision, shape.name).toMatchObject({
        status: "authorized",
        lane: shape.expected.lane,
        groupSessionCount: shape.members,
        ...(shape.expected.reason ? { reason: shape.expected.reason } : {}),
      });
      // The decided lane is also what the next spawner elects.
      const elected = await acquireLease(client.db, {
        ...groupLease(f),
        kind: "turn",
        holderId: initiator.attemptId,
        backend: "modal",
        leaseTtlMs: 60_000,
      });
      expect(elected, shape.name).toMatchObject({ role: "spawner" });
      if (shape.expected.lane === "checkpoint")
        expect(elected.lease.historicalRecoveryAuthorized, shape.name).toBe(true);
      else expect(elected.lease.freshWorkspaceRecoveryId, shape.name).toBeTruthy();
    }
  });
});
