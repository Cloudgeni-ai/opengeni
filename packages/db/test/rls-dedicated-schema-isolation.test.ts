import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import {
  createApiKey,
  createDb,
  deactivateSandboxEphemeralOwner,
  listApiKeys,
  registerSandboxEphemeralOwner,
  rlsStrategyFor,
  withWorkspaceRls,
  type Database,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

// VERIFIER (Step I, Fork-6) — the decisive RLS isolation proof that the existing
// suites do NOT cover: a NON-OWNER role (`opengeni_app`) under FORCE RLS, in a
// DEDICATED schema (NOT public), reading through the REAL packages/db query path
// (createDb searchPath + withWorkspaceRls GUCs + provisionRoles grants).
//
// This closes the exact silent-failure hazard: under a dedicated schema, does a
// tenant-scoped query actually ISOLATE, or does it silently hit `public`/leak
// across tenants? We prove:
//   (A) the embedded migrate+provision SDK path lands tables/policies in the
//       dedicated schema only (0 in public) — re-confirms SPIKE-1 F1 idempotently.
//   (B) rows written under workspace A's RLS context LAND IN THE DEDICATED SCHEMA
//       (verified by a superuser read of <schema>.api_keys), NOT silently in public.
//   (C) a cross-tenant read under workspace B's RLS context returns ZERO of A's
//       rows — RLS genuinely isolates under the non-owner role + dedicated schema.
//   (D) each tenant sees exactly its own rows under its own context.
//   (E) the handle's bound strategy is "force".
//
// Throwaway pgvector pg17, non-default port, torn down in afterAll.

// Fixed Docker listeners stay above Linux's default ephemeral client-port range;
// the container name binds the listener contract across worktrees.
const PORT = 61441;
const CONTAINER = `ogverify-pg-rls-dedicated-${PORT}`;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const SCHEMA = "tenantx";
const directAdminUrl = process.env.OPENGENI_TEST_DEDICATED_ADMIN_DATABASE_URL;
const directAppUrl = process.env.OPENGENI_TEST_DEDICATED_APP_DATABASE_URL;
if (Boolean(directAdminUrl) !== Boolean(directAppUrl)) {
  throw new Error(
    "OPENGENI_TEST_DEDICATED_ADMIN_DATABASE_URL and OPENGENI_TEST_DEDICATED_APP_DATABASE_URL must be set together",
  );
}
const usesDocker = !directAdminUrl;
const ADMIN_URL = directAdminUrl ?? `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const APP_URL =
  directAppUrl ?? `postgres://opengeni_app:${APP_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const SEARCH_PATH = `${SCHEMA},opengeni_private,public`;
const IMAGE = "pgvector/pgvector:pg17";

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function removeContainer(): void {
  try {
    docker(["rm", "-f", "-v", CONTAINER]);
  } catch {
    // already gone
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`postgres did not become ready in time: ${String(err)}`, { cause: err });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let available = true;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

// Seed a fresh (account, workspace) as the superuser (bypasses RLS) directly in
// the dedicated schema. We MUST schema-qualify because the admin connection's
// search_path is the server default (public).
async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
}> {
  const [a] = await admin<{ id: string }[]>`
    insert into ${admin(SCHEMA)}.managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into ${admin(SCHEMA)}.workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  if (usesDocker) {
    try {
      removeContainer();
      docker([
        "run",
        "--rm",
        "-d",
        "-e",
        `POSTGRES_PASSWORD=${PASSWORD}`,
        "-p",
        `${PORT}:5432`,
        "--name",
        CONTAINER,
        IMAGE,
      ]);
    } catch (err) {
      available = false;
      console.warn(`[rls-dedicated] docker unavailable, skipping: ${String(err)}`);
      return;
    }
  }
  await waitForReady();

  // (A) embedded migrate into the dedicated schema via the SDK entry point.
  await migrate(ADMIN_URL, SCHEMA);

  // Provision the non-owner app role via the REAL provisionRoles SDK entry, in
  // FORCE strategy, against the dedicated schema. This GRANTs opengeni_app DML on
  // <schema>.* + EXECUTE on opengeni_private.* — the role openGeni connects as so
  // FORCE RLS is genuinely enforced (a superuser would bypass it).
  await provisionRoles(ADMIN_URL, {
    targetSchema: SCHEMA,
    rlsStrategy: "force",
    appRole: "opengeni_app",
    appPassword: APP_PASSWORD,
    temporalPassword: "",
  });

  admin = postgres(ADMIN_URL, { max: 4 });

  // createDb with the dedicated-schema search_path + force strategy — the exact
  // embedded handle shape (minus userLookup).
  client = createDb(APP_URL, { searchPath: SEARCH_PATH, rlsStrategy: "force" });
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  try {
    await admin?.end();
  } catch {
    /* noop */
  }
  if (usesDocker) removeContainer();
});

describe("Step I Fork-6 — RLS isolation under a DEDICATED schema + NON-OWNER role", () => {
  test("(A) tables + policies isolate to the dedicated schema, 0 in public", async () => {
    if (!available) return;
    const tablesInSchema = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = ${SCHEMA}`
    )[0]!.count;
    const tablesInPublic = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`
    )[0]!.count;
    const policiesInSchema = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = ${SCHEMA}`
    )[0]!.count;
    const policiesInPublic = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public'`
    )[0]!.count;
    expect(tablesInSchema).toBeGreaterThan(30);
    expect(tablesInPublic).toBe(0);
    expect(policiesInSchema).toBeGreaterThan(20);
    expect(policiesInPublic).toBe(0);
  });

  test("(E) the createDb handle is bound to the force strategy", async () => {
    if (!available) return;
    expect(rlsStrategyFor(db)).toBe("force");
  });

  test("(F) protected owner lifecycle ACL survives repeated dedicated-schema provisioning", async () => {
    if (!available) return;

    // provisionRoles() first grants ordinary table DML, then must reapply the
    // protected-registry exception. A later/retried call cannot reopen direct
    // mutation authority.
    await provisionRoles(ADMIN_URL, {
      targetSchema: SCHEMA,
      rlsStrategy: "force",
      appRole: "opengeni_app",
      appPassword: APP_PASSWORD,
      temporalPassword: "",
    });
    const [acl] = await admin<
      {
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
      }[]
    >`
      select
        has_table_privilege(
          'opengeni_app',
          to_regclass(${`${SCHEMA}.sandbox_ephemeral_owners`}),
          'SELECT'
        ) as can_select,
        has_table_privilege(
          'opengeni_app',
          to_regclass(${`${SCHEMA}.sandbox_ephemeral_owners`}),
          'INSERT'
        ) as can_insert,
        has_table_privilege(
          'opengeni_app',
          to_regclass(${`${SCHEMA}.sandbox_ephemeral_owners`}),
          'UPDATE'
        ) as can_update,
        has_table_privilege(
          'opengeni_app',
          to_regclass(${`${SCHEMA}.sandbox_ephemeral_owners`}),
          'DELETE'
        ) as can_delete,
        has_table_privilege(
          'opengeni_app',
          to_regclass(${`${SCHEMA}.sandbox_ephemeral_owners`}),
          'TRUNCATE'
        ) as can_truncate`;
    expect(acl).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    });

    const functions = await admin<
      Array<{
        proname: string;
        prosecdef: boolean;
        proconfig: string[] | null;
        prosrc: string;
      }>
    >`
      select P.proname, P.prosecdef, P.proconfig, P.prosrc
      from pg_proc P
      join pg_namespace N on N.oid = P.pronamespace
      where N.nspname = 'opengeni_private'
        and P.proname in (
          'register_sandbox_ephemeral_owner',
          'deactivate_sandbox_ephemeral_owner',
          'list_live_modal_sandbox_instances'
        )
      order by P.proname`;
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain("search_path=pg_catalog");
      expect(fn.prosrc).toContain(`${SCHEMA}.sandbox_ephemeral_owners`);
    }

    const workspace = await freshWorkspace();
    const executionId = crypto.randomUUID();
    const instanceId = `modal-dedicated-owner-${executionId}`;
    await expect(
      registerSandboxEphemeralOwner(db, {
        executionId,
        ...workspace,
        kind: "rig_verification",
        backend: "modal",
        instanceId,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      }),
    ).resolves.toMatchObject({ executionId, instanceId, active: true });
    await expect(
      deactivateSandboxEphemeralOwner(db, {
        executionId,
        ...workspace,
        kind: "rig_verification",
        backend: "modal",
        instanceId,
      }),
    ).resolves.toBe(true);
  });

  test("(B) rows written under A's RLS context land in the DEDICATED schema, not public", async () => {
    if (!available) return;
    const wsA = await freshWorkspace();
    await createApiKey(db, {
      accountId: wsA.accountId,
      workspaceId: wsA.workspaceId,
      name: "keyA",
      prefix: "pkA",
      keyHash: "hashA",
      permissions: ["workspace:read"],
    });
    // Superuser read of the DEDICATED schema's table — the row must be HERE.
    const inSchema = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${admin(SCHEMA)}.api_keys WHERE key_hash = 'hashA'`
    )[0]!.count;
    expect(inSchema).toBe(1);
    // And public.api_keys must NOT exist at all (proves no silent public fallback).
    const publicApiKeysExists = (
      await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='api_keys') AS exists`
    )[0]!.exists;
    expect(publicApiKeysExists).toBe(false);
  });

  test("(C/D) cross-tenant read under B's context returns ZERO of A's rows; each tenant sees only its own", async () => {
    if (!available) return;
    const wsA = await freshWorkspace();
    const wsB = await freshWorkspace();
    await createApiKey(db, {
      accountId: wsA.accountId,
      workspaceId: wsA.workspaceId,
      name: "onlyA",
      prefix: "pA",
      keyHash: "iso-hash-A",
      permissions: ["workspace:read"],
    });
    await createApiKey(db, {
      accountId: wsB.accountId,
      workspaceId: wsB.workspaceId,
      name: "onlyB",
      prefix: "pB",
      keyHash: "iso-hash-B",
      permissions: ["workspace:read"],
    });

    // listApiKeys wraps withWorkspaceRls → sets the account/workspace GUCs for the
    // given workspace, then selects. Under FORCE RLS as opengeni_app, the policy
    // admits ONLY rows matching the GUC.
    const seenByA = await listApiKeys(db, wsA.workspaceId);
    const seenByB = await listApiKeys(db, wsB.workspaceId);
    expect(seenByA.map((k) => k.name).sort()).toEqual(["onlyA"]);
    expect(seenByB.map((k) => k.name).sort()).toEqual(["onlyB"]);

    // The decisive cross-tenant raw probe: under workspace B's RLS context, a
    // direct SELECT of A's hash returns ZERO rows. If RLS silently failed (wrong
    // schema, unforced, owner role), this would return A's row.
    const crossTenant = await withWorkspaceRls(db, wsB.workspaceId, async (scoped) => {
      const rows = await scoped.execute(
        // raw to bypass the helper's own workspace filter — pure RLS gate test.
        (await import("drizzle-orm")).sql`select id from api_keys where key_hash = 'iso-hash-A'`,
      );
      return rows as unknown as Array<{ id: string }>;
    });
    expect(crossTenant.length).toBe(0);

    // Sanity: under A's own context the same probe DOES find A's row (proves the
    // 0 above is RLS isolation, not a broken query / wrong schema returning empty).
    const ownTenant = await withWorkspaceRls(db, wsA.workspaceId, async (scoped) => {
      const rows = await scoped.execute(
        (await import("drizzle-orm")).sql`select id from api_keys where key_hash = 'iso-hash-A'`,
      );
      return rows as unknown as Array<{ id: string }>;
    });
    expect(ownTenant.length).toBe(1);
  });
});
