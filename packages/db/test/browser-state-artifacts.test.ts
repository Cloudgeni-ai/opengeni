import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateBrowserSession,
  bootstrapWorkspace,
  claimBrowserStateArtifactCleanup,
  completeBrowserStateArtifactCleanup,
  createDb,
  createSession,
  dispatchBrowserSessionOperation,
  prepareBrowserSessionCreate,
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
    browserSessionId: prepared.session.id,
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
};

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
});
