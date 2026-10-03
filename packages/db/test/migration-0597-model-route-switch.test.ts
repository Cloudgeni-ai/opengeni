import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";
import postgres from "postgres";

import {
  createDb,
  nestedPostgresSqlState,
  readModelRouteSwitchStates,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES,
} from "../src/runtime-posture";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const SETTER = "set_model_route(text, text, text, text)";
const TABLE = "opengeni_private.model_route_switch_revisions";
const MIGRATION = "0597_model_route_switch.sql";
let owned: OwnerMigratedTestDatabase | null = null;
let appClient: DbClient | null = null;
let app: postgres.Sql | null = null;
let owner: postgres.Sql | null = null;

type SwitchResult = {
  revision: number;
  productModelId: string;
  route: "primary" | "fallback";
  previousRoute: "primary" | "fallback" | null;
  changed: boolean;
  operator: string;
  reason: string;
  databaseRole: string;
  changedAt: string;
};

async function setRoute(
  productModelId: string,
  route: "primary" | "fallback",
  reason: string,
): Promise<SwitchResult> {
  if (!owner) throw new Error("test database unavailable");
  const [row] = await owner<Array<{ result: SwitchResult }>>`
    select set_model_route(${productModelId}, ${route}, 'test-operator', ${reason}) as result`;
  return row!.result;
}

async function sqlStateOf(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
  } catch (error) {
    return nestedPostgresSqlState(error) ?? null;
  }
  return null;
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0597-model-route-switch");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("model route switch PostgreSQL fixture is unavailable");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  appClient = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), { max: 1, prepare: false, onnotice: () => undefined });
  owner = postgres(owned.ownerUrl, { max: 2, prepare: false, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await owner?.end().catch(() => undefined);
  await appClient?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("migration 0597 model route switch", () => {
  test("is a rolling, operator-only switch", () => {
    const migration = readFileSync(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${SETTER} FROM PUBLIC`);
    expect(RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES).toContain(SETTER);
  });

  test("starts with every product on its primary route", async () => {
    if (!owned || !appClient) return;
    expect(await readModelRouteSwitchStates(appClient.db)).toEqual([]);
  });

  test("the audited setter moves one product at a time, recording who and why", async () => {
    if (!owned || !appClient) return;
    const luna = await setRoute("gpt-6-luna", "fallback", "Azure Luna quota exhausted at launch");
    expect(luna).toMatchObject({
      productModelId: "gpt-6-luna",
      route: "fallback",
      previousRoute: null,
      changed: true,
      operator: "test-operator",
      reason: "Azure Luna quota exhausted at launch",
      databaseRole: owned.ownerRole,
    });
    const sol = await setRoute("azure-sol/gpt-6.1-sol", "fallback", "Sol quota exhausted too");
    const repeated = await setRoute("gpt-6-luna", "fallback", "confirm Luna stays on fallback");
    expect(repeated).toMatchObject({
      route: "fallback",
      previousRoute: "fallback",
      changed: false,
    });
    expect(
      (await readModelRouteSwitchStates(appClient.db)).map(
        ({ productModelId, route, revision }) => ({
          productModelId,
          route,
          revision,
        }),
      ),
    ).toEqual([
      { productModelId: "azure-sol/gpt-6.1-sol", route: "fallback", revision: sol.revision },
      { productModelId: "gpt-6-luna", route: "fallback", revision: repeated.revision },
    ]);
    const back = await setRoute("gpt-6-luna", "primary", "Azure quota raised, back to primary");
    expect(back).toMatchObject({ route: "primary", previousRoute: "fallback", changed: true });
    expect(
      (await readModelRouteSwitchStates(appClient.db)).find(
        (state) => state.productModelId === "gpt-6-luna",
      )?.route,
    ).toBe("primary");
  });

  test("revisions are append-only and inputs are validated", async () => {
    if (!owned || !owner) return;
    await setRoute("gpt-6-astra", "primary", "seed a row for mutation checks");
    expect(await sqlStateOf(() => owner!.unsafe(`update ${TABLE} set route = 'fallback'`))).toBe(
      "55000",
    );
    expect(await sqlStateOf(() => owner!.unsafe(`delete from ${TABLE}`))).toBe("55000");
    expect(await sqlStateOf(() => owner!.unsafe(`truncate ${TABLE}`))).toBe("55000");

    for (const [product, route, operator, reason] of [
      [null, "fallback", "test-operator", "valid reason text"],
      ["bad product id", "fallback", "test-operator", "valid reason text"],
      ["gpt-6-luna", "openrouter", "test-operator", "valid reason text"],
      ["gpt-6-luna", null, "test-operator", "valid reason text"],
      ["gpt-6-luna", "fallback", " padded ", "valid reason text"],
      ["gpt-6-luna", "fallback", "test-operator", "short"],
      ["gpt-6-luna", "fallback", "test-operator", null],
    ] as const) {
      expect(
        await sqlStateOf(
          () => owner!`select set_model_route(
            ${product}::text, ${route}::text, ${operator}::text, ${reason}::text)`,
        ),
      ).toBe("22023");
    }
  });

  test("strips default-privilege grants from the switch table and setter at creation", async () => {
    if (!owned || !owner) return;
    const migration = readFileSync(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
    const rollback = new Error("roll back the 0597 replay");
    let grantees: { table_grantees: string[]; setter_grantees: string[] } | undefined;
    await owner
      .begin(async (tx) => {
        await tx.unsafe(`
          DROP TABLE ${TABLE};
          DROP FUNCTION public.${SETTER};
          DROP FUNCTION public.reject_model_route_switch_revision_mutation();
          ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opengeni_app;
          ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO opengeni_app;
        `);
        await tx.unsafe(migration);
        [grantees] = await tx<Array<{ table_grantees: string[]; setter_grantees: string[] }>>`
          select
            coalesce((
              select array_agg(distinct acl.grantee::regrole::text)
              from pg_class c,
                aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
              where c.oid = ${TABLE}::text::regclass
                and acl.grantee <> c.relowner
            ), '{}'::text[]) as table_grantees,
            coalesce((
              select array_agg(distinct acl.grantee::regrole::text)
              from pg_proc p,
                aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              where p.oid = ${`public.${SETTER}`}::text::regprocedure
                and acl.grantee <> p.proowner
            ), '{}'::text[]) as setter_grantees`;
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    expect(grantees).toEqual({ table_grantees: [], setter_grantees: [] });
  }, 60_000);

  test("the runtime role can read the switch but never flip or rewrite it", async () => {
    if (!owned || !app || !appClient) return;
    const [privileges] = await owned.admin<
      Array<{
        runtime_execute: boolean;
        runtime_select: boolean;
        runtime_insert: boolean;
        runtime_update: boolean;
        runtime_delete: boolean;
        security_definer: boolean;
        setter_config: string[];
      }>
    >`
      select
        has_function_privilege('opengeni_app', ${`public.${SETTER}`}::text, 'EXECUTE') as runtime_execute,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'SELECT') as runtime_select,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'INSERT') as runtime_insert,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'UPDATE') as runtime_update,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'DELETE') as runtime_delete,
        (select p.prosecdef from pg_proc p where p.oid = ${`public.${SETTER}`}::text::regprocedure)
          as security_definer,
        (select p.proconfig from pg_proc p where p.oid = ${`public.${SETTER}`}::text::regprocedure)
          as setter_config`;
    expect(privileges).toMatchObject({
      runtime_execute: false,
      runtime_select: true,
      runtime_insert: false,
      runtime_update: false,
      runtime_delete: false,
      security_definer: true,
    });
    expect(privileges!.setter_config).toContain("search_path=pg_catalog, public, pg_temp");

    const before = await readModelRouteSwitchStates(appClient.db);
    expect(
      await sqlStateOf(
        () =>
          app!`select set_model_route('gpt-6-luna', 'fallback', 'runtime', 'forged runtime flip')`,
      ),
    ).toBe("42501");
    expect(
      await sqlStateOf(() =>
        app!.unsafe(
          `insert into ${TABLE} (product_model_id, route, operator, reason)
           values ('gpt-6-luna', 'fallback', 'runtime', 'forged runtime row')`,
        ),
      ),
    ).toBe("42501");
    expect(await readModelRouteSwitchStates(appClient.db)).toEqual(before);

    const options = {
      expectedRole: "opengeni_app",
      targetSchema: "public",
      rlsStrategy: "force" as const,
      organizationTenancyCanonicalActivationEnabled: true,
    };
    const switchViolations = async () =>
      evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(appClient!.db, options),
        options,
      ).filter(
        (message) => message.includes("set_model_route") || message.includes("model route switch"),
      );
    expect(await switchViolations()).toEqual([]);
    await owned.admin.unsafe(
      `GRANT EXECUTE ON FUNCTION public.${SETTER} TO opengeni_app;
       GRANT INSERT ON ${TABLE} TO opengeni_app`,
    );
    try {
      expect(await switchViolations()).toEqual([
        `runtime role has forbidden owner-internal helper ${SETTER}`,
        "runtime role has forbidden write authority on the model route switch",
      ]);
    } finally {
      await provisionRoles(owned.adminUrl, {
        appPassword: owned.appPassword,
        rlsStrategy: "force",
      });
    }
    const [repaired] = await owned.admin<
      Array<{ runtime_execute: boolean; runtime_insert: boolean; runtime_select: boolean }>
    >`
      select
        has_function_privilege('opengeni_app', ${`public.${SETTER}`}::text, 'EXECUTE') as runtime_execute,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'INSERT') as runtime_insert,
        has_table_privilege('opengeni_app', ${TABLE}::text, 'SELECT') as runtime_select`;
    expect(repaired).toEqual({
      runtime_execute: false,
      runtime_insert: false,
      runtime_select: true,
    });
  }, 180_000);
});
