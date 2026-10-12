// The forward shared-chat exception must also work when the migration owner
// is bound by FORCE RLS. Every runtime call below uses the non-owner app role.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import type { SubscriptionPersonalAuthorityV2 } from "@opengeni/contracts";
import {
  connectSubscriptionCoreCodexConnection,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  readSubscriptionCoreTurnIdentity,
  settleConnectedMachineSessionBackgroundCommand,
  submitHumanPromptInTransaction,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import {
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { subscriptionAuthorityV2ForAcceptanceInTransaction } from "../src/subscription-core-acceptance-authority";
import { chooseSubscriptionCoreSessionAccount } from "../src/subscription-core/session-choice";
import { withSubscriptionCoreAcceptedTurn } from "../src/subscription-core-placement-world";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const EMPTY: SubscriptionPersonalAuthorityV2 = { version: 2, personal: [] };
const key = Buffer.alloc(32, 73);
let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("shared-personal-choice");
  if (!database) throw new Error("real PostgreSQL fixture unavailable");
  await migrate(database.ownerUrl);
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

type Person = { subjectId: string; membershipId: string; personalWorkspaceId: string };
type Fixture = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  creator: Person;
  participant: Person;
};

async function fixture(): Promise<Fixture> {
  const admin = database!.admin;
  const userId = `shared-choice-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Shared personal choice",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const creatorSubject = `user:${userId}`;
  const [creator] = await admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text, personal_workspace_id::text from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${creatorSubject}`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Shared choice') returning id::text`;
  const workspaceId = workspace!.id;
  const participantSubject = `user:participant-${crypto.randomUUID()}`;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Participant Personal') returning id::text`;
  const [participant] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}::uuid, ${participantSubject}, 'member', 'active', ${personal!.id}::uuid) returning id::text`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspaceId}::uuid, ${creatorSubject}, 'owner'),
      (${accountId}::uuid, ${workspaceId}::uuid, ${participantSubject}, 'member')`;
  await admin`insert into workspace_inference_controls (account_id, workspace_id)
    values (${accountId}::uuid, ${workspaceId}::uuid)`;
  await admin`delete from subscription_settings where account_id = ${accountId}::uuid and workspace_id is null`;
  await admin`insert into subscription_settings (
    account_id, rotation, providers, cross_provider_failover, fallback_order,
    personal_connections_allowed, personal_fallback_allowed)
    values (${accountId}::uuid, ${admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, true)`;
  await admin`insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', true)
    on conflict (account_id, provider) do update set enabled = true`;
  const session = await withSessionRlsActorContext({ subjectId: creatorSubject }, () =>
    createSession(client!.db, {
      accountId,
      workspaceId,
      subjectId: creatorSubject,
      initialMessage: "shared choice",
      resources: [],
      metadata: {},
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility: "workspace_shared",
      createdBy: { kind: "subject", subjectId: creatorSubject },
      createdByContext: {},
    }),
  );
  return {
    accountId,
    workspaceId,
    sessionId: session.id,
    creator: {
      subjectId: creatorSubject,
      membershipId: creator!.id,
      personalWorkspaceId: creator!.personal_workspace_id,
    },
    participant: {
      subjectId: participantSubject,
      membershipId: participant!.id,
      personalWorkspaceId: personal!.id,
    },
  };
}

async function connect(f: Fixture, person: Person): Promise<string> {
  const connected = await withSessionRlsActorContext({ subjectId: person.subjectId }, () =>
    connectSubscriptionCoreCodexConnection(client!.db, {
      accountId: f.accountId,
      workspaceId: person.personalWorkspaceId,
      subjectId: person.subjectId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }),
      ),
      providerAccountId: `choice-${crypto.randomUUID()}`,
      providerSubjectId: `choice-${crypto.randomUUID()}`,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 86_400_000),
      lastRefreshAt: new Date(),
      accountEmail: null,
      label: "Own account",
    }),
  );
  if (connected.kind !== "connected") throw new Error(`connect refused: ${connected.reason}`);
  return connected.id;
}

function choose(f: Fixture, person: Person, connectionId: string | null) {
  return chooseSubscriptionCoreSessionAccount(client!.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    subjectId: person.subjectId,
    provider: "codex",
    connectionId,
  });
}

async function send(f: Fixture, person: Person, triggerEventId = crypto.randomUUID()) {
  const turn = await withSessionRlsActorContext({ subjectId: person.subjectId }, () =>
    enqueueSessionTurn(client!.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      triggerEventId,
      temporalWorkflowId: `session-${f.sessionId}`,
      source: "user",
      prompt: "Use my chosen account",
      resources: [],
      tools: [],
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: person.subjectId },
    }),
  );
  const [stored] = await database!.admin<{ authority: unknown }[]>`
    select subscription_authority as authority from session_turns where id = ${turn.id}::uuid`;
  return { turnId: turn.id, triggerEventId, authority: stored!.authority };
}

function exact(f: Fixture, person: Person, connectionId: string): SubscriptionPersonalAuthorityV2 {
  return {
    version: 2,
    personal: [
      {
        provider: "codex",
        ownerMembershipId: person.membershipId,
        authorityGeneration: 1,
        sharedSessionChoice: { sessionId: f.sessionId, connectionId },
      },
    ],
  };
}

async function accept(f: Fixture, requestSubject: string | null, acceptingSubject: string | null) {
  return withRlsContext(
    client!.db,
    { accountId: f.accountId, workspaceId: f.workspaceId },
    async (tx) => {
      if (requestSubject !== null) await setSubjectRlsContext(tx, requestSubject);
      else await tx.execute(sql`select set_config('opengeni.subject_id', '', true)`);
      const result = await subscriptionAuthorityV2ForAcceptanceInTransaction(tx, "codex", {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        acceptingSubjectId: acceptingSubject,
      });
      const [marker] = await rawRows<{ marker: string | null }>(
        tx,
        sql`select nullif(current_setting('opengeni.organization_tenancy_lifecycle', true), '') as marker`,
      );
      expect(marker!.marker).toBeNull();
      return result;
    },
  );
}

describe.skipIf(!realDb)("shared personal choice with a FORCE-RLS-bound schema owner", () => {
  test("maintenance activation rejects missing role inventory and live old/new application sessions before changes", async () => {
    await rawRows(client!.db, sql`select current_user`);
    const migration = await readFile(
      new URL("../drizzle/0736_subscription_shared_personal_choice.sql", import.meta.url),
      "utf8",
    );
    const owner = postgres(database!.ownerUrl, { max: 1, onnotice: () => undefined });
    try {
      for (const roles of ["", "[]", '["opengeni_app"]']) {
        await expect(
          owner.begin(async (tx) => {
            await tx`select set_config('opengeni.migration_application_roles', ${roles}, true)`;
            await tx.unsafe(migration);
          }),
        ).rejects.toMatchObject({ code: "55000" });
      }
    } finally {
      await owner.end();
    }
  });

  test("live workspace policy and participant removal revoke use, not the frozen entry", async () => {
    for (const change of ["workspace_policy", "participation", "resource_revocation"] as const) {
      const f = await fixture();
      const own = await connect(f, f.participant);
      expect((await choose(f, f.participant, own)).outcome).toBe("changed");
      const accepted = await send(f, f.participant);
      const identity = await readSubscriptionCoreTurnIdentity(client!.db, {
        ...f,
        turnId: accepted.turnId,
      });
      if (change === "workspace_policy") {
        await database!
          .admin`insert into subscription_settings (account_id, workspace_id, personal_connections_allowed)
          values (${f.accountId}::uuid, ${f.workspaceId}::uuid, false)`;
      } else if (change === "participation") {
        await database!
          .admin`delete from workspace_memberships where account_id = ${f.accountId}::uuid
          and workspace_id = ${f.workspaceId}::uuid and subject_id = ${f.participant.subjectId}`;
      } else {
        await database!
          .admin`update organization_user_resource_authorities set status = 'revoked', revoked_at = now()
          where account_id = ${f.accountId}::uuid and resource_id = ${own}::uuid`;
      }
      const result = await withSubscriptionCoreAcceptedTurn(client!.db, identity!, async (tx) => {
        const [row] = await rawRows<{ allowed: boolean }>(
          tx,
          sql`select opengeni_private.authorize_subscription_personal_placement_access(
            ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.sessionId}::uuid, ${accepted.turnId}::uuid,
            'codex', ${f.participant.membershipId}::uuid, 1::bigint,
            ${f.creator.subjectId}, ${f.participant.subjectId}) as allowed`,
        );
        return row!.allowed;
      });
      expect({ change, result }).toEqual({ change, result: { status: "completed", value: false } });
      const [stored] = await database!.admin<{ authority: unknown }[]>`
        select subscription_authority as authority from session_turns where id = ${accepted.turnId}::uuid`;
      expect(stored!.authority).toEqual(accepted.authority);
    }
  });

  test("replayed acceptance and background completion preserve the launch turn's exact pool", async () => {
    const f = await fixture();
    const own = await connect(f, f.participant);
    const sibling = await connect(f, f.participant);
    expect((await choose(f, f.participant, own)).outcome).toBe("changed");
    const operationKey = crypto.randomUUID();
    const submit = () =>
      withWorkspaceSubjectSessionActivityRls(
        client!.db,
        f.workspaceId,
        f.participant.subjectId,
        (tx) =>
          submitHumanPromptInTransaction(tx, {
            accountId: f.accountId,
            workspaceId: f.workspaceId,
            sessionId: f.sessionId,
            subjectId: f.participant.subjectId,
            actor: { type: "human", subjectId: f.participant.subjectId },
            operationKey,
            delivery: "send",
            text: "Start my command",
            resources: [],
            model: "codex/gpt-5.5",
            reasoningEffort: "medium",
            reasoningEffortFallback: "medium",
            source: "user",
          }),
      );
    const accepted = await submit();
    const frozen = exact(f, f.participant, own);
    const [captured] = await database!.admin<{ authority: unknown }[]>`
      select subscription_authority as authority from session_turns where id = ${accepted.turnId}::uuid`;
    expect(captured!.authority).toEqual(frozen);
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client!.db, f.workspaceId, {
      sessionId: f.sessionId,
      workflowId: `session-${f.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`claim refused: ${claimed.reason}`);
    expect(claimed.turn.id).toBe(accepted.turnId);
    const commandId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();
    const opId = `${crypto.randomUUID()}:0`;
    await database!.admin`insert into session_background_commands ${database!.admin({
      id: commandId,
      account_id: f.accountId,
      workspace_id: f.workspaceId,
      session_id: f.sessionId,
      provider: "connected_machine",
      state: "running",
      control_workspace_id: f.workspaceId,
      enrollment_id: enrollmentId,
      connection_instance_id: "shared-choice-launch",
      op_id: opId,
      launch_turn_id: accepted.turnId,
      launch_attempt_id: attemptId,
      launch_execution_generation: claimed.turn.executionGeneration,
    })}`;
    expect((await choose(f, f.participant, sibling)).outcome).toBe("changed");
    expect(await submit()).toMatchObject({ replay: true, turnId: accepted.turnId });
    const [replayed] = await database!.admin<{ authority: unknown }[]>`
      select subscription_authority as authority from session_turns where id = ${accepted.turnId}::uuid`;
    expect(replayed!.authority).toEqual(frozen);
    expect((await send(f, f.creator)).authority).toEqual(EMPTY);
    const terminal = {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      commandId,
      controlWorkspaceId: f.workspaceId,
      enrollmentId,
      connectionInstanceId: "shared-choice-launch",
      opId,
      outcome: "exited" as const,
      exitCode: 0,
      reason: "exited",
    };
    expect(
      (await settleConnectedMachineSessionBackgroundCommand(client!.db, terminal))?.command.state,
    ).toBe("exited");
    await settleConnectedMachineSessionBackgroundCommand(client!.db, terminal);
    const updates = await database!.admin<
      { subscription_authority: unknown; lineage: Record<string, unknown> }[]
    >`
      select subscription_authority, lineage from session_system_updates
      where session_id = ${f.sessionId}::uuid and source_id = ${commandId} and kind = 'background_command_result'`;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.subscription_authority).toEqual(frozen);
    expect(updates[0]!.lineage).toMatchObject({
      causalTurnId: accepted.turnId,
      causalAttemptId: attemptId,
    });
  });

  test("an old runtime cannot emit or spend the restricted format", async () => {
    const f = await fixture();
    const own = await connect(f, f.participant);
    expect((await choose(f, f.participant, own)).outcome).toBe("changed");
    await expect(
      withRlsContext(client!.db, f, async (tx) => {
        await setSubjectRlsContext(tx, f.participant.subjectId);
        await tx.execute(sql`select set_config('opengeni.shared_personal_choice_v1', '', true)`);
        return subscriptionAuthorityV2ForAcceptanceInTransaction(tx, "codex", {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: f.sessionId,
          acceptingSubjectId: f.participant.subjectId,
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    const accepted = await send(f, f.participant);
    const identity = await readSubscriptionCoreTurnIdentity(client!.db, {
      ...f,
      turnId: accepted.turnId,
    });
    const result = await withSubscriptionCoreAcceptedTurn(client!.db, identity!, async (tx) => {
      await tx.execute(sql`select set_config('opengeni.shared_personal_choice_v1', '', true)`);
      const [row] = await rawRows<{ allowed: boolean }>(
        tx,
        sql`select opengeni_private.authorize_subscription_personal_placement_access(
          ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.sessionId}::uuid, ${accepted.turnId}::uuid,
          'codex', ${f.participant.membershipId}::uuid, 1::bigint,
          ${f.creator.subjectId}, ${f.participant.subjectId}) as allowed`,
      );
      return row!.allowed;
    });
    expect(result).toEqual({ status: "completed", value: false });
  });

  test("SQL and TypeScript restrictions are strict, with no JSON null CHECK loophole", async () => {
    const f = await fixture();
    const valid = exact(f, f.participant, crypto.randomUUID());
    const entry = valid.personal[0]!;
    const malformed = [
      null,
      {},
      { sessionId: f.sessionId },
      { ...entry.sharedSessionChoice, connectionId: null },
      { ...entry.sharedSessionChoice, sessionId: "not-a-uuid" },
      { ...entry.sharedSessionChoice, allConnections: true },
    ];
    for (const snapshot of [
      valid,
      EMPTY,
      ...malformed.map((sharedSessionChoice) => ({
        version: 2,
        personal: [{ ...entry, sharedSessionChoice }],
      })),
      { version: 2, personal: [{ ...entry, authorityGeneration: null }] },
    ]) {
      const [row] = await rawRows<{ valid: boolean }>(
        client!.db,
        sql`select subscription_personal_authority_v2_valid(${JSON.stringify(snapshot)}::jsonb) as valid`,
      );
      expect(row!.valid).toBe(snapshot === valid || snapshot === EMPTY);
    }
  });

  test("restricted authority admits the account owner, never a sibling or another session", async () => {
    const f = await fixture();
    const own = await connect(f, f.participant);
    const sibling = await connect(f, f.participant);
    const turn = await send(f, f.participant);
    // Seed an exact accepted value as the schema owner to test readers
    // independently of the acceptance writer. The app cannot rewrite it.
    const owner = createDb(database!.ownerUrl, { max: 1 });
    try {
      await withRlsContext(owner.db, f, async (tx) => {
        await setSubjectRlsContext(tx, f.participant.subjectId);
        const updated = await rawRows(
          tx,
          sql`update session_turns set subscription_authority = ${JSON.stringify(exact(f, f.participant, own))}::jsonb
          where id = ${turn.turnId}::uuid returning id`,
        );
        expect(updated).toHaveLength(1);
      });
    } finally {
      await owner.close();
    }
    const identity = await readSubscriptionCoreTurnIdentity(client!.db, {
      ...f,
      turnId: turn.turnId,
    });
    expect(identity!.acceptedAuthorityV2).toEqual(exact(f, f.participant, own));
    const result = await withSubscriptionCoreAcceptedTurn(client!.db, identity!, async (tx) => {
      const [placement] = await rawRows<{ allowed: boolean }>(
        tx,
        sql`select opengeni_private.authorize_subscription_personal_placement_access(
          ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.sessionId}::uuid, ${turn.turnId}::uuid,
          'codex', ${f.participant.membershipId}::uuid, 1::bigint,
          ${f.creator.subjectId}, ${f.participant.subjectId}) as allowed`,
      );
      expect(placement!.allowed).toBe(true);
      const rows = await rawRows<{ id: string }>(
        tx,
        sql`select id::text from subscription_connections where account_id = ${f.accountId}::uuid and ownership = 'personal'`,
      );
      expect(rows.map((row) => row.id)).toEqual([own]);
      // Inference authority is not an administered Personal-workspace grant.
      const versions = await rawRows(
        tx,
        sql`select * from opengeni_private.subscription_core_personal_connection_versions(
          'codex', ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.participant.subjectId})`,
      );
      expect(versions).toEqual([]);
      for (const routine of [
        "read_subscription_core_owned_connection_credential",
        "begin_subscription_core_owned_connection_refresh",
      ] as const) {
        const administered = await rawRows(
          tx,
          sql`select * from ${sql.raw(`opengeni_private.${routine}`)}(
          'codex', ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.participant.subjectId}, ${own}::uuid)`,
        );
        expect(administered).toEqual([]);
      }
      const [quota] = await rawRows<{ recorded: boolean }>(
        tx,
        sql`select opengeni_private.record_subscription_core_owned_connection_quota(
          'codex', ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.participant.subjectId}, ${own}::uuid,
          1::bigint, 0::bigint, '{}'::jsonb, now()) as recorded`,
      );
      expect(quota!.recorded).toBe(false);
      for (const actor of [
        f.creator.subjectId,
        `api_key:${crypto.randomUUID()}`,
        "service:unrelated",
      ]) {
        await setSubjectRlsContext(tx, actor);
        const [borrowed] = await rawRows<{ allowed: boolean }>(
          tx,
          sql`select opengeni_private.authorize_subscription_personal_access(
            ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.sessionId}::uuid, ${turn.turnId}::uuid,
            ${own}::uuid, 'codex', ${f.creator.subjectId}, ${f.participant.subjectId}) as allowed`,
        );
        expect(borrowed!.allowed).toBe(false);
      }
      await setSubjectRlsContext(tx, "service:subscription-core");
      for (const [connectionId, expected] of [
        [own, true],
        [sibling, false],
      ] as const) {
        const [access] = await rawRows<{ allowed: boolean }>(
          tx,
          sql`select opengeni_private.authorize_subscription_personal_access(
            ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.sessionId}::uuid, ${turn.turnId}::uuid,
            ${connectionId}::uuid, 'codex', ${f.creator.subjectId}, ${f.participant.subjectId}) as allowed`,
        );
        expect(access!.allowed).toBe(expected);
      }
      const [foreignSession] = await rawRows<{ allowed: boolean }>(
        tx,
        sql`select opengeni_private.authorize_subscription_personal_access(
          ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${crypto.randomUUID()}::uuid, ${turn.turnId}::uuid,
          ${own}::uuid, 'codex', ${f.creator.subjectId}, ${f.participant.subjectId}) as allowed`,
      );
      expect(foreignSession!.allowed).toBe(false);
    });
    expect(result.status).toBe("completed");
    await database!.admin`update subscription_connections set status = 'error',
      health_retry_at = now() - interval '1 second' where id in (${own}::uuid, ${sibling}::uuid)`;
    const recovered = await withSubscriptionCoreAcceptedTurn(client!.db, identity!, async (tx) => {
      const [row] = await rawRows<{ recovered: number; marker: string | null }>(
        tx,
        sql`select opengeni_private.recover_subscription_core_connection_health(
          'codex', ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.sessionId}::uuid, ${turn.turnId}::uuid) as recovered`,
      );
      const [marker] = await rawRows<{ marker: string | null }>(
        tx,
        sql`select nullif(current_setting('opengeni.organization_tenancy_lifecycle', true), '') as marker`,
      );
      expect(marker!.marker).toBeNull();
      return row!.recovered;
    });
    expect(recovered).toEqual({ status: "completed", value: 1 });
    const states = await database!.admin<{ id: string; status: string }[]>`
      select id::text, status from subscription_connections where id in (${own}::uuid, ${sibling}::uuid)`;
    expect(Object.fromEntries(states.map((row) => [row.id, row.status]))).toEqual({
      [own]: "active",
      [sibling]: "error",
    });
    await expect(
      withRlsContext(client!.db, f, async (tx) => {
        await setSubjectRlsContext(tx, f.participant.subjectId);
        await tx.execute(sql`update session_turns set subscription_authority = ${JSON.stringify(EMPTY)}::jsonb
        where id = ${turn.turnId}::uuid`);
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  test("both database identities lack superuser and RLS bypass, and runtime is not the table owner", async () => {
    const roles = await database!.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname in (${database!.ownerRole}, 'opengeni_app')`;
    expect(roles).toHaveLength(2);
    for (const role of roles) expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [runtime] = await rawRows<{ role: string; owner: string }>(
      client!.db,
      sql`select current_user::text as role, pg_get_userbyid(relowner)::text as owner
        from pg_class where oid = 'subscription_connections'::regclass`,
    );
    expect(runtime!.role).toBe("opengeni_app");
    expect(runtime!.owner).toBe(database!.ownerRole);
  });

  test("a participating noncreator can choose only their own account, frozen on their next send", async () => {
    const f = await fixture();
    const own = await connect(f, f.participant);
    const other = await connect(f, f.creator);
    const before = await send(f, f.participant);
    expect(before.authority).toEqual(EMPTY);
    expect((await choose(f, f.participant, other)).outcome).toBe("not_found");
    expect(await choose(f, f.participant, own)).toMatchObject({
      outcome: "changed",
      appliedTo: "next_turn",
    });
    expect((await send(f, f.participant)).authority).toEqual(exact(f, f.participant, own));
    expect((await send(f, f.creator)).authority).toEqual(EMPTY);
    const [prior] = await database!.admin<{ authority: unknown }[]>`
      select subscription_authority as authority from session_turns where id = ${before.turnId}::uuid`;
    expect(prior!.authority).toEqual(EMPTY);
  });

  test("the chat creator also needs an explicit choice; request identity cannot be borrowed", async () => {
    const f = await fixture();
    const own = await connect(f, f.creator);
    expect((await send(f, f.creator)).authority).toEqual(EMPTY);
    expect((await choose(f, f.creator, own)).outcome).toBe("changed");
    expect(await accept(f, f.creator.subjectId, f.creator.subjectId)).toEqual(
      exact(f, f.creator, own),
    );
    for (const requestSubject of [
      null,
      "service:subscription-core",
      `api_key:${crypto.randomUUID()}`,
      f.participant.subjectId,
    ]) {
      expect(await accept(f, requestSubject, f.creator.subjectId)).toEqual(EMPTY);
    }
    expect(await accept(f, f.creator.subjectId, null)).toEqual(EMPTY);
    expect((await choose(f, f.creator, null)).outcome).toBe("changed");
    expect((await send(f, f.creator)).authority).toEqual(EMPTY);
  });

  test("live effective organization policy still refuses a previously selected shared personal account", async () => {
    const f = await fixture();
    const own = await connect(f, f.participant);
    expect((await choose(f, f.participant, own)).outcome).toBe("changed");
    const frozen = await send(f, f.participant);
    expect(frozen.authority).toEqual(exact(f, f.participant, own));
    await database!.admin`update subscription_settings set personal_connections_allowed = false
      where account_id = ${f.accountId}::uuid and workspace_id is null`;
    expect((await send(f, f.participant)).authority).toEqual(EMPTY);
    const [stored] = await database!.admin<{ authority: unknown }[]>`
      select subscription_authority as authority from session_turns where id = ${frozen.turnId}::uuid`;
    expect(stored!.authority).toEqual(frozen.authority);
  });
});
