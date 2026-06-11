import {
  appendSessionEventsWithLockedSessionUpdate,
  createScheduledTaskRun,
  createSession,
  enqueueSessionTurn,
  getBillingBalance,
  getWorkspaceEnvironment,
  recordUsageEvent,
  requireScheduledTask,
  requireSession,
  setTemporalWorkflowId,
  sumUsageQuantity,
  updateScheduledTask,
  updateScheduledTaskRun,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import { configuredStaticUsageLimits, type Settings } from "@opengeni/config";
import {
  mergeResourceRefs,
  mergeToolRefs,
  scheduledUserMessagePayload,
  workflowIdForSession,
} from "./common";
import type {
  ActivityServices,
  DispatchScheduledTaskRunInput,
  DispatchScheduledTaskRunResult,
} from "./types";

export function createScheduledTaskActivities(services: () => Promise<ActivityServices>) {
  return {
    dispatchScheduledTaskRun: async (input: DispatchScheduledTaskRunInput): Promise<DispatchScheduledTaskRunResult> => {
      const { settings, db, bus } = await services();
      const task = await requireScheduledTask(db, input.workspaceId, input.taskId);
      await ensureScheduledRunAllowed(settings, db, task.accountId, task.workspaceId, input.agentRunUsageIdempotencyKey ? 0 : 1);
      const run = await createScheduledTaskRun(db, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        triggerType: input.triggerType,
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
      let result: DispatchScheduledTaskRunResult;
      try {
        const model = task.agentConfig.model ?? settings.openaiModel;
        const reasoningEffort = task.agentConfig.reasoningEffort ?? settings.openaiReasoningEffort;
        const sandboxBackend = task.agentConfig.sandboxBackend ?? settings.sandboxBackend;
        if (task.runMode === "new_session_per_run" || !task.reusableSessionId) {
          // The FK on scheduled_tasks.environment_id is ON DELETE RESTRICT, so
          // an attached environment must still exist here; fail closed if not.
          const environment = task.environmentId
            ? await getWorkspaceEnvironment(db, task.workspaceId, task.environmentId)
            : null;
          if (task.environmentId && !environment) {
            throw new Error(`workspace environment not found: ${task.environmentId}`);
          }
          const session = await createSession(db, {
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            initialMessage: task.agentConfig.prompt,
            resources: task.agentConfig.resources,
            tools: task.agentConfig.tools,
            metadata: {
              ...task.agentConfig.metadata,
              model,
              reasoningEffort,
              scheduledTaskId: task.id,
              scheduledTaskRunId: run.id,
            },
            model,
            sandboxBackend,
            environmentId: task.environmentId ?? null,
          });
          const workflowId = workflowIdForSession(session.id);
          await setTemporalWorkflowId(db, task.workspaceId, session.id, workflowId);
          if (task.runMode === "reusable_session") {
            await updateScheduledTask(db, task.workspaceId, task.id, { reusableSessionId: session.id });
          }
          const events = await appendAndPublishEvents(db, bus, task.workspaceId, session.id, [
            {
              type: "session.created",
              payload: {
                status: "queued",
                scheduledTaskId: task.id,
                scheduledTaskRunId: run.id,
                // Names/ids only; never values.
                ...(environment ? { environmentId: environment.id, environmentName: environment.name } : {}),
              },
            },
            {
              type: "user.message",
              payload: scheduledUserMessagePayload(task.agentConfig.prompt, task.agentConfig.resources, task.agentConfig.tools, task.id, run.id),
            },
            { type: "session.status.changed", payload: { status: "queued" } },
          ]);
          const trigger = events.find((event) => event.type === "user.message");
          if (!trigger) {
            throw new Error("failed to append scheduled task trigger event");
          }
          const turn = await enqueueSessionTurn(db, {
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            sessionId: session.id,
            triggerEventId: trigger.id,
            temporalWorkflowId: workflowId,
            source: "scheduled_task",
            prompt: task.agentConfig.prompt,
            resources: task.agentConfig.resources,
            tools: task.agentConfig.tools,
            model,
            reasoningEffort,
            sandboxBackend,
            metadata: {
              scheduledTaskId: task.id,
              scheduledTaskRunId: run.id,
            },
          });
          await appendAndPublishEvents(db, bus, task.workspaceId, session.id, [{
            type: "turn.queued",
            turnId: turn.id,
            payload: { turnId: turn.id, triggerEventId: trigger.id, source: turn.source },
          }]);
          await updateScheduledTaskRun(db, task.workspaceId, run.id, {
            status: "dispatched",
            sessionId: session.id,
            triggerEventId: trigger.id,
          });
          result = {
            action: "start",
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            sessionId: session.id,
            triggerEventId: trigger.id,
            workflowId,
          };
        } else {
          const session = await requireSession(db, task.workspaceId, task.reusableSessionId);
          // Defensive backstop for the API-level 409: a reusable session keeps
          // its creation-time attachment, so a diverged task attachment must
          // fail the run instead of silently running with the wrong secrets.
          if ((session.environmentId ?? null) !== (task.environmentId ?? null)) {
            throw new Error("scheduled task environment attachment does not match its reusable session");
          }
          const events = await appendSessionEventsWithLockedSessionUpdate(db, task.workspaceId, session.id, (locked) => ({
            events: [{
              type: "user.message",
              payload: scheduledUserMessagePayload(task.agentConfig.prompt, task.agentConfig.resources, task.agentConfig.tools, task.id, run.id),
            }],
            update: {
              resources: mergeResourceRefs(locked.resources, task.agentConfig.resources),
              tools: mergeToolRefs(locked.tools, task.agentConfig.tools),
            },
          }));
          await bus.publish(task.workspaceId, session.id, events);
          const trigger = events[0];
          if (!trigger) {
            throw new Error("failed to append scheduled task trigger event");
          }
          const turn = await enqueueSessionTurn(db, {
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            sessionId: session.id,
            triggerEventId: trigger.id,
            temporalWorkflowId: workflowIdForSession(session.id),
            source: "scheduled_task",
            prompt: task.agentConfig.prompt,
            resources: task.agentConfig.resources,
            tools: task.agentConfig.tools,
            model,
            reasoningEffort,
            sandboxBackend,
            metadata: {
              scheduledTaskId: task.id,
              scheduledTaskRunId: run.id,
            },
          });
          await appendAndPublishEvents(db, bus, task.workspaceId, session.id, [{
            type: "turn.queued",
            turnId: turn.id,
            payload: { turnId: turn.id, triggerEventId: trigger.id, source: turn.source },
          }]);
          await updateScheduledTaskRun(db, task.workspaceId, run.id, {
            status: "dispatched",
            sessionId: session.id,
            triggerEventId: trigger.id,
          });
          result = {
            action: "signal",
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            sessionId: session.id,
            triggerEventId: trigger.id,
            workflowId: workflowIdForSession(session.id),
          };
        }
      } catch (error) {
        await updateScheduledTaskRun(db, task.workspaceId, run.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        throw error;
      }
      await recordUsageEvent(db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        eventType: "agent_run.created",
        quantity: 1,
        unit: "run",
        sourceResourceType: "scheduled_task_run",
        sourceResourceId: run.id,
        idempotencyKey: input.agentRunUsageIdempotencyKey ?? `usage:agent_run.created:scheduled:${run.id}`,
      });
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
): Promise<void> {
  if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      throw new Error("insufficient OpenGeni credits");
    }
  }
	  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
	    const limits = configuredStaticUsageLimits(settings);
	    if (limits.maxMonthlyCostMicrosPerAccount) {
	      const used = await sumUsageQuantity(db, {
	        accountId,
	        eventType: "model.cost",
	        since: startOfUtcMonth(),
	      });
	      if (used >= limits.maxMonthlyCostMicrosPerAccount) {
	        throw new Error(`monthly model cost limit reached (${limits.maxMonthlyCostMicrosPerAccount} micros)`);
	      }
	    }
	    if (limits.maxMonthlyAgentRunsPerWorkspace) {
	      const used = await sumUsageQuantity(db, {
	        workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      });
      if (used + requestedAgentRuns > limits.maxMonthlyAgentRunsPerWorkspace) {
        throw new Error(`monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`);
      }
    }
  }
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
