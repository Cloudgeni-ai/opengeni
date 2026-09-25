import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acquireLease,
  authorizeAutomaticSandboxCheckpointRecovery,
  beginSandboxRematerialization,
  bootstrapWorkspace,
  claimSandboxCheckpointArtifactsForGc,
  commitWarmingToWarm,
  consentPublicSandboxRecovery,
  createDb,
  createSession,
  claimSessionWorkForAttempt,
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

describe("explicit singleton checkpoint recovery", () => {
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
        filesystemDiscontinuityProtocol: 3 as 1 | 2,
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
      expect(projection.status).toBe(
        consent.status === "fulfilled" ? "consent_accepted" : "unsupported",
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
