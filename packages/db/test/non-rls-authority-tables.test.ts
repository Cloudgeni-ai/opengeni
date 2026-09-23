import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, createSession, ensureManagedAccessForUser, type DbClient } from "../src";
import { NON_RLS_RUNTIME_TABLES } from "../src/runtime-posture";

// Organization-tenancy RLS posture review. `workspaces`,
// `workspace_memberships`, and `auth_identities` carry an
// `account_id`, grant the runtime role full DML, and deliberately have NO row
// level security: they are the tables the authentication layer reads to
// ESTABLISH the organization context that every RLS predicate then depends on,
// so an `account_id = current_account_id()` policy on them is circular.
//
// That exemption is a decision, not an oversight, and it is the one place where
// "cross-organization access is denied at every surface" is enforced above the
// database rather than by it. These tests pin the exemption's exact shape so a
// silent widening — a new table joining the set, or RLS quietly appearing on
// one of these three — fails loudly, and so the contrast with the genuinely
// isolated content tables stays visible.
//
// See docs/design/organization-tenancy-non-rls-authority-tables-2026-08-18.md.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("non-rls-authority-tables");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[non-rls-authority-tables] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("non-RLS authority tables (attested posture-review exemption)", () => {
  test("pins the exact exempt set", () => {
    // Adding a table here is a tenancy decision. Update the design record in the
    // same change.
    expect([...NON_RLS_RUNTIME_TABLES]).toEqual([
      "auth_identities",
      "auth_rate_limits",
      "auth_sessions",
      "auth_users",
      "auth_verifications",
      "automation_webhook_endpoints",
      "deployment_model_catalog",
      "integration_oauth_clients",
      "managed_accounts",
      "mcp_oauth_access_tokens",
      "mcp_oauth_authorization_codes",
      "mcp_oauth_authorization_requests",
      "mcp_oauth_clients",
      "mcp_oauth_refresh_tokens",
      "nested_agent_depth_configuration",
      "pr_review_managed_github_routes",
      "stripe_webhook_events",
      "workspace_memberships",
      "workspaces",
    ]);
  });

  test("keeps the three account-scoped bootstrap tables free of row level security", async () => {
    if (!shared) return;
    const rows = await shared.admin<Array<{ table: string; rls: boolean; forced: boolean }>>`
      select relation.relname as table,
             relation.relrowsecurity as rls,
             relation.relforcerowsecurity as forced
      from pg_class relation
      join pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
      where relation_namespace.nspname = current_schema()
        and relation.relname in ('workspaces', 'workspace_memberships', 'auth_identities')
      order by relation.relname
    `;
    expect(Array.from(rows)).toEqual([
      { table: "auth_identities", rls: false, forced: false },
      { table: "workspace_memberships", rls: false, forced: false },
      { table: "workspaces", rls: false, forced: false },
    ]);
  });

  // PostgreSQL accepts CREATE POLICY on a table whose RLS is disabled and simply
  // stores it inert. Three capability lanes did exactly that on
  // `workspace_memberships`, so the day anyone enables RLS there those become the
  // ENTIRE admission set — and each demands `current_user = <migration owner>`,
  // which the runtime role can never be. Membership reads would return zero rows
  // and every authorization in the product would fail closed. The posture
  // verifier only inspects `relrowsecurity`, so it cannot see this trap; pin it
  // here instead.
  test("records the dormant policies that would activate if RLS were enabled", async () => {
    if (!shared) return;
    const rows = await shared.admin<Array<{ table: string; policy: string }>>`
      select relation.relname as table, policy.polname as policy
      from pg_policy policy
      join pg_class relation on relation.oid = policy.polrelid
      join pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
      where relation_namespace.nspname = current_schema()
        and relation.relname in ('workspaces', 'workspace_memberships', 'auth_identities')
      order by relation.relname, policy.polname
    `;
    expect(Array.from(rows)).toEqual([
      { table: "workspace_memberships", policy: "personal_document_authority_capability_read" },
      { table: "workspace_memberships", policy: "scoped_compute_capability_read" },
      { table: "workspace_memberships", policy: "variable_set_authority_capability_read" },
      // The Default-collection backfill needs to enumerate every workspace in an
      // account from inside its SECURITY DEFINER lifecycle, so it opens a
      // marker-gated window on `workspaces`. Recorded here because it is broader
      // than the three above: it is FOR ALL with no account predicate in either
      // USING or WITH CHECK, so if RLS were ever enabled on `workspaces` this
      // would be the entire admission set and the marker alone would decide.
      // Confined to that definer today, but it is the one entry on this list
      // that would need narrowing before `workspaces` could adopt RLS.
      { table: "workspaces", policy: "document_default_backfill_lifecycle" },
    ]);
  }, 180_000);

  test("leaves cross-organization workspace metadata readable while content stays isolated", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const first = await ensureManagedAccessForUser(client.db, {
      userId: `non-rls-a-${suffix}`,
      email: `non-rls-a-${suffix}@example.test`,
      name: "Organization A human",
    });
    const second = await ensureManagedAccessForUser(client.db, {
      userId: `non-rls-b-${suffix}`,
      email: `non-rls-b-${suffix}@example.test`,
      name: "Organization B human",
    });
    const a = first.workspaceGrants[0]!;
    const b = second.workspaceGrants[0]!;
    // Two independent managed accounts, i.e. two organizations.
    expect(a.accountId).not.toBe(b.accountId);

    const session = await createSession(client.db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      initialMessage: "organization A content",
      resources: [],
      metadata: {},
      model: "test-model",
      sandboxBackend: "modal",
      reasoningEffort: "medium",
      latencyMode: "standard",
      createdBy: { kind: "subject", subjectId: `user:non-rls-a-${suffix}` },
      createdByContext: {},
    });

    const app = postgres(shared.appUrl, { max: 2 });
    try {
      const observed = await app.begin(async (sql) => {
        // Organization B's exact request context.
        await sql`select set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
        await sql`select set_config('opengeni.account_id', ${b.accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${b.workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${`user:non-rls-b-${suffix}`}, true)`;
        const workspaces = await sql`
          select id from workspaces where id = ${a.workspaceId}
        `;
        const memberships = await sql`
          select id from workspace_memberships where workspace_id = ${a.workspaceId}
        `;
        const sessions = await sql`select id from sessions where id = ${session.id}`;
        return {
          workspaces: workspaces.length,
          memberships: memberships.length,
          sessions: sessions.length,
        };
      });
      // The attested gap: workspace/membership metadata is not isolated at the
      // database layer. Authorization for these rows lives in the access layer.
      expect(observed.workspaces).toBe(1);
      expect(observed.memberships).toBe(1);
      // The isolation that genuinely holds: no content crosses organizations.
      expect(observed.sessions).toBe(0);
    } finally {
      await app.end();
    }
  }, 180_000);

  // Posture-review side finding. `api_keys` is FORCE RLS with a two-branch policy; the
  // second branch, `key_hash = opengeni_private.current_api_key_hash()`, carries
  // no account or workspace check. It is a deliberate and necessary bootstrap
  // escape hatch — no account context exists at authentication time, and
  // presenting the bearer whose SHA-256 is that hash IS the authentication — but
  // until now nothing exercised it: the only api_keys RLS test never sets the
  // GUC, so it proves the ACCOUNT branch and structurally cannot reach this one.
  // These assertions pin the branch's exact reach.
  test("bounds the api_keys hash branch to the presented key alone", async () => {
    if (!shared || !client) return;
    const suffix = crypto.randomUUID();
    const first = await ensureManagedAccessForUser(client.db, {
      userId: `api-key-a-${suffix}`,
      email: `api-key-a-${suffix}@example.test`,
      name: "Organization A human",
    });
    const second = await ensureManagedAccessForUser(client.db, {
      userId: `api-key-b-${suffix}`,
      email: `api-key-b-${suffix}@example.test`,
      name: "Organization B human",
    });
    const a = first.workspaceGrants[0]!;
    const b = second.workspaceGrants[0]!;
    const presentedHash = `hash-presented-${suffix}`;
    const siblingHash = `hash-sibling-${suffix}`;
    await shared.admin`
      insert into api_keys (account_id, workspace_id, name, prefix, key_hash)
      values
        (${a.accountId}, ${a.workspaceId}, 'presented', ${`p-${suffix}`}, ${presentedHash}),
        (${a.accountId}, ${a.workspaceId}, 'sibling', ${`s-${suffix}`}, ${siblingHash})
    `;

    const app = postgres(shared.appUrl, { max: 2 });
    try {
      const observed = await app.begin(async (sql) => {
        // Exactly the authentication path's context: the hash GUC and nothing
        // else. No account, workspace, or subject is known yet.
        await sql`select set_config('opengeni.api_key_hash', ${presentedHash}, true)`;
        const presented = await sql`select id from api_keys where key_hash = ${presentedHash}`;
        const sibling = await sql`select id from api_keys where key_hash = ${siblingHash}`;
        const everything = await sql`select id from api_keys`;
        return {
          presented: presented.length,
          sibling: sibling.length,
          everything: everything.length,
        };
      });
      // The branch admits the presented key's own row with no tenant fence...
      expect(observed.presented).toBe(1);
      // ...and nothing else, including its own account's other keys. The unique
      // index on key_hash caps the blast radius at one row.
      expect(observed.sibling).toBe(0);
      expect(observed.everything).toBe(1);

      // Organization B's established context reaches neither key.
      const crossTenant = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${b.accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${b.workspaceId}, true)`;
        return (await sql`select id from api_keys where key_hash = ${presentedHash}`).length;
      });
      expect(crossTenant).toBe(0);
    } finally {
      await app.end();
    }
  }, 180_000);
});
