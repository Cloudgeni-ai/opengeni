// Migration 0717: the v2 accepted-authority writers see the owner's personal
// connections under FORCE row security (design
// docs/design/subscription-core-2026-10-07.md, "Findings in earlier merged
// work"). The database is migrated by the NOSUPERUSER, NOBYPASSRLS owner, as
// the documented posture is; runtime calls run as the restricted application
// role. Before 0717 every acceptance froze the empty value for an owner with a
// serviceable personal Codex account; after it the owner's personal entry is
// frozen, through the same writers and the same rules. The runbook's inventory
// queries (docs/deployment.md) run against the fixtures staged before 0717.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  connectSubscriptionCoreCodexConnection,
  createDb,
  createScheduledTask,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows, withRlsContext } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0717_subscription_personal_acceptance_reads.sql";
const EMPTY = { version: 2, personal: [] };
const key = Buffer.alloc(32, 61);
const ROUTINES = [
  "opengeni_private.subscription_codex_acceptance_authority_v2(uuid,uuid,uuid,text)",
  "opengeni_private.subscription_codex_task_authority_v2(uuid,uuid,uuid,text)",
  "opengeni_private.subscription_core_acceptance_authority_v2(text,uuid,uuid,uuid,text)",
  "opengeni_private.subscription_core_task_authority_v2(text,uuid,uuid,uuid,text)",
];
/** The exact text 0717 inserts into each writer. */
const INSERTED = [
  "      prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);\n",
  "        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',\n" +
    "          'organization_membership_lifecycle', true);\n",
  "        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',\n" +
    "          coalesce(prior_lifecycle, ''), true);\n",
];

type Owner = {
  accountId: string;
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};
type Routine = {
  routine: string;
  definer: boolean;
  config: string[];
  acl: string;
  owner: string;
  definition: string;
};
type Inventory = {
  posture: { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[];
  owners: { account_id: string; owner_organization_membership_id: string }[];
};

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
/** State staged before 0717, on the same database. */
let before: {
  owner: Owner;
  sessionId: string;
  turnId: string;
  sessionTurn: unknown;
  task: unknown;
  codex: unknown;
  core: unknown;
  routines: Routine[];
  /** The runbook's queries as an operator runs them before deploying 0717. */
  inventory: Inventory;
} | null = null;
let posture: { unprovisioned: string[]; provisioned: string[] } | null = null;

/** The 0717 runbook queries in docs/deployment.md: the owner posture, then the owners served. */
async function inventory(): Promise<Inventory> {
  const runbook = await readFile(new URL("../../../docs/deployment.md", import.meta.url), "utf8");
  const section = runbook.slice(
    runbook.indexOf("### Personal Codex acceptance under row security (0717)"),
  );
  const start = section.indexOf("```sql\n") + "```sql\n".length;
  const queries = section
    .slice(start, section.indexOf("\n```", start))
    .split(";\n")
    .filter((query) => /\bSELECT\b/.test(query));
  if (queries.length !== 2)
    throw new Error(`expected two runbook queries, found ${queries.length}`);
  const admin = database!.admin;
  const ownerPosture = await admin.unsafe<Inventory["posture"]>(queries[0]!);
  const owners = await admin.unsafe<Inventory["owners"]>(queries[1]!);
  return {
    posture: ownerPosture.map((row) => ({ ...row })),
    owners: owners.map((row) => ({
      account_id: String(row.account_id),
      owner_organization_membership_id: String(row.owner_organization_membership_id),
    })),
  };
}

async function routines(): Promise<Routine[]> {
  return database!.admin<Routine[]>`
    select listed.name as routine, proc.prosecdef as definer,
      coalesce(proc.proconfig, '{}') as config, coalesce(proc.proacl::text, '') as acl,
      pg_get_userbyid(proc.proowner)::text as owner, pg_get_functiondef(proc.oid) as definition
    from unnest(${ROUTINES}::text[]) with ordinality listed(name, position)
    join pg_proc proc on proc.oid = listed.name::regprocedure
    order by listed.position`;
}

function personal(owner: Owner) {
  return {
    version: 2,
    personal: [
      { provider: "codex", ownerMembershipId: owner.membershipId, authorityGeneration: 1 },
    ],
  };
}

/** An organization owner with one serviceable personal Codex account and a shared workspace. */
async function stageOwner(): Promise<Owner> {
  const admin = database!.admin;
  const userId = `acceptance-reads-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Personal acceptance reads",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const subjectId = `user:${userId}`;
  const [membership] = await admin<{ id: string; workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${subjectId}
      and status = 'active' and revoked_at is null`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Personal acceptance reads shared') returning id::text as id`;
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${subjectId}, 'owner')`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  await admin`delete from subscription_settings where account_id = ${accountId}::uuid and workspace_id is null`;
  await admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (${accountId}::uuid, ${admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, false)`;
  await admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', true)
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
  const found: Owner = {
    accountId,
    subjectId,
    membershipId: membership!.id,
    personalWorkspaceId: membership!.workspace_id,
    sharedWorkspaceId: workspace!.id,
  };
  const connected = await withSessionRlsActorContext({ subjectId }, () =>
    connectSubscriptionCoreCodexConnection(client!.db, {
      accountId,
      workspaceId: found.personalWorkspaceId,
      subjectId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }),
      ),
      providerAccountId: `chatgpt-${crypto.randomUUID()}`,
      providerSubjectId: "acceptance-reads-person",
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 86_400_000),
      lastRefreshAt: new Date(),
      accountEmail: null,
      label: "personal",
    }),
  );
  if (connected.kind !== "connected") throw new Error(`connect refused: ${connected.reason}`);
  return found;
}

/** A session the owner creates and a turn they submit, through the runtime writers. */
async function ownerSession(
  owner: Owner,
  workspaceId = owner.personalWorkspaceId,
  visibility: "user_private" | "workspace_shared" = "user_private",
): Promise<{ sessionId: string; turnId: string; turn: unknown }> {
  const session = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    createSession(client!.db, {
      accountId: owner.accountId,
      workspaceId,
      subjectId: owner.subjectId,
      initialMessage: "Check the deployment",
      resources: [],
      metadata: {},
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility,
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      createdByContext: {},
    }),
  );
  const turn = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    enqueueSessionTurn(client!.db, {
      accountId: owner.accountId,
      workspaceId,
      sessionId: session.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${session.id}`,
      source: "user",
      prompt: "Check the deployment",
      resources: [],
      tools: [],
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: owner.subjectId },
    }),
  );
  return { sessionId: session.id, turnId: turn.id, turn: await turnAuthority(turn.id) };
}

/** A turn's frozen v2 value. */
async function turnAuthority(turnId: string): Promise<unknown> {
  const [row] = await database!.admin<{ v2: unknown }[]>`
    select subscription_authority as v2 from session_turns where id = ${turnId}::uuid`;
  if (!row) throw new Error(`turn ${turnId} not found`);
  return row.v2;
}

/** A scheduled task the owner creates through the runtime writer: its frozen v2 value. */
async function ownerTask(owner: Owner, workspaceId = owner.personalWorkspaceId): Promise<unknown> {
  const task = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
    createScheduledTask(client!.db, {
      accountId: owner.accountId,
      workspaceId,
      name: "Personal acceptance reads",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `acceptance-reads-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "Check the deployment", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "subject", subjectId: owner.subjectId },
      metadata: {},
    } as never),
  );
  const [row] = await database!.admin<{ v2: unknown }[]>`
    select subscription_authority as v2 from scheduled_tasks where id = ${task.id}::uuid`;
  return row!.v2;
}

/** Both session writers called by the application role, after an optional caller marker. */
async function accept(
  owner: Owner,
  sessionId: string,
  acceptingSubjectId = owner.subjectId,
  callerMarker?: string,
): Promise<{ codex: unknown; core: unknown; marker: string | null }> {
  const scope = {
    accountId: owner.accountId,
    workspaceId: owner.personalWorkspaceId,
    subjectId: acceptingSubjectId,
  };
  return withSessionRlsActorContext({ subjectId: acceptingSubjectId }, () =>
    withRlsContext(client!.db, scope, async (tx) => {
      if (callerMarker !== undefined) {
        await rawRows(
          tx,
          sql`select set_config('opengeni.organization_tenancy_lifecycle', ${callerMarker}, true)`,
        );
      }
      const [row] = await rawRows<{ codex: unknown; core: unknown; marker: string | null }>(
        tx,
        sql`select opengeni_private.subscription_codex_acceptance_authority_v2(
              ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${sessionId}::uuid,
              ${acceptingSubjectId}) as codex,
            opengeni_private.subscription_core_acceptance_authority_v2('codex',
              ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${sessionId}::uuid,
              ${acceptingSubjectId}) as core,
            current_setting('opengeni.organization_tenancy_lifecycle', true) as marker`,
      );
      return row!;
    }),
  );
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-personal-acceptance-reads");
  if (!database) throw new Error("Real PostgreSQL is required");
  // Stage a provisioned database without 0717, as a deployment is before it.
  const staging = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await staging`insert into schema_migrations(name) values (${MIGRATION})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await staging.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 4 });
  const stagedOwner = await stageOwner();
  const stagedSession = await ownerSession(stagedOwner);
  const stagedAcceptance = await accept(stagedOwner, stagedSession.sessionId);
  before = {
    owner: stagedOwner,
    sessionId: stagedSession.sessionId,
    turnId: stagedSession.turnId,
    sessionTurn: stagedSession.turn,
    task: await ownerTask(stagedOwner),
    codex: stagedAcceptance.codex,
    core: stagedAcceptance.core,
    routines: await routines(),
    inventory: await inventory(),
  };
  // A rolling migration keeps the previous binary's runtime posture until
  // roles are provisioned again: apply 0717 alone, evaluate as the runtime
  // role, then provision and evaluate again.
  const applying = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await applying`delete from schema_migrations where name = ${MIGRATION}`;
    await migrate(database.ownerUrl);
    const [applied] = await applying<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name = ${MIGRATION}`;
    if (applied?.count !== 1) throw new Error("0717 was not applied by the second migrate");
  } finally {
    await applying.end();
  }
  const options = {
    rlsStrategy: "force" as const,
    expectedRole: "opengeni_app",
    targetSchema: "public",
    requiredRuntimeRoutines: [],
  };
  const evaluate = async () =>
    evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client!.db, options),
      options,
    );
  const unprovisioned = await evaluate();
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  posture = { unprovisioned, provisioned: await evaluate() };
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

describe.skipIf(!realDb)("0717 personal acceptance reads", () => {
  test("the owner and the application role are bound by row security; the rolling posture holds", async () => {
    const roles = await database!.admin<{ superuser: boolean; bypass: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname in (${database!.ownerRole}, 'opengeni_app')`;
    expect([...roles]).toEqual([
      { superuser: false, bypass: false },
      { superuser: false, bypass: false },
    ]);
    const [identity] = await rawRows<{ role: string }>(
      client!.db,
      sql`select current_user::text as role`,
    );
    expect(identity!.role).toBe("opengeni_app");
    expect(posture).toEqual({ unprovisioned: [], provisioned: [] });
  });

  test("before 0717 every writer froze the empty value for a serviceable personal account", () => {
    expect(before!.sessionTurn).toEqual(EMPTY);
    expect(before!.task).toEqual(EMPTY);
    expect({ codex: before!.codex, core: before!.core }).toEqual({ codex: EMPTY, core: EMPTY });
  });

  test("pre-merge inventory: the runbook finds the bound owner and the owner 0717 starts to serve", () => {
    expect(before!.inventory).toEqual({
      posture: [{ rolname: database!.ownerRole, rolsuper: false, rolbypassrls: false }],
      owners: [
        {
          account_id: before!.owner.accountId,
          owner_organization_membership_id: before!.owner.membershipId,
        },
      ],
    });
  });

  test("the writers freeze the owner's personal entry, through the runtime and directly", async () => {
    const fresh = await stageOwner();
    const session = await ownerSession(fresh);
    expect(session.turn).toEqual(personal(fresh));
    expect(await ownerTask(fresh)).toEqual(personal(fresh));
    const direct = await accept(fresh, session.sessionId);
    expect({ codex: direct.codex, core: direct.core }).toEqual({
      codex: personal(fresh),
      core: personal(fresh),
    });
    // The owner staged before 0717 is served by new acceptances; frozen values stay.
    const staged = await ownerSession(before!.owner);
    expect(staged.turn).toEqual(personal(before!.owner));
    expect(await turnAuthority(before!.turnId)).toEqual(EMPTY);
  });

  test("the rules are unchanged: the exact owner, in their private session or Personal workspace", async () => {
    const fresh = await stageOwner();
    const shared = await ownerSession(fresh, fresh.sharedWorkspaceId, "workspace_shared");
    expect(shared.turn).toEqual(EMPTY);
    expect(await ownerTask(fresh, fresh.sharedWorkspaceId)).toEqual(EMPTY);
    const own = await ownerSession(fresh);
    const other = await accept(fresh, own.sessionId, "user:someone-else");
    expect({ codex: other.codex, core: other.core }).toEqual({ codex: EMPTY, core: EMPTY });
  });

  test("the membership-lifecycle marker is restored to the caller's value", async () => {
    const fresh = await stageOwner();
    const session = await ownerSession(fresh);
    const unset = await accept(fresh, session.sessionId);
    expect(unset.core).toEqual(personal(fresh));
    expect(unset.marker ?? "").toBe("");
    const preset = await accept(fresh, session.sessionId, fresh.subjectId, "caller-value");
    expect(preset.core).toEqual(personal(fresh));
    expect(preset.marker).toBe("caller-value");
  });

  test("each writer keeps its attributes and changes only by the inserted marker lines", async () => {
    const after = await routines();
    const attributes = (rows: Routine[]) => rows.map(({ definition: _, ...rest }) => rest);
    expect(attributes(after)).toEqual(attributes(before!.routines));
    for (const [index, routine] of after.entries()) {
      for (const inserted of INSERTED) expect(routine.definition.split(inserted)).toHaveLength(2);
      const stripped = INSERTED.reduce(
        (text, inserted) => text.replace(inserted, ""),
        routine.definition,
      );
      expect(stripped).toBe(before!.routines[index]!.definition);
    }
  });
});
