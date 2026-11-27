import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { sqlParameterLiteral } from "./helpers/sql-literal";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  settleEndedEpochWorkspaceBlockers,
  withSessionActivityRlsContext,
} from "../src";

// Settling a lost or ended Modal box first reads the sessions whose rows it
// must lock: linked background commands, process owners, and closed,
// unquiesced owners of the box's open requests. As the runtime role the open
// request owners were joined on coalesce(request attempt, process owner): not
// a leakproof join key under row security, so every open request read every
// attempt of the workspace through its row policies (production: 184k
// buffers, 310 ms on a lease with 38,866 requests in a workspace with 11k
// attempts, 231 calls an hour). Here that read about 22,500 buffers before;
// 49 after. Production's generic plan also read every settled request of the
// lease through the scoped id index (82k buffers); 1696 indexes the lease's
// open requests for it.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("lost-provider-command-sessions-plan");
  if (!acquired) throw new Error("PostgreSQL application-role plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const ATTEMPTS = 11_000;
const SETTLED_REQUESTS = 39_000;
const OPEN_TURN_REQUESTS = 4;
// Production-like statistics: many short leases in other workspaces.
const BACKGROUND_REQUESTS_PER_LEASE = 34;
const BACKGROUND_LEASES = 3_000;
const BUFFER_BOUND = 2_000;

type Plan = { Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number } };

test("the lost-provider session lookup probes open request owners by id", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Lost provider sessions",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Lost provider sessions",
    subjectId: `lost-provider-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const { accountId, workspaceId } = grant;
  const session = (name: string) =>
    createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: name,
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
    });
  // Owners of open turn requests, owners of an open process request, and a
  // session whose attempts only make the workspace long.
  const turnOwner = await session("turn owner");
  const processOwner = await session("process owner");
  const history = await session("history");
  const tuple = {
    accountId,
    workspaceId,
    leaseId: crypto.randomUUID(),
    sandboxGroupId: crypto.randomUUID(),
    lostEpoch: 79,
    lostBackend: "modal",
    lostInstanceId: `sb-${suffix}`,
  };
  const ownerAttemptIds = Array.from({ length: OPEN_TURN_REQUESTS }, () => crypto.randomUUID());
  const processAttemptId = crypto.randomUUID();
  const processId = crypto.randomUUID();

  // Synthetic rows from the disposable harness administrator, writer
  // triggers and foreign keys off.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const attempts = (sessionId: string, ids: string[] | null, quiesced: boolean, count = 0) =>
      tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies, authority_epoch, authority_visibility,
        state, outcome, closed_at, quiesced_at
      ) select attempt_id, ${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid,
        gen_random_uuid(), 1, ${`session-${sessionId}`}, attempt_id::text, 'attempt', 0,
        '[]'::jsonb, 1, 'workspace_shared', 'closed', 'completed', now(),
        case when ${quiesced} then now() end
      from (
        select unnest(${ids ?? []}::uuid[]) as attempt_id
        union all select gen_random_uuid() from generate_series(1, ${count})
      ) ids`;
    // Most production attempts close without a quiescence receipt, so the
    // owner filter alone does not exclude them.
    await attempts(history.id, null, false, ATTEMPTS);
    await attempts(turnOwner.id, ownerAttemptIds, false);
    await attempts(processOwner.id, [processAttemptId], false);
    // A process the open request names, now on an older box of the lease.
    await tx`
      insert into sandbox_retained_processes (
        id, account_id, workspace_id, session_id, lease_id, sandbox_group_id,
        parent_admission_id, holder_id, owner_actor_kind, owner_actor_id, owner_turn_id,
        owner_attempt_id, owner_execution_generation, lease_epoch, provider_backend,
        provider_instance_id, route_kind, route_epoch, provider_session_id, state
      ) values (${processId}::uuid, ${accountId}::uuid, ${workspaceId}::uuid,
        ${processOwner.id}::uuid, ${tuple.leaseId}::uuid, ${tuple.sandboxGroupId}::uuid,
        gen_random_uuid(), 'process-holder', 'turn', ${processAttemptId}::uuid,
        gen_random_uuid(), ${processAttemptId}::uuid, 1, ${tuple.lostEpoch - 1}, 'modal',
        'sb-older', 'home', 0, 1, 'active')`;
    const requests = (input: {
      sessionId: string;
      count: number;
      from: number;
      settled: boolean;
      attemptIds?: string[];
      processId?: string;
    }) => tx`
      insert into sandbox_workspace_mutation_admissions (
        account_id, workspace_id, lease_id, sandbox_group_id, session_id, actor_kind, actor_id,
        turn_id, attempt_id, execution_generation, holder_kind, holder_id, lease_epoch,
        provider_backend, provider_instance_id, route_kind, route_epoch, workspace_generation,
        operation, provider_outcome, settled_at
      ) select ${accountId}::uuid, ${workspaceId}::uuid, ${tuple.leaseId}::uuid,
        ${tuple.sandboxGroupId}::uuid, ${input.sessionId}::uuid,
        case when ${input.processId ?? null}::uuid is null then 'turn' else 'process' end,
        coalesce(${input.processId ?? null}::uuid, attempt_id),
        case when ${input.processId ?? null}::uuid is null then gen_random_uuid() end,
        case when ${input.processId ?? null}::uuid is null then attempt_id end,
        case when ${input.processId ?? null}::uuid is null then 1 end,
        case when ${input.processId ?? null}::uuid is null then 'turn' else 'process' end,
        'holder', ${tuple.lostEpoch}, 'modal', ${tuple.lostInstanceId}, 'home', 0,
        ${input.from} + ordinality::integer, 'write',
        case when ${input.settled} then 'resolved' end,
        case when ${input.settled} then now() end
      from unnest(
        coalesce(${input.attemptIds ?? null}::uuid[],
          array(select gen_random_uuid() from generate_series(1, ${input.count})))
      ) with ordinality as request(attempt_id, ordinality)`;
    await requests({ sessionId: history.id, count: SETTLED_REQUESTS, from: 0, settled: true });
    await tx`
      insert into sandbox_workspace_mutation_admissions (
        account_id, workspace_id, lease_id, sandbox_group_id, session_id, actor_kind, actor_id,
        holder_kind, holder_id, lease_epoch, provider_backend, provider_instance_id, route_kind,
        route_epoch, workspace_generation, operation, provider_outcome, settled_at
      ) select lease.account_id, lease.workspace_id, lease.id, lease.id, lease.id, 'direct',
        gen_random_uuid(), 'direct', 'holder', 1, 'modal', 'sb-background', 'home', 0, n,
        'write', 'resolved', now()
      from (
        select gen_random_uuid() as id, gen_random_uuid() as account_id,
          gen_random_uuid() as workspace_id
        from generate_series(1, ${BACKGROUND_LEASES})
      ) lease
      cross join generate_series(1, ${BACKGROUND_REQUESTS_PER_LEASE}) n`;
    await requests({
      sessionId: turnOwner.id,
      count: OPEN_TURN_REQUESTS,
      from: SETTLED_REQUESTS,
      settled: false,
      attemptIds: ownerAttemptIds,
    });
    await requests({
      sessionId: processOwner.id,
      count: 1,
      from: SETTLED_REQUESTS + OPEN_TURN_REQUESTS,
      settled: false,
      processId,
    });
  });
  for (const table of [
    "session_turn_attempts",
    "sandbox_workspace_mutation_admissions",
    "sandbox_retained_processes",
  ]) {
    await shared.admin.unsafe(`analyze ${table}`);
  }

  // Capture the lookup exactly as the settlement sends it. No lease row
  // exists, so the settlement stops after its locks.
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const debug = driver.options.debug;
  const lookups: { query: string; parameters: unknown[] }[] = [];
  driver.options.debug = (_connection, query, parameters) => {
    if (query.includes("select distinct session_id from (")) {
      lookups.push({ query, parameters: parameters as unknown[] });
    }
  };
  try {
    expect(await settleEndedEpochWorkspaceBlockers(client.db, tuple)).toBeNull();
  } finally {
    driver.options.debug = debug;
  }
  expect(lookups).toHaveLength(1);
  const [{ query, parameters }] = lookups as [(typeof lookups)[number]];

  const measured: Record<string, number> = {};
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    await withSessionActivityRlsContext(client.db, { accountId, workspaceId }, async (tx) => {
      await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
      await tx.execute(sql.raw(`prepare lost_provider_sessions as ${query}`));
      const execute = `execute lost_provider_sessions(${parameters.map(sqlParameterLiteral).join(", ")})`;
      try {
        const rows = await tx.execute(sql.raw(execute));
        // Both owner kinds, in lock order.
        expect(rows.map((row: { session_id?: unknown }) => row.session_id)).toEqual([turnOwner.id, processOwner.id].sort());
        const [explained] = await tx.execute(
          sql.raw(`explain (analyze, buffers, format json) ${execute}`),
        );
        const plan = (explained as { "QUERY PLAN": Plan[] })["QUERY PLAN"][0]!.Plan;
        measured[mode] = plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
      } finally {
        await tx.execute(sql.raw("deallocate lost_provider_sessions"));
      }
    });
  }
  console.log("lost provider session lookup buffers", JSON.stringify(measured));
  for (const buffers of Object.values(measured)) expect(buffers).toBeLessThan(BUFFER_BOUND);
}, 300_000);
