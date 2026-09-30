import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  retainWorkspaceMutationProcess,
  type DbClient,
} from "../src/index";

const MIGRATION = "0541_idle_command_containment.sql";
const FUNCTION = "opengeni_private.list_unobservable_command_drain_candidates(integer)";
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
  shared = await acquireSharedTestDatabase("migration-0541");
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

async function candidateGroups(): Promise<string[]> {
  const rows = await admin<{ sandbox_group_id: string }[]>`
    select sandbox_group_id from opengeni_private.list_unobservable_command_drain_candidates(100)`;
  return rows.map((row) => row.sandbox_group_id);
}

/** A warm Modal lease whose only holder is one healthy legacy retained command. */
async function leaseWithRetainedCommand() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('migration-0541') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'migration-0541') returning id`;
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
    dispatchId: `migration-0541-${crypto.randomUUID()}`,
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
  await admin`delete from sandbox_lease_holders where lease_id = ${lease!.id} and kind = 'turn'`;
  await admin`update sandbox_leases set refcount = 1, turn_holders = 0 where id = ${lease!.id}`;
  return {
    ...ids,
    leaseId: lease!.id,
    sandboxGroupId: session.sandboxGroupId,
    sessionId: session.id,
  };
}

describe("0541 idle command containment", () => {
  test("is a rolling, additive migration", async () => {
    const source = await migrationSource();
    expect(source).toStartWith("-- deployment-mode: rolling");
    expect(source).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|TRIGGER)\b/i);
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

  test("the inventory is independent of command health and excludes live blockers", async () => {
    const fixture = await leaseWithRetainedCommand();
    // A healthy running command with no other holder is a candidate: exact
    // enrollment, not the inventory, decides whether the group is idle.
    expect(await candidateGroups()).toContain(fixture.sandboxGroupId);

    await admin`insert into sandbox_lease_holders (account_id, lease_id, workspace_id, kind,
      holder_id, subject_id) values (${fixture.accountId}, ${fixture.leaseId},
      ${fixture.workspaceId}, 'viewer', 'viewer-0541', ${fixture.sessionId})`;
    expect(await candidateGroups()).not.toContain(fixture.sandboxGroupId);
    await admin`delete from sandbox_lease_holders where lease_id = ${fixture.leaseId}
      and kind = 'viewer'`;

    await admin`update sandbox_leases set reaper_hold_id = gen_random_uuid(),
      reaper_hold_until = now() + interval '1 hour', reaper_hold_reason = 'operator'
      where id = ${fixture.leaseId}`;
    expect(await candidateGroups()).not.toContain(fixture.sandboxGroupId);
    await admin`update sandbox_leases set reaper_hold_id = null, reaper_hold_until = null,
      reaper_hold_reason = null where id = ${fixture.leaseId}`;
    expect(await candidateGroups()).toContain(fixture.sandboxGroupId);
  });

  test("replays idempotently without widening public authority", async () => {
    const definition = async () => {
      const [row] = await admin<{ definition: string }[]>`
        select pg_get_functiondef(${FUNCTION}::regprocedure) as definition`;
      return row!.definition;
    };
    const before = await definition();
    expect(before).not.toContain("last_reconcile_outcome");
    expect(before).not.toContain("reconcile_attempts");
    expect(before).not.toContain("cancel_requested_at");
    const source = await migrationSource();
    await admin.begin(async (tx) => {
      await tx.unsafe(source.slice(source.indexOf("DO $install$"), source.lastIndexOf("RESET")));
    });
    expect(await definition()).toBe(before);
    const [permission] = await admin<{ public_execute: boolean }[]>`
      select coalesce(bool_or(acl.grantee = 0 and acl.privilege_type = 'EXECUTE'), false)
        as public_execute
      from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid = ${FUNCTION}::regprocedure`;
    expect(permission!.public_execute).toBe(false);
  });
});
