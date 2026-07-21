import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0095");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0095] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0067 (durable goal wake)", () => {
  test("arms only idle legacy goals and preserves existing or blocked work", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((candidate) => candidate < "0067_")) {
        await applyFile(admin, file);
      }

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0095-account') returning id`;
      const insertWorkspace = async (name: string, paused = false) => {
        const [workspace] = await admin<{ id: string }[]>`
          insert into workspaces (account_id, name)
          values (${account!.id}, ${name}) returning id`;
        await admin`
          insert into workspace_inference_controls (
            workspace_id, account_id, revision, workspace_state, workspace_pause_revision
          ) values (
            ${workspace!.id}, ${account!.id}, ${paused ? 1 : 0},
            ${paused ? "paused" : "active"}, ${paused ? 1 : null}
          )`;
        return workspace!;
      };
      const workspace = await insertWorkspace("migration-0095-workspace");
      const pausedWorkspace = await insertWorkspace("migration-0095-paused-workspace", true);

      const insertSession = async (
        text: string,
        options: { workspaceId?: string; parentSessionId?: string } = {},
      ) => {
        const sessionId = crypto.randomUUID();
        const workspaceId = options.workspaceId ?? workspace.id;
        await admin`
          insert into sessions (
            id, account_id, workspace_id, status, initial_message, model,
            sandbox_backend, sandbox_group_id, temporal_workflow_id, parent_session_id
          ) values (
            ${sessionId}, ${account!.id}, ${workspaceId}, 'idle', ${text},
            'scripted-model', 'none', ${sessionId}, ${`session-${sessionId}`},
            ${options.parentSessionId ?? null}
          )`;
        return { sessionId, workspaceId };
      };
      const insertGoalSession = async (
        text: string,
        options: { workspaceId?: string; parentSessionId?: string } = {},
      ) => {
        const { sessionId, workspaceId } = await insertSession(text, options);
        const [goal] = await admin<{ id: string }[]>`
          insert into session_goals (account_id, workspace_id, session_id, text)
          values (${account!.id}, ${workspaceId}, ${sessionId}, ${text}) returning id`;
        return { sessionId, workspaceId, goalId: goal!.id };
      };

      const idle = await insertGoalSession("idle legacy goal");
      const materialized = await insertGoalSession("already materialized goal");
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload
        ) values (
          ${account!.id}, ${workspace!.id}, ${materialized.sessionId}, 'goal_continuation',
          ${materialized.goalId}, 'legacy-goal-continuation', 'already pending',
          ${admin.json({
            type: "goal_continuation",
            goalId: materialized.goalId,
            goalVersion: 1,
            autoContinuation: 1,
            maxAutoContinuations: null,
            prompt: "continue",
            policy: {
              model: "scripted-model",
              reasoningEffort: "low",
              tools: [],
              sandboxBackend: "none",
            },
          })}
        )`;
      // Legacy evaluation and synthesis were separate commits. Model both a
      // duplicate continuation and an already-acknowledged workflow nudge: the
      // migration must keep one runnable update and commit a newer wake.
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload, state, created_at
        ) values (
          ${account!.id}, ${workspace!.id}, ${materialized.sessionId}, 'goal_continuation',
          ${materialized.goalId}, 'legacy-goal-continuation-duplicate',
          'duplicate deferred continuation',
          ${admin.json({
            type: "goal_continuation",
            goalId: materialized.goalId,
            goalVersion: 1,
            autoContinuation: 2,
            maxAutoContinuations: null,
            prompt: "duplicate continuation",
            policy: {
              model: "scripted-model",
              reasoningEffort: "low",
              tools: [],
              sandboxBackend: "none",
            },
          })},
          'deferred', now() + interval '1 minute'
        )`;
      await admin`
        insert into session_workflow_wake_outbox (
          session_id, account_id, workspace_id, temporal_workflow_id,
          wake_revision, delivered_revision, reason
        ) values (
          ${materialized.sessionId}, ${account!.id}, ${workspace!.id},
          ${`session-${materialized.sessionId}`}, 1, 1, 'legacy_acknowledged_wake'
        )`;

      const deferred = await insertGoalSession("single deferred continuation");
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload, state
        ) values (
          ${account!.id}, ${workspace!.id}, ${deferred.sessionId}, 'goal_continuation',
          ${deferred.goalId}, 'legacy-deferred-goal-continuation', 'only deferred update',
          ${admin.json({
            type: "goal_continuation",
            goalId: deferred.goalId,
            goalVersion: 1,
            autoContinuation: 1,
            maxAutoContinuations: null,
            prompt: "continue deferred goal",
            policy: {
              model: "scripted-model",
              reasoningEffort: "low",
              tools: [],
              sandboxBackend: "none",
            },
          })},
          'deferred'
        )`;

      const staleVersion = await insertGoalSession("stale continuation version");
      await admin`update session_goals set version = 2 where id = ${staleVersion.goalId}`;
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload
        ) values (
          ${account!.id}, ${workspace!.id}, ${staleVersion.sessionId}, 'goal_continuation',
          ${staleVersion.goalId}, 'legacy-stale-goal-continuation', 'stale pending update',
          ${admin.json({
            type: "goal_continuation",
            goalId: staleVersion.goalId,
            goalVersion: 1,
            autoContinuation: 1,
            maxAutoContinuations: null,
            prompt: "continue stale goal",
            policy: {
              model: "scripted-model",
              reasoningEffort: "low",
              tools: [],
              sandboxBackend: "none",
            },
          })}
        )`;

      // Payload matching remains textual so malformed legacy JSON cannot make
      // the rollout migration cast-and-abort or count as an observed revision.
      const malformed = await insertGoalSession("malformed legacy continuation");
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload
        ) values (
          ${account!.id}, ${workspace.id}, ${malformed.sessionId}, 'goal_continuation',
          ${malformed.goalId}, 'legacy-malformed-goal-continuation',
          'malformed pending update',
          ${admin.json({
            type: "goal_continuation",
            goalId: malformed.goalId,
            goalVersion: "not-an-integer",
          })}
        )`;

      const delivered = await insertGoalSession("delivered terminal continuation");
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload, state, delivered_at
        ) values (
          ${account!.id}, ${workspace!.id}, ${delivered.sessionId}, 'goal_continuation',
          ${delivered.goalId}, 'legacy-delivered-goal-continuation', 'already delivered',
          ${admin.json({
            type: "goal_continuation",
            goalId: delivered.goalId,
            goalVersion: 1,
            autoContinuation: 1,
            maxAutoContinuations: null,
            prompt: "continue delivered goal",
            policy: {
              model: "scripted-model",
              reasoningEffort: "low",
              tools: [],
              sandboxBackend: "none",
            },
          })},
          'delivered', now()
        )`;

      const humanQueued = await insertGoalSession("human queued goal");
      await admin`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt,
          model, reasoning_effort, sandbox_backend
        ) values (
          ${account!.id}, ${workspace!.id}, ${humanQueued.sessionId}, ${crypto.randomUUID()},
          ${`session-${humanQueued.sessionId}`}, 'queued', 'user', 1, 'human prompt',
          'scripted-model', 'low', 'none'
        )`;

      const capacityBlocked = await insertGoalSession("capacity blocked goal");
      const blockedTurnId = crypto.randomUUID();
      await admin`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt,
          model, reasoning_effort, sandbox_backend
        ) values (
          ${blockedTurnId}, ${account!.id}, ${workspace!.id}, ${capacityBlocked.sessionId},
          ${crypto.randomUUID()}, ${`session-${capacityBlocked.sessionId}`},
          'waiting_capacity', 'goal', 1, 'goal continuation',
          'scripted-model', 'low', 'none'
        )`;
      await admin`
        insert into codex_capacity_waiters (
          account_id, workspace_id, session_id, goal_id, blocked_turn_id,
          workflow_id, goal_version, next_check_at, reset_kind
        ) values (
          ${account!.id}, ${workspace!.id}, ${capacityBlocked.sessionId},
          ${capacityBlocked.goalId}, ${blockedTurnId}, ${`session-${capacityBlocked.sessionId}`},
          1, now() + interval '1 hour', 'authoritative'
        )`;

      const directlyPaused = await insertGoalSession("directly paused goal");
      await admin`
        update sessions
        set direct_control_state = 'paused', direct_pause_revision = 1, control_version = 1
        where id = ${directlyPaused.sessionId}`;

      const pausedAncestor = await insertSession("paused ancestor");
      await admin`
        update sessions
        set direct_control_state = 'paused', direct_pause_revision = 2, control_version = 2
        where id = ${pausedAncestor.sessionId}`;
      await insertGoalSession("ancestor paused goal", {
        parentSessionId: pausedAncestor.sessionId,
      });

      await insertGoalSession("workspace paused goal", {
        workspaceId: pausedWorkspace.id,
      });
      const pausedMaterialized = await insertGoalSession("paused materialized goal", {
        workspaceId: pausedWorkspace.id,
      });
      await admin`
        insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id,
          dedupe_key, summary, payload
        ) values (
          ${account!.id}, ${pausedWorkspace.id}, ${pausedMaterialized.sessionId},
          'goal_continuation', ${pausedMaterialized.goalId},
          'legacy-paused-materialized-goal-continuation', 'paused pending update',
          ${admin.json({
            type: "goal_continuation",
            goalId: pausedMaterialized.goalId,
            goalVersion: 1,
            autoContinuation: 1,
            maxAutoContinuations: null,
            prompt: "continue after resume",
            policy: {
              model: "scripted-model",
              reasoningEffort: "low",
              tools: [],
              sandboxBackend: "none",
            },
          })}
        )`;

      // The target's revision-3 subtree override is closer than its ancestor's
      // revision-2 pause and newer than the workspace's revision-1 pause. Both
      // barriers are therefore defeated, exactly as in projectEffectiveControl.
      const overriddenAncestor = await insertSession("overridden paused ancestor", {
        workspaceId: pausedWorkspace.id,
      });
      await admin`
        update sessions
        set direct_control_state = 'paused', direct_pause_revision = 2, control_version = 2
        where id = ${overriddenAncestor.sessionId}`;
      const overrideAdmitted = await insertGoalSession("newer subtree override goal", {
        workspaceId: pausedWorkspace.id,
        parentSessionId: overriddenAncestor.sessionId,
      });
      await admin`
        update sessions
        set subtree_run_override_revision = 3, control_version = 3
        where id = ${overrideAdmitted.sessionId}`;
      await admin`
        update workspace_inference_controls set revision = 3
        where workspace_id = ${pausedWorkspace.id}`;

      await applyFile(admin, "0095_durable_goal_wake.sql");

      const goals = await admin<
        Array<{
          text: string;
          wake_revision: number;
          observed_revision: number;
        }>
      >`
        select text,
          continuation_wake_revision::integer as wake_revision,
          continuation_observed_revision::integer as observed_revision
        from session_goals order by text`;
      expect(
        goals.map(({ text, wake_revision, observed_revision }) => ({
          text,
          wake_revision,
          observed_revision,
        })),
      ).toEqual([
        { text: "already materialized goal", wake_revision: 1, observed_revision: 1 },
        { text: "ancestor paused goal", wake_revision: 0, observed_revision: 0 },
        { text: "capacity blocked goal", wake_revision: 0, observed_revision: 0 },
        { text: "delivered terminal continuation", wake_revision: 1, observed_revision: 0 },
        { text: "directly paused goal", wake_revision: 0, observed_revision: 0 },
        { text: "human queued goal", wake_revision: 0, observed_revision: 0 },
        { text: "idle legacy goal", wake_revision: 1, observed_revision: 0 },
        { text: "malformed legacy continuation", wake_revision: 1, observed_revision: 0 },
        { text: "newer subtree override goal", wake_revision: 1, observed_revision: 0 },
        { text: "paused materialized goal", wake_revision: 1, observed_revision: 1 },
        { text: "single deferred continuation", wake_revision: 1, observed_revision: 1 },
        { text: "stale continuation version", wake_revision: 1, observed_revision: 0 },
        { text: "workspace paused goal", wake_revision: 0, observed_revision: 0 },
      ]);

      const migratedUpdates = await admin<
        Array<{ session_id: string; summary: string; state: string }>
      >`
        select session_id, summary, state
        from session_system_updates
        where session_id in (
          ${materialized.sessionId}, ${deferred.sessionId}, ${malformed.sessionId},
          ${pausedMaterialized.sessionId}
        )
        order by summary`;
      expect(
        migratedUpdates.map(({ session_id, summary, state }) => ({
          session_id,
          summary,
          state,
        })),
      ).toEqual([
        {
          session_id: materialized.sessionId,
          summary: "already pending",
          state: "pending",
        },
        {
          session_id: materialized.sessionId,
          summary: "duplicate deferred continuation",
          state: "cancelled",
        },
        {
          session_id: malformed.sessionId,
          summary: "malformed pending update",
          state: "pending",
        },
        {
          session_id: deferred.sessionId,
          summary: "only deferred update",
          state: "pending",
        },
        {
          session_id: pausedMaterialized.sessionId,
          summary: "paused pending update",
          state: "pending",
        },
      ]);

      const wakes = await admin<
        Array<{ session_id: string; reason: string; wake_revision: number }>
      >`
        select session_id, reason, wake_revision::integer as wake_revision
        from session_workflow_wake_outbox order by session_id`;
      expect(
        wakes
          .map(({ session_id, reason, wake_revision }) => ({
            session_id,
            reason,
            wake_revision,
          }))
          .sort((left, right) => left.session_id.localeCompare(right.session_id)),
      ).toEqual(
        [
          {
            session_id: deferred.sessionId,
            reason: "goal_materialized_backfill",
            wake_revision: 1,
          },
          {
            session_id: delivered.sessionId,
            reason: "goal_obligation_backfill",
            wake_revision: 1,
          },
          {
            session_id: idle.sessionId,
            reason: "goal_obligation_backfill",
            wake_revision: 1,
          },
          {
            session_id: malformed.sessionId,
            reason: "goal_obligation_backfill",
            wake_revision: 1,
          },
          {
            session_id: materialized.sessionId,
            reason: "goal_materialized_backfill",
            wake_revision: 2,
          },
          {
            session_id: overrideAdmitted.sessionId,
            reason: "goal_obligation_backfill",
            wake_revision: 1,
          },
          {
            session_id: staleVersion.sessionId,
            reason: "goal_obligation_backfill",
            wake_revision: 1,
          },
        ].sort((left, right) => left.session_id.localeCompare(right.session_id)),
      );

      let rejectedInvalidRevision = false;
      try {
        await admin`
          update session_goals
          set continuation_observed_revision = continuation_wake_revision + 1
          where id = ${idle.goalId}`;
      } catch {
        rejectedInvalidRevision = true;
      }
      expect(rejectedInvalidRevision).toBe(true);

      let rejectedUnsafeGoalRevision = false;
      try {
        await admin`
          update session_goals
          set continuation_wake_revision = 9007199254740992
          where id = ${idle.goalId}`;
      } catch {
        rejectedUnsafeGoalRevision = true;
      }
      expect(rejectedUnsafeGoalRevision).toBe(true);

      let rejectedUnsafeWorkflowRevision = false;
      try {
        await admin`
          update session_workflow_wake_outbox
          set wake_revision = 9007199254740992
          where session_id = ${idle.sessionId}`;
      } catch {
        rejectedUnsafeWorkflowRevision = true;
      }
      expect(rejectedUnsafeWorkflowRevision).toBe(true);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 180_000);
});
