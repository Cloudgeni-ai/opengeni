import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type {
  EditableArtifactDurableExportService,
  EditableArtifactMaterializationDownload,
} from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";

import { registerEditableArtifactRoutes } from "../src/routes/editable-artifacts";

const SECRET = "editable-artifact-export-route-test-secret";
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000002";
const ARTIFACT_ID = "1".repeat(32);
const REPLICA_ID = "2".repeat(16);
const VERSION_ID = "3".repeat(32);
const SNAPSHOT_ID = "4".repeat(32);
const JOB_ID = "5".repeat(32);
const RESULT_ID = "6".repeat(32);
const NOW = "2026-08-08T12:00:00.000Z";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("editable artifact durable export routes", () => {
  test("pins, enqueues, polls, and streams a bounded authorized result", async () => {
    const calls: string[] = [];
    const scope = { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID };
    const version = {
      scope,
      artifactId: ARTIFACT_ID,
      id: VERSION_ID,
      modality: "spreadsheet" as const,
      snapshotId: SNAPSHOT_ID,
      headSequence: 7,
      causalFrontier: [{ replicaId: REPLICA_ID, counter: 7 }],
      nativeRevision: null,
      stateHash: `sha256:${"a".repeat(64)}`,
      name: "Forecast v1",
      pinned: true as const,
      createdBySubjectId: "user:artifact-export-test",
      createdAt: NOW,
    };
    const result = {
      id: RESULT_ID,
      byteSize: 3,
      contentHash: `sha256:${"b".repeat(64)}`,
      mimeType: XLSX_MIME as typeof XLSX_MIME,
      verifiedAt: NOW,
      createdAt: NOW,
    };
    const job = {
      scope,
      artifactId: ARTIFACT_ID,
      id: JOB_ID,
      versionId: VERSION_ID,
      inputSnapshotId: SNAPSHOT_ID,
      targetHeadSequence: 7,
      stateHash: version.stateHash,
      format: "xlsx" as const,
      state: "succeeded" as const,
      attemptCount: 1,
      errorCode: null,
      createdAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      result,
    };
    let downloadClosed = 0;
    const exports = {
      async pinVersion(input: { artifactId: string }) {
        calls.push(`pin:${input.artifactId}`);
        return { version, replayed: false };
      },
      async enqueueMaterialization(input: { versionId: string }) {
        calls.push(`enqueue:${input.versionId}`);
        return { job, replayed: false };
      },
      async getMaterialization(input: { jobId: string }) {
        calls.push(`get:${input.jobId}`);
        return job;
      },
      async openMaterializationDownload(input: { jobId: string }) {
        calls.push(`download:${input.jobId}`);
        return {
          artifactId: ARTIFACT_ID,
          jobId: JOB_ID,
          format: "xlsx",
          byteSize: 3,
          contentHash: result.contentHash,
          mimeType: XLSX_MIME,
          async *chunks() {
            yield Uint8Array.of(1, 2, 3);
          },
          async assertUnchanged() {},
          async close() {
            downloadClosed += 1;
          },
        } satisfies EditableArtifactMaterializationDownload;
      },
    } as unknown as EditableArtifactDurableExportService;
    const app = new Hono();
    registerEditableArtifactRoutes(app, {
      settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
      db: {} as never,
      managedAuth: null,
      editableArtifactExports: exports,
    });
    const authorization = await bearer();
    const base = `http://api.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/${ARTIFACT_ID}`;

    const pinned = await app.request(`${base}/versions`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        replicaId: REPLICA_ID,
        idempotencyKey: "pin-forecast-1",
        name: "Forecast v1",
      }),
    });
    expect(pinned.status).toBe(201);
    expect(await pinned.json()).toMatchObject({ id: VERSION_ID, replayed: false });

    const enqueued = await app.request(`${base}/materializations`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        replicaId: REPLICA_ID,
        idempotencyKey: "xlsx-forecast-1",
        versionId: VERSION_ID,
        format: "xlsx",
      }),
    });
    expect(enqueued.status).toBe(201);
    expect(await enqueued.json()).toMatchObject({ id: JOB_ID, replayed: false });

    const polled = await app.request(`${base}/materializations/${JOB_ID}?replicaId=${REPLICA_ID}`, {
      headers: { authorization },
    });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({ id: JOB_ID, state: "succeeded" });

    const downloaded = await app.request(
      `${base}/materializations/${JOB_ID}/download?replicaId=${REPLICA_ID}`,
      { headers: { authorization } },
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toBe(
      `attachment; filename="artifact-${ARTIFACT_ID}.xlsx"`,
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
    expect(downloadClosed).toBe(1);
    expect(calls).toEqual([
      `pin:${ARTIFACT_ID}`,
      `enqueue:${VERSION_ID}`,
      `get:${JOB_ID}`,
      `download:${JOB_ID}`,
    ]);
  });

  test("authenticates before parsing export request bodies", async () => {
    const app = new Hono();
    registerEditableArtifactRoutes(app, {
      settings: testSettings({ productAccessMode: "managed", delegationSecret: SECRET }),
      db: {} as never,
      managedAuth: null,
      editableArtifactExports: {} as EditableArtifactDurableExportService,
    });
    const response = await app.request(
      `http://api.test/v1/workspaces/${WORKSPACE_ID}/editable-artifacts/not-valid/versions`,
      { method: "POST", body: "not-json" },
    );
    expect(response.status).toBe(401);
  });
});

async function bearer(): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: "user:artifact-export-test",
    permissions: ["artifacts:read"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}
