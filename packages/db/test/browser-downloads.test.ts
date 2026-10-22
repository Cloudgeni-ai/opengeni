import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  activateBrowserSession,
  bootstrapWorkspace,
  completeBrowserDownloadSave,
  completeFileUpload,
  createDb,
  createFileUpload,
  createSession,
  dispatchBrowserDownloadSave,
  dispatchBrowserSessionOperation,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  findBrowserDownloadSave,
  getRetainedBrowserDownload,
  InteractionResourceConflictError,
  InteractionResourceStateError,
  listRetainedBrowserDownloads,
  prepareBrowserDownloadSave,
  prepareBrowserSessionCreate,
  recordRetainedBrowserDownload,
  settleBrowserDownloadSaveFailure,
  getBrowserDownloadPrivateOwner,
  BrowserDownloadOwnerUnavailableError,
  withSessionRlsActorContext,
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

/** A person's workspace with private chats enabled, as a signed-in human gets. */
async function privateChatWorkspace() {
  const userId = `browser-download-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Browser download owner",
  });
  const grant = context.workspaceGrants.find(
    (candidate) => candidate.workspaceId !== context.defaultWorkspaceId,
  );
  if (!grant?.workspaceId) throw new Error("managed human has no personal workspace");
  const settings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: subjectId,
  });
  if (!settings.enabled) {
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
  }
  return { ...grant, subjectId };
}

async function fixture(visibility: "user_private" | "workspace_shared" = "workspace_shared") {
  const suffix = crypto.randomUUID();
  const grant =
    visibility === "user_private"
      ? await privateChatWorkspace()
      : (
          await bootstrapWorkspace(client.db, {
            accountExternalSource: "test",
            accountExternalId: `browser-download-account-${suffix}`,
            accountName: "Browser download test",
            workspaceExternalSource: "test",
            workspaceExternalId: `browser-download-workspace-${suffix}`,
            workspaceName: "Browser download test",
            subjectId: `user:browser-download-${suffix}`,
          })
        ).workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    ...(visibility === "user_private"
      ? { createdBy: { kind: "subject" as const, subjectId: grant.subjectId } }
      : {}),
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  if (visibility === "user_private") {
    // The person makes the chat "Only me".
    await transitionSessionVisibility(client.db, {
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actorSubjectId: grant.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `visibility-${crypto.randomUUID()}`,
    });
  }
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
    const [provenance] = await shared!.admin`
      select source_session_id as source, source_session_shared_unrestricted as shared
      from files where id = ${input.fileId}`;
    expect(provenance).toMatchObject({ source: scope.sourceSessionId, shared: true });
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

describe("retained browser downloads", () => {
  async function retainedFile(
    scope: Awaited<ReturnType<typeof fixture>>,
    ready: boolean,
    privateOwnerSubjectId: string | null = null,
  ) {
    const fileId = crypto.randomUUID();
    const created = await createFileUpload(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      fileId,
      privateOwnerSubjectId,
      filename: "report.pdf",
      safeFilename: "report.pdf",
      contentType: "application/octet-stream",
      sizeBytes: scope.download.receivedBytes,
      sha256: scope.download.sha256,
      bucket: "test-files",
      objectKey: `workspaces/${scope.workspaceId}/files/${fileId}/original/report.pdf`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (ready) await completeFileUpload(client.db, scope.workspaceId, created.uploadId);
    return { fileId, uploadId: created.uploadId };
  }

  test("resolves a private chat's owner for kept downloads, whoever saves the browser", async () => {
    if (!available) return;
    const scope = await fixture("user_private");
    const other = `user:browser-download-other-${crypto.randomUUID()}`;
    // The request saving the browser may be someone else's, who cannot see
    // the private chat; ownership is still resolved from the browser's chat.
    for (const actor of [
      { subjectId: other, privateFileOwnerSubjectId: other },
      { subjectId: scope.actorSubjectId },
    ]) {
      expect(
        await withSessionRlsActorContext(actor, () =>
          getBrowserDownloadPrivateOwner(client.db, scope),
        ),
      ).toBe(scope.actorSubjectId);
    }
    const sharedChat = await fixture();
    expect(await getBrowserDownloadPrivateOwner(client.db, sharedChat)).toBeNull();
    // Only the chat that created the browser decides.
    await expect(
      getBrowserDownloadPrivateOwner(client.db, {
        ...scope,
        sourceSessionId: sharedChat.sourceSessionId,
      }),
    ).rejects.toBeInstanceOf(BrowserDownloadOwnerUnavailableError);
  });

  test("keeps a private chat's download visible only to that chat's owner", async () => {
    if (!available) return;
    const scope = await fixture();
    const owner = scope.actorSubjectId;
    const asOwner = { subjectId: owner, privateFileOwnerSubjectId: owner };
    const kept = await withSessionRlsActorContext(asOwner, async () => {
      const file = await retainedFile(scope, true, owner);
      return await recordRetainedBrowserDownload(client.db, { ...scope, ...file });
    });
    expect(
      await withSessionRlsActorContext(asOwner, () =>
        listRetainedBrowserDownloads(client.db, scope),
      ),
    ).toMatchObject([{ fileId: kept.fileId }]);
    // Another member of the workspace, or a request with no private owner,
    // never sees the owner's private download.
    const other = `user:browser-download-other-${crypto.randomUUID()}`;
    for (const actor of [
      { subjectId: other, privateFileOwnerSubjectId: other },
      { subjectId: other, privateFileOwnerSubjectId: null },
    ]) {
      expect(
        await withSessionRlsActorContext(actor, () => getRetainedBrowserDownload(client.db, scope)),
      ).toBeNull();
    }
  });

  test("keeps a completed download saveable after its controller generation is gone", async () => {
    if (!available) return;
    const scope = await fixture();
    // The download came from an earlier controller generation, as after a
    // suspension and resume: the live-controller save path refuses it.
    const download = { ...scope.download, controllerGeneration: crypto.randomUUID() };
    const live = preparation({ ...scope, download });
    await expect(prepareBrowserDownloadSave(client.db, live)).rejects.toBeInstanceOf(
      InteractionResourceStateError,
    );

    const file = await retainedFile(scope, true);
    const kept = await recordRetainedBrowserDownload(client.db, { ...scope, download, ...file });
    expect(kept).toMatchObject({
      fileId: file.fileId,
      uploadId: file.uploadId,
      safeFilename: "report.pdf",
      download: { id: scope.downloadId, controllerGeneration: download.controllerGeneration },
    });
    // The first retained file wins; a second retention of the same download is ignored.
    const other = await retainedFile(scope, true);
    expect(
      await recordRetainedBrowserDownload(client.db, { ...scope, download, ...other }),
    ).toMatchObject({ fileId: file.fileId });
    expect(await listRetainedBrowserDownloads(client.db, scope)).toHaveLength(1);
    expect(await getRetainedBrowserDownload(client.db, scope)).toMatchObject({
      fileId: file.fileId,
    });

    const saved = await prepareBrowserDownloadSave(client.db, {
      ...live,
      fileId: kept.fileId,
      objectKey: kept.objectKey,
      retained: file,
    });
    expect(saved).toMatchObject({
      state: "prepared",
      fileId: file.fileId,
      uploadId: file.uploadId,
    });
    await expect(
      prepareBrowserDownloadSave(client.db, {
        ...preparation({ ...scope, download }),
        fileId: other.fileId,
        objectKey: `workspaces/${scope.workspaceId}/files/${other.fileId}/original/report.pdf`,
        retained: other,
      }),
    ).rejects.toBeInstanceOf(InteractionResourceStateError);
  });

  test("lists only downloads whose retained file is ready, and only completed ones", async () => {
    if (!available) return;
    const scope = await fixture();
    const pending = await retainedFile(scope, false);
    // A file still being uploaded is never presented as retained.
    await expect(
      recordRetainedBrowserDownload(client.db, { ...scope, ...pending }),
    ).rejects.toThrow();
    expect(await listRetainedBrowserDownloads(client.db, scope)).toEqual([]);
    expect(await getRetainedBrowserDownload(client.db, scope)).toBeNull();
    await expect(
      recordRetainedBrowserDownload(client.db, {
        ...scope,
        download: { ...scope.download, status: "failed" },
        ...(await retainedFile(scope, true)),
      }),
    ).rejects.toThrow();
  });
});
