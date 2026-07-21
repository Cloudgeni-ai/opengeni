import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  assertRuntimeDatabasePosture,
  createApiKey,
  createDb,
  listApiKeys,
  RUNTIME_DML_TABLES,
  rlsStrategyFor,
  withWorkspaceRls,
  type Database,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

// The decisive migration-replay and RLS-isolation proof that the existing
// suites do NOT cover: a NON-OWNER role (`opengeni_app`) under FORCE RLS, in a
// DEDICATED schema (NOT public), reading through the REAL packages/db query path
// (createDb searchPath + withWorkspaceRls GUCs + provisionRoles grants).
//
// This closes the exact silent-failure hazard: under a dedicated schema, does a
// tenant-scoped query actually ISOLATE, or does it silently hit `public`/leak
// across tenants? We prove:
//   (A) the embedded migrate+provision SDK path lands tables/policies in the
//       dedicated schema only (0 in public), confirming idempotent schema isolation.
//   (B) rows written under workspace A's RLS context LAND IN THE DEDICATED SCHEMA
//       (verified by a superuser read of <schema>.api_keys), NOT silently in public.
//   (C) a cross-tenant read under workspace B's RLS context returns ZERO of A's
//       rows — RLS genuinely isolates under the non-owner role + dedicated schema.
//   (D) each tenant sees exactly its own rows under its own context.
//   (E) the handle's bound strategy is "force".
//
// By default this uses a throwaway pgvector pg17 Docker container on a
// non-default port and tears it down in afterAll. Environments without Docker
// may point OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL at an equally disposable
// PostgreSQL database with pgvector installed; this test applies every migration
// and creates/normalizes roles, so a shared or persistent database is unsafe.

// Fixed Docker listeners stay above Linux's default ephemeral client-port range;
// the container name binds the listener contract across worktrees.
const PORT = 61441;
const CONTAINER = `ogverify-pg-rls-dedicated-${PORT}`;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const SCHEMA = "tenantx";
const EXTERNAL_ADMIN_URL = process.env.OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL?.trim();
const ADMIN_URL =
  EXTERNAL_ADMIN_URL || `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const appUrl = new URL(ADMIN_URL);
appUrl.username = "opengeni_app";
appUrl.password = APP_PASSWORD;
const APP_URL = appUrl.toString();
const SEARCH_PATH = `${SCHEMA},opengeni_private,public`;
const IMAGE = "pgvector/pgvector:pg17";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
let dockerStarted = false;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

// Seed a fresh (account, workspace) as the superuser (bypasses RLS) directly in
// the dedicated schema. We MUST schema-qualify because the admin connection's
// search_path is the server default (public).
async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into ${admin(SCHEMA)}.managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into ${admin(SCHEMA)}.workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  if (!EXTERNAL_ADMIN_URL) {
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
      dockerStarted = true;
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
  });

  admin = postgres(ADMIN_URL, { max: 4 });

  // createDb with the dedicated-schema search_path + force strategy — the exact
  // embedded handle shape (minus userLookup).
  client = createDb(APP_URL, { max: 1, searchPath: SEARCH_PATH, rlsStrategy: "force" });
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
  if (dockerStarted) {
    removeContainer();
  }
});

describe("migration replay — RLS isolation under a DEDICATED schema + NON-OWNER role", () => {
  test("runtime identity and every declared tenant table satisfy the exact FORCE-RLS posture", async () => {
    if (!available) return;
    const posture = await assertRuntimeDatabasePosture(db, {
      rlsStrategy: "force",
      expectedRole: "opengeni_app",
      targetSchema: SCHEMA,
    });

    expect(posture.identity).toMatchObject({
      currentUser: "opengeni_app",
      sessionUser: "opengeni_app",
      canLogin: true,
      superuser: false,
      inherit: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
      canCreateInDatabase: false,
      rowSecurity: "on",
    });
    expect(posture.memberships).toEqual([]);
    expect(posture.ownedSchemas).toEqual([]);
    expect(posture.ownedRelations).toEqual([]);
    expect(posture.tables.filter((table) => table.rlsEnabled)).toHaveLength(65);
    expect(posture.tables.filter((table) => table.rlsActive)).toHaveLength(65);
    expect(
      posture.tables.filter(
        (table) => table.select && table.insert && table.update && table.delete,
      ),
    ).toHaveLength(RUNTIME_DML_TABLES.length);
    expect(posture.tables.find((table) => table.name === "schema_migrations")).toMatchObject({
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
    expect(
      posture.tables.find((table) => table.name === "session_history_items_repair_audit"),
    ).toMatchObject({ select: false, insert: false, update: false, delete: false });
  });

  test("the restricted runtime role can perform Better Auth table DML", async () => {
    if (!available) return;
    const userId = `posture-auth-${crypto.randomUUID()}`;
    const email = `${userId}@example.test`;
    await db.execute(sql`
      insert into auth_users (id, name, email)
      values (${userId}, 'Runtime posture test', ${email})
    `);
    const rows = (await db.execute(sql`
      select id, email from auth_users where id = ${userId}
    `)) as unknown as Array<{ id: string; email: string }>;
    expect(rows).toEqual([{ id: userId, email }]);
    await db.execute(sql`delete from auth_users where id = ${userId}`);
  });

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

  test("(B) rows written under A's RLS context land in the DEDICATED schema, not public", async () => {
    if (!available) return;
    const wsA = await freshWorkspace();
    const keyHash = `hashA-${crypto.randomUUID()}`;
    await createApiKey(db, {
      accountId: wsA.accountId,
      workspaceId: wsA.workspaceId,
      name: "keyA",
      prefix: "pkA",
      keyHash,
      permissions: ["workspace:read"],
    });
    // Superuser read of the DEDICATED schema's table — the row must be HERE.
    const inSchema = (
      await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ${admin(SCHEMA)}.api_keys WHERE key_hash = ${keyHash}`
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
    const keyHashA = `iso-hash-A-${crypto.randomUUID()}`;
    const keyHashB = `iso-hash-B-${crypto.randomUUID()}`;
    await createApiKey(db, {
      accountId: wsA.accountId,
      workspaceId: wsA.workspaceId,
      name: "onlyA",
      prefix: "pA",
      keyHash: keyHashA,
      permissions: ["workspace:read"],
    });
    await createApiKey(db, {
      accountId: wsB.accountId,
      workspaceId: wsB.workspaceId,
      name: "onlyB",
      prefix: "pB",
      keyHash: keyHashB,
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
        (await import("drizzle-orm")).sql`select id from api_keys where key_hash = ${keyHashA}`,
      );
      return rows as unknown as Array<{ id: string }>;
    });
    expect(crossTenant.length).toBe(0);

    // Sanity: under A's own context the same probe DOES find A's row (proves the
    // 0 above is RLS isolation, not a broken query / wrong schema returning empty).
    const ownTenant = await withWorkspaceRls(db, wsA.workspaceId, async (scoped) => {
      const rows = await scoped.execute(
        (await import("drizzle-orm")).sql`select id from api_keys where key_hash = ${keyHashA}`,
      );
      return rows as unknown as Array<{ id: string }>;
    });
    expect(ownTenant.length).toBe(1);
  });

  test("account/workspace GUCs are transaction-local and remain empty after reconnect", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    await withWorkspaceRls(db, workspace.workspaceId, async (scoped) => {
      const [inside] = (await scoped.execute(sql`
        select
          current_setting('opengeni.account_id', true) as account_id,
          current_setting('opengeni.workspace_id', true) as workspace_id
      `)) as unknown as Array<{ account_id: string; workspace_id: string }>;
      expect(inside).toEqual({
        account_id: workspace.accountId,
        workspace_id: workspace.workspaceId,
      });
    });

    const [afterCommit] = (await db.execute(sql`
      select
        current_setting('opengeni.account_id', true) as account_id,
        current_setting('opengeni.workspace_id', true) as workspace_id
    `)) as unknown as Array<{ account_id: string; workspace_id: string }>;
    expect(afterCommit).toEqual({ account_id: "", workspace_id: "" });

    const reconnected = createDb(APP_URL, {
      max: 1,
      searchPath: SEARCH_PATH,
      rlsStrategy: "force",
    });
    try {
      const [afterReconnect] = (await reconnected.db.execute(sql`
        select
          current_setting('opengeni.account_id', true) as account_id,
          current_setting('opengeni.workspace_id', true) as workspace_id
      `)) as unknown as Array<{ account_id: string | null; workspace_id: string | null }>;
      expect(afterReconnect?.account_id ?? "").toBe("");
      expect(afterReconnect?.workspace_id ?? "").toBe("");
    } finally {
      await reconnected.close();
    }
  });
});
