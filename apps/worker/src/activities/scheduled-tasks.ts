import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  stableJson,
  type ScheduledTask,
  type ScheduledTaskRun,
} from "@opengeni/contracts";
import {
  openGeniSlackBotMetadata,
  requireOpenGeniSlackBotConnection,
  scheduledSlackBotConnectionId,
} from "@opengeni/core";
import {
  appendSessionEventsWithLockedSessionUpdate,
  appendSessionEvents,
  addSessionSystemUpdateWithSourceMutation,
  createScheduledTaskRun,
  createSession,
  createSessionWithIdempotencyKeyResult,
  createSessionGoal,
  enqueueSessionWorkflowWakeIfRunnable,
  getScheduledTask,
  ensureKnowledgeSourceSyncState,
  getScheduledTaskPersonalConnectionDelegations,
  getScheduledTaskXaiProviderAccountAuthoritySnapshot,
  getRig,
  getSessionByCreateIdempotencyKey,
  getVariableSet,
  initializeSessionStartAtomically,
  markScheduledTaskRunFailedIfQueued,
  recordKnowledgeSourceSyncWake,
  recordUsageEvent,
  requireScheduledTaskTargetInTransaction,
  requireScheduledTaskIncidentAuthorityInTransaction,
  requireSession,
  setTemporalWorkflowId,
  settleScheduledTaskRunInTransaction,
  SessionSpawnDeniedDbError,
  updateScheduledTask,
  updateScheduledTaskRun,
  upsertSessionGoal,
  withSessionActivityRlsContext,
} from "@opengeni/db";
import { appendAndPublishEvents, publishDurableSessionEvents } from "@opengeni/events";
import { resolveFirstPartyMcpToolPolicy } from "@opengeni/config";
import {
  assertReusableSessionRevivable,
  scheduledUserMessagePayload,
  workflowIdForSession,
} from "./common";
import { withFirstPartyTools } from "./goals";
import { agentRunAdmissionDenial } from "./agent-run-admission";
import { scheduledAlertOccurrenceIdentity } from "../scheduled-alert-occurrence";
import {
  evaluateIncidentTelemetryPreflight,
  incidentTelemetryAuthorityFence,
  incidentTelemetryPreflightDeclaration,
  INCIDENT_TELEMETRY_AUTHORITY_FENCE_LINEAGE_KEY,
  type IncidentTelemetryPreflightBlockReason,
} from "./incident-telemetry-preflight";
import { resolveIncidentTelemetryResponderMetadata } from "./incident-telemetry-authority";
import type {
  ControlActivityServices,
  DispatchScheduledTaskRunInput,
  DispatchScheduledTaskRunResult,
  WakeSessionWorkflowSignal,
} from "./types";
import type { Database } from "@opengeni/db";

export function createScheduledTaskActivities(services: () => Promise<ControlActivityServices>) {
  return {
    dispatchScheduledTaskRun: async (
      input: DispatchScheduledTaskRunInput,
    ): Promise<DispatchScheduledTaskRunResult> => {
      const service = await services();
      const { settings, db, bus, wakeSessionWorkflow } = service;
      // Histories created before the manual-initiator workflow patch already
      // contain this activity command. Reject their incomplete wire input here
      // so replay consumes the recorded command and the retry loop settles.
      if (input.triggerType !== "scheduled" && !input.initiator) {
        return { action: "blocked", reason: "malformed_manual_trigger" };
      }
      const task = await getScheduledTask(db, input.workspaceId, input.taskId);
      // Deleting a schedule is authoritative. A fire workflow that was already
      // created may still start afterward; completing it as a no-op prevents an
      // unbounded retry loop for work that no longer exists.
      if (!task) {
        return { action: "deleted" };
      }
      if (task.action.kind === "knowledge_source_sync") {
        if (knowledgeSourceSyncEffectivelyPaused(task)) {
          return { action: "blocked", reason: "knowledge_source_paused" };
        }
        const run = await createScheduledTaskRun(db, {
          workspaceId: task.workspaceId,
          taskId: task.id,
          triggerType: input.triggerType,
          producerKey:
            input.producerKey ??
            input.agentRunUsageIdempotencyKey ??
            `knowledge-source-sync:${crypto.randomUUID()}`,
          scheduledAt: null,
        });
        await ensureKnowledgeSourceSyncState(db, task);
        await recordKnowledgeSourceSyncWake(db, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          sourceId: task.action.sourceId,
          scheduledTaskId: task.id,
          scheduledTaskRunId: run.id,
          cause: input.triggerType,
          producerKey:
            input.producerKey ??
            input.agentRunUsageIdempotencyKey ??
            `knowledge-source-sync:${run.id}`,
          sourceConfigGeneration: task.action.sourceConfigGeneration,
          sourceLifecycleGeneration: task.action.sourceLifecycleGeneration,
        });
        await recordUsageEvent(db, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          eventType: "knowledge_source_sync.fired",
          quantity: 1,
          unit: "run",
          sourceResourceType: "scheduled_task_run",
          sourceResourceId: run.id,
          initiator: input.initiator ?? {
            kind: "service",
            subjectId: "scheduler",
          },
          initiatorContext: {
            scheduledTaskId: task.id,
            scheduledTaskRunId: run.id,
          },
          origin: "scheduled_task",
          idempotencyKey: `usage:knowledge_source_sync.fired:${run.id}`,
        });
        if (run.status === "queued") {
          await updateScheduledTaskRun(db, task.workspaceId, run.id, {
            status: "dispatched",
            actionKind: "knowledge_source_sync",
          });
        }
        return {
          action: "knowledge_source_sync",
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          taskId: task.id,
          scheduledTaskRunId: run.id,
          sourceId: task.action.sourceId,
          overlapPolicy: task.overlapPolicy as "skip" | "buffer_one",
        };
      }
      const structuredAlertOccurrence = scheduledAlertOccurrenceIdentity({
        workspaceId: task.workspaceId,
        scheduledTaskId: task.id,
        metadata: task.metadata,
      });
      const alertOccurrence =
        task.runMode === "new_session_per_run" ? structuredAlertOccurrence : null;
      const incidentDeclaration = incidentTelemetryPreflightDeclaration(
        task.agentConfig,
        structuredAlertOccurrence !== null,
      );
      if (incidentDeclaration.action === "blocked") {
        return incidentDeclaration;
      }
      const taskPersonalConnectionDelegations = await getScheduledTaskPersonalConnectionDelegations(
        db,
        task.workspaceId,
        task.id,
      );
      let incidentPreflightRequired = incidentDeclaration.action === "required";
      if (incidentPreflightRequired) {
        const existingSessionId =
          task.runMode === "existing_session" ? task.targetSessionId : task.reusableSessionId;
        const canonicalAlertSession =
          task.runMode === "new_session_per_run" && alertOccurrence
            ? await getSessionByCreateIdempotencyKey(
                db,
                task.workspaceId,
                alertOccurrence.sessionCreateIdempotencyKey,
              )
            : null;
        const responderSession = existingSessionId
          ? await requireSession(db, task.workspaceId, existingSessionId)
          : canonicalAlertSession;
        const responder = await resolveIncidentTelemetryResponderMetadata({
          db,
          settings,
          task,
          session: responderSession,
          personalConnectionDelegations: taskPersonalConnectionDelegations,
        });
        const preflight = evaluateIncidentTelemetryPreflight({
          agentConfig: task.agentConfig,
          incidentTriggered: structuredAlertOccurrence !== null,
          alertOccurrenceLabels: structuredAlertOccurrence?.labels ?? null,
          responder,
        });
        if (preflight.action === "blocked") return preflight;
        incidentPreflightRequired = preflight.action === "ready";
      }
      const taskXaiProviderAccountAuthoritySnapshot =
        await getScheduledTaskXaiProviderAccountAuthoritySnapshot(db, task.workspaceId, task.id);
      // A scheduled bot selection was authorized when the task was written,
      // but connection status and tenant/role binding are mutable. Revalidate
      // before any session/model cost and never fall back to a personal Slack
      // OAuth grant when the selected bot has been revoked or changed.
      const slackBotConnection = task.agentConfig.slackBotConnectionId
        ? await requireOpenGeniSlackBotConnection(
            db,
            task.workspaceId,
            task.agentConfig.slackBotConnectionId,
          )
        : null;
      const slackBotMetadata = slackBotConnection
        ? openGeniSlackBotMetadata(slackBotConnection.metadata)
        : null;
      if (slackBotConnection && !slackBotMetadata) {
        throw new Error("OpenGeni Slack bot connection metadata is invalid");
      }
      const model = task.agentConfig.model ?? settings.openaiModel;
      const admissionDenial = await agentRunAdmissionDenial(service, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        model,
        requestedAgentRuns: input.agentRunUsageIdempotencyKey ? 0 : 1,
      });
      if (admissionDenial) {
        return { action: "blocked", reason: admissionDenial };
      }
      const deferredEvents: Array<{
        sessionId: string;
        events: Awaited<ReturnType<typeof appendSessionEvents>>;
      }> = [];
      const executeDispatch = async (dispatchDb: Database, deferPublications: boolean) => {
        if (incidentPreflightRequired) {
          const exactAuthority = await requireScheduledTaskIncidentAuthorityInTransaction(
            dispatchDb,
            {
              workspaceId: task.workspaceId,
              taskId: task.id,
            },
          );
          if (
            stableJson({
              task: exactAuthority.task,
              personalConnectionDelegations: exactAuthority.personalConnectionDelegations,
            }) !==
            stableJson({
              task,
              personalConnectionDelegations: taskPersonalConnectionDelegations,
            })
          ) {
            throw new IncidentTelemetryPreflightBlockedError("incident_preflight_metadata_missing");
          }
        }
        let run = await createScheduledTaskRun(dispatchDb, {
          workspaceId: task.workspaceId,
          taskId: task.id,
          triggerType: input.triggerType,
          producerKey:
            input.producerKey ??
            input.agentRunUsageIdempotencyKey ??
            `scheduled:${crypto.randomUUID()}`,
          scheduledAt: null,
        });
        await recordScheduledTaskFiredUsage(dispatchDb, task, run, input);
        if (run?.status === "dispatched" && run.sessionId && run.triggerEventId) {
          if (deferPublications) {
            return { kind: "replay" as const, run };
          }
          await recordUsageEvent(dispatchDb, {
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            eventType: "agent_run.created",
            quantity: 1,
            unit: "run",
            sourceResourceType: "scheduled_task_run",
            sourceResourceId: run.id,
            sessionId: run.sessionId,
            initiator: input.initiator ?? {
              kind: "service",
              subjectId: "scheduler",
            },
            initiatorContext: {
              scheduledTaskId: task.id,
              scheduledTaskRunId: run.id,
            },
            origin: "scheduled_task",
            idempotencyKey:
              input.agentRunUsageIdempotencyKey ?? `usage:agent_run.created:scheduled:${run.id}`,
          });
          const workflowId = workflowIdForSession(run.sessionId);
          const workflowWakeRevision = await enqueueSessionWorkflowWakeIfRunnable(dispatchDb, {
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
          return { kind: "complete" as const, result, run };
        }
        let result: DispatchScheduledTaskRunResult;
        try {
          const reasoningEffort =
            task.agentConfig.reasoningEffort ?? settings.openaiReasoningEffort;
          const sandboxBackend = task.agentConfig.sandboxBackend ?? settings.sandboxBackend;
          const goalSpec = task.agentConfig.goal ?? null;
          // Every dispatch carries the first-party MCP server; runtime visibility
          // still follows the session's exact selection and authorization.
          const taskTools = withFirstPartyTools(settings, task.agentConfig.tools);
          const existingSessionId =
            task.runMode === "existing_session" ? task.targetSessionId : task.reusableSessionId;
          if (task.runMode === "existing_session" && !existingSessionId) {
            throw new Error("scheduled task target session is unavailable");
          }
          if (
            task.runMode === "new_session_per_run" ||
            (task.runMode === "reusable_session" && !existingSessionId)
          ) {
            // The FK on scheduled_tasks.variable_set_id is ON DELETE RESTRICT, so
            // an attached variableSet must still exist here; fail closed if not.
            const variableSet = task.variableSetId
              ? await getVariableSet(dispatchDb, task.workspaceId, task.variableSetId)
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
              const rig = await getRig(dispatchDb, task.workspaceId, task.rigId);
              if (!rig || !rig.activeVersion) {
                throw new Error(`rig has no active version to bind: ${task.rigId}`);
              }
              frozenRigId = rig.id;
              frozenRigVersionId = rig.activeVersion.id;
            }
            let session: Awaited<ReturnType<typeof createSession>>;
            let sessionCreated = true;
            const taskMetadata = { ...task.agentConfig.metadata };
            delete taskMetadata[OPENGENI_SLACK_BOT_SESSION_METADATA_KEY];
            try {
              const sessionInput: Parameters<typeof createSession>[1] = {
                accountId: task.accountId,
                workspaceId: task.workspaceId,
                initialMessage: task.agentConfig.prompt,
                resources: task.agentConfig.resources,
                tools: taskTools,
                firstPartyMcpTools: resolveFirstPartyMcpToolPolicy(settings).default,
                metadata: {
                  ...taskMetadata,
                  model,
                  reasoningEffort,
                  scheduledTaskId: task.id,
                  ...(run ? { scheduledTaskRunId: run.id } : {}),
                  ...(slackBotConnection
                    ? {
                        [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: slackBotConnection.id,
                      }
                    : {}),
                },
                createdBy: {
                  kind: "service",
                  subjectId: "scheduler",
                  label: "OpenGeni scheduler",
                },
                createdByContext: {
                  scheduledTaskId: task.id,
                  ...(run ? { scheduledTaskRunId: run.id } : {}),
                },
                model,
                sandboxBackend,
                variableSetId: task.variableSetId ?? null,
                rigId: frozenRigId,
                rigVersionId: frozenRigVersionId,
                personalConnectionDelegations: taskPersonalConnectionDelegations,
                initialXaiProviderAccountAuthoritySnapshot: taskXaiProviderAccountAuthoritySnapshot,
                maxNestedAgentDepthOverride: task.agentConfig.maxNestedAgentDepth ?? null,
                // The durable agent config was privilege-checked when the task
                // was created/updated. Preserve that explicit policy if a broader
                // workspace/deployment limit is narrowed before a later fire.
                allowNestedAgentDepthIncrease: true,
                subjectId: `scheduled_task:${task.id}`,
                ...(incidentPreflightRequired
                  ? {
                      beforeCreateCommit: async (tx, sessionId) => {
                        const exactSession = await requireSession(tx, task.workspaceId, sessionId);
                        const exactAuthority =
                          await requireScheduledTaskIncidentAuthorityInTransaction(tx, {
                            workspaceId: task.workspaceId,
                            taskId: task.id,
                          });
                        const exactResponder = await resolveIncidentTelemetryResponderMetadata({
                          db: tx,
                          settings,
                          task: exactAuthority.task,
                          session: exactSession,
                          personalConnectionDelegations:
                            exactAuthority.personalConnectionDelegations,
                        });
                        const exactPreflight = evaluateIncidentTelemetryPreflight({
                          agentConfig: exactAuthority.task.agentConfig,
                          incidentTriggered: structuredAlertOccurrence !== null,
                          alertOccurrenceLabels: structuredAlertOccurrence?.labels ?? null,
                          responder: exactResponder,
                        });
                        if (exactPreflight.action === "blocked") {
                          throw new IncidentTelemetryPreflightBlockedError(exactPreflight.reason);
                        }
                      },
                    }
                  : {}),
              };
              if (alertOccurrence) {
                const created = await createSessionWithIdempotencyKeyResult(dispatchDb, {
                  ...sessionInput,
                  createIdempotencyKey: alertOccurrence.sessionCreateIdempotencyKey,
                });
                if (created.denied) {
                  throw new SessionSpawnDeniedDbError(created.denial);
                }
                session = created.session;
                sessionCreated = created.created;
              } else {
                session = await createSession(dispatchDb, sessionInput);
              }
            } catch (error) {
              if (error instanceof IncidentTelemetryPreflightBlockedError) {
                throw error;
              }
              if (error instanceof SessionSpawnDeniedDbError) {
                throw new Error(`${error.denial.code}: denial=${error.denial.id}`, {
                  cause: error,
                });
              }
              throw error;
            }
            const scheduledRun = run;
            if (!sessionCreated) {
              assertReusableSessionRevivable(session.status);
              if ((session.variableSetId ?? null) !== (task.variableSetId ?? null)) {
                throw new Error(
                  "scheduled alert occurrence variableSet attachment does not match its canonical session",
                );
              }
              if (
                scheduledSlackBotConnectionId(session.metadata) !==
                (task.agentConfig.slackBotConnectionId ?? null)
              ) {
                throw new Error(
                  "scheduled alert occurrence OpenGeni Slack bot binding does not match its canonical session",
                );
              }
            }
            let workflowId: string;
            if (alertOccurrence) {
              const started = await initializeSessionStartAtomically(dispatchDb, {
                accountId: task.accountId,
                workspaceId: task.workspaceId,
                sessionId: session.id,
                reasoningEffortFallback: reasoningEffort,
                createdEventPayload: {
                  scheduledTaskId:
                    typeof session.metadata.scheduledTaskId === "string"
                      ? session.metadata.scheduledTaskId
                      : task.id,
                  scheduledTaskRunId:
                    typeof session.metadata.scheduledTaskRunId === "string"
                      ? session.metadata.scheduledTaskRunId
                      : run.id,
                  // Names/ids only; never values.
                  ...(variableSet
                    ? {
                        variableSetId: variableSet.id,
                        variableSetName: variableSet.name,
                      }
                    : {}),
                  ...(slackBotConnection && slackBotMetadata
                    ? {
                        slackBotConnection: {
                          credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
                          credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
                          connectionId: slackBotConnection.id,
                          slackTeamId: slackBotMetadata.slackTeamId,
                        },
                      }
                    : {}),
                },
                goal: goalSpec
                  ? {
                      text: goalSpec.text,
                      successCriteria: goalSpec.successCriteria ?? null,
                      maxAutoContinuations: goalSpec.maxAutoContinuations ?? null,
                      ...(goalSpec.mutationPolicy
                        ? { mutationPolicy: goalSpec.mutationPolicy }
                        : {}),
                      createdBy: "scheduled_task",
                    }
                  : null,
                deferInitialTurn: true,
                deferredStatus: "queued",
              });
              workflowId = started.temporalWorkflowId;
              if (started.events.length > 0) {
                if (deferPublications) {
                  deferredEvents.push({
                    sessionId: session.id,
                    events: started.events,
                  });
                } else {
                  await publishDurableSessionEvents(
                    bus,
                    task.workspaceId,
                    session.id,
                    started.events,
                  );
                }
              }
            } else {
              const goal =
                sessionCreated && goalSpec
                  ? await createSessionGoal(dispatchDb, {
                      accountId: task.accountId,
                      workspaceId: task.workspaceId,
                      sessionId: session.id,
                      text: goalSpec.text,
                      successCriteria: goalSpec.successCriteria ?? null,
                      maxAutoContinuations: goalSpec.maxAutoContinuations ?? null,
                      createdBy: "scheduled_task",
                    })
                  : null;
              workflowId = workflowIdForSession(session.id);
              await setTemporalWorkflowId(dispatchDb, task.workspaceId, session.id, workflowId);
              if (task.runMode === "reusable_session") {
                await updateScheduledTask(dispatchDb, task.workspaceId, task.id, {
                  reusableSessionId: session.id,
                });
              }
              if (sessionCreated) {
                const createdEvents: Parameters<typeof appendSessionEvents>[3] = [
                  {
                    type: "session.created",
                    payload: {
                      status: session.status,
                      createdBy: session.createdBy,
                      scheduledTaskId: task.id,
                      scheduledTaskRunId: run.id,
                      // Names/ids only; never values.
                      ...(variableSet
                        ? {
                            variableSetId: variableSet.id,
                            variableSetName: variableSet.name,
                          }
                        : {}),
                      ...(slackBotConnection && slackBotMetadata
                        ? {
                            slackBotConnection: {
                              credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
                              credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
                              connectionId: slackBotConnection.id,
                              slackTeamId: slackBotMetadata.slackTeamId,
                            },
                          }
                        : {}),
                    },
                  },
                  ...(goal
                    ? [
                        {
                          type: "goal.set" as const,
                          payload: {
                            goalId: goal.id,
                            text: goal.text,
                            ...(goal.successCriteria
                              ? { successCriteria: goal.successCriteria }
                              : {}),
                            version: goal.version,
                            actor: "scheduled_task",
                            replaced: false,
                          },
                        },
                      ]
                    : []),
                  {
                    type: "session.status.changed",
                    payload: { status: session.status },
                  },
                ];
                if (deferPublications) {
                  deferredEvents.push({
                    sessionId: session.id,
                    events: await appendSessionEvents(
                      dispatchDb,
                      task.workspaceId,
                      session.id,
                      createdEvents,
                    ),
                  });
                } else {
                  await appendAndPublishEvents(
                    dispatchDb,
                    bus,
                    task.workspaceId,
                    session.id,
                    createdEvents,
                  );
                }
              }
            }
            const scheduledUpdate = await addSessionSystemUpdateWithSourceMutation(
              dispatchDb,
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
                lineage: {
                  scheduledTaskId: task.id,
                  scheduledTaskRunId: run.id,
                  ...(taskXaiProviderAccountAuthoritySnapshot.scope === "user" &&
                  task.createdBy.kind === "subject"
                    ? { xaiAuthoritySubjectId: task.createdBy.subjectId }
                    : {}),
                },
                personalConnectionDelegations: taskPersonalConnectionDelegations,
                xaiProviderAccountAuthoritySnapshot: taskXaiProviderAccountAuthoritySnapshot,
              },
              async (tx, wakeEventId) => {
                if (!wakeEventId) throw new Error("Scheduled delivery has no wake event");
                await settleScheduledTaskRunInTransaction(tx, {
                  workspaceId: task.workspaceId,
                  runId: scheduledRun.id,
                  sessionId: session.id,
                  triggerEventId: wakeEventId,
                  status: "dispatched",
                });
              },
              incidentPreflightRequired
                ? {
                    prepareSource: async (tx, sessionId) =>
                      await prepareIncidentTelemetrySource({
                        tx,
                        settings,
                        taskId: task.id,
                        workspaceId: task.workspaceId,
                        sessionId,
                        alertOccurrenceLabels: structuredAlertOccurrence?.labels ?? null,
                      }),
                  }
                : undefined,
            );
            if (scheduledUpdate.reason === "session_cancelled") {
              throw new Error("new scheduled session was cancelled during dispatch");
            }
            if (scheduledUpdate.added && scheduledUpdate.events.length > 0) {
              if (deferPublications) {
                deferredEvents.push({
                  sessionId: session.id,
                  events: scheduledUpdate.events,
                });
              } else {
                await publishDurableSessionEvents(
                  bus,
                  task.workspaceId,
                  session.id,
                  scheduledUpdate.events,
                );
              }
            }
            result = {
              action: sessionCreated ? "start" : "signal",
              accountId: task.accountId,
              workspaceId: task.workspaceId,
              sessionId: session.id,
              triggerEventId: scheduledUpdate.wakeEventId,
              workflowId,
              workflowWakeRevision: scheduledUpdate.workflowWakeRevision,
            };
          } else {
            if (!run) throw new Error("scheduled task run was not created");
            const scheduledRun = run;
            const session = await requireSession(dispatchDb, task.workspaceId, existingSessionId!);
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
            if (
              scheduledSlackBotConnectionId(session.metadata) !==
              (task.agentConfig.slackBotConnectionId ?? null)
            ) {
              throw new Error(
                "scheduled task OpenGeni Slack bot binding does not match its reusable session",
              );
            }
            // A recurring "maintain X" task re-establishes its objective on every
            // fire: replace the goal text, reactivate it, and reset the counters.
            const reusableGoal =
              task.runMode === "reusable_session" && goalSpec && run.status === "queued"
                ? await upsertSessionGoal(dispatchDb, {
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
                dispatchDb,
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
                { activity: "semantic" },
              );
              if (deferPublications) {
                deferredEvents.push({
                  sessionId: session.id,
                  events: goalEvents,
                });
              } else {
                await publishDurableSessionEvents(bus, task.workspaceId, session.id, goalEvents);
              }
            }
            const bundled = await addSessionSystemUpdateWithSourceMutation(
              dispatchDb,
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
                lineage: {
                  scheduledTaskId: task.id,
                  scheduledTaskRunId: run.id,
                  ...(taskXaiProviderAccountAuthoritySnapshot.scope === "user" &&
                  task.createdBy.kind === "subject"
                    ? { xaiAuthoritySubjectId: task.createdBy.subjectId }
                    : {}),
                },
                personalConnectionDelegations: taskPersonalConnectionDelegations,
                xaiProviderAccountAuthoritySnapshot: taskXaiProviderAccountAuthoritySnapshot,
              },
              async (tx, wakeEventId) => {
                if (task.runMode === "existing_session") {
                  await requireScheduledTaskTargetInTransaction(tx, {
                    workspaceId: task.workspaceId,
                    taskId: task.id,
                    targetSessionId: session.id,
                  });
                }
                if (!wakeEventId) throw new Error("Scheduled delivery has no wake event");
                await settleScheduledTaskRunInTransaction(tx, {
                  workspaceId: task.workspaceId,
                  runId: scheduledRun.id,
                  sessionId: session.id,
                  triggerEventId: wakeEventId,
                  status: "dispatched",
                });
              },
              incidentPreflightRequired
                ? {
                    prepareSource: async (tx, sessionId) =>
                      await prepareIncidentTelemetrySource({
                        tx,
                        settings,
                        taskId: task.id,
                        workspaceId: task.workspaceId,
                        sessionId,
                        alertOccurrenceLabels: structuredAlertOccurrence?.labels ?? null,
                      }),
                  }
                : undefined,
            );
            if (bundled.reason === "session_cancelled") {
              throw new Error(`scheduled wake was not added: ${bundled.reason}`);
            }
            if (bundled.added && bundled.events.length > 0) {
              if (deferPublications) {
                deferredEvents.push({
                  sessionId: session.id,
                  events: bundled.events,
                });
              } else {
                await publishDurableSessionEvents(
                  bus,
                  task.workspaceId,
                  session.id,
                  bundled.events,
                );
              }
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
          if (!incidentPreflightRequired) {
            await markScheduledTaskRunFailedIfQueued(
              dispatchDb,
              task.workspaceId,
              run.id,
              error instanceof Error ? error.message : String(error),
            ).catch(() => undefined);
          }
          throw error;
        }
        await recordUsageEvent(dispatchDb, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          eventType: "agent_run.created",
          quantity: 1,
          unit: "run",
          sourceResourceType: "scheduled_task_run",
          sourceResourceId: run.id,
          sessionId: result.sessionId,
          initiator: input.initiator ?? {
            kind: "service",
            subjectId: "scheduler",
          },
          initiatorContext: {
            scheduledTaskId: task.id,
            scheduledTaskRunId: run.id,
          },
          origin: "scheduled_task",
          idempotencyKey:
            input.agentRunUsageIdempotencyKey ?? `usage:agent_run.created:scheduled:${run.id}`,
        });
        return { kind: "complete" as const, result, run };
      };

      let dispatchOutcome: Awaited<ReturnType<typeof executeDispatch>>;
      try {
        dispatchOutcome = incidentPreflightRequired
          ? await withSessionActivityRlsContext(
              db,
              { accountId: task.accountId, workspaceId: task.workspaceId },
              async (tx) => await executeDispatch(tx, true),
            )
          : await executeDispatch(db, false);
      } catch (error) {
        if (error instanceof IncidentTelemetryPreflightBlockedError) {
          return { action: "blocked", reason: error.reason };
        }
        throw error;
      }
      if (dispatchOutcome.kind === "replay") {
        return await replayScheduledTaskDispatch({
          db,
          wakeSessionWorkflow,
          task,
          run: dispatchOutcome.run,
          input,
        });
      }
      for (const deferred of deferredEvents) {
        await publishDurableSessionEvents(
          bus,
          task.workspaceId,
          deferred.sessionId,
          deferred.events,
        );
      }
      const result = dispatchOutcome.result;
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

class IncidentTelemetryPreflightBlockedError extends Error {
  constructor(readonly reason: IncidentTelemetryPreflightBlockReason) {
    super(reason);
    this.name = "IncidentTelemetryPreflightBlockedError";
  }
}

async function prepareIncidentTelemetrySource(input: {
  tx: Database;
  settings: ControlActivityServices["settings"];
  taskId: string;
  workspaceId: string;
  sessionId: string;
  alertOccurrenceLabels: Readonly<Record<string, string>> | null;
}) {
  const session = await requireSession(input.tx, input.workspaceId, input.sessionId);
  const { task, personalConnectionDelegations } =
    await requireScheduledTaskIncidentAuthorityInTransaction(input.tx, {
      workspaceId: input.workspaceId,
      taskId: input.taskId,
    });
  const responder = await resolveIncidentTelemetryResponderMetadata({
    db: input.tx,
    settings: input.settings,
    task,
    session,
    personalConnectionDelegations,
  });
  const preflight = evaluateIncidentTelemetryPreflight({
    agentConfig: task.agentConfig,
    incidentTriggered: input.alertOccurrenceLabels !== null,
    alertOccurrenceLabels: input.alertOccurrenceLabels,
    responder,
  });
  if (preflight.action === "blocked") {
    throw new IncidentTelemetryPreflightBlockedError(preflight.reason);
  }
  const fence = incidentTelemetryAuthorityFence({
    task,
    responder,
    alertOccurrenceLabels: input.alertOccurrenceLabels,
  });
  if (!fence) {
    throw new IncidentTelemetryPreflightBlockedError("incident_preflight_metadata_missing");
  }
  return {
    lineage: {
      [INCIDENT_TELEMETRY_AUTHORITY_FENCE_LINEAGE_KEY]: fence,
    },
  };
}

async function recordScheduledTaskFiredUsage(
  db: Database,
  task: ScheduledTask,
  run: ScheduledTaskRun,
  input: DispatchScheduledTaskRunInput,
): Promise<void> {
  await recordUsageEvent(db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    eventType: "scheduled_task.fired",
    quantity: 1,
    unit: "run",
    sourceResourceType: "scheduled_task_run",
    sourceResourceId: run.id,
    initiator: input.initiator ?? { kind: "service", subjectId: "scheduler" },
    initiatorContext: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
    origin: "scheduled_task",
    idempotencyKey: `usage:scheduled_task.fired:${run.id}`,
  });
}

async function replayScheduledTaskDispatch(input: {
  db: Database;
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
  task: ScheduledTask;
  run: ScheduledTaskRun;
  input: DispatchScheduledTaskRunInput;
}): Promise<DispatchScheduledTaskRunResult> {
  if (!input.run.sessionId || !input.run.triggerEventId) {
    throw new Error("dispatched scheduled task run is missing its delivery identity");
  }
  const sessionId = input.run.sessionId;
  const triggerEventId = input.run.triggerEventId;
  await recordUsageEvent(input.db, {
    accountId: input.task.accountId,
    workspaceId: input.task.workspaceId,
    eventType: "agent_run.created",
    quantity: 1,
    unit: "run",
    sourceResourceType: "scheduled_task_run",
    sourceResourceId: input.run.id,
    sessionId,
    initiator: input.input.initiator ?? {
      kind: "service",
      subjectId: "scheduler",
    },
    initiatorContext: {
      scheduledTaskId: input.task.id,
      scheduledTaskRunId: input.run.id,
    },
    origin: "scheduled_task",
    idempotencyKey:
      input.input.agentRunUsageIdempotencyKey ??
      `usage:agent_run.created:scheduled:${input.run.id}`,
  });
  const workflowId = workflowIdForSession(sessionId);
  const workflowWakeRevision = await enqueueSessionWorkflowWakeIfRunnable(input.db, {
    accountId: input.task.accountId,
    workspaceId: input.task.workspaceId,
    sessionId,
    temporalWorkflowId: workflowId,
    reason: "scheduled_retry",
  });
  const result = {
    action: input.task.runMode === "new_session_per_run" ? "start" : "signal",
    accountId: input.task.accountId,
    workspaceId: input.task.workspaceId,
    sessionId,
    triggerEventId,
    workflowId,
    workflowWakeRevision,
  } as const;
  if (input.wakeSessionWorkflow && workflowWakeRevision !== null) {
    await input.wakeSessionWorkflow({
      accountId: result.accountId,
      workspaceId: result.workspaceId,
      sessionId: result.sessionId,
      workflowId: result.workflowId,
      wakeRevision: workflowWakeRevision,
    });
  }
  return result;
}

function knowledgeSourceSyncEffectivelyPaused(task: {
  status: "active" | "paused";
  metadata: Record<string, unknown>;
}): boolean {
  if (task.status === "paused") return true;
  const value = task.metadata.knowledgeSourceSync;
  if (!value || typeof value !== "object") return false;
  const control = value as Record<string, unknown>;
  return control.sourceEnabled === false || control.connectionPaused === true;
}
