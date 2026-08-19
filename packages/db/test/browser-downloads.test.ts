import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateBrowserSession,
  bootstrapWorkspace,
  completeBrowserDownloadSave,
  createDb,
  createSession,
  dispatchBrowserDownloadSave,
  dispatchBrowserSessionOperation,
  findBrowserDownloadSave,
  InteractionResourceConflictError,
  InteractionResourceStateError,
  prepareBrowserDownloadSave,
  prepareBrowserSessionCreate,
  settleBrowserDownloadSaveFailure,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("browser-downloads");
  if (!shared) {
    available = false;
    console.warn("[browser-downloads] postgres unavailable, skipping");
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
    accountExternalId: `browser-download-account-${suffix}`,
    accountName: "Browser download test",
    workspaceExternalSource: "test",
    workspaceExternalId: `browser-download-workspace-${suffix}`,
    workspaceName: "Browser download test",
    subjectId: `user:browser-download-${suffix}`,
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
  const createOperationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    operationId: createOperationId,
    associatedSessionId: session.id,
    actorSubjectId: grant.subjectId,
    name: "Download browser",
    initialUrl: "https://example.com/report",
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
    operationId: createOperationId,
    browserSessionId: prepared.session.id,
    controllerGeneration,
  });
  await activateBrowserSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    operationId: createOperationId,
    browserSessionId: prepared.session.id,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.0",
  });
  const downloadId = crypto.randomUUID();
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    actorSubjectId: grant.subjectId,
    sourceSessionId: session.id,
    browserSessionId: prepared.session.id,
    controllerGeneration,
    downloadId,
    download: {
      id: downloadId,
      browserSessionId: prepared.session.id,
      controllerGeneration,
      targetId: "target-1",
      filename: "report.pdf",
      status: "completed" as const,
      receivedBytes: 42,
      totalBytes: 42,
      sha256: "a".repeat(64),
      version: 2,
      startedAt: "2026-08-10T10:00:00.000Z",
      settledAt: "2026-08-10T10:00:01.000Z",
      failureCode: null,
    },
  };
}

function preparation(
  scope: Awaited<ReturnType<typeof fixture>>,
  operationId = crypto.randomUUID(),
) {
  const fileId = crypto.randomUUID();
  const safeFilename = "report.pdf";
  return {
    ...scope,
    request: {
      operationId,
      destinationPath: "downloads/report.pdf",
      overwrite: false,
    },
    fileId,
    safeFilename,
    contentType: "application/octet-stream",
    bucket: "test-files",
    objectKey: `workspaces/${scope.workspaceId}/files/${fileId}/original/${safeFilename}`,
    uploadExpiresAt: new Date(Date.now() + 60_000),
  };
}

describe("browser download saves", () => {
  test("fences prepare, dispatch, completion, and exact replay", async () => {
    if (!available) return;
    const scope = await fixture();
    const input = preparation(scope);
    const created = await prepareBrowserDownloadSave(client.db, input);
    expect(created).toMatchObject({
      operationId: input.request.operationId,
      state: "prepared",
      replayed: false,
      dispatchedNow: false,
      fileId: input.fileId,
      uploadId: expect.any(String),
    });
    expect(await findBrowserDownloadSave(client.db, input)).toMatchObject({
      state: "prepared",
      replayed: true,
      fileId: input.fileId,
    });

    const replay = await prepareBrowserDownloadSave(client.db, {
      ...input,
      uploadExpiresAt: new Date(Date.now() + 120_000),
    });
    expect(replay).toMatchObject({
      state: "prepared",
      replayed: true,
      dispatchedNow: false,
      fileId: input.fileId,
      uploadId: created.uploadId,
    });

    const firstDispatch = await dispatchBrowserDownloadSave(client.db, input);
    expect(firstDispatch).toMatchObject({ state: "dispatched", dispatchedNow: true });
    expect(await dispatchBrowserDownloadSave(client.db, input)).toMatchObject({
      state: "dispatched",
      dispatchedNow: false,
    });
    const completed = await completeBrowserDownloadSave(client.db, input);
    expect(completed).toMatchObject({
      operationId: input.request.operationId,
      destinationPath: input.request.destinationPath,
      fileId: input.fileId,
      replayed: false,
    });
    expect(await completeBrowserDownloadSave(client.db, input)).toMatchObject({ replayed: true });

    const [row] = await shared!.admin<
      Array<{ metadata: unknown; result: unknown; state: string }>
    >`select metadata, result, state from interaction_resource_operations where operation_id = ${input.request.operationId}`;
    expect(row?.state).toBe("completed");
    expect(JSON.stringify(row)).not.toContain("http");
    expect(JSON.stringify(row)).not.toContain("token");
  });

  test("rejects completion before dispatch and preserves terminal failure", async () => {
    if (!available) return;
    const scope = await fixture();
    const input = preparation(scope);
    await prepareBrowserDownloadSave(client.db, input);
    await expect(completeBrowserDownloadSave(client.db, input)).rejects.toBeInstanceOf(
      InteractionResourceStateError,
    );
    await settleBrowserDownloadSaveFailure(client.db, {
      ...input,
      state: "failed",
      errorCode: "destination_conflict",
    });
    expect(await findBrowserDownloadSave(client.db, input)).toMatchObject({
      state: "failed",
      errorCode: "destination_conflict",
      response: null,
    });
    await expect(dispatchBrowserDownloadSave(client.db, input)).resolves.toMatchObject({
      state: "failed",
      dispatchedNow: false,
    });
    await expect(completeBrowserDownloadSave(client.db, input)).rejects.toBeInstanceOf(
      InteractionResourceStateError,
    );
  });

  test("binds an operation id to the exact path and actor", async () => {
    if (!available) return;
    const scope = await fixture();
    const input = preparation(scope);
    await prepareBrowserDownloadSave(client.db, input);
    await expect(
      findBrowserDownloadSave(client.db, {
        ...input,
        request: { ...input.request, destinationPath: "other/report.pdf" },
      }),
    ).rejects.toBeInstanceOf(InteractionResourceConflictError);
    await expect(
      findBrowserDownloadSave(client.db, {
        ...input,
        actorSubjectId: `${input.actorSubjectId}:other`,
      }),
    ).rejects.toBeInstanceOf(InteractionResourceConflictError);
  });
});
