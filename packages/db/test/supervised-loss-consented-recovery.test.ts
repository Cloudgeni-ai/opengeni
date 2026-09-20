import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acquireLease,
  beginSandboxRematerialization,
  bootstrapWorkspace,
  commitWarmingToWarm,
  consentPublicSandboxRecovery,
  createDb,
  createSession,
  getRetainedProcess,
  markSandboxRestoreVerifying,
  markWarmLeaseInstanceLost,
  readLease,
  readPublicSandboxRecovery,
  recordWarmingSandboxCreated,
  registerSandboxCheckpointArtifact,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("supervised-loss-recovery");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl);
  await shared.admin`update opengeni_private.sandbox_recovery_rollout set consent_enabled=true,
    release_evidence='isolated integration regression, not live activation'`;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("supervised provider loss permits explicit historical consent without rewriting incomplete evidence", async () => {
  const unique = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: unique,
    accountName: "loss-recovery",
    workspaceExternalSource: "test",
    workspaceExternalId: unique,
    workspaceName: "loss-recovery",
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
    sandboxBackend: "modal",
  });
  const leaseId = crypto.randomUUID();
  const processId = crypto.randomUUID();
  const admissionId = crypto.randomUUID();
  const actorId = crypto.randomUUID();
  const invocationId = crypto.randomUUID();
  const capturedAt = "2026-09-16T06:24:07.000Z";
  const archive = Buffer.from(
    `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({ snapshot_id: `im-${unique}`, workspace_persistence: "snapshot_filesystem" })}`,
  ).toString("base64");
  const sha = createHash("sha256").update(Buffer.from(archive, "base64")).digest("hex");
  const descriptor = {
    version: 2 as const,
    kind: "provider_snapshot" as const,
    revision: `wa2:${Date.parse(capturedAt)}:${sha}`,
    capturedAt,
    archiveSha256: sha,
    archiveBytes: Buffer.from(archive, "base64").length,
    provider: "modal_snapshot_filesystem" as const,
    snapshotId: `im-${unique}`,
    workspacePersistence: "snapshot_filesystem",
  };
  const command = {
    kind: "modal-router-v1" as const,
    sandboxId: "sb-lost",
    taskId: "ta-lost",
    execId: crypto.randomUUID(),
    supervision: {
      protocol: "native-subreaper-v1" as const,
      invocationId,
      nonce: "a".repeat(64),
      controlPath: `/tmp/opengeni-supervision/${invocationId}.sock`,
    },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
    },
  };
  const resume = {
    backendId: "modal",
    sessionState: {
      workspaceArchive: archive,
      workspaceArchiveMeta: descriptor,
      providerState: { sandboxId: "sb-lost" },
    },
  };
  await shared.admin`insert into sandbox_leases(id,account_id,workspace_id,sandbox_group_id,backend,liveness,
    lease_epoch,instance_id,workspace_generation,archive_generation,resume_backend_id,resume_state,expires_at,refcount)
    values(${leaseId},${scope.accountId},${scope.workspaceId},${session.sandboxGroupId},'modal','warm',2,'sb-lost',44,10,
      'modal',${shared.admin.json(resume)},now()+interval '1 minute',1)`;
  const binding = {
    version: 1,
    serverUrl: "https://modal.test",
    workspaceName: "loss-recovery-fixture",
    environment: "main",
  };
  const artifact = await registerSandboxCheckpointArtifact(client.db, {
    ...scope,
    sandboxGroupId: session.sandboxGroupId,
    sourceLeaseId: leaseId,
    sourceLeaseEpoch: 2,
    sourceInstanceId: "sb-lost",
    sourceWorkspaceGeneration: 10,
    providerBinding: binding,
    providerBindingKey: JSON.stringify(binding),
    workspaceArchive: archive,
    workspaceArchiveMeta: descriptor,
  });
  await shared.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id',${scope.accountId},true),set_config('opengeni.workspace_id',${scope.workspaceId},true)`;
    await tx`update sandbox_checkpoint_artifacts set state='current' where id=${artifact.id}`;
    await tx`update sandbox_leases set current_checkpoint_artifact_id=${artifact.id} where id=${leaseId}`;
    await tx`insert into sandbox_workspace_mutation_admissions ${tx({
      id: admissionId,
      account_id: scope.accountId,
      workspace_id: scope.workspaceId,
      session_id: session.id,
      lease_id: leaseId,
      sandbox_group_id: session.sandboxGroupId,
      actor_kind: "direct",
      actor_id: actorId,
      holder_kind: "direct",
      holder_id: `direct:${actorId}`,
      lease_epoch: 2,
      provider_backend: "modal",
      provider_instance_id: "sb-lost",
      route_kind: "home",
      route_epoch: 0,
      workspace_generation: 44,
      operation: "execCommand",
      provider_outcome: "retained",
    })}`;
    await tx`insert into sandbox_lease_holders ${tx({
      account_id: scope.accountId,
      workspace_id: scope.workspaceId,
      lease_id: leaseId,
      kind: "process",
      holder_id: `process:${processId}`,
      subject_id: session.id,
    })}`;
    await tx`insert into sandbox_retained_processes ${tx({
      id: processId,
      account_id: scope.accountId,
      workspace_id: scope.workspaceId,
      session_id: session.id,
      lease_id: leaseId,
      sandbox_group_id: session.sandboxGroupId,
      parent_admission_id: admissionId,
      holder_id: `process:${processId}`,
      owner_actor_kind: "direct",
      owner_actor_id: actorId,
      lease_epoch: 2,
      provider_backend: "modal",
      provider_instance_id: "sb-lost",
      route_kind: "home",
      route_epoch: 0,
      provider_session_id: 71,
      provider_command: tx.json(command),
    })}`;
  });
  const loss = await markWarmLeaseInstanceLost(client.db, {
    ...scope,
    sandboxGroupId: session.sandboxGroupId,
    expectedEpoch: 2,
    expectedInstanceId: "sb-lost",
    expectedBackend: "modal",
  });
  expect(loss.status).toBe("marked");
  const processScope = { ...scope, sessionId: session.id, processId };
  expect(await getRetainedProcess(client.db, processScope)).toMatchObject({
    state: "lost",
    exitCode: null,
  });
  const [evidence] =
    await shared.admin`select supervision_receipt,supervision_output_captured,provider_command,
    settlement_reason from sandbox_retained_processes where id=${processId}`;
  expect(evidence).toEqual({
    supervision_receipt: null,
    supervision_output_captured: false,
    provider_command: command,
    settlement_reason: "provider_instance_lost",
  });
  const input = { ...scope, sessionId: session.id };
  const preview = await readPublicSandboxRecovery(client.db, input);
  expect(preview.status).toBe("eligible");
  const request = {
    operationId: crypto.randomUUID(),
    acceptHistoricalCheckpoint: true as const,
    selection: preview.checkpoint!,
  };
  expect(
    (await consentPublicSandboxRecovery(client.db, { ...input, request })).recovery.status,
  ).toBe("consent_accepted");
  const leaseScope = {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    sandboxGroupId: session.sandboxGroupId,
  };
  const elected = await acquireLease(client.db, {
    ...leaseScope,
    kind: "viewer",
    holderId: "loss-recovery-test",
    backend: "modal",
    leaseTtlMs: 60_000,
  });
  expect(elected.role).toBe("spawner");
  expect(elected.lease.archiveComplete).toBe(false);
  const rematerializationId = crypto.randomUUID();
  const expectedEpoch = elected.lease.leaseEpoch;
  expect(
    await beginSandboxRematerialization(client.db, {
      ...leaseScope,
      expectedEpoch,
      rematerializationId,
    }),
  ).toMatchObject({ status: "started" });
  await recordWarmingSandboxCreated(client.db, {
    ...leaseScope,
    expectedEpoch,
    rematerializationId,
    instanceId: "sb-restored",
    resumeBackendId: "modal",
    resumeState: {
      backendId: "modal",
      sessionState: { providerState: { sandboxId: "sb-restored" } },
    },
    leaseTtlMs: 60_000,
  });
  await markSandboxRestoreVerifying(client.db, {
    ...leaseScope,
    expectedEpoch,
    rematerializationId,
  });
  expect(
    await commitWarmingToWarm(client.db, {
      ...leaseScope,
      expectedEpoch,
      instanceId: "sb-restored",
      leaseTtlMs: 60_000,
      rematerialization: { id: rematerializationId, verifiedRevision: request.selection.revision },
    }),
  ).toMatchObject({ committed: true });
  expect(await readLease(client.db, scope.workspaceId, session.sandboxGroupId)).toMatchObject({
    workspaceGeneration: 44,
    archiveGeneration: 10,
    archiveComplete: false,
  });
  expect((await readPublicSandboxRecovery(client.db, input)).status).toBe("restored");
  expect((await getRetainedProcess(client.db, processScope))?.state).toBe("lost");
  expect((await consentPublicSandboxRecovery(client.db, { ...input, request })).outcome).toBe(
    "replayed",
  );
}, 60_000);
