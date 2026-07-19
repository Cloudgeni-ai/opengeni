import {
  appendSessionEventsWithLockedSessionUpdate,
  addSessionSystemUpdateWithSourceMutation,
  createScheduledTaskRun,
  enqueueSessionWorkflowWakeIfRunnable,
  getBillingBalance,
  getRig,
  getScheduledTaskRunByProducerKey,
  getVariableSet,
  initializeSessionStartAtomically,
  isCodexBilledTurn,
  markScheduledTaskRunFailedIfQueued,
  recordUsageEvent,
  replayCanonicalScheduledSessionStartByRun,
  requireScheduledTask,
  requireSession,
  ScheduledTaskRunProducerConflictError,
  settleScheduledTaskRunInTransaction,
  sumUsageQuantity,
  upsertSessionGoal,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { configuredStaticUsageLimits, type Settings } from "@opengeni/config";
import { fingerprintSessionCreateRequest } from "@opengeni/core";
import {
  assertReusableSessionRevivable,
  scheduledUserMessagePayload,
  workflowIdForSession,
} from "./common";
import { withFirstPartyTools } from "./goals";
import type {
  ActivityServices,
  DispatchScheduledTaskRunInput,
  DispatchScheduledTaskRunResult,
} from "./types";

export function createScheduledTaskActivities(services: () => Promise<ActivityServices>) {
  return {
    dispatchScheduledTaskRun: async (
      input: DispatchScheduledTaskRunInput,
    ): Promise<DispatchScheduledTaskRunResult> => {
      const { settings, db, bus, wakeSessionWorkflow } = await services();
      const producerKey = input.producerKey ?? input.agentRunUsageIdempotencyKey ?? null;
      const replayCanonicalRun = async (
        run: NonNullable<Awaited<ReturnType<typeof getScheduledTaskRunByProducerKey>>>,
      ): Promise<DispatchScheduledTaskRunResult | null> => {
        if (run.taskId !== input.taskId || run.triggerType !== input.triggerType) {
          throw new ScheduledTaskRunProducerConflictError();
        }
        if (run.status !== "dispatched" || !run.sessionId || !run.triggerEventId) {
          return null;
        }
        const initialized = await replayCanonicalScheduledSessionStartByRun(db, {
          accountId: run.accountId,
          workspaceId: run.workspaceId,
          runId: run.id,
          ...(input.agentRunUsageIdempotencyKey
            ? { usageIdempotencyKey: input.agentRunUsageIdempotencyKey }
            : {}),
        });
        if (!initialized) return null;
        const result: DispatchScheduledTaskRunResult = {
          action: "start",
          accountId: run.accountId,
          workspaceId: run.workspaceId,
          sessionId: initialized.session.id,
          triggerEventId: initialized.triggerEventId,
          workflowId: initialized.temporalWorkflowId,
          workflowWakeRevision: initialized.workflowWakeRevision,
        };
        if (wakeSessionWorkflow && result.workflowWakeRevision !== null) {
          await wakeSessionWorkflow({
            accountId: result.accountId,
            workspaceId: result.workspaceId,
            sessionId: result.sessionId,
            workflowId: result.workflowId,
            wakeRevision: result.workflowWakeRevision,
          });
        }
        return result;
      };

      if (producerKey) {
        const existingRun = await getScheduledTaskRunByProducerKey(
          db,
          input.workspaceId,
          producerKey,
        );
        if (existingRun) {
          const replayed = await replayCanonicalRun(existingRun);
          if (replayed) return replayed;
        }
      }

      const task = await requireScheduledTask(db, input.workspaceId, input.taskId);
      // The scheduled task's model can be codex/<slug>; resolve it here so the
      // admission gate can skip the credit/cost gates for a codex-billed run
      // (paid by the user's ChatGPT/Codex plan). This file uses BASE settings (no
      // codex overlay), so the predicate does its own active-credential read.
      const model = task.agentConfig.model ?? settings.openaiModel;
      const isCodexRun = await isCodexBilledTurn({
        db,
        settings,
        workspaceId: task.workspaceId,
        model,
      });
      await ensureScheduledRunAllowed(
        settings,
        db,
        task.accountId,
        task.workspaceId,
        input.agentRunUsageIdempotencyKey ? 0 : 1,
        isCodexRun,
      );
      const run = await createScheduledTaskRun(db, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        triggerType: input.triggerType,
        producerKey: producerKey ?? `scheduled:${crypto.randomUUID()}`,
        scheduledAt: null,
      });
      await recordUsageEvent(db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        eventType: "scheduled_task.fired",
        quantity: 1,
        unit: "run",
        sourceResourceType: "scheduled_task_run",
        sourceResourceId: run.id,
        idempotencyKey: `usage:scheduled_task.fired:${run.id}`,
      });
      if (run.status === "dispatched" && run.sessionId && run.triggerEventId) {
        const replayed = await replayCanonicalRun(run);
        if (replayed) return replayed;
        await recordUsageEvent(db, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          eventType: "agent_run.created",
          quantity: 1,
          unit: "run",
          sourceResourceType: "scheduled_task_run",
          sourceResourceId: run.id,
          idempotencyKey:
            input.agentRunUsageIdempotencyKey ?? `usage:agent_run.created:scheduled:${run.id}`,
        });
        const workflowId = workflowIdForSession(run.sessionId);
        const workflowWakeRevision = await enqueueSessionWorkflowWakeIfRunnable(db, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          sessionId: run.sessionId,
          temporalWorkflowId: workflowId,
          reason: "scheduled_retry",
        });
        const result = {
          action: task.runMode === "new_session_per_run" ? "start" : "signal",
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          sessionId: run.sessionId,
          triggerEventId: run.triggerEventId,
          workflowId,
          workflowWakeRevision,
        } as const;
        if (wakeSessionWorkflow && workflowWakeRevision !== null) {
          await wakeSessionWorkflow({
            accountId: result.accountId,
            workspaceId: result.workspaceId,
            sessionId: result.sessionId,
            workflowId: result.workflowId,
            wakeRevision: workflowWakeRevision,
          });
        }
        return result;
      }
      let result: DispatchScheduledTaskRunResult;
      let usageCommittedWithInitialization = false;
      try {
        const reasoningEffort = task.agentConfig.reasoningEffort ?? settings.openaiReasoningEffort;
        const sandboxBackend = task.agentConfig.sandboxBackend ?? settings.sandboxBackend;
        const goalSpec = task.agentConfig.goal ?? null;
        // Every dispatch carries the first-party MCP server (set_session_title,
        // goal tools, and the permission-gated tools), matching the API path.
        const taskTools = withFirstPartyTools(settings, task.agentConfig.tools);
        if (task.runMode === "new_session_per_run" || !task.reusableSessionId) {
          // The FK on scheduled_tasks.variable_set_id is ON DELETE RESTRICT, so
          // an attached variableSet must still exist here; fail closed if not.
          const variableSet = task.variableSetId
            ? await getVariableSet(db, task.workspaceId, task.variableSetId)
            : null;
          if (task.variableSetId && !variableSet) {
            throw new Error(`variable set not found: ${task.variableSetId}`);
          }
          // RIG BINDING (M3): resolve the task's rig to its CURRENTLY-ACTIVE
          // version at FIRE time (not task-create time) and freeze that version
          // onto the new session — a task always runs the rig's latest active
          // version. A deleted rig FK-nulls task.rigId (rig-less run); a rig that
          // somehow has no active version fails the fire closed.
          let frozenRigId: string | null = null;
          let frozenRigVersionId: string | null = null;
          if (task.rigId) {
            const rig = await getRig(db, task.workspaceId, task.rigId);
            if (!rig || !rig.activeVersion) {
              throw new Error(`rig has no active version to bind: ${task.rigId}`);
            }
            frozenRigId = rig.id;
            frozenRigVersionId = rig.activeVersion.id;
          }
          const sessionId = crypto.randomUUID();
          const scheduledPayload = scheduledUserMessagePayload(
            task.agentConfig.prompt,
            task.agentConfig.resources,
            taskTools,
            task.id,
            run.id,
          );
          const createRequestFingerprint = fingerprintSessionCreateRequest({
            admission: "scheduled",
            taskId: task.id,
            runId: run.id,
            agentRunUsageIdempotencyKey:
              input.agentRunUsageIdempotencyKey ?? `usage:agent_run.created:scheduled:${run.id}`,
            initialMessage: task.agentConfig.prompt,
            resources: task.agentConfig.resources,
            tools: taskTools,
            metadata: task.agentConfig.metadata,
            model,
            reasoningEffort,
            sandboxBackend,
            sandboxOs: "linux",
            variableSetId: task.variableSetId ?? null,
            rigId: frozenRigId,
            rigVersionId: frozenRigVersionId,
            goal: goalSpec,
            runMode: task.runMode,
          });
          const initialized = await initializeSessionStartAtomically(db, {
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            sessionId,
            createIdempotencyKey: `scheduled-run:${run.id}`,
            createRequestFingerprint,
            session: {
              initialMessage: task.agentConfig.prompt,
              resources: task.agentConfig.resources,
              tools: taskTools,
              metadata: {
                ...task.agentConfig.metadata,
                model,
                reasoningEffort,
                scheduledTaskId: task.id,
                scheduledTaskRunId: run.id,
              },
              model,
              sandboxBackend,
              sandboxOs: "linux",
              variableSetId: task.variableSetId ?? null,
              rigId: frozenRigId,
              rigVersionId: frozenRigVersionId,
            },
            createdEventPayload: {
              scheduledTaskId: task.id,
              scheduledTaskRunId: run.id,
              ...(variableSet
                ? {
                    variableSetId: variableSet.id,
                    variableSetName: variableSet.name,
                  }
                : {}),
            },
            goal: goalSpec
              ? {
                  text: goalSpec.text,
                  successCriteria: goalSpec.successCriteria ?? null,
                  maxAutoContinuations: goalSpec.maxAutoContinuations ?? null,
                  createdBy: "scheduled_task",
                }
              : null,
            admission: {
              kind: "scheduled",
              taskId: task.id,
              runId: run.id,
              summary: task.agentConfig.prompt,
              payload: scheduledPayload,
              lineage: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
              setReusableSession: task.runMode === "reusable_session",
            },
            usage: {
              idempotencyKey:
                input.agentRunUsageIdempotencyKey ?? `usage:agent_run.created:scheduled:${run.id}`,
              sourceResourceType: "scheduled_task_run",
              sourceResourceId: run.id,
            },
          });
          usageCommittedWithInitialization = true;
          if (initialized.events.length > 0) {
            await publishDurableSessionEvents(
              bus,
              task.workspaceId,
              initialized.session.id,
              initialized.events,
            );
          }
          result = {
            action: "start",
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            sessionId: initialized.session.id,
            triggerEventId: initialized.triggerEventId,
            workflowId: initialized.temporalWorkflowId,
            workflowWakeRevision: initialized.workflowWakeRevision,
          };
        } else {
          const session = await requireSession(db, task.workspaceId, task.reusableSessionId);
          // A user-cancelled (terminal) reusable session must not be revived and
          // re-billed on the next fire. Early check avoids the pre-lock goal
          // upsert side-effect; the locked-callback check below is the
          // authoritative atomic guard. Mirrors apps/api/src/domain/sessions.ts.
          assertReusableSessionRevivable(session.status);
          // Defensive backstop for the API-level 409: a reusable session keeps
          // its creation-time attachment, so a diverged task attachment must
          // fail the run instead of silently running with the wrong secrets.
          if ((session.variableSetId ?? null) !== (task.variableSetId ?? null)) {
            throw new Error(
              "scheduled task variableSet attachment does not match its reusable session",
            );
          }
          // A recurring "maintain X" task re-establishes its objective on every
          // fire: replace the goal text, reactivate it, and reset the counters.
          const reusableGoal =
            goalSpec && run.status === "queued"
              ? await upsertSessionGoal(db, {
                  accountId: task.accountId,
                  workspaceId: task.workspaceId,
                  sessionId: session.id,
                  text: goalSpec.text,
                  successCriteria: goalSpec.successCriteria ?? null,
                  maxAutoContinuations: goalSpec.maxAutoContinuations ?? null,
                  createdBy: "scheduled_task",
                })
              : null;
          if (reusableGoal) {
            const goalEvents = await appendSessionEventsWithLockedSessionUpdate(
              db,
              task.workspaceId,
              session.id,
              (locked) => {
                assertReusableSessionRevivable(locked.status);
                return {
                  events: [
                    {
                      type: "goal.set" as const,
                      payload: {
                        goalId: reusableGoal.goal.id,
                        text: reusableGoal.goal.text,
                        ...(reusableGoal.goal.successCriteria
                          ? {
                              successCriteria: reusableGoal.goal.successCriteria,
                            }
                          : {}),
                        version: reusableGoal.goal.version,
                        actor: "scheduled_task",
                        replaced: reusableGoal.replaced,
                      },
                    },
                  ],
                };
              },
            );
            await publishDurableSessionEvents(bus, task.workspaceId, session.id, goalEvents);
          }
          const bundled = await addSessionSystemUpdateWithSourceMutation(
            db,
            {
              accountId: task.accountId,
              workspaceId: task.workspaceId,
              sessionId: session.id,
              kind: "scheduled_occurrence",
              classification: "info",
              sourceId: run.id,
              dedupeKey: `scheduled-wake:${run.id}`,
              summary: task.agentConfig.prompt,
              payload: scheduledUserMessagePayload(
                task.agentConfig.prompt,
                task.agentConfig.resources,
                taskTools,
                task.id,
                run.id,
              ),
              lineage: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
            },
            async (tx, wakeEventId) => {
              if (!wakeEventId) throw new Error("Scheduled delivery has no wake event");
              await settleScheduledTaskRunInTransaction(tx, {
                workspaceId: task.workspaceId,
                runId: run.id,
                sessionId: session.id,
                triggerEventId: wakeEventId,
                status: "dispatched",
              });
            },
          );
          if (bundled.reason === "session_cancelled") {
            throw new Error(`scheduled wake was not added: ${bundled.reason}`);
          }
          if (bundled.added && bundled.events.length > 0) {
            await publishDurableSessionEvents(bus, task.workspaceId, session.id, bundled.events);
          }
          result = {
            action: "signal",
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            sessionId: session.id,
            triggerEventId: bundled.wakeEventId,
            workflowId: workflowIdForSession(session.id),
            workflowWakeRevision: bundled.workflowWakeRevision,
          };
        }
      } catch (error) {
        await markScheduledTaskRunFailedIfQueued(
          db,
          task.workspaceId,
          run.id,
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
        throw error;
      }
      if (!usageCommittedWithInitialization) {
        await recordUsageEvent(db, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          eventType: "agent_run.created",
          quantity: 1,
          unit: "run",
          sourceResourceType: "scheduled_task_run",
          sourceResourceId: run.id,
          idempotencyKey:
            input.agentRunUsageIdempotencyKey ?? `usage:agent_run.created:scheduled:${run.id}`,
        });
      }
      if (wakeSessionWorkflow && result.workflowWakeRevision !== null) {
        await wakeSessionWorkflow({
          accountId: result.accountId,
          workspaceId: result.workspaceId,
          sessionId: result.sessionId,
          workflowId: result.workflowId,
          wakeRevision: result.workflowWakeRevision,
        });
      }
      return result;
    },
  };
}

async function ensureScheduledRunAllowed(
  settings: Settings,
  db: ActivityServices["db"],
  accountId: string,
  workspaceId: string,
  requestedAgentRuns: number,
  isCodexRun: boolean,
): Promise<void> {
  // Codex-billed runs are paid by the user's ChatGPT/Codex plan: skip the
  // credit-balance gate and the monthly model-cost cap. The agent-run COUNT cap
  // below is a volume quota (not a credit/cost gate) and is intentionally kept.
  if (
    !isCodexRun &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  ) {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      throw new Error("insufficient OpenGeni credits");
    }
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    if (!isCodexRun && limits.maxMonthlyCostMicrosPerAccount) {
      const used = await sumUsageQuantity(db, {
        accountId,
        eventType: "model.cost",
        since: startOfUtcMonth(),
      });
      if (used >= limits.maxMonthlyCostMicrosPerAccount) {
        throw new Error(
          `monthly model cost limit reached (${limits.maxMonthlyCostMicrosPerAccount} micros)`,
        );
      }
    }
    if (limits.maxMonthlyAgentRunsPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      });
      if (used + requestedAgentRuns > limits.maxMonthlyAgentRunsPerWorkspace) {
        throw new Error(
          `monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`,
        );
      }
    }
  }
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
