import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  provisionRoles,
} from "../src/index";
import { migrate, runMigrations } from "../src/migrate";

// Schema-isolation reconfirmation. Proves the embedded dedicated-schema path through the REAL
// `migrate()` SDK entry point:
//
//   1. `migrate(DB_URL, "opengeni")` lands EVERY table + RLS policy in the
//      dedicated `opengeni` schema, with ZERO leaking into `public`, via the
//      connection search_path + the `current_schema()` policy guards — NO
//      pgTable rewrite and NO per-statement SQL rewrite.
//   2. Re-running the chain under the SAME dedicated schema is IDEMPOTENT — the
//      load-bearing `current_schema()` guard fix (a `'public'`-pinned guard
//      would fail re-run with "policy ... already exists"; this is the migration-replay
//      silent-failure hazard the substitution closes).
//   3. The opengeni_private SECURITY-DEFINER helpers exist (RLS GUC readers).
//   4. STANDALONE (`migrate(DB_URL)` with no schema) keeps everything in
//      `public` — byte-for-byte today's behavior, run on a SECOND fresh db so
//      the two paths don't interfere.
//
// Two pristine databases from the shared real-PostgreSQL harness. An explicit
// OPENGENI_TEST_PG_URL selects native PostgreSQL without Docker or skip/pass.
// Canonical provisioning prepares the non-owner role and converges the exact
// current grants after migration; never manufacture fixture-only privileges.
let dedicated: BlankTestDatabase | undefined;
let standalone: BlankTestDatabase | undefined;

beforeAll(async () => {
  const acquiredDedicated = await acquireBlankTestDatabase("schema-isolation-dedicated");
  if (!acquiredDedicated) throw new Error("Dedicated-schema PostgreSQL fixture unavailable");
  dedicated = acquiredDedicated;
  const acquiredStandalone = await acquireBlankTestDatabase("schema-isolation-public");
  if (!acquiredStandalone) throw new Error("Standalone PostgreSQL fixture unavailable");
  standalone = acquiredStandalone;
}, 120_000);

afterAll(async () => {
  await Promise.all([dedicated?.release(), standalone?.release()]);
}, 120_000);

function applicationUrl(database: BlankTestDatabase): string {
  if (!database.appPassword) throw new Error("PostgreSQL fixture app password unavailable");
  const url = new URL(database.databaseUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  return url.toString();
}

describe("embedded dedicated-schema isolation", () => {
  test("migrate(url, 'opengeni') isolates all tables + policies into the dedicated schema, idempotently; standalone stays in public", async () => {
    if (!dedicated || !standalone) throw new Error("PostgreSQL schema fixtures unavailable");
    const appUrl = applicationUrl(dedicated);
    const roles = {
      appRole: "opengeni_app",
      appPassword: new URL(appUrl).password,
      targetSchema: "opengeni",
      rlsStrategy: "force" as const,
    };
    await provisionRoles(dedicated.databaseUrl, roles);

    // --- EMBEDDED leg: dedicated schema via the SDK entry point.
    // Run TWICE to prove idempotency under the current_schema() guards.
    await migrate(dedicated.databaseUrl, "opengeni", {
      applicationDatabaseRoles: ["opengeni_app"],
    });
    await runMigrations(dedicated.databaseUrl, "opengeni"); // second pass via the named SDK alias — must be a clean no-op.

    const sql = postgres(dedicated.databaseUrl, { max: 1 });
    try {
      // 0598 revokes PUBLIC on the generated CHECK validator. Migration alone
      // does not provision its app EXECUTE; reproduce the exact missing seam.
      const unprovisionedApp = postgres(appUrl, { max: 1 });
      try {
        await expect(
          Promise.resolve(
            unprovisionedApp`select opengeni.claude_provider_account_authority_snapshot_v1_valid(
            '{"version":1,"scope":"workspace"}'::jsonb)`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await unprovisionedApp.end();
      }
      await provisionRoles(dedicated.databaseUrl, roles);
      const [validator] = await sql<Array<{ execute: boolean; publicExecute: boolean }>>`
        select has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as execute,
          exists(select 1 from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
            where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as "publicExecute"
        from pg_proc procedure
        where procedure.oid = 'opengeni.claude_provider_account_authority_snapshot_v1_valid(jsonb)'::regprocedure`;
      expect(validator).toEqual({ execute: true, publicExecute: false });
      const tablesInOpengeni = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'opengeni'`;
      const tablesInPublic = await sql<{ name: string }[]>`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
        ORDER BY table_name`;

      // Every OpenGeni table landed in the dedicated schema, none in public.
      expect(tablesInOpengeni[0]!.count).toBeGreaterThan(30);
      expect(tablesInPublic.map((r) => r.name)).toEqual([]);

      // Every RLS policy is scoped to the dedicated schema, none in public.
      const policiesInOpengeni = (
        await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'opengeni'`
      )[0]!.count;
      const policiesInPublic = (
        await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public'`
      )[0]!.count;
      expect(policiesInOpengeni).toBeGreaterThan(20);
      expect(policiesInPublic).toBe(0);

      // The opengeni_private RLS GUC-reader helpers exist (SECURITY DEFINER).
      const privateFns = (
        await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'opengeni_private'`
      )[0]!.count;
      expect(privateFns).toBeGreaterThan(0);

      // RLS is enabled + FORCED on a representative table in the dedicated schema.
      const rls = (
        await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'opengeni' AND c.relname = 'sessions'`
      )[0]!;
      expect(rls.relrowsecurity).toBe(true);
      expect(rls.relforcerowsecurity).toBe(true);

      const [account] = await sql<{ id: string }[]>`
        INSERT INTO opengeni.managed_accounts (name) VALUES ('grant acct') RETURNING id`;
      const [workspace] = await sql<{ id: string }[]>`
        INSERT INTO opengeni.workspaces (account_id, name) VALUES (${account!.id}, 'grant ws') RETURNING id`;
      await sql`
        INSERT INTO opengeni.workspace_inference_controls (workspace_id, account_id)
        VALUES (${workspace!.id}, ${account!.id})`;
      const sessionClient = createDb(appUrl, {
        max: 1,
        searchPath: "opengeni,opengeni_private,public",
        rlsStrategy: "force",
      });
      let sessionId: string;
      try {
        const postureOptions = {
          expectedRole: "opengeni_app",
          targetSchema: "opengeni",
          rlsStrategy: "force" as const,
          organizationTenancyCanonicalActivationEnabled: true,
        };
        const posture = await inspectRuntimeDatabasePosture(sessionClient.db, postureOptions);
        expect(evaluateRuntimeDatabasePosture(posture, postureOptions)).toEqual([]);
        expect(posture.identity).toMatchObject({
          currentUser: "opengeni_app",
          sessionUser: "opengeni_app",
          superuser: false,
          bypassRls: false,
        });
        sessionId = (
          await createSession(sessionClient.db, {
            accountId: account!.id,
            workspaceId: workspace!.id,
            initialMessage: "hello",
            resources: [],
            metadata: {},
            model: "gpt-4.1",
            reasoningEffort: "medium" as const,
            latencyMode: "standard" as const,
            sandboxBackend: "none",
          })
        ).id;
      } finally {
        await sessionClient.close();
      }
      await sql.unsafe(`
        CREATE TABLE opengeni.default_privilege_probe (
          id bigserial PRIMARY KEY,
          note text NOT NULL
        )
      `);

      const app = postgres(appUrl, { max: 1 });
      try {
        await app.unsafe(`SET search_path = "opengeni", "opengeni_private", "public"`);
        const [snapshots] = await app<Array<{ valid: boolean; invalid: boolean }>>`
          select claude_provider_account_authority_snapshot_v1_valid('{"version":1,"scope":"workspace"}'::jsonb) as valid,
            claude_provider_account_authority_snapshot_v1_valid('{"version":2,"scope":"workspace"}'::jsonb) as invalid`;
        expect(snapshots).toEqual({ valid: true, invalid: false });
        await app.begin(async (tx) => {
          await tx`SELECT set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`SELECT set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
          await tx`SELECT set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
          const inserted = await tx<{ id: string }[]>`
            INSERT INTO session_mcp_servers (
              account_id, workspace_id, session_id, server_id, name, url, headers_encrypted
            )
            VALUES (
              ${account!.id}, ${workspace!.id}, ${sessionId}, 'grant-test', 'Grant test',
              'https://mcp.example.test', '{}'::jsonb
            )
            RETURNING id`;
          expect(inserted).toHaveLength(1);
          const visible = await tx<Array<{ id: string }>>`
            select id from sessions where id = ${sessionId}`;
          expect(visible.map((row) => row.id)).toEqual([sessionId]);
        });
        // Canonical defaults grant sequence use, not DML on unknown future
        // tables. Keep both halves of that least-privilege contract observable.
        const [defaults] = await app<
          Array<{ sequenceUsage: boolean; sequenceSelect: boolean; insert: boolean }>
        >`
          select has_sequence_privilege(current_user, 'opengeni.default_privilege_probe_id_seq', 'USAGE') as "sequenceUsage",
            has_sequence_privilege(current_user, 'opengeni.default_privilege_probe_id_seq', 'SELECT') as "sequenceSelect",
            has_table_privilege(current_user, 'opengeni.default_privilege_probe', 'INSERT') as insert`;
        expect(defaults).toEqual({ sequenceUsage: true, sequenceSelect: true, insert: false });
        expect(
          await app`select nextval('opengeni.default_privilege_probe_id_seq') as id`,
        ).toHaveLength(1);
        await expect(
          Promise.resolve(app`insert into default_privilege_probe(note) values('must be denied')`),
        ).rejects.toMatchObject({ code: "42501" });
        await app.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${crypto.randomUUID()}, true)`;
          await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
          expect(await tx`select id from sessions where id = ${sessionId}`).toHaveLength(0);
        });
        await expect(
          app.begin(async (tx) => {
            await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
            await tx`select set_config('opengeni.workspace_id', ${crypto.randomUUID()}, true)`;
            await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
            await tx`insert into session_mcp_servers(account_id,workspace_id,session_id,server_id,name,url,headers_encrypted)
            values(${account!.id},${workspace!.id},${sessionId},'wrong-scope','Denied','https://mcp.example.test','{}'::jsonb)`;
          }),
        ).rejects.toMatchObject({ code: "42501" });
        const [privateGrants] = await app<Array<{ insert: boolean }>>`
          select has_table_privilege(current_user, 'opengeni_private.claude_subscription_runtime_capabilities', 'INSERT') as insert`;
        expect(privateGrants?.insert).toBe(false);
        await expect(
          Promise.resolve(
            app`insert into opengeni_private.claude_subscription_runtime_capabilities default values`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
        const [effects] = await sql<
          Array<{ capabilities: number; probeRows: number; deniedMcpRows: number }>
        >`
          select (select count(*)::int from opengeni_private.claude_subscription_runtime_capabilities) as capabilities,
            (select count(*)::int from opengeni.default_privilege_probe) as "probeRows",
            (select count(*)::int from opengeni.session_mcp_servers where server_id = 'wrong-scope') as "deniedMcpRows"`;
        expect(effects).toEqual({ capabilities: 0, probeRows: 0, deniedMcpRows: 0 });
      } finally {
        await app.end();
      }
    } finally {
      await sql.end();
    }

    // --- STANDALONE leg: no schema → public, byte-for-byte today's behavior.
    await migrate(standalone.databaseUrl);
    await runMigrations(standalone.databaseUrl);
    await provisionRoles(standalone.databaseUrl, {
      appRole: "opengeni_app",
      appPassword: new URL(applicationUrl(standalone)).password,
      targetSchema: "public",
      rlsStrategy: "force",
    });
    const pub = postgres(standalone.databaseUrl, { max: 1 });
    try {
      const tablesInPublic = (
        await pub<{ count: number }[]>`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public'`
      )[0]!.count;
      const opengeniSchemaExists = (
        await pub<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'opengeni') AS exists`
      )[0]!.exists;
      expect(tablesInPublic).toBeGreaterThan(30);
      expect(opengeniSchemaExists).toBe(false);
    } finally {
      await pub.end();
    }
  }, 120_000);
});
