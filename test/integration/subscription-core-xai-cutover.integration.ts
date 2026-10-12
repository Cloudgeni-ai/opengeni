/**
 * The M4 SuperGrok cutover seam (design 5.3 "Cutover protocol", "Waiters";
 * the SuperGrok counterpart of SUB-COMPAT-01).
 *
 * A session workflow that parked on a legacy SuperGrok capacity wait recorded
 * the peek activity's result (provider `xai`, waiter id, generation, wake
 * revision) in its history before the drained migration ran. 0738 moves that
 * waiter onto the shared core with the same id, generation and revisions, and
 * a wake the workflow had not observed lands in the core wake outbox. The
 * activity and signal names and payload shapes are unchanged, and a recorded
 * history carrying the SuperGrok reference still replays against the current
 * workflow bundle.
 *
 * Runs as the non-superuser, non-bypass application role against real
 * PostgreSQL migrated by the schema owner (OPENGENI_REQUIRE_REAL_DB=1), and the
 * replay needs no Temporal server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { Worker } from "@temporalio/worker";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  createSession,
  peekSessionWork,
  subscriptionPoolWorkerSubject,
  wakeSubscriptionCoreProviderCapacityWaiters,
  withSessionActivityRlsContext,
  type DbClient,
} from "@opengeni/db";
// The legacy SuperGrok runtime was deleted (M4 X4): the pre-cutover state is
// built with the test-only snapshot of its repository, waiter and peek.
import { armXaiCapacityWait } from "../../packages/db/test/fixtures/legacy-codex";
import {
  createXaiSubscriptionCredential,
  wakeXaiCapacityWaiters,
} from "../../packages/db/test/fixtures/legacy-xai";
import { createHistoricalCodexCapacityPeek } from "../../apps/worker/test/fixtures/legacy-codex/peek";
import { migrate } from "../../packages/db/src/migrate";
import { provisionRoles } from "../../packages/db/src/provision-roles";
import { createCodexCapacityActivities } from "../../apps/worker/src/activities/codex-capacity";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0738_subscription_core_xai_cutover.sql";
const MODEL = "xai/grok-4";
const key = Buffer.alloc(32, 79);
const settings = { environmentsEncryptionKey: key.toString("base64") } as never;
const workspaceSnapshot = { version: 1, scope: "workspace" } as const;
const workflowDefinitionsPath = new URL("../../apps/worker/src/workflows.ts", import.meta.url)
  .pathname;
const legacySessionCapacityWaitHistoryPath = new URL(
  "../../apps/worker/test/fixtures/legacy-session-capacity-wait-history.json",
  import.meta.url,
).pathname;

/** A fixture access token whose principal is `subject`. */
function accessToken(subject: string): string {
  const payload = Buffer.from(
    JSON.stringify({ principal_id: subject, exp: 4_102_444_800 }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

type HistoryEvent = {
  eventId: string;
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string } };
  activityTaskCompletedEventAttributes?: {
    scheduledEventId?: string;
    result?: { payloads?: Array<{ metadata?: unknown; data?: string }> };
  };
  workflowExecutionStartedEventAttributes?: { workflowId?: string };
};

/**
 * The pinned legacy capacity-wait history, rewritten as a SuperGrok wait: the
 * recorded turn result and reconcile result carry `provider: "xai"`, exactly
 * the shape the legacy SuperGrok peek and reconcile returned.
 */
async function supergrokCapacityWaitHistory() {
  const history = (await Bun.file(legacySessionCapacityWaitHistoryPath).json()) as {
    events: HistoryEvent[];
  };
  const scheduled = new Map<string, string>();
  let rewritten = 0;
  for (const event of history.events) {
    const name = event.activityTaskScheduledEventAttributes?.activityType?.name;
    if (name) scheduled.set(String(event.eventId), name);
    const completed = event.activityTaskCompletedEventAttributes;
    const activity = scheduled.get(String(completed?.scheduledEventId));
    for (const payload of completed?.result?.payloads ?? []) {
      if (!payload.data) continue;
      const value = JSON.parse(Buffer.from(payload.data, "base64").toString("utf8"));
      if (activity === "runAgentTurn" && value.capacityWait) {
        value.capacityWait = { provider: "xai", ...value.capacityWait };
      } else if (activity === "reconcileCodexCapacityWait" && value.action === "waiting") {
        Object.assign(value, { provider: "xai" });
      } else continue;
      payload.data = Buffer.from(JSON.stringify(value)).toString("base64");
      rewritten += 1;
    }
  }
  expect(rewritten).toBe(2);
  return history;
}

describe.skipIf(!realDb)(
  "SUB-COMPAT-01 the SuperGrok cutover seam for recorded capacity-wait histories",
  () => {
    let owned: OwnerMigratedTestDatabase;
    let client: DbClient | null = null;
    /** The migrated seam, set by the first case and read by the merge-gate cases. */
    let seam: {
      accountId: string;
      workspaceId: string;
      sessionId: string;
      turnId: string;
      credentialId: string;
      waiterId: string;
      generation: number;
      wakeRevision: number;
    } | null = null;
    const appUrl = () => {
      const url = new URL(owned.ownerUrl);
      url.username = "opengeni_app";
      url.password = owned.appPassword;
      return url.toString();
    };
    const activities = () =>
      createCodexCapacityActivities(
        async () =>
          ({
            db: client!.db,
            bus: { publish: async () => undefined },
            settings,
            signalCodexCapacityWorkflow: async () => undefined,
            wakeSessionWorkflow: undefined,
          }) as never,
      );

    beforeAll(async () => {
      const fixture = await acquireOwnerMigratedTestDatabase("xai-cutover-seam");
      if (!fixture) throw new Error("Real PostgreSQL is required");
      owned = fixture;
      // The legacy SuperGrok world: everything but the drained cutover.
      const owner = postgres(owned.ownerUrl, { max: 1 });
      try {
        await owner`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
        await owner`INSERT INTO schema_migrations(name) VALUES(${MIGRATION})`;
        await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
        await owner`DELETE FROM schema_migrations WHERE name = ${MIGRATION}`;
      } finally {
        await owner.end();
      }
      await provisionRoles(owned.adminUrl, {
        appRole: "opengeni_app",
        appPassword: owned.appPassword,
      });
      client = createDb(appUrl(), { max: 4 });
    }, 180_000);

    afterAll(async () => {
      await client?.close();
      await owned?.release();
    }, 60_000);

    test("a legacy SuperGrok wait recorded before the migration keeps its waiter, generation and pending wake after it", async () => {
      // Pre-cutover world: a workspace SuperGrok account and a turn parked on
      // the legacy SuperGrok waiter by the legacy arm path.
      const [account] = await owned.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('SuperGrok cutover seam') returning id::text as id`;
      const accountId = account!.id;
      const [workspace] = await owned.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${accountId}::uuid, 'Cutover seam')
        returning id::text as id`;
      const workspaceId = workspace!.id;
      const [personal] = await owned.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal')
        returning id::text as id`;
      const subjectId = `user:xai-seam-${crypto.randomUUID()}`;
      await owned.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, 'owner', '[]'::jsonb)`;
      await owned.admin`
        insert into organization_memberships (account_id, subject_id, status, personal_workspace_id, role)
        values (${accountId}::uuid, ${subjectId}, 'active', ${personal!.id}::uuid, 'owner')`;
      await owned.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}::uuid, ${accountId}::uuid)`;
      await owned.admin`
        insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
        values (${accountId}::uuid, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')`;
      const input = { accountId, workspaceId, subjectId };
      const connected = await createXaiSubscriptionCredential(client!.db, {
        ...input,
        scope: "workspace",
        encryptionKey: key,
        secret: { version: 1, accessToken: accessToken("sub-seam"), refreshToken: "refresh-seam" },
        providerAccountId: "sub-seam",
      });
      const credentialId = connected.account.id;
      await owned.admin`
        update xai_subscription_credentials set exhausted_until = now() + interval '1 hour'
        where id = ${credentialId}::uuid`;

      const sessionId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      await createSession(client!.db, {
        accountId,
        workspaceId,
        requestedSessionId: sessionId,
        visibility: "workspace_shared",
        initialMessage: "SuperGrok cutover seam",
        resources: [],
        metadata: {},
        model: MODEL,
        reasoningEffort: "high",
        latencyMode: "standard",
        sandboxBackend: "none",
        subjectId,
        createdBy: { kind: "subject", subjectId },
        createdByContext: {},
      });
      // The accepted execution policy every SuperGrok turn carries.
      const metadata = {
        turnExecutionPolicyV1: {
          schemaVersion: 1,
          productModelId: MODEL,
          requestedModelId: null,
          modelSource: "session",
          reasoningEffort: "high",
          reasoningSource: "session",
          latencyMode: "standard",
          latencyModeSource: "deployment",
          providerId: "supergrok-subscription",
          upstreamModelId: "grok-4",
          wireApi: "responses",
          credentialSource: { kind: "connected_subscription", provider: "xai" },
          billing: { upstreamPayer: "connected_subscription", metering: "external" },
          definitionVersion: `sha256:${"0".repeat(64)}`,
        },
      };
      await withSessionActivityRlsContext(client!.db, input, async (tx) => {
        await tx.execute(
          sql`update sessions set status = 'running', temporal_workflow_id = ${workflowId} where id = ${sessionId}`,
        );
        await tx.execute(
          sql`insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status, source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, execution_generation, active_attempt_id, metadata, initiating_human_subject_id, xai_provider_account_authority_snapshot) values (${turnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${crypto.randomUUID()}, ${workflowId}, 'running', 'user', 1, 'SuperGrok cutover seam', ${MODEL}, 'high', 'standard', 'none', 1, ${attemptId}, ${JSON.stringify(metadata)}::jsonb, ${subjectId}, ${JSON.stringify(workspaceSnapshot)}::jsonb)`,
        );
        await tx.execute(
          sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`,
        );
        await tx.execute(
          sql`insert into session_turn_attempts (id, account_id, workspace_id, session_id, turn_id, execution_generation, state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id, verified_control_revision, mcp_approval_policies) values (${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, 1, 'running', ${workflowId}, ${"seam-run-" + attemptId}, 'seam-activity', 0, '{}'::jsonb)`,
        );
      });
      const armed = await armXaiCapacityWait(client!.db, {
        accountId,
        workspaceId,
        sessionId,
        turnId,
        attemptId,
        workflowId,
        subjectId: subscriptionPoolWorkerSubject("xai"),
        authoritySnapshot: workspaceSnapshot,
        earliestResetAt: new Date(Date.now() + 3_600_000),
        failurePayload: { code: "supergrok_capacity_unavailable" },
      });
      expect(armed.action).toBe("waiting");
      // A capacity change commits a wake whose signal the workflow has not
      // observed yet.
      await wakeXaiCapacityWaiters(client!.db, {
        workspaceId,
        subjectId,
        authoritySnapshot: workspaceSnapshot,
        reason: "usage_refreshed",
      });

      // The peek activity completes before the migration; its result is what
      // the workflow history records.
      const recorded = await createHistoricalCodexCapacityPeek(
        async () => ({ db: client!.db }) as never,
      ).getCodexCapacityWait({
        accountId,
        workspaceId,
        sessionId,
      } as never);
      expect(recorded).toMatchObject({ provider: "xai", waiterId: armed.waiter!.id });
      expect(recorded!.wakeRevision).toBeGreaterThan(armed.waiter!.wakeRevision);

      // Drain: no application login may remain, then the owner migrates.
      await client!.close();
      client = null;
      await migrate(owned.ownerUrl, undefined, {
        applicationDatabaseRoles: ["opengeni_app"],
        environmentsEncryptionKey: key,
      });
      await provisionRoles(owned.adminUrl, {
        appRole: "opengeni_app",
        appPassword: owned.appPassword,
      });
      client = createDb(appUrl(), { max: 4 });

      // The core waiter is the recorded one: same id, generation and wake
      // revision, on the canonical connection's account, with the unobserved
      // wake in the core outbox.
      const [waiter] = await owned.admin<
        {
          turn_id: string;
          generation: number;
          wake_revision: number;
          observed_wake_revision: number;
          blocked_turn_generation: number;
          wait_reason: string;
          reset_kind: string | null;
        }[]
      >`select turn_id::text, generation::int, wake_revision::int, observed_wake_revision::int,
          blocked_turn_generation::int, wait_reason, reset_kind
        from subscription_capacity_waiters
        where provider = 'xai' and workspace_id = ${workspaceId}::uuid
          and session_id = ${sessionId}::uuid and waiter_id = ${recorded!.waiterId}::uuid`;
      expect(waiter).toEqual({
        turn_id: turnId,
        generation: recorded!.generation,
        wake_revision: recorded!.wakeRevision,
        observed_wake_revision: armed.waiter!.observedWakeRevision,
        blocked_turn_generation: 1,
        wait_reason: "no_eligible_capacity",
        reset_kind: "authoritative",
      });
      // The timer the workflow sleeps on and the known reset are the legacy row's.
      const [timers] = await owned.admin<{ next_check: boolean; earliest_reset: boolean }[]>`
        select core.next_check_at = legacy.next_check_at as next_check,
          core.earliest_reset_at = legacy.earliest_reset_at as earliest_reset
        from subscription_capacity_waiters core
        join xai_capacity_waiters legacy on legacy.id = core.waiter_id
        where core.provider = 'xai' and core.waiter_id = ${recorded!.waiterId}::uuid`;
      expect(timers).toEqual({ next_check: true, earliest_reset: true });
      const wakes = await owned.admin<{ generation: number; wake_revision: number }[]>`
        select generation::int, wake_revision::int from subscription_capacity_wake_outbox
        where workspace_id = ${workspaceId}::uuid and waiter_id = ${recorded!.waiterId}::uuid`;
      expect([...wakes]).toEqual([
        { generation: recorded!.generation, wake_revision: recorded!.wakeRevision },
      ]);
      const [legacy] = await owned.admin<{ status: string }[]>`
        select status from xai_capacity_waiters where id = ${recorded!.waiterId}::uuid`;
      expect(legacy!.status).toBe("superseded");
      const [turn] = await owned.admin<{ status: string; execution_generation: number }[]>`
        select status, execution_generation::int from session_turns where id = ${turnId}::uuid`;
      expect(turn).toEqual({ status: "waiting_capacity", execution_generation: 1 });
      const [connection] = await owned.admin<{ provider: string; ownership: string }[]>`
        select provider, ownership from subscription_connections where id = ${credentialId}::uuid`;
      expect(connection).toEqual({ provider: "xai", ownership: "shared" });
      seam = {
        accountId,
        workspaceId,
        sessionId,
        turnId,
        credentialId,
        waiterId: recorded!.waiterId,
        generation: recorded!.generation,
        wakeRevision: recorded!.wakeRevision,
      };
    }, 180_000);

    // The recorded `provider: "xai"` reference reaches the migrated waiter
    // through the runtime's peek and reconcile paths, with no re-arm. The
    // cases run in order on the seam the first case migrated.
    const coreWaiters = async () =>
      await owned.admin<
        {
          waiter_id: string;
          generation: number;
          wake_revision: number;
          observed_wake_revision: number;
        }[]
      >`select waiter_id::text, generation::int, wake_revision::int, observed_wake_revision::int
        from subscription_capacity_waiters
        where workspace_id = ${seam!.workspaceId}::uuid and session_id = ${seam!.sessionId}::uuid`;

    test("(c) the peek and peekSessionWork resolve to the migrated waiter", async () => {
      expect(seam).not.toBeNull();
      const expected = {
        provider: "xai",
        waiterId: seam!.waiterId,
        generation: seam!.generation,
        wakeRevision: seam!.wakeRevision,
        // The unobserved wake makes the next check immediate.
        nextCheckAt: new Date(0).toISOString(),
      };
      const peeked = await activities().getCodexCapacityWait({
        accountId: seam!.accountId,
        workspaceId: seam!.workspaceId,
        sessionId: seam!.sessionId,
      } as never);
      expect(peeked).toEqual(expected);
      const work = await withSessionActivityRlsContext(
        client!.db,
        { accountId: seam!.accountId, workspaceId: seam!.workspaceId },
        (tx) => peekSessionWork(tx, seam!.workspaceId, seam!.sessionId),
      );
      expect(work).toEqual({ kind: "capacity-wait", ref: expected });
    }, 180_000);

    test("(a) the recorded SuperGrok reference keeps waiting on exactly the migrated waiter, no re-arm", async () => {
      expect(seam).not.toBeNull();
      const [wake] = await owned.admin<{ wake_revision: number }[]>`
        select max(wake_revision)::int as wake_revision from subscription_capacity_wake_outbox
        where workspace_id = ${seam!.workspaceId}::uuid and waiter_id = ${seam!.waiterId}::uuid`;
      expect(wake!.wake_revision).toBe(seam!.wakeRevision);
      // The account is still exhausted (the legacy `exhausted_until` moved
      // with it): reconciling the recorded reference keeps the turn waiting.
      const result = await activities().reconcileCodexCapacityWait({
        provider: "xai",
        accountId: seam!.accountId,
        workspaceId: seam!.workspaceId,
        sessionId: seam!.sessionId,
        waiterId: seam!.waiterId,
        generation: seam!.generation,
      } as never);
      expect(result).toMatchObject({
        action: "waiting",
        provider: "xai",
        waiterId: seam!.waiterId,
        generation: seam!.generation,
      });
      // Exactly one core waiter for the session: the migrated one, same id and
      // generation, and it has observed the pending outbox wake.
      expect([...(await coreWaiters())]).toEqual([
        {
          waiter_id: seam!.waiterId,
          generation: seam!.generation,
          wake_revision: seam!.wakeRevision,
          observed_wake_revision: wake!.wake_revision,
        },
      ]);
      const [turn] = await owned.admin<{ status: string; execution_generation: number }[]>`
        select status, execution_generation::int from session_turns where id = ${seam!.turnId}::uuid`;
      expect(turn).toEqual({ status: "waiting_capacity", execution_generation: 1 });
    }, 180_000);

    test("(b) the recorded SuperGrok reference resumes the parked turn id and generation after a core wake", async () => {
      expect(seam).not.toBeNull();
      // Capacity returns on the migrated connection, and the core wakes its
      // SuperGrok waiters.
      await owned.admin`
        update subscription_connection_quota
        set quota = jsonb_set(jsonb_set(quota, '{exhaustedUntil}', 'null'::jsonb), '{exhaustedKind}', 'null'::jsonb),
          revision = revision + 1
        where connection_id = ${seam!.credentialId}::uuid`;
      const scopes = await wakeSubscriptionCoreProviderCapacityWaiters(client!.db, "xai", {
        accountId: seam!.accountId,
        reason: "quota_observed_available",
      });
      expect(scopes).toHaveLength(1);
      const [waiter] = await coreWaiters();
      expect(waiter).toMatchObject({ waiter_id: seam!.waiterId, generation: seam!.generation });
      const result = await activities().reconcileCodexCapacityWait({
        provider: "xai",
        accountId: seam!.accountId,
        workspaceId: seam!.workspaceId,
        sessionId: seam!.sessionId,
        waiterId: seam!.waiterId,
        generation: seam!.generation,
      } as never);
      expect(result).toEqual({ action: "resumed" });
      // The resumed turn is the parked one, at its execution generation; the
      // waiter is gone and nothing re-armed.
      const [turn] = await owned.admin<
        { id: string; status: string; execution_generation: number }[]
      >`
        select id::text, status, execution_generation::int from session_turns
        where session_id = ${seam!.sessionId}::uuid`;
      expect(turn).toEqual({ id: seam!.turnId, status: "recovering", execution_generation: 1 });
      expect([...(await coreWaiters())]).toEqual([]);
      const [legacy] = await owned.admin<{ count: number }[]>`
        select count(*)::int from xai_capacity_waiters
        where session_id = ${seam!.sessionId}::uuid and status = 'waiting'`;
      expect(legacy!.count).toBe(0);
    }, 180_000);

    test("the pinned capacity-wait history, recorded as a SuperGrok wait, replays against the current workflow registry", async () => {
      const history = await supergrokCapacityWaitHistory();
      await Worker.runReplayHistory(
        { workflowsPath: workflowDefinitionsPath },
        history as never,
        history.events[0]?.workflowExecutionStartedEventAttributes?.workflowId ?? "legacy",
      );
    }, 180_000);
  },
);
