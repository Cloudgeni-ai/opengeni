import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateBrowserSession,
  bootstrapWorkspace,
  BrowserStateUploadStateError,
  claimBrowserStateArtifactCleanup,
  claimBrowserStateUploadCleanup,
  commitBrowserRevisionPublication,
  completeBrowserStateArtifactCleanup,
  completeBrowserStateUploadCleanup,
  createBrowserIdentity,
  createDb,
  createSession,
  dispatchBrowserSessionOperation,
  dispatchBrowserRevisionPublication,
  failBrowserRevisionPublication,
  getBrowserSession,
  prepareBrowserRevisionPublication,
  prepareBrowserSessionCreate,
  prepareBrowserSessionSuspend,
  prepareBrowserStateUpload,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("browser-state-artifact-cleanup");
  if (!shared) {
    available = false;
    console.warn("[browser-state-artifact-cleanup] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `artifact-cleanup-account-${suffix}`,
    accountName: "Artifact cleanup",
    workspaceExternalSource: "test",
    workspaceExternalId: `artifact-cleanup-workspace-${suffix}`,
    workspaceName: "Artifact cleanup",
    subjectId: `artifact-cleanup-subject-${suffix}`,
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
  const operationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    operationId,
    associatedSessionId: session.id,
    actorSubjectId: grant.subjectId,
    name: "Cleanup browser",
    initialUrl: "https://example.com/",
    placement: { kind: "sandbox_group", sandboxGroupId: session.sandboxGroupId },
    driverId: "opengeni.cdp.v1",
    engine: "chromium",
    headless: true,
    identityId: null,
    baseRevisionId: null,
  });
  const controllerGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    operationId,
    browserSessionId: prepared.session.id,
    controllerGeneration,
  });
  await activateBrowserSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    operationId,
    browserSessionId: prepared.session.id,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.7922.108",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    browserSessionId: prepared.session.id,
    controllerGeneration,
  };
}

const materialization = {
  portability: "portable",
  reason: null,
  platform: "linux",
  architecture: "x64",
  engine: "chromium",
  engineVersion: "151.0.7922.108",
  driverId: "opengeni.cdp.v1",
  driverSchemaVersion: 1,
  profileCrypto: "chromium_basic",
  providerId: null,
  placement: null,
} as const;

async function insertArtifact(
  scope: Awaited<ReturnType<typeof fixture>>,
  input: {
    purpose?: "private_checkpoint" | "revision_component";
    state?: "available" | "delete_pending";
    retainedUntil?: Date | null;
  } = {},
) {
  const artifactId = crypto.randomUUID();
  const objectKey = `workspaces/${scope.workspaceId}/browser-state/checkpoints/${artifactId}.ogbp`;
  await shared!.admin`
    insert into browser_state_artifacts (
      id, account_id, workspace_id, source_browser_session_id, purpose, kind,
      format, artifact_digest, content_digest, manifest_digest, object_key,
      encrypted_data_key, size_bytes, materialization, state, retained_until
    ) values (
      ${artifactId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.browserSessionId},
      ${input.purpose ?? "private_checkpoint"}, 'chromium_profile',
      'application/vnd.opengeni.browser-profile.v1+tar+gzip+aes256gcm',
      ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${objectKey},
      ${`wrapped-data-key-${artifactId}`}, 4096, ${shared!.admin.json(materialization)},
      ${input.state ?? "available"}, ${input.retainedUntil ?? null}
    )`;
  return { artifactId, objectKey };
}

async function publication(scope: Awaited<ReturnType<typeof fixture>>) {
  const identity = (
    await createBrowserIdentity(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      operationId: crypto.randomUUID(),
      actorSubjectId: scope.subjectId,
      name: `Upload candidate ${crypto.randomUUID()}`,
    })
  ).identity;
  const operationId = crypto.randomUUID();
  const input = {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    operationId,
    browserSessionId: scope.browserSessionId,
    controllerGeneration: scope.controllerGeneration,
    identityId: identity.id,
    expectedHeadGeneration: 0,
    advanceDefault: true,
    actorSubjectId: scope.subjectId,
  };
  await prepareBrowserRevisionPublication(client.db, input);
  return input;
}

function publicationArtifact(scope: Awaited<ReturnType<typeof fixture>>, operationId: string) {
  return {
    kind: "chromium_profile" as const,
    format: "application/vnd.opengeni.browser-profile.v1+tar+gzip+aes256gcm",
    artifactDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    objectKey: `workspaces/${scope.workspaceId}/browser-state/publications/${operationId}.ogbp`,
    encryptedDataKey: `wrapped-data-key-${operationId}`,
    sizeBytes: 4096,
    materialization,
  };
}

describe("browser state artifact cleanup", () => {
  test("claims only due private checkpoints and fences exact completion", async () => {
    if (!available) return;
    const scope = await fixture();
    const due = await insertArtifact(scope, {
      state: "delete_pending",
      retainedUntil: new Date(Date.now() - 60_000),
    });
    await insertArtifact(scope, {
      state: "delete_pending",
      retainedUntil: new Date(Date.now() + 60_000),
    });
    await insertArtifact(scope, { purpose: "revision_component" });

    const [first] = await claimBrowserStateArtifactCleanup(client.db, {
      claimTimeoutMs: 60_000,
      limit: 100,
    });
    expect(first).toMatchObject({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      artifactId: due.artifactId,
      objectKey: due.objectKey,
    });
    expect(
      await claimBrowserStateArtifactCleanup(client.db, {
        claimTimeoutMs: 60_000,
        limit: 100,
      }),
    ).toEqual([]);

    const [reclaimed] = await claimBrowserStateArtifactCleanup(client.db, {
      claimTimeoutMs: 0,
      limit: 100,
    });
    expect(reclaimed?.artifactId).toBe(due.artifactId);
    expect(reclaimed?.claimId).not.toBe(first?.claimId);
    expect(await completeBrowserStateArtifactCleanup(client.db, first!)).toBe(false);
    expect(await completeBrowserStateArtifactCleanup(client.db, reclaimed!)).toBe(true);
    expect(await completeBrowserStateArtifactCleanup(client.db, reclaimed!)).toBe(true);

    const [row] = await shared!.admin<
      Array<{
        state: string;
        encryptedDataKey: string | null;
        deleteClaimId: string | null;
        deleteClaimedAt: Date | null;
        deletedAt: Date | null;
      }>
    >`
      select state, encrypted_data_key as "encryptedDataKey",
        delete_claim_id as "deleteClaimId", delete_claimed_at as "deleteClaimedAt",
        deleted_at as "deletedAt"
      from browser_state_artifacts where id = ${due.artifactId}`;
    expect(row).toMatchObject({
      state: "deleted",
      encryptedDataKey: null,
      deleteClaimId: null,
      deleteClaimedAt: null,
    });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  test("claims one row once across concurrent sweepers", async () => {
    if (!available) return;
    const scope = await fixture();
    const due = await insertArtifact(scope, {
      state: "delete_pending",
      retainedUntil: new Date(Date.now() - 60_000),
    });
    const batches = await Promise.all([
      claimBrowserStateArtifactCleanup(client.db, { claimTimeoutMs: 60_000, limit: 1 }),
      claimBrowserStateArtifactCleanup(client.db, { claimTimeoutMs: 60_000, limit: 1 }),
    ]);
    expect(batches.flat()).toHaveLength(1);
    expect(batches.flat()[0]?.artifactId).toBe(due.artifactId);
  });

  test("roots a prepared upload in the committed artifact transaction", async () => {
    if (!available) return;
    const scope = await fixture();
    const input = await publication(scope);
    const artifact = publicationArtifact(scope, input.operationId);
    await expect(
      dispatchBrowserRevisionPublication(client.db, {
        ...input,
        stateUpload: {
          objectKey: `workspaces/${scope.workspaceId}/browser-state/../escape.ogbp`,
          cleanupAfter: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toBeInstanceOf(BrowserStateUploadStateError);
    const [rolledBack] = await shared!.admin<Array<{ state: string; uploads: number }>>`
      select O.state, count(U.id)::int as uploads
      from interaction_operations O
      left join browser_state_uploads U
        on U.workspace_id = O.workspace_id and U.operation_id = O.operation_id
      where O.workspace_id = ${scope.workspaceId} and O.operation_id = ${input.operationId}
      group by O.state`;
    expect(rolledBack).toEqual({ state: "prepared", uploads: 0 });
    await dispatchBrowserRevisionPublication(client.db, {
      ...input,
      stateUpload: {
        objectKey: artifact.objectKey,
        cleanupAfter: new Date(Date.now() + 60_000),
      },
    });
    const [prepared] = await shared!.admin<Array<{ uploadId: string }>>`
      select id as "uploadId" from browser_state_uploads
      where workspace_id = ${scope.workspaceId} and operation_id = ${input.operationId}`;
    expect(prepared).toBeDefined();
    const renewedUntil = new Date(Date.now() + 120_000);
    expect(
      await dispatchBrowserRevisionPublication(client.db, {
        ...input,
        stateUpload: { objectKey: artifact.objectKey, cleanupAfter: renewedUntil },
      }),
    ).toMatchObject({ kind: "dispatched", replayed: true });
    const [renewed] = await shared!.admin<Array<{ cleanupAfter: Date }>>`
      select cleanup_after as "cleanupAfter"
      from browser_state_uploads where id = ${prepared!.uploadId}`;
    expect(renewed?.cleanupAfter.toISOString()).toBe(renewedUntil.toISOString());
    await commitBrowserRevisionPublication(client.db, {
      ...input,
      manifestDigest: artifact.manifestDigest,
      artifacts: [artifact],
    });
    const [row] = await shared!.admin<
      Array<{
        state: string;
        committedArtifactId: string | null;
        committedObjectKey: string | null;
        cleanupAfter: Date | null;
      }>
    >`
      select U.state, U.committed_artifact_id as "committedArtifactId",
        A.object_key as "committedObjectKey", U.cleanup_after as "cleanupAfter"
      from browser_state_uploads U
      left join browser_state_artifacts A
        on A.workspace_id = U.workspace_id and A.id = U.committed_artifact_id
      where U.id = ${prepared!.uploadId}`;
    expect(row).toMatchObject({
      state: "committed",
      committedArtifactId: expect.any(String),
      committedObjectKey: artifact.objectKey,
      cleanupAfter: null,
    });
    expect(
      await claimBrowserStateUploadCleanup(client.db, { claimTimeoutMs: 0, limit: 100 }),
    ).toEqual([]);
  });

  test("queues definite capture failure and reclaims an exact stale delete claim", async () => {
    if (!available) return;
    const scope = await fixture();
    const input = await publication(scope);
    const artifact = publicationArtifact(scope, input.operationId);
    await dispatchBrowserRevisionPublication(client.db, {
      ...input,
      stateUpload: {
        objectKey: artifact.objectKey,
        cleanupAfter: new Date(Date.now() + 60_000),
      },
    });
    await failBrowserRevisionPublication(client.db, {
      ...input,
      state: "failed",
      error: { code: "driver_failed", message: "capture failed", retryable: false },
    });
    const [first] = await claimBrowserStateUploadCleanup(client.db, {
      claimTimeoutMs: 60_000,
      limit: 100,
    });
    expect(first).toMatchObject({ objectKey: artifact.objectKey });
    const [reclaimed] = await claimBrowserStateUploadCleanup(client.db, {
      claimTimeoutMs: 0,
      limit: 100,
    });
    expect(reclaimed?.uploadId).toBe(first?.uploadId);
    expect(reclaimed?.claimId).not.toBe(first?.claimId);
    expect(await completeBrowserStateUploadCleanup(client.db, first!)).toBe(false);
    expect(await completeBrowserStateUploadCleanup(client.db, reclaimed!)).toBe(true);
    expect(await completeBrowserStateUploadCleanup(client.db, reclaimed!)).toBe(true);
  });

  test("expires abandoned publication authority before deleting its object", async () => {
    if (!available) return;
    const scope = await fixture();
    const input = await publication(scope);
    const artifact = publicationArtifact(scope, input.operationId);
    await prepareBrowserStateUpload(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      operationId: input.operationId,
      sourceBrowserSessionId: scope.browserSessionId,
      purpose: "revision_component",
      objectKey: artifact.objectKey,
      cleanupAfter: new Date(Date.now() + 100),
    });
    await Bun.sleep(150);
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = shared!.admin.begin(async (tx) => {
      await tx`
        select operation_id from interaction_operations
        where workspace_id = ${scope.workspaceId} and operation_id = ${input.operationId}
        for update`;
      locked();
      await hold;
    });
    await ready;
    try {
      const startedAt = performance.now();
      expect(
        await claimBrowserStateUploadCleanup(client.db, {
          claimTimeoutMs: 60_000,
          limit: 100,
        }),
      ).toEqual([]);
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      release();
      await blocker;
    }
    const [claim] = await claimBrowserStateUploadCleanup(client.db, {
      claimTimeoutMs: 60_000,
      limit: 100,
    });
    expect(claim?.objectKey).toBe(artifact.objectKey);
    const [operation] = await shared!.admin<Array<{ state: string; errorCode: string | null }>>`
      select state, error_code as "errorCode"
      from interaction_operations where operation_id = ${input.operationId}`;
    expect(operation).toEqual({
      state: "failed",
      errorCode: "browser_state_upload_expired",
    });
    expect(await completeBrowserStateUploadCleanup(client.db, claim!)).toBe(true);
  });

  test("returns undispatched suspension to active and marks dispatched suspension lost", async () => {
    if (!available) return;
    for (const dispatched of [false, true]) {
      const scope = await fixture();
      const operationId = crypto.randomUUID();
      await prepareBrowserSessionSuspend(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        browserSessionId: scope.browserSessionId,
        operationId,
        actorSubjectId: scope.subjectId,
      });
      const objectKey = `workspaces/${scope.workspaceId}/browser-state/checkpoints/${operationId}.ogbp`;
      if (dispatched) {
        await dispatchBrowserSessionOperation(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          operationId,
          browserSessionId: scope.browserSessionId,
          controllerGeneration: scope.controllerGeneration,
          stateUpload: {
            objectKey,
            cleanupAfter: new Date(Date.now() + 100),
          },
        });
      } else {
        await expect(
          dispatchBrowserSessionOperation(client.db, {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            operationId,
            browserSessionId: scope.browserSessionId,
            controllerGeneration: scope.controllerGeneration,
            stateUpload: {
              objectKey: `workspaces/${scope.workspaceId}/browser-state/../escape.ogbp`,
              cleanupAfter: new Date(Date.now() + 60_000),
            },
          }),
        ).rejects.toBeInstanceOf(BrowserStateUploadStateError);
        const [operation] = await shared!.admin<Array<{ state: string }>>`
          select state from interaction_operations
          where workspace_id = ${scope.workspaceId} and operation_id = ${operationId}`;
        expect(operation?.state).toBe("prepared");
        await prepareBrowserStateUpload(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          operationId,
          sourceBrowserSessionId: scope.browserSessionId,
          purpose: "private_checkpoint",
          objectKey,
          cleanupAfter: new Date(Date.now() + 100),
        });
      }
      await Bun.sleep(150);
      const [claim] = await claimBrowserStateUploadCleanup(client.db, {
        claimTimeoutMs: 60_000,
        limit: 100,
      });
      expect(claim?.objectKey).toBe(objectKey);
      expect(
        (
          await getBrowserSession(client.db, {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            browserSessionId: scope.browserSessionId,
          })
        ).lifecycle,
      ).toBe(dispatched ? "lost" : "active");
      const [operation] = await shared!.admin<Array<{ state: string }>>`
        select state from interaction_operations
        where workspace_id = ${scope.workspaceId} and operation_id = ${operationId}`;
      expect(operation?.state).toBe(dispatched ? "outcome_unknown" : "failed");
      expect(await completeBrowserStateUploadCleanup(client.db, claim!)).toBe(true);
    }
  });
});
