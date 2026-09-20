import { beforeAll, afterAll, test, expect } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  bootstrapWorkspace,
  createSession,
  createFileUpload,
  completeFileUpload,
  withSessionRlsActorContext,
  withWorkspaceRls,
  acceptSessionFileAttachments,
  readSessionFileAttachments,
  requireFileForSubject,
  getFilesForSubject,
  initializeSessionStartAtomically,
  claimSessionWorkForAttempt,
  applySessionTurnSettlement,
  ensureManagedAccessForUser,
  transitionSessionVisibility,
  forkSessionContent,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-file-attachments");
  if (!acquired) throw new Error("PostgreSQL unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
async function fixture(managed = false) {
  const id = crypto.randomUUID();
  const access = managed
    ? await ensureManagedAccessForUser(client.db, {
        userId: id,
        email: `${id}@example.test`,
        name: "Attachment owner",
      })
    : await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: id,
        accountName: "Attachments",
        workspaceExternalSource: "test",
        workspaceExternalId: id,
        workspaceName: "Attachments",
        subjectId: `user:${id}`,
      });
  const grant = access.workspaceGrants[0]!;
  if (managed) {
    await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by)
      values(${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'attachment-test') on conflict do nothing`;
    await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id)
      values(${grant.accountId},true,1,null) on conflict(account_id) do update set enabled=true`;
  }
  const owner = { subjectId: grant.subjectId, privateFileOwnerSubjectId: grant.subjectId };
  const file = await withSessionRlsActorContext(owner, async () => {
    const uploaded = await createFileUpload(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      fileId: crypto.randomUUID(),
      privateOwnerSubjectId: grant.subjectId,
      filename: "test.png",
      safeFilename: "test.png",
      contentType: "image/png",
      sizeBytes: 3,
      bucket: "test",
      objectKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    });
    return completeFileUpload(client.db, grant.workspaceId!, uploaded.uploadId);
  });
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [{ kind: "file", fileId: file.id }],
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const start = await initializeSessionStartAtomically(client.db, {
    ...scope,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!start.turn) throw new Error("missing human attachment turn");
  const turn = start.turn;
  const accept = () =>
    acceptSessionFileAttachments(client.db, {
      ...scope,
      sessionId: session.id,
      turnId: turn.id,
      subjectId: grant.subjectId,
      resources: [{ kind: "file", fileId: file.id }],
    });
  const read = (subjectId: string, sessionId = session.id, authorityEpoch = 1) =>
    withSessionRlsActorContext({ subjectId }, () =>
      readSessionFileAttachments(client.db, {
        ...scope,
        fileIds: [file.id],
        access: { sessionId, authorityEpoch, actor: { kind: "subject", subjectId } },
      }),
    );
  return { grant, session, file, owner, scope, accept, read, turn: start.turn };
}
test("accepted session attachment is readable by another viewer without publishing its original", async () => {
  const f = await fixture();
  const viewer = "user:viewer";
  expect(await f.read(viewer)).toEqual([]);
  await withSessionRlsActorContext(f.owner, f.accept);
  expect((await f.read(viewer)).map((row) => row.id)).toEqual([f.file.id]);
  await expect(
    withSessionRlsActorContext({ subjectId: viewer }, () =>
      requireFileForSubject(client.db, { ...f.scope, subjectId: viewer, fileId: f.file.id }),
    ),
  ).rejects.toThrow("File not found");
  await expect(f.read(viewer, f.session.id, 2)).rejects.toThrow();
  const other = await createSession(client.db, {
    ...f.scope,
    initialMessage: "other",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  expect(await f.read(viewer, other.id)).toEqual([]);
});
test("inherited human and arbitrary file IDs do not mint attachment grants", async () => {
  const f = await fixture();
  await expect(
    withSessionRlsActorContext(
      {
        subjectId: "service:agent-turn",
        initiatingHumanSubjectId: f.grant.subjectId,
        privateFileOwnerSubjectId: f.grant.subjectId,
      },
      f.accept,
    ),
  ).rejects.toThrow();
  expect(await f.read("user:viewer")).toEqual([]);
  await expect(
    withSessionRlsActorContext(f.owner, () =>
      withWorkspaceRls(client.db, f.scope.workspaceId, async (tx) => {
        await acceptSessionFileAttachments(tx, {
          ...f.scope,
          sessionId: f.session.id,
          turnId: f.turn.id,
          subjectId: f.grant.subjectId,
          resources: [{ kind: "file", fileId: f.file.id }],
        });
        throw Error("rollback");
      }),
    ),
  ).rejects.toThrow("rollback");
  expect(await f.read("user:viewer")).toEqual([]);
});
test("session read capability does not survive a successful read", async () => {
  const f = await fixture();
  await withSessionRlsActorContext(f.owner, f.accept);
  await withSessionRlsActorContext({ subjectId: "user:viewer" }, () =>
    withWorkspaceRls(client.db, f.scope.workspaceId, async (tx) => {
      expect(
        await readSessionFileAttachments(tx, {
          ...f.scope,
          fileIds: [f.file.id],
          access: {
            sessionId: f.session.id,
            authorityEpoch: 1,
            actor: { kind: "subject", subjectId: "user:viewer" },
          },
        }),
      ).toHaveLength(1);
      expect(
        await getFilesForSubject(tx, {
          ...f.scope,
          subjectId: "user:viewer",
          fileIds: [f.file.id],
        }),
      ).toEqual([]);
    }),
  );
});

test("live service continuation reads accepted attachments without a human or private owner", async () => {
  const f = await fixture();
  await withSessionRlsActorContext(f.owner, f.accept);
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, f.scope.workspaceId, {
    sessionId: f.session.id,
    workflowId: `session-${f.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("missing live attempt");
  const access = {
    sessionId: f.session.id,
    authorityEpoch: 1,
    actor: {
      kind: "agent_attempt" as const,
      subjectId: "service:agent-turn",
      callerSessionId: f.session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
  const read = () =>
    withSessionRlsActorContext(
      {
        subjectId: "service:agent-turn",
        initiatingHumanSubjectId: null,
        privateFileOwnerSubjectId: null,
        sessionAttachmentReadAccess: access,
      },
      () =>
        getFilesForSubject(client.db, {
          ...f.scope,
          subjectId: null,
          fileIds: [f.file.id],
        }),
    );
  const files = await read();
  expect(files.map((file) => file.id)).toEqual([f.file.id]);
  expect(files[0]?.scope).toBe("personal");
  expect(files[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await applySessionTurnSettlement(client.db, f.scope.workspaceId, {
    sessionId: f.session.id,
    turnId: claim.turn.id,
    triggerEventId: claim.turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [],
  });
  await expect(read()).rejects.toThrow();
  expect(
    await withSessionRlsActorContext({ subjectId: "service:agent-turn" }, () =>
      getFilesForSubject(client.db, {
        ...f.scope,
        subjectId: null,
        fileIds: [f.file.id],
      }),
    ),
  ).toEqual([]);
});

test("an owned upload absent from the accepted human message receives no grant", async () => {
  const f = await fixture();
  const another = await withSessionRlsActorContext(f.owner, async () => {
    const upload = await createFileUpload(client.db, {
      ...f.scope,
      fileId: crypto.randomUUID(),
      privateOwnerSubjectId: f.grant.subjectId,
      filename: "not-attached.txt",
      safeFilename: "not-attached.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      bucket: "test",
      objectKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
    });
    return completeFileUpload(client.db, f.scope.workspaceId, upload.uploadId);
  });
  await withSessionRlsActorContext(f.owner, () =>
    acceptSessionFileAttachments(client.db, {
      ...f.scope,
      sessionId: f.session.id,
      turnId: f.turn.id,
      subjectId: f.grant.subjectId,
      resources: [{ kind: "file", fileId: another.id }],
    }),
  );
  expect(
    await withSessionRlsActorContext({ subjectId: "user:viewer" }, () =>
      readSessionFileAttachments(client.db, {
        ...f.scope,
        fileIds: [another.id],
        access: {
          sessionId: f.session.id,
          authorityEpoch: 1,
          actor: { kind: "subject", subjectId: "user:viewer" },
        },
      }),
    ),
  ).toEqual([]);
});

test("sharing changes attachment readers; making private revokes session reads and forks retain accepted copies", async () => {
  const f = await fixture(true);
  await withSessionRlsActorContext(f.owner, f.accept);
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, f.scope.workspaceId, {
    sessionId: f.session.id,
    workflowId: `session-${f.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("missing human turn");
  await applySessionTurnSettlement(client.db, f.scope.workspaceId, {
    sessionId: f.session.id,
    turnId: claim.turn.id,
    triggerEventId: claim.turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [],
  });
  await transitionSessionVisibility(client.db, {
    workspaceId: f.scope.workspaceId,
    sessionId: f.session.id,
    actorSubjectId: f.grant.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  await expect(f.read("user:viewer", f.session.id, 2)).rejects.toThrow();
  expect(await f.read(f.grant.subjectId, f.session.id, 2)).toHaveLength(1);
  await transitionSessionVisibility(client.db, {
    workspaceId: f.scope.workspaceId,
    sessionId: f.session.id,
    actorSubjectId: f.grant.subjectId,
    targetVisibility: "workspace_shared",
    expectedAuthorityEpoch: 2,
    operationKey: crypto.randomUUID(),
  });
  expect(await f.read("user:viewer", f.session.id, 3)).toHaveLength(1);
  const fork = await forkSessionContent(client.db, {
    sourceWorkspaceId: f.scope.workspaceId,
    sourceSessionId: f.session.id,
    destinationWorkspaceId: f.scope.workspaceId,
    destinationVisibility: "workspace_shared",
    workspaceSharedAcknowledged: false,
    actorSubjectId: f.grant.subjectId,
    operationKey: crypto.randomUUID(),
  });
  expect(await f.read("user:viewer", fork.sessionId, 1)).toHaveLength(1);
  const accepted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.scope.workspaceId,
    f.grant.subjectId,
    (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...f.scope,
        sessionId: fork.sessionId,
        subjectId: f.grant.subjectId,
        actor: { type: "human", subjectId: f.grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Fork boundary",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
  );
  const nestedAttempt = crypto.randomUUID();
  const nestedClaim = await claimSessionWorkForAttempt(client.db, f.scope.workspaceId, {
    sessionId: fork.sessionId,
    workflowId: `session-${fork.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: nestedAttempt,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (nestedClaim.action !== "claimed") throw new Error("Fork turn not claimed");
  expect(nestedClaim.turn.id).toBe(accepted.turnId);
  await applySessionTurnSettlement(client.db, f.scope.workspaceId, {
    sessionId: fork.sessionId,
    turnId: nestedClaim.turn.id,
    triggerEventId: nestedClaim.turn.triggerEventId,
    attemptId: nestedAttempt,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [],
  });
  const nested = await forkSessionContent(client.db, {
    sourceWorkspaceId: f.scope.workspaceId,
    sourceSessionId: fork.sessionId,
    sourceEventId: nestedClaim.turn.triggerEventId,
    destinationWorkspaceId: f.scope.workspaceId,
    destinationVisibility: "workspace_shared",
    workspaceSharedAcknowledged: false,
    actorSubjectId: f.grant.subjectId,
    operationKey: crypto.randomUUID(),
  });
  expect(await f.read("user:viewer", nested.sessionId, 1)).toHaveLength(1);

  await transitionSessionVisibility(client.db, {
    workspaceId: f.scope.workspaceId,
    sessionId: f.session.id,
    actorSubjectId: f.grant.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 3,
    operationKey: crypto.randomUUID(),
  });
  expect(await f.read("user:viewer", fork.sessionId, 1)).toHaveLength(1);
  await expect(f.read("user:viewer", f.session.id, 4)).rejects.toThrow();
});

test("session attachment read honors the host authorization boundary", async () => {
  const { readSessionAttachmentFiles } = await import("@opengeni/core");
  const f = await fixture();
  await withSessionRlsActorContext(f.owner, f.accept);
  const viewer = { ...f.grant, workspaceId: f.scope.workspaceId, subjectId: "user:viewer" };
  expect(
    await readSessionAttachmentFiles({ db: client.db }, viewer, f.session.id, [f.file.id]),
  ).toHaveLength(1);
  await expect(
    readSessionAttachmentFiles(
      {
        db: client.db,
        sessionAuthorization: {
          resolveListScope: async () => {
            throw new Error("not used");
          },
          authorizeSession: async () => ({ allowed: false as const, reason: "forbidden" as const }),
        },
      },
      viewer,
      f.session.id,
      [f.file.id],
    ),
  ).rejects.toThrow();
  await expect(
    readSessionAttachmentFiles(
      {
        db: client.db,
        sessionAuthorization: {
          resolveListScope: async () => {
            throw new Error("not used");
          },
          authorizeSession: async () => {
            throw new Error("host offline");
          },
        },
      },
      viewer,
      f.session.id,
      [f.file.id],
    ),
  ).rejects.toThrow();
});

test("realtime stages uploads without a turn, then accepts them with the authenticated human", async () => {
  const f = await fixture();
  const staged = await createSession(client.db, {
    ...f.scope,
    initialMessage: "",
    resources: [{ kind: "file", fileId: f.file.id }],
    createdBy: { kind: "subject", subjectId: f.grant.subjectId },
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const opened = await initializeSessionStartAtomically(client.db, {
    ...f.scope,
    sessionId: staged.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    deferInitialTurn: true,
  });
  expect(opened.turn).toBeNull();
  expect(await f.read("user:viewer", staged.id)).toEqual([]);
  const admitted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.scope.workspaceId,
    f.grant.subjectId,
    (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...f.scope,
        sessionId: staged.id,
        subjectId: f.grant.subjectId,
        actor: { type: "human", subjectId: f.grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "steer",
        text: "Voice request",
        resources: [],
        reasoningEffortFallback: "low",
        source: "api",
      }),
  );
  const [turn] =
    await shared.admin`select initiator_kind,initiating_human_subject_id from session_turns where id=${admitted.turnId}`;
  expect(turn).toMatchObject({
    initiator_kind: "subject",
    initiating_human_subject_id: f.grant.subjectId,
  });
  expect(await f.read("user:viewer", staged.id)).toHaveLength(1);
});

test("ordinary Send accepts private attachments after persisting the human message", async () => {
  const f = await fixture();
  const target = await createSession(client.db, {
    ...f.scope,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.scope.workspaceId,
    f.grant.subjectId,
    (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...f.scope,
        sessionId: target.id,
        subjectId: f.grant.subjectId,
        actor: { type: "human", subjectId: f.grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Use this image",
        resources: [{ kind: "file", fileId: f.file.id }],
        reasoningEffortFallback: "low",
        source: "user",
      }),
  );
  expect(await f.read("user:viewer", target.id)).toHaveLength(1);
});

test("migration backfills only original uploads proven by accepted human messages", async () => {
  const f = await fixture();
  const unrelated = await fixture();
  expect(await f.read("user:viewer")).toEqual([]);
  const migration = await Bun.file(
    new URL("../drizzle/0499_session_attachment_access.sql", import.meta.url),
  ).text();
  const start = migration.indexOf("ALTER TABLE files NO FORCE ROW LEVEL SECURITY;");
  const end = migration.indexOf("-- Copy only already accepted attachment grants", start);
  if (start < 0 || end < 0) throw new Error("Missing backfill boundary");
  await shared.admin.begin(async (tx) => {
    const [owner] =
      await tx`select r.rolname from pg_class c join pg_roles r on r.oid=c.relowner where c.oid='files'::regclass`;
    await tx.unsafe(`SET LOCAL ROLE "${String(owner!.rolname).replaceAll('"', '""')}"`);
    await tx.unsafe(migration.slice(start, end));
  });
  expect(await f.read("user:viewer")).toHaveLength(1);
  expect(
    await withSessionRlsActorContext({ subjectId: "user:viewer" }, () =>
      readSessionFileAttachments(client.db, {
        ...f.scope,
        fileIds: [unrelated.file.id],
        access: {
          sessionId: f.session.id,
          authorityEpoch: 1,
          actor: { kind: "subject", subjectId: "user:viewer" },
        },
      }),
    ),
  ).toEqual([]);
  const [policy] =
    await shared.admin`select relforcerowsecurity from pg_class where oid='files'::regclass`;
  expect(policy!.relforcerowsecurity).toBe(true);
});
