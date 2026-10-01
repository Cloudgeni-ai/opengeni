import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  appendArchivedSessionEvents,
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createFileUpload,
  createOrganizationApiKey,
  completeFileUpload,
  ensureManagedAccessForUser,
  forkSessionContent,
  getFilesForSubject,
  inspectRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
  provisionRoles,
  getArchivedSessionImportId,
  getSessionForSubject,
  importArchivedSession,
  initializeSessionStartAtomically,
  listSessionEvents,
  nestedPostgresSqlState,
  revokeOrganizationApiKey,
  readSessionFileAttachments,
  setSubjectRlsContext,
  submitHumanPromptInTransaction,
  withRlsContext,
  withSessionRlsActorContext,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("archived-session-imports");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL unavailable");
    return;
  }
  client = createDb(shared.appUrl, { max: 12 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture() {
  if (!client || !shared) throw new Error("PostgreSQL unavailable");
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "archive-test",
    accountExternalId: id,
    accountName: "Import test",
    workspaceExternalSource: "archive-test",
    workspaceExternalId: id,
    workspaceName: "Import test",
    subjectId: `importer:${id}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    fileOwnerSubjectId: null,
    createdBy: { kind: "service" as const, subjectId: grant.subjectId },
  };
}

const event = (text: string) => ({
  type: "user.message" as const,
  createdAt: "2020-02-03T04:05:06Z",
  payload: { text },
});

async function humanFixture() {
  if (!client || !shared) throw new Error("PostgreSQL unavailable");
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Archive uploader",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'archive-test') on conflict do nothing`;
  await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${grant.accountId},true,1,null) on conflict(account_id) do update set enabled=true`;
  const owner = { subjectId: grant.subjectId, privateFileOwnerSubjectId: grant.subjectId };
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    fileOwnerSubjectId: grant.subjectId,
    requireLiveSubject: true,
    createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
  };
  const upload = (subjectId = grant.subjectId) =>
    withSessionRlsActorContext({ subjectId, privateFileOwnerSubjectId: subjectId }, async () => {
      const created = await createFileUpload(client!.db, {
        ...scope,
        privateOwnerSubjectId: subjectId,
        fileId: crypto.randomUUID(),
        filename: "archive.png",
        safeFilename: "archive.png",
        contentType: "image/png",
        sizeBytes: 3,
        bucket: "test",
        objectKey: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      return completeFileUpload(client!.db, scope.workspaceId, created.uploadId);
    });
  return { scope, owner, upload };
}

describe("archived import PostgreSQL persistence", () => {
  test("create and append acquire membership before the shared tenancy fence", async () => {
    if (!client || !shared) return;
    for (const operation of ["create", "append"] as const) {
      const scope = await fixture();
      const payload = {
        importId: "lock-prefix",
        title: "Lock prefix",
        createdAt: "2019-01-01T00:00:00Z",
        events: [event("initial")],
      };
      const imported =
        operation === "append"
          ? await importArchivedSession(client.db, { ...scope, payload })
          : null;
      let pending: Promise<{ error: unknown }> | undefined;
      try {
        await shared.admin.begin(async (blocker) => {
          const [backend] = await blocker`select pg_backend_pid() as pid`;
          await blocker`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${scope.accountId}`},0))`;
          const mutation = imported
            ? appendArchivedSessionEvents(client!.db, {
                ...scope,
                sessionId: imported.session.id,
                importId: payload.importId,
                payload: { batchId: "next", offset: 1, events: [event("next")] },
              })
            : importArchivedSession(client!.db, { ...scope, payload });
          pending = mutation.then(
            () => ({ error: null }),
            (error: unknown) => ({ error }),
          );
          let waiting = false;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const [row] = await shared!.admin`select exists(
              select 1 from pg_stat_activity
              where datname=current_database()
                and ${backend!.pid}::integer=any(pg_blocking_pids(pid))
            ) as waiting`;
            if (row!.waiting) {
              waiting = true;
              break;
            }
            await Bun.sleep(20);
          }
          expect(waiting, operation).toBe(true);
          // The exclusive tenancy prefix must remain available while import
          // waits for membership, otherwise fork/move can form a lock cycle.
          const [tenancy] = await blocker`select pg_try_advisory_xact_lock(
            hashtextextended(${`session-tenancy:${scope.workspaceId}`},0)
          ) as acquired`;
          expect(tenancy!.acquired, operation).toBe(true);
        });
      } finally {
        if (pending) expect((await pending).error, operation).toBeNull();
      }
    }
  }, 60_000);

  test("the actual pre0555 evaluator and provisioner accept the complete post0555 database", async () => {
    if (!client || !shared) return;
    const repoRoot = new URL("../../..", import.meta.url).pathname;
    // Exact immutable feature base before 0555; do not substitute new constants
    // or filter its catalog. Both binaries inspect the entire real database.
    const oldRevision = "bb2f7ea7febacf6fde998625fb1303e35f148c79";
    const root = await mkdtemp(`${repoRoot}/.archived-import-old-runtime-`);
    try {
      for (const name of ["runtime-posture.ts", "role-relationships.ts", "provision-roles.ts"]) {
        await writeFile(
          `${root}/${name}`,
          execFileSync("git", ["show", `${oldRevision}:packages/db/src/${name}`], {
            cwd: repoRoot,
          }),
        );
      }
      const old = await import(pathToFileURL(`${root}/runtime-posture.ts`).href);
      const oldProvision = await import(pathToFileURL(`${root}/provision-roles.ts`).href);
      const options = {
        expectedRole: "opengeni_app",
        rlsStrategy: "force" as const,
        targetSchema: "public",
        organizationTenancyCanonicalActivationEnabled: true,
      };
      expect(old.FORCE_RLS_TABLES).not.toContain("session_import_batches");
      expect(
        old.evaluateRuntimeDatabasePosture(
          await old.inspectRuntimeDatabasePosture(client.db, options),
          options,
        ),
      ).toEqual([]);
      await oldProvision.provisionRoles(shared.adminUrl, {
        appRole: "opengeni_app",
        appPassword: new URL(shared.appUrl).password,
        rlsStrategy: "force",
      });
      expect(
        old.evaluateRuntimeDatabasePosture(
          await old.inspectRuntimeDatabasePosture(client.db, options),
          options,
        ),
      ).toEqual([]);
      await provisionRoles(shared.adminUrl, {
        appRole: "opengeni_app",
        appPassword: new URL(shared.appUrl).password,
        rlsStrategy: "force",
      });
      const posture = await inspectRuntimeDatabasePosture(client.db, options);
      expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
      expect(posture.tables.some((table) => table.name === "session_import_batches")).toBe(false);
      expect(
        posture.privateTables.find((table) => table.name === "session_import_batches"),
      ).toMatchObject({
        rlsEnabled: true,
        rlsForced: true,
        select: false,
        insert: false,
        update: false,
        delete: false,
      });
      for (const routine of posture.privateRoutines.filter((candidate) =>
        candidate.name.includes("archived_session_import_batch"),
      )) {
        expect(routine).toMatchObject({
          execute: true,
          publicExecute: false,
          securityDefiner: true,
          configuration: ["search_path=pg_catalog, public, pg_temp"],
        });
      }
      expect(
        old.evaluateRuntimeDatabasePosture(
          await old.inspectRuntimeDatabasePosture(client.db, options),
          options,
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("exact 256KiB import events retain canonical source bytes above the 64KiB preview bound", async () => {
    if (!client || !shared) return;
    const scope = await fixture();
    const overhead = Buffer.byteLength(JSON.stringify(event("")));
    const text = "x".repeat(256 * 1024 - overhead);
    expect(Buffer.byteLength(JSON.stringify(event(text)))).toBe(256 * 1024);
    const imported = await importArchivedSession(client.db, {
      ...scope,
      payload: {
        importId: "full-size",
        title: "Full source",
        createdAt: "2019-01-01T00:00:00Z",
        events: [event(text)],
      },
    });
    expect(imported.events[0]!.payload).toEqual({ text });
    const appended = await appendArchivedSessionEvents(client.db, {
      ...scope,
      sessionId: imported.session.id,
      importId: "full-size",
      payload: { batchId: "full-size-append", offset: 1, events: [event(text)] },
    });
    expect(appended.events[0]!.payload).toEqual({ text });
    const rows = await shared.admin<
      { text: string }[]
    >`select payload->>'text' as text from session_events where session_id=${imported.session.id} order by sequence`;
    expect(rows.map((row) => row.text)).toEqual([text, text]);
    await expect(
      appendArchivedSessionEvents(client.db, {
        ...scope,
        sessionId: imported.session.id,
        importId: "full-size",
        payload: { batchId: "oversize", offset: 2, events: [event(`${text}x`)] },
      }),
    ).rejects.toThrow("Imported event exceeds");
    const [count] =
      await shared.admin`select count(*)::int as count from session_events where session_id=${imported.session.id}`;
    expect(count!.count).toBe(2);
  });

  test("import attachment acceptance shares only completed own uploads through the exact session", async () => {
    if (!client || !shared) return;
    const { scope, owner, upload } = await humanFixture();
    const first = await upload();
    const second = await upload();
    const viewer = "user:archive-reader";
    const imported = await withSessionRlsActorContext(owner, () =>
      importArchivedSession(client!.db, {
        ...scope,
        payload: {
          importId: "attachment-shared",
          title: "Shared attachment",
          createdAt: "2019-01-01T00:00:00Z",
          events: [
            { ...event("upload"), payload: { resources: [{ kind: "file", fileId: first.id }] } },
          ],
        },
      }),
    );
    await withSessionRlsActorContext(owner, () =>
      appendArchivedSessionEvents(client!.db, {
        ...scope,
        sessionId: imported.session.id,
        importId: "attachment-shared",
        payload: {
          batchId: "nested-attachment",
          offset: 1,
          events: [
            {
              ...event("nested upload"),
              payload: { nested: { fileIds: [second.id.toUpperCase()] } },
            },
          ],
        },
      }),
    );
    const read = (sessionId: string, subjectId: string) =>
      withSessionRlsActorContext({ subjectId }, () =>
        readSessionFileAttachments(client!.db, {
          ...scope,
          fileIds: [first.id, second.id],
          access: { sessionId, authorityEpoch: 1, actor: { kind: "subject", subjectId } },
        }),
      );
    expect((await read(imported.session.id, viewer)).map((file) => file.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(
      await getFilesForSubject(client.db, {
        ...scope,
        subjectId: viewer,
        fileIds: [first.id, second.id],
      }),
    ).toEqual([]);
    const privateImport = await withSessionRlsActorContext(owner, () =>
      importArchivedSession(client!.db, {
        ...scope,
        payload: {
          importId: "attachment-private",
          title: "Private attachment",
          createdAt: "2019-01-01T00:00:00Z",
          visibility: "user_private",
          events: [{ ...event("private"), payload: { fileId: first.id } }],
        },
      }),
    );
    expect((await read(privateImport.session.id, scope.subjectId)).map((file) => file.id)).toEqual([
      first.id,
    ]);
    await expect(read(privateImport.session.id, viewer)).rejects.toThrow();
    const empty = await withSessionRlsActorContext(owner, () =>
      importArchivedSession(client!.db, {
        ...scope,
        payload: {
          importId: "attachment-unrelated",
          title: "No attachments",
          createdAt: "2019-01-01T00:00:00Z",
        },
      }),
    );
    expect(await read(empty.session.id, viewer)).toEqual([]);
    const foreign = await upload("user:foreign-uploader");
    await expect(
      withSessionRlsActorContext(owner, () =>
        appendArchivedSessionEvents(client!.db, {
          ...scope,
          sessionId: imported.session.id,
          importId: "attachment-shared",
          payload: {
            batchId: "foreign",
            offset: 2,
            events: [{ ...event("foreign"), payload: { fileId: foreign.id } }],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_INVALID_FILE" });
    const [counts] =
      await shared.admin`select (select count(*)::int from session_turns where session_id=${imported.session.id}) as turns, (select count(*)::int from session_history_items where session_id=${imported.session.id}) as history, (select count(*)::int from session_workflow_wake_outbox where session_id=${imported.session.id}) as wakes`;
    expect(counts).toEqual({ turns: 0, history: 0, wakes: 0 });
    const grants =
      await shared.admin`select accepted_event_id from opengeni_private.session_file_attachments where session_id=${imported.session.id}`;
    expect(grants).toHaveLength(2);
    expect(new Set(grants.map((grant) => grant.accepted_event_id)).size).toBe(2);
  });

  test("rolling fork routines cannot create executable copies of an imported source", async () => {
    if (!client || !shared) return;
    const { scope, owner } = await humanFixture();
    const imported = await withSessionRlsActorContext(owner, () =>
      importArchivedSession(client!.db, {
        ...scope,
        payload: {
          importId: "no-fork",
          title: "No fork",
          createdAt: "2019-01-01T00:00:00Z",
          events: [event("source input")],
        },
      }),
    );
    for (const destinationVisibility of ["workspace_shared", "user_private"] as const) {
      let failure: unknown;
      try {
        await withSessionRlsActorContext(owner, () =>
          forkSessionContent(client!.db, {
            sourceWorkspaceId: scope.workspaceId,
            sourceSessionId: imported.session.id,
            destinationWorkspaceId: scope.workspaceId,
            destinationVisibility,
            workspaceSharedAcknowledged: false,
            actorSubjectId: scope.subjectId,
            operationKey: crypto.randomUUID(),
          }),
        );
      } catch (error) {
        failure = error;
      }
      expect(nestedPostgresSqlState(failure)).toBe("OG002");
    }
    const [forks] =
      await shared.admin`select count(*)::int as count from sessions where forked_from_session_id=${imported.session.id}`;
    expect(forks!.count).toBe(0);
  });

  test("concurrent creates converge; immutable initial identity includes all source data and actor", async () => {
    if (!client || !shared) return;
    const scope = await fixture();
    const sourceTurnId = crypto.randomUUID();
    const payload = {
      importId: "same",
      title: "Source history",
      createdAt: "2019-01-01T00:00:00Z",
      events: [{ ...event("a\u0000b\uD800"), turnId: sourceTurnId }],
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => importArchivedSession(client!.db, { ...scope, payload })),
    );
    expect(new Set(results.map((result) => result.session.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const session = results[0]!.session;
    expect(session.importedArchive).toMatchObject({ importId: "same", readOnly: true });
    expect(session.createdAt).toBe("2019-01-01T00:00:00.000Z");
    expect(session.title).toBe("Source history");
    expect(session.status).toBe("idle");
    expect(session.activeTurnId).toBeNull();
    expect(session.temporalWorkflowId).toBeNull();
    const events = await listSessionEvents(client.db, scope.workspaceId, session.id, {
      limit: 100,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 1,
      occurredAt: "2020-02-03T04:05:06.000Z",
      turnId: sourceTurnId,
      turnAssociation: null,
      payload: { text: "a\u0000b\uD800" },
    });
    for (const changed of [
      { ...payload, title: "Changed" },
      { ...payload, createdAt: "2020-01-01T00:00:00Z" },
      { ...payload, events: [event("changed")] },
      { ...payload, events: [] },
    ]) {
      await expect(
        importArchivedSession(client.db, { ...scope, payload: changed }),
      ).rejects.toMatchObject({ code: "SESSION_IMPORT_CONFLICT" });
    }
    await expect(
      importArchivedSession(client.db, {
        ...scope,
        subjectId: "other-importer",
        createdBy: { kind: "service", subjectId: "other-importer" },
        payload,
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_CONFLICT" });
    for (const table of [
      "session_turns",
      "session_history_items",
      "session_goals",
      "session_workflow_wake_outbox",
    ]) {
      const rows = await shared.admin.unsafe(
        `select count(*)::int as count from ${table} where session_id = $1`,
        [session.id],
      );
      expect(rows[0]!.count).toBe(0);
    }
  }, 60_000);

  test("batch replay is exact and offset races commit a single suffix", async () => {
    if (!client || !shared) return;
    const scope = await fixture();
    const imported = await importArchivedSession(client.db, {
      ...scope,
      payload: { importId: "append", title: "Append", createdAt: "2019-01-01T00:00:00Z" },
    });
    const appendScope = { ...scope, importId: "append", sessionId: imported.session.id };
    const payload = { batchId: "batch-1", offset: 0, events: [event("first"), event("second")] };
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        appendArchivedSessionEvents(client!.db, { ...appendScope, payload }),
      ),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.map((result) => result.nextOffset)).toEqual(Array(6).fill(2));
    await expect(
      appendArchivedSessionEvents(client.db, {
        ...appendScope,
        payload: { ...payload, offset: 1 },
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_CONFLICT" });
    await expect(
      appendArchivedSessionEvents(client.db, {
        ...appendScope,
        payload: { ...payload, events: [event("changed")] },
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_CONFLICT" });
    await expect(
      appendArchivedSessionEvents(client.db, {
        ...appendScope,
        payload: { batchId: "wrong-offset", offset: 0, events: [event("no")] },
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_OFFSET_CONFLICT" });
    const race = await Promise.allSettled(
      ["a", "b"].map((batchId) =>
        appendArchivedSessionEvents(client!.db, {
          ...appendScope,
          payload: { batchId, offset: 2, events: [event(batchId)] },
        }),
      ),
    );
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (await appendArchivedSessionEvents(client.db, { ...appendScope, payload })).nextOffset,
    ).toBe(2);
    expect(
      (
        await listSessionEvents(client.db, scope.workspaceId, imported.session.id, { limit: 100 })
      ).map((row) => row.sequence),
    ).toEqual([1, 2, 3]);
    const replay = await importArchivedSession(client.db, {
      ...scope,
      payload: { importId: "append", title: "Append", createdAt: "2019-01-01T00:00:00Z" },
    });
    expect(replay.nextOffset).toBe(3);
    expect(replay.created).toBe(false);
  }, 60_000);

  test("ledger FORCE-RLS isolates workspace and importing subject", async () => {
    if (!client || !shared) return;
    const scope = await fixture();
    const other = await fixture();
    const imported = await importArchivedSession(client.db, {
      ...scope,
      payload: { importId: "isolated", title: "RLS", createdAt: "2019-01-01T00:00:00Z" },
    });
    await appendArchivedSessionEvents(client.db, {
      ...scope,
      sessionId: imported.session.id,
      importId: "isolated",
      payload: { batchId: "one", offset: 0, events: [event("one")] },
    });
    const ledger = (accountId: string, workspaceId: string, subjectId: string) =>
      withRlsContext(client!.db, { accountId, workspaceId }, async (tx) => {
        await setSubjectRlsContext(tx, subjectId);
        return tx.select().from(schema.sessionImportBatches);
      });
    let denied: unknown;
    try {
      await ledger(scope.accountId, scope.workspaceId, scope.subjectId);
    } catch (error) {
      denied = error;
    }
    expect(nestedPostgresSqlState(denied)).toBe("42501");
    // Temporary SELECT in this isolated test database proves FORCE RLS still
    // protects the private relation if an operator accidentally adds a grant.
    await shared.admin`grant select on opengeni_private.session_import_batches to opengeni_app`;
    try {
      expect(await ledger(scope.accountId, scope.workspaceId, scope.subjectId)).toHaveLength(1);
      expect(await ledger(scope.accountId, scope.workspaceId, "another-subject")).toHaveLength(0);
      expect(await ledger(other.accountId, other.workspaceId, scope.subjectId)).toHaveLength(0);
    } finally {
      await shared.admin`revoke select on opengeni_private.session_import_batches from opengeni_app`;
    }
    expect(
      await getArchivedSessionImportId(client.db, scope.workspaceId, "another-subject", "isolated"),
    ).toBeNull();
    await expect(
      appendArchivedSessionEvents(client.db, {
        ...scope,
        subjectId: "another-subject",
        sessionId: imported.session.id,
        importId: "isolated",
        payload: { batchId: "two", offset: 1, events: [event("two")] },
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_NOT_FOUND" });
    const [posture] =
      await shared.admin`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'opengeni_private.session_import_batches'::regclass`;
    expect(posture).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  test("private imports derive their verified human owner and never cross the viewer boundary", async () => {
    if (!client || !shared) return;
    const userId = crypto.randomUUID();
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Import owner",
    });
    const grant = access.workspaceGrants[0]!;
    await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by) values(${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'archive-test') on conflict do nothing`;
    await shared.admin`insert into organization_private_session_settings(account_id,enabled,version,updated_by_membership_id) values(${grant.accountId},true,1,null) on conflict(account_id) do update set enabled=true`;
    const scope = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      fileOwnerSubjectId: grant.subjectId,
      requireLiveSubject: true,
      createdBy: { kind: "subject" as const, subjectId: grant.subjectId },
    };
    const imported = await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
      importArchivedSession(client!.db, {
        ...scope,
        payload: {
          importId: "private",
          title: "Only me",
          createdAt: "2019-01-01T00:00:00Z",
          visibility: "user_private",
          events: [event("private message")],
        },
      }),
    );
    const [owner] =
      await shared.admin`select owner_subject_id,visibility from sessions where id=${imported.session.id}`;
    expect(owner).toMatchObject({ owner_subject_id: grant.subjectId, visibility: "user_private" });
    expect(
      await getSessionForSubject(
        client.db,
        scope.workspaceId,
        imported.session.id,
        scope.subjectId,
      ),
    ).not.toBeNull();
    expect(
      await getSessionForSubject(client.db, scope.workspaceId, imported.session.id, "user:other"),
    ).toBeNull();
    expect(
      await withWorkspaceSubjectRls(client.db, scope.workspaceId, "user:other", (tx) =>
        tx
          .select()
          .from(schema.sessionEvents)
          .where(eq(schema.sessionEvents.sessionId, imported.session.id)),
      ),
    ).toEqual([]);
    await expect(
      importArchivedSession(client.db, {
        ...scope,
        subjectId: "service:key",
        createdBy: { kind: "service", subjectId: "service:key" },
        payload: {
          importId: "ownerless-private",
          title: "Denied",
          createdAt: "2019-01-01T00:00:00Z",
          visibility: "user_private",
        },
      }),
    ).rejects.toThrow();
  });

  test("Send and Steer refuse imports before writes; old binaries cannot initialize a turn or remove the marker", async () => {
    if (!client || !shared) return;
    const scope = await fixture();
    const imported = await importArchivedSession(client.db, {
      ...scope,
      payload: { importId: "inert", title: "Inert", createdAt: "2019-01-01T00:00:00Z" },
    });
    for (const delivery of ["send", "steer"] as const) {
      await expect(
        withWorkspaceSubjectSessionActivityRls(
          client.db,
          scope.workspaceId,
          scope.subjectId,
          (tx) =>
            submitHumanPromptInTransaction(tx, {
              ...scope,
              sessionId: imported.session.id,
              actor: { type: "service", subjectId: scope.subjectId },
              operationKey: crypto.randomUUID(),
              delivery,
              text: "must not execute",
              resources: [],
              reasoningEffortFallback: "low",
              source: "api",
            }),
        ),
      ).rejects.toMatchObject({ code: "SESSION_IMPORTED_READ_ONLY" });
    }
    let rejection: unknown;
    try {
      await initializeSessionStartAtomically(client.db, {
        ...scope,
        sessionId: imported.session.id,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
      });
    } catch (error) {
      rejection = error;
    }
    expect(nestedPostgresSqlState(rejection)).toBe("OG002");
    await expect(
      withWorkspaceSubjectRls(client.db, scope.workspaceId, scope.subjectId, (tx) =>
        tx
          .update(schema.sessions)
          .set({
            importedArchiveImportId: null,
            importedArchiveImportedAt: null,
            importedArchiveRequestHash: null,
            importedArchiveSubjectId: null,
            importedArchiveNextOffset: null,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, scope.workspaceId),
              eq(schema.sessions.id, imported.session.id),
            ),
          ),
      ),
    ).rejects.toThrow();
    const [counts] =
      await shared.admin`select (select count(*)::int from session_turns where session_id=${imported.session.id}) as turns, (select count(*)::int from session_history_items where session_id=${imported.session.id}) as history, (select count(*)::int from session_workflow_wake_outbox where session_id=${imported.session.id}) as wakes`;
    expect(counts).toEqual({ turns: 0, history: 0, wakes: 0 });
  });

  test("invalid and cross-workspace file references roll back creates and batches", async () => {
    if (!client || !shared) return;
    const scope = await fixture();
    await expect(
      importArchivedSession(client.db, {
        ...scope,
        payload: {
          importId: "bad-file",
          title: "No",
          createdAt: "2019-01-01T00:00:00Z",
          events: [{ ...event("file"), payload: { fileId: crypto.randomUUID() } }],
        },
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_INVALID_FILE" });
    expect(
      await getArchivedSessionImportId(client.db, scope.workspaceId, scope.subjectId, "bad-file"),
    ).toBeNull();
    const other = await fixture();
    const upload = await createFileUpload(client.db, {
      accountId: other.accountId,
      workspaceId: other.workspaceId,
      fileId: crypto.randomUUID(),
      filename: "history.txt",
      safeFilename: "history.txt",
      contentType: "text/plain",
      sizeBytes: 3,
      bucket: "test",
      objectKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const file = await completeFileUpload(client.db, other.workspaceId, upload.uploadId);
    await expect(
      importArchivedSession(client.db, {
        ...scope,
        payload: {
          importId: "cross-file",
          title: "No",
          createdAt: "2019-01-01T00:00:00Z",
          events: [
            {
              ...event("cross-workspace file"),
              payload: { resources: [{ kind: "file", fileId: file.id }] },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_INVALID_FILE" });
    const imported = await importArchivedSession(client.db, {
      ...scope,
      payload: { importId: "file-append", title: "Files", createdAt: "2019-01-01T00:00:00Z" },
    });
    await expect(
      appendArchivedSessionEvents(client.db, {
        ...scope,
        importId: "file-append",
        sessionId: imported.session.id,
        payload: {
          batchId: "bad",
          offset: 0,
          events: [{ ...event("missing"), payload: { fileId: crypto.randomUUID() } }],
        },
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_INVALID_FILE" });
    expect(
      (await listSessionEvents(client.db, scope.workspaceId, imported.session.id, { limit: 100 }))
        .length,
    ).toBe(0);
    const readableUpload = await createFileUpload(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      fileId: crypto.randomUUID(),
      filename: "readable.txt",
      safeFilename: "readable.txt",
      contentType: "text/plain",
      sizeBytes: 3,
      bucket: "test",
      objectKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const readable = await completeFileUpload(
      client.db,
      scope.workspaceId,
      readableUpload.uploadId,
    );
    const accepted = await appendArchivedSessionEvents(client.db, {
      ...scope,
      importId: "file-append",
      sessionId: imported.session.id,
      payload: {
        batchId: "readable",
        offset: 0,
        events: [
          { ...event("readable"), payload: { resources: [{ kind: "file", fileId: readable.id }] } },
        ],
      },
    });
    expect(accepted.nextOffset).toBe(1);
  });

  test("bookkeeping timeline events do not change the imported batch offset", async () => {
    if (!client || !shared) return;
    const scope = await fixture();
    const payload = {
      importId: "offset",
      title: "Offset",
      createdAt: "2019-01-01T00:00:00Z",
      events: [event("first")],
    };
    const imported = await importArchivedSession(client.db, { ...scope, payload });
    await appendSessionEvents(client.db, scope.workspaceId, imported.session.id, [
      { type: "session.title_set", payload: { title: "Changed" } },
    ]);
    const appended = await appendArchivedSessionEvents(client.db, {
      ...scope,
      importId: "offset",
      sessionId: imported.session.id,
      payload: { batchId: "second", offset: 1, events: [event("second")] },
    });
    expect(appended.nextOffset).toBe(2);
    expect(appended.events[0]!.sequence).toBe(3);
    expect((await importArchivedSession(client.db, { ...scope, payload })).nextOffset).toBe(2);
  });

  test("revoked import credentials cannot replay a create or append a suffix", async () => {
    if (!client || !shared) return;
    const workspace = await fixture();
    const key = await createOrganizationApiKey(client.db, {
      accountId: workspace.accountId,
      name: "Import credential",
      prefix: "test",
      keyHash: "a".repeat(64),
      permissions: ["sessions:create", "sessions:control"],
    });
    const subjectId = `api_key:${key.id}`;
    const scope = {
      ...workspace,
      subjectId,
      apiKeyId: key.id,
      requiredPermission: "sessions:create" as const,
      createdBy: { kind: "service" as const, subjectId },
    };
    const payload = {
      importId: "revoked-key",
      title: "Credential",
      createdAt: "2019-01-01T00:00:00Z",
    };
    const imported = await importArchivedSession(client.db, { ...scope, payload });
    expect((await importArchivedSession(client.db, { ...scope, payload })).created).toBe(false);
    const [owner] =
      await shared.admin`select owner_subject_id from sessions where id=${imported.session.id}`;
    expect(owner!.owner_subject_id).toBeNull();
    await revokeOrganizationApiKey(client.db, workspace.accountId, key.id);
    await expect(importArchivedSession(client.db, { ...scope, payload })).rejects.toMatchObject({
      code: "SESSION_IMPORT_NOT_FOUND",
    });
    await expect(
      appendArchivedSessionEvents(client.db, {
        ...scope,
        requiredPermission: "sessions:control",
        sessionId: imported.session.id,
        importId: payload.importId,
        payload: { batchId: "revoked", offset: 0, events: [event("must not append")] },
      }),
    ).rejects.toMatchObject({ code: "SESSION_IMPORT_NOT_FOUND" });
    expect(
      await listSessionEvents(client.db, workspace.workspaceId, imported.session.id, {
        limit: 100,
      }),
    ).toEqual([]);
  });
});
