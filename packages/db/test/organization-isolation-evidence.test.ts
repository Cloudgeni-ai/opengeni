import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getOrganizationPrivateSessionSettings,
  nestedPostgresSqlState,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  type DbClient,
} from "../src";

// ---------------------------------------------------------------------------
// Organization-tenancy slice 9 — cross-organization / RLS / immediate-revocation evidence.
//
// Organizations (`managed_accounts.id`) are hard non-sharing tenants. This file
// is the durable *executed* evidence for that claim: it drives a real
// PostgreSQL database as the genuine non-superuser, NOBYPASSRLS `opengeni_app`
// login and proves discovery, read, mutation, delegation, and lifecycle paths
// all deny across an organization boundary, fail closed without context, and
// stop immediately on revocation.
//
// Deliberate method notes (each one is load-bearing, not decoration):
//
//  * Every denial assertion is paired with a POSITIVE control under the owning
//    organization's context. A "0 rows" assertion against a row that was never
//    written proves nothing; the positive control is what makes the negative
//    meaningful.
//  * Every probe runs on a raw `shared.appUrl` connection with GUCs set
//    explicitly and transaction-locally, so a test can also express the
//    *absence* of context — which `withWorkspaceRls`/`setRlsContext` cannot.
//  * `opengeni_app` is asserted to be non-superuser, NOBYPASSRLS, and not the
//    table owner before anything else. Without that guard the whole file could
//    pass while measuring owner-privileged behaviour instead of runtime
//    behaviour.
// ---------------------------------------------------------------------------

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_ORG_ISOLATION_POSTGRES_ADMIN_URL;
const externalAppUrl = process.env.OPENGENI_ORG_ISOLATION_POSTGRES_APP_URL;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;
let fixture: Fixture | null = null;
let definerRole: string | null = null;

/** The four FORCE-RLS organization authority/grant tables (migration 0218). */
const ORGANIZATION_AUTHORITY_TABLES = [
  "organization_memberships",
  "organization_user_retention_policies",
  "organization_user_resource_authorities",
  "organization_user_resource_grants",
] as const;

/**
 * Account-carrying `public` tables on which the runtime role holds DML while
 * row-level security is NOT enabled. These are reviewed, deliberate exceptions:
 * `workspaces` and `workspace_memberships` are the tenancy *directory* the
 * access resolver itself reads before an RLS context exists, and
 * `auth_identities` is the Better Auth subject mapping. Their organization
 * boundary is enforced above the database, by `@opengeni/core` access
 * resolution.
 *
 * This list is a review gate, not a target. Adding an organization-scoped
 * resource table without RLS must fail this file; removing an entry here
 * (because the table gained RLS) must also fail it, so the reviewed set can
 * never drift silently in either direction.
 */
const REVIEWED_UNPROTECTED_ACCOUNT_TABLES = [
  "auth_identities",
  "automation_webhook_endpoints",
  "workspace_memberships",
  "workspaces",
] as const;

type Ctx = {
  accountId?: string;
  workspaceId?: string;
  subjectId?: string;
};

/** One seeded row per organization-scoped resource family. */
type SeededResource = { family: string; table: string; id: string };

type Fixture = {
  humanSubjectId: string;
  otherSubjectId: string;
  orgA: {
    accountId: string;
    workspaceId: string;
    siblingWorkspaceId: string;
    membershipId: string;
  };
  orgB: { accountId: string; workspaceId: string; membershipId: string };
  /** Resources owned by organization A / workspace A1. */
  resources: SeededResource[];
  /** A `user_private` session in A1 owned by `humanSubjectId`. */
  privateSessionA: string;
  /** A `user_private` session in B1 owned by the same `humanSubjectId`. */
  privateSessionB: string;
};

beforeAll(async () => {
  if ((externalAdminUrl === undefined) !== (externalAppUrl === undefined)) {
    throw new Error(
      "set both OPENGENI_ORG_ISOLATION_POSTGRES_ADMIN_URL and OPENGENI_ORG_ISOLATION_POSTGRES_APP_URL",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    const admin = postgres(externalAdminUrl, { max: 8 });
    shared = {
      admin,
      adminUrl: externalAdminUrl,
      appUrl: externalAppUrl,
      release: async () => await admin.end(),
    };
  } else {
    shared = await acquireSharedTestDatabase("organization-isolation-evidence");
  }
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[organization-isolation-evidence] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (!shared) return;
  client = createDb(shared.appUrl, { max: 8 });
  app = postgres(shared.appUrl, { max: 4 });
  fixture = await seedFixture(shared, client);
}, 300_000);

afterAll(async () => {
  if (shared && definerRole) {
    await shared.admin.unsafe(`DROP OWNED BY "${definerRole}" CASCADE`).catch(() => undefined);
    await shared.admin.unsafe(`DROP ROLE IF EXISTS "${definerRole}"`).catch(() => undefined);
  }
  await app?.end().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 300_000);

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** Run `fn` on the runtime-role connection with exactly the supplied GUCs. */
async function underContext<T>(ctx: Ctx, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  if (!app) throw new Error("runtime-role connection unavailable");
  return (await app.begin(async (tx) => {
    if (ctx.accountId !== undefined) {
      await tx`select set_config('opengeni.account_id', ${ctx.accountId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx`select set_config('opengeni.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.subjectId !== undefined) {
      await tx`select set_config('opengeni.subject_id', ${ctx.subjectId}, true)`;
    }
    return await fn(tx as unknown as postgres.Sql);
  })) as T;
}

/**
 * `visible`  — the runtime role can read the exact seeded row.
 * `hidden`   — the role holds the privilege but row-level security excludes it.
 * `denied`   — the role holds no table privilege at all (capability-only table).
 *
 * Distinguishing `hidden` from `denied` is deliberate: both are safe, but only
 * an exact expected map proves *why* each family is unreachable, and makes a
 * silently-widened GRANT fail this file.
 */
type Reachability = "visible" | "hidden" | "denied";

async function probeResources(
  ctx: Ctx,
  resources: SeededResource[],
): Promise<Record<string, Reachability>> {
  return await underContext(ctx, async (tx) => {
    const result: Record<string, Reachability> = {};
    for (const resource of resources) {
      // Ask the runtime role's OWN catalog view for its privilege first. A
      // denied statement aborts the whole transaction (and postgres.js
      // re-raises it past a local catch), so the privilege class has to be
      // resolved before the row read rather than inferred from a thrown error.
      // `expectSqlState` in the capability-only test below proves the same
      // absence the hard way.
      const [privilege] = await tx.unsafe<{ readable: boolean }[]>(
        `select has_table_privilege(current_user, $1::regclass, 'SELECT') as readable`,
        [resource.table],
      );
      if (privilege?.readable !== true) {
        result[resource.family] = "denied";
        continue;
      }
      const rows = await tx.unsafe<{ count: number }[]>(
        `select count(*)::int as count from "${resource.table}" where id = $1`,
        [resource.id],
      );
      result[resource.family] = (rows[0]?.count ?? 0) > 0 ? "visible" : "hidden";
    }
    return result;
  });
}

/** The families the runtime role could actually read under `ctx`. */
async function visibleResources(ctx: Ctx, resources: SeededResource[]): Promise<string[]> {
  const probed = await probeResources(ctx, resources);
  return Object.entries(probed)
    .filter(([, status]) => status === "visible")
    .map(([family]) => family);
}

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function seedOrganization(
  db: SharedTestDatabase,
  runtime: DbClient,
  label: string,
  subjectId: string,
): Promise<{ accountId: string; workspaceId: string; membershipId: string }> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(runtime.db, {
    accountExternalSource: "organization-isolation-evidence",
    accountExternalId: `${label}-${suffix}`,
    accountName: `Organization ${label}`,
    workspaceExternalSource: "organization-isolation-evidence",
    workspaceExternalId: `${label}-primary-${suffix}`,
    workspaceName: `${label} primary workspace`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  await db.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  // An active organization membership must point at a same-organization
  // personal workspace (migration 0218's referential contract).
  const personalWorkspaceId = crypto.randomUUID();
  await db.admin`
    insert into workspaces (id, account_id, name, external_source, external_id)
    values (
      ${personalWorkspaceId}, ${grant.accountId}, ${`${label} personal workspace`},
      'organization-isolation-evidence', ${`${label}-personal-${suffix}`}
    )
  `;
  await db.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${personalWorkspaceId}, ${grant.accountId})
  `;
  const [membership] = await db.admin<{ id: string }[]>`
    insert into organization_memberships (
      account_id, subject_id, status, role, personal_workspace_id
    )
    values (${grant.accountId}, ${subjectId}, 'active', 'owner', ${personalWorkspaceId})
    returning id
  `;
  const privateSessionSettings = await getOrganizationPrivateSessionSettings(runtime.db, {
    organizationId: grant.accountId,
    actorSubjectId: subjectId,
  });
  await updateOrganizationPrivateSessionSettings(runtime.db, {
    organizationId: grant.accountId,
    actorSubjectId: subjectId,
    enabled: true,
    expectedVersion: privateSessionSettings.version,
    operationId: crypto.randomUUID(),
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    membershipId: membership!.id,
  };
}

/**
 * Seed one row per organization-scoped resource family in organization A /
 * workspace A1. Written with the superuser handle so the fixture itself never
 * depends on the behaviour under test.
 */
async function seedResources(
  db: SharedTestDatabase,
  runtime: DbClient,
  accountId: string,
  workspaceId: string,
): Promise<SeededResource[]> {
  const suffix = crypto.randomUUID();
  const resources: SeededResource[] = [];

  const session = await createSession(runtime.db, {
    accountId,
    workspaceId,
    initialMessage: "organization isolation evidence session",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  resources.push({ family: "session", table: "sessions", id: session.id });

  const [event] = await db.admin<{ id: string }[]>`
    insert into session_events (session_id, sequence, type, account_id, workspace_id)
    values (${session.id}, 9000, 'evidence.probe', ${accountId}, ${workspaceId})
    returning id
  `;
  resources.push({ family: "session event", table: "session_events", id: event!.id });

  const [variableSet] = await db.admin<{ id: string }[]>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${accountId}, ${workspaceId}, ${`evidence-variable-set-${suffix}`})
    returning id
  `;
  resources.push({
    family: "variable set",
    table: "workspace_variable_sets",
    id: variableSet!.id,
  });

  const [rig] = await db.admin<{ id: string }[]>`
    insert into rigs (account_id, workspace_id, name)
    values (${accountId}, ${workspaceId}, ${`evidence-rig-${suffix}`})
    returning id
  `;
  resources.push({ family: "rig", table: "rigs", id: rig!.id });

  const [enrollment] = await db.admin<{ id: string }[]>`
    insert into enrollments (account_id, workspace_id, pubkey)
    values (${accountId}, ${workspaceId}, ${`evidence-pubkey-${suffix}`})
    returning id
  `;
  resources.push({ family: "enrollment", table: "enrollments", id: enrollment!.id });

  const [sandbox] = await db.admin<{ id: string }[]>`
    insert into sandboxes (account_id, workspace_id, kind, name, enrollment_id)
    values (
      ${accountId}, ${workspaceId}, 'selfhosted', ${`evidence-machine-${suffix}`},
      ${enrollment!.id}
    )
    returning id
  `;
  resources.push({ family: "connected machine", table: "sandboxes", id: sandbox!.id });

  const [connection] = await db.admin<{ id: string }[]>`
    insert into connections (
      account_id, workspace_id, provider_domain, kind, credential_encrypted
    ) values (
      ${accountId}, ${workspaceId}, ${`evidence-${suffix}.example`}, 'oauth2',
      'evidence-ciphertext'
    )
    returning id
  `;
  resources.push({ family: "connection", table: "connections", id: connection!.id });

  const [file] = await db.admin<{ id: string }[]>`
    insert into files (
      filename, safe_filename, content_type, size_bytes, bucket, object_key,
      account_id, workspace_id
    ) values (
      'evidence.txt', 'evidence.txt', 'text/plain', 11, 'evidence-bucket',
      ${`evidence/${suffix}.txt`}, ${accountId}, ${workspaceId}
    )
    returning id
  `;
  resources.push({ family: "file", table: "files", id: file!.id });

  const [base] = await db.admin<{ id: string }[]>`
    insert into document_bases (name, account_id, workspace_id)
    values (${`evidence-base-${suffix}`}, ${accountId}, ${workspaceId})
    returning id
  `;
  resources.push({ family: "document base", table: "document_bases", id: base!.id });

  const [document] = await db.admin<{ id: string }[]>`
    insert into documents (
      base_id, file_id, title, account_id, workspace_id, origin_workspace_id
    ) values (
      ${base!.id}, ${file!.id}, 'Evidence document', ${accountId}, ${workspaceId},
      ${workspaceId}
    )
    returning id
  `;
  resources.push({ family: "document", table: "documents", id: document!.id });

  const [memory] = await db.admin<{ id: string }[]>`
    insert into knowledge_memories (account_id, workspace_id, text)
    values (${accountId}, ${workspaceId}, 'evidence workspace knowledge')
    returning id
  `;
  resources.push({ family: "knowledge memory", table: "knowledge_memories", id: memory!.id });

  const [task] = await db.admin<{ id: string }[]>`
    insert into scheduled_tasks (
      name, schedule, temporal_schedule_id, agent_config, account_id, workspace_id,
      execution_digest
    ) values (
      ${`evidence-task-${suffix}`}, '{"kind":"cron","expression":"0 0 * * *"}'::jsonb,
      ${`evidence-schedule-${suffix}`}, '{}'::jsonb, ${accountId}, ${workspaceId},
      ${`digest-${suffix}`}
    )
    returning id
  `;
  resources.push({ family: "scheduled task", table: "scheduled_tasks", id: task!.id });

  const [apiKey] = await db.admin<{ id: string }[]>`
    insert into api_keys (account_id, workspace_id, name, prefix, key_hash)
    values (
      ${accountId}, ${workspaceId}, ${`evidence-key-${suffix}`},
      ${`ogk_${suffix.slice(0, 8)}`}, ${`hash-${suffix}`}
    )
    returning id
  `;
  resources.push({ family: "api key", table: "api_keys", id: apiKey!.id });

  return resources;
}

/** A `user_private` session owned by `subjectId`, written through the lifecycle seam. */
async function seedPrivateSession(
  db: SharedTestDatabase,
  runtime: DbClient,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<string> {
  const session = await createSession(runtime.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: "organization isolation evidence private session",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: input.subjectId },
    createdByContext: {},
  });
  await transitionSessionVisibility(runtime.db, {
    workspaceId: input.workspaceId,
    sessionId: session.id,
    actorSubjectId: input.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `evidence-private:${crypto.randomUUID()}`,
  });
  const [row] = await db.admin<{ visibility: string }[]>`
    select visibility from sessions where id = ${session.id}
  `;
  if (row?.visibility !== "user_private") {
    throw new Error(`private session fixture did not become user_private: ${row?.visibility}`);
  }
  return session.id;
}

async function seedFixture(db: SharedTestDatabase, runtime: DbClient): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const humanSubjectId = `user:evidence-human-${suffix}`;
  const otherSubjectId = `user:evidence-other-${suffix}`;

  const orgA = await seedOrganization(db, runtime, "alpha", humanSubjectId);
  const orgB = await seedOrganization(db, runtime, "bravo", humanSubjectId);

  // A sibling workspace inside organization A proves the boundary is not only
  // between organizations: a same-organization workspace is still separate.
  const siblingWorkspaceId = crypto.randomUUID();
  await db.admin`
    insert into workspaces (id, account_id, name, external_source, external_id)
    values (
      ${siblingWorkspaceId}, ${orgA.accountId}, 'alpha sibling workspace',
      'organization-isolation-evidence', ${`alpha-sibling-${suffix}`}
    )
  `;
  await db.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${siblingWorkspaceId}, ${orgA.accountId})
  `;

  const resources = await seedResources(db, runtime, orgA.accountId, orgA.workspaceId);

  // The same human owns one private session in each organization. Revoking one
  // membership must hide exactly one of them. `bootstrapWorkspace` already gave
  // this subject an owner `workspace_memberships` row in both primary
  // workspaces, so no extra membership seeding is needed here.
  const privateSessionA = await seedPrivateSession(db, runtime, {
    accountId: orgA.accountId,
    workspaceId: orgA.workspaceId,
    subjectId: humanSubjectId,
  });
  const privateSessionB = await seedPrivateSession(db, runtime, {
    accountId: orgB.accountId,
    workspaceId: orgB.workspaceId,
    subjectId: humanSubjectId,
  });

  return {
    humanSubjectId,
    otherSubjectId,
    orgA: { ...orgA, siblingWorkspaceId },
    orgB,
    resources,
    privateSessionA,
    privateSessionB,
  };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe("organization tenancy isolation evidence", () => {
  test("the probing role is a genuine NOBYPASSRLS non-owner runtime login", async () => {
    if (!shared || !app) return;
    // Without this guard every other assertion in this file could be measuring
    // owner-privileged behaviour instead of runtime behaviour.
    const [role] = await shared.admin<
      { superuser: boolean; bypassRls: boolean; inherit: boolean }[]
    >`
      select rolsuper as "superuser", rolbypassrls as "bypassRls", rolinherit as inherit
      from pg_roles where rolname = 'opengeni_app'
    `;
    expect(role).toEqual({ superuser: false, bypassRls: false, inherit: false });

    // `MEMBER`, not `USAGE`. `opengeni_app` is created NOINHERIT, so `USAGE`
    // (privileges inherited without `SET ROLE`) is false even when membership
    // IS granted — a `GRANT <owner> TO opengeni_app` would sail past a `USAGE`
    // probe while still permitting `SET ROLE <owner>` and therefore a total RLS
    // bypass. `MEMBER` is the predicate that actually detects that grant.
    const owners = await shared.admin<{ tableName: string; isMember: boolean }[]>`
      select
        relation.relname as "tableName",
        pg_has_role('opengeni_app', relation.relowner, 'MEMBER') as "isMember"
      from pg_class relation
      join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
      where namespace_row.nspname = current_schema()
        and relation.relname = any(${shared.admin.array([...ORGANIZATION_AUTHORITY_TABLES])})
    `;
    expect(owners).toHaveLength(ORGANIZATION_AUTHORITY_TABLES.length);
    expect(owners.every((row) => row.isMember === false)).toBe(true);

    const [active] = await app<{ current: string; active: boolean }[]>`
      select current_user as current, row_security_active('sessions'::regclass) as active
    `;
    expect(active?.current).toBe("opengeni_app");
    expect(active?.active).toBe(true);
  });

  test("every organization-scoped resource is reachable exactly as designed under its owning context", async () => {
    if (!fixture) return;
    // POSITIVE CONTROL. Every "zero rows" assertion below is only meaningful
    // because this exact query shape reaches every seeded family here.
    //
    // `workspace_variable_sets` is deliberately `denied`, not `hidden`: scoped
    // Variable Sets are a capability-only surface with zero direct runtime
    // table privileges (migration 0254). Pinning the whole map means a future
    // GRANT that turns `denied` into `hidden` fails this test on purpose.
    expect(
      await probeResources(
        { accountId: fixture.orgA.accountId, workspaceId: fixture.orgA.workspaceId },
        fixture.resources,
      ),
    ).toEqual({
      session: "visible",
      "session event": "visible",
      "variable set": "denied",
      rig: "visible",
      enrollment: "visible",
      "connected machine": "visible",
      connection: "visible",
      file: "visible",
      "document base": "visible",
      document: "visible",
      "knowledge memory": "visible",
      "scheduled task": "visible",
      "api key": "visible",
    });

    // The `denied` classification above is a catalog reading; prove the same
    // absence by executing against the capability-only table under the owning
    // organization's own honest context.
    for (const statement of [
      `select * from "workspace_variable_sets" limit 1`,
      `insert into "workspace_variable_sets" default values`,
      `update "workspace_variable_sets" set name = name`,
      `delete from "workspace_variable_sets"`,
    ]) {
      await expectSqlState(
        async () =>
          await underContext(
            { accountId: fixture!.orgA.accountId, workspaceId: fixture!.orgA.workspaceId },
            async (tx) => await tx.unsafe(statement),
          ),
        "42501",
      );
    }
  });

  test("no organization-scoped resource crosses an organization boundary", async () => {
    if (!fixture) return;
    // Organization B's own honest context.
    expect(
      await visibleResources(
        { accountId: fixture.orgB.accountId, workspaceId: fixture.orgB.workspaceId },
        fixture.resources,
      ),
    ).toEqual([]);

    // Organization B forging organization A's workspace id: knowing the target
    // workspace identifier must not widen anything.
    expect(
      await visibleResources(
        { accountId: fixture.orgB.accountId, workspaceId: fixture.orgA.workspaceId },
        fixture.resources,
      ),
    ).toEqual([]);

    // Organization A's account with organization B's workspace: a mismatched
    // pair must not fall back to either half.
    expect(
      await visibleResources(
        { accountId: fixture.orgA.accountId, workspaceId: fixture.orgB.workspaceId },
        fixture.resources,
      ),
    ).toEqual([]);

    // Same organization, sibling workspace: the boundary is per workspace too.
    expect(
      await visibleResources(
        { accountId: fixture.orgA.accountId, workspaceId: fixture.orgA.siblingWorkspaceId },
        fixture.resources,
      ),
    ).toEqual([]);
  });

  test("missing runtime context denies instead of widening", async () => {
    if (!fixture) return;
    // No GUCs at all.
    expect(await visibleResources({}, fixture.resources)).toEqual([]);
    // Explicitly blank GUCs (the shape a reset/reconnected pool hands back).
    expect(await visibleResources({ accountId: "", workspaceId: "" }, fixture.resources)).toEqual(
      [],
    );
    // The right organization but no workspace. Workspace-scoped families must
    // all stay hidden. `api_keys` is the one deliberately account-scoped family
    // (`optional_workspace_rls_visible`, so a workspace-less context is its
    // normal list shape) — and it still never crosses the organization, which
    // the next assertion proves.
    expect(
      await visibleResources(
        { accountId: fixture.orgA.accountId, workspaceId: "" },
        fixture.resources,
      ),
    ).toEqual(["api key"]);
    expect(
      await visibleResources(
        { accountId: fixture.orgB.accountId, workspaceId: "" },
        fixture.resources,
      ),
    ).toEqual([]);
    // The right workspace but no organization: must not widen to the workspace.
    expect(
      await visibleResources(
        { accountId: "", workspaceId: fixture.orgA.workspaceId },
        fixture.resources,
      ),
    ).toEqual([]);
  });

  test("cross-organization mutation is refused at the write barrier and leaves the row intact", async () => {
    if (!shared || !fixture) return;
    const foreign = {
      accountId: fixture.orgB.accountId,
      workspaceId: fixture.orgB.workspaceId,
    };

    // INSERT carrying organization A's identity while running under B.
    await expectSqlState(
      async () =>
        await underContext(foreign, async (tx) => {
          await tx`
            insert into rigs (account_id, workspace_id, name)
            values (${fixture!.orgA.accountId}, ${fixture!.orgA.workspaceId}, 'forged rig')
          `;
        }),
      "42501",
    );

    // UPDATE and DELETE of organization A's rows: invisible rows cannot be
    // written, so both must affect zero rows rather than raise.
    const rig = fixture.resources.find((r) => r.table === "rigs")!;
    const connection = fixture.resources.find((r) => r.table === "connections")!;
    const affected = await underContext(foreign, async (tx) => {
      const updated = await tx`update rigs set name = 'hijacked' where id = ${rig.id}`;
      const deleted = await tx`delete from connections where id = ${connection.id}`;
      return { updated: updated.count, deleted: deleted.count };
    });
    expect(affected).toEqual({ updated: 0, deleted: 0 });

    // The owning organization's truth is unchanged — the denials above were
    // real denials, not silent successes against a missing row.
    const [survivor] = await shared.admin<{ name: string }[]>`
      select name from rigs where id = ${rig.id}
    `;
    expect(survivor?.name).toStartWith("evidence-rig-");
    const [connectionRow] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from connections where id = ${connection.id}
    `;
    expect(connectionRow?.count).toBe(1);
    expect(
      await visibleResources(
        { accountId: fixture.orgA.accountId, workspaceId: fixture.orgA.workspaceId },
        [rig, connection],
      ),
    ).toEqual([rig.family, connection.family]);
  });

  test("forging the organization tenancy lifecycle GUC opens no authority table", async () => {
    if (!app) return;
    // The four authority tables' policy is a bare `current_setting(...)`
    // comparison, and any caller may set a GUC. The actual defence is that the
    // runtime role holds no privilege at all, and privilege is checked before
    // row-level security. This test fails the moment a GRANT is added.
    for (const lifecycle of [
      "managed_human_provisioning",
      "organization_membership_lifecycle",
      "session_visibility_activation",
    ]) {
      for (const table of ORGANIZATION_AUTHORITY_TABLES) {
        await expectSqlState(
          async () =>
            await underContext({}, async (tx) => {
              await tx`select set_config('opengeni.organization_tenancy_lifecycle', ${lifecycle}, true)`;
              await tx.unsafe(`select * from "${table}" limit 1`);
            }),
          "42501",
        );
        await expectSqlState(
          async () =>
            await underContext({}, async (tx) => {
              await tx`select set_config('opengeni.organization_tenancy_lifecycle', ${lifecycle}, true)`;
              await tx.unsafe(`delete from "${table}"`);
            }),
          "42501",
        );
      }
    }
  });

  test("no table gated only by a caller-settable lifecycle GUC grants the runtime role anything", async () => {
    if (!shared) return;
    // Generalises the previous test across the whole catalog. A policy is
    // "caller-satisfiable" when its expression is gated on the
    // `opengeni.organization_tenancy_lifecycle` GUC and on nothing the caller
    // cannot control (no `CURRENT_USER` owner check). Any table carrying such a
    // permissive policy must therefore hold zero runtime privileges.
    const rows = await shared.admin<
      { tableName: string; select: boolean; insert: boolean; update: boolean; delete: boolean }[]
    >`
      with policies as (
        select distinct
          relation.oid as relation_oid,
          relation.relname as table_name
        from pg_class relation
        join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
        join pg_policy policy on policy.polrelid = relation.oid
        where namespace_row.nspname = current_schema()
          and relation.relkind = 'r'
          and policy.polpermissive
          and coalesce(pg_get_expr(policy.polqual, policy.polrelid), '')
            || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
            like '%opengeni.organization_tenancy_lifecycle%'
          and coalesce(pg_get_expr(policy.polqual, policy.polrelid), '')
            || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
            not like '%CURRENT_USER%'
      )
      select
        table_name as "tableName",
        has_table_privilege('opengeni_app', relation_oid, 'SELECT') as select,
        has_table_privilege('opengeni_app', relation_oid, 'INSERT') as insert,
        has_table_privilege('opengeni_app', relation_oid, 'UPDATE') as update,
        has_table_privilege('opengeni_app', relation_oid, 'DELETE') as delete
      from policies
      order by table_name
    `;
    // Non-vacuity: the organization lifecycle family must actually be found.
    expect(rows.length).toBeGreaterThanOrEqual(ORGANIZATION_AUTHORITY_TABLES.length);
    for (const table of ORGANIZATION_AUTHORITY_TABLES) {
      expect(rows.map((row) => row.tableName)).toContain(table);
    }
    expect(rows.filter((row) => row.select || row.insert || row.update || row.delete)).toEqual([]);
  });

  test("every organization-scoped table the runtime role can touch enforces row security", async () => {
    if (!shared) return;
    const rows = await shared.admin<
      { tableName: string; enabled: boolean; forced: boolean; policyCount: number }[]
    >`
      select
        relation.relname as "tableName",
        relation.relrowsecurity as enabled,
        relation.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy policy where policy.polrelid = relation.oid)
          as "policyCount"
      from pg_class relation
      join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
      where namespace_row.nspname = current_schema()
        and relation.relkind = 'r'
        and exists (
          select 1 from pg_attribute attribute
          where attribute.attrelid = relation.oid
            and attribute.attname = 'account_id'
            and attribute.attnum > 0
            and not attribute.attisdropped
        )
        and (
          has_table_privilege('opengeni_app', relation.oid, 'SELECT')
          or has_table_privilege('opengeni_app', relation.oid, 'INSERT')
          or has_table_privilege('opengeni_app', relation.oid, 'UPDATE')
          or has_table_privilege('opengeni_app', relation.oid, 'DELETE')
        )
      order by relation.relname
    `;
    // Non-vacuity: the organization-scoped surface is large, not empty.
    expect(rows.length).toBeGreaterThan(100);
    const unprotected = rows
      .filter((row) => !row.enabled || !row.forced || row.policyCount === 0)
      .map((row) => row.tableName);
    expect(unprotected).toEqual([...REVIEWED_UNPROTECTED_ACCOUNT_TABLES]);
  });

  test("the reviewed directory tables are cross-organization readable by design", async () => {
    if (!fixture) return;
    // Honest evidence rather than an over-claim: `workspaces` /
    // `workspace_memberships` / `auth_identities` deliberately carry no RLS, so
    // organization A's directory rows ARE readable by the runtime role under
    // organization B's context. Their boundary lives in `@opengeni/core` access
    // resolution. If RLS is ever added to them this assertion fails and the
    // reviewed exception list above must be updated in the same change.
    //
    // The exhaustiveness half — that these are the ONLY account-carrying tables
    // without row security — is owned by the preceding catalog sweep, which
    // pins the unprotected set to `REVIEWED_UNPROTECTED_ACCOUNT_TABLES` exactly.
    // This test executes the actual cross-organization read for the two
    // directory tables the fixture seeds.
    const leaked = await underContext(
      { accountId: fixture.orgB.accountId, workspaceId: fixture.orgB.workspaceId },
      async (tx) => {
        const [workspace] = await tx<{ count: number }[]>`
          select count(*)::int as count from workspaces where id = ${fixture!.orgA.workspaceId}
        `;
        const [membership] = await tx<{ count: number }[]>`
          select count(*)::int as count from workspace_memberships
          where workspace_id = ${fixture!.orgA.workspaceId}
            and subject_id = ${fixture!.humanSubjectId}
        `;
        return { workspaces: workspace?.count ?? 0, memberships: membership?.count ?? 0 };
      },
    );
    expect(leaked).toEqual({ workspaces: 1, memberships: 1 });
  });

  test("an active membership in another organization is not authority in this one", async () => {
    if (!fixture) return;
    const human = fixture.humanSubjectId;
    // POSITIVE CONTROL: each private session is visible in its own organization
    // to its own owner.
    expect(
      await visibleResources(
        {
          accountId: fixture.orgA.accountId,
          workspaceId: fixture.orgA.workspaceId,
          subjectId: human,
        },
        [{ family: "private session A", table: "sessions", id: fixture.privateSessionA }],
      ),
    ).toEqual(["private session A"]);
    expect(
      await visibleResources(
        {
          accountId: fixture.orgB.accountId,
          workspaceId: fixture.orgB.workspaceId,
          subjectId: human,
        },
        [{ family: "private session B", table: "sessions", id: fixture.privateSessionB }],
      ),
    ).toEqual(["private session B"]);

    // The same human holds an active membership in BOTH organizations. That
    // must not make organization A's private session reachable from B.
    expect(
      await visibleResources(
        {
          accountId: fixture.orgB.accountId,
          workspaceId: fixture.orgB.workspaceId,
          subjectId: human,
        },
        [{ family: "private session A", table: "sessions", id: fixture.privateSessionA }],
      ),
    ).toEqual([]);
    // Nor through a forged workspace id.
    expect(
      await visibleResources(
        {
          accountId: fixture.orgB.accountId,
          workspaceId: fixture.orgA.workspaceId,
          subjectId: human,
        },
        [{ family: "private session A", table: "sessions", id: fixture.privateSessionA }],
      ),
    ).toEqual([]);
    // Nor for an unrelated subject inside organization A.
    expect(
      await visibleResources(
        {
          accountId: fixture.orgA.accountId,
          workspaceId: fixture.orgA.workspaceId,
          subjectId: fixture.otherSubjectId,
        },
        [{ family: "private session A", table: "sessions", id: fixture.privateSessionA }],
      ),
    ).toEqual([]);
  });

  test("revoking one organization membership stops access immediately and only there", async () => {
    if (!shared || !fixture) return;
    const human = fixture.humanSubjectId;
    const sessionA = {
      family: "private session A",
      table: "sessions",
      id: fixture.privateSessionA,
    };
    const sessionB = {
      family: "private session B",
      table: "sessions",
      id: fixture.privateSessionB,
    };
    const ctxA = {
      accountId: fixture.orgA.accountId,
      workspaceId: fixture.orgA.workspaceId,
      subjectId: human,
    };
    const ctxB = {
      accountId: fixture.orgB.accountId,
      workspaceId: fixture.orgB.workspaceId,
      subjectId: human,
    };

    // POSITIVE CONTROL before the revocation.
    expect(await visibleResources(ctxA, [sessionA])).toEqual([sessionA.family]);
    expect(await visibleResources(ctxB, [sessionB])).toEqual([sessionB.family]);

    await shared.admin`
      update organization_memberships
      set status = 'revoked', revoked_at = now()
      where id = ${fixture.orgA.membershipId}
    `;
    try {
      // Immediate: the very next transaction on the same runtime connection
      // pool already denies. No cache flush, no reconnect, no epoch bump.
      expect(await visibleResources(ctxA, [sessionA])).toEqual([]);
      // Scoped: organization B's membership is untouched.
      expect(await visibleResources(ctxB, [sessionB])).toEqual([sessionB.family]);
      // Retention is not authority: the row is still physically present.
      const [retained] = await shared.admin<{ count: number }[]>`
        select count(*)::int as count from sessions where id = ${fixture.privateSessionA}
      `;
      expect(retained?.count).toBe(1);
    } finally {
      await shared.admin`
        update organization_memberships
        set status = 'active', revoked_at = null
        where id = ${fixture.orgA.membershipId}
      `;
    }
    // Reactivation restores access, proving the denial above was caused by the
    // membership status and nothing incidental.
    expect(await visibleResources(ctxA, [sessionA])).toEqual([sessionA.family]);
  });

  test("FORCE row security binds a non-superuser SECURITY DEFINER owner", async () => {
    if (!shared || !app || !fixture) return;
    // OpenGeni's capability seams are SECURITY DEFINER routines owned by the
    // migration owner, which in production is NOT a superuser. This proves the
    // property those seams depend on: a definer that is neither superuser nor
    // BYPASSRLS remains subject to FORCE row-level security, so a seam cannot
    // become an ambient cross-organization read path.
    const role = `og_evd_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;
    definerRole = role;
    await shared.admin.unsafe(
      `CREATE ROLE "${role}" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN`,
    );
    await shared.admin.unsafe(`
      CREATE TABLE evidence_definer_rows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id uuid NOT NULL
      );
      ALTER TABLE evidence_definer_rows OWNER TO "${role}";
      ALTER TABLE evidence_definer_rows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE evidence_definer_rows FORCE ROW LEVEL SECURITY;
      CREATE POLICY evidence_account_isolation ON evidence_definer_rows
        USING (
          account_id
            = nullif(current_setting('opengeni.account_id', true), '')::uuid
        )
        WITH CHECK (
          account_id
            = nullif(current_setting('opengeni.account_id', true), '')::uuid
        );
      CREATE FUNCTION evidence_definer_count() RETURNS bigint
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path TO pg_catalog, public, pg_temp
        AS $$ SELECT count(*) FROM evidence_definer_rows $$;
      ALTER FUNCTION evidence_definer_count() OWNER TO "${role}";
      REVOKE ALL ON FUNCTION evidence_definer_count() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION evidence_definer_count() TO opengeni_app;
    `);
    await shared.admin`
      insert into evidence_definer_rows (account_id) values (${fixture.orgA.accountId})
    `;

    const [definerRoleRow] = await shared.admin<{ superuser: boolean; bypassRls: boolean }[]>`
      select rolsuper as "superuser", rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${role}
    `;
    expect(definerRoleRow).toEqual({ superuser: false, bypassRls: false });

    // POSITIVE CONTROL: the definer really can reach the row.
    const owning = await underContext({ accountId: fixture.orgA.accountId }, async (tx) => {
      const [row] = await tx<{ count: string }[]>`select evidence_definer_count() as count`;
      return Number(row?.count ?? -1);
    });
    expect(owning).toBe(1);

    // The definer's own FORCE-RLS policy still applies under organization B.
    const foreign = await underContext({ accountId: fixture.orgB.accountId }, async (tx) => {
      const [row] = await tx<{ count: string }[]>`select evidence_definer_count() as count`;
      return Number(row?.count ?? -1);
    });
    expect(foreign).toBe(0);

    // And with no context at all.
    const contextless = await underContext({}, async (tx) => {
      const [row] = await tx<{ count: string }[]>`select evidence_definer_count() as count`;
      return Number(row?.count ?? -1);
    });
    expect(contextless).toBe(0);

    // The runtime role still has no direct access to the definer's table.
    await expectSqlState(
      async () =>
        await underContext({ accountId: fixture!.orgA.accountId }, async (tx) => {
          await tx`select * from evidence_definer_rows`;
        }),
      "42501",
    );
  });
});
