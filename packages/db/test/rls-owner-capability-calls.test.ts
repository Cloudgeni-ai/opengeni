import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { bootstrapWorkspace, createDb, createSession, withWorkspaceSubjectRls } from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("rls-owner-capability-calls");
  if (!acquired) throw new Error("PostgreSQL application-role fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const FUNCTIONS = [
  "session_tenancy_fence_owner_policy_active",
  "scoped_compute_policy_capability_active",
] as const;
const OTHER_TENANT_SESSIONS = 3000;

async function workspace(label: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `${label}-${suffix}`,
    accountName: label,
    workspaceExternalSource: "test",
    workspaceExternalId: `${label}-${suffix}`,
    workspaceName: label,
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "m",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { workspaceId: grant.workspaceId!, subjectId: `subject-${suffix}`, sessionId: session.id };
}

// Every call to these owner-only definers is guarded by the same owner test the
// function starts with, so each policy admits exactly the rows it did before.
test("each owner capability call in a policy is guarded by its own owner test", async () => {
  const policies = await shared.admin<{ name: string; expression: string }[]>`
    select pol.polrelid::regclass || '.' || pol.polname as name,
      concat_ws(' ', pg_get_expr(pol.polqual, pol.polrelid),
        pg_get_expr(pol.polwithcheck, pol.polrelid)) as expression
    from pg_policy pol
    where exists (
      select 1 from pg_depend d
      where d.classid = 'pg_policy'::regclass and d.objid = pol.oid
        and d.refclassid = 'pg_proc'::regclass
        and d.refobjid in (
          'session_tenancy_fence_owner_policy_active(text, text, oid, uuid, boolean)'::regprocedure,
          'scoped_compute_policy_capability_active(text, text, text)'::regprocedure))`;
  expect(policies.length).toBeGreaterThan(40);
  const call = new RegExp(
    `(${FUNCTIONS.join("|")})\\(\\(CURRENT_USER\\)::text, ('(?:[^']|'')*'::text),`,
    "g",
  );
  for (const policy of policies) {
    const calls = [...policy.expression.matchAll(call)];
    expect(calls.length).toBeGreaterThan(0);
    for (const match of calls) {
      const guard = `((CURRENT_USER)::text = ${match[2]}) AND `;
      expect({
        policy: policy.name,
        guarded: policy.expression.slice(0, match.index).endsWith(guard),
      }).toEqual({ policy: policy.name, guarded: true });
    }
  }
});

// A scan through rows of another tenant tests every permissive policy on each
// row. The runtime role is never the owner, so the definers could only answer
// false, yet each was called several times per row.
test("the runtime role filters other tenants' rows without calling the owner definers", async () => {
  const other = await workspace("other");
  const reader = await workspace("reader");
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into sessions
      select clone.* from sessions s
      cross join (select gen_random_uuid() as id from generate_series(1, ${OTHER_TENANT_SESSIONS})) seed
      cross join lateral jsonb_populate_record(null::sessions, to_jsonb(s)
        || jsonb_build_object('id', seed.id, 'root_session_id', seed.id, 'create_idempotency_key', null)) clone
      where s.id = ${other.sessionId}::uuid`;
  });
  await shared.admin`analyze sessions`;
  const [database] = await shared.admin<{ name: string }[]>`select current_database() as name`;
  await shared.admin.unsafe(
    `alter role opengeni_app in database "${database!.name}" set track_functions = 'all'`,
  );

  const app = createDb(shared.appUrl, { max: 1 });
  try {
    const count = async (scope: { workspaceId: string; subjectId: string }) =>
      await withWorkspaceSubjectRls(app.db, scope.workspaceId, scope.subjectId, async (tx) => {
        const rows = await tx.execute(sql`select count(*)::int as count from sessions`);
        return Number((rows as unknown as { count: number }[])[0]!.count);
      });
    expect(await count(other)).toBe(OTHER_TENANT_SESSIONS + 1);
    await shared.admin`select pg_stat_reset()`;
    expect(await count(reader)).toBe(1);
    // One direct call marks when this connection's statistics have arrived.
    await app.db.execute(
      sql`select session_tenancy_fence_owner_policy_active(current_user::text, 'nobody', 0::oid, null, true)`,
    );
    await app.db.execute(sql`select pg_stat_force_next_flush()`);
    await app.db.execute(sql`select 1`);
  } finally {
    await app.close();
  }
  let calls: Record<string, number> = {};
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await shared.admin`select pg_stat_clear_snapshot()`;
    const rows = await shared.admin<{ name: string; calls: string }[]>`
      select funcname as name, calls::text as calls from pg_stat_user_functions
      where funcname in ${shared.admin(FUNCTIONS)}`;
    calls = Object.fromEntries(rows.map((row) => [row.name, Number(row.calls)]));
    if ((calls.session_tenancy_fence_owner_policy_active ?? 0) > 0) break;
    await Bun.sleep(100);
  }
  // Only the marker call: before, every scanned row of the other tenant called
  // the fence definer several times and the compute definer once or more.
  expect(calls.session_tenancy_fence_owner_policy_active).toBe(1);
  expect(calls.scoped_compute_policy_capability_active ?? 0).toBe(0);
}, 300_000);
