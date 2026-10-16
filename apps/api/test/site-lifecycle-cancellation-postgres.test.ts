import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireRestrictedRuntimeTestDatabase,
  MemoryEventBus,
  testSettings,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import {
  cancelSiteRuntimeConversation,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  currentSessionRlsActorContext,
  getSession,
  initializeSessionStartAtomically,
  inspectRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
  listSessionEvents,
  listSiteRuntimeCancellationCandidates,
  withRlsContext,
  withSessionActivityRlsContext,
  withSessionRlsActorContext,
  withSiteViewerRlsContext,
  type DbClient,
} from "@opengeni/db";
import { cancelPublishedSiteSession } from "@opengeni/core";
import {
  configureSitePublishingEffects,
  setSitePublishingCancellation,
  stopSiteViewers,
  type SitePublishingDeps,
} from "../src/site-publishing/service";

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase(
    "site-lifecycle-cancel",
    "site_cancel",
  );
  if (!acquired) throw new Error("Site lifecycle cancellation requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { searchPath: shared.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture() {
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts(name) values('Site cancellation') returning id`;
  const accountId = account!.id;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces(account_id,name) values(${accountId},'Site workspace') returning id`;
  const workspaceId = workspace!.id;
  await shared.admin`insert into workspace_inference_controls(account_id,workspace_id) values(${accountId},${workspaceId})`;
  const owner = `user:${crypto.randomUUID()}`;
  const manager = `user:${crypto.randomUUID()}`;
  for (const subject of [owner, manager]) {
    const [personal] = await shared.admin<{ id: string }[]>`
      insert into workspaces(account_id,name) values(${accountId},'Personal') returning id`;
    await shared.admin`insert into organization_memberships(account_id,subject_id,status,personal_workspace_id,role)
      values(${accountId},${subject},'active',${personal!.id},'owner')`;
    await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,role,permissions)
      values(${accountId},${workspaceId},${subject},'owner','["workspace:admin"]')`;
  }
  const siteId = crypto.randomUUID();
  await shared.admin`insert into workspace_artifacts(id,account_id,workspace_id,slug,title,created_by_subject_id)
    values(${siteId},${accountId},${workspaceId},${`site-${siteId}`},'Cancellation Site',${manager})`;
  return { accountId, workspaceId, siteId, owner, manager };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function conversation(f: Fixture, kind: "member" | "guest", child = false, deferred = false) {
  const sessionId = crypto.randomUUID();
  const principal = kind === "member" ? `user:${f.owner}` : `guest:${crypto.randomUUID()}`;
  await shared.admin`insert into site_runtime_conversations(session_id,account_id,workspace_id,site_id,viewer_principal,viewer_kind)
    values(${sessionId},${f.accountId},${f.workspaceId},${f.siteId},${principal},${kind})`;
  const subjectId = kind === "member" ? f.owner : `site:${f.siteId}`;
  const asViewer = <T>(run: () => Promise<T>) =>
    withSessionRlsActorContext({ subjectId }, () =>
      withSiteViewerRlsContext({ siteId: f.siteId, principal }, run),
    );
  const create = (
    requestedSessionId: string,
    parent?: { turnId: string; attemptId: string; executionGeneration: number },
  ) =>
    withSessionActivityRlsContext(client.db, f, async (tx) => {
      // Fixture-only: the pre-existing 0313 child-create definer does not open
      // 0349's owner membership read marker under a non-bypass migration owner.
      // Keep every native attempt/owner check; do not alter production policies.
      if (parent && kind === "member")
        await tx.execute(sql`select set_config(
      'opengeni.organization_tenancy_lifecycle','private_session_create_authority',true)`);
      return createSession(tx, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        requestedSessionId,
        ...(parent
          ? {
              parentSessionId: sessionId,
              createdByActor: {
                type: "agent_attempt" as const,
                sessionId,
                ...parent,
              },
            }
          : {}),
        visibility: kind === "member" ? "user_private" : "workspace_shared",
        initialMessage: "Private viewer input",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        subjectId,
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
      });
    });
  await asViewer(() => create(sessionId));
  const start = (id: string) =>
    asViewer(() =>
      initializeSessionStartAtomically(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: id,
        ...(deferred ? { deferInitialTurn: true } : {}),
        reasoningEffortFallback: "low",
        createdEventPayload: {},
      }),
    );
  await start(sessionId);
  const childId = child ? crypto.randomUUID() : null;
  if (childId) {
    const attemptId = crypto.randomUUID();
    const parent = await asViewer(() =>
      claimSessionWorkForAttempt(client.db, f.workspaceId, {
        sessionId,
        workflowId: `session-${sessionId}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      }),
    );
    if (parent.action !== "claimed") throw new Error("Parent turn was not claimable");
    await asViewer(() =>
      create(childId, {
        attemptId,
        turnId: parent.turn.id,
        executionGeneration: parent.turn.executionGeneration,
      }),
    );
    await start(childId);
  }
  return { sessionId, childId, principal, asViewer };
}

test("native member and guest cancellation keeps the actor, cancels descendants, receipts and wakes", async () => {
  const f = await fixture();
  const untouched = await conversation(f, "member");
  const bus = new MemoryEventBus();
  let wakeCalls = 0;
  for (const kind of ["member", "guest"] as const) {
    const c = await conversation(f, kind, true);
    const claimed = await c.asViewer(() =>
      claimSessionWorkForAttempt(client.db, f.workspaceId, {
        sessionId: c.childId!,
        workflowId: `session-${c.childId}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      }),
    );
    expect(claimed.action).toBe("claimed");
    await shared.admin.unsafe(`create function site_cancel_test_actor_guard() returns trigger
      language plpgsql as $$ begin
        if NEW.site_id='${f.siteId}'::uuid and
          current_setting('opengeni.subject_id',true) is distinct from '${f.manager}' then
          raise exception 'cancellation changed its request actor';
        end if;
        return NEW;
      end $$;
      create trigger site_cancel_test_actor_guard before update on sessions
        for each row execute function site_cancel_test_actor_guard()`);
    const input = {
      ...f,
      sessionId: c.sessionId,
      operationKey: crypto.randomUUID(),
      reason: "unpublished",
    };
    await withSessionRlsActorContext({ subjectId: f.manager }, async () => {
      expect(await getSession(client.db, f.workspaceId, c.sessionId)).toBeNull();
      const deps = {
        db: client.db,
        bus,
        workflowClient: {
          requestSessionWorkflowWakeDispatch: async () => {
            wakeCalls++;
          },
        },
      };
      const first = await cancelPublishedSiteSession(deps, input);
      expect(first).toMatchObject({
        replay: false,
        cancelledSessionCount: 2,
        cancelledTurnCount: 2,
      });
      expect(Object.keys(first!)).toEqual([
        "receiptId",
        "replay",
        "cancelledSessionCount",
        "cancelledTurnCount",
      ]);
      const again = await cancelPublishedSiteSession(deps, input);
      expect(again).toMatchObject({ receiptId: first!.receiptId, replay: true });
      expect(
        await cancelPublishedSiteSession(deps, { ...input, operationKey: crypto.randomUUID() }),
      ).toBeNull();
      expect(currentSessionRlsActorContext()?.subjectId).toBe(f.manager);
      expect(await getSession(client.db, f.workspaceId, c.sessionId)).toBeNull();
      expect(await listSessionEvents(client.db, f.workspaceId, c.sessionId)).toEqual([]);
      expect(await getSession(client.db, f.workspaceId, untouched.sessionId)).toBeNull();
      await withRlsContext(client.db, f, async (tx) => {
        const rows = await tx.execute<{ subject: string }>(
          sql`select current_setting('opengeni.subject_id',true) as subject`,
        );
        expect(rows[0]?.subject).toBe(f.manager);
      });
    }).finally(async () => {
      await shared.admin.unsafe(
        "drop trigger site_cancel_test_actor_guard on sessions; drop function site_cancel_test_actor_guard()",
      );
    });
    const rows = await shared.admin<{ id: string; status: string }[]>`
      select id,status from sessions where id in (${c.sessionId},${c.childId})`;
    expect(rows.every((row) => row.status === "cancelled")).toBe(true);
    const [receipt] = await shared.admin<
      { actor_type: string; actor_subject_id: string; count: number }[]
    >`
      select actor_type,actor_subject_id,count(*)::int as count from session_command_receipts
      where target_session_id=${c.sessionId} group by actor_type,actor_subject_id`;
    expect(receipt).toEqual({ actor_type: "service", actor_subject_id: f.manager, count: 1 });
    const [interrupted] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from session_attempt_interruptions where session_id=${c.childId}`;
    expect(interrupted!.count).toBeGreaterThan(0);
    const [wake] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from session_workflow_wake_outbox where session_id in (${c.sessionId},${c.childId})`;
    expect(wake!.count).toBeGreaterThan(0);
    const [activity] = await shared.admin<{ pending: number; stamped: number }[]>`
      select count(*) filter(where activity_revision_pending_xid is not null)::int as pending,
        count(*) filter(where activity_revision>0)::int as stamped from sessions
      where id in (${c.sessionId},${c.childId})`;
    expect(activity).toEqual({ pending: 0, stamped: 2 });
  }
  const [other] = await shared.admin<
    { status: string }[]
  >`select status from sessions where id=${untouched.sessionId}`;
  expect(other!.status).toBe("queued");
  expect(wakeCalls).toBeGreaterThan(0);
  expect(bus.published.flat().length).toBeGreaterThan(0);
  expect(JSON.stringify(bus.published)).not.toContain("Private viewer input");
  const [caps] = await shared.admin<
    { count: number }[]
  >`select count(*)::int as count from opengeni_private.site_session_cancellation_capabilities`;
  expect(caps!.count).toBe(0);
}, 180_000);

test("idle history is preserved without creating a cancellation receipt", async () => {
  const f = await fixture();
  const c = await conversation(f, "member", false, true);
  await withSessionRlsActorContext({ subjectId: f.manager }, async () => {
    expect(
      await cancelSiteRuntimeConversation(client.db, {
        ...f,
        sessionId: c.sessionId,
        operationKey: crypto.randomUUID(),
        reason: "unpublished",
      }),
    ).toBeNull();
  });
  const [row] = await shared.admin<{ status: string; receipts: number }[]>`
    select status,(select count(*)::int from session_command_receipts where target_session_id=s.id) as receipts
    from sessions s where id=${c.sessionId}`;
  expect(row).toEqual({ status: "idle", receipts: 0 });
}, 180_000);

test("wrong Site, service bearer, mismatched retry and reservations never leak a capability", async () => {
  const f = await fixture();
  const c = await conversation(f, "member");
  const input = {
    ...f,
    sessionId: c.sessionId,
    operationKey: crypto.randomUUID(),
    reason: "unpublished",
  };
  await withSessionRlsActorContext({ subjectId: `site:${f.siteId}` }, async () => {
    expect(await getSession(client.db, f.workspaceId, c.sessionId)).toBeNull();
    await expect(cancelSiteRuntimeConversation(client.db, input)).rejects.toThrow();
    expect(await getSession(client.db, f.workspaceId, c.sessionId)).toBeNull();
  });
  await withSessionRlsActorContext({ subjectId: f.manager }, async () => {
    await expect(
      cancelSiteRuntimeConversation(client.db, { ...input, siteId: crypto.randomUUID() }),
    ).rejects.toThrow();
    await cancelSiteRuntimeConversation(client.db, input);
    await expect(
      cancelSiteRuntimeConversation(client.db, { ...input, reason: "different operation" }),
    ).rejects.toThrow();
    expect(await getSession(client.db, f.workspaceId, c.sessionId)).toBeNull();
    const missing = crypto.randomUUID();
    await shared.admin`insert into site_runtime_conversations(session_id,account_id,workspace_id,site_id,viewer_principal,viewer_kind)
      values(${missing},${f.accountId},${f.workspaceId},${f.siteId},'guest:reserved','guest')`;
    expect(
      await cancelSiteRuntimeConversation(client.db, { ...input, sessionId: missing }),
    ).toBeNull();
    await withRlsContext(client.db, f, async (tx) => {
      await expect(cancelSiteRuntimeConversation(tx, input)).rejects.toThrow(
        "requires its own transaction",
      );
    });
  });
  const [caps] = await shared.admin<
    { count: number }[]
  >`select count(*)::int as count from opengeni_private.site_session_cancellation_capabilities`;
  expect(caps!.count).toBe(0);
}, 180_000);

test("scope witness is exact-root and transaction-local, cannot become service transcript authority", async () => {
  const f = await fixture();
  const first = await conversation(f, "member");
  const other = await conversation(f, "guest");
  await withSessionRlsActorContext({ subjectId: f.manager }, async () => {
    await withRlsContext(client.db, f, async (tx) => {
      const [cap] = await tx.execute<{
        token: string;
      }>(sql`select opengeni_private.begin_site_session_cancellation(
        ${f.accountId}::uuid,${f.workspaceId}::uuid,${f.siteId}::uuid,${first.sessionId}::uuid) as token`);
      const predicate = () =>
        tx.execute<{ active: boolean }>(sql`select site_session_cancellation_capability_active(
        ${f.accountId}::uuid,${f.workspaceId}::uuid,${f.siteId}::uuid,${first.sessionId}::uuid) as active`);
      expect((await predicate())[0]?.active).toBe(true);
      expect(await getSession(tx, f.workspaceId, other.sessionId)).toBeNull();
      await tx.execute(sql`select set_config('opengeni.subject_id',${`site:${f.siteId}`},true)`);
      expect((await predicate())[0]?.active).toBe(false);
      await tx.execute(sql`select set_config('opengeni.subject_id',${f.manager},true)`);
      await tx.execute(
        sql`select opengeni_private.end_site_session_cancellation(${cap!.token}::uuid)`,
      );
      expect((await predicate())[0]?.active).toBe(false);
    });
    expect(await getSession(client.db, f.workspaceId, first.sessionId)).toBeNull();
    await expect(
      withRlsContext(client.db, f, async (tx) => {
        await tx.execute(sql`select opengeni_private.begin_site_session_cancellation(
        ${f.accountId}::uuid,${f.workspaceId}::uuid,${f.siteId}::uuid,${first.sessionId}::uuid)`);
        throw new Error("rollback witness");
      }),
    ).rejects.toThrow("rollback witness");
    expect(await getSession(client.db, f.workspaceId, first.sessionId)).toBeNull();
  });
  const [caps] = await shared.admin<
    { count: number }[]
  >`select count(*)::int as count from opengeni_private.site_session_cancellation_capabilities`;
  expect(caps!.count).toBe(0);
}, 180_000);

test("stopSiteViewers drains old conversations over multiple pages and retains queued actor context", async () => {
  const f = await fixture();
  const ids = Array.from({ length: 205 }, () => crypto.randomUUID()).sort();
  for (const id of ids)
    await shared.admin`
    insert into site_runtime_conversations(session_id,account_id,workspace_id,site_id,viewer_principal,viewer_kind,tool_ids,created_at,updated_at)
    values(${id},${f.accountId},${f.workspaceId},${f.siteId},${`guest:${id}`},'guest','["removed"]',now()-interval '30 days',now()-interval '30 days')`;
  const kept = crypto.randomUUID();
  await shared.admin`insert into site_runtime_conversations(session_id,account_id,workspace_id,site_id,viewer_principal,viewer_kind,tool_ids)
    values(${kept},${f.accountId},${f.workspaceId},${f.siteId},'user:kept','member','["kept"]')`;
  const settings = testSettings();
  const effects = configureSitePublishingEffects(settings, {});
  const visited: string[] = [];
  setSitePublishingCancellation(settings, async (input) => {
    expect(currentSessionRlsActorContext()?.subjectId).toBe(f.manager);
    visited.push(input.sessionId);
  });
  const releases: Array<() => void> = [];
  for (let n = 0; n < 4; n++)
    effects.schedule("hold", () => new Promise<void>((resolve) => releases.push(resolve)));
  await withSessionRlsActorContext({ subjectId: f.manager }, () =>
    stopSiteViewers({ db: client.db, settings } as SitePublishingDeps, f, f.siteId, {
      reason: "agent_tools_narrowed",
      revokeSessions: false,
      toolsNarrowedTo: { tools: ["kept"], everyoneTools: true },
    }),
  );
  await withSessionRlsActorContext({ subjectId: f.owner }, async () => {
    for (const release of releases) release();
    await effects.flush();
  });
  expect(visited).toEqual(ids);
  expect(new Set(visited).size).toBe(205);
  const page = await listSiteRuntimeCancellationCandidates(client.db, f, {
    siteId: f.siteId,
    limit: 2,
    startedBefore: new Date(),
  });
  expect(page).toHaveLength(2);
}, 180_000);

test("capability ledger is owner-only, and the definer owner cannot bypass RLS", async () => {
  const role = new URL(shared.appUrl).username;
  const [acl] = await shared.admin<
    {
      read: boolean;
      write: boolean;
      superuser: boolean;
      bypass: boolean;
      public_execute: boolean;
    }[]
  >`
    select has_table_privilege(${role},'opengeni_private.site_session_cancellation_capabilities','SELECT') as read,
      has_table_privilege(${role},'opengeni_private.site_session_cancellation_capabilities','INSERT') as write,
      r.rolsuper as superuser,r.rolbypassrls as bypass,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='opengeni_private.begin_site_session_cancellation(uuid,uuid,uuid,uuid)'::regprocedure`;
  expect(acl).toEqual({
    read: false,
    write: false,
    superuser: false,
    bypass: false,
    public_execute: false,
  });
  const options = {
    expectedRole: role,
    targetSchema: shared.schema,
    rlsStrategy: "force" as const,
  };
  const posture = await inspectRuntimeDatabasePosture(client.db, options);
  const issues = (snapshot: typeof posture) =>
    evaluateRuntimeDatabasePosture(snapshot, options).filter((issue) =>
      issue.startsWith("Site cancellation"),
    );
  expect(issues(posture)).toEqual([]);
  const drift = structuredClone(posture);
  drift.privateTables.find(
    (table) => table.name === "site_session_cancellation_capabilities",
  )!.select = true;
  expect(issues(drift)).toContain("Site cancellation capability ledger is missing or unsafe");
  const missing = structuredClone(posture);
  missing.privateRoutines = missing.privateRoutines.filter(
    (routine) => !routine.name.startsWith("end_site_session_cancellation("),
  );
  expect(issues(missing)).toContain(
    "Site cancellation routine end_site_session_cancellation(uuid) is missing or unsafe",
  );
}, 180_000);

test("saturated effect queue runs cancellation inline instead of dropping it", async () => {
  const f = await fixture();
  const c = await conversation(f, "guest");
  const settings = testSettings();
  const effects = configureSitePublishingEffects(settings, { queueLimit: 0 });
  const visited: string[] = [];
  setSitePublishingCancellation(settings, async (input) => {
    visited.push(input.sessionId);
  });
  const releases: Array<() => void> = [];
  for (let n = 0; n < 4; n++)
    effects.schedule("hold", () => new Promise<void>((resolve) => releases.push(resolve)));
  try {
    await withSessionRlsActorContext({ subjectId: f.manager }, () =>
      stopSiteViewers({ db: client.db, settings } as SitePublishingDeps, f, f.siteId, {
        reason: "unpublished",
        revokeSessions: false,
      }),
    );
    expect(visited).toEqual([c.sessionId]);
  } finally {
    for (const release of releases) release();
    await effects.flush();
  }
}, 180_000);
