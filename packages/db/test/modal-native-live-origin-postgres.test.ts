import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  transitionSessionVisibility,
  withSessionRlsActorContext,
  lockLiveNativeOriginalOriginTx,
  type ModalNativeLiveOriginScope,
  type DbClient,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  submitHumanPromptInTransaction,
} from "../src";
import { rawRows, withRlsContext, type Database } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { nestedPostgresSqlState } from "../src/persistence-errors";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import {
  inspectRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
} from "../src/runtime-posture";

let fixture: OwnerMigratedTestDatabase;
let client: DbClient;
const appRole = `native_origin_${crypto.randomUUID().replaceAll("-", "")}`;
const appPassword = crypto.randomUUID();

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("native-live-origin");
  if (!acquired) throw new Error("Real local PostgreSQL required; no skipped native origin proof");
  fixture = acquired;
  await migrate(fixture.ownerUrl, undefined, { applicationDatabaseRoles: [appRole] });
  await provisionRoles(fixture.adminUrl, { appRole, appPassword, temporalDatabases: [] });
  const url = new URL(fixture.adminUrl);
  url.username = appRole;
  url.password = appPassword;
  client = createDb(url.toString(), { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  if (fixture) {
    await fixture.admin.unsafe(`DROP OWNED BY "${appRole}"`);
    await fixture.admin.unsafe(`DROP ROLE "${appRole}"`);
    await fixture.release();
  }
}, 180_000);

async function seed(
  options: {
    count?: unknown;
    private?: boolean;
    personal?: boolean;
    human?: string | null;
    causalService?: boolean;
  } = {},
) {
  const userId = `native-${crypto.randomUUID()}`;
  const human = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Native origin fixture",
  });
  const grant = { ...access.workspaceGrants[0]! };
  if (options.personal) {
    const [member] = await fixture.admin`select personal_workspace_id from organization_memberships
      where account_id=${grant.accountId} and subject_id=${human}`;
    grant.workspaceId = member!.personal_workspace_id;
  }
  await fixture.admin`insert into session_tenancy_activations
    (account_id,activation_version,inventory_digest,parity_digest,activated_by)
    values (${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'native-origin-fixture')
    on conflict (account_id) do nothing`;
  const session = await withSessionRlsActorContext({ subjectId: human }, () =>
    createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "native preparation",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: human },
      createdByContext: {},
    }),
  );
  const [stored] =
    await fixture.admin`select visibility,authority_epoch,active_epoch,sandbox_group_id
    from sessions where id=${session.id}`;
  if (options.private !== false && stored!.visibility !== "user_private") {
    const settings = await getOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: human,
    });
    if (!settings.enabled)
      await updateOrganizationPrivateSessionSettings(client.db, {
        organizationId: grant.accountId,
        actorSubjectId: human,
        enabled: true,
        expectedVersion: settings.version,
        operationId: crypto.randomUUID(),
      });
    await transitionSessionVisibility(client.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      actorSubjectId: human,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: stored!.authority_epoch,
      operationKey: crypto.randomUUID(),
    });
  }
  const scope: ModalNativeLiveOriginScope = {
    version: 2,
    declarationId: crypto.randomUUID(),
    planId: crypto.randomUUID(),
    creatorId: crypto.randomUUID(),
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    triggerEventId: crypto.randomUUID(),
    sandboxGroupId: stored!.sandbox_group_id,
    routeKind: "home",
    routeTargetId: null,
    routeEpoch: stored!.active_epoch,
  };
  const metadata =
    options.count === undefined
      ? { unrelated: "retained" }
      : { unrelated: "retained", providerRecoveryCount: options.count };
  await fixture.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.session_inference_claim','1',true),
      set_config('opengeni.account_id',${scope.accountId},true),
      set_config('opengeni.workspace_id',${scope.workspaceId},true),
      set_config('opengeni.subject_id',${human},true),
      set_config('opengeni.initiating_human_subject_id',${human},true),
      set_config('opengeni.session_variable_set_attachments_v1','1',true),
      set_config('opengeni.lossless_content_writer','1',true),
      set_config('opengeni.sandbox_recovery_protocol_v2','1',true),
      set_config('opengeni.pending_tool_event_output_v1','1',true)`;
    await tx`select acquire_session_tenancy_fence(${scope.workspaceId}::uuid)`;
    await tx`insert into session_turns (id,account_id,workspace_id,session_id,trigger_event_id,
      temporal_workflow_id,status,source,position,prompt,model,reasoning_effort,sandbox_backend,
      execution_generation,initiator_kind,initiator_subject_id,initiator_context,initiating_human_subject_id,metadata)
      values (${scope.turnId},${scope.accountId},${scope.workspaceId},${scope.sessionId},${scope.triggerEventId},
      ${`workflow-${scope.sessionId}`},'running','user',1,'native fixture','test-model','medium','none',1,
      ${options.causalService ? "service" : "subject"},${options.causalService ? "service:test" : human},'{}',
      ${"human" in options ? options.human! : human},${tx.json(metadata as postgres.JSONValue)})`;
    await tx`update sessions set active_turn_id=${scope.turnId},status='running' where id=${scope.sessionId}`;
    await tx`update session_turns set active_attempt_id=${scope.attemptId} where id=${scope.turnId}`;
    await tx`insert into session_turn_attempts (id,account_id,workspace_id,session_id,turn_id,execution_generation,
      state,temporal_workflow_id,temporal_workflow_run_id,temporal_activity_id,verified_control_revision,mcp_approval_policies)
      values (${scope.attemptId},${scope.accountId},${scope.workspaceId},${scope.sessionId},${scope.turnId},1,'running',
      ${`workflow-${scope.sessionId}`},${`run-${scope.attemptId}`},${`activity-${scope.attemptId}`},0,'{}')`;
  });
  return { scope, human, metadata };
}

async function scoped<T>(scope: ModalNativeLiveOriginScope, action: (tx: Database) => Promise<T>) {
  return withSessionRlsActorContext({ subjectId: "service:native-proof-test" }, () =>
    withRlsContext(
      client.db,
      { accountId: scope.accountId, workspaceId: scope.workspaceId },
      action,
      undefined,
      "none",
    ),
  );
}
async function project(scope: ModalNativeLiveOriginScope) {
  return scoped(scope, (tx) => lockLiveNativeOriginalOriginTx(tx, scope));
}
async function sqlState(action: () => Promise<unknown>, expected: string) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(expected);
}
async function truth(scope: ModalNativeLiveOriginScope) {
  const [row] =
    await fixture.admin`select metadata,active_attempt_id,execution_generation from session_turns where id=${scope.turnId}`;
  return row;
}

async function adminMutation(
  f: Awaited<ReturnType<typeof seed>>,
  action: (tx: postgres.TransactionSql) => Promise<unknown>,
) {
  return fixture.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id',${f.scope.accountId},true),
      set_config('opengeni.workspace_id',${f.scope.workspaceId},true),
      set_config('opengeni.subject_id',${f.human},true),
      set_config('opengeni.initiating_human_subject_id',${f.human},true),
      set_config('opengeni.session_variable_set_attachments_v1','1',true),
      set_config('opengeni.lossless_content_writer','1',true),
      set_config('opengeni.sandbox_recovery_protocol_v2','1',true),
      set_config('opengeni.pending_tool_event_output_v1','1',true)`;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${f.scope.accountId}`},0))`;
    await tx`select acquire_session_tenancy_fence(${f.scope.workspaceId}::uuid)`;
    return action(tx);
  });
}

async function control(f: Awaited<ReturnType<typeof seed>>, action: "pause" | "cancel") {
  return withSessionRlsActorContext({ subjectId: f.human }, () =>
    withWorkspaceSessionActivityRls(client.db, f.scope.workspaceId, (tx) =>
      mutateSessionControlInTransaction(tx, {
        accountId: f.scope.accountId,
        workspaceId: f.scope.workspaceId,
        sessionId: f.scope.sessionId,
        actor: { type: "human", subjectId: f.human },
        operationKey: crypto.randomUUID(),
        action,
      }),
    ),
  );
}

async function steer(f: Awaited<ReturnType<typeof seed>>) {
  return withWorkspaceSubjectSessionActivityRls(client.db, f.scope.workspaceId, f.human, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: f.scope.accountId,
      workspaceId: f.scope.workspaceId,
      sessionId: f.scope.sessionId,
      subjectId: f.human,
      actor: { type: "human", subjectId: f.human },
      operationKey: crypto.randomUUID(),
      delivery: "steer",
      text: "new direction",
      resources: [],
      reasoningEffortFallback: "low",
      source: "user",
    }),
  );
}

async function waitForBlockedWriter(blockerPid: number) {
  for (let index = 0; index < 200; index++) {
    const [row] = await fixture.admin`select exists(select 1 from pg_stat_activity
      where datname=current_database() and ${blockerPid}=any(pg_blocking_pids(pid))) as blocked`;
    if (row!.blocked) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected real competing writer to block on the projection transaction");
}

describe("inert LIVE native origin projection under restricted FORCE RLS", () => {
  for (const count of [undefined, 0, 1, 2, 3, 4, 5] as const)
    test(`private source-derived human; count ${count ?? "missing"} unchanged`, async () => {
      const f = await seed({ count });
      const before = await truth(f.scope);
      await scoped(f.scope, async (tx) => {
        const beforeGuc = await rawRows(
          tx,
          sql`select current_setting('opengeni.subject_id',true) as subject,
        current_setting('opengeni.initiating_human_subject_id',true) as human,
        current_setting('opengeni.account_id',true) as account, current_setting('opengeni.workspace_id',true) as workspace`,
        );
        expect(
          await rawRows(tx, sql`select id from sessions where id=${f.scope.sessionId}::uuid`),
        ).toHaveLength(0);
        const result = await lockLiveNativeOriginalOriginTx(tx, f.scope);
        expect(result.kind).toBe("live");
        if (result.kind !== "live") throw new Error(JSON.stringify(result));
        expect(result.projection.scope).toEqual(f.scope);
        expect(result.projection.initiator.initiatingHumanSubjectId).toBe(f.human);
        expect(result.projection.providerRecoveryCount).toBe(count ?? 0);
        expect(result.projection.execution.activityId).toBe(`activity-${f.scope.attemptId}`);
        expect(
          await rawRows(tx, sql`select id from sessions where id=${f.scope.sessionId}::uuid`),
        ).toHaveLength(0);
        expect(
          await rawRows(
            tx,
            sql`select current_setting('opengeni.subject_id',true) as subject,
        current_setting('opengeni.initiating_human_subject_id',true) as human,
        current_setting('opengeni.account_id',true) as account, current_setting('opengeni.workspace_id',true) as workspace`,
          ),
        ).toEqual(beforeGuc);
      });
      expect(await truth(f.scope)).toEqual(before);
      expect(
        (
          await fixture.admin`select count(*)::int as n from opengeni_private.modal_native_origin_read_capabilities`
        )[0]!.n,
      ).toBe(0);
    });

  test("strict malformed count refusal, including raw SQL; no mutation", async () => {
    for (const count of [null, "0", "5", 0.5, -1, 6, {}, []]) {
      const f = await seed({ count });
      const before = await truth(f.scope);
      expect(await project(f.scope)).toEqual({ kind: "fenced" });
      expect(
        await scoped(
          f.scope,
          async (tx) =>
            (
              await rawRows(
                tx,
                sql`select lock_live_native_original_origin_v2(${JSON.stringify(f.scope)}::jsonb) as result`,
              )
            )[0],
        ),
      ).toEqual({ result: { kind: "fenced" } });
      expect(await truth(f.scope)).toEqual(before);
    }
  });

  test("cross-scope, trigger, generation, group and home-route mismatches", async () => {
    const f = await seed();
    for (const key of [
      "accountId",
      "workspaceId",
      "sessionId",
      "turnId",
      "attemptId",
      "triggerEventId",
      "sandboxGroupId",
    ] as const) {
      const wrong = { ...f.scope, [key]: crypto.randomUUID() };
      expect(await scoped(f.scope, (tx) => lockLiveNativeOriginalOriginTx(tx, wrong))).toEqual({
        kind: "fenced",
      });
    }
    for (const wrong of [
      { ...f.scope, executionGeneration: 2 },
      { ...f.scope, routeEpoch: 1 },
    ])
      expect(await project(wrong)).toEqual({ kind: "fenced" });
    expect(await project({ ...f.scope, extra: true } as ModalNativeLiveOriginScope)).toEqual({
      kind: "unsupported",
      reason: "invalid_scope",
    });
    expect(
      await project({
        ...f.scope,
        routeTargetId: crypto.randomUUID(),
      } as unknown as ModalNativeLiveOriginScope),
    ).toEqual({ kind: "unsupported", reason: "invalid_scope" });
  });

  test("no inferred human; service provenance can retain the genuine human", async () => {
    const absent = await seed({ human: null });
    expect(await project(absent.scope)).toEqual({
      kind: "unsupported",
      reason: "human_unavailable",
    });
    const service = await seed({ causalService: true });
    const live = await project(service.scope);
    expect(live.kind).toBe("live");
    if (live.kind === "live")
      expect(live.projection.initiator).toEqual({
        kind: "service",
        subjectId: "service:test",
        initiatingHumanSubjectId: service.human,
      });
  });

  test("raw SQL independently rejects malformed correlation fields", async () => {
    const f = await seed();
    for (const value of [
      null,
      [],
      {},
      { ...f.scope, version: "2" },
      { ...f.scope, routeEpoch: null },
      { ...f.scope, executionGeneration: "1" },
      { ...f.scope, executionGeneration: 1.5 },
      { ...f.scope, creatorId: f.scope.attemptId },
      { ...f.scope, authority: true },
      { ...f.scope, accountId: f.scope.accountId.toUpperCase() },
    ]) {
      const [row] = await scoped(f.scope, (tx) =>
        rawRows(
          tx,
          sql`select lock_live_native_original_origin_v2(${JSON.stringify(value)}::jsonb) as result`,
        ),
      );
      expect(row).toEqual({ result: { kind: "unsupported", reason: "invalid_scope" } });
    }
  });

  test("legacy, external-linked and missing initiating humans are never reconstructed", async () => {
    for (const kind of ["legacy", "external", "missing"] as const) {
      const f = await seed();
      // Local historical-fixture setup only: these immutable accepted fields
      // cannot be retrofitted by a runtime caller. Installed guards stay intact.
      await fixture.admin.begin(async (tx) => {
        await tx`set local session_replication_role='replica'`;
        if (kind === "legacy")
          await tx`update session_turns set initiator_subject_id='unattributed-legacy' where id=${f.scope.turnId}`;
        if (kind === "missing")
          await tx`update session_turns set initiating_human_subject_id='user:missing-fixture' where id=${f.scope.turnId}`;
        if (kind === "external")
          await tx`insert into external_link_turn_authorities
          (turn_id,account_id,workspace_id,session_id,link_id,link_revision,canonical_snapshot,source_kind)
          values (${f.scope.turnId},${f.scope.accountId},${f.scope.workspaceId},${f.scope.sessionId},${crypto.randomUUID()},1,'{}','direct')`;
      });
      expect(await project(f.scope)).toEqual(
        kind === "missing"
          ? { kind: "fenced" }
          : {
              kind: "unsupported",
              reason: kind === "legacy" ? "human_unavailable" : "external_authority",
            },
      );
    }
  });

  test("capability table and direct membership reads remain unavailable; fake GUC is not a capability", async () => {
    const f = await seed();
    for (const statement of [
      "select * from opengeni_private.modal_native_origin_read_capabilities",
      "delete from opengeni_private.modal_native_origin_read_capabilities",
      "select * from organization_memberships",
    ])
      await sqlState(() => scoped(f.scope, (tx) => tx.execute(sql.raw(statement))), "42501");
    await scoped(f.scope, async (tx) => {
      await tx.execute(sql`select set_config('opengeni.native_host_authenticated','true',true)`);
      expect(
        await rawRows(tx, sql`select id from sessions where id=${f.scope.sessionId}::uuid`),
      ).toHaveLength(0);
    });
    const [catalog] = await fixture.admin`select c.relrowsecurity,c.relforcerowsecurity,
      pg_get_userbyid(c.relowner) as owner from pg_class c where c.oid='opengeni_private.modal_native_origin_read_capabilities'::regclass`;
    expect(catalog).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      owner: fixture.ownerRole,
    });
    const [role] =
      await fixture.admin`select rolsuper,rolbypassrls from pg_roles where rolname=${appRole}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const routines = await fixture.admin`select p.proname,p.prosecdef,p.proconfig,
      pg_get_userbyid(p.proowner) as owner,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('lock_live_native_original_origin_v2','modal_native_origin_member_read_active')`;
    expect(routines).toHaveLength(2);
    for (const routine of routines) {
      expect(routine.owner).toBe(fixture.ownerRole);
      expect(routine.prosecdef).toBe(true);
      expect(routine.public_execute).toBe(false);
      expect(routine.proconfig).toEqual([
        routine.proname === "lock_live_native_original_origin_v2"
          ? "search_path=pg_catalog, public, pg_temp"
          : "search_path=pg_catalog",
      ]);
    }
  });

  test("rollback and root-handle rejection leave no capability or origin mutation", async () => {
    const f = await seed();
    const before = await truth(f.scope);
    await expect(lockLiveNativeOriginalOriginTx(client.db, f.scope)).rejects.toThrow(
      "existing transaction",
    );
    await expect(
      scoped(f.scope, async (tx) => {
        expect((await lockLiveNativeOriginalOriginTx(tx, f.scope)).kind).toBe("live");
        throw new Error("fixture rollback");
      }),
    ).rejects.toThrow("fixture rollback");
    expect(await truth(f.scope)).toEqual(before);
    expect(
      (
        await fixture.admin`select count(*)::int as n from opengeni_private.modal_native_origin_read_capabilities`
      )[0]!.n,
    ).toBe(0);
  });

  test("bounded membership lock contention propagates 55P03, never live/fenced success", async () => {
    const f = await seed();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = fixture.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${f.scope.accountId}`},0))`;
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      await sqlState(
        () =>
          scoped(f.scope, async (tx) => {
            await tx.execute(sql`set local lock_timeout='100ms'`);
            return lockLiveNativeOriginalOriginTx(tx, f.scope);
          }),
        "55P03",
      );
    } finally {
      release.resolve();
      await blocker;
    }
    expect((await project(f.scope)).kind).toBe("live");
  });

  test("Personal pointer needs no workspace-membership row; shared membership remains exact", async () => {
    const f = await seed({ private: false });
    const [member] =
      await fixture.admin`select id,personal_workspace_id from organization_memberships
      where account_id=${f.scope.accountId} and subject_id=${f.human}`;
    const initial = await project(f.scope);
    expect(initial.kind).toBe("live");
    if (initial.kind === "live") expect(initial.projection.membership.id).toBe(member!.id);
    await adminMutation(f, async (tx) => {
      await tx`delete from workspace_memberships where workspace_id=${f.scope.workspaceId} and subject_id=${f.human}`;
    });
    const result = await project(f.scope);
    if (member!.personal_workspace_id === f.scope.workspaceId) {
      expect(result.kind).toBe("live");
      if (result.kind === "live")
        expect(result.projection.membership.basis).toBe("personal_workspace");
    } else expect(result).toEqual({ kind: "fenced" });
    const personal = await seed({ personal: true });
    expect(
      await fixture.admin`select 1 from workspace_memberships where workspace_id=${personal.scope.workspaceId}
      and subject_id=${personal.human}`,
    ).toHaveLength(0);
    const personalResult = await project(personal.scope);
    expect(personalResult.kind).toBe("live");
    if (personalResult.kind === "live")
      expect(personalResult.projection.membership.basis).toBe("personal_workspace");
  });

  test("membership suspension and revocation never become absent-human fallback", async () => {
    for (const status of ["provisioning", "suspended", "revoked"]) {
      const f = await seed();
      await adminMutation(
        f,
        (tx) => tx`update organization_memberships set status=${status},
        revoked_at=${status === "revoked" ? new Date() : null},authorization_revision=authorization_revision+1
        where account_id=${f.scope.accountId} and subject_id=${f.human}`,
      );
      expect(await project(f.scope)).toEqual({ kind: "fenced" });
    }
  });

  test("benign private-to-shared authority window passes; accepted epoch below floor fences", async () => {
    const f = await seed();
    const original = await project(f.scope);
    expect(original.kind).toBe("live");
    if (original.kind !== "live") throw new Error("missing original projection");
    await transitionSessionVisibility(client.db, {
      workspaceId: f.scope.workspaceId,
      sessionId: f.scope.sessionId,
      actorSubjectId: f.human,
      targetVisibility: "workspace_shared",
      expectedAuthorityEpoch: original.projection.currentAuthority.epoch,
      operationKey: crypto.randomUUID(),
    });
    const shared = await project(f.scope);
    expect(shared.kind).toBe("live");
    if (shared.kind === "live") {
      expect(shared.projection.acceptedAuthority).toEqual(original.projection.acceptedAuthority);
      expect(shared.projection.currentAuthority.epoch).toBeGreaterThan(
        shared.projection.acceptedAuthority.epoch,
      );
      expect(shared.projection.currentAuthority.executionEpoch).toBe(
        original.projection.currentAuthority.executionEpoch,
      );
    }
    await sqlState(
      () =>
        adminMutation(
          f,
          (tx) =>
            tx`update sessions set authority_epoch=authority_epoch+1 where id=${f.scope.sessionId}`,
        ),
      "42501",
    );
    // Seed an old accepted snapshot below the current floor. Current runtime
    // writers cannot author it; this fixture does not relax any installed guard.
    await fixture.admin.begin(async (tx) => {
      await tx`set local session_replication_role='replica'`;
      await tx`update session_turn_attempts set authority_epoch=1 where id=${f.scope.attemptId}`;
    });
    expect(await project(f.scope)).toEqual({ kind: "fenced" });
  });

  for (const action of ["pause", "cancel"] as const)
    test(`real ${action} fences the live projection without spending count`, async () => {
      const f = await seed({ count: 4 });
      await control(f, action);
      expect(await project(f.scope)).toEqual({ kind: "fenced" });
      expect((await truth(f.scope))!.metadata).toEqual(f.metadata);
    });

  test("real Steer creates an interruption; no successor/human substitution", async () => {
    const f = await seed({ count: 1 });
    await steer(f);
    expect(await project(f.scope)).toEqual({ kind: "fenced" });
    expect((await truth(f.scope))!.metadata).toEqual(f.metadata);
  });

  test("model dispatch, pending tool/open suffix, and closed-but-unquiesced are unsupported", async () => {
    const model = await seed();
    await adminMutation(model, async (tx) => {
      await tx`insert into session_events (account_id,workspace_id,session_id,turn_id,sequence,type,payload)
        select ${model.scope.accountId},${model.scope.workspaceId},${model.scope.sessionId},${model.scope.turnId},
        coalesce(max(sequence),0)+1,'agent.model.request','{}' from session_events where session_id=${model.scope.sessionId}`;
    });
    expect(await project(model.scope)).toEqual({ kind: "unsupported", reason: "not_premodel" });
    const pending = await seed();
    await adminMutation(
      pending,
      (tx) => tx`insert into session_pending_tool_calls
      (account_id,workspace_id,session_id,turn_id,execution_generation,attempt_id,call_id,call_type,call_item_ordered)
      values (${pending.scope.accountId},${pending.scope.workspaceId},${pending.scope.sessionId},${pending.scope.turnId},1,
      ${pending.scope.attemptId},'call','function_call','{}')`,
    );
    expect(await project(pending.scope)).toEqual({ kind: "unsupported", reason: "not_premodel" });
    const closed = await seed();
    await adminMutation(
      closed,
      (
        tx,
      ) => tx`update session_turn_attempts set state='closed',outcome='failed',closed_at=clock_timestamp()
      where id=${closed.scope.attemptId}`,
    );
    expect(await project(closed.scope)).toEqual({ kind: "fenced" });
    expect(
      (
        await fixture.admin`select quiesced_at from session_turn_attempts where id=${closed.scope.attemptId}`
      )[0]!.quiesced_at,
    ).toBeNull();
  });

  test("real worker turn.started lifecycle prefix is not a model-dispatch suffix", async () => {
    const f = await seed();
    await adminMutation(
      f,
      (
        tx,
      ) => tx`insert into session_events (account_id,workspace_id,session_id,turn_id,sequence,type,payload)
      select ${f.scope.accountId},${f.scope.workspaceId},${f.scope.sessionId},${f.scope.turnId},
      coalesce(max(sequence),0)+1,'turn.started',jsonb_build_object('triggerEventId',${f.scope.triggerEventId}::text)
      from session_events where session_id=${f.scope.sessionId}`,
    );
    expect((await project(f.scope)).kind).toBe("live");
    expect((await truth(f.scope))!.metadata).toEqual(f.metadata);
  });

  test("earlier tenancy-only entry is rejected instead of reversing membership lock order", async () => {
    const f = await seed();
    await sqlState(
      () =>
        scoped(f.scope, async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${f.scope.workspaceId}`},0))`,
          );
          return lockLiveNativeOriginalOriginTx(tx, f.scope);
        }),
      "25001",
    );
  });

  for (const action of ["pause", "cancel", "steer", "revoke"] as const)
    test(`projection serializes concurrent ${action}; no grant across commit`, async () => {
      const f = await seed();
      const entered = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const admission = scoped(f.scope, async (tx) => {
        expect((await lockLiveNativeOriginalOriginTx(tx, f.scope)).kind).toBe("live");
        const [row] = await rawRows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`);
        entered.resolve(row!.pid);
        await release.promise;
      });
      const pid = await entered.promise;
      const writer =
        action === "steer"
          ? steer(f)
          : action === "revoke"
            ? adminMutation(
                f,
                (
                  tx,
                ) => tx`update organization_memberships set status='revoked',revoked_at=clock_timestamp(),
          authorization_revision=authorization_revision+1 where account_id=${f.scope.accountId} and subject_id=${f.human}`,
              )
            : control(f, action);
      try {
        await waitForBlockedWriter(pid);
      } finally {
        release.resolve();
        await admission;
        await writer;
      }
      expect(await project(f.scope)).toEqual({ kind: "fenced" });
      expect((await truth(f.scope))!.metadata).toEqual(f.metadata);
    });

  test("real workspace Pause blocks the original origin", async () => {
    const f = await seed();
    await withWorkspaceSubjectSessionActivityRls(client.db, f.scope.workspaceId, f.human, (tx) =>
      mutateWorkspaceControlInTransaction(tx, {
        accountId: f.scope.accountId,
        workspaceId: f.scope.workspaceId,
        actor: { type: "human", subjectId: f.human },
        operationKey: crypto.randomUUID(),
        action: "pause",
      }),
    );
    expect(await project(f.scope)).toEqual({ kind: "fenced" });
  });

  test("private owner mismatch, active route and closed quiescence never pass", async () => {
    for (const field of ["owner", "route", "quiesced"] as const) {
      const f = await seed();
      await fixture.admin.begin(async (tx) => {
        await tx`set local session_replication_role='replica'`;
        if (field === "owner")
          await tx`update sessions set owner_subject_id='user:other-fixture' where id=${f.scope.sessionId}`;
        if (field === "route")
          await tx`update sessions set active_sandbox_id=${crypto.randomUUID()} where id=${f.scope.sessionId}`;
        if (field === "quiesced")
          await tx`update session_turn_attempts set state='closed',outcome='failed',closed_at=clock_timestamp(),
          quiesced_at=clock_timestamp() where id=${f.scope.attemptId}`;
      });
      expect(await project(f.scope)).toEqual({ kind: "fenced" });
    }
  });

  test("nested owner capability survives; exact membership capability cannot cross schema or subject", async () => {
    const f = await seed();
    const owner = postgres(fixture.ownerUrl, {
      max: 1,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    try {
      await owner.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id',${f.scope.accountId},true),
          set_config('opengeni.workspace_id',${f.scope.workspaceId},true),
          set_config('opengeni.subject_id','service:native-proof-test',true)`;
        const [outer] =
          await tx`select opengeni_private.open_session_tenancy_fenced_access('public'::regnamespace::oid) as id`;
        const [result] =
          await tx`select lock_live_native_original_origin_v2(${tx.json(f.scope)}) as result`;
        expect(result!.result.kind).toBe("live");
        expect(
          (
            await tx`select count(*)::int as n from opengeni_private.session_tenancy_fenced_access_capabilities
          where capability_id=${outer!.id}`
          )[0]!.n,
        ).toBe(1);
        expect(
          await tx`select id from organization_memberships where account_id=${f.scope.accountId}`,
        ).toHaveLength(0);
        const cap = crypto.randomUUID();
        await tx`insert into opengeni_private.modal_native_origin_read_capabilities values
          (${cap},'pg_catalog'::regnamespace::oid,pg_backend_pid(),pg_current_xact_id(),${f.scope.accountId},
          ${f.scope.workspaceId},${f.scope.sessionId},${f.scope.turnId},${f.scope.attemptId},1,${f.human})`;
        expect(
          await tx`select id from organization_memberships where account_id=${f.scope.accountId}`,
        ).toHaveLength(0);
        await tx`update opengeni_private.modal_native_origin_read_capabilities set data_schema='public'::regnamespace::oid where capability_id=${cap}`;
        expect(
          await tx`select id from organization_memberships where account_id=${f.scope.accountId} and subject_id=${f.human}`,
        ).toHaveLength(1);
        expect(
          await tx`select id from organization_memberships where account_id=${f.scope.accountId} and subject_id<>${f.human}`,
        ).toHaveLength(0);
        expect(
          await tx`update organization_memberships set authorization_revision=authorization_revision+1
          where account_id=${f.scope.accountId} and subject_id=${f.human} returning id`,
        ).toHaveLength(0);
        await tx`delete from opengeni_private.modal_native_origin_read_capabilities where capability_id=${cap}`;
        await tx`select opengeni_private.close_session_tenancy_fenced_access(${outer!.id}::uuid)`;
      });
    } finally {
      await owner.end();
    }
  });

  test("provisioning repairs table/column grants; actual runtime posture rejects the unsafe ledger", async () => {
    const options = {
      expectedRole: appRole,
      rlsStrategy: "force" as const,
      targetSchema: "public",
    };
    const clean = await inspectRuntimeDatabasePosture(client.db, options);
    expect(
      evaluateRuntimeDatabasePosture(clean, options).filter(
        (x) =>
          x.includes("Native LIVE-origin") ||
          x.includes("lock_live_native_original_origin_v2") ||
          x.includes("modal_native_origin_member_read_active"),
      ),
    ).toEqual([]);
    await fixture.admin.unsafe(
      `GRANT INSERT (initiating_human_subject_id) ON opengeni_private.modal_native_origin_read_capabilities TO "${appRole}"`,
    );
    const dirty = await inspectRuntimeDatabasePosture(client.db, options);
    expect(evaluateRuntimeDatabasePosture(dirty, options)).toContain(
      "Native LIVE-origin read capability has unsafe owner, RLS or privileges",
    );
    await provisionRoles(fixture.adminUrl, { appRole, appPassword, temporalDatabases: [] });
    expect(
      (
        await fixture.admin`select has_any_column_privilege(${appRole},'opengeni_private.modal_native_origin_read_capabilities','INSERT') as value`
      )[0]!.value,
    ).toBe(false);
    expect(
      (
        await fixture.admin`select count(*)::int as n from opengeni_private.modal_native_origin_read_capabilities`
      )[0]!.n,
    ).toBe(0);
  });
});
