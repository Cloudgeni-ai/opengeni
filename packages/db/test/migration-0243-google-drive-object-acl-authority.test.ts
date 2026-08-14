import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  appendKnowledgeDocumentVersion,
  appendKnowledgeSourceAclVersion,
  createConnection,
  createDb,
  createScheduledTask,
  createScheduledTaskRun,
  enqueueKnowledgeSourceSyncIndexObligation,
  ensureKnowledgeSourceBlobFile,
  ensureKnowledgeSourceSyncState,
  getFilesForSubject,
  migrate,
  provisionRoles,
  recordGoogleDriveObjectAclEvidence,
  requireFileForSubject,
  settleKnowledgeSourceSyncIndexObligation,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  upsertKnowledgeSourceObject,
  type DbClient,
} from "../src";
import {
  FORCE_RLS_TABLES,
  RUNTIME_READ_INSERT_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0243_google_drive_object_acl_authority.sql",
);
const provisionerPath = join(dirname(fileURLToPath(import.meta.url)), "../src/provision-roles.ts");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_DRIVE_ACL_POSTGRES_ADMIN_URL?.trim();
const externalAppUrl = process.env.OPENGENI_DRIVE_ACL_POSTGRES_APP_URL?.trim();
const driveScope = "https://www.googleapis.com/auth/drive.readonly";

let migration = "";
let provisioner = "";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let appProbe: postgres.Sql | null = null;

type ProtectedObject = {
  externalObjectId: string;
  objectId: string;
  versionId: string;
  versionGeneration: number;
  documentId: string;
  obligationId: string;
  providerRevision: string;
};

beforeAll(async () => {
  [migration, provisioner] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(provisionerPath, "utf8"),
  ]);
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_DRIVE_ACL_POSTGRES_ADMIN_URL and OPENGENI_DRIVE_ACL_POSTGRES_APP_URL",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 4, prepare: false });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0243-google-drive-object-acl-authority");
  }
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0243-google-drive-object-acl-authority] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    console.warn(
      "[migration-0243-google-drive-object-acl-authority] PostgreSQL unavailable, skipping live assertions",
    );
    return;
  }
  await migrate(shared.adminUrl);
  await provisionRoles(shared.adminUrl, {
    appRole: "opengeni_app",
    appPassword: decodeURIComponent(new URL(shared.appUrl).password),
    rlsStrategy: "force",
  });
  client = createDb(shared.appUrl);
  appProbe = postgres(shared.appUrl, { max: 1, prepare: false });
}, 180_000);

afterAll(async () => {
  await appProbe?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("migration 0243 Google Drive object ACL authority", () => {
  test("is rolling, hash-only, FORCE-RLS, append-only, and exposes exact capabilities", () => {
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of [
      "google_drive_object_acl_evidence",
      "google_drive_object_acl_principals",
    ] as const) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_READ_INSERT_TABLES).toContain(table);
    }
    expect(migration).toContain('"permission_id_hash" text');
    expect(migration).toContain('"email_hash" text');
    expect(migration).toContain('"domain_hash" text');
    expect(migration).not.toMatch(/"(?:email_address|permission_id|principal_value)"/iu);
    expect(migration).not.toMatch(
      /GRANT\s+(?:UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)[^;]*google_drive_object_acl/iu,
    );
    expect(migration).toContain("opengeni_private.google_drive_object_acl_runtime_capabilities");
    expect(migration).toContain("opengeni_private.google_drive_object_acl_capability_active()");
    expect(migration).toContain("google_drive_object_acl_capability_read");
    expect(migration).toContain("current_user = pg_catalog.pg_get_userbyid");
    expect(migration).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)[^;]*google_drive_object_acl_runtime_capabilities/iu,
    );
    for (const routine of [
      "google_drive_file_authorized(uuid, uuid, text, uuid)",
      "google_drive_document_citation(uuid, uuid, text, uuid, uuid)",
    ] as const) {
      expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(routine);
      expect(migration).toContain("SECURITY DEFINER");
      expect(migration).toContain(`REVOKE ALL ON FUNCTION %I.${routine.replaceAll(", ", ",")}`);
      expect(provisioner).toContain(routine.replaceAll(", ", ","));
    }
    expect(migration).toContain(
      "Every Google Drive object that has ever protected these exact bytes",
    );
    expect(migration).toContain("WHERE NOT EXISTS");
    expect(migration).toContain("evidence.expires_at > pg_catalog.statement_timestamp()");
  });

  test("denies mixed shared bytes until every Drive protector authorizes the subject", async () => {
    if (!shared || !client || !appProbe) return;

    const suffix = crypto.randomUUID();
    const alice = `user:drive-owner-${suffix}`;
    const bob = `user:drive-viewer-${suffix}`;
    const alicePermission = `permission-owner-${suffix}`;
    const bobPermission = `permission-viewer-${suffix}`;
    const bobEmail = `viewer-${suffix}@example.test`;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name)
      values (${`drive-acl-${suffix}`})
      returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, ${`drive-acl-${suffix}`})
      returning id`;
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values
        (${account!.id}, ${workspace!.id}, ${alice}, 'Alice', 'owner', '[]'::jsonb),
        (${account!.id}, ${workspace!.id}, ${bob}, 'Bob', 'member', '[]'::jsonb)`;

    const sourceConnection = await createConnection(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      subjectId: alice,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      credentialEncrypted: "test-only-encrypted-source-credential",
      grantedScopes: [driveScope],
      metadata: {
        accessMode: "readonly",
        googlePermissionId: alicePermission,
        googleEmail: `owner-${suffix}@example.test`,
        lifecycle: { state: "active" },
      },
      createdBySubjectId: alice,
    });
    const viewerConnection = await createConnection(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      subjectId: bob,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      credentialEncrypted: "test-only-encrypted-viewer-credential",
      grantedScopes: [driveScope],
      metadata: {
        accessMode: "readonly",
        googlePermissionId: bobPermission,
        googleEmail: bobEmail,
        lifecycle: { state: "active" },
      },
      createdBySubjectId: bob,
    });
    const actor = {
      kind: "human" as const,
      subjectId: alice,
      initiatingHumanSubjectId: alice,
    };
    const scope = {
      kind: "workspace" as const,
      workspaceId: workspace!.id,
      subjectId: null,
    };
    const provider = await upsertKnowledgeProvider(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerKey: "google-drive",
      externalTenantId: `tenant-${suffix}`,
      operationId: `provider-${suffix}`,
      actor,
    });
    const source = await upsertKnowledgeSource(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scope,
      providerId: provider.id,
      externalSourceId: `folder-${suffix}`,
      sourceKind: "google-drive-folder",
      sourceUri: `https://drive.google.com/drive/folders/${suffix}`,
      operationId: `source-${suffix}`,
      actor,
    });
    const acl = await appendKnowledgeSourceAclVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      sourceId: source.id,
      audience: scope,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedAclGeneration: 0,
      aclVersion: "drive-source-selected",
      agentAccess: false,
      operationId: `source-acl-${suffix}`,
      reasonCode: "source_selected",
      actor,
    });
    const task = await createScheduledTask(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      name: `Drive ACL ${suffix}`,
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `drive-acl-${suffix}`,
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      action: {
        kind: "knowledge_source_sync",
        sourceId: source.id,
        sourceGeneration: source.syncGeneration,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        sourceConfigGeneration: 1,
        controlWorkspaceId: workspace!.id,
        providerCoordinationKey: `google-drive:${alicePermission}:my-drive`,
        destination: scope,
        initiatingSubjectId: alice,
        allDescendants: true,
        connection: {
          connectionId: sourceConnection.id,
          connectionVersion: sourceConnection.version,
          providerDomain: "googleapis.com",
          kind: "oauth2",
          ownerSubjectId: alice,
        },
        limits: {
          maxItems: 10,
          maxBytes: 10_000,
          maxFileBytes: 10_000,
          maxProviderRequests: 10,
          maxElapsedSeconds: 10,
          maxConcurrency: 1,
          maxFailureDetails: 5,
        },
      },
      agentConfig: { prompt: "sync", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    await ensureKnowledgeSourceSyncState(client.db, task);
    const run = await createScheduledTaskRun(client.db, {
      workspaceId: workspace!.id,
      taskId: task.id,
      triggerType: "manual",
      producerKey: `drive-acl-run-${suffix}`,
    });
    const sharedFile = await ensureKnowledgeSourceBlobFile(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      fileId: crypto.randomUUID(),
      filename: "shared-drive-bytes.txt",
      safeFilename: "shared-drive-bytes.txt",
      contentType: "text/plain",
      sizeBytes: 12,
      sha256: "a".repeat(64),
      bucket: "test",
      objectKey: `workspaces/${workspace!.id}/knowledge/blobs/${suffix}`,
    });
    const [base] = await shared.admin<{ id: string }[]>`
      insert into document_bases (account_id, workspace_id, name)
      values (${account!.id}, ${workspace!.id}, ${`Drive ACL ${suffix}`})
      returning id`;
    const subjectlessOrdinaryRead = await requireFileForSubject(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      subjectId: null,
      fileId: sharedFile.id,
    });
    expect(subjectlessOrdinaryRead.id).toBe(sharedFile.id);

    const createProtectedObject = async (name: "a" | "b"): Promise<ProtectedObject> => {
      const externalObjectId = `drive-object-${name}-${suffix}`;
      const [document] = await shared!.admin<{ id: string }[]>`
        insert into documents (
          account_id, workspace_id, base_id, file_id, title, source_kind,
          source_uri, source_external_id, source_version, knowledge_source_identity,
          authority_kind, authority_workspace_id, visibility, created_by, agent_access
        ) values (
          ${account!.id}, ${workspace!.id}, ${base!.id}, ${sharedFile.id},
          ${`Drive object ${name.toUpperCase()}`}, 'document',
          ${`https://drive.google.com/open?id=${externalObjectId}`}, ${externalObjectId},
          ${`revision-${name}`}, ${crypto.randomUUID()}, 'workspace', ${workspace!.id},
          'workspace', ${alice}, false
        ) returning id`;
      const object = await upsertKnowledgeSourceObject(client!.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sourceId: source.id,
        externalObjectId,
        operationId: `object-${name}-${suffix}`,
        actor,
      });
      const version = await appendKnowledgeDocumentVersion(client!.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        objectId: object.id,
        expectedSourceLifecycleGeneration: source.lifecycleGeneration,
        expectedObjectLifecycleGeneration: object.lifecycleGeneration,
        expectedVersionGeneration: 0,
        externalVersionId: `revision-${name}`,
        contentSha256: "a".repeat(64),
        ingestionKey: `drive:${externalObjectId}:revision-${name}`,
        sourceMetadata: { providerRevision: `revision-${name}` },
        aclVersionId: acl.id,
        aclGeneration: acl.generation,
        documentId: document!.id,
        fileId: sharedFile.id,
        operationId: `version-${name}-${suffix}`,
        reasonCode: "source_content_observed",
        actor,
      });
      const obligation = await enqueueKnowledgeSourceSyncIndexObligation(client!.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        scheduledTaskRunId: run.id,
        sourceId: source.id,
        sourceSyncGeneration: source.syncGeneration,
        initiatingSubjectId: alice,
        externalObjectId,
        knowledgeSourceObjectId: object.id,
        knowledgeDocumentVersionId: version.id,
        documentId: document!.id,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        objectLifecycleGeneration: object.lifecycleGeneration,
        objectVersionGeneration: version.versionGeneration,
        citationLocator: {
          provider: "google_drive",
          externalObjectId,
          sourceUri: `https://drive.google.com/open?id=${externalObjectId}`,
        },
      });
      await settleKnowledgeSourceSyncIndexObligation(client!.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: obligation.id,
        status: "indexed",
      });
      return {
        externalObjectId,
        objectId: object.id,
        versionId: version.id,
        versionGeneration: version.versionGeneration,
        documentId: document!.id,
        obligationId: obligation.id,
        providerRevision: `revision-${name}`,
      };
    };

    let objectA = await createProtectedObject("a");
    const objectB = await createProtectedObject("b");
    await shared.admin`
      insert into documents (
        account_id, workspace_id, base_id, file_id, title, source_kind,
        authority_kind, authority_workspace_id, visibility, created_by, agent_access
      ) values (
        ${account!.id}, ${workspace!.id}, ${base!.id}, ${sharedFile.id},
        'Ordinary duplicate mapping', 'manual_upload', 'workspace', ${workspace!.id},
        'workspace', ${alice}, true
      )`;

    const recordEvidence = async (
      object: ProtectedObject,
      operation: string,
      expiresAt: Date,
    ): Promise<void> => {
      await recordGoogleDriveObjectAclEvidence(client!.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        obligationId: object.obligationId,
        connectionId: sourceConnection.id,
        connectionVersion: sourceConnection.version,
        sourceGooglePermissionId: alicePermission,
        sourceSyncGeneration: source.syncGeneration,
        sourceConfigGeneration: 1,
        sourceLifecycleGeneration: source.lifecycleGeneration,
        objectLifecycleGeneration: 1,
        objectVersionGeneration: object.versionGeneration,
        providerRevision: object.providerRevision,
        driveId: `drive-${suffix}`,
        aclRevision: `acl-${operation}`,
        eligibility: "eligible",
        observedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        citationLocator: {
          provider: "google_drive",
          externalObjectId: object.externalObjectId,
          sourceUri: `https://drive.google.com/open?id=${object.externalObjectId}`,
        },
        operationId: operation,
        principals: [
          {
            type: "user",
            permissionId: bobPermission,
            emailAddress: bobEmail,
            role: "reader",
          },
        ],
      });
    };
    const expectDenied = async (): Promise<void> => {
      await expect(
        requireFileForSubject(client!.db, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          subjectId: bob,
          fileId: sharedFile.id,
        }),
      ).rejects.toThrow(`File not found: ${sharedFile.id}`);
      expect(
        await getFilesForSubject(client!.db, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          subjectId: bob,
          fileIds: [sharedFile.id],
        }),
      ).toEqual([]);
    };
    const expectAllowed = async (): Promise<void> => {
      const file = await requireFileForSubject(client!.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        subjectId: bob,
        fileId: sharedFile.id,
      });
      expect(file.id).toBe(sharedFile.id);
      expect(
        (
          await getFilesForSubject(client!.db, {
            accountId: account!.id,
            workspaceId: workspace!.id,
            subjectId: bob,
            fileIds: [sharedFile.id],
          })
        ).map((authorized) => authorized.id),
      ).toEqual([sharedFile.id]);
    };

    const longExpiry = new Date(Date.now() + 60_000);
    await recordEvidence(objectA, `evidence-a-1-${suffix}`, longExpiry);
    await expectDenied();
    await recordEvidence(objectB, `evidence-b-1-${suffix}`, longExpiry);
    await expectAllowed();

    const citation = await appProbe.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
      await tx`select set_config('opengeni.subject_id', ${bob}, true)`;
      const [row] = await tx<Array<{ citation: Record<string, unknown> | null }>>`
        select google_drive_document_citation(
          ${account!.id}::uuid,
          ${workspace!.id}::uuid,
          ${bob},
          ${objectA.documentId}::uuid,
          ${sharedFile.id}::uuid
        ) as citation`;
      return row!.citation;
    });
    expect(citation).toMatchObject({
      provider: "google_drive",
      externalObjectId: objectA.externalObjectId,
      providerRevision: objectA.providerRevision,
      sourceVersion: objectA.providerRevision,
      driveId: `drive-${suffix}`,
      deepLink: `https://drive.google.com/open?id=${objectA.externalObjectId}`,
    });
    const citationText = JSON.stringify(citation);
    expect(citationText).not.toContain(bobEmail);
    expect(citationText).not.toContain(bobPermission);
    expect(citationText).not.toContain(sourceConnection.id);
    expect(citationText).not.toContain(viewerConnection.id);

    await shared.admin`
      update connections set granted_scopes = '[]'::jsonb where id = ${viewerConnection.id}`;
    await expectDenied();
    await shared.admin`
      update connections set granted_scopes = ${shared.admin.json([driveScope])}::jsonb
      where id = ${viewerConnection.id}`;
    await expectAllowed();

    await shared.admin`
      update connections set granted_scopes = '[]'::jsonb where id = ${sourceConnection.id}`;
    await expectDenied();
    await shared.admin`
      update connections set granted_scopes = ${shared.admin.json([driveScope])}::jsonb
      where id = ${sourceConnection.id}`;
    await expectAllowed();

    const refreshedVersion = await appendKnowledgeDocumentVersion(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      objectId: objectA.objectId,
      expectedSourceLifecycleGeneration: source.lifecycleGeneration,
      expectedObjectLifecycleGeneration: 1,
      expectedVersionGeneration: objectA.versionGeneration,
      externalVersionId: "revision-a-2",
      contentSha256: "a".repeat(64),
      ingestionKey: `drive:${objectA.externalObjectId}:revision-a-2`,
      sourceMetadata: { providerRevision: "revision-a-2" },
      aclVersionId: acl.id,
      aclGeneration: acl.generation,
      documentId: objectA.documentId,
      fileId: sharedFile.id,
      operationId: `version-a-2-${suffix}`,
      reasonCode: "source_content_observed",
      actor,
    });
    const refreshedObligation = await enqueueKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      scheduledTaskRunId: run.id,
      sourceId: source.id,
      sourceSyncGeneration: source.syncGeneration,
      initiatingSubjectId: alice,
      externalObjectId: objectA.externalObjectId,
      knowledgeSourceObjectId: objectA.objectId,
      knowledgeDocumentVersionId: refreshedVersion.id,
      documentId: objectA.documentId,
      sourceConfigGeneration: 1,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      objectLifecycleGeneration: 1,
      objectVersionGeneration: refreshedVersion.versionGeneration,
      citationLocator: {
        provider: "google_drive",
        externalObjectId: objectA.externalObjectId,
        sourceUri: `https://drive.google.com/open?id=${objectA.externalObjectId}`,
      },
    });
    await settleKnowledgeSourceSyncIndexObligation(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      obligationId: refreshedObligation.id,
      status: "indexed",
    });
    await expectDenied();
    objectA = {
      ...objectA,
      versionId: refreshedVersion.id,
      versionGeneration: refreshedVersion.versionGeneration,
      obligationId: refreshedObligation.id,
      providerRevision: "revision-a-2",
    };
    await recordEvidence(objectA, `evidence-a-2-${suffix}`, longExpiry);
    await expectAllowed();

    await shared.admin`
      update connections
      set status = 'revoked',
          metadata = jsonb_set(metadata, '{lifecycle,state}', '"disconnected"'::jsonb, true)
      where id = ${viewerConnection.id}`;
    await expectDenied();
    await shared.admin`
      update connections
      set status = 'active',
          metadata = jsonb_set(metadata, '{lifecycle,state}', '"active"'::jsonb, true)
      where id = ${viewerConnection.id}`;
    await expectAllowed();

    await shared.admin`
      update connections
      set status = 'revoked',
          metadata = jsonb_set(metadata, '{lifecycle,state}', '"disconnected"'::jsonb, true)
      where id = ${sourceConnection.id}`;
    await expectDenied();
    await shared.admin`
      update connections
      set status = 'active',
          metadata = jsonb_set(metadata, '{lifecycle,state}', '"active"'::jsonb, true)
      where id = ${sourceConnection.id}`;
    await expectAllowed();

    const shortExpiry = new Date(Date.now() + 1_500);
    await recordEvidence(objectA, `evidence-a-expiring-${suffix}`, shortExpiry);
    await recordEvidence(objectB, `evidence-b-expiring-${suffix}`, shortExpiry);
    await expectAllowed();
    await Bun.sleep(1_700);
    await expectDenied();

    // FORCE RLS also applies to a non-superuser table/function owner. Prove
    // that the private transaction capability exposes the hidden protector to
    // the exact functions without granting the runtime role a way to create a
    // capability. Without the capability policies this cross-workspace call
    // would miss the source-workspace protector and incorrectly return true.
    const definerRole = `drive_acl_owner_${suffix.replaceAll("-", "").slice(0, 24)}`;
    const [requestWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, ${`drive-acl-request-${suffix}`})
      returning id`;
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${requestWorkspace!.id}, ${bob}, 'Bob', 'member', '[]'::jsonb
      )`;
    await shared.admin.unsafe(`
      CREATE ROLE "${definerRole}"
        NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;
      GRANT USAGE ON SCHEMA public, opengeni_private TO "${definerRole}";
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO "${definerRole}";
      ALTER TABLE opengeni_private.google_drive_object_acl_runtime_capabilities
        OWNER TO "${definerRole}";
      ALTER FUNCTION opengeni_private.google_drive_object_acl_capability_active()
        OWNER TO "${definerRole}";
      ALTER TABLE public.connections OWNER TO "${definerRole}";
      ALTER TABLE public.files OWNER TO "${definerRole}";
      ALTER TABLE public.google_drive_object_acl_evidence OWNER TO "${definerRole}";
      ALTER TABLE public.google_drive_object_acl_principals OWNER TO "${definerRole}";
      ALTER TABLE public.knowledge_document_versions OWNER TO "${definerRole}";
      ALTER TABLE public.knowledge_providers OWNER TO "${definerRole}";
      ALTER TABLE public.knowledge_source_objects OWNER TO "${definerRole}";
      ALTER TABLE public.knowledge_source_sync_index_obligations OWNER TO "${definerRole}";
      ALTER TABLE public.knowledge_source_sync_states OWNER TO "${definerRole}";
      ALTER TABLE public.knowledge_sources OWNER TO "${definerRole}";
      ALTER FUNCTION public.google_drive_file_authorized(uuid, uuid, text, uuid)
        OWNER TO "${definerRole}";
      ALTER FUNCTION public.google_drive_document_citation(uuid, uuid, text, uuid, uuid)
        OWNER TO "${definerRole}";
    `);
    const [definerPosture] = await shared.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${definerRole}`;
    expect(definerPosture).toEqual({ superuser: false, bypassRls: false });
    const hiddenProtectorAuthorized = await appProbe.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${requestWorkspace!.id}, true)`;
      await tx`select set_config('opengeni.subject_id', ${bob}, true)`;
      const [row] = await tx<Array<{ authorized: boolean }>>`
        select google_drive_file_authorized(
          ${account!.id}::uuid,
          ${requestWorkspace!.id}::uuid,
          ${bob},
          ${sharedFile.id}::uuid
        ) as authorized`;
      return row!.authorized;
    });
    expect(hiddenProtectorAuthorized).toBe(false);

    const [posture] = await shared.admin<
      Array<{
        evidenceRls: boolean;
        evidenceForced: boolean;
        principalRls: boolean;
        principalForced: boolean;
        rawPrincipalColumns: number;
      }>
    >`
      select
        evidence.relrowsecurity as "evidenceRls",
        evidence.relforcerowsecurity as "evidenceForced",
        principal.relrowsecurity as "principalRls",
        principal.relforcerowsecurity as "principalForced",
        (
          select count(*)::int from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'google_drive_object_acl_principals'
            and column_name in ('email_address', 'permission_id', 'principal_value')
        ) as "rawPrincipalColumns"
      from pg_class evidence
      cross join pg_class principal
      where evidence.oid = 'google_drive_object_acl_evidence'::regclass
        and principal.oid = 'google_drive_object_acl_principals'::regclass`;
    expect(posture).toEqual({
      evidenceRls: true,
      evidenceForced: true,
      principalRls: true,
      principalForced: true,
      rawPrincipalColumns: 0,
    });
  }, 120_000);
});
