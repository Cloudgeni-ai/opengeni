import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  completeFileUpload,
  createDb,
  createSession,
  EditableArtifactAudienceOwnerRequiredError,
  EditableArtifactPersistenceError,
  getFile,
  listArtifactCatalogCandidates,
  prepareGeneratedWorkspaceFile,
  PostgresEditableArtifactStore,
  readEditableArtifactAudiences,
  setEditableArtifactAudience,
  withRlsContext,
} from "../src/index";
import { rawRows, withSessionRlsActorContext } from "../src/database";

// A document, spreadsheet or presentation is shared with its workspace or
// Only me, like a chat or a Site (1160). An Only me one opens only for its
// owner: the owner themselves, or an agent turn acting for them or running in
// their own Only me chat. Colleagues, workspace administrators, keys and
// services do not open it, and the artifact catalog does not list it for them.
// Runs as the restricted application role, as deployed.

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("editable-artifact-audience");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

const STATE_HASH = `sha256:${"b".repeat(64)}`;

function stableId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

async function workspace() {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const owner = `user:${crypto.randomUUID()}`;
  const colleague = `user:${crypto.randomUUID()}`;
  const admin = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into managed_accounts(id,name) values(${accountId},'Artifact audiences')`;
  await shared.admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Team')`;
  const personal = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
  for (const id of personal)
    await shared.admin`insert into workspaces(id,account_id,name) values(${id},${accountId},'Personal')`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${accountId},${owner},'member','active',${personal[0]}),
      (${accountId},${colleague},'member','active',${personal[1]}),
      (${accountId},${admin},'admin','active',${personal[2]})`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
    values(${accountId},${workspaceId},${owner},'member',
        opengeni_private.workspace_member_role_permissions('member')),
      (${accountId},${workspaceId},${colleague},'member',
        opengeni_private.workspace_member_role_permissions('member')),
      (${accountId},${workspaceId},${admin},'admin',
        opengeni_private.workspace_member_role_permissions('admin'))`;
  await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
    values (${accountId}, ${workspaceId}) on conflict (workspace_id) do nothing`;
  return { accountId, workspaceId, owner, colleague, admin };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

/** Created through the store, as the application does, by its owner. */
async function artifact(
  ws: Workspace,
  audience: { visibility: "workspace_shared" | "user_private"; owner: string | null },
  modality: "document" | "spreadsheet" | "presentation" = "document",
): Promise<string> {
  const scope = { accountId: ws.accountId, workspaceId: ws.workspaceId };
  const artifactId = stableId();
  const snapshotId = stableId();
  const creator = audience.owner ?? ws.owner;
  const publishedAt = new Date().toISOString();
  const snapshotCommon = {
    scope,
    artifactId,
    snapshotId,
    blobReference: `editable-artifacts/${artifactId}/${snapshotId}`,
    byteSize: 256,
    contentHash: `sha256:${"f".repeat(64)}`,
    mimeType: "application/vnd.opengeni.editable-artifact-snapshot" as const,
    coveredHeadSequence: 0,
    stateHash: STATE_HASH,
    modelSchemaVersion: modality === "spreadsheet" ? 2 : 1,
    kernelVersion: "test-kernel-1",
    verifiedAt: publishedAt,
    publishedAt,
  };
  const event = {
    kind: "snapshot_published" as const,
    schemaVersion: 1 as const,
    scope,
    artifactId,
    snapshotId,
    coveredHeadSequence: 0,
    stateHash: STATE_HASH,
    publishedAt,
  };
  const store = new PostgresEditableArtifactStore(app.db);
  const result = await store.createArtifact({
    scope,
    artifactId,
    authorizationActor: { kind: "human", subjectId: creator, replicaId: "9999999999999999" },
    receiptId: stableId(),
    authorityKey: JSON.stringify(["human", creator]),
    idempotencyKey: `create:${artifactId}`,
    requestHash: `sha256:${"a".repeat(64)}`,
    operationKind: "create",
    modality,
    title: "Plan",
    expectedScopeAuthorizationRevision: 1,
    initialArtifactAuthorizationRevision: 1,
    createdBySubjectId: creator,
    ...(audience.owner === null
      ? {}
      : { audience: { visibility: audience.visibility, ownerSubjectId: audience.owner } }),
    genesisSnapshot:
      modality === "spreadsheet"
        ? {
            ...snapshotCommon,
            modality,
            coveredCausalFrontier: [],
            operationProtocolVersion: 2,
            crdtStateVersion: 2,
          }
        : { ...snapshotCommon, modality, nativeRevision: 0 },
    outbox: {
      outboxId: stableId(),
      event:
        modality === "spreadsheet"
          ? { ...event, modality, operationProtocolVersion: 2 }
          : { ...event, modality },
      state: "pending",
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: publishedAt,
      lastErrorCode: null,
      publishedAt: null,
      deadLetteredAt: null,
      createdAt: publishedAt,
    },
  } as Parameters<PostgresEditableArtifactStore["createArtifact"]>[0]);
  expect(result.kind).toBe("result");
  return artifactId;
}

type Actor =
  | { kind: "human"; subjectId: string }
  | { kind: "service"; subjectId: string; serviceName: string }
  | { kind: "agent"; sessionId: string; turnId: string; attemptId: string };

async function allowed(
  ws: Workspace,
  artifactId: string,
  actor: Actor,
  permission: "read" | "edit" | "export" = "read",
): Promise<boolean> {
  const [row] = await withRlsContext(
    app.db,
    { accountId: ws.accountId, workspaceId: ws.workspaceId },
    async (tx) =>
      await rawRows<{ allowed: boolean }>(
        tx,
        sql`select allowed from opengeni_private.authorize_editable_artifact_actor(
          ${ws.accountId}::uuid, ${ws.workspaceId}::uuid, ${artifactId}, ${actor.kind},
          ${actor.kind === "agent" ? "worker:first-party-mcp" : actor.subjectId},
          ${actor.kind === "agent" ? actor.sessionId : null},
          ${actor.kind === "agent" ? actor.turnId : null},
          ${actor.kind === "agent" ? actor.attemptId : null},
          ${actor.kind === "agent" ? 1 : null}::integer,
          ${actor.kind === "service" ? actor.serviceName : null},
          ${permission}, current_schema())`,
      ),
  );
  return row?.allowed === true;
}

/** A live agent turn in a chat, started by a person or by a service. */
async function agentTurn(
  ws: Workspace,
  options: {
    initiator: { kind: "subject"; subjectId: string } | { kind: "service" };
    onlyMeChatOf?: string;
  },
): Promise<Extract<Actor, { kind: "agent" }>> {
  const creator = options.onlyMeChatOf ?? ws.owner;
  const session = await withSessionRlsActorContext({ subjectId: creator }, () =>
    createSession(app.db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: creator },
      createdByContext: {},
      ...(options.onlyMeChatOf ? { visibility: "user_private" as const, subjectId: creator } : {}),
      model: "gpt-5.6-sol",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    }),
  );
  const attemptId = crypto.randomUUID();
  const subject =
    options.initiator.kind === "subject" ? options.initiator.subjectId : "service:meetings";
  const turnId = await shared.admin.begin(async (tx) => {
    // As the current runtime writes turns, inside the chat's tenant.
    await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
    await tx`select set_config('opengeni.account_id', ${ws.accountId}, true),
      set_config('opengeni.workspace_id', ${ws.workspaceId}, true)`;
    const [turn] = await tx<{ id: string }[]>`
      insert into session_turns (
        account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        active_attempt_id, initiator_kind, initiator_subject_id
      ) values (
        ${ws.accountId}, ${ws.workspaceId}, ${session.id}, gen_random_uuid(),
        'artifact-audience', 'running', 0, 'edit artifact', 'gpt-5.6-sol',
        'medium', 'none', 1, null, ${options.initiator.kind}, ${subject}
      ) returning id`;
    await tx`update sessions set active_turn_id = ${turn!.id} where id = ${session.id}`;
    await tx`update session_turns set active_attempt_id = ${attemptId} where id = ${turn!.id}`;
    await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id,
        execution_generation, state, temporal_workflow_id,
        temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${ws.accountId}, ${ws.workspaceId}, ${session.id}, ${turn!.id},
        1, 'running', 'artifact-audience', ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
    return turn!.id;
  });
  return { kind: "agent", sessionId: session.id, turnId, attemptId };
}

test("a workspace artifact, including every existing one, opens for the whole workspace", async () => {
  const ws = await workspace();
  const legacy = await artifact(ws, { visibility: "workspace_shared", owner: null });
  for (const subjectId of [ws.owner, ws.colleague, ws.admin])
    expect({ subjectId, allowed: await allowed(ws, legacy, { kind: "human", subjectId }) }).toEqual(
      { subjectId, allowed: true },
    );
  // An agent turn started by a colleague opens it too.
  const colleagueTurn = await agentTurn(ws, {
    initiator: { kind: "subject", subjectId: ws.colleague },
  });
  expect(await allowed(ws, legacy, colleagueTurn)).toBe(true);
}, 120_000);

test("an Only me artifact opens only for its owner, never for colleagues, admins or keys", async () => {
  const ws = await workspace();
  for (const modality of ["document", "spreadsheet", "presentation"] as const) {
    const id = await artifact(ws, { visibility: "user_private", owner: ws.owner }, modality);
    for (const permission of ["read", "edit", "export"] as const)
      expect({
        modality,
        permission,
        allowed: await allowed(ws, id, { kind: "human", subjectId: ws.owner }, permission),
      }).toEqual({ modality, permission, allowed: true });
    for (const subjectId of [ws.colleague, ws.admin])
      expect({ subjectId, allowed: await allowed(ws, id, { kind: "human", subjectId }) }).toEqual({
        subjectId,
        allowed: false,
      });
    // A configured key naming the owner is still not the owner.
    expect(
      await allowed(ws, id, {
        kind: "service",
        subjectId: ws.owner,
        serviceName: "configured_key",
      }),
    ).toBe(false);
  }
}, 120_000);

test("an agent opens an Only me artifact only for its owner's turn or in the owner's Only me chat", async () => {
  const ws = await workspace();
  const id = await artifact(ws, { visibility: "user_private", owner: ws.owner });
  // The owner's own turn, even in a chat shared with the workspace.
  const ownerTurn = await agentTurn(ws, { initiator: { kind: "subject", subjectId: ws.owner } });
  expect(await allowed(ws, id, ownerTurn, "edit")).toBe(true);
  // A colleague's turn does not, and neither does an admin's.
  for (const subjectId of [ws.colleague, ws.admin]) {
    const turn = await agentTurn(ws, { initiator: { kind: "subject", subjectId } });
    expect({ subjectId, allowed: await allowed(ws, id, turn) }).toEqual({
      subjectId,
      allowed: false,
    });
  }
  // A run without a person (such as a meeting summary) opens it only inside
  // the owner's own Only me chat.
  const inOwnersChat = await agentTurn(ws, {
    initiator: { kind: "service" },
    onlyMeChatOf: ws.owner,
  });
  expect(await allowed(ws, id, inOwnersChat)).toBe(true);
  const inSharedChat = await agentTurn(ws, { initiator: { kind: "service" } });
  expect(await allowed(ws, id, inSharedChat)).toBe(false);
  const inColleaguesChat = await agentTurn(ws, {
    initiator: { kind: "service" },
    onlyMeChatOf: ws.colleague,
  });
  expect(await allowed(ws, id, inColleaguesChat)).toBe(false);
}, 120_000);

test("only the owner changes who can open it, and the change re-decides open sessions", async () => {
  const ws = await workspace();
  const scope = { accountId: ws.accountId, workspaceId: ws.workspaceId };
  const id = await artifact(ws, { visibility: "workspace_shared", owner: ws.owner });
  const revision = async () =>
    Number(
      (
        await shared.admin<{ authorization_revision: string }[]>`
          select authorization_revision from editable_artifacts where id = ${id}`
      )[0]!.authorization_revision,
    );

  // Someone else cannot limit the owner's shared artifact.
  await expect(
    setEditableArtifactAudience(app.db, scope, {
      artifactId: id,
      callerSubjectId: ws.colleague,
      visibility: "user_private",
    }),
  ).rejects.toBeInstanceOf(EditableArtifactAudienceOwnerRequiredError);
  expect(await revision()).toBe(1);

  // The owner limits it to themselves; the authorization revision advances.
  expect(
    await setEditableArtifactAudience(app.db, scope, {
      artifactId: id,
      callerSubjectId: ws.owner,
      visibility: "user_private",
    }),
  ).toEqual({ visibility: "user_private", ownerSubjectId: ws.owner });
  expect(await revision()).toBe(2);
  expect(await allowed(ws, id, { kind: "human", subjectId: ws.colleague })).toBe(false);
  expect((await readEditableArtifactAudiences(app.db, scope, [id])).get(id)).toEqual({
    visibility: "user_private",
    ownerSubjectId: ws.owner,
  });

  // Someone else's Only me artifact answers exactly like a missing one.
  const missing = await setEditableArtifactAudience(app.db, scope, {
    artifactId: id,
    callerSubjectId: ws.admin,
    visibility: "workspace_shared",
  }).catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(EditableArtifactPersistenceError);
  expect((missing as EditableArtifactPersistenceError).code).toBe("not_found");

  // Asking for the audience it already has changes nothing.
  await setEditableArtifactAudience(app.db, scope, {
    artifactId: id,
    callerSubjectId: ws.owner,
    visibility: "user_private",
  });
  expect(await revision()).toBe(2);

  // Sharing it again opens it for the workspace.
  await setEditableArtifactAudience(app.db, scope, {
    artifactId: id,
    callerSubjectId: ws.owner,
    visibility: "workspace_shared",
  });
  expect(await revision()).toBe(3);
  expect(await allowed(ws, id, { kind: "human", subjectId: ws.colleague })).toBe(true);

  // An existing artifact without an owner stays shared: nobody can limit it.
  const legacy = await artifact(ws, { visibility: "workspace_shared", owner: null });
  await expect(
    setEditableArtifactAudience(app.db, scope, {
      artifactId: legacy,
      callerSubjectId: ws.owner,
      visibility: "user_private",
    }),
  ).rejects.toBeInstanceOf(EditableArtifactAudienceOwnerRequiredError);

  // The database itself refuses an Only me artifact without an owner.
  await expect(
    shared.admin`update editable_artifacts set visibility = 'user_private' where id = ${legacy}`,
  ).rejects.toThrow(/editable_artifacts_visibility_chk/);
}, 120_000);

test("the artifact catalog lists the workspace's artifacts and the viewer's own Only me ones", async () => {
  const ws = await workspace();
  const shared_ = await artifact(ws, { visibility: "workspace_shared", owner: ws.colleague });
  const ownersOnly = await artifact(ws, { visibility: "user_private", owner: ws.owner });
  const list = async (subjectId: string | null) =>
    (
      await listArtifactCatalogCandidates(
        app.db,
        { accountId: ws.accountId, workspaceId: ws.workspaceId },
        {
          query: { status: "active", sort: "recent", limit: 50 } as never,
          kinds: ["document"],
          siteViewer: { subjectId },
          snapshotAt: new Date(Date.now() + 60_000).toISOString(),
          limit: 50,
        },
      )
    )
      .map((row) => ({
        id: row.id,
        visibility: row.visibility,
        owner: row.owner_subject_id,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  const both = [
    { id: shared_, visibility: "workspace_shared" as const, owner: ws.colleague },
    { id: ownersOnly, visibility: "user_private" as const, owner: ws.owner },
  ].sort((left, right) => left.id.localeCompare(right.id));
  expect(await list(ws.owner)).toEqual(both);
  expect(await list(ws.colleague)).toEqual([
    { id: shared_, visibility: "workspace_shared", owner: ws.colleague },
  ]);
  expect(await list(ws.admin)).toEqual([
    { id: shared_, visibility: "workspace_shared", owner: ws.colleague },
  ]);
  expect(await list(null)).toEqual([
    { id: shared_, visibility: "workspace_shared", owner: ws.colleague },
  ]);
}, 120_000);

test("an Only me document's export file is written as its owner and stays theirs", async () => {
  // An agent exporting an Only me document from a chat shared with the
  // workspace runs with no Only me file owner, so the export is written and
  // completed scoped as the document's owner.
  const ws = await workspace();
  const exportFile = (fileId: string) => ({
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    fileId,
    uploadId: crypto.randomUUID(),
    filename: "Plan.docx",
    safeFilename: "plan.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 5,
    sha256: "c".repeat(64),
    bucket: "test",
    objectKey: `workspaces/${ws.workspaceId}/files/${fileId}/plan.docx`,
    expiresAt: new Date(Date.now() + 60_000),
    privateOwnerSubjectId: ws.owner,
  });
  const sharedChatTurn = { subjectId: "worker:export", privateFileOwnerSubjectId: null };
  const asOwner = { subjectId: "worker:export", privateFileOwnerSubjectId: ws.owner };

  // Unscoped, the owner's Only me file is refused.
  const refused = await withSessionRlsActorContext(sharedChatTurn, () =>
    prepareGeneratedWorkspaceFile(app.db, exportFile(crypto.randomUUID())),
  ).catch((error: unknown) => error);
  expect(String((refused as { cause?: unknown })?.cause ?? refused)).toContain(
    "row-level security",
  );

  // Scoped as the owner, it is made, completed and theirs alone.
  const input = exportFile(crypto.randomUUID());
  expect(
    (await withSessionRlsActorContext(asOwner, () => prepareGeneratedWorkspaceFile(app.db, input)))
      .created,
  ).toBe(true);
  expect(
    (
      await withSessionRlsActorContext(asOwner, () =>
        completeFileUpload(app.db, ws.workspaceId, input.uploadId),
      )
    ).status,
  ).toBe("ready");
  const [row] = await shared.admin<Array<{ owners: string[] | null }>>`
    select private_owner_subject_ids as owners from files where id = ${input.fileId}`;
  expect(row?.owners).toEqual([ws.owner]);
  for (const viewer of [ws.colleague, ws.admin]) {
    expect(
      await withSessionRlsActorContext(
        { subjectId: viewer, privateFileOwnerSubjectId: viewer },
        () => getFile(app.db, ws.workspaceId, input.fileId),
      ),
    ).toBeNull();
  }
  expect(
    (await withSessionRlsActorContext(asOwner, () => getFile(app.db, ws.workspaceId, input.fileId)))
      ?.id,
  ).toBe(input.fileId);
}, 120_000);
