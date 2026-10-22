import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import {
  fileSourceVisibleToHost,
  fileMayBeCopiedToWorkspace,
  validateFileResources,
  sourceSessionRequiresHumanShare,
  type ObjectStorageDependency,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  type AccessGrant,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";
import {
  bindSlackInteractionSession,
  claimSessionWorkForAttempt,
  createDb,
  createFileUpload,
  createOrganizationApiKey,
  createSession,
  createWorkspace,
  ensureExternalIdentity,
  getFilesForSubject,
  getOrCreateSlackInteraction,
  initializeSessionStartAtomically,
  transitionSessionVisibility,
  updateFileVisibility,
  withSessionRlsActorContext,
  withRlsContext,
  setSubjectRlsContext,
  type DbClient,
} from "@opengeni/db";
import { addDocumentToBase, getDocument } from "@opengeni/documents";
import { rawRows } from "../../../packages/db/src/database";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp, type AppDependencies } from "../src/app";

// A file has the same two audiences as a Site: Only me or the workspace.
// These run the real file routes against PostgreSQL as the restricted
// application role, so row-level security decides what each person sees.
let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("file-visibility");
  if (!acquired) throw new Error("File visibility tests require real PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
});

const noop = async () => undefined;
const memberPermissions = [
  "workspace:read",
  "files:read",
  "files:upload",
  "documents:search",
  "documents:manage",
] as const;

async function fixture(
  testShared: SharedTestDatabase = shared,
  testDb: DbClient = db,
  hostDeniesSource = false,
) {
  const [account] =
    await testShared.admin`insert into managed_accounts (name) values ('File visibility fixture') returning id`;
  const accountId = String(account!.id);
  const workspace = await createWorkspace(testDb.db, { accountId, name: "Team workspace" });
  const token = crypto.randomUUID();
  await createOrganizationApiKey(testDb.db, {
    accountId,
    name: "Service fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [
      "workspace:read",
      "workspace:admin",
      "members:manage",
      "files:read",
      "files:upload",
      "documents:search",
      "documents:manage",
      "account:admin",
    ],
  });
  const appDeps = {
    db: testDb.db,
    bus: new MemoryEventBus(),
    settings: testSettings({ productAccessMode: "configured", sandboxBackend: "none" }),
    objectStorage: {
      bucket: "fixture",
      maxSinglePutSizeBytes: 5_000_000_000,
      createPutUrl: async (input: { key: string }) => ({
        url: `https://storage.example.test/${input.key}`,
        expiresAt: new Date(Date.now() + 60_000),
        requiredHeaders: {},
      }),
      createGetUrl: async (input: { key: string }) => ({
        url: `https://storage.example.test/${input.key}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    } as unknown as ObjectStorageDependency,
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
    } as unknown as SessionWorkflowClient,
    managedAuth: null,
  } as unknown as AppDependencies;
  const app = createApp({
    ...appDeps,
    ...(hostDeniesSource
      ? {
          sessionAuthorization: {
            authorizeSession: async () => ({ allowed: false, reason: "revoked" }),
            resolveListScope: async () => ({ kind: "all" }),
          },
        }
      : {}),
  } as AppDependencies);
  const appWithoutHost = hostDeniesSource ? createApp(appDeps) : app;
  const source = "example:instance";
  const service = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const person = async () => {
    const identity = await ensureExternalIdentity(testDb.db, {
      accountId,
      source,
      externalId: crypto.randomUUID(),
    });
    const added = await app.request(`/v1/workspaces/${workspace.id}/external-members`, {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        identity: { source, externalId: identity.externalId },
        permissions: memberPermissions,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(added.status).toBe(200);
    return {
      subjectId: identity.subjectId,
      headers: {
        ...service,
        "x-opengeni-external-actor": encodeURIComponent(
          JSON.stringify({
            mode: "external",
            identity: { source, externalId: identity.externalId },
          }),
        ),
      },
    };
  };
  const owner = await person();
  const other = await person();
  await testShared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'file-visibility-test')`;
  await testShared.admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const callWith = (
    target: typeof app,
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) =>
    target.request(`/v1/workspaces/${workspace.id}${path}`, {
      method,
      headers: who.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const call = (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) => callWith(app, who, method, path, body);
  const callWithoutHost = (
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: unknown,
  ) => callWith(appWithoutHost, who, method, path, body);
  const readyFile = async (privateTo: string | null, ownerId = privateTo) => {
    const id = crypto.randomUUID();
    await testShared.admin`insert into files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,sha256,bucket,object_key,private_owner_subject_ids,owner_subject_id)
      values(${id},${accountId},${workspace.id},'ready','chart.png','chart.png','image/png',4,${"a".repeat(64)},'fixture',
        ${`workspaces/${workspace.id}/files/${id}/chart.png`},${privateTo ? [privateTo] : null},${ownerId})`;
    return id;
  };
  return { workspace, owner, other, call, callWithoutHost, readyFile };
}

test("someone else's Only me file says it is private, until its owner shares it", async () => {
  const f = await fixture();
  const fileId = await f.readyFile(f.owner.subjectId);
  const missing = crypto.randomUUID();

  // Another member learns only that it is private; a missing file stays 404.
  for (const suffix of ["", "/content"]) {
    const denied = await f.call(f.other, "GET", `/artifacts/${fileId}${suffix}`);
    expect({ suffix, status: denied.status }).toEqual({ suffix, status: 403 });
    const body = (await denied.json()) as Record<string, unknown>;
    expect(body).toEqual({ artifactId: fileId, available: false, reason: "private" });
    expect(JSON.stringify(body)).not.toContain("chart.png");
    expect(JSON.stringify(body)).not.toContain(f.owner.subjectId);
    const absent = await f.call(f.other, "GET", `/artifacts/${missing}${suffix}`);
    expect({ suffix, status: absent.status }).toEqual({ suffix, status: 404 });
  }
  expect((await f.call(f.owner, "GET", `/artifacts/${fileId}`)).status).toBe(200);

  // Nobody else can share it, or even tell it apart from a missing file.
  const notFound = await f.call(f.other, "PUT", `/files/${fileId}/visibility`, {
    visibility: "workspace",
  });
  expect(notFound.status).toBe(404);
  expect(
    (await f.call(f.other, "PUT", `/files/${missing}/visibility`, { visibility: "workspace" }))
      .status,
  ).toBe(404);
  expect(
    (await f.call(f.owner, "PUT", `/files/not-a-uuid/visibility`, { visibility: "workspace" }))
      .status,
  ).toBe(404);

  // Its owner shares it, and is told who can open it now.
  const sharedResponse = await f.call(f.owner, "PUT", `/files/${fileId}/visibility`, {
    visibility: "workspace",
  });
  expect(sharedResponse.status, await sharedResponse.clone().text()).toBe(200);
  const sharedFile = ((await sharedResponse.json()) as { file: Record<string, unknown> }).file;
  expect(sharedFile).toMatchObject({
    id: fileId,
    scope: "workspace",
    ownerSubjectId: f.owner.subjectId,
    access: {
      visibility: "workspace",
      whoCanOpen: "Everyone in the workspace “Team workspace” can open this file.",
    },
  });
  expect((await f.call(f.other, "GET", `/artifacts/${fileId}`)).status).toBe(200);

  // Only its owner limits it again.
  const notOwner = await f.call(f.other, "PUT", `/files/${fileId}/visibility`, {
    visibility: "private",
  });
  expect(notOwner.status).toBe(403);
  const limited = await f.call(f.owner, "PUT", `/files/${fileId}/visibility`, {
    visibility: "private",
  });
  expect(limited.status, await limited.clone().text()).toBe(200);
  expect(
    ((await limited.json()) as { file: { access: { visibility: string } } }).file.access,
  ).toMatchObject({ visibility: "private" });
  expect((await f.call(f.other, "GET", `/artifacts/${fileId}`)).status).toBe(403);

  const audit =
    await shared.admin`select subject_id, metadata from audit_events where action='file.visibility.changed' and target_id=${fileId} order by occurred_at`;
  expect(audit.map((row) => row.subject_id)).toEqual([f.owner.subjectId, f.owner.subjectId]);
});

test("an upload says who will be able to open it", async () => {
  const f = await fixture();
  const upload = (scope?: "personal" | "workspace") =>
    f.call(f.owner, "POST", "/files/uploads", {
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      ...(scope ? { scope } : {}),
    });
  const team = await upload();
  expect(team.status, await team.clone().text()).toBe(201);
  expect(((await team.json()) as { access: unknown }).access).toEqual({
    visibility: "workspace",
    whoCanOpen: "Everyone in the workspace “Team workspace” can open this file.",
  });
  const mine = await upload("personal");
  expect(mine.status, await mine.clone().text()).toBe(201);
  const access = ((await mine.json()) as { access: { visibility: string; whoCanOpen: string } })
    .access;
  expect(access.visibility).toBe("private");
  // Names the owner, never "you": an agent or a shared chat may read it.
  expect(access.whoCanOpen).toStartWith("Only ");
  expect(access.whoCanOpen).not.toMatch(/\byou\b/iu);
  expect(access.whoCanOpen).toContain("is told it is private");
});

test("a session-scoped agent cannot read another shared chat's File", async () => {
  const f = await fixture();
  const makeSession = () =>
    withSessionRlsActorContext({ subjectId: f.owner.subjectId }, () =>
      createSession(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        initialMessage: "Example request",
        resources: [],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        agentAccess: "session",
        createdBy: { kind: "subject", subjectId: f.owner.subjectId },
        createdByContext: {},
      }),
    );
  const caller = await makeSession();
  const other = await makeSession();
  const fileId = await f.readyFile(null, f.owner.subjectId);
  await shared.admin`update files set source_session_id = ${other.id},
    source_session_shared_unrestricted = true where id = ${fileId}`;
  const ownFileId = await f.readyFile(null, f.owner.subjectId);
  await shared.admin`update files set source_session_id = ${caller.id},
    source_session_shared_unrestricted = true where id = ${ownFileId}`;
  await initializeSessionStartAtomically(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    sessionId: caller.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db.db, f.workspace.id, {
    sessionId: caller.id,
    workflowId: `session-${caller.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Could not claim agent attempt");
  const grant: AccessGrant = {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    subjectId: "worker:test",
    principalKind: "agent_attempt",
    permissions: ["files:read"],
    metadata: {
      sessionId: caller.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
  expect(await fileSourceVisibleToHost({ db: db.db }, grant, fileId)).toBe(false);
  expect(await fileSourceVisibleToHost({ db: db.db }, grant, ownFileId)).toBe(true);
  const scopedActor = {
    subjectId: grant.subjectId,
    initiatingHumanSubjectId: f.owner.subjectId,
    agentRootSessionId: caller.rootSessionId,
    agentCallerSessionId: caller.id,
  };
  const unrelated = await withSessionRlsActorContext(scopedActor, () =>
    getFilesForSubject(db.db, {
      accountId: f.workspace.accountId,
      workspaceId: f.workspace.id,
      subjectId: grant.subjectId,
      fileIds: [fileId],
    }),
  );
  expect(unrelated).toHaveLength(0);
  const own = await withSessionRlsActorContext(scopedActor, () =>
    getFilesForSubject(db.db, {
      accountId: f.workspace.accountId,
      workspaceId: f.workspace.id,
      subjectId: grant.subjectId,
      fileIds: [ownFileId],
    }),
  );
  expect(own).toHaveLength(1);
  const workspaceCaller = await withSessionRlsActorContext({ subjectId: f.owner.subjectId }, () =>
    createSession(db.db, {
      accountId: f.workspace.accountId,
      workspaceId: f.workspace.id,
      initialMessage: "Example request",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      agentAccess: "workspace",
      createdBy: { kind: "subject", subjectId: f.owner.subjectId },
      createdByContext: {},
    }),
  );
  const workspaceScoped = await withSessionRlsActorContext(
    {
      subjectId: grant.subjectId,
      agentRootSessionId: workspaceCaller.rootSessionId,
      agentCallerSessionId: workspaceCaller.id,
    },
    () =>
      getFilesForSubject(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        subjectId: grant.subjectId,
        fileIds: [fileId],
      }),
  );
  expect(workspaceScoped).toHaveLength(1);
  const oldReader = await withRlsContext(
    db.db,
    { accountId: f.workspace.accountId, workspaceId: f.workspace.id },
    async (tx) => {
      await setSubjectRlsContext(tx, f.owner.subjectId);
      await tx.execute(sql`select set_config('opengeni.file_provenance_reader_v1', '', true)`);
      return rawRows<{ id: string }>(tx, sql`select id from files where id = ${ownFileId}`);
    },
  );
  expect(oldReader).toHaveLength(0);
  await validateFileResources(
    db.db,
    f.workspace.accountId,
    f.workspace.id,
    grant.subjectId,
    [{ kind: "file", fileId: ownFileId, mountPath: "/workspace/input" }],
    scopedActor,
    grant,
  );
  await expect(
    validateFileResources(
      db.db,
      f.workspace.accountId,
      f.workspace.id,
      grant.subjectId,
      [{ kind: "file", fileId, mountPath: "/workspace/input" }],
      scopedActor,
      grant,
    ),
  ).rejects.toThrow("unknown file resource");
});

test("document authority reads an ordinary private original without opening a source chat", async () => {
  const f = await fixture(shared, db, true);
  const fileId = await f.readyFile(f.owner.subjectId);
  const [base] = await shared.admin<{ id: string }[]>`
    insert into document_bases(account_id, workspace_id, name)
    values (${f.workspace.accountId}, ${f.workspace.id}, 'Example base') returning id`;
  const [document] = await shared.admin<{ id: string }[]>`
    insert into documents(account_id, workspace_id, base_id, file_id, status,
      title, created_by, authority_kind, authority_workspace_id, visibility)
    values (${f.workspace.accountId}, ${f.workspace.id}, ${base!.id}, ${fileId},
      'ready', 'Example document', ${f.owner.subjectId}, 'workspace',
      ${f.workspace.id}, 'workspace') returning id`;
  const metadata = await f.call(f.other, "GET", `/documents/${document!.id}/original-file`);
  expect(metadata.status, await metadata.clone().text()).toBe(200);
  expect((await metadata.json()) as { id: string }).toMatchObject({ id: fileId });
  expect(
    (await f.callWithoutHost(f.other, "GET", `/documents/${document!.id}/original-file`)).status,
  ).toBe(200);
  const download = await f.call(
    f.other,
    "POST",
    `/documents/${document!.id}/original-file/download-url`,
  );
  expect(download.status, await download.clone().text()).toBe(200);

  const sourceFileId = await f.readyFile(null, f.owner.subjectId);
  const session = await createSession(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Example request",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.owner.subjectId },
    createdByContext: {},
  });
  await shared.admin`update files set source_session_id = ${session.id},
    source_session_shared_unrestricted = true where id = ${sourceFileId}`;
  const [sourceDocument] = await shared.admin<{ id: string }[]>`
    insert into documents(account_id, workspace_id, base_id, file_id, status,
      title, created_by, authority_kind, authority_workspace_id, visibility)
    values (${f.workspace.accountId}, ${f.workspace.id}, ${base!.id}, ${sourceFileId},
      'ready', 'Source document', ${f.owner.subjectId}, 'workspace',
      ${f.workspace.id}, 'workspace') returning id`;
  const [sourceDocumentFlag] = await shared.admin<{ inherited: boolean }[]>`
    select source_file_has_inherited_audience as inherited from documents
      where id = ${sourceDocument!.id}`;
  expect(sourceDocumentFlag?.inherited).toBe(true);
  const zeroVector = `[${Array.from({ length: 3072 }, () => "0").join(",")}]`;
  const [sourceChunk] = await shared.admin<{ id: string }[]>`
    insert into document_chunks(account_id, workspace_id, document_id, base_id,
      file_id, chunk_index, text, metadata, embedding, embedding_model)
    values (${f.workspace.accountId}, ${f.workspace.id}, ${sourceDocument!.id},
      ${base!.id}, ${sourceFileId}, 0, 'synthetic source text', '{}'::jsonb,
      ${zeroVector}::vector, 'test') returning id`;
  const copiedText = await withRlsContext(
    db.db,
    { accountId: f.workspace.accountId, workspaceId: f.workspace.id },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, f.other.subjectId);
      return {
        documents: await rawRows(
          scopedDb,
          sql`select id from documents
          where id = ${sourceDocument!.id}::uuid`,
        ),
        chunks: await rawRows(
          scopedDb,
          sql`select text from document_chunks
          where id = ${sourceChunk!.id}::uuid`,
        ),
      };
    },
  );
  expect(copiedText).toEqual({ documents: [], chunks: [] });
  expect(
    await getDocument(db.db, f.workspace.id, sourceDocument!.id, {
      viewerSubjectId: f.other.subjectId,
    }),
  ).toBeNull();
  const [secondBase] = await shared.admin<{ id: string }[]>`
    insert into document_bases(account_id, workspace_id, name)
    values (${f.workspace.accountId}, ${f.workspace.id}, 'Another base') returning id`;
  await expect(
    addDocumentToBase(db.db, {
      accountId: f.workspace.accountId,
      workspaceId: f.workspace.id,
      baseId: secondBase!.id,
      fileId: sourceFileId,
      authorityKind: "workspace",
      createdBy: f.owner.subjectId,
      initiatingSubjectId: f.owner.subjectId,
      access: { viewerSubjectId: f.owner.subjectId },
    }),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining("Document source requires independent File sharing"),
    },
  });
  expect(
    (await f.call(f.other, "GET", `/documents/${sourceDocument!.id}/original-file`)).status,
  ).toBe(404);
  expect(
    (await f.callWithoutHost(f.other, "GET", `/documents/${sourceDocument!.id}/original-file`))
      .status,
  ).toBe(404);
  expect(
    (await f.call(f.other, "POST", `/documents/${sourceDocument!.id}/original-file/download-url`))
      .status,
  ).toBe(404);
  const sharedSource = await f.call(f.owner, "PUT", `/files/${sourceFileId}/visibility`, {
    visibility: "workspace",
  });
  expect(sharedSource.status, await sharedSource.clone().text()).toBe(200);
  expect(
    await getDocument(db.db, f.workspace.id, sourceDocument!.id, {
      viewerSubjectId: f.other.subjectId,
    }),
  ).not.toBeNull();
  expect(
    (await f.callWithoutHost(f.other, "GET", `/documents/${sourceDocument!.id}/original-file`))
      .status,
  ).toBe(200);
  await transitionSessionVisibility(db.db, {
    workspaceId: f.workspace.id,
    sessionId: session.id,
    actorSubjectId: f.owner.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `document-source:${crypto.randomUUID()}`,
  });
  expect(
    (await f.call(f.other, "GET", `/documents/${sourceDocument!.id}/original-file`)).status,
  ).toBe(200);
  expect(
    (await f.callWithoutHost(f.other, "GET", `/documents/${sourceDocument!.id}/original-file`))
      .status,
  ).toBe(200);
  expect(
    (await f.call(f.other, "POST", `/documents/${sourceDocument!.id}/original-file/download-url`))
      .status,
  ).toBe(200);
  expect(
    (
      await f.callWithoutHost(
        f.other,
        "POST",
        `/documents/${sourceDocument!.id}/original-file/download-url`,
      )
    ).status,
  ).toBe(200);
});

test("a generated file follows its source chat when the chat becomes private", async () => {
  const f = await fixture();
  const fileId = await f.readyFile(null, f.owner.subjectId);
  const session = await createSession(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Example request",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.owner.subjectId },
    createdByContext: {},
  });
  const sessionId = session.id;
  await shared.admin`
    insert into generated_image_artifacts (
      artifact_id, account_id, workspace_id, session_id, settlement_key,
      tool_call_id, source_strategy, provider_id, provider_binding_hash,
      status, media_type, size_bytes, sha256, width, height, sandbox_path, ready_at
    ) values (
      ${fileId}, ${f.workspace.accountId}, ${f.workspace.id}, ${sessionId}, ${"c".repeat(64)},
      'fixture-call', 'provider_adapter', 'fixture', ${"b".repeat(64)},
      'ready', 'image/png', 4, ${"a".repeat(64)}, 1, 1,
      ${`/workspace/generated-images/generated-image-${fileId}.png`}, now()
    )`;
  await shared.admin`update files set source_session_id = ${sessionId},
    source_session_shared_unrestricted = true where id = ${fileId}`;
  const unsharedFileId = await f.readyFile(null, f.owner.subjectId);
  await shared.admin`update files set source_session_id = ${sessionId},
    source_session_shared_unrestricted = true where id = ${unsharedFileId}`;
  const legacyOwnerlessId = await f.readyFile(null, null);
  await shared.admin`update files set source_session_id = ${sessionId},
    source_session_shared_unrestricted = true where id = ${legacyOwnerlessId}`;
  const personalFileId = await f.readyFile(f.owner.subjectId);
  await shared.admin`update files set source_session_id = ${sessionId},
    source_session_shared_unrestricted = true where id = ${personalFileId}`;
  const otherOwnedFileId = await f.readyFile(f.other.subjectId);
  await shared.admin`update files set source_session_id = ${sessionId},
    source_session_shared_unrestricted = true where id = ${otherOwnedFileId}`;
  const otherOwnedSharedFileId = await f.readyFile(null, f.other.subjectId);
  await shared.admin`update files set source_session_id = ${sessionId},
    source_session_shared_unrestricted = true where id = ${otherOwnedSharedFileId}`;
  const uploadedFileId = crypto.randomUUID();
  await createFileUpload(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    fileId: uploadedFileId,
    sourceSessionId: sessionId,
    filename: "upload.txt",
    safeFilename: "upload.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    bucket: "fixture",
    objectKey: `workspaces/${f.workspace.id}/files/${uploadedFileId}/original/upload.txt`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await shared.admin`update files set status = 'ready' where id = ${uploadedFileId}`;
  const [uploadedSource] = await shared.admin`
    select source_session_id as source, source_session_audience_explicit as explicit
    from files where id = ${uploadedFileId}`;
  expect(uploadedSource).toMatchObject({ source: sessionId, explicit: false });

  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(200);
  const ownerGrant: AccessGrant = {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    subjectId: f.owner.subjectId,
    principalKind: "human_session",
    permissions: ["files:read"],
  };
  const [inheritedSource] = await getFilesForSubject(db.db, {
    accountId: ownerGrant.accountId,
    workspaceId: ownerGrant.workspaceId,
    subjectId: ownerGrant.subjectId,
    fileIds: [fileId],
  });
  expect(inheritedSource).toBeDefined();
  expect(await fileMayBeCopiedToWorkspace({ db: db.db }, ownerGrant, inheritedSource!)).toBe(false);
  expect(
    (
      await updateFileVisibility(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        fileId,
        visibility: "workspace",
        actorSubjectId: f.owner.subjectId,
        auditSubjectId: "agent:example",
        agentAttempt: true,
      })
    ).kind,
  ).toBe("not_changeable");
  const [sharingFlag] = await shared.admin`
    select source_session_audience_explicit as explicit from files where id = ${fileId}`;
  expect(sharingFlag?.explicit).toBe(false);
  const unrelatedAgent = await withSessionRlsActorContext(
    {
      subjectId: "agent:example",
      initiatingHumanSubjectId: f.owner.subjectId,
      agentRootSessionId: crypto.randomUUID(),
    },
    () =>
      getFilesForSubject(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        subjectId: "agent:example",
        fileIds: [fileId],
      }),
  );
  expect(unrelatedAgent).toHaveLength(0);
  await transitionSessionVisibility(db.db, {
    workspaceId: f.workspace.id,
    sessionId,
    actorSubjectId: f.owner.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `file-visibility:${crypto.randomUUID()}`,
  });
  const wrongOwnerShare = await f.call(
    f.owner,
    "PUT",
    `/files/${otherOwnedSharedFileId}/visibility`,
    { visibility: "workspace" },
  );
  expect(wrongOwnerShare.status).toBe(403);
  const [wrongOwnerFlag] = await shared.admin`
    select source_session_audience_explicit as explicit from files
    where id = ${otherOwnedSharedFileId}`;
  expect(wrongOwnerFlag?.explicit).toBe(false);
  const [sourceSnapshot] = await shared.admin`
    select source_session_owner_subject_id as owner from files where id = ${unsharedFileId}`;
  expect(sourceSnapshot?.owner).toBe(f.owner.subjectId);
  const [legacySnapshot] = await shared.admin`
    select source_session_owner_subject_id as owner from files where id = ${legacyOwnerlessId}`;
  expect(legacySnapshot?.owner).toBe(f.owner.subjectId);
  const serviceFiles = await getFilesForSubject(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    subjectId: null,
    fileIds: [fileId],
  });
  expect(serviceFiles).toHaveLength(0);
  const anotherRootFiles = await withSessionRlsActorContext(
    {
      subjectId: "agent:example",
      initiatingHumanSubjectId: f.owner.subjectId,
      agentRootSessionId: crypto.randomUUID(),
    },
    () =>
      getFilesForSubject(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        subjectId: "agent:example",
        fileIds: [fileId],
      }),
  );
  expect(anotherRootFiles).toHaveLength(0);
  const sameRootFiles = await withSessionRlsActorContext(
    {
      subjectId: "agent:example",
      initiatingHumanSubjectId: f.owner.subjectId,
      agentRootSessionId: sessionId,
    },
    () =>
      getFilesForSubject(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        subjectId: "agent:example",
        fileIds: [fileId],
      }),
  );
  expect(sameRootFiles).toHaveLength(1);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(404);
  // An old shared snapshot must never stand in for a hidden, still-live chat.
  await shared.admin`update files set source_session_shared_unrestricted = true
    where id = ${unsharedFileId}`;
  expect((await f.call(f.other, "GET", `/files/${unsharedFileId}`)).status).toBe(404);
  await shared.admin`update files set source_session_shared_unrestricted = false
    where id = ${unsharedFileId}`;
  expect((await f.call(f.other, "GET", `/files/${uploadedFileId}`)).status).toBe(404);
  const legacyShare = await f.call(f.owner, "PUT", `/files/${legacyOwnerlessId}/visibility`, {
    visibility: "workspace",
  });
  expect(legacyShare.status, await legacyShare.clone().text()).toBe(200);
  const [legacyOwner] = await shared.admin`
    select owner_subject_id as owner, source_session_audience_explicit as explicit
    from files where id = ${legacyOwnerlessId}`;
  expect(legacyOwner).toMatchObject({ owner: f.owner.subjectId, explicit: true });
  expect((await f.call(f.other, "GET", `/files/${legacyOwnerlessId}`)).status).toBe(200);
  const legacyLimit = await f.call(f.owner, "PUT", `/files/${legacyOwnerlessId}/visibility`, {
    visibility: "private",
  });
  expect(legacyLimit.status, await legacyLimit.clone().text()).toBe(200);
  expect((await f.call(f.other, "GET", `/files/${legacyOwnerlessId}`)).status).toBe(404);
  expect((await f.call(f.other, "POST", `/files/${fileId}/download-url`)).status).toBe(404);
  expect((await f.call(f.other, "GET", `/artifacts/${fileId}`)).status).toBe(404);
  expect((await f.call(f.other, "GET", `/artifacts/${fileId}/content`)).status).toBe(404);
  const listed = await f.call(f.other, "GET", "/files");
  expect(listed.status).toBe(200);
  expect(JSON.stringify(await listed.json())).not.toContain(fileId);
  const ownerFile = await f.call(f.owner, "GET", `/files/${fileId}`);
  expect(ownerFile.status).toBe(200);
  expect(((await ownerFile.json()) as { scope: string }).scope).toBe("personal");

  const sharedFile = await f.call(f.owner, "PUT", `/files/${fileId}/visibility`, {
    visibility: "workspace",
  });
  expect(sharedFile.status, await sharedFile.clone().text()).toBe(200);
  const [explicitSource] = await getFilesForSubject(db.db, {
    accountId: ownerGrant.accountId,
    workspaceId: ownerGrant.workspaceId,
    subjectId: ownerGrant.subjectId,
    fileIds: [fileId],
  });
  expect(explicitSource).toBeDefined();
  expect(await fileMayBeCopiedToWorkspace({ db: db.db }, ownerGrant, explicitSource!)).toBe(true);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(200);
  await shared.admin`delete from sessions where id = ${sessionId}`;
  expect((await f.call(f.other, "GET", `/files/${otherOwnedFileId}`)).status).toBe(404);
  expect((await f.call(f.owner, "GET", `/files/${unsharedFileId}`)).status).toBe(200);
  expect((await f.call(f.other, "GET", `/files/${unsharedFileId}`)).status).toBe(404);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(200);
});

test("a private Slack source keeps its File ID private", async () => {
  const f = await fixture();
  const suffix = crypto.randomUUID();
  const [connection] = await shared.admin<{ id: string }[]>`
    insert into connections (
      account_id, workspace_id, subject_id, provider_domain, kind,
      credential_encrypted, verified_install_at, verified_install_version, metadata
    ) values (
      ${f.workspace.accountId}, ${f.workspace.id}, null, 'slack.com', 'app_install',
      repeat('x', 32), now(), 1, ${shared.admin.json({
        credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
        credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
        slackTeamId: `T_${suffix}`,
        slackTeamName: "Example team",
        botId: `B_${suffix}`,
        botUserId: `U_${suffix}`,
        botDisplayName: "Opengeni",
        verifiedAt: new Date().toISOString(),
      })}
    ) returning id`;
  const { interaction } = await getOrCreateSlackInteraction(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    connectionId: connection!.id,
    slackTeamId: `T_${suffix}`,
    slackChannelId: `D_${suffix}`,
    slackThreadTs: "1710000000.000001",
    routeKey: `D_${suffix}:1710000000.000001`,
    triggeringProviderEventId: `E_${suffix}`,
    owningSubjectId: f.owner.subjectId,
    visibility: "private",
  });
  const session = await createSession(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    requestedSessionId: interaction.sessionReservationId,
    initialMessage: "Example request",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.owner.subjectId },
    createdByContext: {},
  });
  await bindSlackInteractionSession(db.db, {
    ...interaction,
    owningSubjectId: f.owner.subjectId,
    sessionId: session.id,
  });
  expect(await sourceSessionRequiresHumanShare(db.db, f.workspace.id, session.id)).toBe(true);
  const fileId = crypto.randomUUID();
  await withSessionRlsActorContext(
    { subjectId: f.owner.subjectId, privateFileOwnerSubjectId: f.owner.subjectId },
    () =>
      createFileUpload(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        fileId,
        sourceSessionId: session.id,
        filename: "output.txt",
        safeFilename: "output.txt",
        contentType: "text/plain",
        sizeBytes: 4,
        bucket: "fixture",
        objectKey: `workspaces/${f.workspace.id}/files/${fileId}/original/output.txt`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
  );
  await shared.admin`update files set status = 'ready' where id = ${fileId}`;
  const [source] = await shared.admin`
    select source_session_owner_subject_id as owner, source_session_shared_unrestricted as shared
    from files where id = ${fileId}`;
  expect(source).toMatchObject({ owner: f.owner.subjectId, shared: false });
  expect((await f.call(f.owner, "GET", `/files/${fileId}`)).status).toBe(200);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(404);
  await expect(
    (async () =>
      await shared.admin`update slack_interactions set visibility = 'workspace_shared'
        where id = ${interaction.id}`)(),
  ).rejects.toThrow("Slack interaction audience is immutable");
  await expect(
    (async () => await shared.admin`delete from connections where id = ${connection!.id}`)(),
  ).rejects.toThrow();
  const laterFileId = crypto.randomUUID();
  await withSessionRlsActorContext(
    { subjectId: f.owner.subjectId, privateFileOwnerSubjectId: f.owner.subjectId },
    () =>
      createFileUpload(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        fileId: laterFileId,
        sourceSessionId: session.id,
        filename: "later.txt",
        safeFilename: "later.txt",
        contentType: "text/plain",
        sizeBytes: 4,
        bucket: "fixture",
        objectKey: `workspaces/${f.workspace.id}/files/${laterFileId}/original/later.txt`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
  );
  await shared.admin`update files set status = 'ready' where id = ${laterFileId}`;
  expect((await f.call(f.other, "GET", `/files/${laterFileId}`)).status).toBe(404);
  expect((await f.call(f.owner, "GET", `/files/${fileId}`)).status).toBe(200);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(404);
  await shared.admin`delete from sessions where id = ${session.id}`;
  await shared.admin`delete from connections where id = ${connection!.id}`;
  expect((await f.call(f.owner, "GET", `/files/${fileId}`)).status).toBe(200);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(404);
});

test("a host denial also hides a shared source File ID and listing", async () => {
  const f = await fixture(shared, db, true);
  const session = await createSession(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Example request",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.owner.subjectId },
    createdByContext: {},
  });
  const fileId = crypto.randomUUID();
  await createFileUpload(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    fileId,
    sourceSessionId: session.id,
    filename: "output.txt",
    safeFilename: "output.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    bucket: "fixture",
    objectKey: `workspaces/${f.workspace.id}/files/${fileId}/original/output.txt`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await shared.admin`update files set status = 'ready' where id = ${fileId}`;
  const [authorizedFile] = await getFilesForSubject(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    subjectId: f.other.subjectId,
    fileIds: [fileId],
  });
  expect(authorizedFile?.id).toBe(fileId);
  const fileGrant = {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    subjectId: f.other.subjectId,
    permissions: ["files:read"],
  } as AccessGrant;
  const surfaces: string[] = [];
  const surfacePort = {
    authorizeSession: async ({ surface }: { surface: string }) => {
      surfaces.push(surface);
      return surface === "http"
        ? ({ allowed: true } as const)
        : ({ allowed: false, reason: "revoked" } as const);
    },
    resolveListScope: async () => ({ kind: "all" as const }),
  };
  expect(
    await fileSourceVisibleToHost(
      { db: db.db, sessionAuthorization: surfacePort },
      fileGrant,
      fileId,
      f.workspace.id,
      true,
      f.other.subjectId,
      authorizedFile,
      "http",
    ),
  ).toBe(true);
  expect(
    await fileSourceVisibleToHost(
      { db: db.db, sessionAuthorization: surfacePort },
      fileGrant,
      fileId,
      f.workspace.id,
      true,
      f.other.subjectId,
      authorizedFile,
      "first_party_mcp",
    ),
  ).toBe(false);
  expect(surfaces).toEqual(["http", "first_party_mcp"]);
  await expect(
    validateFileResources(
      db.db,
      f.workspace.accountId,
      f.workspace.id,
      f.other.subjectId,
      [{ kind: "file", fileId }],
      undefined,
      fileGrant,
      {
        authorizeSession: async () => ({ allowed: false, reason: "revoked" }),
        resolveListScope: async () => ({ kind: "all" }),
      },
    ),
  ).rejects.toThrow("unknown file resource");
  expect(
    await fileSourceVisibleToHost(
      {
        db: db.db,
        sessionAuthorization: {
          authorizeSession: async () => ({ allowed: false, reason: "revoked" }),
          resolveListScope: async () => ({ kind: "all" }),
        },
      },
      {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        subjectId: f.other.subjectId,
      } as AccessGrant,
      fileId,
      f.workspace.id,
      true,
      f.other.subjectId,
      authorizedFile,
    ),
  ).toBe(false);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(404);
  expect((await f.call(f.other, "GET", `/artifacts/${fileId}`)).status).toBe(404);
  expect((await f.call(f.other, "POST", `/files/${fileId}/download-url`)).status).toBe(404);
  const list = await f.call(f.other, "GET", "/files");
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ files: [], nextCursor: null });
  const firstVisible = await f.readyFile(null, f.owner.subjectId);
  const secondVisible = await f.readyFile(null, f.owner.subjectId);
  await shared.admin`update files set created_at = now() - interval '2 minutes'
    where id = ${firstVisible}`;
  await shared.admin`update files set created_at = now() - interval '3 minutes'
    where id = ${secondVisible}`;
  const firstPage = await f.call(f.other, "GET", "/files?limit=1");
  expect(firstPage.status).toBe(200);
  const firstBody = (await firstPage.json()) as {
    files: Array<{ id: string }>;
    nextCursor: string | null;
  };
  expect(firstBody.files.map((file) => file.id)).toEqual([firstVisible]);
  expect(firstBody.nextCursor).not.toBeNull();
  const position = JSON.parse(Buffer.from(firstBody.nextCursor!, "base64url").toString("utf8"));
  expect(position.id).toBe(firstVisible);
  const secondPage = await f.call(
    f.other,
    "GET",
    `/files?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
  );
  expect(secondPage.status).toBe(200);
  expect((await secondPage.json()) as { files: Array<{ id: string }> }).toMatchObject({
    files: [{ id: secondVisible }],
  });
});

test("migration removes legacy document resolver access from custom runtime roles", async () => {
  const legacy = await acquireSharedTestDatabase("file-resolver-role", {
    withheldMigrations: ["0914_session_file_source_visibility.sql"],
  });
  if (!legacy) throw new Error("File resolver role test requires real PostgreSQL");
  const roleName = `og_test_resolver_${crypto.randomUUID().replaceAll("-", "")}`;
  let roleCreated = false;
  try {
    const [row] = await legacy.admin`select current_schema() as schema_name`;
    const schemaName = String(row!.schema_name);
    await legacy.admin.unsafe(`CREATE ROLE "${roleName}"`);
    roleCreated = true;
    await legacy.admin.unsafe(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${roleName}"`);
    await legacy.admin.unsafe(
      `GRANT EXECUTE ON FUNCTION "${schemaName}".resolve_document_original_file(uuid,uuid,text,uuid) TO "${roleName}"`,
    );
    const [before] = await legacy.admin`select has_function_privilege(
      ${roleName}, ${`${schemaName}.resolve_document_original_file(uuid,uuid,text,uuid)`}, 'EXECUTE') as allowed`;
    expect(before?.allowed).toBe(true);
    await legacy.admin.unsafe(
      await readFile(
        new URL(
          "../../../packages/db/drizzle/0914_session_file_source_visibility.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const [after] = await legacy.admin`select has_function_privilege(
      ${roleName}, ${`${schemaName}.resolve_document_original_file_authority_0914(uuid,uuid,text,uuid)`}, 'EXECUTE') as allowed`;
    expect(after?.allowed).toBe(false);
  } finally {
    if (roleCreated) {
      await legacy.admin.unsafe(`DROP OWNED BY "${roleName}"`);
      await legacy.admin.unsafe(`DROP ROLE "${roleName}"`);
    }
    await legacy.release();
  }
}, 180_000);

test("migration protects existing output and preserves a verified human share", async () => {
  const legacy = await acquireSharedTestDatabase("file-source-backfill", {
    withheldMigrations: ["0914_session_file_source_visibility.sql"],
  });
  if (!legacy) throw new Error("File source backfill requires real PostgreSQL");
  const legacyDb = createDb(legacy.appUrl);
  try {
    const f = await fixture(legacy, legacyDb);
    const session = await createSession(legacyDb.db, {
      accountId: f.workspace.accountId,
      workspaceId: f.workspace.id,
      initialMessage: "Example request",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: f.owner.subjectId },
      createdByContext: {},
    });
    const inheritedFileId = await f.readyFile(null, f.owner.subjectId);
    const sharedFileId = await f.readyFile(null, f.owner.subjectId);
    const orphanFileId = await f.readyFile(null, f.owner.subjectId);
    const oldAgentUploadId = await f.readyFile(null, f.owner.subjectId);
    const disputedOwnerId = await f.readyFile(null, f.owner.subjectId);
    const humanUploadId = await f.readyFile(null, f.owner.subjectId);
    const oldSpillId = await f.readyFile(null, null);
    const oldSandboxId = await f.readyFile(null, f.owner.subjectId);
    const sharedSandboxId = await f.readyFile(null, f.owner.subjectId);
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${oldAgentUploadId}/original/upload.txt`}
      where id = ${oldAgentUploadId}`;
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${disputedOwnerId}/original/output.txt`}
      where id = ${disputedOwnerId}`;
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${humanUploadId}/original/report.txt`}
      where id = ${humanUploadId}`;
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${oldSpillId}/tool-results/output.json`}
      where id = ${oldSpillId}`;
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${oldSandboxId}/sandbox/output.txt`}
      where id = ${oldSandboxId}`;
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${sharedSandboxId}/sandbox/shared.txt`}
      where id = ${sharedSandboxId}`;
    await legacy.admin`insert into opengeni_private.file_source_adjudications
      (file_id, decision, attested_by) values
      (${sharedFileId}, 'human_shared', 'fixture-operator'),
      (${oldAgentUploadId}, 'owner_only', 'fixture-operator'),
      (${humanUploadId}, 'human_shared', 'fixture-operator'),
      (${sharedSandboxId}, 'human_shared', 'fixture-operator')`;
    await legacy.admin`insert into opengeni_private.file_source_adjudications
      (file_id, decision, owner_subject_id, attested_by) values
      (${inheritedFileId}, 'owner_only', ${f.owner.subjectId}, 'fixture-operator'),
      (${oldSpillId}, 'owner_only', ${f.owner.subjectId}, 'fixture-operator'),
      (${disputedOwnerId}, 'owner_only', ${f.other.subjectId}, 'fixture-operator')`;
    await legacy.admin`
      insert into audit_events (account_id, workspace_id, subject_id, action, target_type, target_id, metadata)
      values (${f.workspace.accountId}, ${f.workspace.id}, 'worker:first-party-mcp',
        'file.signed_upload.issued', 'workspace_file', ${oldAgentUploadId}, '{}'::jsonb)`;
    await legacy.admin`
      insert into generated_image_artifacts (
        artifact_id, account_id, workspace_id, session_id, settlement_key,
        tool_call_id, source_strategy, provider_id, provider_binding_hash,
        status, media_type, size_bytes, sha256, width, height, sandbox_path, ready_at
      ) values (
        ${inheritedFileId}, ${f.workspace.accountId}, ${f.workspace.id}, ${session.id}, ${"d".repeat(64)},
        'fixture-call', 'provider_adapter', 'fixture', ${"e".repeat(64)},
        'ready', 'image/png', 4, ${"a".repeat(64)}, 1, 1,
        ${`/workspace/generated-images/generated-image-${inheritedFileId}.png`}, now()
      )`;
    await legacy.admin`
      insert into audit_events (account_id, workspace_id, subject_id, action, target_type, target_id, metadata)
      values (${f.workspace.accountId}, ${f.workspace.id}, 'agent:example',
        'file.visibility.changed', 'workspace_file', ${inheritedFileId},
        jsonb_build_object('from', 'private', 'to', 'workspace'))`;
    await legacy.admin`
      insert into generated_image_artifacts (
        artifact_id, account_id, workspace_id, session_id, settlement_key,
        tool_call_id, source_strategy, provider_id, provider_binding_hash,
        status, media_type, size_bytes, sha256, width, height, sandbox_path, ready_at
      ) values (
        ${orphanFileId}, ${f.workspace.accountId}, ${f.workspace.id}, null, ${"f".repeat(64)},
        'fixture-orphan', 'provider_adapter', 'fixture', ${"e".repeat(64)},
        'ready', 'image/png', 4, ${"a".repeat(64)}, 1, 1,
        ${`/workspace/generated-images/generated-image-${orphanFileId}.png`}, now()
      )`;
    await legacy.admin`
      insert into opengeni_private.sandbox_file_publications
        (account_id, workspace_id, file_id, source_session_id)
      values (${f.workspace.accountId}, ${f.workspace.id}, ${sharedFileId}, ${session.id})`;
    await legacy.admin`
      insert into audit_events (account_id, workspace_id, subject_id, action, target_type, target_id, metadata)
      values (${f.workspace.accountId}, ${f.workspace.id}, ${f.owner.subjectId},
        'file.visibility.changed', 'workspace_file', ${sharedFileId},
        jsonb_build_object('from', 'private', 'to', 'workspace'))`;
    await transitionSessionVisibility(legacyDb.db, {
      workspaceId: f.workspace.id,
      sessionId: session.id,
      actorSubjectId: f.owner.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `file-backfill:${crypto.randomUUID()}`,
    });
    await legacy.admin.unsafe(
      await readFile(
        new URL(
          "../../../packages/db/drizzle/0914_session_file_source_visibility.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const files = await legacy.admin`
      select id, source_session_id, source_session_owner_subject_id,
        source_session_audience_explicit from files
      where id in (${inheritedFileId}, ${sharedFileId}) order by id`;
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.source_session_id === session.id)).toBe(true);
    expect(files.every((file) => file.source_session_owner_subject_id === f.owner.subjectId)).toBe(
      true,
    );
    const byId = new Map(files.map((file) => [file.id, file]));
    expect(byId.get(inheritedFileId)?.source_session_audience_explicit).toBe(false);
    expect(byId.get(sharedFileId)?.source_session_audience_explicit).toBe(true);
    const [orphan] = await legacy.admin`
      select source_session_provenance_missing as missing from files where id = ${orphanFileId}`;
    expect(orphan?.missing).toBe(true);
    expect((await f.call(f.other, "GET", `/files/${orphanFileId}`)).status).toBe(404);
    expect((await f.call(f.owner, "GET", `/files/${orphanFileId}`)).status).toBe(200);
    const recoveredShare = await f.call(f.owner, "PUT", `/files/${orphanFileId}/visibility`, {
      visibility: "workspace",
    });
    expect(recoveredShare.status, await recoveredShare.clone().text()).toBe(200);
    expect((await f.call(f.other, "GET", `/files/${orphanFileId}`)).status).toBe(200);
    expect((await f.call(f.other, "GET", `/files/${oldAgentUploadId}`)).status).toBe(404);
    expect((await f.call(f.owner, "GET", `/files/${oldAgentUploadId}`)).status).toBe(200);
    expect((await f.call(f.owner, "GET", `/files/${disputedOwnerId}`)).status).toBe(404);
    expect((await f.call(f.other, "GET", `/files/${disputedOwnerId}`)).status).toBe(200);
    const [attested] = await legacy.admin`select owner_subject_id as owner,
      source_session_owner_subject_id as source_owner from files where id = ${disputedOwnerId}`;
    expect(attested).toMatchObject({
      owner: f.other.subjectId,
      source_owner: f.other.subjectId,
    });
    expect((await f.call(f.other, "GET", `/files/${humanUploadId}`)).status).toBe(200);
    expect((await f.call(f.other, "GET", `/files/${oldSpillId}`)).status).toBe(404);
    expect((await f.call(f.owner, "GET", `/files/${oldSpillId}`)).status).toBe(200);
    expect((await f.call(f.other, "GET", `/files/${oldSandboxId}`)).status).toBe(404);
    expect((await f.call(f.other, "GET", `/files/${sharedSandboxId}`)).status).toBe(200);
    expect((await f.call(f.other, "GET", `/files/${inheritedFileId}`)).status).toBe(404);
    expect((await f.call(f.owner, "GET", `/files/${inheritedFileId}`)).status).toBe(200);
    expect((await f.call(f.other, "GET", `/files/${sharedFileId}`)).status).toBe(200);
  } finally {
    await legacyDb.close();
    await legacy.release();
  }
}, 180_000);

test("migration requires decisions for ambiguous shared originals", async () => {
  const legacy = await acquireSharedTestDatabase("file-source-ownerless-preflight", {
    withheldMigrations: ["0914_session_file_source_visibility.sql"],
  });
  if (!legacy) throw new Error("File source preflight requires real PostgreSQL");
  const legacyDb = createDb(legacy.appUrl);
  try {
    const f = await fixture(legacy, legacyDb);
    const fileId = await f.readyFile(null, null);
    const ordinaryPrivateId = await f.readyFile(f.owner.subjectId);
    const privateOutputId = await f.readyFile(f.owner.subjectId);
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${fileId}/original/legacy.txt`}
      where id = ${fileId}`;
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${ordinaryPrivateId}/original/ordinary.txt`}
      where id = ${ordinaryPrivateId}`;
    await legacy.admin`update files set object_key =
      ${`workspaces/${f.workspace.id}/files/${privateOutputId}/original/output.txt`}
      where id = ${privateOutputId}`;
    const [base] = await legacy.admin<{ id: string }[]>`
      insert into document_bases(account_id, workspace_id, name)
      values (${f.workspace.accountId}, ${f.workspace.id}, 'Example base') returning id`;
    const [document] = await legacy.admin<{ id: string }[]>`
      insert into documents(account_id, workspace_id, base_id, file_id, status,
        title, created_by, authority_kind, authority_workspace_id, visibility)
      values (${f.workspace.accountId}, ${f.workspace.id}, ${base!.id}, ${ordinaryPrivateId},
        'ready', 'Ordinary original', ${f.owner.subjectId}, 'workspace',
        ${f.workspace.id}, 'workspace') returning id`;
    const migration = await readFile(
      new URL(
        "../../../packages/db/drizzle/0914_session_file_source_visibility.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await expect((async () => await legacy.admin.unsafe(migration))()).rejects.toThrow(
      "Ambiguous shared legacy uploads require operator adjudication",
    );
    await legacy.admin`insert into opengeni_private.file_source_adjudications
      (file_id, decision, attested_by) values
      (${fileId}, 'owner_only', 'fixture-operator')`;
    await expect((async () => await legacy.admin.unsafe(migration))()).rejects.toThrow(
      "Ambiguous private legacy uploads require operator adjudication",
    );
    await legacy.admin`insert into opengeni_private.file_source_adjudications
      (file_id, decision, owner_subject_id, attested_by) values
      (${ordinaryPrivateId}, 'ordinary_upload', null, 'fixture-operator'),
      (${privateOutputId}, 'owner_only', ${f.other.subjectId}, 'fixture-operator')`;
    await expect((async () => await legacy.admin.unsafe(migration))()).rejects.toThrow(
      "Legacy private file owner conflicts with operator adjudication",
    );
    await legacy.admin`update opengeni_private.file_source_adjudications
      set owner_subject_id = ${f.owner.subjectId} where file_id = ${privateOutputId}`;
    await expect((async () => await legacy.admin.unsafe(migration))()).rejects.toThrow(
      "Ownerless legacy file provenance requires operator adjudication",
    );
    await legacy.admin`update opengeni_private.file_source_adjudications
      set owner_subject_id = ${f.owner.subjectId} where file_id = ${fileId}`;
    await legacy.admin.unsafe(migration);
    const [ordinary] = await legacy.admin`select source_session_provenance_missing as missing
      from files where id = ${ordinaryPrivateId}`;
    expect(ordinary?.missing).toBe(false);
    expect((await f.call(f.other, "GET", `/documents/${document!.id}/original-file`)).status).toBe(
      200,
    );
    expect((await f.call(f.other, "GET", `/files/${privateOutputId}`)).status).toBe(404);
    expect((await f.call(f.owner, "GET", `/files/${privateOutputId}`)).status).toBe(200);
    expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(404);
    expect((await f.call(f.owner, "GET", `/files/${fileId}`)).status).toBe(200);
    const sharedByOwner = await f.call(f.owner, "PUT", `/files/${fileId}/visibility`, {
      visibility: "workspace",
    });
    expect(sharedByOwner.status, await sharedByOwner.clone().text()).toBe(200);
    expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(200);
  } finally {
    await legacyDb.close();
    await legacy.release();
  }
}, 180_000);

test("migration refuses a source whose historical Slack audience was erased", async () => {
  const legacy = await acquireSharedTestDatabase("missing-slack-audience", {
    withheldMigrations: ["0914_session_file_source_visibility.sql"],
  });
  if (!legacy) throw new Error("Slack audience preflight requires real PostgreSQL");
  const legacyDb = createDb(legacy.appUrl);
  try {
    const f = await fixture(legacy, legacyDb);
    const session = await createSession(legacyDb.db, {
      accountId: f.workspace.accountId,
      workspaceId: f.workspace.id,
      initialMessage: "Synthetic Slack request",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: f.owner.subjectId },
      createdByContext: {},
    });
    await initializeSessionStartAtomically(legacyDb.db, {
      accountId: f.workspace.accountId,
      workspaceId: f.workspace.id,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      clientEventId: "slack:synthetic-event",
    });
    const fileId = await f.readyFile(null, f.owner.subjectId);
    await legacy.admin`insert into generated_image_artifacts (
      artifact_id, account_id, workspace_id, session_id, settlement_key,
      tool_call_id, source_strategy, provider_id, provider_binding_hash,
      status, media_type, size_bytes, sha256, width, height, sandbox_path, ready_at
    ) values (${fileId}, ${f.workspace.accountId}, ${f.workspace.id}, ${session.id},
      ${"d".repeat(64)}, 'fixture-call', 'provider_adapter', 'fixture', ${"e".repeat(64)},
      'ready', 'image/png', 4, ${"a".repeat(64)}, 1, 1,
      ${`/workspace/generated-images/generated-image-${fileId}.png`}, now())`;
    const migration = await readFile(
      new URL(
        "../../../packages/db/drizzle/0914_session_file_source_visibility.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await expect((async () => await legacy.admin.unsafe(migration))()).rejects.toThrow(
      "Missing historical Slack audience requires operator adjudication",
    );
    const privateFileId = await f.readyFile(f.owner.subjectId);
    await legacy.admin`insert into opengeni_private.sandbox_file_publications
      (account_id, workspace_id, file_id, source_session_id)
      values (${f.workspace.accountId}, ${f.workspace.id}, ${privateFileId}, ${session.id})`;
    await legacy.admin`insert into opengeni_private.file_source_adjudications
      (file_id, decision, owner_subject_id, attested_by)
      values (${fileId}, 'owner_only', null, 'fixture-operator'),
        (${privateFileId}, 'owner_only', ${f.other.subjectId}, 'fixture-operator')`;
    await expect((async () => await legacy.admin.unsafe(migration))()).rejects.toThrow(
      "Known-source owner-only decision requires a verified owner",
    );
    await legacy.admin`update opengeni_private.file_source_adjudications
      set owner_subject_id = ${f.owner.subjectId} where file_id = ${fileId}`;
    await expect((async () => await legacy.admin.unsafe(migration))()).rejects.toThrow(
      "Legacy private file owner conflicts with operator adjudication",
    );
    await legacy.admin`update opengeni_private.file_source_adjudications
      set owner_subject_id = ${f.owner.subjectId} where file_id = ${privateFileId}`;
    await legacy.admin.unsafe(migration);
    expect(
      await withSessionRlsActorContext(
        { subjectId: f.owner.subjectId, privateFileOwnerSubjectId: f.owner.subjectId },
        () =>
          getFilesForSubject(legacyDb.db, {
            accountId: f.workspace.accountId,
            workspaceId: f.workspace.id,
            subjectId: f.owner.subjectId,
            fileIds: [fileId],
          }),
      ),
    ).toHaveLength(1);
    expect(
      await getFilesForSubject(legacyDb.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        subjectId: f.other.subjectId,
        fileIds: [fileId],
      }),
    ).toHaveLength(0);
  } finally {
    await legacyDb.close();
    await legacy.release();
  }
}, 180_000);

test("a shared chat's retained file remains shared after chat deletion", async () => {
  const f = await fixture();
  const session = await createSession(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Example request",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.owner.subjectId },
    createdByContext: {},
  });
  const fileId = crypto.randomUUID();
  await createFileUpload(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    fileId,
    sourceSessionId: session.id,
    filename: "upload.txt",
    safeFilename: "upload.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    bucket: "fixture",
    objectKey: `workspaces/${f.workspace.id}/files/${fileId}/original/upload.txt`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await shared.admin`update files set status = 'ready' where id = ${fileId}`;
  const [source] = await shared.admin`
    select s.owner_subject_id as session_owner, f.source_session_owner_subject_id as file_owner
    from files f join sessions s on s.id = f.source_session_id where f.id = ${fileId}`;
  expect(source?.session_owner).toBe(f.owner.subjectId);
  expect(source?.file_owner).toBeNull();
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(200);
  await shared.admin`delete from sessions where id = ${session.id}`;
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(200);
  const unrelatedAgent = await withSessionRlsActorContext(
    {
      subjectId: "agent:example",
      initiatingHumanSubjectId: f.owner.subjectId,
      agentRootSessionId: crypto.randomUUID(),
    },
    () =>
      getFilesForSubject(db.db, {
        accountId: f.workspace.accountId,
        workspaceId: f.workspace.id,
        subjectId: "agent:example",
        fileIds: [fileId],
      }),
  );
  expect(unrelatedAgent).toHaveLength(0);
});

test("user-scoped chat files stay personal before and after source deletion", async () => {
  const f = await fixture();
  const session = await createSession(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    initialMessage: "Example request",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: f.owner.subjectId },
    createdByContext: {},
  });
  const fileId = crypto.randomUUID();
  await createFileUpload(db.db, {
    accountId: f.workspace.accountId,
    workspaceId: f.workspace.id,
    fileId,
    sourceSessionId: session.id,
    filename: "output.txt",
    safeFilename: "output.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    bucket: "fixture",
    objectKey: `workspaces/${f.workspace.id}/files/${fileId}/original/output.txt`,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await shared.admin`update files set status = 'ready' where id = ${fileId}`;
  await shared.admin`update sessions set memory_scope = 'user',
    scope_subject_id = ${f.owner.subjectId} where id = ${session.id}`;
  const [snapshot] = await shared.admin`
    select source_session_owner_subject_id as owner, source_session_shared_unrestricted as shared
    from files where id = ${fileId}`;
  expect(snapshot).toMatchObject({ owner: f.owner.subjectId, shared: false });
  expect((await f.call(f.owner, "GET", `/files/${fileId}`)).status).toBe(200);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(404);
  await shared.admin`delete from sessions where id = ${session.id}`;
  expect((await f.call(f.owner, "GET", `/files/${fileId}`)).status).toBe(200);
  expect((await f.call(f.other, "GET", `/files/${fileId}`)).status).toBe(404);
});

test("an app-shot travels with its screenshot and only with an image", async () => {
  const f = await fixture();
  const appShot = {
    app: "Safari",
    bundleId: "com.apple.Safari",
    title: "Example Domain",
    capturedAt: "2026-10-20T09:15:00.000Z",
    platform: "macos",
    text: "Example Domain\nThis domain is for use in documentation examples.",
    window: { processId: 812, windowId: 4211 },
  };
  const screenshot = await f.call(f.owner, "POST", "/files/uploads", {
    filename: "Safari - Example Domain.png",
    contentType: "image/png",
    sizeBytes: 4,
    appShot,
  });
  expect(screenshot.status, await screenshot.clone().text()).toBe(201);
  const { fileId } = (await screenshot.json()) as { fileId: string };
  const [row] = await shared.admin`select app_shot from files where id = ${fileId}`;
  expect(row!.app_shot).toEqual(appShot);
  const read = await f.call(f.owner, "GET", `/files/${fileId}`);
  expect(read.status, await read.clone().text()).toBe(200);
  expect(((await read.json()) as { appShot?: unknown }).appShot).toEqual(appShot);

  const notAnImage = await f.call(f.owner, "POST", "/files/uploads", {
    filename: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    appShot,
  });
  expect(notAnImage.status).toBe(422);
});
