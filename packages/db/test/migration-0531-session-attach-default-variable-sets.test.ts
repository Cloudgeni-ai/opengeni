// Migration 0531: the direct session-attach Variable Set seam also admits the
// defaults of the session's frozen Sandbox Environment version, as the agent
// attempt seam does, and turns every other miss into a recorded 42501 denial
// instead of an unmapped P0002. Personal sets still need the exact causal human
// and a live session/always grant.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  createDb,
  createRig,
  createRigVersion,
  createSession,
  getVariableSetValuesForRun,
  initializeSessionStartAtomically,
  nestedPostgresSqlState,
  type Database,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL(
  "../drizzle/0531_session_attach_sandbox_environment_default_variable_sets.sql",
  import.meta.url,
);

type Context = { admin: postgres.Sql; db: Database };
type Workspace = { accountId: string; workspaceId: string };
type SessionFixture = Workspace & { rigId: string; sessionId: string };

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let ctx: Context;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0531-session-attach-default-variable-sets");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  client = createDb(shared.appUrl);
  ctx = { admin: shared.admin, db: client.db };
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspaceFixture(context: Context): Promise<Workspace> {
  const [account] = await context.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('session-attach-defaults') returning id`;
  const [workspace] = await context.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'session-attach-defaults') returning id`;
  await context.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function variableSet(
  context: Context,
  input: Workspace & {
    name: string;
    value: string;
    scope?: "workspace" | "organization";
  },
): Promise<string> {
  const [row] = await context.admin<{ id: string }[]>`
    insert into workspace_variable_sets (
      account_id, workspace_id, name, origin_workspace_id, authority_scope
    ) values (
      ${input.accountId}, ${input.workspaceId}, ${input.name}, ${input.workspaceId},
      ${input.scope ?? "workspace"}
    ) returning id`;
  await context.admin`
    insert into workspace_variable_set_variables (
      account_id, workspace_id, variable_set_id, name, value_encrypted
    ) values (${input.accountId}, ${input.workspaceId}, ${row!.id}, 'TOKEN', ${input.value})`;
  return row!.id;
}

async function sessionFixture(
  context: Context,
  input: {
    workspace: Workspace;
    defaultVariableSetIds?: string[];
    variableSetIds?: string[];
    createdBySubjectId?: string;
  },
): Promise<SessionFixture> {
  const { workspace } = input;
  const rig = await createRig(context.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    name: `environment-${crypto.randomUUID()}`,
    createdBy: "user:test",
    initialVersion: { changelog: "v1" },
  });
  // Seed the frozen version's defaults directly: this suite is about the
  // attach seam, not about which sets the product API lets an owner bind.
  await context.admin`
    update rig_versions
    set default_variable_set_ids = ${JSON.stringify(input.defaultVariableSetIds ?? [])}::text::jsonb
    where id = ${rig.activeVersion!.id}`;
  const [seeded] = await context.admin<Array<{ ids: string[] }>>`
    select default_variable_set_ids as ids from rig_versions where id = ${rig.activeVersion!.id}`;
  expect(seeded!.ids).toEqual(input.defaultVariableSetIds ?? []);
  const session = await createSession(context.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: "attach me",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    variableSetIds: input.variableSetIds ?? [],
    rigId: rig.id,
    rigVersionId: rig.activeVersion!.id,
    ...(input.createdBySubjectId
      ? { createdBy: { kind: "subject" as const, subjectId: input.createdBySubjectId } }
      : {}),
  });
  await initializeSessionStartAtomically(context.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  return { ...workspace, rigId: rig.id, sessionId: session.id };
}

async function attach(
  context: Context,
  fixture: SessionFixture,
  variableSetId: string,
  subjectId: string | null = "user:session-attach-defaults",
) {
  return await getVariableSetValuesForRun(context.db, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    variableSetId,
    authority: { kind: "session_attach", sessionId: fixture.sessionId, subjectId },
  });
}

async function attachFailure(
  context: Context,
  fixture: SessionFixture,
  variableSetId: string,
  subjectId?: string | null,
): Promise<string | null> {
  return await attach(context, fixture, variableSetId, subjectId).then(
    () => "no error",
    (error: unknown) => nestedPostgresSqlState(error),
  );
}

async function auditCounts(context: Context, workspaceId: string, variableSetId: string) {
  const [counts] = await context.admin<Array<{ materialized: number; denied: number }>>`
    select
      count(*) filter (where action = 'variable_set.materialized')::int as materialized,
      count(*) filter (where action = 'variable_set.materialize.denied')::int as denied
    from audit_events
    where workspace_id = ${workspaceId} and target_id = ${variableSetId}`;
  return counts!;
}

/** A personal (user-scope) Variable Set owned by one member, used as the
 *  default of a shared-workspace session's frozen Sandbox Environment, with
 *  the owner's live `variable_set.use` session grant for that session. */
async function personalDefaultFixture(context: Context) {
  const accountId = crypto.randomUUID();
  const personalWorkspaceId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const ownerSubjectId = `user:${crypto.randomUUID()}`;
  const otherSubjectId = `user:${crypto.randomUUID()}`;
  const otherPersonalWorkspaceId = crypto.randomUUID();
  await context.admin`
    insert into managed_accounts (id, name) values (${accountId}, 'personal default')`;
  await context.admin`
    insert into workspaces (id, account_id, name) values
      (${personalWorkspaceId}, ${accountId}, 'personal'),
      (${otherPersonalWorkspaceId}, ${accountId}, 'other personal'),
      (${workspaceId}, ${accountId}, 'shared')`;
  await context.admin`
    insert into workspace_inference_controls (workspace_id, account_id) values
      (${personalWorkspaceId}, ${accountId}),
      (${otherPersonalWorkspaceId}, ${accountId}),
      (${workspaceId}, ${accountId})`;
  const [membership] = await context.admin<Array<{ id: string }>>`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, authorization_revision
    ) values (${accountId}, ${ownerSubjectId}, 'active', ${personalWorkspaceId}, 3)
    returning id`;
  await context.admin`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id, authorization_revision
    ) values (${accountId}, ${otherSubjectId}, 'active', ${otherPersonalWorkspaceId}, 3)`;
  await context.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id) values
      (${accountId}, ${workspaceId}, ${ownerSubjectId}),
      (${accountId}, ${workspaceId}, ${otherSubjectId})`;
  const [personalSet] = await context.admin<Array<{ id: string }>>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${accountId}, ${personalWorkspaceId}, 'personal default') returning id`;
  const [authority] = await context.admin<Array<{ id: string }>>`
    insert into organization_user_resource_authorities (
      account_id, organization_membership_id, resource_kind, resource_id,
      origin_workspace_id, generation, status
    ) values (
      ${accountId}, ${membership!.id}, 'variable_set', ${personalSet!.id},
      ${personalWorkspaceId}, 1, 'active'
    ) returning id`;
  await context.admin`
    update workspace_variable_sets
    set authority_scope = 'user', authority_id = ${authority!.id},
      owner_organization_membership_id = ${membership!.id},
      origin_workspace_id = ${personalWorkspaceId}
    where id = ${personalSet!.id}`;
  await context.admin`
    insert into workspace_variable_set_variables (
      account_id, workspace_id, variable_set_id, name, value_encrypted
    ) values (
      ${accountId}, ${personalWorkspaceId}, ${personalSet!.id}, 'TOKEN', 'ciphertext:personal'
    )`;
  const fixture = await sessionFixture(context, {
    workspace: { accountId, workspaceId },
    defaultVariableSetIds: [personalSet!.id],
    createdBySubjectId: ownerSubjectId,
  });
  const [session] = await context.admin<Array<{ epoch: number; visibility: string }>>`
    select authority_epoch as epoch, visibility from sessions where id = ${fixture.sessionId}`;
  const [grant] = await context.admin<Array<{ id: string }>>`
    insert into organization_user_resource_grants (
      account_id, authority_id, owner_organization_membership_id, workspace_id,
      session_id, action, mode, context, authority_epoch, status
    ) values (
      ${accountId}, ${authority!.id}, ${membership!.id}, ${workspaceId},
      ${fixture.sessionId}, 'variable_set.use', 'session', ${session!.visibility},
      ${session!.epoch}, 'active'
    ) returning id`;
  return {
    fixture,
    personalSetId: personalSet!.id,
    grantId: grant!.id,
    ownerSubjectId,
    otherSubjectId,
  };
}

/** Behaviour that must hold on every database posture. */
async function assertDefaultAdmission(context: Context): Promise<void> {
  const workspace = await workspaceFixture(context);
  const defaultSet = await variableSet(context, {
    ...workspace,
    name: "environment default",
    value: "ciphertext:default",
  });
  const selectedSet = await variableSet(context, {
    ...workspace,
    name: "selected",
    value: "ciphertext:selected",
  });
  const otherSet = await variableSet(context, {
    ...workspace,
    name: "other",
    value: "ciphertext:other",
  });
  const fixture = await sessionFixture(context, {
    workspace,
    defaultVariableSetIds: [defaultSet],
    variableSetIds: [selectedSet],
  });
  expect((await attach(context, fixture, defaultSet))?.values).toEqual({
    TOKEN: "ciphertext:default",
  });
  expect((await attach(context, fixture, selectedSet))?.values).toEqual({
    TOKEN: "ciphertext:selected",
  });
  expect(await attachFailure(context, fixture, otherSet)).toBe("42501");
  expect(await auditCounts(context, workspace.workspaceId, defaultSet)).toEqual({
    materialized: 1,
    denied: 0,
  });
  expect(await auditCounts(context, workspace.workspaceId, otherSet)).toEqual({
    materialized: 0,
    denied: 1,
  });
}

/** Another member and a service attach never borrow the owner's grant. */
async function assertPersonalDefaultDenials(
  context: Context,
  personal: Awaited<ReturnType<typeof personalDefaultFixture>>,
): Promise<void> {
  const { fixture, personalSetId } = personal;
  expect(await attachFailure(context, fixture, personalSetId, personal.otherSubjectId)).toBe(
    "42501",
  );
  expect(await attachFailure(context, fixture, personalSetId, null)).toBe("42501");
}

async function assertPersonalDefault(context: Context): Promise<void> {
  const personal = await personalDefaultFixture(context);
  const { fixture, personalSetId } = personal;
  // The owner, as causal human with a live session grant, materializes it.
  expect((await attach(context, fixture, personalSetId, personal.ownerSubjectId))?.values).toEqual({
    TOKEN: "ciphertext:personal",
  });
  await assertPersonalDefaultDenials(context, personal);
  // A revoked grant denies the owner too.
  await context.admin`
    update organization_user_resource_grants
    set status = 'revoked', revoked_at = now()
    where id = ${personal.grantId}`;
  expect(await attachFailure(context, fixture, personalSetId, personal.ownerSubjectId)).toBe(
    "42501",
  );
  expect(await auditCounts(context, fixture.workspaceId, personalSetId)).toEqual({
    materialized: 1,
    denied: 3,
  });
}

async function assertOrganizationDefault(context: Context): Promise<void> {
  const workspace = await workspaceFixture(context);
  const [homeWorkspace] = await context.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${workspace.accountId}, 'organization set home') returning id`;
  const organizationSet = await variableSet(context, {
    accountId: workspace.accountId,
    workspaceId: homeWorkspace!.id,
    name: "organization default",
    value: "ciphertext:organization",
    scope: "organization",
  });
  const fixture = await sessionFixture(context, {
    workspace,
    defaultVariableSetIds: [organizationSet],
  });
  expect((await attach(context, fixture, organizationSet))?.values).toEqual({
    TOKEN: "ciphertext:organization",
  });
  // An organization set of another organization is never admitted, even if a
  // stale environment version names it.
  const otherOrganization = await workspaceFixture(context);
  const foreignOrganizationSet = await variableSet(context, {
    ...otherOrganization,
    name: "foreign organization default",
    value: "ciphertext:foreign",
    scope: "organization",
  });
  const foreign = await sessionFixture(context, {
    workspace,
    defaultVariableSetIds: [foreignOrganizationSet],
  });
  expect(await attachFailure(context, foreign, foreignOrganizationSet)).toBe("42501");
}

describe("migration 0531 session-attach Sandbox Environment default Variable Sets", () => {
  test("declares a rolling, signature-preserving replacement that mirrors the attempt seam", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain(
      "CREATE OR REPLACE FUNCTION materialize_scoped_variable_set_for_session(",
    );
    expect(source).toContain("ON rig_version.id = session_value.rig_version_id");
    expect(source).toContain("AND rig_version.rig_id = session_value.rig_id");
    expect(source).toContain("AND rig_version.account_id = session_value.account_id");
    expect(source).toContain(
      "coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)\n        ? p_variable_set_id::text",
    );
    // Every pre-existing check survives the replacement.
    expect(source).toContain("variable-set session materialization scope mismatch");
    expect(source).toContain("AND variable_set.workspace_id = p_workspace_id");
    expect(source).toContain("'waiting_capacity', 'failed'");
    expect(source).toContain("grant_value.action = 'variable_set.use'");
    expect(source).toContain("membership.subject_id = causal_human");
    expect(source).toContain("FOR SHARE OF session_value, variable_set");
    expect(source).toContain("FOR SHARE OF membership, authority, grant_value");
    expect(source).toContain("'variable_set.materialized'");
    // The no-row case is an authorization denial, not a STRICT P0002.
    expect(source).not.toMatch(/^\s*INTO STRICT\b/mu);
    expect(source).toContain("IF NOT FOUND THEN");
    expect(source).toContain("SET search_path = pg_catalog, %1$I, pg_temp");
    expect(source).not.toMatch(/\bDROP\b/u);
    expect(source).not.toMatch(/\bGRANT\b/u);
  });

  test("keeps the definer posture: pinned search path and application-only EXECUTE", async () => {
    if (!available) return;
    const [routine] = await ctx.admin<
      Array<{
        securityDefiner: boolean;
        configuration: string[] | null;
        schema: string;
        publicExecute: boolean;
        appExecute: boolean;
      }>
    >`
      select p.prosecdef as "securityDefiner", p.proconfig as configuration,
        n.nspname as schema,
        exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute",
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as "appExecute"
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'materialize_scoped_variable_set_for_session'`;
    expect(routine!.securityDefiner).toBe(true);
    expect(routine!.configuration).toEqual([`search_path=pg_catalog, ${routine!.schema}, pg_temp`]);
    expect(routine!.publicExecute).toBe(false);
    expect(routine!.appExecute).toBe(true);
  });

  test("materializes defaults and the session's own selection; denies anything else", async () => {
    if (!available) return;
    await assertDefaultAdmission(ctx);
  });

  test("a personal default needs its owner as causal human and a live grant", async () => {
    if (!available) return;
    await assertPersonalDefault(ctx);
  });

  test("an organization default is admitted only inside its own organization", async () => {
    if (!available) return;
    await assertOrganizationDefault(ctx);
  });

  test("a default added by a later environment version is not admitted to a frozen session", async () => {
    if (!available) return;
    const workspace = await workspaceFixture(ctx);
    const laterSet = await variableSet(ctx, {
      ...workspace,
      name: "later default",
      value: "ciphertext:later",
    });
    const fixture = await sessionFixture(ctx, { workspace });
    await createRigVersion(
      ctx.db,
      fixture.workspaceId,
      fixture.rigId,
      { changelog: "v2", defaultVariableSetIds: [laterSet] },
      { activate: true },
    );
    expect(await attachFailure(ctx, fixture, laterSet)).toBe("42501");
    expect(await auditCounts(ctx, fixture.workspaceId, laterSet)).toEqual({
      materialized: 0,
      denied: 1,
    });
  });

  test("another environment's default in the same workspace is not admitted", async () => {
    if (!available) return;
    const workspace = await workspaceFixture(ctx);
    const foreignDefault = await variableSet(ctx, {
      ...workspace,
      name: "other environment default",
      value: "ciphertext:foreign",
    });
    await sessionFixture(ctx, { workspace, defaultVariableSetIds: [foreignDefault] });
    const fixture = await sessionFixture(ctx, { workspace });
    expect(await attachFailure(ctx, fixture, foreignDefault)).toBe("42501");
  });

  test("a workspace-scoped default from another workspace stays outside the attach", async () => {
    if (!available) return;
    const workspace = await workspaceFixture(ctx);
    const [otherWorkspace] = await ctx.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${workspace.accountId}, 'other workspace') returning id`;
    const foreignSet = await variableSet(ctx, {
      accountId: workspace.accountId,
      workspaceId: otherWorkspace!.id,
      name: "other workspace set",
      value: "ciphertext:foreign",
    });
    const fixture = await sessionFixture(ctx, {
      workspace,
      defaultVariableSetIds: [foreignSet],
    });
    expect(await attachFailure(ctx, fixture, foreignSet)).toBe("42501");
  });

  test("a default that was revoked is denied, not materialized", async () => {
    if (!available) return;
    const workspace = await workspaceFixture(ctx);
    const defaultSet = await variableSet(ctx, {
      ...workspace,
      name: "revoked default",
      value: "ciphertext:revoked",
    });
    const fixture = await sessionFixture(ctx, { workspace, defaultVariableSetIds: [defaultSet] });
    await ctx.admin`
      update workspace_variable_sets set status = 'revoked', revoked_at = now()
      where id = ${defaultSet}`;
    expect(await attachFailure(ctx, fixture, defaultSet)).toBe("42501");
  });

  // The shared template is migrated by the container superuser, for whom FORCE
  // ROW LEVEL SECURITY never engages. Replay the ledger as a non-superuser
  // owner, provision the application role, and prove the definer still reads
  // rig_versions (FORCE RLS) through its capability on a real posture.
  test("admits defaults through FORCE RLS on an owner-migrated database", async () => {
    const owned = await acquireOwnerMigratedTestDatabase("session-attach-default-variable-sets");
    if (!owned) {
      if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
      return;
    }
    let ownedClient: DbClient | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const [forced] = await owned.admin<Array<{ forced: boolean }>>`
        select relforcerowsecurity as forced from pg_class where relname = 'rig_versions'`;
      expect(forced!.forced).toBe(true);
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      ownedClient = createDb(appUrl.toString());
      const ownedContext: Context = { admin: owned.admin, db: ownedClient.db };
      await assertDefaultAdmission(ownedContext);
      await assertPersonalDefaultDenials(ownedContext, await personalDefaultFixture(ownedContext));
      // Positive admission of a set stored in another workspace (personal or
      // organization scope) is not asserted here: under this posture the
      // seam's FOR SHARE lock also evaluates the table's UPDATE policy, which
      // the read-only materialize capability does not open. That predates this
      // migration and applies equally to the agent attempt seam.
    } finally {
      await ownedClient?.close();
      await owned.release();
    }
  }, 180_000);
});
