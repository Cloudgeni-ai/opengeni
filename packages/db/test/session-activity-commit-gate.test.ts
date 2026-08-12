import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  bootstrapWorkspace,
  createDb,
  createSession,
  lockSessionEventWriteRows,
  mutateSessionControlInTransaction,
  retrySessionActivityRls,
  withRlsContext,
  withSessionActivityRlsContext,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  type Database,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-activity-commit-gate");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function createWorkspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session activity gate test",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session activity gate test",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

async function createTestSession(
  grant: Awaited<ReturnType<typeof createWorkspace>>,
  initialMessage: string,
  parentSessionId?: string,
) {
  return await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage,
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
    ...(parentSessionId ? { parentSessionId } : {}),
  });
}

async function readCounter(workspaceId: string): Promise<bigint> {
  const [row] = await shared.admin<Array<{ revision: string }>>`
    select revision::text as revision
    from workspace_session_activity_revisions
    where workspace_id = ${workspaceId}`;
  if (!row) throw new Error(`Workspace activity counter missing: ${workspaceId}`);
  return BigInt(row.revision);
}

async function readSessionState(workspaceId: string, sessionId: string) {
  const [row] = await shared.admin<
    Array<{
      status: string;
      updatedAt: Date;
      revision: string;
      pendingXid: string | null;
    }>
  >`
    select status,
      updated_at as "updatedAt",
      activity_revision::text as revision,
      activity_revision_pending_xid::text as "pendingXid"
    from sessions
    where workspace_id = ${workspaceId} and id = ${sessionId}`;
  if (!row) throw new Error(`Session missing: ${sessionId}`);
  return row;
}

async function waitForBackendResolution(backendPid: number): Promise<"blocked" | "completed"> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await shared.admin<
      Array<{ state: string | null; waitEventType: string | null }>
    >`
      select state, wait_event_type as "waitEventType"
      from pg_stat_activity
      where pid = ${backendPid}`;
    if (!activity || activity.state === "idle") return "completed";
    if (activity.waitEventType === "Lock") return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${backendPid} neither completed nor reached a lock wait`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe("session activity commit gate", () => {
  test("the app role can only read and advance existing activity counters", async () => {
    const [privileges] = await shared.admin<
      Array<{
        canSelect: boolean;
        canInsert: boolean;
        canUpdate: boolean;
        canDelete: boolean;
      }>
    >`
      select
        has_table_privilege('opengeni_app', 'workspace_session_activity_revisions', 'SELECT') as "canSelect",
        has_table_privilege('opengeni_app', 'workspace_session_activity_revisions', 'INSERT') as "canInsert",
        has_table_privilege('opengeni_app', 'workspace_session_activity_revisions', 'UPDATE') as "canUpdate",
        has_table_privilege('opengeni_app', 'workspace_session_activity_revisions', 'DELETE') as "canDelete"
    `;

    expect(privileges).toEqual({
      canSelect: true,
      canInsert: false,
      canUpdate: true,
      canDelete: false,
    });
  });

  test("workspace creation precreates an empty activity counter", async () => {
    const grant = await createWorkspace();
    expect(await readCounter(grant.workspaceId!)).toBe(0n);
  });

  test("the structural initializer obeys FORCE RLS as a non-bypass owner and restores context", async () => {
    const grant = await createWorkspace();
    const roleName = `session_activity_owner_${crypto.randomUUID().replaceAll("-", "")}`;
    const quotedRole = quoteIdentifier(roleName);
    const [fixture] = await shared.admin<
      Array<{ schemaName: string; functionOwner: string; ownerCount: number }>
    >`
      select counter_namespace.nspname as "schemaName",
        min(pg_get_userbyid(procedure_row.proowner)::text) as "functionOwner",
        count(distinct procedure_row.proowner)::integer as "ownerCount"
      from pg_class counter_table
      join pg_namespace counter_namespace on counter_namespace.oid = counter_table.relnamespace
      cross join pg_proc procedure_row
      join pg_namespace procedure_namespace on procedure_namespace.oid = procedure_row.pronamespace
      where counter_table.oid = 'workspace_session_activity_revisions'::regclass
        and procedure_namespace.nspname = 'opengeni_private'
        and procedure_row.proname in (
          'ensure_workspace_session_activity_revision',
          'initialize_workspace_session_activity_revision'
        )
      group by counter_namespace.nspname`;
    expect(fixture?.ownerCount).toBe(1);
    if (!fixture) throw new Error("Session activity initializer fixture is unavailable");

    let roleCreated = false;
    let helperTransferred = false;
    let triggerTransferred = false;
    try {
      await shared.admin.unsafe(`create role ${quotedRole} nologin nosuperuser nobypassrls`);
      roleCreated = true;
      await shared.admin.unsafe(
        `grant usage on schema ${quoteIdentifier(fixture.schemaName)}, opengeni_private to ${quotedRole}`,
      );
      await shared.admin.unsafe(`grant create on schema opengeni_private to ${quotedRole}`);
      await shared.admin.unsafe(
        `grant execute on function opengeni_private.workspace_rls_visible(uuid, uuid), opengeni_private.current_account_id(), opengeni_private.current_workspace_id() to ${quotedRole}`,
      );
      await shared.admin.unsafe(
        `grant select, insert on table ${quoteIdentifier(fixture.schemaName)}.workspace_session_activity_revisions to ${quotedRole}`,
      );
      await shared.admin.unsafe(
        `alter function opengeni_private.ensure_workspace_session_activity_revision(text, uuid, uuid) owner to ${quotedRole}`,
      );
      helperTransferred = true;
      await shared.admin.unsafe(
        `alter function opengeni_private.initialize_workspace_session_activity_revision() owner to ${quotedRole}`,
      );
      triggerTransferred = true;

      const [role] = await shared.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
        select rolsuper as superuser, rolbypassrls as "bypassRls"
        from pg_roles
        where rolname = ${roleName}`;
      expect(role).toEqual({ superuser: false, bypassRls: false });

      await shared.admin`
        delete from workspace_session_activity_revisions
        where workspace_id = ${grant.workspaceId!}`;
      const triggerWorkspaceId = crypto.randomUUID();
      const priorAccountId = crypto.randomUUID();
      const priorWorkspaceId = crypto.randomUUID();
      await shared.admin.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${priorAccountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${priorWorkspaceId}, true)`;
        await tx`
          select opengeni_private.ensure_workspace_session_activity_revision(
            ${fixture.schemaName}, ${grant.workspaceId!}::uuid, ${grant.accountId}::uuid
          )`;
        await tx`
          insert into workspaces (id, account_id, name)
          values (${triggerWorkspaceId}::uuid, ${grant.accountId}::uuid, 'FORCE RLS initializer probe')`;
        const [restored] = await tx<Array<{ accountId: string; workspaceId: string }>>`
          select current_setting('opengeni.account_id', true) as "accountId",
            current_setting('opengeni.workspace_id', true) as "workspaceId"`;
        expect(restored).toEqual({
          accountId: priorAccountId,
          workspaceId: priorWorkspaceId,
        });
      });

      expect(await readCounter(grant.workspaceId!)).toBe(0n);
      expect(await readCounter(triggerWorkspaceId)).toBe(0n);
    } finally {
      if (triggerTransferred) {
        await shared.admin.unsafe(
          `alter function opengeni_private.initialize_workspace_session_activity_revision() owner to ${quoteIdentifier(fixture.functionOwner)}`,
        );
      }
      if (helperTransferred) {
        await shared.admin.unsafe(
          `alter function opengeni_private.ensure_workspace_session_activity_revision(text, uuid, uuid) owner to ${quoteIdentifier(fixture.functionOwner)}`,
        );
      }
      if (roleCreated) {
        await shared.admin.unsafe(`drop owned by ${quotedRole}`);
        await shared.admin.unsafe(`drop role if exists ${quotedRole}`);
      }
    }
  });

  test("the activity counter rejects direct runtime updates", async () => {
    const grant = await createWorkspace();

    let rejection: unknown;
    try {
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db
          .update(schema.workspaceSessionActivityRevisions)
          .set({
            revision: sql`${schema.workspaceSessionActivityRevisions.revision} + 1`,
          })
          .where(eq(schema.workspaceSessionActivityRevisions.workspaceId, grant.workspaceId!)),
      );
    } catch (error) {
      rejection = error;
    }
    expect((rejection as { cause?: unknown }).cause).toMatchObject({
      code: "55000",
      message: "Workspace session activity revision requires the finalizing commit gate",
    });
    expect(await readCounter(grant.workspaceId!)).toBe(0n);
  });

  test("one transaction stamps every changed session with one shared revision", async () => {
    const grant = await createWorkspace();
    const first = await createTestSession(grant, "first");
    const second = await createTestSession(grant, "second");
    const before = await readCounter(grant.workspaceId!);
    const changedAt = new Date("2026-08-10T12:00:00.123Z");

    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId!, async (db) => {
      await db
        .update(schema.sessions)
        .set({ status: "running", updatedAt: changedAt })
        .where(
          and(
            eq(schema.sessions.workspaceId, grant.workspaceId!),
            inArray(schema.sessions.id, [first.id, second.id]),
          ),
        );

      const pending = await db
        .select({
          id: schema.sessions.id,
          revision: schema.sessions.activityRevision,
          pendingXid: schema.sessions.activityRevisionPendingXid,
        })
        .from(schema.sessions)
        .where(inArray(schema.sessions.id, [first.id, second.id]));
      expect(pending.every((row) => row.pendingXid !== null)).toBe(true);
      expect(new Set(pending.map((row) => row.pendingXid)).size).toBe(1);
      expect(await readCounter(grant.workspaceId!)).toBe(before);
    });

    const after = await readCounter(grant.workspaceId!);
    const firstAfter = await readSessionState(grant.workspaceId!, first.id);
    const secondAfter = await readSessionState(grant.workspaceId!, second.id);
    expect(after).toBe(before + 1n);
    expect(firstAfter).toMatchObject({ status: "running", pendingXid: null });
    expect(secondAfter).toMatchObject({ status: "running", pendingXid: null });
    expect(BigInt(firstAfter.revision)).toBe(after);
    expect(BigInt(secondAfter.revision)).toBe(after);
  });

  test("read-only and zero-row transactions do not advance the counter", async () => {
    const grant = await createWorkspace();
    const session = await createTestSession(grant, "no-op");
    const before = await readCounter(grant.workspaceId!);

    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId!, async (db) => {
      await db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, session.id));
      await db
        .update(schema.sessions)
        .set({ updatedAt: new Date() })
        .where(eq(schema.sessions.id, crypto.randomUUID()));
    });

    expect(await readCounter(grant.workspaceId!)).toBe(before);
  });

  test("nested same-workspace scopes finalize once and conflicting scopes fail closed", async () => {
    const grant = await createWorkspace();
    const first = await createTestSession(grant, "outer");
    const second = await createTestSession(grant, "inner");
    const other = await createWorkspace();
    const before = await readCounter(grant.workspaceId!);

    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId!, async (outer) => {
      await outer
        .update(schema.sessions)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(schema.sessions.id, first.id));
      await withWorkspaceSessionActivityRls(outer, grant.workspaceId!, async (inner) => {
        await inner
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.id, second.id));
      });
      await expect(
        withSessionActivityRlsContext(
          outer,
          { accountId: other.accountId, workspaceId: other.workspaceId! },
          async () => undefined,
        ),
      ).rejects.toThrow("already owned by another transaction scope");
    });

    const after = await readCounter(grant.workspaceId!);
    expect(after).toBe(before + 1n);
    expect(BigInt((await readSessionState(grant.workspaceId!, first.id)).revision)).toBe(after);
    expect(BigInt((await readSessionState(grant.workspaceId!, second.id)).revision)).toBe(after);
    expect(await readCounter(other.workspaceId!)).toBe(0n);
  });

  test("nested generic RLS scopes restore the gate owner before finalization", async () => {
    const grant = await createWorkspace();
    const other = await createWorkspace();
    const session = await createTestSession(grant, "nested RLS restoration");
    const before = await readCounter(grant.workspaceId!);

    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId!, async (db) => {
      await db
        .update(schema.sessions)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(schema.sessions.id, session.id));
      await withRlsContext(
        db,
        { accountId: other.accountId, workspaceId: other.workspaceId! },
        async (otherDb) => {
          const [scope] = await otherDb.execute<{
            accountId: string;
            workspaceId: string;
          }>(sql`select current_setting('opengeni.account_id', true) as "accountId",
              current_setting('opengeni.workspace_id', true) as "workspaceId"`);
          expect(scope).toEqual({
            accountId: other.accountId,
            workspaceId: other.workspaceId!,
          });
        },
      );
      const [restored] = await db.execute<{ accountId: string; workspaceId: string }>(
        sql`select current_setting('opengeni.account_id', true) as "accountId",
          current_setting('opengeni.workspace_id', true) as "workspaceId"`,
      );
      expect(restored).toEqual({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
      });
    });

    const after = await readCounter(grant.workspaceId!);
    const committed = await readSessionState(grant.workspaceId!, session.id);
    expect(after).toBe(before + 1n);
    expect(committed).toMatchObject({ status: "running", pendingXid: null });
    expect(BigInt(committed.revision)).toBe(after);
  });

  test("a gate cannot begin halfway through an unrelated outer transaction", async () => {
    const grant = await createWorkspace();
    const before = await readCounter(grant.workspaceId!);

    await expect(
      client.db.transaction(async (tx) =>
        withSessionActivityRlsContext(
          tx as unknown as Database,
          { accountId: grant.accountId, workspaceId: grant.workspaceId! },
          async () => undefined,
        ),
      ),
    ).rejects.toThrow("must start at the outer transaction boundary");
    expect(await readCounter(grant.workspaceId!)).toBe(before);
  });

  test("a semantic writer without the gate is rejected without partial state", async () => {
    const grant = await createWorkspace();
    const session = await createTestSession(grant, "ungated");
    const before = await readSessionState(grant.workspaceId!, session.id);
    const counterBefore = await readCounter(grant.workspaceId!);

    let rejection: unknown;
    try {
      await withWorkspaceRls(client.db, grant.workspaceId!, (db) =>
        db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.id, session.id)),
      );
    } catch (error) {
      rejection = error;
    }
    expect((rejection as { cause?: unknown }).cause).toMatchObject({
      code: "55000",
      message: "Session activity write requires an open workspace commit gate",
    });

    expect(await readSessionState(grant.workspaceId!, session.id)).toEqual(before);
    expect(await readCounter(grant.workspaceId!)).toBe(counterBefore);
  });

  test("a manually opened gate cannot commit without its finalizer", async () => {
    const grant = await createWorkspace();
    const session = await createTestSession(grant, "unfinalized");
    const before = await readSessionState(grant.workspaceId!, session.id);
    const counterBefore = await readCounter(grant.workspaceId!);

    let rejection: unknown;
    try {
      await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
        await db.execute(
          sql`select set_config('opengeni.session_activity_gate_state', 'open', true)`,
        );
        await db.execute(
          sql`select set_config('opengeni.session_activity_gate_workspace_id', ${grant.workspaceId!}, true)`,
        );
        await db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.id, session.id));
      });
    } catch (error) {
      rejection = error;
    }
    const databaseError = (rejection as { cause?: unknown }).cause ?? rejection;
    expect(databaseError).toMatchObject({
      code: "55000",
      message: "Session activity transaction reached commit without finalization",
    });
    expect(await readSessionState(grant.workspaceId!, session.id)).toEqual(before);
    expect(await readCounter(grant.workspaceId!)).toBe(counterBefore);
  });

  test("callback failure and missing counter corruption both roll back atomically", async () => {
    const grant = await createWorkspace();
    const session = await createTestSession(grant, "rollback");
    const before = await readSessionState(grant.workspaceId!, session.id);
    const counterBefore = await readCounter(grant.workspaceId!);

    await expect(
      withWorkspaceSessionActivityRls(client.db, grant.workspaceId!, async (db) => {
        await db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.id, session.id));
        throw new Error("injected callback failure");
      }),
    ).rejects.toThrow("injected callback failure");
    expect(await readSessionState(grant.workspaceId!, session.id)).toEqual(before);
    expect(await readCounter(grant.workspaceId!)).toBe(counterBefore);

    await shared.admin`
      delete from workspace_session_activity_revisions
      where workspace_id = ${grant.workspaceId!}`;
    await expect(
      withWorkspaceSessionActivityRls(client.db, grant.workspaceId!, (db) =>
        db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.id, session.id)),
      ),
    ).rejects.toThrow("Workspace session activity counter is unavailable");
    expect(await readSessionState(grant.workspaceId!, session.id)).toEqual(before);

    await shared.admin`
      insert into workspace_session_activity_revisions (workspace_id, account_id, revision)
      values (${grant.workspaceId!}, ${grant.accountId}, ${counterBefore.toString()}::bigint)`;
    expect(await readCounter(grant.workspaceId!)).toBe(counterBefore);
  });

  test("uncommitted activity stays invisible, then publishes one atomic revision", async () => {
    const grant = await createWorkspace();
    const session = await createTestSession(grant, "visibility");
    const before = await readSessionState(grant.workspaceId!, session.id);
    const counterBefore = await readCounter(grant.workspaceId!);
    let markWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      markWritten = resolve;
    });
    let releaseWriter!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const writer = withWorkspaceSessionActivityRls(client.db, grant.workspaceId!, async (db) => {
      await db
        .update(schema.sessions)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(schema.sessions.id, session.id));
      markWritten();
      await release;
    });
    await written;

    expect(await readCounter(grant.workspaceId!)).toBe(counterBefore);
    expect(await readSessionState(grant.workspaceId!, session.id)).toEqual(before);

    releaseWriter();
    await writer;
    const after = await readSessionState(grant.workspaceId!, session.id);
    expect(await readCounter(grant.workspaceId!)).toBe(counterBefore + 1n);
    expect(after).toMatchObject({ status: "running", pendingXid: null });
    expect(BigInt(after.revision)).toBe(counterBefore + 1n);
  });

  test("a canonical parent lock remains compatible with child activity finalization", async () => {
    const grant = await createWorkspace();
    const parent = await createTestSession(grant, "concurrent-finalizer-parent");
    const child = await createTestSession(grant, "concurrent-finalizer-child", parent.id);
    const sessions = [parent, child];
    const counterBefore = await readCounter(grant.workspaceId!);
    let firstBackendPid = 0;
    let markFirstReady!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      markFirstReady = resolve;
    });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstWriter = withWorkspaceSessionActivityRls(
      client.db,
      grant.workspaceId!,
      async (db) => {
        await db.execute(sql`set local statement_timeout = '10s'`);
        const [backend] = await db.execute<{ pid: number }>(
          sql`select pg_backend_pid()::integer as pid`,
        );
        firstBackendPid = backend!.pid;
        await db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.id, child.id));
        markFirstReady();
        await firstReleased;
      },
    );

    await firstReady;
    let markParentLocked!: () => void;
    const parentLocked = new Promise<void>((resolve) => {
      markParentLocked = resolve;
    });
    let releaseSecond!: () => void;
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondWriter = withWorkspaceSessionActivityRls(
      client.db,
      grant.workspaceId!,
      async (db) => {
        await db.execute(sql`set local statement_timeout = '10s'`);
        await lockSessionEventWriteRows(db, {
          workspaceId: grant.workspaceId!,
          controlLock: "none",
          sessionIds: [parent.id],
        });
        await db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.id, parent.id));
        markParentLocked();
        await secondReleased;
      },
    );

    await parentLocked;
    releaseFirst();
    const resolution = await waitForBackendResolution(firstBackendPid).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
    if (resolution instanceof Error) {
      releaseSecond();
      await Promise.allSettled([firstWriter, secondWriter]);
      throw resolution;
    }
    if (resolution === "blocked") {
      releaseSecond();
      const outcomes = await Promise.allSettled([firstWriter, secondWriter]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
      throw new Error("Child finalization blocked behind the canonical parent session lock");
    }
    await firstWriter;
    releaseSecond();
    const outcomes = await Promise.allSettled([secondWriter]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }

    const counterAfter = await readCounter(grant.workspaceId!);
    const committed = await Promise.all(
      sessions.map((session) => readSessionState(grant.workspaceId!, session.id)),
    );
    expect(counterAfter).toBe(counterBefore + BigInt(sessions.length));
    expect(committed.every((session) => session.pendingXid === null)).toBe(true);
    expect(
      committed
        .map((session) => BigInt(session.revision))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    ).toEqual(
      Array.from({ length: sessions.length }, (_, index) => counterBefore + BigInt(index + 1)),
    );
  });

  test("a concurrent parent control transaction retries a transient fault atomically", async () => {
    const grant = await createWorkspace();
    const parent = await createTestSession(grant, "parent");
    const child = await createTestSession(grant, "child", parent.id);
    const concurrent = await createTestSession(grant, "concurrent");
    let markChildWritten!: () => void;
    const childWritten = new Promise<void>((resolve) => {
      markChildWritten = resolve;
    });
    let releaseChild!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    const childWriter = withWorkspaceSessionActivityRls(
      client.db,
      grant.workspaceId!,
      async (db) => {
        await db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.id, concurrent.id));
        markChildWritten();
        await release;
      },
    );
    await childWritten;

    let retryCount = 0;
    let injectSerializationFailure = true;
    const operationKey = crypto.randomUUID();
    const cancellation = retrySessionActivityRls(
      client.db,
      grant.workspaceId!,
      {
        stage: "test.session_activity_parent_control",
        eventTypes: ["session.control.paused"],
        maxAttempts: 3,
        onRetry: () => {
          retryCount += 1;
        },
      },
      async (db) => {
        if (injectSerializationFailure) {
          injectSerializationFailure = false;
          await db
            .update(schema.sessions)
            .set({ status: "running", updatedAt: new Date() })
            .where(eq(schema.sessions.id, parent.id));
          throw Object.assign(new Error("injected retryable serialization failure"), {
            code: "40001",
          });
        }
        return await mutateSessionControlInTransaction(db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: parent.id,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey,
          action: "cancel",
        });
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseChild();
    await Promise.all([childWriter, cancellation]);
    expect(retryCount).toBe(1);
    expect((await readSessionState(grant.workspaceId!, parent.id)).status).toBe("cancelled");
    expect((await readSessionState(grant.workspaceId!, child.id)).status).toBe("cancelled");
    expect((await readSessionState(grant.workspaceId!, concurrent.id)).status).toBe("running");
  });
});
