import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encodeDocumentArtifactCommandBatch } from "@opengeni/contracts/document-artifact-commands";
import { encodeEditableArtifactSerializedCommit } from "@opengeni/contracts/editable-artifact-serialized-commit";
import {
  encodeEditableArtifactMutationIntent,
  hashEditableArtifactMutationIntentBytes,
} from "@opengeni/contracts/editable-artifacts";
import { encodePresentationArtifactCommandBatch } from "@opengeni/contracts/presentation-artifact-commands";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";

import { createDb, withRlsContext, type DbClient } from "../src/database";
import {
  bootstrapWorkspace,
  completeFileUpload,
  createSession,
  nestedPostgresSqlState,
  prepareEditableArtifactSourceFile,
} from "../src/index";
import { provisionRoles } from "../src/provision-roles";
import {
  EditableArtifactPersistenceError,
  PostgresEditableArtifactLiveReadStore,
  PostgresEditableArtifactLiveTicketStore,
  PostgresEditableArtifactStore,
  type PersistedEditableArtifact,
  type PersistedEditableArtifactCausalFrontier,
  type PersistedEditableArtifactKernelState,
  type PersistedEditableArtifactReceipt,
  type PersistedEditableArtifactSnapshotPublicationUnitOfWork,
} from "../src/editable-artifacts";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let dispatcherClient: DbClient | null = null;
let ticketPeerClient: DbClient | null = null;
let available = true;
let store: PostgresEditableArtifactStore;
let outboxStore: PostgresEditableArtifactStore;
let ticketStore: PostgresEditableArtifactLiveTicketStore;
let ticketPeerStore: PostgresEditableArtifactLiveTicketStore;
let accountId: string;
let workspaceId: string;
let otherAccountId: string;
let otherWorkspaceId: string;
let idCounter = 1n;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("editable-artifacts-postgres");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("[editable-artifacts] real PostgreSQL harness is unavailable");
    }
    available = false;
    return;
  }
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('artifact account') returning id`;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'artifact workspace') returning id`;
  const [otherAccount] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('other artifact account') returning id`;
  const [otherWorkspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${otherAccount!.id}, 'other artifact workspace') returning id`;
  accountId = account!.id;
  workspaceId = workspace!.id;
  otherAccountId = otherAccount!.id;
  otherWorkspaceId = otherWorkspace!.id;
  await shared.admin`
    insert into workspace_memberships (
      account_id, workspace_id, subject_id, permissions
    ) values
      (${accountId}, ${workspaceId}, 'user:alice',
        '["artifacts:read","artifacts:publish"]'::jsonb),
      (${accountId}, ${workspaceId}, 'user:ticket-owner',
        '["artifacts:read","artifacts:publish"]'::jsonb)`;
  client = createDb(shared.appUrl, { max: 8 });
  store = new PostgresEditableArtifactStore(client.db);
  ticketStore = new PostgresEditableArtifactLiveTicketStore(client.db);
  await provisionRoles(shared.adminUrl, {
    rlsStrategy: "scoped",
    artifactOutboxDispatcherRole: "opengeni_artifact_outbox_dispatcher",
    artifactOutboxDispatcherPassword: "artifact-outbox-test-password",
  });
  const dispatcherUrl = new URL(shared.adminUrl);
  dispatcherUrl.username = "opengeni_artifact_outbox_dispatcher";
  dispatcherUrl.password = "artifact-outbox-test-password";
  dispatcherClient = createDb(dispatcherUrl.toString(), { max: 2 });
  outboxStore = new PostgresEditableArtifactStore(dispatcherClient.db);
  ticketPeerClient = createDb(shared.appUrl, { max: 2 });
  ticketPeerStore = new PostgresEditableArtifactLiveTicketStore(ticketPeerClient.db);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await dispatcherClient?.close();
  await ticketPeerClient?.close();
  await shared?.release();
}, 180_000);

describe("Postgres editable artifact authority", () => {
  test("prepares one exact replay-safe Office source upload", async () => {
    if (!available || !client) return;
    const fileId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const input = {
      accountId,
      workspaceId,
      fileId,
      uploadId,
      filename: "final.xlsx",
      safeFilename: `editable-artifact-source-${fileId}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 4_096,
      sha256: "a".repeat(64),
      bucket: "artifact-test",
      objectKey: `workspaces/${workspaceId}/files/${fileId}/editable-artifact-source/final.xlsx`,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prepared = await prepareEditableArtifactSourceFile(client.db, input);
    expect(prepared).toMatchObject({ created: true, uploadId, file: { status: "pending_upload" } });
    expect(await prepareEditableArtifactSourceFile(client.db, input)).toMatchObject({
      created: false,
      uploadId,
      file: { id: fileId, sha256: "a".repeat(64), status: "pending_upload" },
    });
    expect((await completeFileUpload(client.db, workspaceId, uploadId)).status).toBe("ready");
    expect(await prepareEditableArtifactSourceFile(client.db, input)).toMatchObject({
      created: false,
      file: { status: "ready" },
    });
    await expect(
      prepareEditableArtifactSourceFile(client.db, { ...input, sha256: "b".repeat(64) }),
    ).rejects.toThrow("identity conflict");
  });

  test("tags built-in bootstrap grants with exact principal provenance", async () => {
    if (!available || !client) return;
    const suffix = crypto.randomUUID();
    const bootstrap = async (source: string) =>
      await bootstrapWorkspace(client!.db, {
        accountExternalSource: source,
        accountExternalId: `account-${suffix}`,
        accountName: `Artifact ${source}`,
        workspaceExternalSource: source,
        workspaceExternalId: `workspace-${suffix}`,
        workspaceName: `Artifact ${source}`,
        subjectId: `subject:${source}:${suffix}`,
      });
    expect((await bootstrap("opengeni:local")).workspaceGrants[0]?.principalKind).toBe(
      "human_session",
    );
    expect((await bootstrap("opengeni:configured")).workspaceGrants[0]?.principalKind).toBe(
      "configured_key",
    );
    expect((await bootstrap("artifact:generic")).workspaceGrants[0]?.principalKind).toBeUndefined();
  });

  test("grants the outbox dispatcher exactly six functions and no relation privileges", async () => {
    if (!available || !shared) return;
    const dispatcherRole = "opengeni_artifact_outbox_dispatcher";
    const expectedFunctions = [
      "claim_editable_artifact_live_outbox(text, integer, integer, name)",
      "dead_letter_editable_artifact_live_outbox(text, text, integer, text, name)",
      "mark_editable_artifact_live_outbox_published(text, text, integer, name)",
      "release_editable_artifact_live_outbox(text, text, integer, name)",
      "renew_editable_artifact_live_outbox(text, text, integer, integer, name)",
      "retry_editable_artifact_live_outbox(text, text, integer, integer, text, name)",
    ];
    const functionAcls = await shared.admin<
      Array<{
        signature: string;
        appExecute: boolean;
        dispatcherExecute: boolean;
        publicExecute: boolean;
      }>
    >`
      select
        procedure.proname || '(' || pg_catalog.oidvectortypes(procedure.proargtypes) || ')'
          as signature,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        has_function_privilege(${dispatcherRole}, procedure.oid, 'EXECUTE')
          as "dispatcherExecute",
        exists (
          select 1 from aclexplode(
            coalesce(procedure.proacl, acldefault('f', procedure.proowner))
          ) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private' and procedure.prokind = 'f'
      order by signature`;
    expect(
      functionAcls.filter((entry) => entry.dispatcherExecute).map((entry) => entry.signature),
    ).toEqual(expectedFunctions);
    for (const signature of expectedFunctions) {
      expect(functionAcls.find((entry) => entry.signature === signature)).toEqual({
        signature,
        appExecute: false,
        dispatcherExecute: true,
        publicExecute: false,
      });
    }
    const [directPrivileges] = await shared.admin<
      Array<{
        tablePrivileges: number;
        sequencePrivileges: number;
      }>
    >`
      select
        (select count(*)::int
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
            ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) privilege(name)
          where namespace.nspname = current_schema()
            and relation.relkind in ('r', 'p', 'v', 'm', 'f')
            and has_table_privilege(${dispatcherRole}, relation.oid, privilege.name)
        ) as "tablePrivileges",
        (select count(*)::int
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) privilege(name)
          where namespace.nspname = current_schema() and relation.relkind = 'S'
            and has_sequence_privilege(${dispatcherRole}, relation.oid, privilege.name)
        ) as "sequencePrivileges"`;
    expect(directPrivileges).toEqual({ tablePrivileges: 0, sequencePrivileges: 0 });
  }, 30_000);

  test("rejects null causal collections and incomplete live-ticket actors", async () => {
    if (!available || !shared || !client) return;
    const [validators] = await shared.admin<
      Array<{ frontierValid: boolean; idArrayValid: boolean }>
    >`
      select
        opengeni_private.editable_artifact_frontier_valid(null::jsonb) as "frontierValid",
        opengeni_private.editable_artifact_id_array_valid(null::jsonb) as "idArrayValid"`;
    expect(validators).toEqual({ frontierValid: false, idArrayValid: false });

    const invalidArtifactId = nextId();
    const invalidArtifactError = await shared.admin`
      insert into editable_artifacts (
        account_id, workspace_id, id, modality, title, authorization_revision,
        causal_frontier, state_hash, created_by_subject_id
      ) values (
        ${accountId}, ${workspaceId}, ${invalidArtifactId}, 'spreadsheet',
        'Invalid null frontier', 1, null, ${hash("e")}, 'user:null-frontier'
      )`.then(
      () => null,
      (error) => error,
    );
    expect((invalidArtifactError as { constraint_name?: string }).constraint_name).toBe(
      "editable_artifacts_frontier_chk",
    );

    const artifactId = nextId();
    const creation = creationFixture({
      scope: { accountId, workspaceId },
      artifactId,
      receiptId: nextId(),
      authorityKey: JSON.stringify(["human", "user:ticket-owner"]),
      idempotencyKey: `create:${artifactId}`,
      requestHash: hash("d"),
      modality: "document",
      title: "Live ticket null authority",
      stateHash: hash("c"),
      authorizationRevision: 1,
      createdBySubjectId: "user:ticket-owner",
    });
    expect((await store.createArtifact(creation)).kind).toBe("result");

    const completeAgent = {
      sessionId: "session:null-authority",
      turnId: "turn:null-authority",
      attemptId: "attempt:null-authority",
      generation: 1,
    };
    for (const missing of Object.keys(completeAgent) as Array<keyof typeof completeAgent>) {
      const actor = { ...completeAgent, [missing]: null };
      const digest = hashBytesSha256(
        new TextEncoder().encode(`missing-live-ticket-agent-${missing}`),
      );
      const error = await shared.admin`
        insert into editable_artifact_live_tickets (
          token_digest, account_id, workspace_id, artifact_id, modality,
          actor_kind, actor_subject_id, replica_id, agent_session_id,
          agent_turn_id, agent_attempt_id, agent_generation, allow_edit,
          protocol_version, issued_at, expires_at
        ) values (
          ${digest}, ${accountId}, ${workspaceId}, ${artifactId}, 'document',
          'agent', 'agent:null-authority', '1234567890abcdef', ${actor.sessionId},
          ${actor.turnId}, ${actor.attemptId}, ${actor.generation}, true, 1,
          now(), now() + interval '30 seconds'
        )`.then(
        () => null,
        (cause) => cause,
      );
      expect((error as { constraint_name?: string }).constraint_name).toBe(
        "editable_artifact_live_tickets_actor_chk",
      );
    }

    const serviceError = await shared.admin`
      insert into editable_artifact_live_tickets (
        token_digest, account_id, workspace_id, artifact_id, modality,
        actor_kind, actor_subject_id, replica_id, allow_edit, protocol_version,
        issued_at, expires_at
      ) values (
        ${hashBytesSha256(new TextEncoder().encode("missing-live-ticket-service"))},
        ${accountId}, ${workspaceId}, ${artifactId}, 'document',
        'service', 'service:null-authority', '234567890abcdef1', true, 1,
        now(), now() + interval '30 seconds'
      )`.then(
      () => null,
      (error) => error,
    );
    expect((serviceError as { constraint_name?: string }).constraint_name).toBe(
      "editable_artifact_live_tickets_actor_chk",
    );

    const invalidAuthorizations = [
      { artifactId: null, actorKind: "human", permission: "read" },
      { artifactId, actorKind: null, permission: "read" },
      { artifactId, actorKind: "human", permission: null },
    ] as const;
    for (const invalid of invalidAuthorizations) {
      const error = await withRlsContext(
        client.db,
        { accountId, workspaceId },
        async (tx) =>
          await tx.execute(sql`
            select * from opengeni_private.authorize_editable_artifact_actor(
              ${accountId}::uuid, ${workspaceId}::uuid, ${invalid.artifactId},
              ${invalid.actorKind}, 'user:alice', null, null, null, null, null,
              ${invalid.permission}
            )`),
      ).then(
        () => null,
        (cause) => cause,
      );
      expect(nestedPostgresSqlState(error)).toBe("22023");
    }
  }, 60_000);

  test("stores live tickets as execute-only, database-bounded, atomic one-use capabilities", async () => {
    if (!available || !shared) return;
    const scope = { accountId, workspaceId };
    const artifactId = nextId();
    const createdAt = new Date();
    const create = creationFixture({
      scope,
      artifactId,
      receiptId: nextId(),
      authorityKey: JSON.stringify(["human", "user:ticket-owner"]),
      idempotencyKey: `create:${artifactId}`,
      requestHash: hash("9"),
      modality: "document",
      title: "Live ticket authority",
      stateHash: hash("8"),
      authorizationRevision: 1,
      createdBySubjectId: "user:ticket-owner",
      createdAt,
    });
    const created = await store.createArtifact(create);
    expect(created.kind).toBe("result");

    const functionPosture = await shared.admin<
      Array<{
        signature: string;
        appExecute: boolean;
        publicExecute: boolean;
        securityDefiner: boolean;
        searchPath: string[] | null;
      }>
    >`
      select
        procedure.proname || '(' || pg_catalog.oidvectortypes(procedure.proargtypes) || ')'
          as signature,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1 from aclexplode(
            coalesce(procedure.proacl, acldefault('f', procedure.proowner))
          ) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.prosecdef as "securityDefiner",
        procedure.proconfig as "searchPath"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname in (
          'put_editable_artifact_live_ticket',
          'consume_editable_artifact_live_ticket',
          'cleanup_expired_editable_artifact_live_tickets',
          'resolve_editable_artifact_ticket_data_schema'
        )
      order by signature`;
    expect(functionPosture).toHaveLength(4);
    for (const routine of functionPosture) {
      expect(routine.publicExecute).toBe(false);
      expect(routine.securityDefiner).toBe(true);
      expect(routine.searchPath).toContain("search_path=pg_catalog, pg_temp");
      expect(routine.appExecute).toBe(
        !routine.signature.startsWith("resolve_editable_artifact_ticket_data_schema("),
      );
    }
    const authorizationRoutines = await shared.admin<
      Array<{
        signature: string;
        appExecute: boolean;
        publicExecute: boolean;
        securityDefiner: boolean;
      }>
    >`
      select
        procedure.proname || '(' || pg_catalog.oidvectortypes(procedure.proargtypes) || ')'
          as signature,
        has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as "appExecute",
        exists (
          select 1 from aclexplode(
            coalesce(procedure.proacl, acldefault('f', procedure.proowner))
          ) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        procedure.prosecdef as "securityDefiner"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname in (
          'authorize_editable_artifact_actor',
          'bump_editable_artifact_workspace_authorization',
          'invalidate_editable_artifact_authorization'
        )`;
    expect(Array.from(authorizationRoutines)).toEqual([
      {
        signature:
          "authorize_editable_artifact_actor(uuid, uuid, text, text, text, text, text, text, integer, text, text, name)",
        appExecute: true,
        publicExecute: false,
        securityDefiner: true,
      },
    ]);
    const [tablePrivileges] = await shared.admin<
      Array<{ privileges: number; rlsEnabled: boolean; rlsForced: boolean }>
    >`
      select
        (select count(*)::int
          from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
            ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) privilege(name)
          where has_table_privilege(
            'opengeni_app', 'editable_artifact_live_tickets', privilege.name
          )
        ) as privileges,
        relation.relrowsecurity as "rlsEnabled",
        relation.relforcerowsecurity as "rlsForced"
      from pg_class relation
      where relation.oid = 'editable_artifact_live_tickets'::regclass`;
    expect(tablePrivileges).toEqual({ privileges: 0, rlsEnabled: true, rlsForced: true });

    const ticketIssuedAt = new Date();
    const issuedAt = ticketIssuedAt.toISOString();
    const expiresAt = new Date(ticketIssuedAt.getTime() + 30_000).toISOString();
    const record = {
      tokenDigest: hash("7"),
      scope,
      artifactId,
      modality: "document" as const,
      actor: {
        kind: "agent" as const,
        subjectId: "agent:ticket-test",
        replicaId: "1234567890abcdef",
        sessionId: "session:ticket-test",
        turnId: "turn:ticket-test",
        attemptId: "attempt:ticket-test",
        generation: 3,
      },
      allowEdit: true,
      protocolVersion: 1,
      issuedAt,
      expiresAt,
    };
    await ticketStore.put(record);
    await expect(ticketStore.put(record)).rejects.toThrow("Live ticket digest collision");
    const consumed = await Promise.all([
      ticketStore.consume(record.tokenDigest),
      ticketPeerStore.consume(record.tokenDigest),
    ]);
    expect(consumed.filter((value) => value !== null)).toHaveLength(1);
    expect(consumed.find((value) => value !== null)).toEqual(record);
    expect(await ticketStore.consume(record.tokenDigest)).toBeNull();

    for (const [digest, actor] of [
      [
        hash("6"),
        { kind: "human" as const, subjectId: "user:ticket-test", replicaId: "234567890abcdef1" },
      ],
      [
        hash("5"),
        {
          kind: "service" as const,
          subjectId: "service:ticket-test",
          replicaId: "34567890abcdef12",
          service: "api_key",
        },
      ],
    ] as const) {
      const authorityRecord = { ...record, tokenDigest: digest, actor };
      await ticketStore.put(authorityRecord);
      expect(await ticketPeerStore.consume(digest)).toEqual(authorityRecord);
    }

    const farFutureIssuedAt = new Date(Date.now() + 5 * 60_000);
    await expect(
      ticketStore.put({
        ...record,
        tokenDigest: hash("4"),
        issuedAt: farFutureIssuedAt.toISOString(),
        expiresAt: new Date(farFutureIssuedAt.getTime() + 30_000).toISOString(),
      }),
    ).rejects.toThrow();
    const [futureTicket] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from editable_artifact_live_tickets
      where token_digest = ${hash("4")}`;
    expect(futureTicket?.count).toBe(0);

    await shared.admin`
      insert into editable_artifact_live_tickets (
        token_digest, account_id, workspace_id, artifact_id, modality,
        actor_kind, actor_subject_id, replica_id, allow_edit, protocol_version,
        issued_at, expires_at
      ) values (
        ${hash("3")}, ${accountId}, ${workspaceId}, ${artifactId}, 'document',
        'human', 'user:expired-ticket', '4567890abcdef123', true, 1,
        now() - interval '2 seconds', now() - interval '1 second'
      )`;
    expect(await ticketStore.consume(hash("3"))).toBeNull();
    const [remaining] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from editable_artifact_live_tickets
      where token_digest = ${hash("3")}`;
    expect(remaining?.count).toBe(0);

    await shared.admin`
      insert into editable_artifact_live_tickets (
        token_digest, account_id, workspace_id, artifact_id, modality,
        actor_kind, actor_subject_id, replica_id, allow_edit, protocol_version,
        issued_at, expires_at
      ) values (
        ${hash("2")}, ${accountId}, ${workspaceId}, ${artifactId}, 'document',
        'human', 'user:expired-cleanup', '567890abcdef1234', true, 1,
        now() - interval '2 seconds', now() - interval '1 second'
      )`;
    expect(await ticketStore.cleanupExpired(1)).toBe(1);
  }, 60_000);

  test("isolates tenant rows, serializes commits, and preserves exact idempotency", async () => {
    if (!available) return;
    const scope = { accountId, workspaceId };
    const artifactId = nextId();
    const create = creationFixture({
      scope,
      artifactId,
      receiptId: nextId(),
      authorityKey: JSON.stringify(["human", "user:alice"]),
      idempotencyKey: `create:${artifactId}`,
      requestHash: hash("a"),
      modality: "spreadsheet",
      title: "Collaborative workbook",
      stateHash: hash("0"),
      authorizationRevision: 1,
      createdBySubjectId: "user:alice",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const createdResult = await store.createArtifact(create);
    if (createdResult.kind !== "result") throw new Error("fresh authorization unexpectedly stale");
    const created = createdResult.value;
    expect(created.artifact.headSequence).toBe(0);
    expect(created.artifact.currentSnapshotId).toBe(create.genesisSnapshot.snapshotId);
    expect(created.genesisSnapshot).toEqual(create.genesisSnapshot);
    expect(created.creationReceipt).toMatchObject({
      receiptId: create.receiptId,
      artifactId,
      genesisSnapshotId: create.genesisSnapshot.snapshotId,
    });
    expect(created.replayed).toBe(false);
    const replayedCreateResult = await store.createArtifact({
      ...create,
      receiptId: nextId(),
    });
    if (replayedCreateResult.kind !== "result") throw new Error("idempotent replay was fenced");
    const replayedCreate = replayedCreateResult.value;
    expect(replayedCreate.artifact.id).toBe(artifactId);
    expect(replayedCreate.replayed).toBe(true);
    expect(replayedCreate.creationReceipt).toEqual(created.creationReceipt);
    await expect(
      store.createArtifact({
        ...create,
        receiptId: nextId(),
        requestHash: hash("b"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const concurrentArtifactId = nextId();
    const concurrentCreate = creationFixture({
      scope,
      artifactId: concurrentArtifactId,
      receiptId: nextId(),
      authorityKey: JSON.stringify(["human", "user:alice"]),
      idempotencyKey: `create:${concurrentArtifactId}`,
      requestHash: hash("c"),
      modality: "document" as const,
      title: "Concurrent create",
      stateHash: hash("d"),
      authorizationRevision: 1,
      createdBySubjectId: "user:alice",
    });
    const [concurrentLeft, concurrentRight] = await Promise.all([
      store.createArtifact({ ...concurrentCreate, receiptId: nextId() }),
      store.createArtifact({ ...concurrentCreate, receiptId: nextId() }),
    ]);
    expect(concurrentLeft.kind).toBe("result");
    expect(concurrentRight.kind).toBe("result");
    if (concurrentLeft.kind !== "result" || concurrentRight.kind !== "result") {
      throw new Error("concurrent create authorization unexpectedly stale");
    }
    expect(concurrentLeft.value.artifact.id).toBe(concurrentRight.value.artifact.id);
    expect(
      await store.getArtifact(
        { accountId: otherAccountId, workspaceId: otherWorkspaceId },
        artifactId,
      ),
    ).toBeNull();

    const sameClient = "client-same-1";
    const sameHash = hash("1");
    const [left, right] = await Promise.all([
      applyTransaction({
        artifactId,
        clientTransactionId: sameClient,
        requestHash: sameHash,
        replicaId: "1111111111111111",
        stateHash: hash("2"),
      }),
      applyTransaction({
        artifactId,
        clientTransactionId: sameClient,
        requestHash: sameHash,
        replicaId: "1111111111111111",
        stateHash: hash("2"),
      }),
    ]);
    expect(left.serverTransactionId).toBe(right.serverTransactionId);
    expect((await store.getArtifact(scope, artifactId))?.headSequence).toBe(1);

    await expect(
      applyTransaction({
        artifactId,
        clientTransactionId: sameClient,
        requestHash: hash("3"),
        replicaId: "1111111111111111",
        stateHash: hash("4"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await Promise.all([
      applyTransaction({
        artifactId,
        clientTransactionId: "parallel-a",
        requestHash: hash("5"),
        replicaId: "2222222222222222",
        stateHash: hash("6"),
      }),
      applyTransaction({
        artifactId,
        clientTransactionId: "parallel-b",
        requestHash: hash("7"),
        replicaId: "3333333333333333",
        stateHash: hash("8"),
      }),
    ]);
    const afterParallel = await store.getArtifact(scope, artifactId);
    if (!afterParallel) throw new Error("parallel artifact disappeared");
    const afterParallelSpreadsheet = spreadsheetArtifact(afterParallel);
    expect(afterParallelSpreadsheet.headSequence).toBe(3);
    expect(afterParallelSpreadsheet.causalFrontier).toEqual([
      { replicaId: "1111111111111111", counter: 1 },
      { replicaId: "2222222222222222", counter: 1 },
      { replicaId: "3333333333333333", counter: 1 },
    ]);

    await applyTransaction({
      artifactId,
      clientTransactionId: "same-replica-next",
      previousLocalTransactionId: sameClient,
      requestHash: hash("9"),
      replicaId: "1111111111111111",
      stateHash: hash("a"),
    });
    expect((await store.getArtifact(scope, artifactId))?.headSequence).toBe(4);
    const kernelState = await readKernelState(scope, artifactId, "inspect-whole-transaction-tail");
    expect(kernelState.committedTransactionTail).toHaveLength(4);
    expect(kernelState.committedTransactionTail.at(-1)?.priorStateHash).toBe(
      afterParallelSpreadsheet.stateHash,
    );

    await applyTransaction({
      artifactId,
      clientTransactionId: "causal-observer",
      requestHash: hash("b"),
      replicaId: "7777777777777777",
      stateHash: hash("c"),
    });
    const transitive = await applyTransaction({
      artifactId,
      clientTransactionId: "same-replica-transitive",
      previousLocalTransactionId: "same-replica-next",
      causalBase: [{ replicaId: "1111111111111111", counter: 2 }],
      requestHash: hash("d"),
      replicaId: "1111111111111111",
      stateHash: hash("e"),
    });
    expect(transitive.resolvedCausalBase).toEqual([
      { replicaId: "1111111111111111", counter: 2 },
      { replicaId: "2222222222222222", counter: 1 },
      { replicaId: "3333333333333333", counter: 1 },
    ]);
    expect((await store.getArtifact(scope, artifactId))?.headSequence).toBe(6);
  }, 30_000);

  test.each(["document", "presentation"] as const)(
    "persists exact serialized %s commits without spreadsheet projections",
    async (modality) => {
      if (!available || !shared) return;
      const scope = { accountId, workspaceId };
      const actorKey = JSON.stringify(["human", "user:alice"]);
      const artifactId = nextId();
      const initialStateHash = hash(modality === "document" ? "1" : "2");
      const nextStateHash = hash(modality === "document" ? "3" : "4");
      const genesisBytes = new TextEncoder().encode(`native-${modality}-genesis`);
      const created = await store.createArtifact(
        creationFixture({
          scope,
          artifactId,
          receiptId: nextId(),
          authorityKey: actorKey,
          idempotencyKey: `create:${artifactId}`,
          requestHash: hash(modality === "document" ? "5" : "6"),
          modality,
          title: `${modality} native authority`,
          stateHash: initialStateHash,
          authorizationRevision: 1,
          createdBySubjectId: "user:alice",
          snapshotBytes: genesisBytes,
        }),
      );
      if (created.kind !== "result") throw new Error("serialized create unexpectedly stale");
      if (created.value.artifact.modality !== modality) {
        throw new Error("serialized create returned the wrong modality");
      }

      const clientTransactionId = `${modality}.pg.1`;
      const basis = await store.readTransactionBasis(scope, artifactId, {
        actorKey,
        clientTransactionId,
        previousLocalTransactionId: null,
        selectiveUndoOperationIds: [],
      });
      if (
        basis.kind !== "basis" ||
        basis.kernelState.modality !== modality ||
        basis.artifact.modality !== modality
      ) {
        throw new Error("serialized transaction did not receive a native basis");
      }
      expect(basis.kernelState).toMatchObject({ baseNativeRevision: 0 });
      expect("causalFrontier" in basis.artifact).toBe(false);

      const fixture = serializedTransactionFixture({
        artifact: basis.artifact,
        modality,
        transactionId: nextId(),
        receiptId: nextId(),
        outboxId: nextId(),
        clientTransactionId,
        stateHash: nextStateHash,
        priorNativeRevision: 0,
        nativeRevision: 1,
      });
      const committed = await store.tryCommitAppliedTransaction({
        scope,
        artifactId,
        expectedLifecycle: "active",
        expectedAuthorizationRevision: basis.artifact.authorizationRevision,
        authorizationActor: humanAuthorizationActor(),
        actorKey,
        clientTransactionId,
        requestHash: fixture.commit.receipt.requestHash,
        expectedPredecessor: null,
        expectedUnclaimedUndoTargets: [],
        ...fixture.commit,
      });
      expect(committed.kind).toBe("committed");
      if (committed.kind === "stale" || committed.receipt.modality !== modality) {
        throw new Error("serialized commit unexpectedly stale or changed modality");
      }
      expect(committed.receipt).toMatchObject({
        sequenceStart: 1,
        sequenceEnd: 1,
        priorNativeRevision: 0,
        nativeRevision: 1,
        commandCount: 1,
      });

      const liveRead = new PostgresEditableArtifactLiveReadStore(client!.db, {
        snapshotBytes: {
          async readSnapshotBytes(snapshot) {
            expect(snapshot.snapshotId).toBe(created.value.genesisSnapshot.snapshotId);
            return genesisBytes.slice();
          },
        },
      });
      const bootstrap = await liveRead.readBootstrap({
        scope,
        artifactId,
        protocolVersion: 1,
        resume: {
          modality,
          localCursor: null,
          localStateHash: null,
          localNativeRevision: null,
          requireSnapshot: false,
        },
      });
      expect(bootstrap).toMatchObject({
        modality,
        headSequence: 1,
        stateHash: nextStateHash,
        nativeRevision: 1,
        minimumReplaySequence: 1,
        resumeAccepted: false,
        resumeSequence: 0,
        resumeStateHash: initialStateHash,
        snapshot: {
          modality,
          artifactId,
          sequence: 0,
          stateHash: initialStateHash,
          nativeRevision: 0,
        },
      });
      expect(bootstrap.snapshot?.bytes).toEqual(genesisBytes);
      expect(await liveRead.readHead(scope, artifactId)).toEqual({
        modality,
        headSequence: 1,
        stateHash: nextStateHash,
        nativeRevision: 1,
        minimumReplaySequence: 1,
      });
      const page = await liveRead.readTransactions({
        scope,
        artifactId,
        after: 0,
        through: 1,
        maxCount: 8,
        maxBytes: 1024 * 1024,
      });
      expect(page.transactions).toHaveLength(1);
      expect(page.transactions[0]).toEqual({
        modality,
        artifactId,
        transactionId: fixture.commit.serverTransactionId,
        requestHash: fixture.commit.receipt.requestHash,
        startSequence: 1,
        endSequence: 1,
        priorStateHash: initialStateHash,
        stateHash: nextStateHash,
        priorNativeRevision: 0,
        nativeRevision: 1,
        commitProtocolVersion: 1,
        committedTransactionBytes: fixture.commit.committedTransaction.committedTransactionBytes,
      });
      expect(
        await liveRead.readTransactions({
          scope,
          artifactId,
          after: 0,
          through: 1,
          maxCount: 8,
          maxBytes: fixture.commit.committedTransaction.committedTransactionBytes.byteLength - 1,
        }),
      ).toMatchObject({ transactions: [] });
      expect(
        await liveRead.readCommittedTransaction({
          scope,
          artifactId,
          transactionId: fixture.commit.serverTransactionId,
        }),
      ).toEqual(page.transactions[0]!);
      const resumed = await liveRead.readBootstrap({
        scope,
        artifactId,
        protocolVersion: 1,
        resume: {
          modality,
          localCursor: 1,
          localStateHash: nextStateHash,
          localNativeRevision: 1,
          requireSnapshot: false,
        },
      });
      expect(resumed).toMatchObject({
        modality,
        resumeAccepted: true,
        resumeSequence: 1,
        resumeStateHash: nextStateHash,
        snapshot: null,
      });
      await expect(
        liveRead.readBootstrap({
          scope,
          artifactId,
          protocolVersion: 1,
          resume: {
            localCursor: null,
            localStateHash: null,
            localCausalFrontier: [],
            requireSnapshot: false,
          },
        }),
      ).rejects.toThrow("modality differs");
      const liveReplicaId = modality === "document" ? "dddddddddddddddd" : "eeeeeeeeeeeeeeee";
      await liveRead.acknowledgeReplica({
        scope,
        artifactId,
        replicaId: liveReplicaId,
        actorKey,
        streamEpoch: `epoch-${modality}`,
        sequence: 1,
        stateHash: nextStateHash,
      });
      const [lease] = await shared.admin<
        Array<{
          modality: string;
          sequence: number;
          causalFrontier: unknown | null;
          nativeRevision: number | null;
          actorKey: string;
        }>
      >`
        select modality, applied_head_sequence::int as sequence,
          causal_frontier as "causalFrontier", native_revision::int as "nativeRevision",
          actor_key as "actorKey"
        from editable_artifact_replica_leases
        where artifact_id = ${artifactId} and replica_id = ${liveReplicaId}`;
      expect(lease).toEqual({
        modality,
        sequence: 1,
        causalFrontier: null,
        nativeRevision: 1,
        actorKey,
      });
      await expect(
        liveRead.acknowledgeReplica({
          scope,
          artifactId,
          replicaId: liveReplicaId,
          actorKey: JSON.stringify(["human", "user:mallory"]),
          streamEpoch: `epoch-${modality}-other`,
          sequence: 1,
          stateHash: nextStateHash,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await shared.admin`
        update editable_artifact_replica_leases
        set revoked_at = clock_timestamp()
        where artifact_id = ${artifactId} and replica_id = ${liveReplicaId}`;
      await expect(
        liveRead.acknowledgeReplica({
          scope,
          artifactId,
          replicaId: liveReplicaId,
          actorKey,
          streamEpoch: `epoch-${modality}-revoked`,
          sequence: 1,
          stateHash: nextStateHash,
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      const replay = await store.readTransactionBasis(scope, artifactId, {
        actorKey,
        clientTransactionId,
        previousLocalTransactionId: null,
        selectiveUndoOperationIds: [],
      });
      if (replay.kind !== "existing" || replay.receipt.modality !== modality) {
        throw new Error("serialized durable receipt did not replay");
      }
      expect(replay.receipt.intentBytes).toEqual(fixture.commit.receipt.intentBytes);

      const inspect = await store.readTransactionBasis(scope, artifactId, {
        actorKey,
        clientTransactionId: `${modality}.inspect`,
        previousLocalTransactionId: null,
        selectiveUndoOperationIds: [],
      });
      if (inspect.kind !== "basis" || inspect.kernelState.modality !== modality) {
        throw new Error("serialized kernel state did not hydrate");
      }
      expect(inspect.kernelState.committedTransactionTail).toHaveLength(1);
      expect(inspect.kernelState.committedTransactionTail[0]?.committedTransactionBytes).toEqual(
        fixture.commit.committedTransaction.committedTransactionBytes,
      );
      expect(inspect.kernelState.committedTransactionTail[0]?.nativeReceiptBytes).toEqual(
        fixture.commit.committedTransaction.nativeReceiptBytes,
      );
      expect(inspect.artifact).toMatchObject({
        headSequence: 1,
        stateHash: nextStateHash,
      });

      const persisted = await shared.admin<
        Array<{
          operationCount: number | null;
          operationIds: unknown | null;
          causalBase: unknown | null;
          nativeRevision: number;
          operations: number;
          checkpointNativeRevision: number;
        }>
      >`
        select transaction.operation_count as "operationCount",
          transaction.operation_ids as "operationIds",
          transaction.causal_base as "causalBase",
          transaction.native_revision::int as "nativeRevision",
          (select count(*)::int from editable_artifact_operations operation
            where operation.transaction_id = transaction.id) as operations,
          checkpoint.native_revision::int as "checkpointNativeRevision"
        from editable_artifact_transactions transaction
        join editable_artifact_sequence_checkpoints checkpoint
          on checkpoint.account_id = transaction.account_id
          and checkpoint.workspace_id = transaction.workspace_id
          and checkpoint.artifact_id = transaction.artifact_id
          and checkpoint.transaction_id = transaction.id
        where transaction.id = ${fixture.commit.serverTransactionId}`;
      expect(persisted[0]).toEqual({
        operationCount: null,
        operationIds: null,
        causalBase: null,
        nativeRevision: 1,
        operations: 0,
        checkpointNativeRevision: 1,
      });

      const snapshotId = nextId();
      const publishedAt = new Date().toISOString();
      await store.withSnapshotPublicationLock(scope, artifactId, async (unit) => {
        await unit.commitSnapshot({
          expectedCurrentSnapshotId: created.value.genesisSnapshot.snapshotId,
          expectedAuthorizationRevision: unit.artifact().authorizationRevision,
          authorizationActor: humanAuthorizationActor(),
          snapshot: {
            scope,
            artifactId,
            modality,
            snapshotId,
            blobReference: `editable-artifacts/${artifactId}/${snapshotId}`,
            byteSize: 4_096,
            contentHash: hash("7"),
            mimeType: "application/vnd.opengeni.editable-artifact-snapshot",
            coveredHeadSequence: 1,
            nativeRevision: 1,
            stateHash: nextStateHash,
            modelSchemaVersion: 1,
            kernelVersion: "test-kernel-1",
            verifiedAt: publishedAt,
            publishedAt,
          },
          outbox: {
            outboxId: nextId(),
            event: {
              kind: "snapshot_published",
              schemaVersion: 1,
              scope,
              artifactId,
              modality,
              snapshotId,
              coveredHeadSequence: 1,
              stateHash: nextStateHash,
              publishedAt,
            },
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
        });
      });
      const afterSnapshot = await store.readTransactionBasis(scope, artifactId, {
        actorKey,
        clientTransactionId: `${modality}.after-snapshot`,
        previousLocalTransactionId: null,
        selectiveUndoOperationIds: [],
      });
      if (afterSnapshot.kind !== "basis" || afterSnapshot.kernelState.modality !== modality) {
        throw new Error("serialized snapshot did not hydrate");
      }
      expect(afterSnapshot.kernelState).toMatchObject({
        baseNativeRevision: 1,
        committedTransactionTail: [],
      });
    },
    30_000,
  );

  test("reads and ACKs legacy spreadsheet live history without changing OGACO semantics", async () => {
    if (!available || !shared || !client) return;
    const scope = { accountId, workspaceId };
    const actorKey = JSON.stringify(["human", "user:alice"]);
    const artifactId = nextId();
    const initialStateHash = hash("1");
    const nextStateHash = hash("2");
    const genesisBytes = new TextEncoder().encode("spreadsheet-genesis");
    const created = await store.createArtifact(
      creationFixture({
        scope,
        artifactId,
        receiptId: nextId(),
        authorityKey: actorKey,
        idempotencyKey: `create:${artifactId}`,
        requestHash: hash("3"),
        modality: "spreadsheet",
        title: "Live workbook",
        stateHash: initialStateHash,
        authorizationRevision: 1,
        createdBySubjectId: "user:alice",
        snapshotBytes: genesisBytes,
      }),
    );
    if (created.kind !== "result") throw new Error("live spreadsheet create was fenced");
    const receipt = await applyTransaction({
      artifactId,
      clientTransactionId: "live-spreadsheet-1",
      requestHash: "live-spreadsheet-request",
      replicaId: "aaaaaaaaaaaaaaaa",
      stateHash: nextStateHash,
    });
    const liveRead = new PostgresEditableArtifactLiveReadStore(client.db, {
      snapshotBytes: {
        async readSnapshotBytes(snapshot) {
          expect(snapshot.snapshotId).toBe(created.value.genesisSnapshot.snapshotId);
          return genesisBytes.slice();
        },
      },
    });
    const bootstrap = await liveRead.readBootstrap({
      scope,
      artifactId,
      protocolVersion: 1,
      resume: {
        localCursor: null,
        localStateHash: null,
        localCausalFrontier: [],
        requireSnapshot: false,
      },
    });
    expect(bootstrap).toMatchObject({
      modality: "spreadsheet",
      headSequence: 1,
      stateHash: nextStateHash,
      causalFrontier: receipt.resultingCausalFrontier,
      minimumReplaySequence: 1,
      resumeAccepted: false,
      resumeSequence: 0,
      snapshot: {
        modality: "spreadsheet",
        sequence: 0,
        causalFrontier: [],
      },
    });
    const page = await liveRead.readTransactions({
      scope,
      artifactId,
      after: 0,
      through: 1,
      maxCount: 8,
      maxBytes: 1024 * 1024,
    });
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0]).toMatchObject({
      modality: "spreadsheet",
      artifactId,
      transactionId: receipt.serverTransactionId,
      requestHash: receipt.requestHash,
      startSequence: 1,
      endSequence: 1,
      priorStateHash: initialStateHash,
      stateHash: nextStateHash,
      causalFrontier: receipt.resultingCausalFrontier,
      operationProtocolVersion: 1,
    });
    expect("nativeRevision" in page.transactions[0]!).toBe(false);
    expect(
      await liveRead.readBootstrap({
        scope,
        artifactId,
        protocolVersion: 1,
        resume: {
          localCursor: 1,
          localStateHash: nextStateHash,
          localCausalFrontier: receipt.resultingCausalFrontier,
          requireSnapshot: false,
        },
      }),
    ).toMatchObject({ resumeAccepted: true, snapshot: null });
    const liveReplicaId = "ffffffffffffffff";
    await liveRead.acknowledgeReplica({
      scope,
      artifactId,
      replicaId: liveReplicaId,
      actorKey,
      streamEpoch: "spreadsheet-live-epoch",
      sequence: 1,
      stateHash: nextStateHash,
    });
    const [lease] = await shared.admin<
      Array<{
        modality: string;
        sequence: number;
        causalFrontier: unknown | null;
        nativeRevision: number | null;
      }>
    >`
      select modality, applied_head_sequence::int as sequence,
        causal_frontier as "causalFrontier", native_revision::int as "nativeRevision"
      from editable_artifact_replica_leases
      where artifact_id = ${artifactId} and replica_id = ${liveReplicaId}`;
    expect(lease).toEqual({
      modality: "spreadsheet",
      sequence: 1,
      causalFrontier: receipt.resultingCausalFrontier,
      nativeRevision: null,
    });
    const corruptSnapshotReader = new PostgresEditableArtifactLiveReadStore(client.db, {
      snapshotBytes: {
        async readSnapshotBytes() {
          return new Uint8Array(genesisBytes.byteLength);
        },
      },
    });
    await expect(
      corruptSnapshotReader.readBootstrap({
        scope,
        artifactId,
        protocolVersion: 1,
        resume: {
          localCursor: null,
          localStateHash: null,
          localCausalFrontier: [],
          requireSnapshot: true,
        },
      }),
    ).rejects.toMatchObject({ code: "corrupt_history" });
  }, 30_000);

  test("rolls back staged history and prevents sequence gaps and history mutation", async () => {
    if (!available || !shared) return;
    const scope = { accountId, workspaceId };
    const artifactId = nextId();
    const duplicateReceiptId = nextId();
    await store.createArtifact(
      creationFixture({
        scope,
        artifactId,
        receiptId: duplicateReceiptId,
        authorityKey: JSON.stringify(["human", "user:alice"]),
        idempotencyKey: `create:${artifactId}`,
        requestHash: hash("b"),
        modality: "spreadsheet",
        title: "Rollback document",
        stateHash: hash("9"),
        authorizationRevision: 1,
        createdBySubjectId: "user:alice",
      }),
    );
    const actorKey = JSON.stringify(["human", "user:alice"]);
    const basis = await store.readTransactionBasis(scope, artifactId, {
      actorKey,
      clientTransactionId: "rollback-1",
      previousLocalTransactionId: null,
      selectiveUndoOperationIds: [],
    });
    if (basis.kind !== "basis") throw new Error("unexpected existing rollback receipt");
    const fixture = transactionFixture({
      artifact: spreadsheetArtifact(basis.artifact),
      transactionId: nextId(),
      receiptId: duplicateReceiptId,
      operationId: nextId(),
      outboxId: nextId(),
      clientTransactionId: "rollback-1",
      requestHash: hash("a"),
      replicaId: "4444444444444444",
      stateHash: hash("b"),
    });
    await expect(
      store.tryCommitAppliedTransaction({
        scope,
        artifactId,
        expectedLifecycle: "active",
        expectedAuthorizationRevision: basis.artifact.authorizationRevision,
        authorizationActor: humanAuthorizationActor(),
        actorKey,
        clientTransactionId: "rollback-1",
        requestHash: fixture.commit.receipt.requestHash,
        expectedPredecessor: null,
        expectedUnclaimedUndoTargets: [],
        ...fixture.commit,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await store.getArtifact(scope, artifactId))?.headSequence).toBe(0);
    const rolledBack = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from editable_artifact_transactions
      where artifact_id = ${artifactId}`;
    expect(rolledBack[0]?.count).toBe(0);

    const committed = await applyTransaction({
      artifactId,
      clientTransactionId: "immutable-1",
      requestHash: hash("c"),
      replicaId: "4444444444444444",
      stateHash: hash("d"),
    });
    await expectSqlFailure(
      shared.admin`update editable_artifact_transactions
        set actor_key = '["human","mallory"]'
        where id = ${committed.serverTransactionId}`,
      "immutable",
    );
    await expectSqlFailure(
      shared.admin`delete from editable_artifact_operations
        where transaction_id = ${committed.serverTransactionId}`,
      "immutable",
    );
    await expectSqlFailure(
      shared.admin`update editable_artifacts set head_sequence = head_sequence + 2
        where id = ${artifactId}`,
      "checkpoint",
    );
  }, 30_000);

  test("returns detached undo bases and atomically replays the short optimistic commit", async () => {
    if (!available) return;
    const scope = { accountId, workspaceId };
    const artifactId = nextId();
    await store.createArtifact(
      creationFixture({
        scope,
        artifactId,
        receiptId: nextId(),
        authorityKey: JSON.stringify(["human", "user:alice"]),
        idempotencyKey: `create:${artifactId}`,
        requestHash: hash("4"),
        modality: "spreadsheet",
        title: "Optimistic undo document",
        stateHash: hash("5"),
        authorizationRevision: 1,
        createdBySubjectId: "user:alice",
      }),
    );
    await applyTransaction({
      artifactId,
      clientTransactionId: "undo-source",
      requestHash: hash("6"),
      replicaId: "9999999999999999",
      stateHash: hash("7"),
    });
    const actorKey = JSON.stringify(["human", "user:alice"]);
    const source = await readKernelState(scope, artifactId, "inspect-undo-source");
    const targetOperationId = source.committedTransactionTail[0]!.operationIds[0]!;
    const basis = await store.readTransactionBasis(scope, artifactId, {
      actorKey,
      clientTransactionId: "undo-commit",
      previousLocalTransactionId: null,
      selectiveUndoOperationIds: [targetOperationId],
    });
    if (basis.kind !== "basis") throw new Error("unexpected optimistic replay basis");
    expect(basis.undoTargets[0]).toMatchObject({
      operationId: targetOperationId,
      claimedBy: null,
    });
    expect(Object.isFrozen(basis.undoTargets[0]!.operation)).toBe(true);
    const detachedReplay = await store.readTransactionBasis(scope, artifactId, {
      actorKey,
      clientTransactionId: "undo-commit",
      previousLocalTransactionId: null,
      selectiveUndoOperationIds: [targetOperationId],
    });
    if (detachedReplay.kind !== "basis") throw new Error("unexpected optimistic replay basis");
    expect(detachedReplay.undoTargets[0]!.operation!.operationId).toBe(targetOperationId);

    const fixture = transactionFixture({
      artifact: spreadsheetArtifact(detachedReplay.artifact),
      transactionId: nextId(),
      receiptId: nextId(),
      operationId: nextId(),
      outboxId: nextId(),
      clientTransactionId: "undo-commit",
      causalBase: spreadsheetArtifact(detachedReplay.artifact).causalFrontier,
      selectiveUndoOperationIds: [targetOperationId],
      requestHash: hash("8"),
      replicaId: "aaaaaaaaaaaaaaaa",
      stateHash: hash("9"),
    });
    const commitRequest = {
      scope,
      artifactId,
      expectedLifecycle: "active" as const,
      expectedAuthorizationRevision: detachedReplay.artifact.authorizationRevision,
      authorizationActor: humanAuthorizationActor(),
      actorKey,
      clientTransactionId: "undo-commit",
      requestHash: fixture.commit.receipt.requestHash,
      expectedPredecessor: null,
      expectedUnclaimedUndoTargets: [targetOperationId],
      ...fixture.commit,
    };
    const intendedCommittedByte =
      fixture.commit.committedTransaction.committedTransactionBytes[24]!;
    const intendedIntentByte = fixture.commit.receipt.intentBytes[8]!;
    const commitPromise = store.tryCommitAppliedTransaction(commitRequest);
    fixture.commit.committedTransaction.committedTransactionBytes[24] =
      intendedCommittedByte ^ 0xff;
    fixture.commit.receipt.intentBytes[8] = intendedIntentByte ^ 0xff;
    expect((await commitPromise).kind).toBe("committed");
    fixture.commit.committedTransaction.committedTransactionBytes[24] = intendedCommittedByte;
    fixture.commit.receipt.intentBytes[8] = intendedIntentByte;
    expect((await store.tryCommitAppliedTransaction(commitRequest)).kind).toBe("replayed");
    const persisted = await store.readTransactionBasis(scope, artifactId, {
      actorKey,
      clientTransactionId: "undo-commit",
      previousLocalTransactionId: null,
      selectiveUndoOperationIds: [],
    });
    if (persisted.kind !== "existing") throw new Error("missing committed receipt replay");
    expect(persisted.receipt.intentBytes[8]).toBe(intendedIntentByte);
    const committedKernel = await readKernelState(scope, artifactId, "inspect-owned-commit");
    expect(committedKernel.committedTransactionTail.at(-1)?.committedTransactionBytes[24]).toBe(
      intendedCommittedByte,
    );
    const claimed = await store.readTransactionBasis(scope, artifactId, {
      actorKey,
      clientTransactionId: "after-undo",
      previousLocalTransactionId: null,
      selectiveUndoOperationIds: [targetOperationId],
    });
    if (claimed.kind !== "basis") throw new Error("unexpected optimistic replay basis");
    expect(claimed.undoTargets[0]?.claimedBy).toBe(fixture.commit.serverTransactionId);
  }, 30_000);

  test("recovers expired outbox leases and fences stale publishers", async () => {
    if (!available) return;
    const scope = { accountId, workspaceId };
    const artifactId = nextId();
    await store.createArtifact(
      creationFixture({
        scope,
        artifactId,
        receiptId: nextId(),
        authorityKey: JSON.stringify(["human", "user:alice"]),
        idempotencyKey: `create:${artifactId}`,
        requestHash: hash("c"),
        modality: "spreadsheet",
        title: "Outbox deck",
        stateHash: hash("e"),
        authorizationRevision: 1,
        createdBySubjectId: "user:alice",
      }),
    );
    const receipt = await applyTransaction({
      artifactId,
      clientTransactionId: "outbox-1",
      requestHash: hash("f"),
      replicaId: "5555555555555555",
      stateHash: hash("0"),
    });
    await expect(
      store.claimLiveOutbox({ owner: "forbidden-app", leaseDurationMs: 1_000, limit: 1 }),
    ).rejects.toThrow();
    const first = await outboxStore.claimLiveOutbox({
      owner: "publisher-a",
      leaseDurationMs: 1_000,
      limit: 100,
    });
    const target = first.find(
      (record) =>
        record.event.kind === "transaction_committed" &&
        record.event.serverTransactionId === receipt.serverTransactionId,
    );
    expect(target?.event.kind).toBe("transaction_committed");
    await shared!.admin`
      update editable_artifact_live_outbox
      set lease_expires_at = now() - interval '1 second'
      where id = ${target!.outboxId}`;
    const reclaimed = await outboxStore.claimLiveOutbox({
      owner: "publisher-a",
      leaseDurationMs: 1_000,
      limit: 100,
    });
    const reclaimedTarget = reclaimed.find((record) => record.outboxId === target?.outboxId);
    expect(reclaimedTarget?.outboxId).toBe(target?.outboxId);
    await expect(
      outboxStore.markLiveOutboxPublished({
        outboxId: target!.outboxId,
        owner: "publisher-a",
        attemptCount: target!.attemptCount,
      }),
    ).rejects.toMatchObject({ code: "outbox_lease_conflict" });
    await outboxStore.releaseLiveOutbox({
      outboxId: reclaimedTarget!.outboxId,
      owner: "publisher-a",
      attemptCount: reclaimedTarget!.attemptCount,
    });
    await outboxStore.releaseLiveOutbox({
      outboxId: reclaimedTarget!.outboxId,
      owner: "publisher-a",
      attemptCount: reclaimedTarget!.attemptCount,
    });
    const third = await outboxStore.claimLiveOutbox({
      owner: "publisher-c",
      leaseDurationMs: 1_000,
      limit: 100,
    });
    const thirdTarget = third.find((record) => record.outboxId === target?.outboxId);
    await expect(
      outboxStore.releaseLiveOutbox({
        outboxId: reclaimedTarget!.outboxId,
        owner: "publisher-a",
        attemptCount: reclaimedTarget!.attemptCount,
      }),
    ).rejects.toMatchObject({ code: "outbox_lease_conflict" });
    await outboxStore.markLiveOutboxPublished({
      outboxId: thirdTarget!.outboxId,
      owner: "publisher-c",
      attemptCount: thirdTarget!.attemptCount,
    });
    await outboxStore.markLiveOutboxPublished({
      outboxId: thirdTarget!.outboxId,
      owner: "publisher-c",
      attemptCount: thirdTarget!.attemptCount,
    });
    await outboxStore.releaseLiveOutbox({
      outboxId: thirdTarget!.outboxId,
      owner: "publisher-c",
      attemptCount: thirdTarget!.attemptCount,
    });
    await expect(
      outboxStore.markLiveOutboxPublished({
        outboxId: thirdTarget!.outboxId,
        owner: "publisher-a",
        attemptCount: reclaimedTarget!.attemptCount,
      }),
    ).rejects.toMatchObject({ code: "outbox_lease_conflict" });
  }, 30_000);

  test("dead-letters an exhausted outbox lease without starving healthy work", async () => {
    if (!available || !shared) return;
    const scope = { accountId, workspaceId };
    const exhaustedArtifactId = nextId();
    const exhaustedCreate = creationFixture({
      scope,
      artifactId: exhaustedArtifactId,
      receiptId: nextId(),
      authorityKey: JSON.stringify(["human", "user:alice"]),
      idempotencyKey: `create:${exhaustedArtifactId}`,
      requestHash: hash("1"),
      modality: "spreadsheet",
      title: "Exhausted outbox",
      stateHash: hash("2"),
      authorizationRevision: 1,
      createdBySubjectId: "user:alice",
    });
    await store.createArtifact(exhaustedCreate);
    const claimed = await outboxStore.claimLiveOutbox({
      owner: "exhaustion-fixture",
      leaseDurationMs: 30_000,
      limit: 100,
    });
    const exhausted = claimed.find((record) => record.event.artifactId === exhaustedArtifactId);
    expect(exhausted).toBeDefined();
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update editable_artifact_live_outbox
        set attempt_count = 1000000, lease_expires_at = now() - interval '1 second'
        where id = ${exhausted!.outboxId}`;
    });

    const healthyArtifactId = nextId();
    await store.createArtifact(
      creationFixture({
        scope,
        artifactId: healthyArtifactId,
        receiptId: nextId(),
        authorityKey: JSON.stringify(["human", "user:alice"]),
        idempotencyKey: `create:${healthyArtifactId}`,
        requestHash: hash("3"),
        modality: "document",
        title: "Healthy outbox",
        stateHash: hash("4"),
        authorizationRevision: 1,
        createdBySubjectId: "user:alice",
      }),
    );
    const healthyClaims = await outboxStore.claimLiveOutbox({
      owner: "healthy-publisher",
      leaseDurationMs: 30_000,
      limit: 100,
    });
    expect(healthyClaims.some((record) => record.event.artifactId === healthyArtifactId)).toBe(
      true,
    );
    const [terminal] = await shared.admin<Array<{ state: string; errorCode: string }>>`
      select state, last_error_code as "errorCode"
      from editable_artifact_live_outbox where id = ${exhausted!.outboxId}`;
    expect(terminal).toEqual({ state: "dead_lettered", errorCode: "attempts_exhausted" });
  }, 30_000);

  test("fences a permission revocation that lands while the kernel is outside Postgres", async () => {
    if (!available || !shared) return;
    const scope = { accountId, workspaceId };
    const subjectId = "user:revoked-during-kernel";
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, permissions
      ) values (
        ${accountId}, ${workspaceId}, ${subjectId},
        '["artifacts:read","artifacts:publish"]'::jsonb
      )`;
    const artifactId = nextId();
    await store.createArtifact(
      creationFixture({
        scope,
        artifactId,
        receiptId: nextId(),
        authorityKey: JSON.stringify(["human", subjectId]),
        idempotencyKey: `create:${artifactId}`,
        requestHash: hash("a"),
        modality: "spreadsheet",
        title: "Authorization race workbook",
        stateHash: hash("b"),
        authorizationRevision: 1,
        createdBySubjectId: subjectId,
      }),
    );
    const actorKey = JSON.stringify(["human", subjectId]);
    const basis = await store.readTransactionBasis(scope, artifactId, {
      actorKey,
      clientTransactionId: "authorization-race",
      previousLocalTransactionId: null,
      selectiveUndoOperationIds: [],
    });
    if (basis.kind !== "basis") throw new Error("unexpected authorization race replay");
    const fixture = transactionFixture({
      artifact: spreadsheetArtifact(basis.artifact),
      transactionId: nextId(),
      receiptId: nextId(),
      operationId: nextId(),
      outboxId: nextId(),
      clientTransactionId: "authorization-race",
      requestHash: hash("c"),
      replicaId: "bbbbbbbbbbbbbbbb",
      stateHash: hash("d"),
      actorKey,
    });

    await shared.admin`
      update workspace_memberships
      set permissions = '[]'::jsonb
      where account_id = ${accountId} and workspace_id = ${workspaceId}
        and subject_id = ${subjectId}`;
    const result = await store.tryCommitAppliedTransaction({
      scope,
      artifactId,
      expectedLifecycle: "active",
      expectedAuthorizationRevision: basis.artifact.authorizationRevision,
      authorizationActor: humanAuthorizationActor(subjectId),
      actorKey,
      clientTransactionId: fixture.commit.receipt.clientTransactionId,
      requestHash: fixture.commit.receipt.requestHash,
      expectedPredecessor: null,
      expectedUnclaimedUndoTargets: [],
      ...fixture.commit,
    });
    expect(result.kind).toBe("stale");
    expect(await store.getArtifact(scope, artifactId)).toMatchObject({
      authorizationRevision: 1,
      headSequence: 0,
    });
    const durableTransactions = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from editable_artifact_transactions
      where account_id = ${accountId} and workspace_id = ${workspaceId}
        and artifact_id = ${artifactId}`;
    expect(durableTransactions[0]?.count).toBe(0);
  }, 30_000);

  test("fences an API-key expiry that lands while the kernel is outside Postgres", async () => {
    if (!available || !shared) return;
    const scope = { accountId, workspaceId };
    const [key] = await shared.admin<{ id: string }[]>`
      insert into api_keys (
        account_id, workspace_id, name, prefix, key_hash, permissions, expires_at
      ) values (
        ${accountId}, ${workspaceId}, 'artifact expiry fence',
        ${`og_artifact_${nextId()}`}, ${hash("4")},
        '["artifacts:read","artifacts:publish"]'::jsonb,
        clock_timestamp() + interval '1 second'
      ) returning id`;
    const subjectId = `api_key:${key!.id}`;
    const actor = {
      kind: "service" as const,
      subjectId,
      replicaId: "dddddddddddddddd",
      service: "api_key",
    };
    const actorKey = JSON.stringify(["service", subjectId, "api_key"]);
    const artifactId = nextId();
    const creation = creationFixture({
      scope,
      artifactId,
      receiptId: nextId(),
      authorityKey: actorKey,
      idempotencyKey: `create:${artifactId}`,
      requestHash: hash("5"),
      modality: "spreadsheet",
      title: "Expiring API key workbook",
      stateHash: hash("6"),
      authorizationRevision: 1,
      createdBySubjectId: subjectId,
    });
    const created = await store.createArtifact({ ...creation, authorizationActor: actor });
    expect(created.kind).toBe("result");
    const basis = await store.readTransactionBasis(scope, artifactId, {
      actorKey,
      clientTransactionId: "api-key-expiry-race",
      previousLocalTransactionId: null,
      selectiveUndoOperationIds: [],
    });
    if (basis.kind !== "basis") throw new Error("unexpected API-key expiry replay");
    const fixture = transactionFixture({
      artifact: spreadsheetArtifact(basis.artifact),
      transactionId: nextId(),
      receiptId: nextId(),
      operationId: nextId(),
      outboxId: nextId(),
      clientTransactionId: "api-key-expiry-race",
      requestHash: hash("7"),
      replicaId: actor.replicaId,
      stateHash: hash("8"),
      actorKey,
    });

    await Bun.sleep(1_100);
    const result = await store.tryCommitAppliedTransaction({
      scope,
      artifactId,
      expectedLifecycle: "active",
      expectedAuthorizationRevision: basis.artifact.authorizationRevision,
      authorizationActor: actor,
      actorKey,
      clientTransactionId: fixture.commit.receipt.clientTransactionId,
      requestHash: fixture.commit.receipt.requestHash,
      expectedPredecessor: null,
      expectedUnclaimedUndoTargets: [],
      ...fixture.commit,
    });
    expect(result.kind).toBe("stale");
    expect(await store.getArtifact(scope, artifactId)).toMatchObject({
      authorizationRevision: 1,
      headSequence: 0,
    });
  }, 30_000);

  test("authorizes only the exact active agent attempt at the commit fence", async () => {
    if (!available || !shared || !client) return;
    const scope = { accountId, workspaceId };
    await shared.admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${workspaceId}) on conflict (workspace_id) do nothing`;
    const session = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "artifact attempt fence",
      resources: [],
      metadata: {},
      model: "gpt-5.6-sol",
      sandboxBackend: "none",
    });
    const attemptId = crypto.randomUUID();
    const [turn] = await shared.admin<{ id: string }[]>`
      insert into session_turns (
        account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, execution_generation,
        active_attempt_id, initiator_kind, initiator_subject_id
      ) values (
        ${accountId}, ${workspaceId}, ${session.id}, gen_random_uuid(),
        'artifact-agent-fence', 'running', 0, 'edit artifact', 'gpt-5.6-sol',
        'medium', 'none', 1, null, 'subject', 'user:alice'
      ) returning id`;
    await shared.admin`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id,
        execution_generation, state, temporal_workflow_id,
        temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${accountId}, ${workspaceId}, ${session.id}, ${turn!.id},
        1, 'running', 'artifact-agent-fence', ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
    await shared.admin`
      update session_turns set active_attempt_id = ${attemptId} where id = ${turn!.id}`;
    await shared.admin`
      update sessions set active_turn_id = ${turn!.id} where id = ${session.id}`;
    const actor = {
      kind: "agent" as const,
      subjectId: "worker:first-party-mcp",
      replicaId: "eeeeeeeeeeeeeeee",
      sessionId: session.id,
      turnId: turn!.id,
      attemptId,
      generation: 1,
    };
    const actorKey = JSON.stringify([
      "agent",
      actor.subjectId,
      actor.sessionId,
      actor.turnId,
      actor.attemptId,
      actor.generation,
    ]);
    const artifactId = nextId();
    const creation = creationFixture({
      scope,
      artifactId,
      receiptId: nextId(),
      authorityKey: actorKey,
      idempotencyKey: `create:${artifactId}`,
      requestHash: hash("a"),
      modality: "spreadsheet",
      title: "Attempt-fenced workbook",
      stateHash: hash("b"),
      authorizationRevision: 1,
      createdBySubjectId: actor.subjectId,
    });
    expect((await store.createArtifact({ ...creation, authorizationActor: actor })).kind).toBe(
      "result",
    );
    const basis = await store.readTransactionBasis(scope, artifactId, {
      actorKey,
      clientTransactionId: "agent-attempt-race",
      previousLocalTransactionId: null,
      selectiveUndoOperationIds: [],
    });
    if (basis.kind !== "basis") throw new Error("unexpected agent attempt replay");
    const fixture = transactionFixture({
      artifact: spreadsheetArtifact(basis.artifact),
      transactionId: nextId(),
      receiptId: nextId(),
      operationId: nextId(),
      outboxId: nextId(),
      clientTransactionId: "agent-attempt-race",
      requestHash: hash("c"),
      replicaId: actor.replicaId,
      stateHash: hash("d"),
      actorKey,
    });
    await shared.admin`
      update sessions set active_turn_id = null where id = ${session.id}`;
    const displaced = await store.tryCommitAppliedTransaction({
      scope,
      artifactId,
      expectedLifecycle: "active",
      expectedAuthorizationRevision: basis.artifact.authorizationRevision,
      authorizationActor: actor,
      actorKey,
      clientTransactionId: fixture.commit.receipt.clientTransactionId,
      requestHash: fixture.commit.receipt.requestHash,
      expectedPredecessor: null,
      expectedUnclaimedUndoTargets: [],
      ...fixture.commit,
    });
    expect(displaced.kind).toBe("stale");
    await shared.admin`
      update sessions set active_turn_id = ${turn!.id} where id = ${session.id}`;

    const [interruptionReceipt] = await shared.admin<{ id: string }[]>`
      insert into session_command_receipts (
        account_id, workspace_id, actor_type, actor_subject_id, action,
        target_session_id, target_turn_id, operation_key, canonical_request_hash
      ) values (
        ${accountId}, ${workspaceId}, 'human', 'artifact-attempt-test',
        'session.queue.steer', ${session.id}, ${turn!.id},
        ${crypto.randomUUID()}, 'artifact-attempt-interruption'
      ) returning id`;
    await shared.admin`
      insert into session_attempt_interruptions (
        account_id, workspace_id, session_id, operation_id, attempt_id,
        kind, control_revision
      ) values (
        ${accountId}, ${workspaceId}, ${session.id}, ${interruptionReceipt!.id},
        ${attemptId}, 'steer', 1
      )`;
    const interrupted = await store.tryCommitAppliedTransaction({
      scope,
      artifactId,
      expectedLifecycle: "active",
      expectedAuthorizationRevision: basis.artifact.authorizationRevision,
      authorizationActor: actor,
      actorKey,
      clientTransactionId: fixture.commit.receipt.clientTransactionId,
      requestHash: fixture.commit.receipt.requestHash,
      expectedPredecessor: null,
      expectedUnclaimedUndoTargets: [],
      ...fixture.commit,
    });
    expect(interrupted.kind).toBe("stale");
    await shared.admin`
      update session_attempt_interruptions
      set state = 'settled', settled_at = clock_timestamp()
      where attempt_id = ${attemptId}`;
    await shared.admin`
      update session_turn_attempts
      set state = 'closed', outcome = 'completed', closed_at = clock_timestamp(),
        quiesced_at = clock_timestamp()
      where id = ${attemptId}`;
    const closed = await store.tryCommitAppliedTransaction({
      scope,
      artifactId,
      expectedLifecycle: "active",
      expectedAuthorizationRevision: basis.artifact.authorizationRevision,
      authorizationActor: actor,
      actorKey,
      clientTransactionId: fixture.commit.receipt.clientTransactionId,
      requestHash: fixture.commit.receipt.requestHash,
      expectedPredecessor: null,
      expectedUnclaimedUndoTargets: [],
      ...fixture.commit,
    });
    expect(closed.kind).toBe("stale");
    expect((await store.getArtifact(scope, artifactId))?.headSequence).toBe(0);
  }, 30_000);

  test("publishes exact forward snapshots and bounds replay at their checkpoint", async () => {
    if (!available || !shared) return;
    const scope = { accountId, workspaceId };
    const artifactId = nextId();
    const created = await store.createArtifact(
      creationFixture({
        scope,
        artifactId,
        receiptId: nextId(),
        authorityKey: JSON.stringify(["human", "user:alice"]),
        idempotencyKey: `create:${artifactId}`,
        requestHash: hash("1"),
        modality: "spreadsheet",
        title: "Snapshot workbook",
        stateHash: hash("2"),
        authorizationRevision: 1,
        createdBySubjectId: "user:alice",
      }),
    );
    if (created.kind !== "result") throw new Error("snapshot fixture authorization stale");
    const receipt = await applyTransaction({
      artifactId,
      clientTransactionId: "snapshot-source",
      requestHash: hash("3"),
      replicaId: "6666666666666666",
      stateHash: hash("4"),
    });
    const compactionBasis = await store.readSnapshotCompactionBasis(scope, artifactId, 1);
    expect(compactionBasis.kind).toBe("basis");
    if (compactionBasis.kind !== "basis") throw new Error("compaction basis unavailable");
    expect(compactionBasis.state.tailTransactionCount).toBe(1);
    expect(compactionBasis.state.tailByteSize).toBeGreaterThan(0);
    expect(await store.readSnapshotCompactionBasis(scope, artifactId, 2)).toEqual({
      kind: "authorization_stale",
    });
    const snapshotId = nextId();
    const publishedAt = new Date().toISOString();
    const snapshot = {
      scope,
      artifactId,
      modality: "spreadsheet" as const,
      snapshotId,
      blobReference: `editable-artifacts/${artifactId}/${snapshotId}`,
      byteSize: 4_096,
      contentHash: hash("5"),
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot" as const,
      coveredHeadSequence: receipt.sequenceEnd,
      coveredCausalFrontier: receipt.resultingCausalFrontier,
      stateHash: receipt.stateHash,
      modelSchemaVersion: receipt.modelSchemaVersion,
      operationProtocolVersion: receipt.operationProtocolVersion,
      kernelVersion: receipt.kernelVersion,
      crdtStateVersion: 1,
      verifiedAt: publishedAt,
      publishedAt,
    };
    const snapshotOutbox = () => ({
      outboxId: nextId(),
      event: {
        kind: "snapshot_published" as const,
        schemaVersion: 1 as const,
        scope,
        artifactId,
        modality: "spreadsheet" as const,
        snapshotId,
        coveredHeadSequence: snapshot.coveredHeadSequence,
        stateHash: snapshot.stateHash,
        operationProtocolVersion: snapshot.operationProtocolVersion,
        publishedAt,
      },
      state: "pending" as const,
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: publishedAt,
      lastErrorCode: null,
      publishedAt: null,
      deadLetteredAt: null,
      createdAt: publishedAt,
    });
    await shared.admin`
      update workspace_memberships
      set permissions = '["artifacts:read"]'::jsonb
      where account_id = ${accountId} and workspace_id = ${workspaceId}
        and subject_id = 'user:alice'`;
    try {
      const denied = await store.withSnapshotPublicationLock(
        scope,
        artifactId,
        async (unit) =>
          await unit.commitSnapshot({
            expectedCurrentSnapshotId: created.value.genesisSnapshot.snapshotId,
            expectedAuthorizationRevision: unit.artifact().authorizationRevision,
            authorizationActor: humanAuthorizationActor(),
            snapshot,
            outbox: snapshotOutbox(),
          }),
      );
      expect(denied).toEqual({ kind: "authorization_stale" });
    } finally {
      await shared.admin`
        update workspace_memberships
        set permissions = '["artifacts:read","artifacts:publish"]'::jsonb
        where account_id = ${accountId} and workspace_id = ${workspaceId}
          and subject_id = 'user:alice'`;
    }
    let retainedUnit: PersistedEditableArtifactSnapshotPublicationUnitOfWork | null = null;
    await store.withSnapshotPublicationLock(scope, artifactId, async (unit) => {
      retainedUnit = unit;
      expect(Object.keys(unit).sort()).toEqual([
        "artifact",
        "checkpoint",
        "commitSnapshot",
        "findSnapshot",
      ]);
      expect(
        await unit.commitSnapshot({
          expectedCurrentSnapshotId: created.value.genesisSnapshot.snapshotId,
          expectedAuthorizationRevision: unit.artifact().authorizationRevision,
          authorizationActor: humanAuthorizationActor(),
          authorizationPermission: "read",
          snapshot,
          outbox: snapshotOutbox(),
        }),
      ).toEqual({ kind: "committed" });
    });
    expect(() => retainedUnit!.artifact()).toThrow("already closed");
    const kernel = await readKernelState(scope, artifactId, "inspect-snapshot-cutover");
    expect(kernel.snapshot?.snapshotId).toBe(snapshotId);
    expect(kernel.committedTransactionTail).toEqual([]);
    expect(kernel).toMatchObject({ tailTransactionCount: 0, tailByteSize: 0 });
    expect(kernel.artifact.currentSnapshotId).toBe(snapshotId);
  }, 30_000);

  test("commits the maximum operation cardinality in bounded statement batches", async () => {
    if (!available) return;
    const scope = { accountId, workspaceId };
    const artifactId = nextId();
    await store.createArtifact(
      creationFixture({
        scope,
        artifactId,
        receiptId: nextId(),
        authorityKey: JSON.stringify(["human", "user:alice"]),
        idempotencyKey: `create:${artifactId}`,
        requestHash: hash("6"),
        modality: "spreadsheet",
        title: "Maximum operation batch",
        stateHash: hash("7"),
        authorizationRevision: 1,
        createdBySubjectId: "user:alice",
      }),
    );
    const operationCount = 4_096;
    const transactionId = nextId();
    const committedAt = new Date().toISOString();
    const replicaId = "8888888888888888";
    const actorKey = JSON.stringify(["human", "user:alice"]);
    const stateHash = hash("8");
    const intent = intentOfSize(5 * 1024 * 1024);
    const resultingCausalFrontier = [{ replicaId, counter: 1 }];
    const operationIds = Array.from({ length: operationCount }, () => nextId());
    const committedTransactionBytes = encodeCommittedTransaction({
      transactionId,
      replicaId,
      replicaCounter: 1,
      resolvedCausalBase: [],
      priorStateHash: hash("7"),
      operationIds,
      resultingCausalFrontier,
      stateHash,
    });
    const receipt: PersistedEditableArtifactReceipt = {
      receiptId: nextId(),
      scope,
      artifactId,
      modality: "spreadsheet",
      serverTransactionId: transactionId,
      clientTransactionId: "maximum-operation-cardinality",
      replicaId,
      replicaCounter: 1,
      previousLocalTransactionId: null,
      intentBytes: intent.bytes,
      requestHash: intent.requestHash,
      actorKey,
      sequenceStart: 1,
      sequenceEnd: operationCount,
      priorStateHash: hash("7"),
      causalBase: [],
      resolvedCausalBase: [],
      resultingCausalFrontier,
      stateHash,
      operationCount,
      selectiveUndoOperationIds: [],
      intentEnvelopeVersion: 1,
      intentProtocolVersion: 1,
      commandProtocolVersion: 1,
      kernelVersion: "test-kernel-1",
      modelSchemaVersion: 1,
      operationProtocolVersion: 1,
      committedAt,
    };
    const result = await store.tryCommitAppliedTransaction({
      scope,
      artifactId,
      expectedLifecycle: "active",
      expectedAuthorizationRevision: 1,
      expectedHeadSequence: 0,
      authorizationActor: humanAuthorizationActor(),
      actorKey,
      clientTransactionId: receipt.clientTransactionId,
      requestHash: receipt.requestHash,
      expectedPredecessor: null,
      expectedUnclaimedUndoTargets: [],
      serverTransactionId: transactionId,
      receipt,
      committedTransaction: {
        scope,
        artifactId,
        modality: "spreadsheet",
        serverTransactionId: transactionId,
        requestHash: receipt.requestHash,
        sequenceStart: 1,
        sequenceEnd: operationCount,
        priorStateHash: hash("7"),
        stateHash,
        dot: { replicaId, counter: 1 },
        resolvedCausalBase: [],
        resultingCausalFrontier,
        operationIds,
        operationProtocolVersion: 1,
        modelSchemaVersion: 1,
        kernelVersion: "test-kernel-1",
        committedTransactionBytes,
        committedAt,
      },
      operations: operationIds.map((operationId, index) => ({
        scope,
        artifactId,
        serverTransactionId: transactionId,
        sequence: index + 1,
        actorKey,
        createdAt: committedAt,
        operationId,
        dot: { replicaId, counter: 1 },
      })),
      outbox: {
        outboxId: nextId(),
        event: {
          kind: "transaction_committed",
          schemaVersion: 1,
          scope,
          artifactId,
          modality: "spreadsheet",
          serverTransactionId: transactionId,
          sequenceStart: 1,
          sequenceEnd: operationCount,
          stateHash,
          operationProtocolVersion: 1,
          committedAt,
        },
        state: "pending",
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: committedAt,
        lastErrorCode: null,
        publishedAt: null,
        deadLetteredAt: null,
        createdAt: committedAt,
      },
    });
    expect(result.kind).toBe("committed");
    expect((await store.getArtifact(scope, artifactId))?.headSequence).toBe(operationCount);
    const operationFacts = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from editable_artifact_operations
      where account_id = ${accountId} and workspace_id = ${workspaceId}
        and artifact_id = ${artifactId}`;
    expect(operationFacts[0]?.count).toBe(operationCount);
  }, 60_000);

  test("fences create and read authorization revisions without partial genesis writes", async () => {
    if (!available || !shared) return;
    const [fenceAccount] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('artifact fence account') returning id`;
    const [fenceWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${fenceAccount!.id}, 'artifact fence workspace') returning id`;
    const scope = { accountId: fenceAccount!.id, workspaceId: fenceWorkspace!.id };
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, permissions
      ) values (
        ${scope.accountId}, ${scope.workspaceId}, 'user:fenced',
        '["artifacts:read","artifacts:publish"]'::jsonb
      )`;

    expect(await store.ensureScopeCreateAuthorizationHead(scope)).toEqual({
      scope,
      createRevision: 1,
    });
    expect(await store.advanceScopeCreateAuthorizationRevision(scope, 1, 2)).toEqual({
      applied: true,
      authorizationRevision: 2,
    });
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, permissions
      ) values (
        ${scope.accountId}, ${scope.workspaceId}, 'user:read-only',
        '["artifacts:read"]'::jsonb
      )`;
    const deniedArtifactId = nextId();
    expect(
      await store.createArtifact(
        creationFixture({
          scope,
          artifactId: deniedArtifactId,
          receiptId: nextId(),
          authorityKey: JSON.stringify(["human", "user:read-only"]),
          idempotencyKey: `create:${deniedArtifactId}`,
          requestHash: hash("9"),
          modality: "document",
          title: "Denied genesis",
          stateHash: hash("8"),
          authorizationRevision: 2,
          createdBySubjectId: "user:read-only",
        }),
      ),
    ).toEqual({ kind: "authorization_stale" });
    expect(await store.getArtifact(scope, deniedArtifactId)).toBeNull();
    const configuredActor = {
      kind: "service" as const,
      subjectId: "configured:key",
      replicaId: "abababababababab",
      service: "configured_key",
    };
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, permissions
      ) values (
        ${scope.accountId}, ${scope.workspaceId}, ${configuredActor.subjectId},
        '["artifacts:read","artifacts:publish"]'::jsonb
      )`;
    const configuredServiceArtifactId = nextId();
    const configuredServiceCreation = creationFixture({
      scope,
      artifactId: configuredServiceArtifactId,
      receiptId: nextId(),
      authorityKey: JSON.stringify(["service", "configured:key", "configured_key"]),
      idempotencyKey: `create:${configuredServiceArtifactId}`,
      requestHash: hash("7"),
      modality: "presentation",
      title: "Configured deployment authority",
      stateHash: hash("6"),
      authorizationRevision: 2,
      createdBySubjectId: configuredActor.subjectId,
    });
    const configuredServiceCreated = await store.createArtifact({
      ...configuredServiceCreation,
      authorizationActor: configuredActor,
    });
    expect(configuredServiceCreated.kind).toBe("result");
    await shared.admin`
      delete from workspace_memberships
      where account_id = ${scope.accountId}
        and workspace_id = ${scope.workspaceId}
        and subject_id = ${configuredActor.subjectId}`;
    const revokedConfiguredArtifactId = nextId();
    expect(
      await store.createArtifact({
        ...creationFixture({
          scope,
          artifactId: revokedConfiguredArtifactId,
          receiptId: nextId(),
          authorityKey: JSON.stringify([
            "service",
            configuredActor.subjectId,
            configuredActor.service,
          ]),
          idempotencyKey: `create:${revokedConfiguredArtifactId}`,
          requestHash: hash("5"),
          modality: "presentation",
          title: "Revoked configured authority",
          stateHash: hash("4"),
          authorizationRevision: 2,
          createdBySubjectId: configuredActor.subjectId,
        }),
        authorizationActor: configuredActor,
      }),
    ).toEqual({ kind: "authorization_stale" });
    expect(await store.getArtifact(scope, revokedConfiguredArtifactId)).toBeNull();

    const artifactId = nextId();
    const fixture = creationFixture({
      scope,
      artifactId,
      receiptId: nextId(),
      authorityKey: JSON.stringify(["human", "user:fenced"]),
      idempotencyKey: `create:${artifactId}`,
      requestHash: hash("a"),
      modality: "document",
      title: "Fenced genesis",
      stateHash: hash("b"),
      authorizationRevision: 1,
      createdBySubjectId: "user:fenced",
    });
    expect(await store.createArtifact(fixture)).toEqual({ kind: "authorization_stale" });

    const absentFacts = await shared.admin<
      {
        artifacts: number;
        snapshots: number;
        receipts: number;
        outbox: number;
      }[]
    >`
      select
        (select count(*)::int from editable_artifacts where id = ${artifactId}) as artifacts,
        (select count(*)::int from editable_artifact_snapshots where artifact_id = ${artifactId}) as snapshots,
        (select count(*)::int from editable_artifact_idempotency_receipts where artifact_id = ${artifactId}) as receipts,
        (select count(*)::int from editable_artifact_live_outbox where artifact_id = ${artifactId}) as outbox`;
    expect(absentFacts[0]).toEqual({ artifacts: 0, snapshots: 0, receipts: 0, outbox: 0 });

    const created = await store.createArtifact({
      ...fixture,
      expectedScopeAuthorizationRevision: 2,
      initialArtifactAuthorizationRevision: 7,
    });
    if (created.kind !== "result") throw new Error("current create authorization was fenced");
    expect(created.value.artifact.authorizationRevision).toBe(7);
    expect(await store.readArtifactAtAuthorizationRevision(scope, artifactId, 6)).toEqual({
      kind: "authorization_stale",
    });
    expect(await store.readArtifactAtAuthorizationRevision(scope, nextId(), 7)).toEqual({
      kind: "result",
      artifact: null,
    });
    expect(await store.readArtifactAtAuthorizationRevision(scope, artifactId, 7)).toEqual({
      kind: "result",
      artifact: created.value.artifact,
    });

    expect(await store.advanceAuthorizationRevision(scope, artifactId, 7, 8)).toEqual({
      applied: true,
      authorizationRevision: 8,
    });
    expect(await store.readArtifactAtAuthorizationRevision(scope, artifactId, 7)).toEqual({
      kind: "authorization_stale",
    });
    expect(await store.advanceScopeCreateAuthorizationRevision(scope, 2, 3)).toEqual({
      applied: true,
      authorizationRevision: 3,
    });
    const replay = await store.createArtifact({
      ...fixture,
      expectedScopeAuthorizationRevision: 2,
      initialArtifactAuthorizationRevision: 7,
    });
    if (replay.kind !== "result") throw new Error("durable creation replay was fenced");
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.artifact.authorizationRevision).toBe(8);
  }, 30_000);

  test("imports a retained Office file as exact sequence-zero authority", async () => {
    if (!available || !shared) return;
    const scope = { accountId, workspaceId };
    const sourceFileId = crypto.randomUUID();
    const sourceObjectKey = `workspaces/${workspaceId}/files/${sourceFileId}/original/import.xlsx`;
    await shared.admin`
      insert into files (
        id, account_id, workspace_id, status, filename, safe_filename,
        content_type, size_bytes, sha256, bucket, object_key
      ) values (
        ${sourceFileId}, ${accountId}, ${workspaceId}, 'ready', 'import.xlsx', 'import.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        4096, ${"a".repeat(64)}, 'test', ${sourceObjectKey}
      )`;

    const artifactId = nextId();
    const idempotencyKey = `import:${artifactId}`;
    const authorityKey = JSON.stringify(["human", "user:alice"]);
    const base = creationFixture({
      scope,
      artifactId,
      receiptId: nextId(),
      authorityKey,
      idempotencyKey,
      requestHash: hash("8"),
      modality: "spreadsheet",
      title: "Imported workbook",
      stateHash: hash("7"),
      authorizationRevision: 1,
      createdBySubjectId: "user:alice",
    });
    if (base.genesisSnapshot.modality !== "spreadsheet") {
      throw new Error("spreadsheet import fixture returned another modality");
    }
    const frontier = [{ replicaId: "1234567890abcdef", counter: 4 }] as const;
    const imported = await store.createArtifact({
      ...base,
      operationKind: "import",
      genesisSnapshot: { ...base.genesisSnapshot, coveredCausalFrontier: frontier },
      originalImport: {
        fileId: sourceFileId,
        blobRefId: nextId(),
        blobReference: sourceObjectKey,
        byteSize: 4_096,
        contentHash: hash("a"),
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
    if (imported.kind !== "result") throw new Error("scope-authorized import was fenced");
    expect(imported.value.creationReceipt.operationKind).toBe("import");
    expect(spreadsheetArtifact(imported.value.artifact).causalFrontier).toEqual(frontier);
    expect(imported.value.genesisSnapshot).toMatchObject({
      coveredHeadSequence: 0,
      coveredCausalFrontier: frontier,
    });
    expect(
      await store.findArtifactCreation(scope, "import", authorityKey, idempotencyKey),
    ).toMatchObject({
      replayed: true,
      artifact: { id: artifactId },
      creationReceipt: { operationKind: "import" },
    });
    expect(
      await store.findArtifactCreation(scope, "create", authorityKey, idempotencyKey),
    ).toBeNull();

    const [sourceLink] = await shared.admin<
      Array<{ kind: string; sourceFileId: string; objectReference: string }>
    >`
      select kind, source_file_id::text as "sourceFileId",
        object_reference as "objectReference"
      from editable_artifact_blob_refs
      where account_id = ${accountId} and workspace_id = ${workspaceId}
        and artifact_id = ${artifactId} and kind = 'original_import'`;
    expect(sourceLink).toEqual({
      kind: "original_import",
      sourceFileId,
      objectReference: sourceObjectKey,
    });

    const createArtifactId = nextId();
    const createWithSameKey = await store.createArtifact(
      creationFixture({
        scope,
        artifactId: createArtifactId,
        receiptId: nextId(),
        authorityKey,
        idempotencyKey,
        requestHash: hash("6"),
        modality: "document",
        title: "Separate create namespace",
        stateHash: hash("5"),
        authorizationRevision: 1,
        createdBySubjectId: "user:alice",
      }),
    );
    expect(createWithSameKey.kind).toBe("result");
  }, 30_000);
});

async function readKernelState(
  scope: { accountId: string; workspaceId: string },
  artifactId: string,
  clientTransactionId: string,
): Promise<Extract<PersistedEditableArtifactKernelState, { modality: "spreadsheet" }>> {
  const basis = await store.readTransactionBasis(scope, artifactId, {
    actorKey: JSON.stringify(["human", "user:alice"]),
    clientTransactionId,
    previousLocalTransactionId: null,
    selectiveUndoOperationIds: [],
  });

  if (basis.kind !== "basis") throw new Error("unexpected existing transaction receipt");
  if (basis.kernelState.modality !== "spreadsheet") {
    throw new Error("spreadsheet test received a serialized kernel state");
  }
  return basis.kernelState;
}

async function applyTransaction(input: {
  artifactId: string;
  clientTransactionId: string;
  previousLocalTransactionId?: string;
  causalBase?: PersistedEditableArtifactCausalFrontier;
  requestHash: string;
  replicaId: string;
  stateHash: string;
}): Promise<Extract<PersistedEditableArtifactReceipt, { modality: "spreadsheet" }>> {
  const scope = { accountId, workspaceId };
  const actorKey = JSON.stringify(["human", "user:alice"]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const basis = await store.readTransactionBasis(scope, input.artifactId, {
      actorKey,
      clientTransactionId: input.clientTransactionId,
      previousLocalTransactionId: input.previousLocalTransactionId ?? null,
      selectiveUndoOperationIds: [],
    });
    if (basis.kind === "existing") {
      const intent = intentFor(input.requestHash);
      if (basis.receipt.requestHash !== intent.requestHash) {
        throw new EditableArtifactPersistenceError("conflict", "idempotency hash differs");
      }
      if (basis.receipt.modality !== "spreadsheet") {
        throw new Error("spreadsheet test replayed a serialized receipt");
      }
      return basis.receipt;
    }
    if (basis.artifact.modality !== "spreadsheet") {
      throw new Error("spreadsheet transaction fixture received a serialized artifact");
    }
    if (basis.predecessor && basis.predecessor.modality !== "spreadsheet") {
      throw new Error("spreadsheet transaction fixture received a serialized predecessor");
    }
    const transactionId = nextId();
    const fixture = transactionFixture({
      artifact: spreadsheetArtifact(basis.artifact),
      transactionId,
      receiptId: nextId(),
      operationId: nextId(),
      outboxId: nextId(),
      clientTransactionId: input.clientTransactionId,
      ...(input.previousLocalTransactionId === undefined
        ? {}
        : { previousLocalTransactionId: input.previousLocalTransactionId }),
      ...(input.causalBase === undefined ? {} : { causalBase: input.causalBase }),
      ...(basis.predecessor === null ? {} : { predecessor: basis.predecessor }),
      requestHash: input.requestHash,
      replicaId: input.replicaId,
      stateHash: input.stateHash,
    });
    const result = await store.tryCommitAppliedTransaction({
      scope,
      artifactId: input.artifactId,
      expectedLifecycle: "active",
      expectedAuthorizationRevision: basis.artifact.authorizationRevision,
      authorizationActor: humanAuthorizationActor(),
      actorKey,
      clientTransactionId: input.clientTransactionId,
      requestHash: fixture.commit.receipt.requestHash,
      expectedPredecessor: basis.predecessor
        ? {
            receiptId: basis.predecessor.receiptId,
            serverTransactionId: basis.predecessor.serverTransactionId,
            actorKey: basis.predecessor.actorKey,
            clientTransactionId: basis.predecessor.clientTransactionId,
            replicaId: basis.predecessor.replicaId,
            replicaCounter: basis.predecessor.replicaCounter,
          }
        : null,
      expectedUnclaimedUndoTargets: [],
      ...fixture.commit,
    });
    if (result.kind !== "stale") {
      if (result.receipt.modality !== "spreadsheet") {
        throw new Error("spreadsheet commit returned a serialized receipt");
      }
      return result.receipt;
    }
  }
  throw new Error("optimistic artifact transaction did not converge");
}

function transactionFixture(input: {
  artifact: Extract<PersistedEditableArtifact, { modality: "spreadsheet" }>;
  transactionId: string;
  receiptId: string;
  operationId: string;
  outboxId: string;
  clientTransactionId: string;
  previousLocalTransactionId?: string;
  causalBase?: PersistedEditableArtifactCausalFrontier;
  predecessor?: Extract<PersistedEditableArtifactReceipt, { modality: "spreadsheet" }>;
  selectiveUndoOperationIds?: readonly string[];
  requestHash: string;
  replicaId: string;
  stateHash: string;
  actorKey?: string;
}) {
  const committedAt = new Date().toISOString();
  const replicaCounter =
    input.artifact.causalFrontier.find((entry) => entry.replicaId === input.replicaId)?.counter ??
    0;
  const counter = replicaCounter + 1;
  const causalBase = input.causalBase ?? input.artifact.causalFrontier;
  const resolvedCausalBase = input.predecessor
    ? mergeFrontiers(causalBase, input.predecessor.resolvedCausalBase, [
        {
          replicaId: input.predecessor.replicaId,
          counter: input.predecessor.replicaCounter,
        },
      ])
    : causalBase;
  const resultingCausalFrontier = mergeFrontier(
    input.artifact.causalFrontier,
    input.replicaId,
    counter,
  );
  const actorKey = input.actorKey ?? JSON.stringify(["human", "user:alice"]);
  const intent = intentFor(input.requestHash);
  const receipt: PersistedEditableArtifactReceipt = {
    receiptId: input.receiptId,
    scope: input.artifact.scope,
    artifactId: input.artifact.id,
    modality: "spreadsheet",
    serverTransactionId: input.transactionId,
    clientTransactionId: input.clientTransactionId,
    replicaId: input.replicaId,
    replicaCounter: counter,
    previousLocalTransactionId: input.previousLocalTransactionId ?? null,
    intentBytes: intent.bytes,
    requestHash: intent.requestHash,
    actorKey,
    sequenceStart: input.artifact.headSequence + 1,
    sequenceEnd: input.artifact.headSequence + 1,
    priorStateHash: input.artifact.stateHash,
    causalBase,
    resolvedCausalBase,
    resultingCausalFrontier,
    stateHash: input.stateHash,
    operationCount: 1,
    selectiveUndoOperationIds: input.selectiveUndoOperationIds ?? [],
    intentEnvelopeVersion: 1,
    intentProtocolVersion: 1,
    commandProtocolVersion: 1,
    kernelVersion: "test-kernel-1",
    modelSchemaVersion: 1,
    operationProtocolVersion: 1,
    committedAt,
  };
  const operations = [
    {
      scope: input.artifact.scope,
      artifactId: input.artifact.id,
      serverTransactionId: input.transactionId,
      sequence: receipt.sequenceStart,
      actorKey,
      createdAt: committedAt,
      operationId: input.operationId,
      dot: { replicaId: input.replicaId, counter },
    },
  ];
  const committedTransactionBytes = encodeCommittedTransaction({
    transactionId: input.transactionId,
    replicaId: input.replicaId,
    replicaCounter: counter,
    resolvedCausalBase,
    priorStateHash: input.artifact.stateHash,
    operationIds: [input.operationId],
    resultingCausalFrontier,
    stateHash: input.stateHash,
  });
  return {
    commit: {
      expectedHeadSequence: input.artifact.headSequence,
      serverTransactionId: input.transactionId,
      receipt,
      committedTransaction: {
        scope: input.artifact.scope,
        artifactId: input.artifact.id,
        modality: "spreadsheet" as const,
        serverTransactionId: input.transactionId,
        requestHash: receipt.requestHash,
        sequenceStart: receipt.sequenceStart,
        sequenceEnd: receipt.sequenceEnd,
        priorStateHash: input.artifact.stateHash,
        stateHash: input.stateHash,
        dot: { replicaId: input.replicaId, counter },
        resolvedCausalBase,
        resultingCausalFrontier,
        operationIds: [input.operationId],
        operationProtocolVersion: 1,
        modelSchemaVersion: 1,
        kernelVersion: "test-kernel-1",
        committedTransactionBytes,
        committedAt,
      },
      operations,
      outbox: {
        outboxId: input.outboxId,
        event: {
          kind: "transaction_committed" as const,
          schemaVersion: 1 as const,
          scope: input.artifact.scope,
          artifactId: input.artifact.id,
          modality: "spreadsheet" as const,
          serverTransactionId: input.transactionId,
          sequenceStart: receipt.sequenceStart,
          sequenceEnd: receipt.sequenceEnd,
          stateHash: input.stateHash,
          operationProtocolVersion: 1,
          committedAt,
        },
        state: "pending" as const,
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: committedAt,
        lastErrorCode: null,
        publishedAt: null,
        deadLetteredAt: null,
        createdAt: committedAt,
      },
    },
  };
}

function serializedTransactionFixture(input: {
  artifact: Extract<PersistedEditableArtifact, { modality: "document" | "presentation" }>;
  modality: "document" | "presentation";
  transactionId: string;
  receiptId: string;
  outboxId: string;
  clientTransactionId: string;
  stateHash: string;
  priorNativeRevision: number;
  nativeRevision: number;
}) {
  if (input.artifact.modality !== input.modality) {
    throw new TypeError("serialized fixture modality differs from its artifact");
  }
  const replicaId = "bbbbbbbbbbbbbbbb";
  const replicaCounter = input.artifact.headSequence + 1;
  const commandBytes =
    input.modality === "document"
      ? encodeDocumentArtifactCommandBatch({
          version: 1,
          commands: [
            {
              kind: "document.flags.set",
              evenAndOddHeaders: true,
              trackRevisions: null,
            },
          ],
        })
      : encodePresentationArtifactCommandBatch({
          version: 1,
          commands: [
            {
              kind: "master.create",
              id: "8".repeat(32),
              name: "Postgres native master",
              background: { kind: "none" },
            },
          ],
        });
  const intentBytes = encodeEditableArtifactMutationIntent({
    envelopeVersion: 1,
    protocolVersion: 1,
    modelSchemaVersion: 1,
    commandProtocolVersion: 1,
    artifactId: input.artifact.id,
    clientTransactionId: input.clientTransactionId,
    replicaId,
    replicaCounter,
    previousLocalTransactionId: null,
    observedHeadSequence: input.artifact.headSequence,
    causalBase: [],
    selectiveUndoOperationIds: [],
    commandBytes,
  });
  const requestHash = hashEditableArtifactMutationIntentBytes(intentBytes);
  const nativeReceiptBytes = encodeSerializedNativeReceipt(input.modality, input.nativeRevision, 1);
  const committedTransactionBytes = encodeEditableArtifactSerializedCommit({
    modality: input.modality,
    transactionId: input.transactionId,
    parentHeadSequence: input.artifact.headSequence,
    resultHeadSequence: input.artifact.headSequence + 1,
    priorNativeRevision: input.priorNativeRevision,
    priorStateHash: input.artifact.stateHash,
    stateHash: input.stateHash,
    intentBytes,
    nativeReceiptBytes,
  });
  const committedAt = new Date().toISOString();
  const receipt: Extract<
    PersistedEditableArtifactReceipt,
    { modality: "document" | "presentation" }
  > = {
    receiptId: input.receiptId,
    scope: input.artifact.scope,
    artifactId: input.artifact.id,
    modality: input.modality,
    serverTransactionId: input.transactionId,
    clientTransactionId: input.clientTransactionId,
    replicaId,
    replicaCounter,
    previousLocalTransactionId: null,
    intentBytes,
    requestHash,
    actorKey: JSON.stringify(["human", "user:alice"]),
    sequenceStart: input.artifact.headSequence + 1,
    sequenceEnd: input.artifact.headSequence + 1,
    priorStateHash: input.artifact.stateHash,
    stateHash: input.stateHash,
    intentEnvelopeVersion: 1,
    intentProtocolVersion: 1,
    commandProtocolVersion: 1,
    kernelVersion: "test-kernel-1",
    modelSchemaVersion: 1,
    commitProtocolVersion: 1,
    priorNativeRevision: input.priorNativeRevision,
    nativeRevision: input.nativeRevision,
    commandCount: 1,
    committedAt,
  };
  return {
    commit: {
      expectedHeadSequence: input.artifact.headSequence,
      serverTransactionId: input.transactionId,
      receipt,
      committedTransaction: {
        scope: input.artifact.scope,
        artifactId: input.artifact.id,
        modality: input.modality,
        serverTransactionId: input.transactionId,
        requestHash,
        sequenceStart: receipt.sequenceStart,
        sequenceEnd: receipt.sequenceEnd,
        priorStateHash: input.artifact.stateHash,
        stateHash: input.stateHash,
        commitProtocolVersion: 1,
        priorNativeRevision: input.priorNativeRevision,
        nativeRevision: input.nativeRevision,
        commandCount: 1,
        nativeReceiptBytes,
        modelSchemaVersion: 1,
        kernelVersion: "test-kernel-1",
        committedTransactionBytes,
        committedAt,
      },
      operations: [],
      outbox: {
        outboxId: input.outboxId,
        event: {
          kind: "transaction_committed" as const,
          schemaVersion: 1 as const,
          scope: input.artifact.scope,
          artifactId: input.artifact.id,
          modality: input.modality,
          serverTransactionId: input.transactionId,
          sequenceStart: receipt.sequenceStart,
          sequenceEnd: receipt.sequenceEnd,
          stateHash: input.stateHash,
          commitProtocolVersion: 1,
          committedAt,
        },
        state: "pending" as const,
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: committedAt,
        lastErrorCode: null,
        publishedAt: null,
        deadLetteredAt: null,
        createdAt: committedAt,
      },
    },
  };
}

function encodeSerializedNativeReceipt(
  modality: "document" | "presentation",
  revision: number,
  commandCount: number,
): Uint8Array {
  if (modality === "document") {
    const payload = new OgacoFixtureWriter()
      .u64(BigInt(revision))
      .u32(commandCount)
      .u32(0)
      .finish();
    const receipt = new OgacoFixtureWriter()
      .raw(new TextEncoder().encode("OGADR001"))
      .u16(1)
      .u16(0)
      .u32(commandCount)
      .u64(BigInt(payload.byteLength))
      .raw(payload)
      .finish(8);
    new DataView(receipt.buffer, receipt.byteOffset, receipt.byteLength).setBigUint64(
      receipt.byteLength - 8,
      fnv1a64(receipt.subarray(0, receipt.byteLength - 8)),
      true,
    );
    return receipt;
  }
  const receipt = new OgacoFixtureWriter()
    .raw(new TextEncoder().encode("OGAPR001"))
    .u16(1)
    .u16(0)
    .u64(BigInt(revision))
    .u32(commandCount)
    .finish(8);
  new DataView(receipt.buffer, receipt.byteOffset, receipt.byteLength).setBigUint64(
    receipt.byteLength - 8,
    fnv1a64(receipt.subarray(0, receipt.byteLength - 8)),
    true,
  );
  return receipt;
}

function spreadsheetArtifact(
  artifact: PersistedEditableArtifact,
): Extract<PersistedEditableArtifact, { modality: "spreadsheet" }> {
  if (artifact.modality !== "spreadsheet") {
    throw new Error("spreadsheet fixture received a serialized artifact");
  }
  return artifact;
}

function humanAuthorizationActor(subjectId = "user:alice") {
  return {
    kind: "human" as const,
    subjectId,
    replicaId: "9999999999999999",
  };
}

function creationFixture(input: {
  scope: { accountId: string; workspaceId: string };
  artifactId: string;
  receiptId: string;
  authorityKey: string;
  idempotencyKey: string;
  requestHash: string;
  modality: PersistedEditableArtifact["modality"];
  title: string;
  stateHash: string;
  authorizationRevision: number;
  createdBySubjectId: string;
  createdAt?: Date | string;
  snapshotBytes?: Uint8Array;
}): Parameters<PostgresEditableArtifactStore["createArtifact"]>[0] {
  const publishedAt = new Date(input.createdAt ?? Date.now()).toISOString();
  const snapshotId = nextId();
  const snapshotBytes = input.snapshotBytes?.slice();
  const snapshotCommon = {
    scope: input.scope,
    artifactId: input.artifactId,
    snapshotId,
    blobReference: `editable-artifacts/${input.artifactId}/${snapshotId}`,
    byteSize: snapshotBytes?.byteLength ?? 256,
    contentHash: snapshotBytes ? hashBytesSha256(snapshotBytes) : hash("f"),
    mimeType: "application/vnd.opengeni.editable-artifact-snapshot" as const,
    coveredHeadSequence: 0,
    stateHash: input.stateHash,
    modelSchemaVersion: 1,
    kernelVersion: "test-kernel-1",
    verifiedAt: publishedAt,
    publishedAt,
  };
  const genesisSnapshot: Parameters<
    PostgresEditableArtifactStore["createArtifact"]
  >[0]["genesisSnapshot"] =
    input.modality === "spreadsheet"
      ? {
          ...snapshotCommon,
          modality: "spreadsheet",
          coveredCausalFrontier: [],
          operationProtocolVersion: 1,
          crdtStateVersion: 1,
        }
      : {
          ...snapshotCommon,
          modality: input.modality,
          nativeRevision: 0,
        };
  const snapshotEvent =
    input.modality === "spreadsheet"
      ? {
          kind: "snapshot_published" as const,
          schemaVersion: 1 as const,
          scope: input.scope,
          artifactId: input.artifactId,
          modality: "spreadsheet" as const,
          snapshotId,
          coveredHeadSequence: 0,
          stateHash: input.stateHash,
          operationProtocolVersion: 1,
          publishedAt,
        }
      : {
          kind: "snapshot_published" as const,
          schemaVersion: 1 as const,
          scope: input.scope,
          artifactId: input.artifactId,
          modality: input.modality,
          snapshotId,
          coveredHeadSequence: 0,
          stateHash: input.stateHash,
          publishedAt,
        };
  return {
    scope: input.scope,
    artifactId: input.artifactId,
    authorizationActor: humanAuthorizationActor(input.createdBySubjectId),
    receiptId: input.receiptId,
    authorityKey: input.authorityKey,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    operationKind: "create",
    modality: input.modality,
    title: input.title,
    expectedScopeAuthorizationRevision: input.authorizationRevision,
    initialArtifactAuthorizationRevision: input.authorizationRevision,
    createdBySubjectId: input.createdBySubjectId,
    genesisSnapshot,
    outbox: {
      outboxId: nextId(),
      event: snapshotEvent,
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
  };
}

function mergeFrontier(
  current: PersistedEditableArtifactCausalFrontier,
  replicaId: string,
  counter: number,
): PersistedEditableArtifactCausalFrontier {
  return [...current.filter((entry) => entry.replicaId !== replicaId), { replicaId, counter }].sort(
    (left, right) =>
      left.replicaId < right.replicaId ? -1 : left.replicaId > right.replicaId ? 1 : 0,
  );
}

function mergeFrontiers(
  ...frontiers: readonly PersistedEditableArtifactCausalFrontier[]
): PersistedEditableArtifactCausalFrontier {
  const counters = new Map<string, number>();
  for (const frontier of frontiers) {
    for (const entry of frontier) {
      counters.set(entry.replicaId, Math.max(counters.get(entry.replicaId) ?? 0, entry.counter));
    }
  }
  return [...counters]
    .map(([replicaId, counter]) => ({ replicaId, counter }))
    .sort((left, right) =>
      left.replicaId < right.replicaId ? -1 : left.replicaId > right.replicaId ? 1 : 0,
    );
}

function nextId(): string {
  const value = `abcdef0123456789${idCounter.toString(16).padStart(16, "0")}`;
  idCounter += 1n;
  return value;
}

function hash(nibble: string): string {
  return `sha256:${nibble.repeat(64)}`;
}

function hashBytesSha256(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function intentFor(seed: string): { bytes: Uint8Array; requestHash: string } {
  const bytes = new TextEncoder().encode(`OGATX001${seed}`);
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { bytes, requestHash: `sha256:${digest}` };
}

function intentOfSize(byteLength: number): { bytes: Uint8Array; requestHash: string } {
  const bytes = new Uint8Array(byteLength);
  bytes.set(new TextEncoder().encode("OGATX001"));
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { bytes, requestHash: `sha256:${digest}` };
}

function encodeCommittedTransaction(input: {
  transactionId: string;
  replicaId: string;
  replicaCounter: number;
  resolvedCausalBase: PersistedEditableArtifactCausalFrontier;
  priorStateHash: string;
  operationIds: readonly string[];
  resultingCausalFrontier: PersistedEditableArtifactCausalFrontier;
  stateHash: string;
}): Uint8Array {
  const payload = new OgacoFixtureWriter()
    .stableId(input.transactionId)
    .hex64(input.replicaId)
    .u64(BigInt(input.replicaCounter))
    .frontier(input.resolvedCausalBase)
    .raw(hashBytes(input.priorStateHash));
  for (const operationId of input.operationIds) {
    // Selective-undo is the smallest typed OGACO operation. The persistence
    // suite exercises the envelope/authority boundary, not kernel semantics.
    payload.stableId(operationId).u8(5).stableId(operationId);
  }
  payload.frontier(input.resultingCausalFrontier).raw(hashBytes(input.stateHash));
  const payloadBytes = payload.finish();
  const bytes = new OgacoFixtureWriter()
    .raw(new TextEncoder().encode("OGACO001"))
    .u16(1)
    .u16(0)
    .u32(input.operationIds.length)
    .u64(BigInt(payloadBytes.byteLength))
    .raw(payloadBytes)
    .finish(8);
  const payloadEnd = bytes.byteLength - 8;
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(
    payloadEnd,
    fnv1a64(bytes.subarray(0, payloadEnd)),
    true,
  );
  return bytes;
}

class OgacoFixtureWriter {
  readonly #bytes: number[] = [];

  raw(bytes: Uint8Array): this {
    for (const byte of bytes) this.#bytes.push(byte);
    return this;
  }

  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >>> 8);
  }

  u32(value: number): this {
    return this.u8(value)
      .u8(value >>> 8)
      .u8(value >>> 16)
      .u8(value >>> 24);
  }

  u64(value: bigint): this {
    return this.u32(Number(value & 0xffff_ffffn)).u32(Number((value >> 32n) & 0xffff_ffffn));
  }

  hex64(value: string): this {
    if (!/^[0-9a-f]{16}$/.test(value)) throw new TypeError("invalid fixture replica id");
    return this.u64(BigInt(`0x${value}`));
  }

  stableId(value: string): this {
    if (!/^[0-9a-f]{32}$/.test(value)) throw new TypeError("invalid fixture stable id");
    return this.u64(BigInt(`0x${value.slice(16)}`)).u64(BigInt(`0x${value.slice(0, 16)}`));
  }

  frontier(entries: PersistedEditableArtifactCausalFrontier): this {
    this.u32(entries.length);
    for (const entry of entries) this.hex64(entry.replicaId).u64(BigInt(entry.counter));
    return this;
  }

  finish(trailingZeros = 0): Uint8Array {
    const result = new Uint8Array(this.#bytes.length + trailingZeros);
    result.set(this.#bytes);
    return result;
  }
}

function hashBytes(value: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError("invalid fixture state hash");
  const hex = value.slice("sha256:".length);
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

function fnv1a64(bytes: Uint8Array): bigint {
  let hashValue = 0xcbf2_9ce4_8422_2325n;
  for (const byte of bytes) {
    hashValue ^= BigInt(byte);
    hashValue = (hashValue * 0x100_0000_01b3n) & 0xffff_ffff_ffff_ffffn;
  }
  return hashValue;
}

async function expectSqlFailure(work: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(message);
}
