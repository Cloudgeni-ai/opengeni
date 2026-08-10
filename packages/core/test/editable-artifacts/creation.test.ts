import { describe, expect, test } from "bun:test";
import {
  EditableArtifactIdempotencyConflictError,
  EditableArtifactRetryableConflictError,
} from "../../src/domain/editable-artifacts/errors";
import {
  hashEditableArtifactCreateRequest,
  hashEditableArtifactImportRequest,
} from "../../src/domain/editable-artifacts/hash";
import {
  editableArtifactCausalFrontier,
  editableArtifactClientTransactionId,
  editableArtifactContentHash,
  editableArtifactReplicaId,
  editableArtifactStateHash,
  type CreateEditableArtifactRequest,
  type ImportEditableArtifactRequest,
} from "../../src/domain/editable-artifacts/types";
import { artifactFixture, hash, humanActor, scope } from "./fixtures";

const createRequest = (
  idempotencyKey = "create-budget",
  title = "Budget",
): CreateEditableArtifactRequest =>
  Object.freeze({
    idempotencyKey: editableArtifactClientTransactionId(idempotencyKey),
    modality: "spreadsheet" as const,
    title,
  });

const importRequest = (
  input: Readonly<{
    idempotencyKey?: string;
    title?: string;
    blobReference?: string;
    sourceContentHash?: string;
  }> = {},
): ImportEditableArtifactRequest =>
  Object.freeze({
    idempotencyKey: editableArtifactClientTransactionId(input.idempotencyKey ?? "import-budget"),
    modality: "spreadsheet" as const,
    title: input.title ?? "Imported budget",
    originalImport: Object.freeze({
      fileId: "63b07634-ec8b-4fca-9030-598cc756c60b",
      blobReference: input.blobReference ?? "files/imported-budget.xlsx",
      byteSize: 4_096,
      contentHash: editableArtifactContentHash(input.sourceContentHash ?? hash(801)),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
    }),
    snapshot: Object.freeze({
      modality: "spreadsheet" as const,
      blobReference: "editable-artifacts/snapshots/imported-budget",
      byteSize: 8_192,
      contentHash: editableArtifactContentHash(hash(802)),
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot" as const,
      coveredHeadSequence: 0,
      coveredCausalFrontier: editableArtifactCausalFrontier([
        { replicaId: editableArtifactReplicaId("0000000000000009"), counter: 4 },
      ]),
      stateHash: editableArtifactStateHash(hash(803)),
      modelSchemaVersion: 1,
      operationProtocolVersion: 1,
      kernelVersion: "test-kernel/1",
      crdtStateVersion: 1,
    }),
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

  test("atomically imports one retained Office file as verified sequence-zero state", async () => {
    const fixture = await artifactFixture({ seed: false });
    const created = await fixture.service.importArtifact({
      scope,
      actor: humanActor,
      request: importRequest(),
    });

    expect(created).toMatchObject({
      replayed: false,
      artifact: {
        modality: "spreadsheet",
        title: "Imported budget",
        headSequence: 0,
        causalFrontier: [{ replicaId: "0000000000000009", counter: 4 }],
      },
      genesisSnapshot: {
        coveredHeadSequence: 0,
        coveredCausalFrontier: [{ replicaId: "0000000000000009", counter: 4 }],
        verifiedAt: "2026-08-08T10:00:00.000Z",
        publishedAt: "2026-08-08T10:00:00.000Z",
      },
      creationReceipt: { operationKind: "import" },
    });
    expect(fixture.genesis.calls).toHaveLength(0);
    expect(fixture.snapshotVerifier.calls).toHaveLength(1);
    expect(fixture.authorization.calls.map((call) => call.permission)).toEqual(["import"]);
    expect((await fixture.store.listOutbox()).map((item) => item.event.kind)).toEqual([
      "snapshot_published",
    ]);
  });

  test("replays exact imports and isolates their idempotency namespace from create", async () => {
    const fixture = await artifactFixture({ seed: false });
    const request = importRequest({ idempotencyKey: "shared-origin-key" });
    const imported = await fixture.service.importArtifact({ scope, actor: humanActor, request });
    const replay = await fixture.service.importArtifact({ scope, actor: humanActor, request });
    const created = await fixture.service.createArtifact({
      scope,
      actor: humanActor,
      request: createRequest("shared-origin-key"),
    });

    expect(replay.replayed).toBe(true);
    expect(replay.artifact.id).toBe(imported.artifact.id);
    expect(created.artifact.id).not.toBe(imported.artifact.id);
    await expect(
      fixture.service.importArtifact({
        scope,
        actor: humanActor,
        request: importRequest({ idempotencyKey: "shared-origin-key", title: "Changed" }),
      }),
    ).rejects.toBeInstanceOf(EditableArtifactIdempotencyConflictError);
    expect(fixture.snapshotVerifier.calls).toHaveLength(2);
  });

  test("hashes import semantics but not idempotency or infrastructure object references", () => {
    const first = importRequest({ idempotencyKey: "first", blobReference: "objects/a" });
    const retry = importRequest({ idempotencyKey: "second", blobReference: "objects/b" });
    const changed = importRequest({ sourceContentHash: hash(804) });
    expect(hashEditableArtifactImportRequest(first)).toBe(hashEditableArtifactImportRequest(retry));
    expect(hashEditableArtifactImportRequest(changed)).not.toBe(
      hashEditableArtifactImportRequest(first),
    );
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for genesis");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
