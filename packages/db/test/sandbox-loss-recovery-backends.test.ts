import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { SandboxRecoveryProjection } from "@opengeni/contracts";
import {
  acquireLease,
  authorizeAutomaticSandboxCheckpointRecovery,
  beginSandboxRematerialization,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  commitWarmingToWarm,
  consentPublicSandboxRecovery,
  createDb,
  createSession,
  deliverPendingSandboxRestoreNotice,
  failWarmingToCold,
  getSandboxRecoveryDiscontinuity,
  markWarmLeaseInstanceLost,
  markSandboxRestoreVerifying,
  readLease,
  readPublicSandboxRecovery,
  readSandboxReducedSave,
  recordWarmingSandboxCreated,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";

// System continuity after a lost sandbox on backends other than Modal. A
// NotFound alone may at most restore a checkpoint; only backend-specific proof
// that the workspace is gone may continue on an empty one.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("sandbox-loss-recovery-backends");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Backend = "docker" | "compute" | "opensandbox";

function tarArchive(capturedAt = "2026-09-20T03:04:05.000Z") {
  const archive = Buffer.from(`portable workspace ${crypto.randomUUID()}`).toString("base64");
  const bytes = Buffer.from(archive, "base64");
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    workspaceArchive: archive,
    workspaceArchiveMeta: {
      version: 1 as const,
      revision: `wa1:${Date.parse(capturedAt)}:${archiveSha256}`,
      archiveSha256,
      archiveBytes: bytes.length,
      capturedAt,
      workspace: {
        algorithm: "sha256" as const,
        sha256: archiveSha256,
        entryCount: 1,
        fileCount: 1,
        totalFileBytes: bytes.length,
      },
    },
  };
}

/** The recovery state a box lost before any capture of its newest writes
 * leaves behind (confirmDrainCold's missing-before-capture commit). */
function lostRecovery(archive: boolean) {
  return {
    provider: {
      status: "missing",
      instanceId: "lost-box",
      observedAt: "2026-09-21T06:24:31.000Z",
      diagnostic: "provider_not_found_before_workspace_capture",
    },
    restore: archive
      ? { status: "degraded", retryable: false, failureCode: "archive_generation_mismatch" }
      : {
          status: "unrecoverable",
          rematerializationId: null,
          selectedRevision: null,
          startedAt: null,
          completedAt: "2026-09-21T06:24:31.000Z",
          failureCode: "archive_unavailable",
          retryable: false,
        },
    workspace: { status: archive ? "degraded" : "unrecoverable" },
  };
}

async function fixture(
  backend: Backend,
  lease: {
    liveness?: "cold" | "warming" | "warm";
    instanceId?: string | null;
    archiveGeneration: number | null;
    resumeState: Record<string, unknown>;
  },
) {
  const unique = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: unique,
    accountName: "loss recovery",
    workspaceExternalSource: "test",
    workspaceExternalId: unique,
    workspaceName: "loss recovery",
    subjectId: `subject-${unique}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: backend,
  });
  const leaseId = crypto.randomUUID();
  await shared.admin`insert into sandbox_leases(id,account_id,workspace_id,sandbox_group_id,backend,liveness,
    instance_id,lease_epoch,workspace_generation,archive_generation,resume_backend_id,resume_state,expires_at)
    values(${leaseId},${scope.accountId},${scope.workspaceId},${session.sandboxGroupId},${backend},
      ${lease.liveness ?? "cold"},${lease.instanceId ?? null},3,44,${lease.archiveGeneration},${backend},
      ${shared.admin.json({ backendId: backend, ...lease.resumeState } as never)},now() + interval '1 hour')`;
  return {
    ...scope,
    scope,
    session,
    leaseId,
    sessionId: session.id,
    group: {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sandboxGroupId: session.sandboxGroupId,
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A running attempt of a new human prompt, as turn start sees it. */
async function claimedAttempt(f: Fixture) {
  await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (tx) =>
    submitHumanPromptInTransaction(tx, {
      ...f.scope,
      sessionId: f.session.id,
      actor: { type: "human", subjectId: f.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Continue from the current filesystem",
      resources: [],
      reasoningEffortFallback: "medium",
      source: "user",
    }),
  );
  const input = {
    sessionId: f.session.id,
    workflowId: `session-${f.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" as const },
  };
  expect(
    await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      ...input,
      filesystemDiscontinuityProtocol: 3,
    }),
  ).toMatchObject({ action: "claimed" });
  return {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: f.session.id,
    attemptId: input.attemptId,
  };
}

function lossRecord(
  f: Fixture,
  deathProof?: { kind: "workspace_absent" | "provider_lifetime"; provenAt: string },
) {
  return {
    version: 1,
    source: "drain_probe",
    leaseId: f.leaseId,
    lostEpoch: 2,
    instanceId: "lost-box",
    workspaceGeneration: 44,
    observedAt: "2026-09-21T06:24:31.000Z",
    providerDeadlineAt: null,
    ...(deathProof ? { deathProof } : {}),
  };
}

describe("system continuity after a lost sandbox on every backend", () => {
  test("a lost Docker workspace restores its older verified portable archive by itself", async () => {
    const archive = tarArchive();
    const f = await fixture("docker", {
      archiveGeneration: 10,
      resumeState: { sessionState: archive, opengeniRecovery: lostRecovery(true) },
    });
    const preview = await readPublicSandboxRecovery(client.db, f);
    expect(preview).toMatchObject({
      status: "eligible",
      automaticAvailable: true,
      automaticLane: "checkpoint",
      // The public consent selection names native checkpoints only, so older
      // readers never see a null artifact; the portable one is additive.
      checkpoint: null,
      automaticCheckpoint: {
        archiveGeneration: 10,
        workspaceGeneration: 44,
        artifactId: null,
        revision: archive.workspaceArchiveMeta.revision,
      },
    });
    expect(SandboxRecoveryProjection.safeParse(preview).success).toBe(true);
    const attempt = await claimedAttempt(f);
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toMatchObject({
      status: "authorized",
      lane: "checkpoint",
      selection: { archiveGeneration: 10, artifactId: null },
    });
    expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.sessionId)).toContain(
      archive.workspaceArchiveMeta.capturedAt,
    );
    // The decision alone tells the person nothing: the restore may still fail.
    const recoveryNotices = async () =>
      (
        await shared.admin`select payload from session_events
          where session_id = ${f.sessionId} and type = 'sandbox.recovery.selected'`
      ).map((row) => row.payload);
    expect(await recoveryNotices()).toEqual([]);
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toMatchObject({
      status: "already_authorized",
      lane: "checkpoint",
    });
    // The elected owner restores exactly that older archive.
    const elected = await acquireLease(client.db, {
      ...f.group,
      kind: "turn",
      holderId: "docker-recovery",
      backend: "docker",
      leaseTtlMs: 60_000,
    });
    expect(elected.role).toBe("spawner");
    expect(elected.lease.historicalRecoveryAuthorized).toBe(true);
    const rematerializationId = crypto.randomUUID();
    expect(
      await beginSandboxRematerialization(client.db, {
        ...f.group,
        expectedEpoch: elected.lease.leaseEpoch,
        rematerializationId,
      }),
    ).toMatchObject({ status: "started" });
    const leaseScope = { ...f.group, expectedEpoch: elected.lease.leaseEpoch };
    await recordWarmingSandboxCreated(client.db, {
      ...leaseScope,
      rematerializationId,
      instanceId: "restored-docker-box",
      resumeBackendId: "docker",
      resumeState: { backendId: "docker", sessionState: archive },
      leaseTtlMs: 60_000,
    });
    await markSandboxRestoreVerifying(client.db, { ...leaseScope, rematerializationId });
    expect(await recoveryNotices()).toEqual([]);
    expect(
      await commitWarmingToWarm(client.db, {
        ...leaseScope,
        instanceId: "restored-docker-box",
        leaseTtlMs: 60_000,
        rematerialization: {
          id: rematerializationId,
          verifiedRevision: archive.workspaceArchiveMeta.revision,
        },
      }),
    ).toMatchObject({ committed: true });
    // Once the restore is verified, the person is told once, with the save's time.
    expect(await recoveryNotices()).toEqual([
      expect.objectContaining({
        mode: "checkpoint",
        capturedAt: archive.workspaceArchiveMeta.capturedAt,
      }),
    ]);
  });

  // DC-G follow-up: the older-save notice is written after the warm commit.
  // The old code only logged a failed write, so the people in the chat were
  // never told. It is now pending on the lease until written, retried at the
  // next turn start, and written exactly once.
  test("an older-save notice whose write failed after the restore is delivered once on the next turn", async () => {
    const archive = tarArchive();
    const f = await fixture("docker", {
      archiveGeneration: 10,
      resumeState: { sessionState: archive, opengeniRecovery: lostRecovery(true) },
    });
    const attempt = await claimedAttempt(f);
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toMatchObject({
      status: "authorized",
      lane: "checkpoint",
    });
    const elected = await acquireLease(client.db, {
      ...f.group,
      kind: "turn",
      holderId: "notice-retry",
      backend: "docker",
      leaseTtlMs: 60_000,
    });
    const rematerializationId = crypto.randomUUID();
    expect(
      await beginSandboxRematerialization(client.db, {
        ...f.group,
        expectedEpoch: elected.lease.leaseEpoch,
        rematerializationId,
      }),
    ).toMatchObject({ status: "started" });
    const leaseScope = { ...f.group, expectedEpoch: elected.lease.leaseEpoch };
    await recordWarmingSandboxCreated(client.db, {
      ...leaseScope,
      rematerializationId,
      instanceId: "restored-notice-box",
      resumeBackendId: "docker",
      resumeState: { backendId: "docker", sessionState: archive },
      leaseTtlMs: 60_000,
    });
    await markSandboxRestoreVerifying(client.db, { ...leaseScope, rematerializationId });
    // The notice write fails (as any database error would) right after the
    // restore commits.
    const blocker = `fail_notice_${crypto.randomUUID().replaceAll("-", "")}`;
    await shared.admin.unsafe(`
      create function ${blocker}() returns trigger language plpgsql as $$
      begin
        if new.type = 'sandbox.recovery.selected' and new.session_id = '${f.sessionId}' then
          raise exception 'notice write unavailable';
        end if;
        return new;
      end $$;
      create trigger ${blocker} before insert on session_events
        for each row execute function ${blocker}();
    `);
    const notices = async () =>
      (
        await shared.admin`select payload from session_events
          where session_id = ${f.sessionId} and type = 'sandbox.recovery.selected'`
      ).map((row) => row.payload);
    try {
      expect(
        await commitWarmingToWarm(client.db, {
          ...leaseScope,
          instanceId: "restored-notice-box",
          leaseTtlMs: 60_000,
          rematerialization: {
            id: rematerializationId,
            verifiedRevision: archive.workspaceArchiveMeta.revision,
          },
        }),
      ).toMatchObject({ committed: true });
      // The restore stands; the person has not been told yet.
      expect((await readLease(client.db, f.workspaceId, f.group.sandboxGroupId))?.liveness).toBe(
        "warm",
      );
      expect(await notices()).toEqual([]);
    } finally {
      await shared.admin.unsafe(`drop trigger ${blocker} on session_events;
        drop function ${blocker}();`);
    }
    // The next turn start delivers it, with the save's time.
    expect(
      await deliverPendingSandboxRestoreNotice(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
      }),
    ).toBe(true);
    expect(await notices()).toEqual([
      expect.objectContaining({
        mode: "checkpoint",
        capturedAt: archive.workspaceArchiveMeta.capturedAt,
      }),
    ]);
    // Exactly once: later turns, and concurrent callers, add nothing.
    const again = await Promise.all(
      [0, 1, 2].map(() =>
        deliverPendingSandboxRestoreNotice(client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sandboxGroupId: f.group.sandboxGroupId,
        }),
      ),
    );
    expect(again).toEqual([false, false, false]);
    expect(await notices()).toHaveLength(1);
  });

  for (const named of [true, false]) {
    test(
      named
        ? "a box the drain stopped after failed saves restores the save its notice named without a second notice"
        : "a box the drain stopped restores a different save than its notice named, and says so",
      async () => {
        const archive = tarArchive();
        const f = await fixture("docker", {
          archiveGeneration: 10,
          resumeState: { sessionState: archive, opengeniRecovery: lostRecovery(true) },
        });
        await shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
      '{opengeniProviderLoss}', ${shared.admin.json({
        ...lossRecord(f),
        captureAbandoned: true,
        unsavedSince: named ? archive.workspaceArchiveMeta.capturedAt : "2020-01-01T00:00:00.000Z",
      })}::jsonb)
      where id = ${f.leaseId}`;
        const attempt = await claimedAttempt(f);
        expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toMatchObject(
          {
            status: "authorized",
            lane: "checkpoint",
          },
        );
        // The model still learns which save it continues from.
        expect(
          await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.sessionId),
        ).toContain(archive.workspaceArchiveMeta.capturedAt);
        // The verified restore adds no notice: the person was already told when
        // the drain stopped the box.
        const elected = await acquireLease(client.db, {
          ...f.group,
          kind: "turn",
          holderId: "abandoned-recovery",
          backend: "docker",
          leaseTtlMs: 60_000,
        });
        const rematerializationId = crypto.randomUUID();
        expect(
          await beginSandboxRematerialization(client.db, {
            ...f.group,
            expectedEpoch: elected.lease.leaseEpoch,
            rematerializationId,
          }),
        ).toMatchObject({ status: "started" });
        const leaseScope = { ...f.group, expectedEpoch: elected.lease.leaseEpoch };
        await recordWarmingSandboxCreated(client.db, {
          ...leaseScope,
          rematerializationId,
          instanceId: "restored-abandoned-box",
          resumeBackendId: "docker",
          resumeState: { backendId: "docker", sessionState: archive },
          leaseTtlMs: 60_000,
        });
        await markSandboxRestoreVerifying(client.db, { ...leaseScope, rematerializationId });
        expect(
          await commitWarmingToWarm(client.db, {
            ...leaseScope,
            instanceId: "restored-abandoned-box",
            leaseTtlMs: 60_000,
            rematerialization: {
              id: rematerializationId,
              verifiedRevision: archive.workspaceArchiveMeta.revision,
            },
          }),
        ).toMatchObject({ committed: true });
        const notices = await shared.admin`select count(*)::int as n from session_events
      where session_id = ${f.sessionId} and type = 'sandbox.recovery.selected'`;
        // Only a restore of exactly the save the stop notice named is already
        // explained; any other save is announced with its own time.
        expect(notices[0]!.n).toBe(named ? 0 : 1);
      },
    );
  }

  test("a reduced save is readable for the next turn's note; a full save is not", async () => {
    const reduced = tarArchive("2026-09-20T03:04:05.000Z");
    const f = await fixture("docker", {
      archiveGeneration: 10,
      resumeState: {
        sessionState: {
          ...reduced,
          workspaceArchiveMeta: {
            ...reduced.workspaceArchiveMeta,
            omittedPaths: ["node_modules", "web/.next"],
          },
        },
      },
    });
    expect(await readSandboxReducedSave(client.db, f.workspaceId, f.sessionId)).toEqual({
      capturedAt: "2026-09-20T03:04:05.000Z",
      omittedPaths: ["node_modules", "web/.next"],
    });
    const full = await fixture("docker", {
      archiveGeneration: 10,
      resumeState: { sessionState: tarArchive() },
    });
    expect(await readSandboxReducedSave(client.db, full.workspaceId, full.sessionId)).toBeNull();
  });

  test("a Docker NotFound with nothing to restore never continues on an empty workspace", async () => {
    const f = await fixture("docker", {
      archiveGeneration: null,
      resumeState: { opengeniRecovery: lostRecovery(false) },
    });
    const preview = await readPublicSandboxRecovery(client.db, f);
    expect(preview.automaticAvailable).toBeUndefined();
    const attempt = await claimedAttempt(f);
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toEqual({
      status: "not_eligible",
    });
    expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.sessionId)).toBeNull();
  });

  test("a continuity restore that proves the Docker workspace gone continues on an empty workspace", async () => {
    const f = await fixture("docker", {
      liveness: "warming",
      archiveGeneration: null,
      resumeState: {},
    });
    await shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
      '{opengeniProviderLoss}', ${shared.admin.json(lossRecord(f))}::jsonb) where id = ${f.leaseId}`;
    await failWarmingToCold(client.db, {
      ...f.group,
      expectedEpoch: 3,
      discardContinuity: true,
      providerWorkspaceAbsent: true,
    });
    const lease = await readLease(client.db, f.workspaceId, f.session.sandboxGroupId);
    expect(lease?.liveness).toBe("cold");
    expect(lease?.recovery.restore.status).toBe("unrecoverable");
    expect(lease?.resumeState?.opengeniProviderLoss).toMatchObject({
      leaseId: f.leaseId,
      deathProof: { kind: "workspace_absent" },
    });
    const attempt = await claimedAttempt(f);
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toMatchObject({
      status: "authorized",
      lane: "fresh_workspace",
      reason: "archive_unavailable",
    });
    expect(await getSandboxRecoveryDiscontinuity(client.db, f.workspaceId, f.sessionId)).toContain(
      "new empty workspace",
    );
  });

  test("a failed continuity restore without that proof keeps the loss instead of a clean lease", async () => {
    const f = await fixture("docker", {
      liveness: "warming",
      archiveGeneration: null,
      resumeState: {},
    });
    await shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
      '{opengeniProviderLoss}', ${shared.admin.json(lossRecord(f))}::jsonb) where id = ${f.leaseId}`;
    await failWarmingToCold(client.db, { ...f.group, expectedEpoch: 3, discardContinuity: true });
    const lease = await readLease(client.db, f.workspaceId, f.session.sandboxGroupId);
    // Before, the lease was nulled into what looked like a brand-new sandbox,
    // and the next turn silently published an empty workspace.
    expect(lease?.resumeState?.opengeniProviderLoss).toMatchObject({ leaseId: f.leaseId });
    expect(lease?.recovery.restore.status).toBe("unrecoverable");
    // Not a dead end: the person who controls the chat may still choose an
    // empty workspace deliberately, without any database repair.
    const scope = { ...f.scope, sessionId: f.sessionId, canControlMember: async () => true };
    const preview = await readPublicSandboxRecovery(client.db, scope);
    expect(preview).toMatchObject({ status: "eligible", freshWorkspaceAvailable: true });
    expect(preview.automaticAvailable).toBeUndefined();
    expect(
      await consentPublicSandboxRecovery(client.db, {
        ...scope,
        request: {
          operationId: crypto.randomUUID(),
          action: "continue_fresh",
          acceptEmptyWorkspace: true,
          target: preview.target!,
        },
      }),
    ).toMatchObject({ outcome: "accepted" });
    expect(await readPublicSandboxRecovery(client.db, scope)).toMatchObject({
      status: "consent_accepted",
      reason: "fresh_workspace_selected",
    });
  });

  test("the compute control plane's NotFound is proof, so a lost compute sandbox continues", async () => {
    const f = await fixture("compute", {
      archiveGeneration: null,
      resumeState: { opengeniRecovery: lostRecovery(false) },
    });
    expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
      automaticAvailable: true,
      automaticLane: "fresh_workspace",
    });
    const attempt = await claimedAttempt(f);
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toMatchObject({
      status: "authorized",
      lane: "fresh_workspace",
    });
  });

  test("an OpenSandbox loss waits out the box's unrenewed lifetime before an empty workspace", async () => {
    const f = await fixture("opensandbox", {
      liveness: "warm",
      instanceId: "os-box",
      archiveGeneration: null,
      resumeState: { sessionState: { providerState: { sandboxId: "os-box" } } },
    });
    expect(
      await markWarmLeaseInstanceLost(client.db, {
        ...f.group,
        expectedEpoch: 3,
        expectedInstanceId: "os-box",
        expectedBackend: "opensandbox",
        providerMaxRemainingLifetimeMs: 3_600_000,
      }),
    ).toMatchObject({ status: "marked" });
    const lost = await readLease(client.db, f.workspaceId, f.session.sandboxGroupId);
    const proof = (lost?.resumeState?.opengeniProviderLoss as Record<string, unknown>)
      ?.deathProof as { kind: string; provenAt: string };
    expect(proof.kind).toBe("provider_lifetime");
    expect(Date.parse(proof.provenAt)).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await readPublicSandboxRecovery(client.db, f)).toMatchObject({
      status: "blocked",
      reason: "provider_lifetime_unexpired",
      availableAt: proof.provenAt,
    });
    const attempt = await claimedAttempt(f);
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toEqual({
      status: "not_eligible",
    });
    // Once no box can still be running, the same chat continues by itself.
    await shared.admin`update sandbox_leases set resume_state = jsonb_set(resume_state,
      '{opengeniProviderLoss,deathProof,provenAt}', '"2026-09-21T07:00:00.000Z"'::jsonb)
      where id = ${f.leaseId}`;
    expect(await authorizeAutomaticSandboxCheckpointRecovery(client.db, attempt)).toMatchObject({
      status: "authorized",
      lane: "fresh_workspace",
    });
  });
});
