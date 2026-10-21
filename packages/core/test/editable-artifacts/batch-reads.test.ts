import { expect, test } from "bun:test";
import type { EditableArtifactStorePort } from "../../src/domain/editable-artifacts/ports";
import { editableArtifactId } from "../../src/domain/editable-artifacts/types";
import { artifactFixture, artifactId, humanActor, scope } from "./fixtures";

const missingId = editableArtifactId("ffffffffffffffffffffffffffffffff");

test("batch reads preserve order, denial, missing results, and do not read denied metadata", async () => {
  const { service, store, authorization } = await artifactFixture();
  const requests: string[][] = [];
  const original = store.readArtifactAtAuthorizationRevision.bind(store);
  (store as EditableArtifactStorePort).readArtifactsAtAuthorizationRevisions = async (
    batchScope,
    batch,
  ) => {
    requests.push(batch.map((item) => item.artifactId));
    return Promise.allSettled(
      batch.map((item) =>
        original(batchScope, item.artifactId, item.expectedAuthorizationRevision),
      ),
    );
  };
  const deniedId = editableArtifactId("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  authorization.authorize = async (input) => ({
    allowed: input.artifactId !== deniedId,
    revision: 1,
  });
  const result = await service.getArtifacts({
    scope,
    actor: humanActor,
    artifactIds: [missingId, deniedId, artifactId],
  });
  expect(result[0]).toMatchObject({ status: "rejected", reason: { code: "not_found" } });
  expect(result[1]).toMatchObject({ status: "rejected", reason: { code: "forbidden" } });
  expect(result[2]).toMatchObject({ status: "fulfilled", value: { id: artifactId } });
  expect(requests).toEqual([[missingId, artifactId]]);
});

test("revocation between authorization and a batch read is reauthorized and denied", async () => {
  const { service, store, authorization } = await artifactFixture();
  (store as EditableArtifactStorePort).readArtifactsAtAuthorizationRevisions = async (
    batchScope,
    batch,
  ) => {
    await store.advanceAuthorizationRevision(batchScope, artifactId, 1, 2);
    authorization.setRevision(2);
    authorization.deny("read");
    return Promise.allSettled(
      batch.map((item) =>
        store.readArtifactAtAuthorizationRevision(
          batchScope,
          item.artifactId,
          item.expectedAuthorizationRevision,
        ),
      ),
    );
  };
  expect(
    await service.getArtifacts({ scope, actor: humanActor, artifactIds: [artifactId] }),
  ).toMatchObject([{ status: "rejected", reason: { code: "forbidden" } }]);
  expect(authorization.calls.filter((call) => call.permission === "read")).toHaveLength(2);
});

test("stale batch reads retain the scalar retry budget and do not retry successful peers", async () => {
  const { service, store, authorization } = await artifactFixture();
  let scalarReads = 0;
  (store as EditableArtifactStorePort).readArtifactsAtAuthorizationRevisions = async () => [
    { status: "fulfilled", value: { kind: "authorization_stale" } },
    {
      status: "fulfilled",
      value: { kind: "result", artifact: await store.getArtifact(scope, artifactId) },
    },
  ];
  store.readArtifactAtAuthorizationRevision = async () => {
    scalarReads++;
    return { kind: "authorization_stale" };
  };
  const result = await service.getArtifacts({
    scope,
    actor: humanActor,
    artifactIds: [artifactId, artifactId],
  });
  expect(result[0]).toMatchObject({ status: "rejected", reason: { code: "retryable_conflict" } });
  expect(result[1]).toMatchObject({ status: "fulfilled", value: { id: artifactId } });
  expect(scalarReads).toBe(3);
  expect(authorization.calls.filter((call) => call.permission === "read")).toHaveLength(6);
});

test("custom stores retain scalar reads, empty batches do no work, and fanout is bounded", async () => {
  const { service, authorization } = await artifactFixture();
  expect(await service.getArtifacts({ scope, actor: humanActor, artifactIds: [] })).toEqual([]);
  expect(authorization.calls).toHaveLength(0);
  expect(
    await service.getArtifacts({ scope, actor: humanActor, artifactIds: [artifactId, missingId] }),
  ).toMatchObject([
    { status: "fulfilled", value: { id: artifactId } },
    { status: "rejected", reason: { code: "not_found" } },
  ]);
  await expect(
    service.getArtifacts({ scope, actor: humanActor, artifactIds: Array(9).fill(artifactId) }),
  ).rejects.toThrow("batch is too large");
  expect(authorization.calls).toHaveLength(2);
});
