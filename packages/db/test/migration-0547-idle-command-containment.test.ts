import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  advanceWorkspaceGeneration,
  COMMAND_CONTAINMENT_TURN_STARTING_UPDATE_KINDS,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enrollRetainedCommandContainment,
  initializeSessionStartAtomically,
  retainWorkspaceMutationProcess,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0547_idle_command_containment.sql";
const FUNCTION = "opengeni_private.list_command_containment_candidates(integer,bigint)";
const LEGACY_FUNCTION = "opengeni_private.list_unobservable_command_drain_candidates(integer)";
const WINDOW_MS = 30 * 60_000;
const MODAL_PROVIDER_BINDING = {
  key: '{"version":1,"serverUrl":"https://modal.test","workspaceName":"opengeni-test","environment":"test"}',
  binding: {
    version: 1 as const,
    serverUrl: "https://modal.test",
    workspaceName: "opengeni-test",
    environment: "test",
  },
};

setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let app: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0547");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  admin = shared.admin;
  app = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function migrationSource(): Promise<string> {
  return await Bun.file(new URL(`../drizzle/${MIGRATION}`, import.meta.url)).text();
}

/** Called as the runtime role, exactly as the reaper does. */
async function candidateGroups(idleMs: number | null = WINDOW_MS): Promise<string[]> {
  const rows = await app.db.execute<{ sandbox_group_id: string }>(sql`
    select sandbox_group_id
    from opengeni_private.list_command_containment_candidates(100, ${idleMs}::bigint)`);
  return [...rows].map((row) => row.sandbox_group_id);
}

async function legacyCandidateGroups(): Promise<string[]> {
  const rows = await admin<{ sandbox_group_id: string }[]>`
    select sandbox_group_id from opengeni_private.list_unobservable_command_drain_candidates(100)`;
  return rows.map((row) => row.sandbox_group_id);
}

async function definition(signature: string): Promise<string> {
  const [row] = await admin<{ definition: string }[]>`
    select pg_get_functiondef(${signature}::regprocedure) as definition`;
  return row!.definition;
}

/** Move the group's durable activity facts back in time. */
async function unusedFor(fixture: { workspaceId: string; leaseId: string }, minutes: number) {
  const ago = `${minutes} minutes`;
  await admin`update session_turn_attempts set closed_at = now() - ${ago}::interval,
    updated_at = now() - ${ago}::interval, quiesced_at = now() - ${ago}::interval
    where workspace_id = ${fixture.workspaceId}`;
  await admin`update session_turns set finished_at = now() - ${ago}::interval
    where workspace_id = ${fixture.workspaceId}`;
  await admin`update sandbox_workspace_mutation_admissions set admitted_at = now() - ${ago}::interval
    where lease_id = ${fixture.leaseId}`;
  await admin`update sandbox_leases set holders_changed_at = now() - ${ago}::interval
    where id = ${fixture.leaseId}`;
}

/** A warm Modal lease whose only holder is one healthy legacy retained command. */
async function leaseWithRetainedCommand() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('migration-0547') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'migration-0547') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(app.db, {
    ...ids,
    initialMessage: "start a server",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    ...ids,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(app.db, ids.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `migration-0547-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("fixture turn was not claimed");
  const holderId = `turn-attempt:${attemptId}`;
  const instanceId = `box-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, instance_id, backend, lease_epoch, expires_at)
    values (${ids.accountId}, ${ids.workspaceId}, ${session.sandboxGroupId}, 'warm', 1, 1,
      ${instanceId}, 'modal', 3, now() + interval '10 minutes')
    returning id`;
  await admin`insert into sandbox_lease_holders (account_id, lease_id, workspace_id, kind,
    holder_id, subject_id) values (${ids.accountId}, ${lease!.id}, ${ids.workspaceId}, 'turn',
    ${holderId}, ${session.id})`;
  const turn = {
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId,
    holderId,
    sandboxGroupId: session.sandboxGroupId,
    expectedEpoch: 3,
    expectedInstanceId: instanceId,
    routeKind: "home" as const,
    routeTargetId: null,
    routeEpoch: 0,
  };
  const admission = await advanceWorkspaceGeneration(app.db, {
    ...ids,
    sessionId: session.id,
    ...turn,
    operation: "exec_command",
  });
  const processId = crypto.randomUUID();
  await retainWorkspaceMutationProcess(app.db, {
    ...ids,
    sessionId: session.id,
    processId,
    providerSessionId: 5,
    admissionId: admission.id,
    admittedWorkspaceGeneration: admission.workspaceGeneration,
    operation: "exec_command",
    providerBinding: MODAL_PROVIDER_BINDING,
    backgroundCommand: { commandId: processId, command: "python -m http.server" },
    owner: { kind: "turn", ...turn },
  });
  await admin`update sandbox_retained_processes set last_reconcile_outcome = 'provider_running'
    where id = ${processId}`;
  await admin`update session_turn_attempts set state = 'closed', outcome = 'completed',
    closed_at = now(), quiesced_at = now() where id = ${attemptId}`;
  await admin`update session_turns set status = 'completed', finished_at = now(),
    active_attempt_id = null where id = ${claim.turn.id}`;
  await admin`update sessions set status = 'idle', active_turn_id = null where id = ${session.id}`;
  await admin`delete from sandbox_lease_holders where lease_id = ${lease!.id} and kind = 'turn'`;
  await admin`update sandbox_leases set refcount = 1, turn_holders = 0 where id = ${lease!.id}`;
  return {
    ...ids,
    leaseId: lease!.id,
    sandboxGroupId: session.sandboxGroupId,
    sessionId: session.id,
  };
}

describe("0547 idle command containment", () => {
  test("is a rolling, expand-only migration", async () => {
    const source = await migrationSource();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|TRIGGER)\b/i);
    // Pre-0547 workers keep calling the untouched legacy inventory.
    expect(source).not.toMatch(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+opengeni_private\.list_unobservable_command_drain_candidates/i,
    );
    // An RLS-immune stable default, never a row backfill over a FORCE-RLS table.
    expect(source).toContain("ADD COLUMN holders_changed_at timestamptz NOT NULL DEFAULT now()");
    expect(source).not.toMatch(/\bUPDATE\s+sandbox_leases\b/i);
  });

  test("the database stamps holder-set changes and nothing else", async () => {
    const fixture = await leaseWithRetainedCommand();
    const stampedAt = async () => {
      const [row] = await admin<{ at: Date }[]>`
        select holders_changed_at as at from sandbox_leases where id = ${fixture.leaseId}`;
      return row!.at.getTime();
    };
    await admin`update sandbox_leases set holders_changed_at = now() - interval '2 hours'
      where id = ${fixture.leaseId}`;
    const before = await stampedAt();
    // Unrelated writes (billing ticks, expiry refresh, same-count recounts) are
    // not holder activity.
    await admin`update sandbox_leases set last_meter_at = now(), updated_at = now(),
      expires_at = now() + interval '5 minutes' where id = ${fixture.leaseId}`;
    await admin`update sandbox_leases set refcount = refcount, turn_holders = turn_holders
      where id = ${fixture.leaseId}`;
    expect(await stampedAt()).toBe(before);
    for (const change of [
      () => admin`update sandbox_leases set viewer_holders = 1 where id = ${fixture.leaseId}`,
      () => admin`update sandbox_leases set turn_holders = 1 where id = ${fixture.leaseId}`,
      () => admin`update sandbox_leases set refcount = 2 where id = ${fixture.leaseId}`,
    ]) {
      await admin`update sandbox_leases set holders_changed_at = now() - interval '2 hours'
        where id = ${fixture.leaseId}`;
      await change();
      expect(await stampedAt()).toBeGreaterThan(Date.now() - 60_000);
    }
  });

  test("the new inventory screens for unused groups independent of command health", async () => {
    const fixture = await leaseWithRetainedCommand();
    // A healthy running command whose group was just used is not a candidate,
    // so a busy group never costs the exclusive workspace-control fence.
    expect(await candidateGroups()).not.toContain(fixture.sandboxGroupId);
    await unusedFor(fixture, 31);
    expect(await candidateGroups()).toContain(fixture.sandboxGroupId);
    // A NULL window lists only enrolled or rotating leases.
    expect(await candidateGroups(null)).not.toContain(fixture.sandboxGroupId);

    // Every live blocker keeps it out.
    await admin`insert into sandbox_lease_holders (account_id, lease_id, workspace_id, kind,
      holder_id, subject_id) values (${fixture.accountId}, ${fixture.leaseId},
      ${fixture.workspaceId}, 'viewer', 'viewer-0547', ${fixture.sessionId})`;
    expect(await candidateGroups()).not.toContain(fixture.sandboxGroupId);
    await admin`delete from sandbox_lease_holders where lease_id = ${fixture.leaseId}
      and kind = 'viewer'`;
    await admin`update sandbox_leases set reaper_hold_id = gen_random_uuid(),
      reaper_hold_until = now() + interval '1 hour', reaper_hold_reason = 'operator'
      where id = ${fixture.leaseId}`;
    expect(await candidateGroups()).not.toContain(fixture.sandboxGroupId);
    await admin`update sandbox_leases set reaper_hold_id = null, reaper_hold_until = null,
      reaper_hold_reason = null where id = ${fixture.leaseId}`;
    await admin`update session_turns set status = 'requires_action'
      where session_id = ${fixture.sessionId}`;
    expect(await candidateGroups()).not.toContain(fixture.sandboxGroupId);
    await admin`update session_turns set status = 'completed' where session_id = ${fixture.sessionId}`;
    await unusedFor(fixture, 31);
    expect(await candidateGroups()).toContain(fixture.sandboxGroupId);
    // A rotating lease is listed regardless of the window; exact enrollment
    // applies the deadline grace.
    await admin`update sandbox_leases set holders_changed_at = now(),
      rotation_requested_at = now(), rotation_reason = 'provider_deadline'
      where id = ${fixture.leaseId}`;
    expect(await candidateGroups(null)).toContain(fixture.sandboxGroupId);
  });

  test("pre-0547 workers keep their exact legacy inventory", async () => {
    const fixture = await leaseWithRetainedCommand();
    await unusedFor(fixture, 31);
    // The old function is untouched: a healthy command never becomes one of
    // its candidates, so an old worker takes no new workspace-control locks.
    expect(await definition(LEGACY_FUNCTION)).toContain("process.reconcile_attempts >= 5");
    expect(await legacyCandidateGroups()).not.toContain(fixture.sandboxGroupId);
    expect(await candidateGroups()).toContain(fixture.sandboxGroupId);
  });

  test("the new inventory is private to the reaper's role", async () => {
    expect(await definition(FUNCTION)).not.toContain("last_reconcile_outcome");
    const [permission] = await admin<{ public_execute: boolean; app_execute: boolean }[]>`
      select
        coalesce((select bool_or(acl.grantee = 0 and acl.privilege_type = 'EXECUTE')
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl), false)
          as public_execute,
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as app_execute
      from pg_proc p where p.oid = ${FUNCTION}::regprocedure`;
    expect(permission).toEqual({ public_execute: false, app_execute: true });
  });
  test("the inventory screen sees activity as the FORCE-RLS owner", async () => {
    // Production migrates as a non-superuser owner, so the SECURITY DEFINER
    // screen reads activity tables only through inventory policies.
    const owned = await acquireOwnerMigratedTestDatabase("idle-command-containment");
    if (!owned) throw new Error("PostgreSQL verification requires the Docker fixture");
    const [sharedAdmin, sharedApp] = [admin, app];
    let client: DbClient | undefined;
    try {
      await migrate(owned.ownerUrl);
      await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
      const appUrl = new URL(owned.ownerUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = owned.appPassword;
      client = createDb(appUrl.toString());
      admin = owned.admin;
      app = client;
      const fixture = await leaseWithRetainedCommand();
      await unusedFor(fixture, 31);
      expect(await candidateGroups()).toContain(fixture.sandboxGroupId);
      const [attempt] = await admin<{ id: string; turn_id: string }[]>`
        select id, turn_id from session_turn_attempts where workspace_id = ${fixture.workspaceId}`;
      // Each activity table must be visible to the owner-run screen.
      const probes: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
        [
          "attempt close",
          () => admin`update session_turn_attempts set closed_at = now(), quiesced_at = now()
              where id = ${attempt!.id}`,
          () => unusedFor(fixture, 31),
        ],
        [
          "open turn",
          () =>
            admin`update session_turns set status = 'requires_action' where id = ${attempt!.turn_id}`,
          () => admin`update session_turns set status = 'completed' where id = ${attempt!.turn_id}`,
        ],
        [
          "admission",
          () =>
            admin`update sandbox_workspace_mutation_admissions set admitted_at = now()
              where lease_id = ${fixture.leaseId}`,
          () => unusedFor(fixture, 31),
        ],
        [
          "pending machine input",
          () => admin`insert into session_system_updates (
              account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary, payload
            ) values (${fixture.accountId}, ${fixture.workspaceId}, ${fixture.sessionId},
              'agent_message', ${crypto.randomUUID()}, ${`probe-${crypto.randomUUID()}`},
              'probe', ${admin.json({ type: "agent_message" })})`,
          () =>
            admin`update session_system_updates set state = 'superseded'
              where session_id = ${fixture.sessionId}`,
        ],
      ];
      for (const [label, activate, clear] of probes) {
        await activate();
        expect({
          label,
          listed: (await candidateGroups()).includes(fixture.sandboxGroupId),
        }).toEqual({
          label,
          listed: false,
        });
        await clear();
        expect(await candidateGroups()).toContain(fixture.sandboxGroupId);
      }
      // The replacement inventory and exact enrollment must also work when
      // migrations ran under FORCE RLS as an ordinary schema owner.
      await admin`update session_turns set status = 'recovering', finished_at = null
        where session_id = ${fixture.sessionId}`;
      await admin`update sessions set direct_control_state = 'paused',
        direct_pause_revision = control_version where id = ${fixture.sessionId}`;
      expect(await candidateGroups()).toContain(fixture.sandboxGroupId);
      expect(
        (
          await enrollRetainedCommandContainment(app.db, {
            accountId: fixture.accountId,
            workspaceId: fixture.workspaceId,
            sandboxGroupId: fixture.sandboxGroupId,
            idleCommandContainmentMs: WINDOW_MS,
          })
        )?.mode,
      ).toBe("idle");
    } finally {
      admin = sharedAdmin;
      app = sharedApp;
      await client?.close().catch(() => undefined);
      await owned.release();
    }
  }, 180_000);
  test("the screen's turn-starting update kinds match the wake class map", async () => {
    const source = await migrationSource();
    const lists = [...source.matchAll(/pending_update\.kind IN \(([^)]*)\)/g)].map((match) =>
      [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((kind) => kind[1]).sort(),
    );
    expect(lists).toEqual([
      [...COMMAND_CONTAINMENT_TURN_STARTING_UPDATE_KINDS.always].sort(),
      [...COMMAND_CONTAINMENT_TURN_STARTING_UPDATE_KINDS.withActiveGoal].sort(),
    ]);
    expect(COMMAND_CONTAINMENT_TURN_STARTING_UPDATE_KINDS.always).not.toContain(
      "background_command_result",
    );
  });
});
