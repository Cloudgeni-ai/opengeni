/**
 * The M4 Claude cutover seam (design 5.3 "Cutover protocol", "Waiters"; the
 * Claude counterpart of SUB-COMPAT-01).
 *
 * A session workflow that parked on a legacy Claude capacity wait recorded the
 * peek activity's result (provider `claude`, waiter id, generation, wake
 * revision) in its history before the drained migration ran. 0748 moves that
 * waiter onto the shared core with the same id, generation and revisions, and
 * a wake the workflow had not observed lands in the core wake outbox. The
 * activity and signal names and payload shapes are unchanged, and a recorded
 * history carrying the Claude reference still replays against the current
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
  wakeSubscriptionCoreProviderCapacityWaiters,
  withSessionActivityRlsContext,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "../../packages/db/src/migrate";
import { provisionRoles } from "../../packages/db/src/provision-roles";
import { restorePreRetirementGrants } from "../../packages/db/test/fixtures/pre-retirement-grants";
import { createCodexCapacityActivities } from "../../apps/worker/src/activities/codex-capacity";
// The legacy Claude runtime is deleted (design 5.3, C4). The pre-cutover world
// is staged with the retired account writers (now only a test fixture), the
// frozen legacy waiter and the exact historical peek activity body.
import {
  createClaudeSubscriptionAccount,
  wakeClaudeCapacityWaiters,
} from "../../packages/db/test/fixtures/legacy-claude/accounts";
import { armClaudeCapacityWait } from "../../packages/db/test/fixtures/legacy-codex";
import { createHistoricalCodexCapacityPeek } from "../../apps/worker/test/fixtures/legacy-codex/peek";
import { subscriptionPoolWorkerSubject } from "../../packages/db/test/fixtures/legacy-subscription-session-access";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0748_subscription_core_claude_cutover.sql";
// The drained retirement requires every receipt; this seam fixture records it
// and never runs it.
const RETIREMENT = "0751_subscription_core_legacy_retirement.sql";
const PROVIDER = "workspace-claude-subscription";
const MODEL = `${PROVIDER}/claude-opus-5-5`;
const key = Buffer.alloc(32, 83);
const settings = { environmentsEncryptionKey: key.toString("base64") } as never;
const workspaceSnapshot = { version: 1, scope: "workspace" } as const;
const workflowDefinitionsPath = new URL("../../apps/worker/src/workflows.ts", import.meta.url)
  .pathname;
const legacySessionCapacityWaitHistoryPath = new URL(
  "../../apps/worker/test/fixtures/legacy-session-capacity-wait-history.json",
  import.meta.url,
).pathname;

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
 * The pinned legacy capacity-wait history, rewritten as a Claude wait: the
 * recorded turn result and reconcile result carry `provider: "claude"`,
 * exactly the shape the legacy Claude peek and reconcile returned.
 */
async function claudeCapacityWaitHistory() {
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
        value.capacityWait = { provider: "claude", ...value.capacityWait };
      } else if (activity === "reconcileCodexCapacityWait" && value.action === "waiting") {
        Object.assign(value, { provider: "claude" });
      } else continue;
      payload.data = Buffer.from(JSON.stringify(value)).toString("base64");
      rewritten += 1;
    }
  }
  expect(rewritten).toBe(2);
  return history;
}

describe.skipIf(!realDb)(
  "SUB-COMPAT-01 the Claude cutover seam for recorded capacity-wait histories",
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

    const historicalPeek = () =>
      createHistoricalCodexCapacityPeek(async () => ({ db: client!.db }) as never);

    beforeAll(async () => {
      const fixture = await acquireOwnerMigratedTestDatabase("claude-cutover-seam");
      if (!fixture) throw new Error("Real PostgreSQL is required");
      owned = fixture;
      // The legacy Claude world: everything but the drained Claude cutover.
      const owner = postgres(owned.ownerUrl, { max: 1 });
      try {
        await owner`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
        await owner`INSERT INTO schema_migrations(name) VALUES(${MIGRATION}), (${RETIREMENT})`;
        await migrate(owned.ownerUrl, undefined, {
          applicationDatabaseRoles: ["opengeni_app"],
          environmentsEncryptionKey: key,
        });
        await owner`DELETE FROM schema_migrations WHERE name = ${MIGRATION}`;
      } finally {
        await owner.end();
      }
      await provisionRoles(owned.adminUrl, {
        appRole: "opengeni_app",
        appPassword: owned.appPassword,
      });
      // Both windows this seam models run before the retirement, under that
      // release's grants.
      await restorePreRetirementGrants(owned.adminUrl);
      client = createDb(appUrl(), { max: 4 });
    }, 180_000);

    afterAll(async () => {
      await client?.close();
      await owned?.release();
    }, 60_000);

    test("a legacy Claude wait recorded before the migration keeps its waiter, generation and pending wake after it", async () => {
      // Pre-cutover world: a workspace Claude account and a turn parked on the
      // legacy Claude waiter by the legacy arm path.
      const [account] = await owned.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('Claude cutover seam') returning id::text as id`;
      const accountId = account!.id;
      const [workspace] = await owned.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${accountId}::uuid, 'Cutover seam')
        returning id::text as id`;
      const workspaceId = workspace!.id;
      const [personal] = await owned.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal')
        returning id::text as id`;
      const subjectId = `user:claude-seam-${crypto.randomUUID()}`;
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
      const accountUuid = crypto.randomUUID();
      const connected = await createClaudeSubscriptionAccount(client!.db, {
        ...input,
        scope: "workspace",
        encryptionKey: key,
        secret: {
          version: 1,
          token: `sk-ant-oat01-seam-${crypto.randomUUID()}`,
          identity: { accountUuid, deviceId: "a".repeat(64) },
          oauth: {
            refreshToken: `seam-refresh-${crypto.randomUUID()}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            scopes: ["user:inference", "user:profile"],
          },
        },
        providerAccountId: accountUuid,
        label: null,
        accountEmail: null,
        planType: "claude_max",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const credentialId = connected.account.id;
      await owned.admin`
        update claude_subscription_credentials set exhausted_until = now() + interval '1 hour'
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
        initialMessage: "Claude cutover seam",
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
      // The accepted execution policy every Claude subscription turn carries.
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
          providerId: PROVIDER,
          upstreamModelId: "claude-opus-5-5",
          wireApi: "anthropic-messages",
          credentialSource: { kind: "connected_subscription", provider: "claude" },
          billing: { upstreamPayer: "connected_subscription", metering: "external" },
          definitionVersion: `sha256:${"0".repeat(64)}`,
        },
      };
      await withSessionActivityRlsContext(client!.db, input, async (tx) => {
        await tx.execute(
          sql`update sessions set status = 'running', temporal_workflow_id = ${workflowId} where id = ${sessionId}`,
        );
        await tx.execute(
          sql`insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status, source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, execution_generation, active_attempt_id, metadata, initiating_human_subject_id, claude_provider_account_authority_snapshot) values (${turnId}, ${accountId}, ${workspaceId}, ${sessionId}, ${crypto.randomUUID()}, ${workflowId}, 'running', 'user', 1, 'Claude cutover seam', ${MODEL}, 'high', 'standard', 'none', 1, ${attemptId}, ${JSON.stringify(metadata)}::jsonb, ${subjectId}, ${JSON.stringify(workspaceSnapshot)}::jsonb)`,
        );
        await tx.execute(
          sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`,
        );
        await tx.execute(
          sql`insert into session_turn_attempts (id, account_id, workspace_id, session_id, turn_id, execution_generation, state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id, verified_control_revision, mcp_approval_policies) values (${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, 1, 'running', ${workflowId}, ${"seam-run-" + attemptId}, 'seam-activity', 0, '{}'::jsonb)`,
        );
      });
      const armed = await armClaudeCapacityWait(client!.db, {
        accountId,
        workspaceId,
        sessionId,
        turnId,
        attemptId,
        workflowId,
        subjectId: subscriptionPoolWorkerSubject("claude"),
        authoritySnapshot: workspaceSnapshot,
        earliestResetAt: new Date(Date.now() + 3_600_000),
        failurePayload: { code: "claude_capacity_unavailable" },
      });
      expect(armed.action).toBe("waiting");
      // A capacity change commits a wake whose signal the workflow has not
      // observed yet.
      await wakeClaudeCapacityWaiters(client!.db, {
        workspaceId,
        subjectId,
        authoritySnapshot: workspaceSnapshot,
        reason: "usage_refreshed",
      });

      // The legacy peek activity completes before the migration; its result
      // is what the workflow history records.
      const recorded = await historicalPeek().getCodexCapacityWait({
        accountId,
        workspaceId,
        sessionId,
      } as never);
      expect(recorded).toMatchObject({ provider: "claude", waiterId: armed.waiter!.id });
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
      await restorePreRetirementGrants(owned.adminUrl);
      client = createDb(appUrl(), { max: 4 });

      // The core waiter is the recorded one: same id, generation and wake
      // revision, with the unobserved wake in the core outbox.
      const [waiter] = await owned.admin<
        {
          provider: string;
          turn_id: string;
          generation: number;
          wake_revision: number;
          observed_wake_revision: number;
          blocked_turn_generation: number;
          wait_reason: string;
        }[]
      >`select provider, turn_id::text, generation::int, wake_revision::int,
          observed_wake_revision::int, blocked_turn_generation::int, wait_reason
        from subscription_capacity_waiters
        where workspace_id = ${workspaceId}::uuid
          and session_id = ${sessionId}::uuid and waiter_id = ${recorded!.waiterId}::uuid`;
      expect(waiter).toEqual({
        provider: "claude",
        turn_id: turnId,
        generation: recorded!.generation,
        wake_revision: recorded!.wakeRevision,
        observed_wake_revision: armed.waiter!.observedWakeRevision,
        blocked_turn_generation: 1,
        wait_reason: "no_eligible_capacity",
      });
      // The timer the workflow sleeps on and the known reset are the legacy row's.
      const [timers] = await owned.admin<{ next_check: boolean; earliest_reset: boolean }[]>`
        select core.next_check_at = legacy.next_check_at as next_check,
          core.earliest_reset_at = legacy.earliest_reset_at as earliest_reset
        from subscription_capacity_waiters core
        join claude_capacity_waiters legacy on legacy.id = core.waiter_id
        where core.provider = 'claude' and core.waiter_id = ${recorded!.waiterId}::uuid`;
      expect(timers).toEqual({ next_check: true, earliest_reset: true });
      const wakes = await owned.admin<{ generation: number; wake_revision: number }[]>`
        select generation::int, wake_revision::int from subscription_capacity_wake_outbox
        where workspace_id = ${workspaceId}::uuid and waiter_id = ${recorded!.waiterId}::uuid`;
      expect([...wakes]).toEqual([
        { generation: recorded!.generation, wake_revision: recorded!.wakeRevision },
      ]);
      const [legacy] = await owned.admin<{ status: string }[]>`
        select status from claude_capacity_waiters where id = ${recorded!.waiterId}::uuid`;
      expect(legacy!.status).toBe("superseded");
      const [turn] = await owned.admin<{ status: string; execution_generation: number }[]>`
        select status, execution_generation::int from session_turns where id = ${turnId}::uuid`;
      expect(turn).toEqual({ status: "waiting_capacity", execution_generation: 1 });
      // A workspace account becomes a shared organization connection with the
      // legacy credential version as its refresh generation.
      const [connection] = await owned.admin<
        { provider: string; ownership: string; credential_format: string }[]
      >`select provider, ownership, credential_format from subscription_connections
        where id = ${credentialId}::uuid`;
      expect(connection).toMatchObject({ provider: "claude", ownership: "shared" });
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

    // The recorded `provider: "claude"` reference reaches the migrated waiter
    // through the runtime's peek and reconcile paths, with no re-arm (the
    // Claude core wait binding of C1b; the legacy Claude waiter arms are
    // deleted in C4).
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
        provider: "claude",
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

    test("(a) the recorded Claude reference keeps waiting on exactly the migrated waiter, no re-arm", async () => {
      expect(seam).not.toBeNull();
      const [wake] = await owned.admin<{ wake_revision: number }[]>`
          select max(wake_revision)::int as wake_revision from subscription_capacity_wake_outbox
          where workspace_id = ${seam!.workspaceId}::uuid and waiter_id = ${seam!.waiterId}::uuid`;
      expect(wake!.wake_revision).toBe(seam!.wakeRevision);
      // The account is still exhausted (the legacy `exhausted_until` moved
      // with it): reconciling the recorded reference keeps the turn waiting.
      const result = await activities().reconcileCodexCapacityWait({
        provider: "claude",
        accountId: seam!.accountId,
        workspaceId: seam!.workspaceId,
        sessionId: seam!.sessionId,
        waiterId: seam!.waiterId,
        generation: seam!.generation,
      } as never);
      expect(result).toMatchObject({
        action: "waiting",
        provider: "claude",
        waiterId: seam!.waiterId,
        generation: seam!.generation,
      });
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

    test("(b) the recorded Claude reference resumes the parked turn id and generation after a core wake", async () => {
      expect(seam).not.toBeNull();
      await owned.admin`
          update subscription_connection_quota
          set quota = jsonb_set(jsonb_set(quota, '{exhaustedUntil}', 'null'::jsonb), '{exhaustedKind}', 'null'::jsonb),
            revision = revision + 1
          where connection_id = ${seam!.credentialId}::uuid`;
      const scopes = await wakeSubscriptionCoreProviderCapacityWaiters(client!.db, "claude", {
        accountId: seam!.accountId,
        reason: "quota_observed_available",
      });
      expect(scopes).toHaveLength(1);
      const result = await activities().reconcileCodexCapacityWait({
        provider: "claude",
        accountId: seam!.accountId,
        workspaceId: seam!.workspaceId,
        sessionId: seam!.sessionId,
        waiterId: seam!.waiterId,
        generation: seam!.generation,
      } as never);
      expect(result).toEqual({ action: "resumed" });
      const [turn] = await owned.admin<
        { id: string; status: string; execution_generation: number }[]
      >`select id::text, status, execution_generation::int from session_turns
          where session_id = ${seam!.sessionId}::uuid`;
      expect(turn).toEqual({ id: seam!.turnId, status: "recovering", execution_generation: 1 });
      expect([...(await coreWaiters())]).toEqual([]);
    }, 180_000);

    test("the pinned capacity-wait history, recorded as a Claude wait, replays against the current workflow registry", async () => {
      const history = await claudeCapacityWaitHistory();
      await Worker.runReplayHistory(
        { workflowsPath: workflowDefinitionsPath },
        history as never,
        history.events[0]?.workflowExecutionStartedEventAttributes?.workflowId ?? "legacy",
      );
    }, 180_000);
  },
);
