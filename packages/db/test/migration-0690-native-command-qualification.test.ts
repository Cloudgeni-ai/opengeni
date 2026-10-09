import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  beginModalProviderCreate,
  beginSandboxRematerialization,
  bootstrapWorkspace,
  commitWarmingToWarm,
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  claimWorkspaceArchiveCapture,
  confirmDrainCold,
  markSandboxRestoreVerifying,
  persistDrainSnapshot,
  registerSandboxCheckpointArtifact,
  recordWarmingSandboxCreated,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";
import { nativeCommandQualificationTriggerBindings } from "../src/native-command-readiness";
import {
  disableNativeCommandEnrollment,
  inspectNativeCommandProviderQualification,
  loadNativeCommandBirthQualification,
  publishNativeCommandQualification,
  type NativeCommandQualification,
} from "../src/native-command-qualification";

let fixture: OwnerMigratedTestDatabase, app: DbClient, owner: DbClient, appSql: postgres.Sql;
const SOURCE = "a".repeat(40);
const IMAGE = `ghcr.io/cloudgeni-ai/opengeni-desktop@sha256:${"b".repeat(64)}`;
const PROVIDER_IMAGE = "im-exact-native-fixture";
const BINDING = {
  version: 1 as const,
  serverUrl: "https://api.modal.test",
  workspaceName: "native-fixture",
  environment: "native-fixture",
};
const BINDING_KEY = JSON.stringify(BINDING);

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("native-command-qualification");
  if (!acquired) throw new Error("Native qualification requires isolated PostgreSQL");
  fixture = acquired;
  await migrate(fixture.ownerUrl, "public", {
    preinstalledVector: true,
    applicationDatabaseRoles: ["opengeni_app"],
  });
  await provisionRoles(fixture.adminUrl, { appPassword: fixture.appPassword });
  const appUrl = new URL(fixture.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = fixture.appPassword;
  app = createDb(appUrl.toString(), { max: 4 });
  owner = createDb(fixture.ownerUrl, { max: 2 });
  appSql = postgres(appUrl.toString(), { max: 2 });
  await assertRuntimeDatabasePosture(app.db, {
    rlsStrategy: "force",
    expectedRole: "opengeni_app",
  });
}, 180_000);
afterAll(async () => {
  await appSql?.end();
  await app?.close();
  await owner?.close();
  await fixture?.release();
}, 60_000);

test("qualification cannot fall back to legacy with a disabled, missing, or wrongly bound trigger", async () => {
  const tenant = await workspace();
  const legacy = await session(tenant);
  const scope = { ...tenant, sandboxGroupId: legacy.id };
  const q = await qualification(tenant);
  const input = {
    ...scope,
    providerInstanceId: "sb-legacy",
    leaseEpoch: 1,
    protocol: "native-subreaper-v1" as const,
    sourceSha: SOURCE,
  };
  expect(await inspectNativeCommandProviderQualification(app.db, input)).toEqual({
    status: "legacy",
  });
  for (const binding of nativeCommandQualificationTriggerBindings("public")) {
    const relation = `${binding.schema}.${binding.relation}`;
    const [saved] = await fixture.admin<{ ddl: string }[]>`
      select pg_get_triggerdef(t.oid) as ddl from pg_trigger t
      where t.tgrelid = ${relation}::regclass and t.tgname = ${binding.name}`;
    if (!saved?.ddl) throw new Error(`Missing fixture trigger ${binding.name}`);
    for (const mutation of ["disabled", "missing", "wrong-function"]) {
      if (mutation === "disabled") {
        await fixture.admin.unsafe(`ALTER TABLE ${relation} DISABLE TRIGGER ${binding.name}`);
      } else {
        await fixture.admin.unsafe(`DROP TRIGGER ${binding.name} ON ${relation}`);
        if (mutation === "wrong-function") {
          const otherFunction =
            binding.functionName === "native_command_receipt_immutable"
              ? "opengeni_private.native_command_qualification_guard()"
              : "opengeni_private.native_command_receipt_immutable()";
          await fixture.admin.unsafe(
            saved.ddl.replace(/EXECUTE FUNCTION .+$/u, `EXECUTE FUNCTION ${otherFunction}`),
          );
        }
      }
      try {
        await expect(
          assertRuntimeDatabasePosture(app.db, {
            rlsStrategy: "force",
            expectedRole: "opengeni_app",
          }),
        ).rejects.toThrow(`Native command qualification trigger ${binding.schema}.${binding.name}`);
        await expect(loadNativeCommandBirthQualification(app.db, scope)).rejects.toThrow(
          "Native command qualification is unavailable",
        );
        await expect(inspectNativeCommandProviderQualification(app.db, input)).rejects.toThrow(
          "Native command qualification is unavailable",
        );
        await expect(
          publishNativeCommandQualification(owner.db, {
            ...q,
            id: crypto.randomUUID(),
            activationGeneration: 2,
          }),
        ).rejects.toThrow("Native command qualification is unavailable");
      } finally {
        await fixture.admin.unsafe(`DROP TRIGGER IF EXISTS ${binding.name} ON ${relation}`);
        await fixture.admin.unsafe(saved.ddl);
      }
    }
  }
  expect(await inspectNativeCommandProviderQualification(app.db, input)).toEqual({
    status: "legacy",
  });
  await assertRuntimeDatabasePosture(app.db, {
    rlsStrategy: "force",
    expectedRole: "opengeni_app",
  });
});

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Native qualification",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Native qualification",
    subjectId: `test-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId! };
}

async function qualification(
  scope: Awaited<ReturnType<typeof workspace>>,
  generation = 1,
): Promise<NativeCommandQualification> {
  const row: NativeCommandQualification = {
    ...scope,
    id: crypto.randomUUID(),
    activationGeneration: generation,
    sourceSha: SOURCE,
    imageRef: IMAGE,
    providerImageId: PROVIDER_IMAGE,
    providerBindingKey: BINDING_KEY,
    protocols: ["native-subreaper-v1", "native-subreaper-pty-v1"],
    acceptanceEvidenceHash: "c".repeat(64),
    enrollmentEnabled: true,
  };
  await publishNativeCommandQualification(owner.db, row);
  return row;
}

async function session(
  scope: Awaited<ReturnType<typeof workspace>>,
  options: {
    sandboxBackend?: "modal" | "none";
    sandboxGroupId?: string;
    createIdempotencyKey?: string;
  } = {},
) {
  return createSession(app.db, {
    ...scope,
    ...options,
    sandboxBackend: options.sandboxBackend ?? "modal",
    initialMessage: "Qualification fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
  });
}

function scopeFor(scope: Awaited<ReturnType<typeof workspace>>, sandboxGroupId: string) {
  return { ...scope, sandboxGroupId };
}

async function warming(scope: ReturnType<typeof scopeFor>) {
  const leaseId = crypto.randomUUID();
  await fixture.admin`insert into sandbox_leases ${fixture.admin({
    id: leaseId,
    account_id: scope.accountId,
    workspace_id: scope.workspaceId,
    sandbox_group_id: scope.sandboxGroupId,
    backend: "modal",
    liveness: "warming",
    lease_epoch: 0,
    instance_id: null,
    expires_at: new Date(Date.now() + 60_000),
  })}`;
  return leaseId;
}

function createInput(
  scope: ReturnType<typeof scopeFor>,
  expectedEpoch = 0,
  overrides: Partial<Parameters<typeof beginModalProviderCreate>[1]> = {},
) {
  const operationId = crypto.randomUUID();
  return {
    ...scope,
    expectedEpoch,
    operationId,
    providerBindingKey: BINDING_KEY,
    rematerializationId: null,
    selectedRevision: null,
    imageId: PROVIDER_IMAGE,
    imageRef: IMAGE,
    appId: "ap-native-fixture",
    providerName: `opengeni-create-${operationId}`,
    requestSha256: "d".repeat(64),
    nativeSourceSha: SOURCE,
    nativeImagePreparation: {
      kind: "registry-import" as const,
      imageRef: IMAGE,
      imageId: PROVIDER_IMAGE,
    },
    ...overrides,
  };
}

async function warm(
  scope: ReturnType<typeof scopeFor>,
  create: ReturnType<typeof createInput>,
  instanceId = `sb-${crypto.randomUUID()}`,
) {
  const recorded = await recordWarmingSandboxCreated(app.db, {
    ...scope,
    expectedEpoch: create.expectedEpoch,
    providerCreateOperationId: create.operationId,
    rematerializationId: create.rematerializationId,
    instanceId,
    leaseTtlMs: 60_000,
  });
  expect(recorded.recorded).toBe(true);
  if (create.rematerializationId)
    expect(
      (
        await markSandboxRestoreVerifying(app.db, {
          ...scope,
          expectedEpoch: create.expectedEpoch,
          rematerializationId: create.rematerializationId,
        })
      ).wrote,
    ).toBe(true);
  const committed = await commitWarmingToWarm(app.db, {
    ...scope,
    expectedEpoch: create.expectedEpoch,
    instanceId,
    ...(create.rematerializationId
      ? {
          rematerialization: {
            id: create.rematerializationId,
            verifiedRevision: create.selectedRevision!,
          },
        }
      : {}),
    leaseTtlMs: 60_000,
  });
  expect(committed.committed).toBe(true);
  return { providerInstanceId: instanceId, leaseEpoch: committed.lease!.leaseEpoch };
}

async function inspect(
  scope: ReturnType<typeof scopeFor>,
  physical: { providerInstanceId: string; leaseEpoch: number },
  sourceSha = SOURCE,
) {
  return inspectNativeCommandProviderQualification(app.db, {
    ...scope,
    ...physical,
    protocol: "native-subreaper-pty-v1",
    sourceSha,
  });
}

async function checkpoint(
  scope: ReturnType<typeof scopeFor>,
  leaseId: string,
  physical: { providerInstanceId: string; leaseEpoch: number },
  snapshotId: string,
) {
  // Synthetic provider receipt fixture: exercise canonical final quiet drain
  // publication and replacement. Live provider stop/capture is proved by the
  // separate image qualification canary, not this database test.
  await fixture.admin`update sandbox_leases set liveness='draining' where id=${leaseId}`;
  const captureId = crypto.randomUUID();
  const claim = await claimWorkspaceArchiveCapture(app.db, {
    ...scope,
    captureId,
    expectedEpoch: physical.leaseEpoch,
    expectedInstanceId: physical.providerInstanceId,
    liveness: "draining",
    captureTimeoutMs: 30_000,
    minIntervalMs: 0,
    pointInTimeCapture: true,
  });
  expect(claim.status).toBe("claimed");
  if (claim.status !== "claimed") throw new Error(`Fixture native capture fenced: ${claim.status}`);
  const capturedAtMs = Date.now();
  const bytes = Buffer.from(
    `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({ snapshot_id: snapshotId, workspace_persistence: "snapshot_filesystem" })}`,
  );
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptor = {
    version: 2 as const,
    kind: "provider_snapshot" as const,
    revision: `wa2:${capturedAtMs}:${archiveSha256}`,
    archiveSha256,
    archiveBytes: bytes.length,
    capturedAt: new Date(capturedAtMs).toISOString(),
    provider: "modal_snapshot_filesystem" as const,
    snapshotId,
    workspacePersistence: "snapshot_filesystem" as const,
  };
  const artifact = await registerSandboxCheckpointArtifact(app.db, {
    ...scope,
    sourceLeaseId: leaseId,
    sourceLeaseEpoch: physical.leaseEpoch,
    sourceInstanceId: physical.providerInstanceId,
    sourceWorkspaceGeneration: claim.lease.workspaceGeneration,
    providerBindingKey: BINDING_KEY,
    providerBinding: BINDING,
    workspaceArchive: bytes.toString("base64"),
    workspaceArchiveMeta: descriptor,
  });
  const publication = await persistDrainSnapshot(app.db, {
    ...scope,
    expectedEpoch: physical.leaseEpoch,
    expectedInstanceId: physical.providerInstanceId,
    expectedWorkspaceGeneration: claim.lease.workspaceGeneration,
    captureId,
    workspaceArchive: bytes.toString("base64"),
    workspaceArchiveMeta: descriptor,
    checkpointArtifactId: artifact.id,
  });
  expect(publication.wrote).toBe(true);
  expect(
    (
      await confirmDrainCold(app.db, {
        ...scope,
        expectedCaptureId: captureId,
        expectedEpoch: physical.leaseEpoch,
        providerStopped: true,
      })
    ).wentCold,
  ).toBe(true);
  await fixture.admin`update sandbox_leases set liveness='warming' where id=${leaseId}`;
  const rematerializationId = crypto.randomUUID();
  const selected = await beginSandboxRematerialization(app.db, {
    ...scope,
    expectedEpoch: physical.leaseEpoch + 1,
    rematerializationId,
  });
  expect(selected.status).toBe("started");
  return {
    artifactId: artifact.id,
    snapshotId,
    revision: descriptor.revision,
    create: createInput(scope, physical.leaseEpoch + 1, {
      rematerializationId,
      selectedRevision: descriptor.revision,
      imageId: snapshotId,
      nativeImagePreparation: { kind: "provider-image-id", imageId: snapshotId },
    }),
  };
}

test("actual native image ID and canonical registry selector are required despite matching logical source/ref", async () => {
  const ws = await workspace();
  const q = await qualification(ws);
  const born = await session(ws);
  const scope = scopeFor(ws, born.sandboxGroupId);
  const leaseId = await warming(scope);
  const create = createInput(scope);
  for (const actualId of ["im-old-custom", "im-unrelated"]) {
    await expect(
      beginModalProviderCreate(app.db, {
        ...create,
        imageId: actualId,
        nativeImagePreparation: { kind: "registry-import", imageRef: IMAGE, imageId: actualId },
      }),
    ).rejects.toThrow("exact authenticated registry image");
  }
  await expect(
    beginModalProviderCreate(app.db, {
      ...create,
      nativeImagePreparation: { kind: "provider-image-id", imageId: PROVIDER_IMAGE },
    }),
  ).rejects.toThrow("exact authenticated registry image");
  const { nativeImagePreparation: _preparation, ...copied } = create;
  await expect(beginModalProviderCreate(app.db, copied)).rejects.toThrow(
    "actual canonical image preparation",
  );
  await expect(
    beginModalProviderCreate(app.db, {
      ...create,
      providerBindingKey: JSON.stringify({ ...BINDING, environment: "other" }),
    }),
  ).rejects.toThrow("exact installed source");
  const attempt = {
    version: 1,
    operationId: create.operationId,
    leaseEpoch: 0,
    providerBindingKey: create.providerBindingKey,
    rematerializationId: null,
    selectedRevision: null,
    imageId: "im-unrelated",
    imageRef: IMAGE,
    appId: create.appId,
    providerName: create.providerName,
    requestSha256: create.requestSha256,
    startedAt: new Date().toISOString(),
    instanceId: null,
    nativeCommandQualification: {
      qualificationId: q.id,
      activationGeneration: q.activationGeneration,
      sourceSha: q.sourceSha,
      imageRef: q.imageRef,
      providerImageId: q.providerImageId,
      providerBindingKey: q.providerBindingKey,
      acceptanceEvidenceHash: q.acceptanceEvidenceHash,
    },
    nativeImageSource: {
      kind: "stock-registry",
      imageId: "im-unrelated",
      checkpointArtifactId: null,
    },
  };
  await expect(
    Promise.resolve(
      fixture.admin`update sandbox_leases set provider_create_attempt=${fixture.admin.json(attempt)} where id=${leaseId}`,
    ),
  ).rejects.toThrow("actual image or checkpoint lineage");
  await beginModalProviderCreate(app.db, create);
  expect((await inspect(scope, await warm(scope, create))).status).toBe("enrolled");
});

test("two canonical filesystem checkpoint rotations keep qualified physical lineage and refuse unrelated snapshot selectors", async () => {
  const ws = await workspace();
  await qualification(ws);
  const born = await session(ws);
  const scope = scopeFor(ws, born.sandboxGroupId);
  const leaseId = await warming(scope);
  const first = createInput(scope);
  await beginModalProviderCreate(app.db, first);
  let physical = await warm(scope, first);
  for (const iteration of [1, 2]) {
    const selected = await checkpoint(
      scope,
      leaseId,
      physical,
      `im-qualified-snapshot-${crypto.randomUUID()}`,
    );
    await expect(
      beginModalProviderCreate(app.db, {
        ...selected.create,
        imageId: "im-unrelated-snapshot",
        nativeImagePreparation: { kind: "provider-image-id", imageId: "im-unrelated-snapshot" },
      }),
    ).rejects.toThrow("exact selected snapshot image");
    await expect(
      beginModalProviderCreate(app.db, {
        ...selected.create,
        imageId: PROVIDER_IMAGE,
        nativeImagePreparation: {
          kind: "registry-import",
          imageRef: IMAGE,
          imageId: PROVIDER_IMAGE,
        },
      }),
    ).rejects.toThrow("exact selected snapshot image");
    const [preserved] =
      await fixture.admin`select current_checkpoint_artifact_id from sandbox_leases where id=${leaseId}`;
    expect(preserved!.current_checkpoint_artifact_id).toBe(selected.artifactId);
    await beginModalProviderCreate(app.db, selected.create);
    physical = await warm(scope, selected.create);
    expect((await inspect(scope, physical)).status).toBe("enrolled");
    expect(iteration).toBeGreaterThan(0);
  }
});

test("matching selected snapshot metadata from an unqualified predecessor cannot mint lineage and remains preserved", async () => {
  const ws = await workspace();
  await qualification(ws);
  const born = await session(ws);
  const scope = scopeFor(ws, born.sandboxGroupId);
  const leaseId = crypto.randomUUID();
  const physical = { providerInstanceId: `sb-old-${crypto.randomUUID()}`, leaseEpoch: 1 };
  await fixture.admin`insert into sandbox_leases ${fixture.admin({
    id: leaseId,
    account_id: ws.accountId,
    workspace_id: ws.workspaceId,
    sandbox_group_id: scope.sandboxGroupId,
    backend: "modal",
    liveness: "warm",
    instance_id: physical.providerInstanceId,
    lease_epoch: 1,
    expires_at: new Date(Date.now() + 60_000),
  })}`;
  const selected = await checkpoint(
    scope,
    leaseId,
    physical,
    `im-old-snapshot-${crypto.randomUUID()}`,
  );
  await expect(beginModalProviderCreate(app.db, selected.create)).rejects.toMatchObject({
    cause: {
      code: "55000",
      message: "Qualified native command actual image or checkpoint lineage is unqualified",
    },
  });
  const [preserved] =
    await fixture.admin`select current_checkpoint_artifact_id, provider_create_attempt from sandbox_leases where id=${leaseId}`;
  expect(preserved!.current_checkpoint_artifact_id).toBe(selected.artifactId);
  expect(preserved!.provider_create_attempt).toBeNull();
});

test("only enabled canonical Modal self-group births qualify; old/shared/other-backend groups cannot upgrade", async () => {
  const ws = await workspace();
  const old = await session(ws);
  const oldScope = scopeFor(ws, old.sandboxGroupId);
  await warming(oldScope);
  const oldCreate = createInput(oldScope);
  await beginModalProviderCreate(app.db, oldCreate);
  const oldPhysical = await warm(oldScope, oldCreate);
  await qualification(ws);
  expect(await loadNativeCommandBirthQualification(app.db, oldScope)).toBeNull();
  expect(await inspect(oldScope, oldPhysical)).toEqual({ status: "legacy" });
  const shared = await session(ws, { sandboxGroupId: old.sandboxGroupId });
  expect(
    await loadNativeCommandBirthQualification(app.db, scopeFor(ws, shared.sandboxGroupId)),
  ).toBeNull();
  const other = await session(ws, { sandboxBackend: "none" });
  expect(
    await loadNativeCommandBirthQualification(app.db, scopeFor(ws, other.sandboxGroupId)),
  ).toBeNull();
  const born = await session(ws);
  const qualified = await loadNativeCommandBirthQualification(
    app.db,
    scopeFor(ws, born.sandboxGroupId),
  );
  expect(qualified?.activationGeneration).toBe(1);
  const child = await session(ws, { sandboxGroupId: born.sandboxGroupId });
  expect(
    await loadNativeCommandBirthQualification(app.db, scopeFor(ws, child.sandboxGroupId)),
  ).toEqual(qualified);
});

test("exact predispatch create then canonical warming transition binds instance/epoch; unknown create stays blocked", async () => {
  const ws = await workspace();
  const q = await qualification(ws);
  const born = await session(ws);
  const scope = scopeFor(ws, born.sandboxGroupId);
  const leaseId = await warming(scope);
  const create = createInput(scope);
  await beginModalProviderCreate(app.db, create);
  const [ledger] =
    await fixture.admin`select create_operation_id, create_attempt from opengeni_private.native_command_provider_enrollments where lease_id=${leaseId}`;
  expect(ledger!.create_operation_id).toBe(create.operationId);
  expect(ledger!.create_attempt.nativeCommandQualification).toEqual({
    qualificationId: q.id,
    activationGeneration: q.activationGeneration,
    sourceSha: SOURCE,
    imageRef: IMAGE,
    providerImageId: PROVIDER_IMAGE,
    providerBindingKey: BINDING_KEY,
    acceptanceEvidenceHash: q.acceptanceEvidenceHash,
  });
  expect((await inspect(scope, { providerInstanceId: "sb-unknown", leaseEpoch: 0 })).status).toBe(
    "blocked",
  );
  await expect(beginModalProviderCreate(app.db, create)).rejects.toThrow("cannot be replayed");
  const physical = await warm(scope, create);
  expect((await inspect(scope, physical)).status).toBe("enrolled");
  expect((await inspect(scope, { ...physical, providerInstanceId: "sb-other" })).status).toBe(
    "blocked",
  );
  expect((await inspect(scope, { ...physical, leaseEpoch: physical.leaseEpoch + 1 })).status).toBe(
    "blocked",
  );
  expect((await inspect(scope, physical, "e".repeat(40))).status).toBe("blocked");
  await expect(
    Promise.resolve(fixture.admin`update sandbox_leases set provider_create_attempt=
    provider_create_attempt-'nativeCommandQualification' where id=${leaseId}`),
  ).rejects.toThrow("descriptor is immutable");
  await expect(
    Promise.resolve(fixture.admin`update sandbox_leases set provider_create_attempt=
    jsonb_set(provider_create_attempt,'{requestSha256}',${fixture.admin.json("f".repeat(64))}) where id=${leaseId}`),
  ).rejects.toThrow("request is immutable");
  await expect(
    Promise.resolve(fixture.admin`update sandbox_leases set provider_create_attempt=
    jsonb_set(provider_create_attempt,'{imageId}',${fixture.admin.json("im-other")}) where id=${leaseId}`),
  ).rejects.toThrow("request is immutable");
  await expect(
    Promise.resolve(fixture.admin`update sandbox_leases set provider_create_attempt=
    jsonb_set(provider_create_attempt,'{instanceId}',${fixture.admin.json("sb-other")}),instance_id='sb-other' where id=${leaseId}`),
  ).rejects.toThrow("attribution is immutable");
  expect((await inspect(scope, physical)).status).toBe("enrolled");
});

test("missing source, wrong image and old raw create writers fail before dispatch; descriptor cannot be stripped or swapped", async () => {
  const ws = await workspace();
  await qualification(ws);
  const born = await session(ws);
  const scope = scopeFor(ws, born.sandboxGroupId);
  const leaseId = await warming(scope);
  const create = createInput(scope);
  const { nativeSourceSha: _installedSource, ...withoutSource } = create;
  await expect(beginModalProviderCreate(app.db, withoutSource)).rejects.toThrow(
    "exact installed source",
  );
  await expect(
    beginModalProviderCreate(app.db, {
      ...create,
      imageRef: IMAGE.replace("b".repeat(64), "f".repeat(64)),
    }),
  ).rejects.toThrow("exact installed source");
  const legacyAttempt = {
    version: 1,
    operationId: create.operationId,
    leaseEpoch: 0,
    providerBindingKey: create.providerBindingKey,
    rematerializationId: null,
    selectedRevision: null,
    imageId: create.imageId,
    imageRef: create.imageRef,
    appId: create.appId,
    providerName: create.providerName,
    requestSha256: create.requestSha256,
    startedAt: new Date().toISOString(),
    instanceId: null,
  };
  await expect(
    Promise.resolve(
      fixture.admin`update sandbox_leases set provider_create_attempt=${fixture.admin.json(legacyAttempt)} where id=${leaseId}`,
    ),
  ).rejects.toThrow("descriptor is immutable");
  await beginModalProviderCreate(app.db, create);
  await expect(
    Promise.resolve(
      fixture.admin`update sandbox_leases set provider_create_attempt=provider_create_attempt-'nativeCommandQualification' where id=${leaseId}`,
    ),
  ).rejects.toThrow("preserve operation");
  await expect(
    Promise.resolve(
      fixture.admin`update sandbox_leases set provider_create_attempt=jsonb_set(provider_create_attempt,'{nativeCommandQualification,sourceSha}',${fixture.admin.json("f".repeat(40))}) where id=${leaseId}`,
    ),
  ).rejects.toThrow("preserve operation");
});

test("disabling births preserves frozen cohort and exact replacement provenance; later generations never rewrite existing groups", async () => {
  const ws = await workspace();
  const q = await qualification(ws);
  const born = await session(ws);
  const scope = scopeFor(ws, born.sandboxGroupId);
  const leaseId = await warming(scope);
  const create = createInput(scope);
  await beginModalProviderCreate(app.db, create);
  const physical = await warm(scope, create);
  await disableNativeCommandEnrollment(owner.db, { ...ws, qualificationId: q.id });
  expect((await inspect(scope, physical)).status).toBe("enrolled");
  const disabledBorn = await session(ws);
  expect(
    await loadNativeCommandBirthQualification(app.db, scopeFor(ws, disabledBorn.sandboxGroupId)),
  ).toBeNull();
  await fixture.admin`update sandbox_leases set liveness='cold', instance_id=null, lease_epoch=lease_epoch+1 where id=${leaseId}`;
  expect((await inspect(scope, physical)).status).toBe("blocked");
  await fixture.admin`update sandbox_leases set liveness='warming' where id=${leaseId}`;
  const replacement = createInput(scope, 2);
  await beginModalProviderCreate(app.db, replacement);
  const fresh = await warm(scope, replacement);
  expect(fresh.leaseEpoch).toBe(3);
  expect((await inspect(scope, fresh)).status).toBe("enrolled");
  expect((await inspect(scope, physical)).status).toBe("blocked");
  const next = await qualification(ws, 2);
  const nextBorn = await session(ws);
  expect(
    (await loadNativeCommandBirthQualification(app.db, scopeFor(ws, nextBorn.sandboxGroupId)))?.id,
  ).toBe(next.id);
  expect((await loadNativeCommandBirthQualification(app.db, scope))?.id).toBe(q.id);
  await expect(qualification(ws, 1)).rejects.toThrow();
  const afterRejectedPublish = await session(ws);
  expect(
    (
      await loadNativeCommandBirthQualification(
        app.db,
        scopeFor(ws, afterRejectedPublish.sandboxGroupId),
      )
    )?.id,
  ).toBe(next.id);
  await expect(
    disableNativeCommandEnrollment(owner.db, { ...ws, qualificationId: crypto.randomUUID() }),
  ).rejects.toThrow("does not exist");
});

test("canonical keyed birth replay keeps the original qualification after disable and caller metadata cannot qualify a group", async () => {
  const ws = await workspace();
  const q = await qualification(ws);
  const input = {
    ...ws,
    createIdempotencyKey: `native-birth-${crypto.randomUUID()}`,
    sandboxBackend: "modal" as const,
    initialMessage: "Keyed birth",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
  };
  const first = await createSessionWithIdempotencyKeyResult(app.db, input);
  if (first.denied) throw new Error("Fixture birth was denied");
  expect(first.created).toBe(true);
  await disableNativeCommandEnrollment(owner.db, { ...ws, qualificationId: q.id });
  const replay = await createSessionWithIdempotencyKeyResult(app.db, input);
  if (replay.denied) throw new Error("Fixture replay was denied");
  expect(replay.created).toBe(false);
  expect(replay.session.id).toBe(first.session.id);
  expect(
    (await loadNativeCommandBirthQualification(app.db, scopeFor(ws, replay.session.sandboxGroupId)))
      ?.id,
  ).toBe(q.id);
  const forged = await createSession(app.db, {
    ...input,
    createIdempotencyKey: `metadata-${crypto.randomUUID()}`,
    metadata: { nativeCommandQualification: q, enrollmentEnabled: true, sourceSha: SOURCE },
  });
  expect(
    await loadNativeCommandBirthQualification(app.db, scopeFor(ws, forged.sandboxGroupId)),
  ).toBeNull();
  const [births] =
    await fixture.admin`select count(*)::integer as count from opengeni_private.native_command_group_births where workspace_id=${ws.workspaceId}`;
  expect(births!.count).toBe(1);
});

test("birth and operator publication serialize without session/lease lock inversion and select one committed generation", async () => {
  const ws = await workspace();
  const initial = await qualification(ws);
  const next = { ...initial, id: crypto.randomUUID(), activationGeneration: 2 };
  let opened!: (pid: number) => void, release!: () => void;
  const held = new Promise<number>((resolve) => {
    opened = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publication = owner.db.transaction(async (raw) => {
    const tx = raw as unknown as typeof owner.db;
    await publishNativeCommandQualification(tx, next);
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    opened(row!.pid);
    await resume;
  });
  const publisherPid = await held;
  const birth = session(ws);
  try {
    const deadline = Date.now() + 3000;
    for (;;) {
      const [waiting] = await fixture.admin`select exists(select 1 from pg_stat_activity
        where datname=current_database() and wait_event='advisory' and ${publisherPid} = any(pg_blocking_pids(pid))) as present`;
      if (waiting!.present) break;
      if (Date.now() >= deadline)
        throw new Error("Canonical birth did not wait for operator qualification publication");
      await Bun.sleep(10);
    }
  } finally {
    release();
  }
  await publication;
  const created = await birth;
  expect(
    (await loadNativeCommandBirthQualification(app.db, scopeFor(ws, created.sandboxGroupId)))?.id,
  ).toBe(next.id);
}, 30_000);

test("FORCE-RLS owner-only writes, immutable evidence and scoped reads survive polluted ACL reprovisioning", async () => {
  const ws = await workspace();
  const q = await qualification(ws);
  const born = await session(ws);
  const scope = scopeFor(ws, born.sandboxGroupId);
  const [posture] =
    await fixture.admin`select bool_and(relforcerowsecurity) as forced from pg_class where oid in
    ('opengeni_private.native_command_qualifications'::regclass,'opengeni_private.native_command_group_births'::regclass,
     'opengeni_private.native_command_provider_enrollments'::regclass,'opengeni_private.native_command_provider_bindings'::regclass)`;
  expect(posture!.forced).toBe(true);
  await expect(
    publishNativeCommandQualification(app.db, {
      ...q,
      id: crypto.randomUUID(),
      activationGeneration: 2,
    }),
  ).rejects.toThrow();
  await expect(
    disableNativeCommandEnrollment(app.db, { ...ws, qualificationId: q.id }),
  ).rejects.toThrow();
  await expect(
    Promise.resolve(
      fixture.admin`update opengeni_private.native_command_qualifications set source_sha=${"f".repeat(40)} where id=${q.id}`,
    ),
  ).rejects.toThrow("immutable");
  await expect(
    Promise.resolve(
      fixture.admin`delete from opengeni_private.native_command_group_births where sandbox_group_id=${scope.sandboxGroupId}`,
    ),
  ).rejects.toThrow("immutable");
  await expect(
    Promise.resolve(
      appSql`select native_command_birth_qualification(${ws.accountId}::uuid,${ws.workspaceId}::uuid,${scope.sandboxGroupId}::uuid)`,
    ),
  ).rejects.toThrow("scope mismatch");
  await fixture.admin.unsafe(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON opengeni_private.native_command_qualifications TO opengeni_app",
  );
  await fixture.admin.unsafe(
    "GRANT UPDATE (enrollment_enabled) ON opengeni_private.native_command_qualifications TO opengeni_app",
  );
  await fixture.admin.unsafe(
    "GRANT EXECUTE ON FUNCTION opengeni_private.native_command_qualification_guard() TO opengeni_app",
  );
  await provisionRoles(fixture.adminUrl, { appPassword: fixture.appPassword });
  const [acl] =
    await fixture.admin`select has_table_privilege('opengeni_app','opengeni_private.native_command_qualifications','INSERT') as insertable,
    has_column_privilege('opengeni_app','opengeni_private.native_command_qualifications','enrollment_enabled','UPDATE') as mutable,
    has_function_privilege('opengeni_app','opengeni_private.native_command_qualification_guard()','EXECUTE') as guard`;
  expect(acl).toEqual({ insertable: false, mutable: false, guard: false });
  expect((await loadNativeCommandBirthQualification(app.db, scope))?.id).toBe(q.id);
  await assertRuntimeDatabasePosture(app.db, {
    rlsStrategy: "force",
    expectedRole: "opengeni_app",
  });
});
