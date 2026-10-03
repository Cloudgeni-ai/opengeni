import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, ensureManagedAccessForUser } from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

setDefaultTimeout(180_000);
let shared: SharedTestDatabase | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("reservation-ledger-compatibility");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 180_000);

test("forward exclusion migrations preserve current analytics, amount and plan contracts", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const [installed] = await shared.admin<Array<{ export: string; summary: string }>>`
    select pg_get_functiondef('opengeni_private.enqueue_host_usage_event_export()'::regprocedure) as export,
      pg_get_functiondef('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure) as summary`;
  expect(installed).toBeDefined();
  expect(installed!.export).toContain("v_surface, v_model_provider");
  expect(installed!.export).toContain("analytics_model_provider");
  expect(installed!.export).toContain("coalesce(octet_length(v_surface), 0)");
  expect(installed!.export).toContain("IF NEW.event_type LIKE '%.reserved'");
  expect(installed!.summary).toContain("'personalWorkspaces'");
  expect(installed!.summary).toContain("'privateChatsTruncated'");
  expect(installed!.summary).toContain("close_session_tenancy_fence_inventory");
  expect(installed!.summary).toContain("WITH visible AS NOT MATERIALIZED");
  expect(installed!.summary).toContain("JOIN private_sessions matched_session");
  expect(installed!.summary).toContain("SET enable_nestloop TO 'off'");
  expect(installed!.summary.match(/usage_row.event_type NOT LIKE '%\.reserved'/g)).toHaveLength(2);
});

test("old and prior-month unknown holds count without appearing in organization amounts", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const client = createDb(shared.appUrl, { max: 1, rlsStrategy: "force" });
  const app = postgres(shared.appUrl, {
    max: 1,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  try {
    const userId = `reservation-compat-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Reservation compatibility fixture",
    });
    const grant = access.workspaceGrants[0]!;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const old = new Date(monthStart.getTime() - 86_400_000);
    const source = `unknown-hold:${crypto.randomUUID()}`;
    await shared.admin`
      insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
        source_resource_type, source_resource_id, idempotency_key, occurred_at)
      values (${grant.accountId}, ${grant.workspaceId}, 'model.cost.reserved', 80, 'usd_micros',
        'model_call_reservation', ${source}, ${source}, ${old}),
        (${grant.accountId}, ${grant.workspaceId}, 'model.cost', 3, 'usd_micros',
        'model_response', ${`${source}:actual`}, ${`${source}:actual`}, now())`;
    const accountResult = () =>
      app.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${grant.accountId}, true),
        set_config('opengeni.workspace_id', '', true),
        set_config('opengeni.subject_id', '', true),
        set_config('opengeni.initiating_human_subject_id', '', true)`;
        const [row] = await tx<
          Array<{
            held: string;
            summary: { totals: Array<{ eventType: string; quantity: string }> };
          }>
        >`
        select opengeni_private.account_open_usage_reservations(
          ${grant.accountId}, 'model.cost.reserved', ${monthStart}, now())::text as held,
          opengeni_private.organization_usage_summary(
            ${grant.accountId}, ${monthStart}, now(), 'day', null, true) as summary`;
        return row;
      });
    const held = await accountResult();
    expect(held?.held).toBe("80");
    expect(held?.summary.totals.some((item) => item.eventType.endsWith(".reserved"))).toBe(false);
    expect(held?.summary.totals.find((item) => item.eventType === "model.cost")?.quantity).toBe(
      "3",
    );
    // A release in a later month still nets against its own original hold.
    await shared.admin`
      insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
        source_resource_type, source_resource_id, idempotency_key, occurred_at)
      values (${grant.accountId}, ${grant.workspaceId}, 'model.cost.reserved', -80, 'usd_micros',
        'model_call_reservation', ${source}, ${`${source}:release`}, now())`;
    expect((await accountResult())?.held).toBe("0");
  } finally {
    await app.end();
    await client.close();
  }
});

test("account aggregates retain private ACLs and refuse a conflicting actor capability", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const role = new URL(shared.appUrl).username;
  const routines = await shared.admin<
    Array<{ definer: boolean; owner: boolean; executable: boolean; public: boolean }>
  >`
    select procedure.prosecdef as definer,
      procedure.proowner = (select relowner from pg_class where oid = 'usage_events'::regclass) as owner,
      has_function_privilege(${role}, procedure.oid, 'EXECUTE') as executable,
      exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public
    from pg_proc procedure
    where procedure.oid in (
      'opengeni_private.account_usage_quantity(uuid,text,timestamptz)'::regprocedure,
      'opengeni_private.account_open_usage_reservations(uuid,text,timestamptz,timestamptz)'::regprocedure)`;
  expect(routines).toHaveLength(2);
  expect(
    routines.every(
      (routine) => routine.definer && routine.owner && routine.executable && !routine.public,
    ),
  ).toBe(true);
  const accountId = crypto.randomUUID();
  await expect(
    shared.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', '', true),
      set_config('opengeni.subject_id', 'user:current', true),
      set_config('opengeni.initiating_human_subject_id', '', true),
      set_config('application_name', ${LOSSLESS_CONTENT_WRITER_APPLICATION_NAME}, true)`;
      await tx`insert into opengeni_private.organization_usage_read_capabilities
      (backend_pid, transaction_id, account_id, subject_id)
      values (pg_backend_pid(), pg_current_xact_id(), ${accountId}, 'user:other')`;
      await tx`select opengeni_private.account_usage_quantity(${accountId}, 'model.cost', now())`;
    }),
  ).rejects.toThrow("Account usage capability context mismatch");
});
