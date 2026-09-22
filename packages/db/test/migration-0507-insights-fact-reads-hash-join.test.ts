import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const FACT_AUTHORITIES = [
  "visible_workspace_insights_usage_projection(uuid, timestamp with time zone, timestamp with time zone, text[])",
  "visible_workspace_insights_usage_events(uuid, timestamp with time zone, timestamp with time zone, text[])",
  "visible_workspace_insights_usage_events(uuid, timestamp with time zone, timestamp with time zone)",
  "visible_workspace_insights_model_call_facts(uuid, timestamp with time zone, timestamp with time zone, text, text)",
  "visible_workspace_insights_model_call_facts(uuid, timestamp with time zone, timestamp with time zone)",
];

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0507");
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

test("0507 is a rolling planner pin that touches nothing but function configuration", async () => {
  const candidate = await Bun.file(
    new URL("../drizzle/0507_insights_fact_reads_hash_join.sql", import.meta.url),
  ).text();
  expect(candidate).toStartWith("-- deployment-mode: rolling");
  expect(candidate.match(/ALTER FUNCTION opengeni_private\./g)).toHaveLength(
    FACT_AUTHORITIES.length,
  );
  expect(candidate.match(/SET enable_nestloop = off;/g)).toHaveLength(FACT_AUTHORITIES.length);
  for (const authority of FACT_AUTHORITIES) {
    const [name, args] = authority.split("(");
    expect(candidate).toContain(`ALTER FUNCTION opengeni_private.${name}(`);
    expect(candidate.replace(/\s+/g, " ")).toContain(`${name}( ${args!.replace(")", "")} )`);
  }
  expect(candidate).not.toContain("CREATE");
  expect(candidate).not.toContain("POLICY");
  expect(candidate).not.toContain("SECURITY");
  expect(candidate).not.toContain("search_path");
});

test("every insights fact authority keeps its protocol and carries the hash-join-safe pin", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const routines = await shared.admin<
    Array<{
      name: string;
      securityDefiner: boolean;
      volatility: string;
      configuration: string[] | null;
      publicExecute: boolean;
    }>
  >`
    select
      procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')' as name,
      procedure.prosecdef as "securityDefiner",
      procedure.provolatile as volatility,
      procedure.proconfig as configuration,
      exists (
        select 1
        from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ) as "publicExecute"
    from pg_proc procedure
    inner join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'opengeni_private'
      and procedure.proname in (
        'visible_workspace_insights_usage_projection',
        'visible_workspace_insights_usage_events',
        'visible_workspace_insights_model_call_facts'
      )
    order by procedure.proname, procedure.pronargs desc`;
  const identityArgs = (authority: string) =>
    authority.replace(
      /\(([^)]*)\)/,
      (_match, args: string) =>
        `(${args
          .split(",")
          .map((arg) => arg.trim().replace("p_", ""))
          .join(", ")})`,
    );
  expect(routines.map((routine) => routine.name).sort()).toEqual(
    FACT_AUTHORITIES.map((authority) =>
      identityArgs(authority)
        .replace(
          "(uuid, timestamp with time zone, timestamp with time zone, text[])",
          "(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_event_types text[])",
        )
        .replace(
          "(uuid, timestamp with time zone, timestamp with time zone, text, text)",
          "(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_provider text, p_model text)",
        )
        .replace(
          "(uuid, timestamp with time zone, timestamp with time zone)",
          "(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone)",
        ),
    ).sort(),
  );
  for (const routine of routines) {
    expect(routine.securityDefiner).toBe(true);
    expect(routine.publicExecute).toBe(false);
    expect(routine.volatility).toBe("v");
    expect(routine.configuration).toEqual([
      "search_path=pg_catalog, public, opengeni_private, pg_temp",
      "enable_nestloop=off",
    ]);
  }
});
