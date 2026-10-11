// Migration 0724: the v2 accepted-authority writers see the owner's personal
// connections under FORCE row security (design
// docs/design/subscription-core-2026-10-07.md, "Findings in earlier merged
// work"). The database is migrated by the NOSUPERUSER, NOBYPASSRLS owner, as
// the documented posture is; runtime calls run as the restricted application
// role. Before 0724 every acceptance froze the empty value for an owner with a
// serviceable personal Codex account; after it the owner's personal entry is
// frozen, through the same writers and the same rules. Health recovery had the
// same defect: before 0724 the owner's own turn never recovered their due
// quarantined personal account, even with the entry frozen; after it the turn
// does. The runbook's inventory queries (docs/deployment.md) run against the
// fixtures staged before 0724.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  claimSessionWorkForAttempt,
  connectSubscriptionCoreCodexConnection,
  createDb,
  createScheduledTask,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  readSubscriptionCoreTurnIdentity,
  recoverSubscriptionCoreCodexConnectionHealth,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { rawRows, withRlsContext } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { withSubscriptionCoreAcceptedTurn } from "../src/subscription-core-placement-world";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0724_subscription_personal_acceptance_reads.sql";
const EMPTY = { version: 2, personal: [] };
const key = Buffer.alloc(32, 61);
const ROUTINES = [
  "opengeni_private.subscription_codex_acceptance_authority_v2(uuid,uuid,uuid,text)",
  "opengeni_private.subscription_codex_task_authority_v2(uuid,uuid,uuid,text)",
  "opengeni_private.subscription_core_acceptance_authority_v2(text,uuid,uuid,uuid,text)",
  "opengeni_private.subscription_core_task_authority_v2(text,uuid,uuid,uuid,text)",
];
const RECOVERY = [
  "opengeni_private.recover_subscription_codex_connection_health(uuid,uuid,uuid,uuid)",
  "opengeni_private.recover_subscription_core_connection_health(text,uuid,uuid,uuid,uuid)",
];
const SET_MARKER = "pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',\n";
/**
 * The exact replacements 0724 makes in each writer, written out here rather
 * than read from the migration, so the live definition pins where the marker
 * is set and where it is restored (immediately around the generation count).
 */
const WRITER_PATCHES: [string, string][] = [
  [
    "      minted_lifecycle boolean := false;\n",
    "      minted_lifecycle boolean := false;\n" +
      "      prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);\n",
  ],
  [
    "        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')\n" +
      "          INTO generations\n",
    `        PERFORM ${SET_MARKER}` +
      "          'organization_membership_lifecycle', true);\n" +
      "        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')\n" +
      "          INTO generations\n",
  ],
  [
    "          AND authority.status = 'active' AND authority.revoked_at IS NULL;\n      END IF;\n",
    "          AND authority.status = 'active' AND authority.revoked_at IS NULL;\n" +
      `        PERFORM ${SET_MARKER}` +
      "          coalesce(prior_lifecycle, ''), true);\n" +
      "      END IF;\n",
  ],
];
/**
 * The exact replacements 0724 makes in each recovery routine: the candidates
 * are collected under the marker and it is restored before the first write.
 */
const RECOVERY_PATCHES: [string, string][] = [
  [
    "      recovered integer := 0;\n",
    "      recovered integer := 0;\n" +
      "      targets uuid[];\n" +
      "      prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);\n",
  ],
  [
    "      FOR target IN\n        SELECT connection.id FROM ",
    `      PERFORM ${SET_MARKER}` +
      "        'organization_membership_lifecycle', true);\n" +
      "      SELECT coalesce(array_agg(connection.id ORDER BY connection.id), '{}')\n" +
      "        INTO targets\n" +
      "        FROM ",
  ],
  [
    "        ORDER BY connection.id\n      LOOP\n",
    "        ;\n" +
      `      PERFORM ${SET_MARKER}` +
      "        coalesce(prior_lifecycle, ''), true);\n" +
      "      FOREACH target IN ARRAY targets LOOP\n",
  ],
];

/** A definition with each replacement applied once, where its anchor occurs exactly once. */
function patched(definition: string, patches: [string, string][]): string {
  return patches.reduce((text, [anchor, replacement]) => {
    expect(text.split(anchor)).toHaveLength(2);
    return text.replace(anchor, () => replacement);
  }, definition);
}

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
/** State staged before 0724, on the same database. */
let before: {
  owner: Owner;
  sessionId: string;
  turnId: string;
  sessionTurn: unknown;
  task: unknown;
  codex: unknown;
  core: unknown;
  routines: Routine[];
  recovery: Routine[];
  /** Recovery by the owner's own turn before 0724, through the core and Codex routines. */
  recovered: { core: number; codex: number };
  /** The runbook's queries as an operator runs them before deploying 0724. */
  inventory: Inventory;
} | null = null;
let posture: { unprovisioned: string[]; provisioned: string[] } | null = null;

/** The 0724 runbook queries in docs/deployment.md: the owner posture, then the owners served. */
async function inventory(): Promise<Inventory> {
  const runbook = await readFile(new URL("../../../docs/deployment.md", import.meta.url), "utf8");
  const section = runbook.slice(
    runbook.indexOf("### Personal Codex acceptance under row security (0724)"),
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

async function routines(names: string[] = ROUTINES): Promise<Routine[]> {
  return database!.admin<Routine[]>`
    select listed.name as routine, proc.prosecdef as definer,
      coalesce(proc.proconfig, '{}') as config, coalesce(proc.proacl::text, '') as acl,
      pg_get_userbyid(proc.proowner)::text as owner, pg_get_functiondef(proc.oid) as definition
    from unnest(${names}::text[]) with ordinality listed(name, position)
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

/**
 * The owner's own claimed turn in their private session with the personal
 * entry frozen. Before 0724 the writers froze the empty value, so the fixture
 * writes the entry directly with triggers suspended (the frozen value is
 * immutable), and the evidence does not depend on the writers.
 */
async function quarantinedOwnTurn(owner: Owner, sessionId: string, turnId: string) {
  if (JSON.stringify(await turnAuthority(turnId)) !== JSON.stringify(personal(owner))) {
    await database!.admin.begin(async (admin) => {
      await admin`set local session_replication_role = replica`;
      await admin`update session_turns
        set subscription_authority = ${admin.json(personal(owner))}::jsonb
        where id = ${turnId}::uuid`;
    });
  }
  const claimed = await claimSessionWorkForAttempt(client!.db, owner.personalWorkspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  const identity = await readSubscriptionCoreTurnIdentity(client!.db, {
    accountId: owner.accountId,
    workspaceId: owner.personalWorkspaceId,
    sessionId,
    turnId,
  });
  if (!identity) throw new Error("accepted turn identity was not readable");
  return identity;
}

async function quarantinePersonal(owner: Owner): Promise<void> {
  const updated = await database!.admin`update subscription_connections
    set status = 'error', last_error = 'model request was forbidden for this credential',
      health_retry_at = now() - interval '1 second'
    where account_id = ${owner.accountId}::uuid and ownership = 'personal'
      and owner_organization_membership_id = ${owner.membershipId}::uuid`;
  if (updated.count !== 1)
    throw new Error(`expected one personal connection, found ${updated.count}`);
}

async function personalStatus(owner: Owner): Promise<string> {
  const [row] = await database!.admin<{ status: string }[]>`
    select status from subscription_connections
    where account_id = ${owner.accountId}::uuid and ownership = 'personal'
      and owner_organization_membership_id = ${owner.membershipId}::uuid`;
  return row!.status;
}

/** Recovery through the Codex form, called directly inside the accepted turn. */
async function recoverCodexDirect(
  identity: NonNullable<Awaited<ReturnType<typeof readSubscriptionCoreTurnIdentity>>>,
): Promise<number> {
  const access = await withSubscriptionCoreAcceptedTurn(client!.db, identity, async (tx) => {
    const [row] = await rawRows<{ recovered: number }>(
      tx,
      sql`select opengeni_private.recover_subscription_codex_connection_health(
        ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
        ${identity.sessionId}::uuid, ${identity.turnId}::uuid) as recovered`,
    );
    return Number(row?.recovered ?? 0);
  });
  if (access.status !== "completed") throw new Error(`turn access: ${access.status}`);
  return access.value;
}

/** Recover the owner's quarantined personal account through both routines. */
async function recoverBoth(
  owner: Owner,
  identity: NonNullable<Awaited<ReturnType<typeof readSubscriptionCoreTurnIdentity>>>,
): Promise<{ core: number; codex: number; status: string }> {
  await quarantinePersonal(owner);
  const core = await recoverSubscriptionCoreCodexConnectionHealth(client!.db, identity);
  await quarantinePersonal(owner);
  const codex = await recoverCodexDirect(identity);
  return { core, codex, status: await personalStatus(owner) };
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-personal-acceptance-reads");
  if (!database) throw new Error("Real PostgreSQL is required");
  // Stage a provisioned database without 0724, as a deployment is before it:
  // 0724 and every later migration (which may require 0724, or retire the
  // routines it patches) are held back, and only 0724 is applied below.
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= MIGRATION)
    .sort();
  const staging = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack)
      await staging`insert into schema_migrations(name) values (${name})`;
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
  const recoverySession = await ownerSession(stagedOwner);
  const recoveryIdentity = await quarantinedOwnTurn(
    stagedOwner,
    recoverySession.sessionId,
    recoverySession.turnId,
  );
  const stagedRecovery = await recoverBoth(stagedOwner, recoveryIdentity);
  if (stagedRecovery.status !== "error")
    throw new Error("the quarantine was recovered before 0724");
  await database.admin`update subscription_connections set status = 'active', last_error = null,
      health_retry_at = null
    where account_id = ${stagedOwner.accountId}::uuid and ownership = 'personal'`;
  before = {
    owner: stagedOwner,
    sessionId: stagedSession.sessionId,
    turnId: stagedSession.turnId,
    sessionTurn: stagedSession.turn,
    task: await ownerTask(stagedOwner),
    codex: stagedAcceptance.codex,
    core: stagedAcceptance.core,
    routines: await routines(),
    recovery: await routines(RECOVERY),
    recovered: { core: stagedRecovery.core, codex: stagedRecovery.codex },
    inventory: await inventory(),
  };
  // A rolling migration keeps the previous binary's runtime posture until
  // roles are provisioned again: apply 0724 alone, evaluate as the runtime
  // role, then provision and evaluate again.
  const applying = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await applying`delete from schema_migrations where name = ${MIGRATION}`;
    await migrate(database.ownerUrl);
    const [applied] = await applying<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name = ${MIGRATION}`;
    if (applied?.count !== 1) throw new Error("0724 was not applied by the second migrate");
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

describe.skipIf(!realDb)("0724 personal acceptance reads", () => {
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

  test("before 0724 every writer froze the empty value for a serviceable personal account", () => {
    expect(before!.sessionTurn).toEqual(EMPTY);
    expect(before!.task).toEqual(EMPTY);
    expect({ codex: before!.codex, core: before!.core }).toEqual({ codex: EMPTY, core: EMPTY });
  });

  test("pre-merge inventory: the runbook finds the bound owner and the owner 0724 starts to serve", () => {
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
    // The owner staged before 0724 is served by new acceptances; frozen values stay.
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

  test("the owner's own turn recovers their due quarantined personal account", async () => {
    // Before 0724 neither routine saw the row, though the entry was frozen.
    expect(before!.recovered).toEqual({ core: 0, codex: 0 });
    const fresh = await stageOwner();
    const session = await ownerSession(fresh);
    expect(session.turn).toEqual(personal(fresh));
    const identity = await quarantinedOwnTurn(fresh, session.sessionId, session.turnId);
    expect(await recoverBoth(fresh, identity)).toEqual({ core: 1, codex: 1, status: "active" });
    // The rules are unchanged: the owner's own turn in a shared session froze
    // no personal entry and recovers nothing; the caller's marker is restored.
    const shared = await ownerSession(fresh, fresh.sharedWorkspaceId, "workspace_shared");
    const claimed = await claimSessionWorkForAttempt(client!.db, fresh.sharedWorkspaceId, {
      sessionId: shared.sessionId,
      workflowId: `session-${shared.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    const sharedIdentity = await readSubscriptionCoreTurnIdentity(client!.db, {
      accountId: fresh.accountId,
      workspaceId: fresh.sharedWorkspaceId,
      sessionId: shared.sessionId,
      turnId: shared.turnId,
    });
    await quarantinePersonal(fresh);
    expect(await recoverSubscriptionCoreCodexConnectionHealth(client!.db, sharedIdentity!)).toBe(0);
    expect(await recoverCodexDirect(sharedIdentity!)).toBe(0);
    expect(await personalStatus(fresh)).toBe("error");
    const marker = await withSubscriptionCoreAcceptedTurn(client!.db, identity, async (tx) => {
      await rawRows(
        tx,
        sql`select set_config('opengeni.organization_tenancy_lifecycle', 'caller-value', true)`,
      );
      const [row] = await rawRows<{ recovered: number; marker: string }>(
        tx,
        sql`select opengeni_private.recover_subscription_core_connection_health('codex',
            ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
            ${identity.sessionId}::uuid, ${identity.turnId}::uuid) as recovered,
          current_setting('opengeni.organization_tenancy_lifecycle', true) as marker`,
      );
      return row!;
    });
    expect(marker).toEqual({
      status: "completed",
      value: { recovered: 1, marker: "caller-value" },
    });
  });

  test("each recovery routine keeps its attributes and changes by exactly 0724's replacements", async () => {
    const after = await routines(RECOVERY);
    const attributes = (rows: Routine[]) => rows.map(({ definition: _, ...rest }) => rest);
    expect(attributes(after)).toEqual(attributes(before!.recovery));
    for (const [index, routine] of after.entries()) {
      expect(routine.definition).toBe(
        patched(before!.recovery[index]!.definition, RECOVERY_PATCHES),
      );
      // The marker is restored before the loop's first write.
      const restore = routine.definition.indexOf("coalesce(prior_lifecycle, ''), true);");
      expect(restore).toBeGreaterThan(0);
      for (const write of ["INSERT INTO", "UPDATE subscription_connections", "DELETE FROM"]) {
        expect(routine.definition.indexOf(write)).toBeGreaterThan(restore);
      }
    }
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

  test("each writer keeps its attributes and changes by exactly 0724's replacements", async () => {
    const after = await routines();
    const attributes = (rows: Routine[]) => rows.map(({ definition: _, ...rest }) => rest);
    expect(attributes(after)).toEqual(attributes(before!.routines));
    for (const [index, routine] of after.entries()) {
      expect(routine.definition).toBe(patched(before!.routines[index]!.definition, WRITER_PATCHES));
    }
  });
});
