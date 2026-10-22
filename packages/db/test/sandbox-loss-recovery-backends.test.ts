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
  consentPublicSandboxRecovery,
  createDb,
  createSession,
  failWarmingToCold,
  getSandboxRecoveryDiscontinuity,
  markWarmLeaseInstanceLost,
  readLease,
  readPublicSandboxRecovery,
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
    expect(
      await beginSandboxRematerialization(client.db, {
        ...f.group,
        expectedEpoch: elected.lease.leaseEpoch,
        rematerializationId: crypto.randomUUID(),
      }),
    ).toMatchObject({ status: "started" });
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
