import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  enqueueSessionTurn,
  transitionSessionVisibility,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
  mutateSessionControlInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src";
import { rawRows } from "../src/database";
import { executeMigrationFile, migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const file = "0882_continuable_core_capacity_waits.sql";
const source = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
let owned: OwnerMigratedTestDatabase;
let client: DbClient;
let owner: postgres.Sql;
let app: postgres.Sql;

beforeAll(async () => {
  const fixture = await acquireOwnerMigratedTestDatabase("0882-owner-window");
  if (!fixture) throw new Error("Real PostgreSQL required");
  owned = fixture;
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const url = new URL(owned.ownerUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  client = createDb(url.toString(), { max: 2 });
  app = postgres(url.toString(), { max: 1 });
  owner = postgres(owned.ownerUrl, { max: 1 });
  for (const connection of [owner, app]) {
    await connection`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', false),
      set_config('opengeni.session_variable_set_attachments_v1', '1', false)`;
  }
}, 900_000);
afterAll(async () => {
  await client?.close();
  await owner?.end();
  await app?.end();
  await owned?.release();
}, 180_000);

async function human() {
  const userId = `capacity-owner-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Capacity owner",
  });
  const grant = access.workspaceGrants[0]!;
  await owned.admin`insert into organization_private_session_settings(account_id, enabled, version, updated_at)
    values (${grant.accountId}, true, 1, now()) on conflict(account_id) do update set enabled=true`;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}
type Human = Awaited<ReturnType<typeof human>>;

async function waiting(h: Human, privateSession = false) {
  const session = await withSessionRlsActorContext({ subjectId: h.subjectId }, () =>
    createSession(client.db, {
      accountId: h.accountId,
      workspaceId: h.workspaceId,
      initialMessage: "wait",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: h.subjectId },
      createdByContext: {},
    }),
  );
  if (privateSession)
    await transitionSessionVisibility(client.db, {
      workspaceId: h.workspaceId,
      sessionId: session.id,
      actorSubjectId: h.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: crypto.randomUUID(),
    });
  const turn = await withSessionRlsActorContext({ subjectId: h.subjectId }, () =>
    enqueueSessionTurn(client.db, {
      accountId: h.accountId,
      workspaceId: h.workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "wait",
      resources: [],
      tools: [],
      model: "test-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: h.subjectId },
    }),
  );
  await owned.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`update session_turns set status='waiting_capacity' where id=${turn.id}`;
    await tx`update sessions set active_turn_id=${turn.id} where id=${session.id}`;
    await tx`delete from session_workflow_wake_outbox where session_id=${session.id}`;
  });
  return session.id;
}

const posture = () => owned.admin`select relname, relrowsecurity, relforcerowsecurity from pg_class
  where oid in ('sessions'::regclass, 'session_turns'::regclass, 'workspace_inference_controls'::regclass,
    'codex_capacity_waiters'::regclass, 'subscription_capacity_waiters'::regclass, 'session_workflow_wake_outbox'::regclass)
  order by relname`;

const policies = () => owned.admin`select polrelid, polname, polcmd, polpermissive, polroles,
  pg_get_expr(polqual, polrelid) as using_expression,
  pg_get_expr(polwithcheck, polrelid) as check_expression from pg_policy
  where polrelid in ('sessions'::regclass, 'session_turns'::regclass, 'workspace_inference_controls'::regclass,
    'codex_capacity_waiters'::regclass, 'subscription_capacity_waiters'::regclass, 'session_workflow_wake_outbox'::regclass)
  order by polrelid, polname`;

async function visible(h: Human, actor: string, targetWorkspace = h.workspaceId) {
  return withSessionRlsActorContext({ subjectId: actor }, () =>
    withRlsContext(client.db, h, async (tx) =>
      (
        await rawRows<{ session_id: string }>(
          tx,
          sql`select session_id from
      opengeni_private.list_continuable_sessions(${targetWorkspace}::uuid, null)`,
        )
      )
        .map((row) => row.session_id)
        .sort(),
    ),
  );
}

test("0882 owner-only backfill restores FORCE and retains invoker actor/workspace boundaries", async () => {
  const alice = await human();
  const other = await human();
  const privateId = await waiting(alice, true);
  const sharedId = await waiting(alice);
  const foreignId = await waiting(other);
  const pausedId = await waiting(other);
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    other.workspaceId,
    other.subjectId,
    (db) =>
      mutateSessionControlInTransaction(db, {
        accountId: other.accountId,
        workspaceId: other.workspaceId,
        sessionId: pausedId,
        operationKey: crypto.randomUUID(),
        action: "pause",
        actor: { type: "human", subjectId: other.subjectId },
      }),
  );
  const member = `user:capacity-member-${crypto.randomUUID()}`;
  await owned.admin`insert into workspace_memberships(account_id, workspace_id, subject_id, role, permissions)
    values (${alice.accountId}, ${alice.workspaceId}, ${member}, 'member', '[]'::jsonb)`;

  const [role] =
    await owner`select rolsuper, rolbypassrls from pg_roles where rolname=current_user`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
  expect(await owner`select id from sessions`).toHaveLength(0);
  const before = await posture();
  const policiesBefore = await policies();
  expect(before).toHaveLength(6);
  expect(before.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  const [routineBefore] =
    await owned.admin`select proowner, proacl, prosecdef, proconfig from pg_proc
    where oid='opengeni_private.list_continuable_sessions(uuid,uuid)'::regprocedure`;
  await executeMigrationFile(owner, file, source);
  expect(await posture()).toEqual(before);
  expect(await policies()).toEqual(policiesBefore);
  expect(await owner`select id from sessions`).toHaveLength(0);
  const wakes = await owned.admin`select session_id, reason from session_workflow_wake_outbox
    where session_id = any(${[privateId, sharedId, foreignId, pausedId]}::uuid[]) order by session_id`;
  expect(wakes.map((row) => row.session_id).sort()).toEqual(
    [privateId, sharedId, foreignId].sort(),
  );
  expect(wakes.every((row) => row.reason === "capacity_wait_repair")).toBe(true);
  const [routine] =
    await owned.admin`select proowner, proacl, prosecdef, proconfig, pg_get_functiondef(oid) as definition from pg_proc
    where oid='opengeni_private.list_continuable_sessions(uuid,uuid)'::regprocedure`;
  expect(routine).toMatchObject(routineBefore!);
  expect(routine!.prosecdef).toBe(false);
  expect(routine!.proconfig).toEqual(["search_path=pg_catalog"]);
  expect(routine!.definition).toContain("public.sessions");
  expect(await visible(alice, alice.subjectId)).toEqual([privateId, sharedId].sort());
  expect(await visible(alice, member)).toEqual([sharedId]);
  expect(await visible(alice, member, other.workspaceId)).toEqual([]);
  // Unadmitted nonmember/guest connections have no trusted tenant scope. The
  // helper does not independently authorize a caller-supplied tenant context.
  for (const actor of ["user:unadmitted-nonmember", "site_guest:unadmitted"]) {
    await app.begin(async (tx) => {
      await tx`select set_config('opengeni.subject_id', ${actor}, true)`;
      expect(
        await tx`select * from opengeni_private.list_continuable_sessions(${alice.workspaceId}, null)`,
      ).toHaveLength(0);
    });
  }
  await withSessionRlsActorContext({ subjectId: alice.subjectId }, () =>
    withRlsContext(client.db, alice, async (tx) => {
      await tx.execute(sql`create temp table sessions(id uuid) on commit drop`);
      const rows = await rawRows<{ session_id: string }>(
        tx,
        sql`select session_id from
      opengeni_private.list_continuable_sessions(${alice.workspaceId}::uuid, null)`,
      );
      expect(rows.map((row) => row.session_id).sort()).toEqual([privateId, sharedId].sort());
    }),
  );
  await expect(
    owner.begin(async (tx) => {
      await tx.unsafe(source);
      throw new Error("controlled rollback after window");
    }),
  ).rejects.toThrow("controlled rollback after window");
  expect(await posture()).toEqual(before);
  expect(await policies()).toEqual(policiesBefore);
}, 180_000);
