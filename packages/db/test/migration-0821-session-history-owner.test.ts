import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate, executeMigrationFile } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  claimSessionWorkForAttempt,
  mutateSessionControlInTransaction,
  withWorkspaceSessionActivityRls,
  appendSessionEventsForTurnAttempt,
} from "../src";
import { splitStatements } from "../../../scripts/migration-rls-backfills";
import {
  SESSION_HISTORY_REPAIR,
  SESSION_HISTORY_REPAIR_SOURCE,
  SESSION_HISTORY_CAPABILITY,
  sessionHistoryPolicySql,
} from "../src/migration-session-history-backfills";

const hintFile = "0809_session_open_settlement_index.sql";
const usageFile = "0811_session_events_usage_source_key_backfill.sql";
const hintSource = await readFile(new URL(`../drizzle/${hintFile}`, import.meta.url), "utf8");
const usageSource = await readFile(new URL(`../drizzle/${usageFile}`, import.meta.url), "utf8");
const tables = [
  "session_attempt_interruptions",
  "session_turn_attempts",
  "session_events",
  "session_turns",
  "sessions",
];
let owned: OwnerMigratedTestDatabase;
let owner: postgres.Sql;
let app: postgres.Sql;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("migration-0821-session-history-owner");
  if (!acquired) throw new Error("Real PostgreSQL required");
  owned = acquired;
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appRole: "opengeni_app",
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  owner = postgres(owned.ownerUrl, { max: 1 });
  const appUrl = new URL(owned.adminUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  app = postgres(appUrl.toString(), { max: 1 });
  client = createDb(owned.adminUrl);
}, 180_000);
afterAll(async () => {
  await app?.end();
  await client?.close();
  await owner?.end();
  await owned?.release();
}, 60_000);

async function seedHistorical(count = 1, quiesced = true, interrupt = true) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "backfill-proof",
    accountExternalId: suffix,
    accountName: "Backfill proof",
    workspaceExternalSource: "backfill-proof",
    workspaceExternalId: suffix,
    workspaceName: "Backfill proof",
    subjectId: `subject:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    ...grant,
    initialMessage: "Backfill proof",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    ...grant,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claim.action).toBe("claimed");
  if (interrupt)
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (tx) =>
      mutateSessionControlInTransaction(tx, {
        ...grant,
        sessionId: session.id,
        actor: { type: "human", subjectId: grant.subjectId },
        action: "pause",
        operationKey: crypto.randomUUID(),
      }),
    );
  if (quiesced)
    await owned.admin`update session_turn_attempts set quiesced_at=now() where id=${attemptId}`;
  await owned.admin`update session_attempt_interruptions set attempt_quiesced=false where attempt_id=${attemptId}`;
  const [attempt] =
    await owned.admin`select turn_id,execution_generation from session_turn_attempts where id=${attemptId}`;
  await owned.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id',${grant.accountId},true), set_config('opengeni.workspace_id',${grant.workspaceId},true),
      set_config('opengeni.subject_id',${grant.subjectId},true), set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
    const [cursor] =
      await tx`select last_sequence from session_event_cursors where session_id=${session.id} for update`;
    await tx`insert into session_events(account_id,workspace_id,session_id,turn_id,sequence,type,payload,turn_generation,turn_attempt_id,turn_association)
      select ${grant.accountId},${grant.workspaceId},${session.id},${attempt!.turn_id},${cursor!.last_sequence}::bigint+n,
        'agent.model.usage',jsonb_build_object('sourceKey','proof-'||n),${attempt!.execution_generation},${attemptId},'current' from generate_series(1,${count}) as n`;
  });
  await owned.admin`update session_events set usage_source_key=null where session_id=${session.id} and type='agent.model.usage'`;
  const snapshot = async () => {
    const [hint] =
      await owned.admin`select attempt_quiesced from session_attempt_interruptions where attempt_id=${attemptId}`;
    const [usage] = await owned.admin`select count(*)::int as repaired from session_events
      where session_id=${session.id} and usage_source_key=payload->>'sourceKey'`;
    return { hint: hint?.attempt_quiesced ?? false, repaired: usage!.repaired };
  };
  return {
    grant,
    session,
    attemptId,
    turnId: attempt!.turn_id as string,
    generation: attempt!.execution_generation as number,
    snapshot,
  };
}

async function expectCleanPosture() {
  const flags =
    await owned.admin`select relforcerowsecurity from pg_class where relname=any(${tables}) and relnamespace='public'::regnamespace`;
  expect(flags).toHaveLength(5);
  expect(flags.every((row) => row.relforcerowsecurity)).toBe(true);
  expect(
    await owned.admin`select polname from pg_policy where polname like '%_history_owner_backfill'`,
  ).toHaveLength(0);
  const [marker] =
    await owner`select nullif(current_setting(${SESSION_HISTORY_CAPABILITY},true),'') as value`;
  expect(marker!.value).toBeNull();
}

test("historical no-ops are repaired by the forward stage without changing restrictive policies", async () => {
  const [role] = await owner`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  const seed = await seedHistorical();
  const unchanged = await seedHistorical(1, false);
  const finished = await seedHistorical();
  await owned.admin`update session_turns set finished_at=now() where id=${finished.turnId}`;
  const emptyKey = await seedHistorical();
  await owned.admin`update session_events set payload='{"sourceKey":""}'::jsonb
    where session_id=${emptyKey.session.id} and type='agent.model.usage'`;
  const restrictive = () =>
    owned.admin`select polrelid,polname,polqual::text,polwithcheck::text from pg_policy where not polpermissive order by polrelid,polname`;
  const beforePolicies = await restrictive();
  const hintUpdate = splitStatements(hintSource).find((statement) =>
    /^UPDATE session_attempt_interruptions/m.test(statement),
  )!;
  await owner.unsafe(hintUpdate);
  await owner.begin(async (tx) => {
    await tx`select set_config('opengeni.session_variable_set_attachments_v1','1',true), set_config('opengeni.sandbox_recovery_protocol_v2','1',true)`;
    await tx.unsafe(usageSource);
  });
  expect(await seed.snapshot()).toEqual({ hint: false, repaired: 0 });
  await executeMigrationFile(owner, SESSION_HISTORY_REPAIR, SESSION_HISTORY_REPAIR_SOURCE);
  expect(await seed.snapshot()).toEqual({ hint: true, repaired: 1 });
  expect(await unchanged.snapshot()).toEqual({ hint: false, repaired: 1 });
  expect(await finished.snapshot()).toEqual({ hint: true, repaired: 0 });
  expect(await emptyKey.snapshot()).toEqual({ hint: true, repaired: 0 });
  expect(await restrictive()).toEqual(beforePolicies);
  await expectCleanPosture();
  await executeMigrationFile(owner, SESSION_HISTORY_REPAIR, SESSION_HISTORY_REPAIR_SOURCE);
  expect(await seed.snapshot()).toEqual({ hint: true, repaired: 1 });
  await expectCleanPosture();
}, 180_000);

test("fresh 0809 execution repairs seeded old rows and restores its two-table transaction window", async () => {
  const seed = await seedHistorical();
  await expect(
    owner.begin(async (tx) => {
      // Recreate the pre-0809 schema only in this rolled-back fixture transaction.
      await tx`drop function session_attempt_interruption_fill_quiescence_hint() cascade`;
      await tx`drop function session_turn_attempt_propagate_quiescence_hint() cascade`;
      await tx`alter table session_attempt_interruptions drop column attempt_quiesced`;
      await executeMigrationFile(tx as unknown as postgres.Sql, hintFile, hintSource);
      // Ground truth through NO FORCE is unnecessary: query as the owner with
      // the ordinary tenant scope for this shared-session fixture.
      await tx`select set_config('opengeni.account_id',${seed.grant.accountId},true), set_config('opengeni.workspace_id',${seed.grant.workspaceId},true)`;
      const [row] =
        await tx`select attempt_quiesced from session_attempt_interruptions where attempt_id=${seed.attemptId}`;
      expect(row!.attempt_quiesced).toBe(true);
      const [trigger] =
        await tx`select tgenabled from pg_trigger where tgrelid='session_attempt_interruptions'::regclass and tgname='session_tenancy_workspace_fence'`;
      expect(trigger!.tgenabled).toBe("O");
      const flags =
        await tx`select relforcerowsecurity from pg_class where oid in ('session_attempt_interruptions'::regclass,'session_turn_attempts'::regclass)`;
      expect(flags.every((flag) => flag.relforcerowsecurity)).toBe(true);
      throw new Error("rollback fixture");
    }),
  ).rejects.toThrow("rollback fixture");
  expect(await seed.snapshot()).toEqual({ hint: false, repaired: 0 });
}, 180_000);

test("0811 commits at most 1000 fenced updates per transaction and retries a failed tail exactly", async () => {
  await executeMigrationFile(owner, SESSION_HISTORY_REPAIR, SESSION_HISTORY_REPAIR_SOURCE);
  const seed = await seedHistorical(1001);
  const [last] =
    await owned.admin`select id from session_events where session_id=${seed.session.id} and type='agent.model.usage' order by id desc limit 1`;
  await owner`create table backfill_batch_audit(id uuid, transaction_id bigint, exclusive_lock boolean)`;
  await owner.unsafe(`create function backfill_batch_audit_trigger() returns trigger language plpgsql as $$ begin
    insert into backfill_batch_audit values(new.id,txid_current(),exists(select 1 from pg_locks
      where pid=pg_backend_pid() and mode='AccessExclusiveLock' and relation in ('session_events'::regclass,'session_turns'::regclass,'sessions'::regclass)));
    if new.id='${last!.id}'::uuid then raise exception 'injected tail failure'; end if;
    return new;
  end $$;
  create trigger backfill_batch_audit after update of usage_source_key on session_events
  for each row when (old.usage_source_key is null and new.usage_source_key is not null) execute function backfill_batch_audit_trigger();`);
  try {
    await expect(executeMigrationFile(owner, usageFile, usageSource)).rejects.toThrow(
      "injected tail failure",
    );
    expect((await seed.snapshot()).repaired).toBe(1000);
    const [first] =
      await owner`select count(*)::int as rows,count(distinct transaction_id)::int as batches,bool_or(exclusive_lock) as exclusive from backfill_batch_audit`;
    expect(first).toEqual({ rows: 1000, batches: 1, exclusive: false });
    await expectCleanPosture();
    await owner`drop trigger backfill_batch_audit on session_events`;
    await executeMigrationFile(owner, usageFile, usageSource);
    expect((await seed.snapshot()).repaired).toBe(1001);
    await executeMigrationFile(owner, usageFile, usageSource);
    expect((await seed.snapshot()).repaired).toBe(1001);
    await expectCleanPosture();
  } finally {
    await owner`drop function backfill_batch_audit_trigger() cascade`;
    await owner`drop table backfill_batch_audit`;
  }
}, 180_000);

test("forged migration markers do not expose rows to the restricted app role", async () => {
  await seedHistorical();
  await owner.unsafe(sessionHistoryPolicySql("install", tables));
  try {
    await app.begin(async (tx) => {
      await tx`select set_config(${SESSION_HISTORY_CAPABILITY},'1',true), set_config('opengeni.session_variable_set_attachments_v1','1',true), set_config('opengeni.sandbox_recovery_protocol_v2','1',true)`;
      for (const table of tables)
        expect(await tx.unsafe(`select id from ${table}`)).toHaveLength(0);
      expect(
        await tx`update session_events set usage_source_key='forged' returning id`,
      ).toHaveLength(0);
    });
  } finally {
    await owner.unsafe(sessionHistoryPolicySql("remove", tables));
  }
  await expectCleanPosture();
}, 180_000);

test("repaired historical usage keys recover canonical append replay identity", async () => {
  const seed = await seedHistorical(1, false, false);
  const [canonical] =
    await owned.admin`select id from session_events where session_id=${seed.session.id} and type='agent.model.usage'`;
  await executeMigrationFile(owner, usageFile, usageSource);
  const replay = await appendSessionEventsForTurnAttempt(
    client.db,
    seed.grant.workspaceId,
    seed.session.id,
    seed.turnId,
    seed.generation,
    seed.attemptId,
    [{ type: "agent.model.usage", payload: { sourceKey: "proof-1" } }],
  );
  expect(replay.accepted).toBe(true);
  expect(replay.events).toHaveLength(1);
  expect(replay.events[0]).toMatchObject({
    turnAssociation: "duplicate",
    duplicateOfEventId: canonical!.id,
    duplicateReason: "duplicate_provider_response_usage",
  });
  await expectCleanPosture();
}, 180_000);
