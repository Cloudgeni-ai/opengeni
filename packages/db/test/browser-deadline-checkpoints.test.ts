import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  browserDeadlineCheckpoint,
  clearSuspendedBrowserSessionController,
  commitBrowserSessionSuspension,
  createDb,
  dispatchBrowserSessionOperation,
  getBrowserPrivateCheckpointAuthority,
  listBrowserDeadlineCheckpoints,
  prepareBrowserSessionResume,
  reapStaleLeaseHoldersGlobal,
  releaseLeaseHolder,
  withRlsContext,
  type BrowserStateArtifactCommitInput,
} from "../src";
import { migrate } from "../src/migrate";
import { seedBrowserDeadlineCheckpoint } from "../../../test/fixtures/browser-deadline-checkpoint";

let owned: OwnerMigratedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const database = await acquireOwnerMigratedTestDatabase("browser-deadline-checkpoint");
  if (!database)
    throw new Error("real database required for browser deadline lifecycle acceptance");
  owned = database;
  await migrate(owned.ownerUrl);
  client = createDb(owned.ownerUrl, { max: 3 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await owned?.release();
}, 120_000);

const seed = (options: { checkpoint?: boolean; rotation?: string } = {}) =>
  seedBrowserDeadlineCheckpoint(owned, options);

function artifact(
  target: Awaited<ReturnType<typeof seed>>,
  operationId: string,
): BrowserStateArtifactCommitInput {
  return {
    kind: "chromium_profile",
    format: "application/vnd.opengeni.browser-profile.v1+tar+gzip+aes256gcm",
    objectKey: `workspaces/${target.workspaceId}/browser-state/checkpoints/${operationId}.ogbp`,
    artifactDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    encryptedDataKey: `test-wrapped-key-${operationId}`,
    sizeBytes: 4096,
    materialization: {
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
    },
  };
}

async function dispatch(target: Awaited<ReturnType<typeof seed>>) {
  const claim = await browserDeadlineCheckpoint(client.db, target, { prepare: true });
  if (!claim) throw new Error("checkpoint fixture claim missing");
  const saved = artifact(target, claim.operationId);
  await dispatchBrowserSessionOperation(client.db, {
    ...target,
    operationId: claim.operationId,
    deadlineTarget: target,
    stateUpload: { objectKey: saved.objectKey, cleanupAfter: new Date(Date.now() + 60_000) },
  });
  return { claim, saved };
}

test("only automatic, checkpoint-capable exact managed placements enter inventory", async () => {
  const target = await seed();
  const unsupported = await seed({ checkpoint: false });
  const operator = await seed({ rotation: "operator" });
  const inventory = await listBrowserDeadlineCheckpoints(client.db);
  expect(inventory).toContainEqual(target);
  expect(inventory).not.toContainEqual(unsupported);
  expect(inventory).not.toContainEqual(operator);
  await expect(listBrowserDeadlineCheckpoints(client.db, 501)).rejects.toThrow();
});

test("system suspension is idempotent and cannot borrow another lease, workspace or controller", async () => {
  const target = await seed();
  const prepared = await browserDeadlineCheckpoint(client.db, target, {
    prepare: true,
    touch: true,
  });
  expect(prepared?.state).toBe("prepared");
  expect(await browserDeadlineCheckpoint(client.db, target, { prepare: true })).toEqual(prepared);
  for (const forged of [
    { ...target, leaseEpoch: 2 },
    { ...target, instanceId: "different-instance" },
    { ...target, workspaceId: crypto.randomUUID() },
    { ...target, controllerGeneration: crypto.randomUUID() },
  ]) {
    expect(await browserDeadlineCheckpoint(client.db, forged, { prepare: true })).toBeNull();
  }
  const [row] = await owned.admin`select browser.lifecycle, operation.actor_subject_id
    from browser_sessions browser join interaction_operations operation
      on operation.operation_id = ${prepared!.operationId}
    where browser.id = ${target.browserSessionId}`;
  expect(row).toEqual({
    lifecycle: "suspending",
    actor_subject_id: "system:sandbox-provider-deadline",
  });
});

test("lead-time reaping retains a saveable browser; physical expiry still releases it", async () => {
  const target = await seed();
  const settings = {
    viewerHolderTtlMs: 90_000,
    turnHolderTtlMs: 90_000,
    interactionHolderTtlMs: 90_000,
    idleGraceMs: 0,
  };
  await reapStaleLeaseHoldersGlobal(client.db, settings);
  const [before] =
    await owned.admin`select lifecycle from browser_sessions where id = ${target.browserSessionId}`;
  expect(before?.lifecycle).toBe("active");
  await owned.admin`update sandbox_leases set provider_created_at = now() - interval '25 hours',
    provider_deadline_at = now() - interval '1 minute' where id = ${target.leaseId}`;
  expect(await browserDeadlineCheckpoint(client.db, target, { prepare: true })).toBeNull();
  await reapStaleLeaseHoldersGlobal(client.db, settings);
  const [after] =
    await owned.admin`select lifecycle, failure_code from browser_sessions where id = ${target.browserSessionId}`;
  expect(after).toEqual({ lifecycle: "lost", failure_code: "provider_deadline_rotation" });
});

test("a replaced lease cannot dispatch or commit a stale browser checkpoint", async () => {
  const target = await seed();
  const claim = await browserDeadlineCheckpoint(client.db, target, { prepare: true });
  if (!claim) throw new Error("checkpoint fixture claim missing");
  await owned.admin`update sandbox_leases set lease_epoch = 2 where id = ${target.leaseId}`;
  await expect(
    dispatchBrowserSessionOperation(client.db, {
      ...target,
      operationId: claim.operationId,
      deadlineTarget: target,
    }),
  ).rejects.toThrow("Browser deadline checkpoint authority changed");
  const [undispatched] =
    await owned.admin`select state from interaction_operations where operation_id = ${claim.operationId}`;
  expect(undispatched?.state).toBe("prepared");

  const capturing = await seed();
  const { claim: dispatched, saved } = await dispatch(capturing);
  await owned.admin`update sandbox_leases set instance_id = 'replacement-fixture' where id = ${capturing.leaseId}`;
  await expect(
    commitBrowserSessionSuspension(client.db, {
      ...capturing,
      operationId: dispatched.operationId,
      deadlineTarget: capturing,
      artifact: saved,
    }),
  ).rejects.toThrow("Browser deadline checkpoint authority changed");
  expect(await getBrowserPrivateCheckpointAuthority(client.db, capturing)).toBeNull();
});

test("durable automatic suspension replays cleanup and then uses ordinary resume", async () => {
  const target = await seed();
  const { claim, saved } = await dispatch(target);
  await commitBrowserSessionSuspension(client.db, {
    ...target,
    operationId: claim.operationId,
    deadlineTarget: target,
    artifact: saved,
  });
  expect(await browserDeadlineCheckpoint(client.db, target, { prepare: true })).toEqual({
    operationId: claim.operationId,
    state: "completed",
  });
  expect(await getBrowserPrivateCheckpointAuthority(client.db, target)).toMatchObject({
    objectKey: saved.objectKey,
  });
  await withRlsContext(
    client.db,
    target,
    async (tx) => {
      expect((await browserDeadlineCheckpoint(tx, target))?.state).toBe("completed");
      expect(
        await clearSuspendedBrowserSessionController(tx, {
          ...target,
          expectedControllerGeneration: target.controllerGeneration,
        }),
      ).toBe(true);
      await releaseLeaseHolder(tx, {
        ...target,
        kind: "interaction",
        holderId: `browser-session:${target.browserSessionId}`,
        idleGraceMs: 0,
      });
    },
    undefined,
    "none",
  );
  expect(await browserDeadlineCheckpoint(client.db, target, { prepare: true })).toBeNull();
  const resume = await prepareBrowserSessionResume(client.db, {
    ...target,
    operationId: crypto.randomUUID(),
    actorSubjectId: "fixture-human",
  });
  expect(resume.session.lifecycle).toBe("restoring");
  expect(await getBrowserPrivateCheckpointAuthority(client.db, target)).toMatchObject({
    objectKey: saved.objectKey,
  });
});

test("another live operation blocks cleanup of a completed automatic checkpoint", async () => {
  const target = await seed();
  const { claim, saved } = await dispatch(target);
  await commitBrowserSessionSuspension(client.db, {
    ...target,
    operationId: claim.operationId,
    deadlineTarget: target,
    artifact: saved,
  });
  await owned.admin`insert into interaction_operations (
    operation_id, account_id, workspace_id, resource_kind, resource_id, kind, request_digest, state, actor_subject_id
  ) values (${crypto.randomUUID()}, ${target.accountId}, ${target.workspaceId}, 'browser_session',
    ${target.browserSessionId}, 'resume', ${"d".repeat(64)}, 'prepared', 'fixture-human')`;
  expect(await browserDeadlineCheckpoint(client.db, target)).toBeNull();
});

test("provider expiry after failed cleanup preserves the checkpoint and permits ordinary resume", async () => {
  const target = await seed();
  const { claim, saved } = await dispatch(target);
  await commitBrowserSessionSuspension(client.db, {
    ...target,
    operationId: claim.operationId,
    deadlineTarget: target,
    artifact: saved,
  });
  const reaperSettings = {
    viewerHolderTtlMs: 90_000,
    turnHolderTtlMs: 90_000,
    interactionHolderTtlMs: 90_000,
    idleGraceMs: 0,
  };
  await reapStaleLeaseHoldersGlobal(client.db, reaperSettings);
  expect((await browserDeadlineCheckpoint(client.db, target))?.state).toBe("completed");
  await owned.admin`update sandbox_leases set provider_created_at = now() - interval '25 hours',
    provider_deadline_at = now() - interval '1 minute' where id = ${target.leaseId}`;
  await reapStaleLeaseHoldersGlobal(client.db, reaperSettings);
  expect(await getBrowserPrivateCheckpointAuthority(client.db, target)).toMatchObject({
    objectKey: saved.objectKey,
  });
  const [state] = await owned.admin`select lifecycle, controller_id, failure_code
    from browser_sessions where id = ${target.browserSessionId}`;
  expect(state).toEqual({ lifecycle: "suspended", controller_id: null, failure_code: null });
  const resume = await prepareBrowserSessionResume(client.db, {
    ...target,
    operationId: crypto.randomUUID(),
    actorSubjectId: "fixture-human",
  });
  expect(resume.session.lifecycle).toBe("restoring");
});
