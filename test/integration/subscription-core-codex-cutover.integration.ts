/**
 * The M3 Codex cutover seam (design 5.1.1 "Workflow and public compatibility").
 *
 * A session workflow that parked on a legacy Codex capacity wait recorded the
 * legacy peek activity's result (waiter id, generation, next check, wake
 * revision) in its history before the drained migration ran. After 0689 those
 * recorded arguments execute in reconciliation against the migrated core
 * waiter, which kept the same id, generation and revisions. The activity and
 * signal names and payload shapes are unchanged, and the pinned legacy
 * capacity-wait history still replays against the current workflow bundle.
 *
 * Runs as the non-superuser, non-bypass application role against real
 * PostgreSQL migrated by the schema owner (OPENGENI_REQUIRE_REAL_DB=1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { Worker } from "@temporalio/worker";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  wakeSubscriptionCoreCodexCapacityWaiters,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { armCodexCapacityWait } from "../../packages/db/test/fixtures/legacy-codex";
import { migrate } from "../../packages/db/src/migrate";
import { provisionRoles } from "../../packages/db/src/provision-roles";
import { encryptEnvironmentValue } from "../../packages/db/src/environment-crypto";
import { createCodexCapacityActivities } from "../../apps/worker/src/activities/codex-capacity";
import { createHistoricalCodexCapacityPeek } from "../../apps/worker/test/fixtures/legacy-codex/peek";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0689_subscription_core_codex_cutover.sql";
// 0711 requires the committed 0689 cutover, so it is held back with it.
const PRECURSOR = "0711_subscription_core_generic_precursor.sql";
const MODEL = "codex/gpt-5.5";
const key = Buffer.alloc(32, 77);
const settings = { environmentsEncryptionKey: key.toString("base64") } as never;
const workflowDefinitionsPath = new URL("../../apps/worker/src/workflows.ts", import.meta.url)
  .pathname;
const legacySessionCapacityWaitHistoryPath = new URL(
  "../../apps/worker/test/fixtures/legacy-session-capacity-wait-history.json",
  import.meta.url,
).pathname;

describe.skipIf(!realDb)(
  "SUB-COMPAT-01 the Codex cutover seam for recorded capacity-wait histories",
  () => {
    let owned: OwnerMigratedTestDatabase;
    let client: DbClient | null = null;
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
      const fixture = await acquireOwnerMigratedTestDatabase("codex-cutover-seam");
      if (!fixture) throw new Error("Real PostgreSQL is required");
      owned = fixture;
      const owner = postgres(owned.ownerUrl, { max: 1 });
      try {
        await owner`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
        await owner`INSERT INTO schema_migrations(name) VALUES(${MIGRATION}), (${PRECURSOR})`;
        await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
        await owner`DELETE FROM schema_migrations WHERE name IN (${MIGRATION}, ${PRECURSOR})`;
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

    test("a legacy peek recorded before the migration reconciles against the same waiter after it", async () => {
      // Pre-cutover world: a legacy organization Codex account, exhausted, and
      // a turn parked on the legacy Codex waiter by the legacy arm path.
      const userId = `cutover-seam-${crypto.randomUUID()}`;
      const access = await ensureManagedAccessForUser(client!.db, {
        userId,
        email: `${userId}@example.test`,
        name: "Codex cutover seam",
      });
      const accountId = access.workspaceGrants[0]!.accountId;
      const ownerSubjectId = `user:${userId}`;
      const [workspace] = await owned.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${accountId}::uuid, 'Cutover seam')
        returning id::text as id`;
      const workspaceId = workspace!.id;
      await owned.admin`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role)
        values (${accountId}::uuid, ${workspaceId}::uuid, ${ownerSubjectId}, 'owner')`;
      await owned.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}::uuid, ${accountId}::uuid)`;
      const [credential] = await owned.admin<{ id: string }[]>`
        insert into codex_subscription_credentials (
          account_id, organization_id, authority_scope, credential_encrypted,
          chatgpt_account_id, plan_type, status, exhausted_until, exhausted_kind
        ) values (
          ${accountId}::uuid, ${accountId}::uuid, 'organization',
          ${encryptEnvironmentValue(key, JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }))},
          'chatgpt-seam', 'pro', 'active', now() + interval '1 hour', 'quota'
        ) returning id::text as id`;
      // The legacy arm serializes on the workspace rotation row.
      await owned.admin`
        insert into codex_rotation_settings (account_id, workspace_id, rotation_enabled)
        values (${accountId}::uuid, ${workspaceId}::uuid, false)`;
      await owned.admin`
        insert into organization_codex_rotation_settings (account_id, rotation_enabled)
        values (${accountId}::uuid, true)`;
      const session = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
        createSession(client!.db, {
          accountId,
          workspaceId,
          initialMessage: "cutover seam",
          resources: [],
          metadata: {},
          model: MODEL,
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          subjectId: ownerSubjectId,
          createdBy: { kind: "subject" as const, subjectId: ownerSubjectId },
          createdByContext: {},
        }),
      );
      const turn = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
        enqueueSessionTurn(client!.db, {
          accountId,
          workspaceId,
          sessionId: session.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `session-${session.id}`,
          source: "user",
          prompt: "cutover seam",
          resources: [],
          tools: [],
          model: MODEL,
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: {},
          initiator: { kind: "subject", subjectId: ownerSubjectId },
        }),
      );
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client!.db, workspaceId, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId,
        trigger: { kind: "next" },
      });
      expect(claimed.action).toBe("claimed");
      const armed = await armCodexCapacityWait(client!.db, {
        accountId,
        workspaceId,
        sessionId: session.id,
        turnId: turn.id,
        attemptId,
        workflowId: `session-${session.id}`,
        earliestResetAt: new Date(Date.now() + 3_600_000),
        resetKind: "authoritative",
        failurePayload: { code: "codex_capacity_unavailable" },
      });
      expect(armed.action).toBe("waiting");

      // The legacy peek activity completes before the migration; its result
      // is what the workflow history records.
      const recorded = await createHistoricalCodexCapacityPeek(
        async () => ({ db: client!.db }) as never,
      ).getCodexCapacityWait({
        accountId,
        workspaceId,
        sessionId: session.id,
      } as never);
      expect(recorded).not.toBeNull();
      expect(recorded).not.toHaveProperty("provider");

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

      // The same activity names and shapes now read the core waiter, which
      // kept the recorded id, generation and wake revision.
      const peeked = await activities().getCodexCapacityWait({
        accountId,
        workspaceId,
        sessionId: session.id,
      } as never);
      expect(peeked).toMatchObject({
        waiterId: recorded!.waiterId,
        generation: recorded!.generation,
        wakeRevision: recorded!.wakeRevision,
      });

      // The recorded arguments reconcile on the core: still exhausted, so the
      // same waiter keeps waiting.
      const waiting = await activities().reconcileCodexCapacityWait({
        accountId,
        workspaceId,
        sessionId: session.id,
        waiterId: recorded!.waiterId,
        generation: recorded!.generation,
        cause: "timer",
      });
      expect(waiting).toMatchObject({
        action: "waiting",
        waiterId: recorded!.waiterId,
        generation: recorded!.generation,
      });

      // Capacity returns on the migrated (canonical, same id) connection and
      // the core wake reaches the migrated waiter; the recorded reference
      // resumes the blocked turn.
      await owned.admin`
        update subscription_connection_quota
        set quota = jsonb_set(quota, '{exhaustedUntil}', 'null'::jsonb) || '{"exhaustedKind":null}'::jsonb,
          revision = revision + 1
        where connection_id = ${credential!.id}::uuid`;
      await wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
        accountId,
        reason: "cutover_seam",
      });
      const resumed = await activities().reconcileCodexCapacityWait({
        accountId,
        workspaceId,
        sessionId: session.id,
        waiterId: recorded!.waiterId,
        generation: recorded!.generation,
        cause: "signal",
      });
      expect(resumed).toEqual({ action: "resumed" });
      const [row] = await owned.admin<{ status: string }[]>`
        select status from session_turns where id = ${turn.id}::uuid`;
      expect(row!.status).toBe("recovering");
      const legacy = await owned.admin<{ status: string }[]>`
        select status from codex_capacity_waiters where id = ${recorded!.waiterId}::uuid`;
      expect(legacy[0]!.status).toBe("superseded");
    }, 180_000);

    test("the pinned legacy capacity-wait history replays against the current workflow registry", async () => {
      const history = (await Bun.file(legacySessionCapacityWaitHistoryPath).json()) as {
        events: Array<{ workflowExecutionStartedEventAttributes?: { workflowId?: string } }>;
      };
      await Worker.runReplayHistory(
        { workflowsPath: workflowDefinitionsPath },
        history,
        history.events[0]?.workflowExecutionStartedEventAttributes?.workflowId ?? "legacy",
      );
    }, 180_000);
  },
);
