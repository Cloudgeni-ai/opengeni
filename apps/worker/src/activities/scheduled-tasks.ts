import {
  appendSessionEventsWithLockedSessionUpdate,
  createScheduledTaskRun,
  createSession,
  enqueueSessionTurn,
  requireScheduledTask,
  requireSession,
  setTemporalWorkflowId,
  updateScheduledTask,
  updateScheduledTaskRun,
} from "@infra-agents/db";
import { appendAndPublishEvents } from "@infra-agents/events";
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
      const task = await requireScheduledTask(db, input.taskId);
      const run = await createScheduledTaskRun(db, {
        taskId: task.id,
        triggerType: input.triggerType,
        scheduledAt: null,
      });
      try {
        const model = task.agentConfig.model ?? settings.openaiModel;
        const reasoningEffort = task.agentConfig.reasoningEffort ?? settings.openaiReasoningEffort;
        const sandboxBackend = task.agentConfig.sandboxBackend ?? settings.sandboxBackend;
        if (task.runMode === "new_session_per_run" || !task.reusableSessionId) {
          const session = await createSession(db, {
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
          });
          const workflowId = workflowIdForSession(session.id);
          await setTemporalWorkflowId(db, session.id, workflowId);
          if (task.runMode === "reusable_session") {
            await updateScheduledTask(db, task.id, { reusableSessionId: session.id });
          }
          const events = await appendAndPublishEvents(db, bus, session.id, [
            { type: "session.created", payload: { status: "queued", scheduledTaskId: task.id, scheduledTaskRunId: run.id } },
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
          await appendAndPublishEvents(db, bus, session.id, [{
            type: "turn.queued",
            turnId: turn.id,
            payload: { turnId: turn.id, triggerEventId: trigger.id, source: turn.source },
          }]);
          await updateScheduledTaskRun(db, run.id, {
            status: "dispatched",
            sessionId: session.id,
            triggerEventId: trigger.id,
          });
          return {
            action: "start",
            sessionId: session.id,
            triggerEventId: trigger.id,
            workflowId,
          };
        }

        const session = await requireSession(db, task.reusableSessionId);
        const events = await appendSessionEventsWithLockedSessionUpdate(db, session.id, (locked) => ({
          events: [{
            type: "user.message",
            payload: scheduledUserMessagePayload(task.agentConfig.prompt, task.agentConfig.resources, task.agentConfig.tools, task.id, run.id),
          }],
          update: {
            resources: mergeResourceRefs(locked.resources, task.agentConfig.resources),
            tools: mergeToolRefs(locked.tools, task.agentConfig.tools),
          },
        }));
        await bus.publish(session.id, events);
        const trigger = events[0];
        if (!trigger) {
          throw new Error("failed to append scheduled task trigger event");
        }
        const turn = await enqueueSessionTurn(db, {
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
        await appendAndPublishEvents(db, bus, session.id, [{
          type: "turn.queued",
          turnId: turn.id,
          payload: { turnId: turn.id, triggerEventId: trigger.id, source: turn.source },
        }]);
        await updateScheduledTaskRun(db, run.id, {
          status: "dispatched",
          sessionId: session.id,
          triggerEventId: trigger.id,
        });
        return {
          action: "signal",
          sessionId: session.id,
          triggerEventId: trigger.id,
          workflowId: workflowIdForSession(session.id),
        };
      } catch (error) {
        await updateScheduledTaskRun(db, run.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        throw error;
      }
    },
  };
}
