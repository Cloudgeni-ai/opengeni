import { describe, expect, test } from "bun:test";

import { OpenGeniClient } from "../src";
import {
  createBrowserEditableArtifactSession,
  createEditableArtifactReplicaId,
} from "../src/editable-artifacts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "11111111111111111111111111111111";
const REPLICA_ID = "2222222222222222";

const artifact = {
  id: ARTIFACT_ID,
  modality: "spreadsheet" as const,
  title: "Forecast",
  lifecycle: "active" as const,
  headSequence: 0,
  stateHash: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-08-08T10:00:00.000Z",
  updatedAt: "2026-08-08T10:00:00.000Z",
};

describe("editable artifact public SDK", () => {
  test("creates and reads durable metadata through encoded workspace routes", async () => {
    const requests: Request[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        signals.push(init?.signal);
        return Response.json(artifact, { status: requests.length === 1 ? 201 : 200 });
      }) as typeof fetch,
    });
    const abort = new AbortController();

    expect(
      await client.createEditableArtifact(
        WORKSPACE_ID,
        {
          idempotencyKey: "create-forecast-1",
          replicaId: REPLICA_ID,
          modality: "spreadsheet",
          title: "Forecast",
        },
        { signal: abort.signal },
      ),
    ).toEqual(artifact);
    expect(
      await client.getEditableArtifact(WORKSPACE_ID, ARTIFACT_ID, {
        replicaId: REPLICA_ID,
        signal: abort.signal,
      }),
    ).toEqual(artifact);

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts`],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}?replicaId=${REPLICA_ID}`,
      ],
    ]);
    expect(await requests[0]!.json()).toEqual({
      idempotencyKey: "create-forecast-1",
      replicaId: REPLICA_ID,
      modality: "spreadsheet",
      title: "Forecast",
    });
    expect(signals).toEqual([abort.signal, abort.signal]);
  });

  test("generates canonical nonzero replica identities", () => {
    const values = new Set(Array.from({ length: 64 }, () => createEditableArtifactReplicaId()));
    expect(values.size).toBe(64);
    for (const value of values) expect(value).toMatch(/^(?!0{16}$)[0-9a-f]{16}$/u);
  });

  test("pins, enqueues, polls, and downloads an exact durable version", async () => {
    const requests: Request[] = [];
    const version = {
      id: "33333333333333333333333333333333",
      artifactId: ARTIFACT_ID,
      modality: "spreadsheet" as const,
      snapshotId: "44444444444444444444444444444444",
      headSequence: 7,
      causalFrontier: [{ replicaId: REPLICA_ID, counter: 7 }],
      nativeRevision: null,
      stateHash: `sha256:${"b".repeat(64)}`,
      name: "Forecast v1",
      pinned: true as const,
      createdAt: "2026-08-08T12:00:00.000Z",
      replayed: false,
    };
    const job = {
      id: "55555555555555555555555555555555",
      artifactId: ARTIFACT_ID,
      versionId: version.id,
      inputSnapshotId: version.snapshotId,
      targetHeadSequence: version.headSequence,
      stateHash: version.stateHash,
      format: "xlsx" as const,
      state: "pending" as const,
      attemptCount: 0,
      errorCode: null,
      createdAt: version.createdAt,
      startedAt: null,
      completedAt: null,
      result: null,
      replayed: false,
    };
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/download?replicaId=2222222222222222")) {
          return new Response(Uint8Array.of(1, 2, 3), {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return Response.json(requests.length === 1 ? version : job, {
          status: requests.length <= 2 ? 201 : 200,
        });
      }) as typeof fetch,
    });

    await expect(
      client.pinEditableArtifactVersion(WORKSPACE_ID, ARTIFACT_ID, {
        replicaId: REPLICA_ID,
        idempotencyKey: "pin-forecast-1",
        name: "Forecast v1",
      }),
    ).resolves.toEqual(version);
    await expect(
      client.createEditableArtifactMaterialization(WORKSPACE_ID, ARTIFACT_ID, {
        replicaId: REPLICA_ID,
        idempotencyKey: "xlsx-forecast-1",
        versionId: version.id,
        format: "xlsx",
      }),
    ).resolves.toEqual(job);
    await expect(
      client.getEditableArtifactMaterialization(WORKSPACE_ID, ARTIFACT_ID, job.id, {
        replicaId: REPLICA_ID,
      }),
    ).resolves.toEqual(job);
    const response = await client.downloadEditableArtifactMaterialization(
      WORKSPACE_ID,
      ARTIFACT_ID,
      job.id,
      { replicaId: REPLICA_ID },
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}/versions`,
      ],
      [
        "POST",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}/materializations`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}/materializations/${job.id}?replicaId=${REPLICA_ID}`,
      ],
      [
        "GET",
        `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}/materializations/${job.id}/download?replicaId=${REPLICA_ID}`,
      ],
    ]);
    expect(await requests[0]!.json()).toEqual({
      replicaId: REPLICA_ID,
      idempotencyKey: "pin-forecast-1",
      name: "Forecast v1",
    });
  });

  test("rejects cache authority drift before allocating a Worker", () => {
    expect(() =>
      createBrowserEditableArtifactSession({
        baseUrl: "https://api.example.test",
        workspaceId: WORKSPACE_ID,
        artifact: { id: ARTIFACT_ID, modality: "spreadsheet" },
        storageAuthority: {
          deploymentOrigin: "https://different.example.test",
          accountId: "account-1",
          workspaceId: WORKSPACE_ID,
          principalId: "principal-1",
          authorizationEpoch: "epoch-1",
        },
        runtime: {
          kernelVersion: "kernel-1",
          modelSchemaVersion: 1,
          commandVersion: 1,
          workerUrl: "https://api.example.test/artifact-worker.js",
          wasmGlueUrl: "https://api.example.test/artifact-kernel.js",
          wasmBinaryUrl: "https://api.example.test/artifact-kernel.wasm",
        },
      }),
    ).toThrow("storageAuthority deployment origin does not match baseUrl");
  });
});
