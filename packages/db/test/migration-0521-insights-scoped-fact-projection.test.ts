import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

setDefaultTimeout(120_000);

const SIGNATURE =
  "visible_workspace_insights_model_fact_rows(uuid, timestamp with time zone, timestamp with time zone, text, text, uuid, uuid)";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) return await acquireSharedTestDatabase("migration-0519");
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 2 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (shared) client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("0521 is additive: one new fact authority, released functions and policies untouched", async () => {
  const candidate = await Bun.file(
    new URL("../drizzle/0521_insights_scoped_fact_projection.sql", import.meta.url),
  ).text();
  expect(candidate).toStartWith("-- deployment-mode: rolling");
  expect(candidate.match(/CREATE FUNCTION/g)).toHaveLength(1);
  expect(candidate).toContain(
    "CREATE FUNCTION opengeni_private.visible_workspace_insights_model_fact_rows(",
  );
  expect(candidate).not.toContain("CREATE OR REPLACE");
  expect(candidate).not.toContain("ALTER FUNCTION");
  expect(candidate).not.toContain("POLICY");
  expect(candidate).not.toContain("visible_workspace_insights_model_call_facts");
  // The 0359 capability protocol is reused verbatim, not a new capability kind.
  expect(candidate).toContain("'model_call_facts',");
  expect(candidate).toContain("opengeni.migration_application_roles");
});

test("the scoped projection is a pinned SECURITY DEFINER callable only by application roles", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const [routine] = await shared.admin<
    Array<{
      securityDefiner: boolean;
      volatility: string;
      configuration: string[] | null;
      grantees: string[];
      publicExecute: boolean;
    }>
  >`
    select
      procedure.prosecdef as "securityDefiner",
      procedure.provolatile as volatility,
      procedure.proconfig as configuration,
      coalesce(array_agg(distinct grantee.rolname) filter (
        where acl.privilege_type = 'EXECUTE' and acl.grantee <> procedure.proowner
      ), '{}') as grantees,
      bool_or(acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as "publicExecute"
    from pg_proc procedure
    inner join pg_namespace namespace on namespace.oid = procedure.pronamespace
    cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
    left join pg_roles grantee on grantee.oid = acl.grantee
    where namespace.nspname = 'opengeni_private'
      and procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')' =
        ${SIGNATURE.replace(
          "(uuid, timestamp with time zone, timestamp with time zone, text, text, uuid, uuid)",
          "(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_provider text, p_model text, p_root_session_id uuid, p_session_id uuid)",
        )}
    group by procedure.oid, procedure.prosecdef, procedure.provolatile, procedure.proconfig`;
  expect(routine).toBeDefined();
  expect(routine!.securityDefiner).toBe(true);
  expect(routine!.volatility).toBe("v");
  expect(routine!.publicExecute).toBe(false);
  expect(routine!.configuration).toEqual([
    "search_path=pg_catalog, public, opengeni_private, pg_temp",
    "enable_nestloop=off",
  ]);
  for (const grantee of routine!.grantees) {
    const [privileges] = await shared.admin<Array<{ facts: boolean; usage: boolean }>>`
      select has_table_privilege(${grantee}, 'model_call_facts', 'SELECT') as facts,
        has_table_privilege(${grantee}, 'usage_events', 'SELECT') as usage`;
    expect(privileges).toEqual({ facts: true, usage: true });
  }
});

test("the scoped projection enforces the exact workspace context and narrows by root", async () => {
  if (!shared || !client) throw new Error("PostgreSQL test database unavailable");
  const userId = `migration-0519-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Migration 0521 owner",
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const create = (parentSessionId: string | null) =>
    withSessionRlsActorContext({ subjectId }, () =>
      createSession(client!.db, {
        accountId: grant.accountId,
        workspaceId,
        initialMessage: "scoped projection",
        resources: [],
        metadata: {},
        model: "fixture-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
        parentSessionId,
      }),
    );
  const root = await create(null);
  const child = await create(root.id);
  const otherRoot = await create(null);
  await shared.admin`
    insert into model_call_facts (
      account_id, workspace_id, session_id, turn_id, source_key, provider, provider_api,
      model, billing_path, input_tokens, output_tokens, total_tokens, priced_cost_micros,
      occurred_at
    )
    select ${grant.accountId}, ${workspaceId}, session_id, gen_random_uuid(),
      'migration-0519-' || n, 'openai', 'responses', 'gpt-0519', 'opengeni_credits',
      10, 5, 15, 7, now() - interval '1 hour'
    from (values (${root.id}::uuid, 1), (${child.id}::uuid, 2), (${otherRoot.id}::uuid, 3))
      facts(session_id, n)`;

  const app = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  try {
    const read = async (contextWorkspaceId: string, rootSessionId: string | null) =>
      await app.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${grant.accountId}, true)`;
        await transaction`select set_config('opengeni.workspace_id', ${contextWorkspaceId}, true)`;
        await transaction`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        return await transaction<Array<{ session_id: string; root_session_id: string }>>`
          select session_id, root_session_id
          from opengeni_private.visible_workspace_insights_model_fact_rows(
            ${workspaceId}::uuid, now() - interval '1 day', now(), null, null,
            ${rootSessionId}::uuid, null
          )
          order by session_id`;
      });
    const all = await read(workspaceId, null);
    expect(all.map((row) => row.session_id).sort()).toEqual(
      [root.id, child.id, otherRoot.id].sort(),
    );
    const scoped = await read(workspaceId, root.id);
    expect(scoped.map((row) => row.session_id).sort()).toEqual([root.id, child.id].sort());
    expect(scoped.every((row) => row.root_session_id === root.id)).toBe(true);
    await expect(read(crypto.randomUUID(), root.id)).rejects.toMatchObject({ code: "42501" });
    const [leftover] = await shared.admin<Array<{ count: string }>>`
      select count(*)::text as count
      from opengeni_private.insights_fact_read_runtime_capabilities`;
    expect(leftover?.count).toBe("0");
  } finally {
    await app.end();
  }
});
