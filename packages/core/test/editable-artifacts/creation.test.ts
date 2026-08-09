import { describe, expect, test } from "bun:test";
import {
  EditableArtifactIdempotencyConflictError,
  EditableArtifactRetryableConflictError,
} from "../../src/domain/editable-artifacts/errors";
import { hashEditableArtifactCreateRequest } from "../../src/domain/editable-artifacts/hash";
import {
  editableArtifactClientTransactionId,
  type CreateEditableArtifactRequest,
} from "../../src/domain/editable-artifacts/types";
import { artifactFixture, humanActor, scope } from "./fixtures";

const createRequest = (
  idempotencyKey = "create-budget",
  title = "Budget",
): CreateEditableArtifactRequest =>
  Object.freeze({
    idempotencyKey: editableArtifactClientTransactionId(idempotencyKey),
    modality: "spreadsheet" as const,
    title,
  });

describe("editable artifact genesis composition", () => {
  test("atomically publishes one verified sequence-zero artifact, receipt, and outbox", async () => {
    const fixture = await artifactFixture({ seed: false });
    const created = await fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request: createRequest(),
    });

    expect(created).toMatchObject({
      replayed: false,
      artifact: {
        modality: "spreadsheet",
        title: "Budget",
        lifecycle: "active",
        authorizationRevision: 1,
        headSequence: 0,
        causalFrontier: [],
      },
      genesisSnapshot: {
        coveredHeadSequence: 0,
        coveredCausalFrontier: [],
      },
    });
    expect(created.artifact.currentSnapshotId).toBe(created.genesisSnapshot.snapshotId);
    expect(created.artifact.stateHash).toBe(created.genesisSnapshot.stateHash);
    expect(created.creationReceipt.artifactId).toBe(created.artifact.id);
    expect(fixture.genesis.calls).toHaveLength(1);
    expect(fixture.snapshotVerifier.calls).toHaveLength(1);
    expect((await fixture.store.listOutbox()).map((item) => item.event.kind)).toEqual([
      "snapshot_published",
    ]);
  });

  test("replays durable semantic creation without rebuilding genesis", async () => {
    const fixture = await artifactFixture({ seed: false });
    const request = createRequest();
    const first = await fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request,
    });
    const replay = await fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.artifact.id).toBe(first.artifact.id);
    expect(replay.creationReceipt.receiptId).toBe(first.creationReceipt.receiptId);
    expect(fixture.genesis.calls).toHaveLength(1);
    expect(fixture.snapshotVerifier.calls).toHaveLength(1);
  });

  test("coalesces concurrent exact retries and rejects conflicting semantics", async () => {
    const fixture = await artifactFixture({ seed: false });
    let releaseGenesis!: () => void;
    fixture.genesis.wait = new Promise<void>((resolve) => {
      releaseGenesis = resolve;
    });
    const firstPromise = fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request: createRequest(),
    });
    await waitUntil(() => fixture.genesis.calls.length === 1);
    const replayPromise = fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request: createRequest(),
    });
    const conflictPromise = fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request: createRequest("create-budget", "Different title"),
    });
    releaseGenesis();

    const [first, replay] = await Promise.all([firstPromise, replayPromise]);
    expect(replay.replayed).toBe(true);
    expect(replay.artifact.id).toBe(first.artifact.id);
    await expect(conflictPromise).rejects.toBeInstanceOf(EditableArtifactIdempotencyConflictError);
    expect(fixture.genesis.calls).toHaveLength(1);
  });

  test("fences permission changes during native genesis without rerunning it", async () => {
    const fixture = await artifactFixture({ seed: false });
    let releaseGenesis!: () => void;
    fixture.genesis.wait = new Promise<void>((resolve) => {
      releaseGenesis = resolve;
    });
    const pending = fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request: createRequest("create-after-policy-change"),
    });
    await waitUntil(() => fixture.genesis.calls.length === 1);
    await fixture.store.advanceScopeCreateAuthorizationRevision(scope, 1, 2);
    fixture.authorization.setRevision(2);
    releaseGenesis();

    const created = await pending;
    expect(created.artifact.authorizationRevision).toBe(2);
    expect(fixture.authorization.calls.filter((call) => call.permission === "create")).toHaveLength(
      2,
    );
    expect(fixture.genesis.calls).toHaveLength(1);
    expect(fixture.snapshotVerifier.calls).toHaveLength(1);
  });

  test("cannot publish genesis after create permission is revoked", async () => {
    const fixture = await artifactFixture({ seed: false });
    let releaseGenesis!: () => void;
    fixture.genesis.wait = new Promise<void>((resolve) => {
      releaseGenesis = resolve;
    });
    const pending = fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request: createRequest("create-revoked-during-genesis"),
    });
    await waitUntil(() => fixture.genesis.calls.length === 1);
    await fixture.store.advanceScopeCreateAuthorizationRevision(scope, 1, 2);
    fixture.authorization.setRevision(2);
    fixture.authorization.deny("create");
    releaseGenesis();

    await expect(pending).rejects.toMatchObject({ code: "forbidden" });
    expect(fixture.genesis.calls).toHaveLength(1);
    expect(fixture.snapshotVerifier.calls).toHaveLength(1);
    expect(await fixture.store.listOutbox()).toHaveLength(0);
  });

  test("fails closed after bounded create-policy CAS contention", async () => {
    const fixture = await artifactFixture({ seed: false });
    await fixture.store.advanceScopeCreateAuthorizationRevision(scope, 1, 2);
    await expect(
      fixture.service.createArtifact({
        scope,
        actor: humanActor,
        request: createRequest("create-stale-policy"),
      }),
    ).rejects.toBeInstanceOf(EditableArtifactRetryableConflictError);
    expect(fixture.genesis.calls).toHaveLength(1);
    expect(fixture.authorization.calls.filter((call) => call.permission === "create")).toHaveLength(
      5,
    );
    expect(await fixture.store.listOutbox()).toHaveLength(0);
  });

  test("hashes only create semantics, never idempotency or generated facts", () => {
    const first = hashEditableArtifactCreateRequest(createRequest("key-one"));
    const retry = hashEditableArtifactCreateRequest(createRequest("key-two"));
    const changed = hashEditableArtifactCreateRequest(createRequest("key-one", "Budget 2027"));
    expect(retry).toBe(first);
    expect(changed).not.toBe(first);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for genesis");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
