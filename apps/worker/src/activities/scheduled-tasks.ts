import {
  AUTOMATIC_SESSION_TITLE_FALLBACK,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  resolveWorkspaceCodexCompactionDefault,
  SCHEDULED_TASK_OCCURRENCE_PAYLOAD_MAX_BYTES,
  ScheduledTaskRunAcceptedExecution,
  normalizeAutomaticSessionTitle,
  scheduledOccurrencePayloadUtf8Bytes,
  stableJson,
  type ScheduledTask,
  type ScheduledTaskRun,
} from "@opengeni/contracts";
import {
  defaultSessionMcpServerIds,
  openGeniSlackBotMetadata,
  requireOpenGeniSlackBotConnection,
  resolveSessionToolPolicy,
  scheduledSlackBotConnectionId,
  swapActiveSandbox,
} from "@opengeni/core";
import {
  appendSessionEvents,
  addSessionSystemUpdateWithSourceMutation,
  bindScheduledTaskRunSessionInTransaction,
  createScheduledTaskRun,
  createSession,
  createSessionWithIdempotencyKeyResult,
  enqueueSessionWorkflowWakeIfRunnable,
  failScheduledGeneratedSessionRoute,
  getScheduledTask,
  getScheduledTaskRunAcceptedExecution,
  getScheduledTaskRunByProducerKey,
  getScheduledTargetSessionExecution,
  ensureKnowledgeSourceSyncState,
  getScheduledTaskPersonalConnectionDelegations,
  getScheduledTaskRunPersonalResourceAuthority,
  getScheduledTaskPersonalResourceAuthoritySubject,
  getScheduledTaskRevisionAuthority,
  getScheduledTaskXaiProviderAccountAuthoritySnapshot,
  getEnrollment,
  getSandbox,
  getRig,
  getScheduledScopedRigVersionMetadata,
  getNestedAgentDepthDeploymentPolicy,
  getSessionByCreateIdempotencyKey,
  getVariableSet,
  isCodexBilledModel,
  initializeSessionStartAtomically,
  materializeScheduledTaskReusableSessionFromRun,
  listEnabledMcpCapabilityServerIds,
  listInstalledApiIntegrationServerIdsForDelegations,
  markScheduledTaskRunFailedIfQueued,
  markScheduledTaskRunSkippedIfQueued,
  recordKnowledgeSourceSyncWake,
  recordUsageEvent,
  requireScheduledTaskIncidentAuthorityInTransaction,
  requireSession,
  requireWorkspace,
  settleScheduledTaskRunInTransaction,
  SessionSpawnDeniedDbError,
  updateScheduledTaskRun,
  updateSessionTitleWithEvent,
  upsertScheduledSessionGoalForRun,
  withSessionActivityRlsContext,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import { resolveFirstPartyMcpToolPolicy } from "@opengeni/config";
import { Context } from "@temporalio/activity";
import {
  assertReusableSessionRevivable,
  scheduledUserMessagePayload,
  workflowIdForSession,
} from "./common";
import { withFirstPartyTools } from "./goals";
import { agentRunAdmissionDenial } from "./agent-run-admission";
import {
  scheduledAlertOccurrenceIdentity,
  scheduledAlertResponderSessionCreateIdempotencyKey,
} from "../scheduled-alert-occurrence";
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

type ScheduledTemporalActivityIdentity = {
  namespace: string;
  workflowExecution?: { workflowId: string; runId: string };
  activityId: string;
};

export function scheduledTaskRunProducerKey(
  input: DispatchScheduledTaskRunInput,
  suppliedActivityIdentity?: ScheduledTemporalActivityIdentity,
): string {
  if (input.producerKey) return input.producerKey;
  if (input.triggerType !== "scheduled") return input.agentRunUsageIdempotencyKey;

  let info = suppliedActivityIdentity;
  if (!info) {
    try {
      info = Context.current().info;
    } catch {
      throw new Error(
        "scheduled task delivery without a producer key requires a Temporal activity execution",
      );
    }
  }
  if (!info.workflowExecution) {
    throw new Error("scheduled task Temporal activity is missing its workflow execution identity");
  }
  return `scheduled-temporal:${stableJson({
    namespace: info.namespace,
    workflowId: info.workflowExecution.workflowId,
  })}`;
}

/**
 * Display title for a session the scheduler generates for a task.
 *
 * A scheduled session's `initialMessage` is the task prompt, byte-identical for
 * every run. The task name is the short human-chosen label that actually
 * identifies it, so that is the title.
 *
 * The title is the task name and NOTHING else. It deliberately does not name the
 * run's fire instant, for two independent reasons:
 *
 *   - No run mode guarantees one run per session. `reusable_session` generates
 *     its session on the first fire and then reuses it forever, and even under
 *     `new_session_per_run` alert-occurrence redelivery converges several runs
 *     onto one canonical responder session. `existing_session` never generates a
 *     session at all, so the scheduler never titles one. A run-specific fact
 *     frozen into the title is therefore right for the generating run and a lie
 *     for every run that lands in the same session afterwards.
 *   - A title is one stored string shown to every viewer, while every surface
 *     that renders a run's fire instant renders it viewer-local: the rail row
 *     prints the title beside `relativeTimeLabel(session.updatedAt)`, and the
 *     Schedules run list prints `formatTimestamp(run.firedAt)`, which is
 *     `toLocaleString()`. A wall clock stored in the title therefore disagrees
 *     with the time printed next to it for every viewer outside whichever zone
 *     it was rendered in. The task's own `timeZone` is no escape: it labels the
 *     schedule rule ("Mon Wed 09:00 Europe/Oslo"), not the rendering of a run,
 *     which stays viewer-local. No stored clock can agree with a viewer-local
 *     one, so the title carries none and the instant stays on the surfaces that
 *     already render it correctly.
 *
 * Dropping the clock settles the determinism constraint outright rather than
 * working around it: the same run titled by the normal dispatch or by a later
 * recovery in a different worker process derives one string from `task.name`
 * alone, with no Intl call and so no host ICU or tzdata build to make the two
 * texts differ.
 */
export function scheduledTaskSessionTitle(taskName: string): string {
  return normalizeAutomaticSessionTitle(taskName) ?? "Scheduled run";
}

/**
 * Title a session the scheduler generated, and emit the same `session.title_set`
 * event every other title write in the product emits.
 *
 * This uses the same database operation as `@opengeni/core`
 * `updateSessionTitle`: the clobber/CAS guarded row update and its identical
 * `session.title_set` append commit together under the session event lock. A
 * newer writer therefore cannot land between the authoritative row change and
 * an older event. Without the event a live subscriber sees nothing:
 * `packages/react/src/hooks/use-session.ts` patches an open session's title
 * exclusively on `session.title_set`, so a bare row write leaves the viewer on
 * the stale title until an unrelated refetch.
 *
 * The core wrapper itself is not called, because its only additional behavior is
 * `requireSessionAuthorization(grant, ...)` - a check on an HTTP/MCP caller's
 * grant. The scheduler has no such grant; it is naming a session it just created
 * itself moments earlier. Satisfying that gate would mean fabricating a subject,
 * and the gate would then answer for it: a session later transitioned to
 * `user_private` denies any actor whose subject is not the owner
 * (`packages/core/src/session-authorization.ts`), which would turn naming a
 * session into a way to fail a dispatch. Authorization belongs to callers with
 * grants; the durable write and its event are the part that is shared.
 *
 * Only the neutral create fallback is replaced. A keyed create replay can hand
 * back a session that has already run, and recovery re-enters this path for a
 * session the dead dispatch may already have titled; in both cases whatever the
 * agent or a human chose is newer truth than this stamp. The fallback check is
 * part of the UPDATE itself, not a stale session-object precheck, so a title
 * committed between dispatch read and stamp cannot be overwritten.
 *
 * `source: "agent"` is deliberate, and is the only system-assigned value the
 * schema offers (`Session.titleSource` is "user" | "agent" | null). The database
 * clobber guard pins only a `user` title, so this title still lets the agent
 * rename its own session through set_session_title, and a human rename still
 * wins permanently. Writing "user" here would quietly make every scheduled
 * session unrenameable by the agent that runs in it.
 *
 * Returns the appended events so the caller can route them through the same
 * defer-or-publish path as every other event this dispatch produces.
 */
export async function stampScheduledSessionTitle(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    taskName: string;
  },
): Promise<Awaited<ReturnType<typeof updateSessionTitleWithEvent>>["events"]> {
  const title = scheduledTaskSessionTitle(input.taskName);
  const result = await updateSessionTitleWithEvent(db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    title,
    source: "agent",
    expectedCurrent: {
      title: AUTOMATIC_SESSION_TITLE_FALLBACK,
      source: "agent",
    },
  });
  return result.events;
}

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
      const stableProducerKey = scheduledTaskRunProducerKey(input);
      const priorRun = await getScheduledTaskRunByProducerKey(db, {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        triggerType: input.triggerType,
        producerKey: stableProducerKey,
      });
      if (priorRun?.actionKind === "agent_turn") {
        const acceptedExecution = await getScheduledTaskRunAcceptedExecution(db, {
          workspaceId: input.workspaceId,
          runId: priorRun.id,
        });
        if (!acceptedExecution) {
          if (
            priorRun.status === "succeeded" ||
            priorRun.status === "failed" ||
            priorRun.status === "skipped"
          ) {
            return scheduledRunTerminalResult(priorRun.error);
          }
          throw new Error("scheduled agent run is missing accepted execution truth");
        }
        await recordScheduledTaskFiredUsage(db, acceptedExecution, priorRun);
        if (priorRun.status === "dispatched") {
          return await replayScheduledTaskDispatch({
            db,
            wakeSessionWorkflow,
            task: acceptedExecution.task,
            run: priorRun,
            acceptedExecution,
          });
        }
        if (priorRun.status === "queued") {
          try {
            return await recoverBoundScheduledTaskDispatch({
              db,
              bus,
              settings,
              wakeSessionWorkflow,
              run: priorRun,
              acceptedExecution,
              input,
            });
          } catch (error) {
            const terminalError = scheduledRunRecoveryTerminalError(error);
            if (!terminalError) throw error;
            await markScheduledTaskRunFailedIfQueued(
              db,
              priorRun.workspaceId,
              priorRun.id,
              terminalError.code,
            );
            return scheduledRunTerminalResult(terminalError.code);
          }
        }
        if (priorRun.status === "succeeded") {
          if (!priorRun.sessionId || !priorRun.triggerEventId) {
            throw new Error("succeeded scheduled run is missing its delivery identity");
          }
          return {
            action: acceptedExecution.task.runMode === "new_session_per_run" ? "start" : "signal",
            accountId: acceptedExecution.task.accountId,
            workspaceId: acceptedExecution.task.workspaceId,
            sessionId: priorRun.sessionId,
            triggerEventId: priorRun.triggerEventId,
            workflowId: workflowIdForSession(priorRun.sessionId),
            workflowWakeRevision: null,
          };
        }
        if (priorRun.status === "failed" || priorRun.status === "skipped") {
          return scheduledRunTerminalResult(priorRun.error);
        }
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
          taskAuthorityRevision: task.authorityRevision,
          taskExecutionDigest: task.executionDigest,
          triggerType: input.triggerType,
          producerKey: stableProducerKey,
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
          producerKey: stableProducerKey,
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
      if (task.status !== "active") {
        return { action: "blocked", reason: "scheduled_task_paused" };
      }
      const structuredAlertOccurrence = scheduledAlertOccurrenceIdentity({
        workspaceId: task.workspaceId,
        scheduledTaskId: task.id,
        metadata: task.metadata,
      });
      const alertOccurrence =
        task.runMode === "new_session_per_run" ? structuredAlertOccurrence : null;
      const alertResponderSessionCreateIdempotencyKey = alertOccurrence
        ? scheduledAlertResponderSessionCreateIdempotencyKey({
            occurrence: alertOccurrence,
            taskAuthorityRevision: task.authorityRevision,
            taskExecutionDigest: task.executionDigest,
          })
        : null;
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
      const taskConnectionAuthoritySubjects = [
        ...new Set(
          taskPersonalConnectionDelegations.map((delegation) => delegation.ownerSubjectId),
        ),
      ];
      if (taskConnectionAuthoritySubjects.length > 1) {
        throw new Error("scheduled connection authority has multiple causal humans");
      }
      const taskConnectionAuthoritySubjectId = taskConnectionAuthoritySubjects[0] ?? null;
      const taskPersonalResourceAuthoritySubjectId =
        await getScheduledTaskPersonalResourceAuthoritySubject(db, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          taskId: task.id,
          taskAuthorityRevision: task.authorityRevision,
        });
      const taskRevisionAuthority = await getScheduledTaskRevisionAuthority(db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        taskAuthorityRevision: task.authorityRevision,
      });
      if (
        taskConnectionAuthoritySubjectId &&
        taskPersonalResourceAuthoritySubjectId &&
        taskConnectionAuthoritySubjectId !== taskPersonalResourceAuthoritySubjectId
      ) {
        throw new Error("scheduled authority classes have different causal humans");
      }
      const taskAuthoritySubjectId =
        taskRevisionAuthority?.subjectId ??
        taskPersonalResourceAuthoritySubjectId ??
        taskConnectionAuthoritySubjectId;
      const model = task.agentConfig.model ?? settings.openaiModel;
      const reasoningEffort = task.agentConfig.reasoningEffort ?? settings.openaiReasoningEffort;
      let sandboxBackend = task.agentConfig.sandboxBackend ?? settings.sandboxBackend;
      let sandboxOs: "linux" | "macos" | "windows" = "linux";
      const taskTools = withFirstPartyTools(settings, task.agentConfig.tools);
      const firstPartyMcpTools = resolveFirstPartyMcpToolPolicy(settings).default;
      const generatedTarget =
        task.runMode === "new_session_per_run" ||
        (task.runMode === "reusable_session" && task.reusableSessionId === null);
      if (generatedTarget && task.agentConfig.machineTarget) {
        const access = {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          subjectId: taskAuthoritySubjectId ?? task.createdBy.subjectId,
        };
        const machine = await getSandbox(
          db,
          access,
          task.agentConfig.machineTarget.targetSandboxId,
        );
        if (
          !machine ||
          machine.kind !== "selfhosted" ||
          !machine.enrollmentId ||
          machine.scope === "user"
        ) {
          throw new Error("scheduled Connected Machine target is unavailable");
        }
        const enrollment = await getEnrollment(db, access, machine.enrollmentId);
        if (!enrollment || enrollment.status !== "active") {
          throw new Error("scheduled Connected Machine enrollment is unavailable");
        }
        sandboxBackend = "selfhosted";
        sandboxOs = enrollment.os;
      } else if (generatedTarget && sandboxBackend === "selfhosted") {
        throw new Error("self-hosted scheduled task has no Connected Machine target");
      }
      const generatedSessionDepthPolicy = generatedTarget
        ? await (async () => {
            const workspace = await requireWorkspace(db, task.workspaceId);
            const deployment = await getNestedAgentDepthDeploymentPolicy(db);
            const taskOverride = task.agentConfig.maxNestedAgentDepth ?? null;
            const workspaceOverride =
              typeof workspace.settings.maxNestedAgentDepth === "number"
                ? workspace.settings.maxNestedAgentDepth
                : null;
            return taskOverride !== null
              ? {
                  effectiveMaxNestedAgentDepth: taskOverride,
                  nestedAgentDepthPolicySource: "session" as const,
                  codexCompactionMode: isCodexBilledModel(model)
                    ? resolveWorkspaceCodexCompactionDefault(workspace.settings)
                    : ("portable" as const),
                }
              : workspaceOverride !== null
                ? {
                    effectiveMaxNestedAgentDepth: workspaceOverride,
                    nestedAgentDepthPolicySource: "workspace" as const,
                    codexCompactionMode: isCodexBilledModel(model)
                      ? resolveWorkspaceCodexCompactionDefault(workspace.settings)
                      : ("portable" as const),
                  }
                : {
                    effectiveMaxNestedAgentDepth: deployment.maxNestedAgentDepth,
                    nestedAgentDepthPolicySource: deployment.policySource,
                    codexCompactionMode: isCodexBilledModel(model)
                      ? resolveWorkspaceCodexCompactionDefault(workspace.settings)
                      : ("portable" as const),
                  };
          })()
        : null;
      const acceptedTargetSessionId = generatedTarget
        ? null
        : task.runMode === "existing_session"
          ? task.targetSessionId
          : task.reusableSessionId;
      // A targeted task whose exact session was deleted has no target to
      // resolve; database admission settles that occurrence terminally
      // (`scheduled_target_session_unavailable`) instead of retrying forever.
      const targetSessionExecutionBase = acceptedTargetSessionId
        ? await getScheduledTargetSessionExecution(
            db,
            task.workspaceId,
            acceptedTargetSessionId,
            taskAuthoritySubjectId,
          )
        : null;
      const targetSessionExecution = targetSessionExecutionBase
        ? await (async () => {
            const [capabilityServerIds, apiIntegrationServerIds] = await Promise.all([
              listEnabledMcpCapabilityServerIds(db, task.workspaceId),
              listInstalledApiIntegrationServerIdsForDelegations(
                db,
                task.workspaceId,
                taskPersonalConnectionDelegations,
              ),
            ]);
            const workspaceDefaultMcpServerIds = new Set(
              settings.mcpServers.map((server) => server.id),
            );
            for (const id of capabilityServerIds) workspaceDefaultMcpServerIds.add(id);
            for (const id of apiIntegrationServerIds) workspaceDefaultMcpServerIds.add(id);
            const availableMcpServerIds = new Set(workspaceDefaultMcpServerIds);
            for (const id of targetSessionExecutionBase.mcpServerIds) {
              availableMcpServerIds.add(id);
            }
            const effective = resolveSessionToolPolicy({
              toolPolicy: targetSessionExecutionBase.toolPolicy,
              sessionTools: targetSessionExecutionBase.tools,
              availableMcpServerIds,
              defaultMcpServerIds: defaultSessionMcpServerIds(
                [...workspaceDefaultMcpServerIds].map((id) => ({ id })),
              ),
            });
            return {
              ...targetSessionExecutionBase,
              effectiveMcpServerIds: [
                ...new Set(
                  effective.toolRefs.flatMap((tool) => (tool.kind === "mcp" ? [tool.id] : [])),
                ),
              ].sort(),
            };
          })()
        : null;
      const acceptedVariableSet =
        generatedTarget && task.variableSetId
          ? await getVariableSet(
              db,
              {
                accountId: task.accountId,
                workspaceId: task.workspaceId,
                // Organization/workspace sets have no personal-resource causal
                // subject. The scoped resolver still permits those common
                // scopes for a service/legacy actor, while a user-owned set can
                // only resolve through the exact frozen 0252 subject.
                subjectId: taskAuthoritySubjectId ?? task.createdBy.subjectId,
              },
              task.variableSetId,
            )
          : null;
      if (generatedTarget && task.variableSetId && !acceptedVariableSet) {
        throw new Error(`variable set not found: ${task.variableSetId}`);
      }
      const acceptedRig =
        generatedTarget && task.rigId
          ? await getRig(
              db,
              {
                accountId: task.accountId,
                workspaceId: task.workspaceId,
                subjectId: taskAuthoritySubjectId ?? task.createdBy.subjectId,
              },
              task.rigId,
            )
          : null;
      if (generatedTarget && task.rigId && (!acceptedRig || !acceptedRig.activeVersion)) {
        throw new Error(`rig has no active version to bind: ${task.rigId}`);
      }
      const acceptedRigDefaultVariableSets = acceptedRig?.activeVersion
        ? await Promise.all(
            acceptedRig.activeVersion.defaultVariableSetIds.map(async (variableSetId) => {
              const variableSet = await getVariableSet(
                db,
                {
                  accountId: task.accountId,
                  workspaceId: task.workspaceId,
                  subjectId: taskAuthoritySubjectId ?? task.createdBy.subjectId,
                },
                variableSetId,
              );
              if (!variableSet) {
                throw new Error(`rig default Variable Set not found: ${variableSetId}`);
              }
              return { id: variableSet.id, generation: variableSet.generation };
            }),
          )
        : [];
      let incidentPreflightRequired = incidentDeclaration.action === "required";
      if (incidentPreflightRequired) {
        const existingSessionId =
          task.runMode === "existing_session" ? task.targetSessionId : task.reusableSessionId;
        const canonicalAlertSession =
          task.runMode === "new_session_per_run" && alertOccurrence
            ? await getSessionByCreateIdempotencyKey(
                db,
                task.workspaceId,
                alertResponderSessionCreateIdempotencyKey!,
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
          personalResourceAuthoritySubjectId: taskAuthoritySubjectId,
          executionPolicy: targetSessionExecution
            ? {
                tools: targetSessionExecution.tools,
                firstPartyMcpTools: targetSessionExecution.firstPartyMcpTools,
                firstPartyMcpPermissions: targetSessionExecution.firstPartyMcpPermissions,
                variableSetIds: targetSessionExecution.variableSets.map(
                  (variableSet) => variableSet.id,
                ),
                variableSetId: targetSessionExecution.variableSetId,
                rigId: targetSessionExecution.rigId,
                rigVersionId: targetSessionExecution.rigVersionId,
                toolPolicy: targetSessionExecution.toolPolicy,
                mcpServerIds: targetSessionExecution.mcpServerIds,
                toolPolicyVersion: targetSessionExecution.toolPolicyVersion,
              }
            : {
                tools: taskTools,
                firstPartyMcpTools,
                firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
                variableSetId: acceptedVariableSet?.id ?? null,
                rigId: acceptedRig?.id ?? null,
                rigVersionId: acceptedRig?.activeVersion?.id ?? null,
                toolPolicy: responderSession?.toolPolicy ?? {
                  mode: "explicit",
                  inheritedFromSessionId: null,
                },
                mcpServerIds: [],
                toolPolicyVersion: responderSession?.toolPolicyVersion ?? null,
              },
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
      const xaiAuthoritySubjectId =
        taskXaiProviderAccountAuthoritySnapshot.scope === "user" &&
        task.createdBy.kind === "subject"
          ? task.createdBy.subjectId
          : null;
      if (taskXaiProviderAccountAuthoritySnapshot.scope === "user" && !xaiAuthoritySubjectId) {
        throw new Error("scheduled user-scoped xAI authority has no causal human");
      }
      if (
        xaiAuthoritySubjectId &&
        taskAuthoritySubjectId &&
        xaiAuthoritySubjectId !== taskAuthoritySubjectId
      ) {
        throw new Error("scheduled authority classes have different causal humans");
      }
      const causalHumanSubjectId = taskAuthoritySubjectId ?? xaiAuthoritySubjectId;
      // Workspace/organization Variable Sets and Rigs run through ordinary
      // workspace authority; only a user-owned resource needs the exact frozen
      // human, and the database admission fence re-proves the same rule for
      // existing/warm targets.
      if (
        (acceptedVariableSet?.scope === "user" || acceptedRig?.scope === "user") &&
        !causalHumanSubjectId
      ) {
        throw new Error("scheduled personal-resource execution has no causal human");
      }
      const admissionDenial = await agentRunAdmissionDenial(service, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        model: targetSessionExecution?.model ?? model,
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
        const admittedRunId = crypto.randomUUID();
        const generatedSessionBinding = generatedTarget
          ? {
              createIdempotencyKey:
                alertResponderSessionCreateIdempotencyKey ??
                (task.runMode === "reusable_session"
                  ? `scheduled-task-reusable:${task.id}:${task.authorityRevision}:${task.executionDigest}`
                  : `scheduled-task-run:${admittedRunId}`),
              effectiveMaxNestedAgentDepth:
                generatedSessionDepthPolicy!.effectiveMaxNestedAgentDepth,
              nestedAgentDepthPolicySource:
                generatedSessionDepthPolicy!.nestedAgentDepthPolicySource,
              codexCompactionMode: generatedSessionDepthPolicy!.codexCompactionMode,
            }
          : null;
        const acceptedExecution: ScheduledTaskRunAcceptedExecution = {
          version: 1,
          task,
          resolvedModel: model,
          resolvedReasoningEffort: reasoningEffort,
          resolvedLatencyMode: "standard",
          resolvedSandboxBackend: sandboxBackend,
          resolvedSandboxOs: sandboxOs,
          resolvedTools: taskTools,
          resolvedFirstPartyMcpTools: firstPartyMcpTools,
          resolvedFirstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
          resolvedVariableSet: acceptedVariableSet
            ? { id: acceptedVariableSet.id, generation: acceptedVariableSet.generation }
            : null,
          resolvedRig: acceptedRig?.activeVersion
            ? {
                id: acceptedRig.id,
                versionId: acceptedRig.activeVersion.id,
                defaultVariableSets: acceptedRigDefaultVariableSets,
              }
            : null,
          resolvedSlackBotConnection:
            slackBotConnection && slackBotMetadata && slackBotConnection.verifiedInstallVersion
              ? {
                  id: slackBotConnection.id,
                  version: slackBotConnection.version,
                  verifiedInstallVersion: slackBotConnection.verifiedInstallVersion,
                  metadata: slackBotMetadata,
                }
              : null,
          targetSessionExecution,
          generatedSessionBinding,
          personalConnectionDelegations: taskPersonalConnectionDelegations,
          personalResourceAuthoritySubjectId: taskPersonalResourceAuthoritySubjectId,
          causalHumanSubjectId,
          causalHumanAuthority: taskRevisionAuthority,
          xaiProviderAccountAuthoritySnapshot: taskXaiProviderAccountAuthoritySnapshot,
          xaiAuthoritySubjectId,
          connectionAuthoritySubjectId: taskConnectionAuthoritySubjectId,
          triggerInitiator: input.initiator ?? { kind: "service", subjectId: "scheduler" },
          agentRunUsageIdempotencyKey: input.agentRunUsageIdempotencyKey ?? null,
          incidentPreflightRequired,
          alertOccurrenceLabels: structuredAlertOccurrence?.labels ?? null,
        };
        // The accepted snapshot is immutable execution truth. A legacy task
        // whose stored shape can no longer be represented as a bounded
        // accepted execution is a deterministic, operator-visible block, not a
        // retryable activity failure that would silently drop the occurrence.
        const acceptedExecutionParse =
          ScheduledTaskRunAcceptedExecution.safeParse(acceptedExecution);
        if (
          !acceptedExecutionParse.success ||
          scheduledOccurrencePayloadUtf8Bytes({
            prompt: task.agentConfig.prompt,
            resources: task.agentConfig.resources,
            tools: taskTools,
          }) > SCHEDULED_TASK_OCCURRENCE_PAYLOAD_MAX_BYTES
        ) {
          return {
            kind: "blocked" as const,
            result: {
              action: "blocked" as const,
              reason: "scheduled_execution_unrepresentable" as const,
            },
          };
        }
        let run = await createScheduledTaskRun(dispatchDb, {
          runId: admittedRunId,
          workspaceId: task.workspaceId,
          taskId: task.id,
          taskAuthorityRevision: task.authorityRevision,
          taskExecutionDigest: task.executionDigest,
          triggerType: input.triggerType,
          producerKey: stableProducerKey,
          scheduledAt: null,
          acceptedExecutionSnapshot: acceptedExecution,
        });
        await recordScheduledTaskFiredUsage(dispatchDb, acceptedExecution, run);
        if (run.status === "failed" && run.error === "scheduled_authority_exhausted") {
          return {
            kind: "blocked" as const,
            result: {
              action: "blocked" as const,
              reason: "scheduled_authority_exhausted" as const,
            },
            run,
          };
        }
        if (run.status === "failed" || run.status === "skipped") {
          return {
            kind: "blocked" as const,
            result: scheduledRunTerminalResult(run.error),
            run,
          };
        }
        const runPersonalResourceAuthority = await getScheduledTaskRunPersonalResourceAuthority(
          dispatchDb,
          {
            accountId: task.accountId,
            workspaceId: task.workspaceId,
            runId: run.id,
          },
        );
        if (run?.status === "dispatched" && run.sessionId && run.triggerEventId) {
          if (deferPublications) {
            return { kind: "replay" as const, run, acceptedExecution };
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
            initiator: acceptedExecution.triggerInitiator,
            initiatorContext: {
              scheduledTaskId: task.id,
              scheduledTaskRunId: run.id,
            },
            origin: "scheduled_task",
            idempotencyKey:
              acceptedExecution.agentRunUsageIdempotencyKey ??
              `usage:agent_run.created:scheduled:${run.id}`,
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
              throw new IncidentTelemetryPreflightBlockedError(
                "incident_preflight_metadata_missing",
              );
            }
          }
          const goalSpec = task.agentConfig.goal ?? null;
          // Every dispatch carries the first-party MCP server; runtime visibility
          // still follows the session's exact selection and authorization.
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
            const variableSet = acceptedVariableSet;
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
              const rig = acceptedRig;
              if (!rig || !rig.activeVersion) {
                throw new Error(`rig has no active version to bind: ${task.rigId}`);
              }
              frozenRigId = rig.id;
              frozenRigVersionId =
                runPersonalResourceAuthority?.resources.find(
                  (resource) => resource.resourceKind === "rig" && resource.resourceId === rig.id,
                )?.resourceVersionId ?? rig.activeVersion.id;
              if (frozenRigVersionId !== rig.activeVersion.id) {
                throw new Error("scheduled run rig version changed during admission");
              }
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
                firstPartyMcpTools,
                firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
                metadata: {
                  ...taskMetadata,
                  model,
                  reasoningEffort,
                  scheduledTaskId: task.id,
                  scheduledTaskRunMode: task.runMode,
                  ...(goalSpec ? { scheduledTaskGoal: goalSpec } : {}),
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
                reasoningEffort,
                latencyMode: "standard",
                sandboxBackend,
                sandboxOs,
                variableSetId: task.variableSetId ?? null,
                rigId: frozenRigId,
                rigVersionId: frozenRigVersionId,
                personalConnectionDelegations: [],
                initialXaiProviderAccountAuthoritySnapshot: taskXaiProviderAccountAuthoritySnapshot,
                maxNestedAgentDepthOverride: task.agentConfig.maxNestedAgentDepth ?? null,
                frozenNestedAgentDepthPolicy: {
                  effectiveMaxNestedAgentDepth:
                    generatedSessionBinding!.effectiveMaxNestedAgentDepth,
                  nestedAgentDepthPolicySource:
                    generatedSessionBinding!.nestedAgentDepthPolicySource,
                },
                frozenCodexCompactionMode: generatedSessionBinding!.codexCompactionMode,
                // The durable agent config was privilege-checked when the task
                // was created/updated. Preserve that explicit policy if a broader
                // workspace/deployment limit is narrowed before a later fire.
                allowNestedAgentDepthIncrease: true,
                subjectId: `scheduled_task:${task.id}`,
                beforeCreateCommit: async (tx, sessionId) => {
                  if (incidentPreflightRequired) {
                    const exactSession = await requireSession(tx, task.workspaceId, sessionId);
                    const exactResponder = await resolveIncidentTelemetryResponderMetadata({
                      db: tx,
                      settings,
                      task: acceptedExecution.task,
                      session: exactSession,
                      personalConnectionDelegations:
                        acceptedExecution.personalConnectionDelegations,
                      personalResourceAuthoritySubjectId:
                        acceptedExecution.personalResourceAuthoritySubjectId,
                      executionPolicy: {
                        tools: exactSession.tools,
                        firstPartyMcpTools: exactSession.firstPartyMcpTools,
                        firstPartyMcpPermissions: exactSession.firstPartyMcpPermissions,
                        variableSetId: exactSession.variableSetId,
                        rigId: exactSession.rigId,
                        rigVersionId: exactSession.rigVersionId,
                        toolPolicy: exactSession.toolPolicy,
                        mcpServerIds: exactSession.mcpServers.map((server) => server.id),
                        toolPolicyVersion: exactSession.toolPolicyVersion,
                      },
                    });
                    const exactPreflight = evaluateIncidentTelemetryPreflight({
                      agentConfig: acceptedExecution.task.agentConfig,
                      incidentTriggered: structuredAlertOccurrence !== null,
                      alertOccurrenceLabels: structuredAlertOccurrence?.labels ?? null,
                      responder: exactResponder,
                    });
                    if (exactPreflight.action === "blocked") {
                      throw new IncidentTelemetryPreflightBlockedError(exactPreflight.reason);
                    }
                  }
                  await bindScheduledTaskRunSessionInTransaction(tx, {
                    accountId: task.accountId,
                    workspaceId: task.workspaceId,
                    runId: run.id,
                    sessionId,
                  });
                },
              };
              const created = await createSessionWithIdempotencyKeyResult(dispatchDb, {
                ...sessionInput,
                createIdempotencyKey: generatedSessionBinding!.createIdempotencyKey,
              });
              if (created.denied) {
                throw new SessionSpawnDeniedDbError(created.denial);
              }
              session = created.session;
              sessionCreated = created.created;
              if (!sessionCreated) {
                await bindScheduledTaskRunSessionInTransaction(dispatchDb, {
                  accountId: task.accountId,
                  workspaceId: task.workspaceId,
                  runId: run.id,
                  sessionId: session.id,
                });
                run = { ...run, sessionId: session.id };
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
            session = await seedScheduledGeneratedSessionRoute({
              db: dispatchDb,
              bus,
              settings,
              task,
              runId: run.id,
              session,
              deferPublications,
              deferredEvents,
            });
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
                    ? { variableSetId: variableSet.id, variableSetName: variableSet.name }
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
                  deferredEvents.push({ sessionId: session.id, events: started.events });
                } else {
                  await publishDurableSessionEvents(
                    bus,
                    task.workspaceId,
                    session.id,
                    started.events,
                  );
                }
              }
              if (task.runMode === "reusable_session") {
                await materializeScheduledTaskReusableSessionFromRun(dispatchDb, {
                  accountId: task.accountId,
                  workspaceId: task.workspaceId,
                  taskId: task.id,
                  runId: run.id,
                  sessionId: session.id,
                  sourceTaskAuthorityRevision:
                    runPersonalResourceAuthority?.taskAuthorityRevision ??
                    run.taskAuthorityRevision!,
                  sourceExecutionDigest:
                    runPersonalResourceAuthority?.executionDigest ?? run.taskExecutionDigest!,
                });
              }
            }
            // After both start branches, so the timeline reads session.created
            // then session.title_set rather than titling a session that has not
            // announced itself yet. `session.created` is what carries the row
            // into the rail, and this lands on its heels.
            const titleEvents = await stampScheduledSessionTitle(dispatchDb, {
              workspaceId: task.workspaceId,
              sessionId: session.id,
              taskName: task.name,
            });
            if (titleEvents.length > 0) {
              if (deferPublications) {
                deferredEvents.push({ sessionId: session.id, events: titleEvents });
              } else {
                await publishDurableSessionEvents(bus, task.workspaceId, session.id, titleEvents);
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
                dedupeKey: `scheduled-task-run:${run.id}`,
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
                  ...(causalHumanSubjectId ? { causalHumanSubjectId } : {}),
                  ...(taskConnectionAuthoritySubjectId
                    ? { connectionAuthoritySubjectId: taskConnectionAuthoritySubjectId }
                    : {}),
                  ...(taskXaiProviderAccountAuthoritySnapshot.scope === "user" &&
                  task.createdBy.kind === "subject"
                    ? { xaiAuthoritySubjectId: task.createdBy.subjectId }
                    : {}),
                },
                personalConnectionDelegations: taskPersonalConnectionDelegations,
                xaiProviderAccountAuthoritySnapshot: taskXaiProviderAccountAuthoritySnapshot,
                scheduledTaskRunId: run.id,
              },
              async (tx, wakeEventId) => {
                if (!wakeEventId) {
                  await settleScheduledTaskRunInTransaction(tx, {
                    workspaceId: task.workspaceId,
                    runId: scheduledRun.id,
                    sessionId: session.id,
                    triggerEventId: null,
                    status: "skipped",
                    error: "session_cancelled",
                  });
                  return;
                }
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
                        acceptedExecution,
                      }),
                  }
                : undefined,
            );
            if (scheduledUpdate.reason === "session_cancelled") {
              return {
                kind: "blocked" as const,
                result: { action: "blocked" as const, reason: "scheduled_run_terminal" as const },
                run: { ...run, status: "skipped" as const, error: "session_cancelled" },
              };
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
            await bindScheduledTaskRunSessionInTransaction(dispatchDb, {
              accountId: task.accountId,
              workspaceId: task.workspaceId,
              runId: run.id,
              sessionId: session.id,
            });
            // A user-cancelled (terminal) reusable session must not be revived and
            // re-billed on the next fire. Early check avoids the pre-lock goal
            // upsert side-effect; the locked-callback check below is the
            // authoritative atomic guard. Mirrors apps/api/src/domain/sessions.ts.
            assertReusableSessionRevivable(session.status);
            // Defensive backstop for the API-level 409: a reusable session keeps
            // its creation-time attachment, so a diverged task attachment must
            // fail the run instead of silently running with the wrong secrets.
            assertReusableSessionBindingMatches(session, task);
            // A recurring "maintain X" task re-establishes its objective on every
            // fire: replace the goal text, reactivate it, and reset the counters.
            const goalEvents =
              task.runMode === "reusable_session" && goalSpec && run.status === "queued"
                ? await upsertScheduledSessionGoalForRun(dispatchDb, {
                    accountId: task.accountId,
                    workspaceId: task.workspaceId,
                    sessionId: session.id,
                    runId: run.id,
                    text: goalSpec.text,
                    successCriteria: goalSpec.successCriteria ?? null,
                    maxAutoContinuations: goalSpec.maxAutoContinuations ?? null,
                    ...(goalSpec.mutationPolicy ? { mutationPolicy: goalSpec.mutationPolicy } : {}),
                  })
                : [];
            if (goalEvents.length > 0) {
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
                dedupeKey: `scheduled-task-run:${run.id}`,
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
                  ...(causalHumanSubjectId ? { causalHumanSubjectId } : {}),
                  ...(taskConnectionAuthoritySubjectId
                    ? { connectionAuthoritySubjectId: taskConnectionAuthoritySubjectId }
                    : {}),
                  ...(taskXaiProviderAccountAuthoritySnapshot.scope === "user" &&
                  task.createdBy.kind === "subject"
                    ? { xaiAuthoritySubjectId: task.createdBy.subjectId }
                    : {}),
                },
                personalConnectionDelegations: taskPersonalConnectionDelegations,
                xaiProviderAccountAuthoritySnapshot: taskXaiProviderAccountAuthoritySnapshot,
                scheduledTaskRunId: run.id,
              },
              async (tx, wakeEventId) => {
                if (!wakeEventId) {
                  await settleScheduledTaskRunInTransaction(tx, {
                    workspaceId: task.workspaceId,
                    runId: scheduledRun.id,
                    sessionId: session.id,
                    triggerEventId: null,
                    status: "skipped",
                    error: "session_cancelled",
                  });
                  return;
                }
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
                        acceptedExecution,
                      }),
                  }
                : undefined,
            );
            if (bundled.reason === "session_cancelled") {
              return {
                kind: "blocked" as const,
                result: { action: "blocked" as const, reason: "scheduled_run_terminal" as const },
                run: { ...run, status: "skipped" as const, error: "session_cancelled" },
              };
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
          const terminalError = scheduledRunRecoveryTerminalError(error);
          if (!terminalError) throw error;
          await markScheduledTaskRunFailedIfQueued(
            dispatchDb,
            task.workspaceId,
            run.id,
            terminalError.code,
          );
          return {
            kind: "blocked" as const,
            result: scheduledRunTerminalResult(terminalError.code),
            run: { ...run, status: "failed" as const, error: terminalError.code },
          };
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
          acceptedExecution: dispatchOutcome.acceptedExecution,
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
      if (dispatchOutcome.kind === "blocked") return dispatchOutcome.result;
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

/**
 * Defensive backstop for the API-level 409: a reusable/existing target session
 * keeps its creation-time attachment, so a diverged task attachment or Slack
 * bot binding must settle the run terminally instead of silently running with
 * the wrong secrets - on the first attempt and on every recovery attempt.
 */
function assertReusableSessionBindingMatches(
  session: { variableSetId: string | null; metadata: Record<string, unknown> },
  task: Pick<ScheduledTask, "variableSetId" | "agentConfig">,
): void {
  if ((session.variableSetId ?? null) !== (task.variableSetId ?? null)) {
    throw new ScheduledRunTerminalAuthorityError(
      "scheduled_reusable_binding_changed",
      "scheduled task variableSet attachment does not match its reusable session",
    );
  }
  if (
    scheduledSlackBotConnectionId(session.metadata) !==
    (task.agentConfig.slackBotConnectionId ?? null)
  ) {
    throw new ScheduledRunTerminalAuthorityError(
      "scheduled_reusable_binding_changed",
      "scheduled task OpenGeni Slack bot binding does not match its reusable session",
    );
  }
}

class ScheduledRunTerminalAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScheduledRunTerminalAuthorityError";
  }
}

function scheduledRunRecoveryTerminalError(
  error: unknown,
): ScheduledRunTerminalAuthorityError | null {
  if (
    error instanceof Error &&
    "cause" in error &&
    error.cause !== undefined &&
    error.cause !== error
  ) {
    const nested = scheduledRunRecoveryTerminalError(error.cause);
    if (nested) return nested;
  }
  if (error instanceof ScheduledRunTerminalAuthorityError) return error;
  if (error instanceof IncidentTelemetryPreflightBlockedError) {
    return new ScheduledRunTerminalAuthorityError(
      `scheduled_incident_${error.reason}`,
      error.message,
    );
  }
  if (error instanceof SessionSpawnDeniedDbError) {
    return new ScheduledRunTerminalAuthorityError("scheduled_session_spawn_denied", error.message);
  }
  if (error instanceof Error && error.message.startsWith("Session not found:")) {
    return new ScheduledRunTerminalAuthorityError(
      "scheduled_target_session_unavailable",
      error.message,
    );
  }
  if (typeof error === "object" && error !== null && "status" in error && error.status === 422) {
    return new ScheduledRunTerminalAuthorityError(
      "scheduled_slack_authority_unavailable",
      error instanceof Error ? error.message : "scheduled Slack authority is unavailable",
    );
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "42501") {
    return new ScheduledRunTerminalAuthorityError(
      "scheduled_run_authority_proof_rejected",
      error instanceof Error ? error.message : "scheduled run authority proof was rejected",
    );
  }
  return null;
}

function scheduledRunTerminalResult(
  error: string | null,
): Extract<DispatchScheduledTaskRunResult, { action: "blocked" }> {
  if (error === "scheduled_authority_exhausted") {
    return { action: "blocked", reason: "scheduled_authority_exhausted" };
  }
  if (error === "scheduled_incident_incident_preflight_metadata_missing") {
    return { action: "blocked", reason: "incident_preflight_metadata_missing" };
  }
  if (error === "scheduled_incident_incident_responder_under_capable") {
    return { action: "blocked", reason: "incident_responder_under_capable" };
  }
  if (error === "scheduled_incident_incident_data_source_unsuitable") {
    return { action: "blocked", reason: "incident_data_source_unsuitable" };
  }
  return { action: "blocked", reason: "scheduled_run_terminal" };
}

async function prepareIncidentTelemetrySource(input: {
  tx: Database;
  settings: ControlActivityServices["settings"];
  taskId: string;
  workspaceId: string;
  sessionId: string;
  alertOccurrenceLabels: Readonly<Record<string, string>> | null;
  acceptedExecution?: ScheduledTaskRunAcceptedExecution;
}) {
  const session = await requireSession(input.tx, input.workspaceId, input.sessionId);
  const { task, personalConnectionDelegations } = input.acceptedExecution
    ? {
        task: input.acceptedExecution.task,
        personalConnectionDelegations: input.acceptedExecution.personalConnectionDelegations,
      }
    : await requireScheduledTaskIncidentAuthorityInTransaction(input.tx, {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
      });
  const responder = await resolveIncidentTelemetryResponderMetadata({
    db: input.tx,
    settings: input.settings,
    task,
    session,
    personalConnectionDelegations,
    personalResourceAuthoritySubjectId:
      input.acceptedExecution?.personalResourceAuthoritySubjectId ?? null,
    ...(input.acceptedExecution
      ? {
          executionPolicy: input.acceptedExecution.targetSessionExecution
            ? {
                tools: input.acceptedExecution.targetSessionExecution.tools,
                firstPartyMcpTools:
                  input.acceptedExecution.targetSessionExecution.firstPartyMcpTools,
                firstPartyMcpPermissions:
                  input.acceptedExecution.targetSessionExecution.firstPartyMcpPermissions,
                variableSetIds: input.acceptedExecution.targetSessionExecution.variableSets.map(
                  (variableSet) => variableSet.id,
                ),
                variableSetId: input.acceptedExecution.targetSessionExecution.variableSetId,
                rigId: input.acceptedExecution.targetSessionExecution.rigId,
                rigVersionId: input.acceptedExecution.targetSessionExecution.rigVersionId,
                toolPolicy: input.acceptedExecution.targetSessionExecution.toolPolicy,
                mcpServerIds: input.acceptedExecution.targetSessionExecution.mcpServerIds,
                toolPolicyVersion: input.acceptedExecution.targetSessionExecution.toolPolicyVersion,
              }
            : {
                tools: input.acceptedExecution.resolvedTools,
                firstPartyMcpTools: input.acceptedExecution.resolvedFirstPartyMcpTools,
                firstPartyMcpPermissions: input.acceptedExecution.resolvedFirstPartyMcpPermissions,
                variableSetId: input.acceptedExecution.resolvedVariableSet?.id ?? null,
                rigId: input.acceptedExecution.resolvedRig?.id ?? null,
                rigVersionId: input.acceptedExecution.resolvedRig?.versionId ?? null,
                toolPolicy: session.toolPolicy,
                mcpServerIds: [],
                toolPolicyVersion: session.toolPolicyVersion,
              },
        }
      : {}),
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
  acceptedExecution: ScheduledTaskRunAcceptedExecution,
  run: ScheduledTaskRun,
): Promise<void> {
  const task = acceptedExecution.task;
  await recordUsageEvent(db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    eventType: "scheduled_task.fired",
    quantity: 1,
    unit: "run",
    sourceResourceType: "scheduled_task_run",
    sourceResourceId: run.id,
    initiator: acceptedExecution.triggerInitiator,
    initiatorContext: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
    origin: "scheduled_task",
    idempotencyKey: `usage:scheduled_task.fired:${run.id}`,
  });
}

async function seedScheduledGeneratedSessionRoute(input: {
  db: Database;
  bus: ControlActivityServices["bus"];
  settings: ControlActivityServices["settings"];
  task: ScheduledTask;
  runId: string;
  session: Awaited<ReturnType<typeof createSession>>;
  deferPublications: boolean;
  deferredEvents: Array<{
    sessionId: string;
    events: Awaited<ReturnType<typeof appendSessionEvents>>;
  }>;
}): Promise<Awaited<ReturnType<typeof createSession>>> {
  const target = input.task.agentConfig.machineTarget;
  if (!target) return input.session;
  const seeded = await swapActiveSandbox(
    {
      db: input.db,
      settings: input.settings,
      bus: input.bus,
    },
    {
      accountId: input.task.accountId,
      workspaceId: input.task.workspaceId,
      sessionId: input.session.id,
      sessionBackend: input.session.sandboxBackend,
      sessionGroupId: input.session.sandboxGroupId,
    },
    target.targetSandboxId,
    target.workingDir ?? null,
  );
  if (seeded.swapped) {
    return await requireSession(input.db, input.task.workspaceId, input.session.id);
  }

  const failed = await failScheduledGeneratedSessionRoute(input.db, {
    accountId: input.task.accountId,
    workspaceId: input.task.workspaceId,
    taskId: input.task.id,
    runId: input.runId,
    sessionId: input.session.id,
    error: "scheduled_machine_unavailable",
  });
  if (failed.action === "advanced") {
    throw new Error(
      `scheduled run advanced to ${failed.status} while its Connected Machine route was being established`,
    );
  }
  if (failed.events.length > 0) {
    if (input.deferPublications) {
      input.deferredEvents.push({ sessionId: input.session.id, events: failed.events });
    } else {
      await publishDurableSessionEvents(
        input.bus,
        input.task.workspaceId,
        input.session.id,
        failed.events,
      );
    }
  }
  const error =
    failed.action === "terminal" ? (failed.error ?? "scheduled_run_terminal") : failed.error;
  throw new ScheduledRunTerminalAuthorityError(
    error,
    seeded.reason ?? "scheduled Connected Machine target is unavailable",
  );
}

async function recoverBoundScheduledTaskDispatch(input: {
  db: Database;
  bus: ControlActivityServices["bus"];
  settings: ControlActivityServices["settings"];
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
  run: ScheduledTaskRun;
  acceptedExecution: ScheduledTaskRunAcceptedExecution;
  input: DispatchScheduledTaskRunInput;
}): Promise<DispatchScheduledTaskRunResult> {
  const { task } = input.acceptedExecution;
  if (input.run.status !== "queued") {
    throw new Error("scheduled run is not an exact queued recovery");
  }
  const generatedSession =
    task.runMode === "new_session_per_run" ||
    (task.runMode === "reusable_session" && task.reusableSessionId === null);
  const frozenSlack = input.acceptedExecution.resolvedSlackBotConnection;
  if (frozenSlack) {
    const currentSlack = await requireOpenGeniSlackBotConnection(
      input.db,
      task.workspaceId,
      frozenSlack.id,
    );
    const currentMetadata = openGeniSlackBotMetadata(currentSlack.metadata);
    if (
      currentSlack.version !== frozenSlack.version ||
      currentSlack.verifiedInstallVersion !== frozenSlack.verifiedInstallVersion ||
      stableJson(currentMetadata) !== stableJson(frozenSlack.metadata)
    ) {
      throw new ScheduledRunTerminalAuthorityError(
        "scheduled_slack_authority_changed",
        "scheduled Slack bot authority changed after run admission",
      );
    }
  }
  let session: Awaited<ReturnType<typeof createSession>>;
  if (input.run.sessionId) {
    session = await requireSession(input.db, task.workspaceId, input.run.sessionId);
    // A bound existing/reusable target must still carry the exact Variable Set
    // and Slack bot binding frozen with this occurrence; recovery must fail the
    // run terminally rather than deliver into a diverged session.
    if (!generatedSession) assertReusableSessionBindingMatches(session, task);
  } else if (generatedSession) {
    const variableSet = input.acceptedExecution.resolvedVariableSet;
    if (variableSet) {
      const current = await getVariableSet(
        input.db,
        {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          subjectId:
            input.acceptedExecution.personalResourceAuthoritySubjectId ?? task.createdBy.subjectId,
        },
        variableSet.id,
      );
      if (!current || current.generation !== variableSet.generation) {
        throw new ScheduledRunTerminalAuthorityError(
          "scheduled_variable_set_authority_changed",
          "scheduled variable set changed after run admission",
        );
      }
    }
    const rig = input.acceptedExecution.resolvedRig;
    if (rig) {
      const retained = await getScheduledScopedRigVersionMetadata(
        input.db,
        {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          subjectId:
            input.acceptedExecution.personalResourceAuthoritySubjectId ?? task.createdBy.subjectId,
        },
        rig.id,
        rig.versionId,
      );
      if (!retained) {
        throw new ScheduledRunTerminalAuthorityError(
          "scheduled_rig_authority_changed",
          "scheduled rig changed after run admission",
        );
      }
    }
    const taskMetadata = { ...task.agentConfig.metadata };
    delete taskMetadata[OPENGENI_SLACK_BOT_SESSION_METADATA_KEY];
    const created = await createSessionWithIdempotencyKeyResult(input.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      initialMessage: task.agentConfig.prompt,
      resources: task.agentConfig.resources,
      tools: input.acceptedExecution.resolvedTools,
      firstPartyMcpTools: input.acceptedExecution.resolvedFirstPartyMcpTools,
      firstPartyMcpPermissions: input.acceptedExecution.resolvedFirstPartyMcpPermissions,
      metadata: {
        ...taskMetadata,
        model: input.acceptedExecution.resolvedModel,
        reasoningEffort: input.acceptedExecution.resolvedReasoningEffort,
        scheduledTaskId: task.id,
        scheduledTaskRunMode: task.runMode,
        ...(task.agentConfig.goal ? { scheduledTaskGoal: task.agentConfig.goal } : {}),
        scheduledTaskRunId: input.run.id,
        ...(frozenSlack ? { [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: frozenSlack.id } : {}),
      },
      createdBy: {
        kind: "service",
        subjectId: "scheduler",
        label: "OpenGeni scheduler",
      },
      createdByContext: {
        scheduledTaskId: task.id,
        scheduledTaskRunId: input.run.id,
      },
      model: input.acceptedExecution.resolvedModel,
      reasoningEffort: input.acceptedExecution.resolvedReasoningEffort,
      latencyMode: input.acceptedExecution.resolvedLatencyMode,
      sandboxBackend: input.acceptedExecution.resolvedSandboxBackend,
      sandboxOs: input.acceptedExecution.resolvedSandboxOs,
      variableSetId: variableSet?.id ?? null,
      rigId: rig?.id ?? null,
      rigVersionId: rig?.versionId ?? null,
      personalConnectionDelegations: [],
      initialXaiProviderAccountAuthoritySnapshot:
        input.acceptedExecution.xaiProviderAccountAuthoritySnapshot,
      maxNestedAgentDepthOverride: task.agentConfig.maxNestedAgentDepth ?? null,
      frozenNestedAgentDepthPolicy: {
        effectiveMaxNestedAgentDepth:
          input.acceptedExecution.generatedSessionBinding!.effectiveMaxNestedAgentDepth,
        nestedAgentDepthPolicySource:
          input.acceptedExecution.generatedSessionBinding!.nestedAgentDepthPolicySource,
      },
      frozenCodexCompactionMode:
        input.acceptedExecution.generatedSessionBinding!.codexCompactionMode,
      allowNestedAgentDepthIncrease: true,
      subjectId: `scheduled_task:${task.id}`,
      createIdempotencyKey:
        input.acceptedExecution.generatedSessionBinding?.createIdempotencyKey ??
        (() => {
          throw new ScheduledRunTerminalAuthorityError(
            "scheduled_generated_session_binding_missing",
            "scheduled generated session binding is missing",
          );
        })(),
      beforeCreateCommit: async (tx, sessionId) => {
        await bindScheduledTaskRunSessionInTransaction(tx, {
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          runId: input.run.id,
          sessionId,
        });
      },
    });
    if (created.denied) throw new SessionSpawnDeniedDbError(created.denial);
    session = created.session;
    if (!created.created) {
      await bindScheduledTaskRunSessionInTransaction(input.db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        runId: input.run.id,
        sessionId: session.id,
      });
    }
  } else {
    const targetSessionId =
      task.runMode === "existing_session" ? task.targetSessionId : task.reusableSessionId;
    if (!targetSessionId) {
      throw new ScheduledRunTerminalAuthorityError(
        "scheduled_target_session_unavailable",
        "scheduled accepted target session is unavailable",
      );
    }
    session = await requireSession(input.db, task.workspaceId, targetSessionId);
    // Same backstop for a first attempt that died before its bind landed.
    assertReusableSessionBindingMatches(session, task);
    await bindScheduledTaskRunSessionInTransaction(input.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      runId: input.run.id,
      sessionId: session.id,
    });
  }
  if (generatedSession) {
    session = await seedScheduledGeneratedSessionRoute({
      db: input.db,
      bus: input.bus,
      settings: input.settings,
      task,
      runId: input.run.id,
      session,
      deferPublications: false,
      deferredEvents: [],
    });
  }
  if (session.status === "cancelled") {
    await markScheduledTaskRunSkippedIfQueued(input.db, {
      workspaceId: task.workspaceId,
      runId: input.run.id,
      sessionId: session.id,
      error: "session_cancelled",
    });
    return { action: "blocked", reason: "scheduled_run_terminal" };
  }
  if (generatedSession) {
    const expectedCreateKey = input.acceptedExecution.generatedSessionBinding?.createIdempotencyKey;
    if (!expectedCreateKey) {
      throw new ScheduledRunTerminalAuthorityError(
        "scheduled_generated_session_binding_missing",
        "scheduled generated session binding is missing",
      );
    }
    const generatedBinding = input.acceptedExecution.generatedSessionBinding!;
    const canonicalGeneratedRunId =
      task.runMode === "reusable_session" && typeof session.metadata.scheduledTaskRunId === "string"
        ? session.metadata.scheduledTaskRunId
        : input.run.id;
    const expectedTaskMetadata = { ...task.agentConfig.metadata };
    delete expectedTaskMetadata[OPENGENI_SLACK_BOT_SESSION_METADATA_KEY];
    const expectedMetadata = {
      ...expectedTaskMetadata,
      model: input.acceptedExecution.resolvedModel,
      reasoningEffort: input.acceptedExecution.resolvedReasoningEffort,
      scheduledTaskId: task.id,
      scheduledTaskRunMode: task.runMode,
      ...(task.agentConfig.goal ? { scheduledTaskGoal: task.agentConfig.goal } : {}),
      scheduledTaskRunId: canonicalGeneratedRunId,
      ...(frozenSlack ? { [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: frozenSlack.id } : {}),
    };
    if (
      session.createIdempotencyKey !== expectedCreateKey ||
      session.initialMessage !== task.agentConfig.prompt ||
      session.instructions !== null ||
      session.policyRole !== null ||
      stableJson(session.skills) !== "[]" ||
      stableJson(session.toolPolicy) !==
        stableJson({ mode: "explicit", inheritedFromSessionId: null }) ||
      session.toolPolicyVersion !== 1 ||
      session.mcpServers.length !== 0 ||
      session.parentSessionId !== null ||
      session.rootSessionId !== session.id ||
      session.nestedAgentDepth !== 0 ||
      session.effectiveMaxNestedAgentDepth !== generatedBinding.effectiveMaxNestedAgentDepth ||
      session.nestedAgentDepthPolicySource !== generatedBinding.nestedAgentDepthPolicySource ||
      session.nestedAgentDepthPolicySessionId !==
        (generatedBinding.nestedAgentDepthPolicySource === "session" ? session.id : null) ||
      session.sandboxGroupId !== session.id ||
      session.channelId !== null ||
      session.codexCompactionMode !== generatedBinding.codexCompactionMode ||
      stableJson(session.metadata) !== stableJson(expectedMetadata) ||
      session.createdBy.kind !== "service" ||
      session.createdBy.subjectId !== "scheduler" ||
      stableJson(session.createdByContext) !==
        stableJson({
          label: "OpenGeni scheduler",
          scheduledTaskId: task.id,
          scheduledTaskRunId: canonicalGeneratedRunId,
        }) ||
      (task.runMode === "new_session_per_run" &&
        input.acceptedExecution.alertOccurrenceLabels === null &&
        (session.metadata.scheduledTaskRunId !== input.run.id ||
          session.createdByContext.scheduledTaskRunId !== input.run.id)) ||
      session.model !== input.acceptedExecution.resolvedModel ||
      session.reasoningEffort !== input.acceptedExecution.resolvedReasoningEffort ||
      session.latencyMode !== input.acceptedExecution.resolvedLatencyMode ||
      session.sandboxBackend !== input.acceptedExecution.resolvedSandboxBackend ||
      session.sandboxOs !== input.acceptedExecution.resolvedSandboxOs ||
      session.activeSandboxId !== (task.agentConfig.machineTarget?.targetSandboxId ?? null) ||
      stableJson(session.resources) !== stableJson(task.agentConfig.resources) ||
      stableJson(session.tools) !== stableJson(input.acceptedExecution.resolvedTools) ||
      stableJson(session.firstPartyMcpTools) !==
        stableJson(input.acceptedExecution.resolvedFirstPartyMcpTools) ||
      stableJson(session.firstPartyMcpPermissions) !==
        stableJson(input.acceptedExecution.resolvedFirstPartyMcpPermissions) ||
      session.maxNestedAgentDepthOverride !== (task.agentConfig.maxNestedAgentDepth ?? null) ||
      (session.variableSetId ?? null) !==
        (input.acceptedExecution.resolvedVariableSet?.id ?? null) ||
      (session.rigId ?? null) !== (input.acceptedExecution.resolvedRig?.id ?? null) ||
      (session.rigVersionId ?? null) !== (input.acceptedExecution.resolvedRig?.versionId ?? null) ||
      scheduledSlackBotConnectionId(session.metadata) !== (frozenSlack?.id ?? null)
    ) {
      throw new ScheduledRunTerminalAuthorityError(
        "scheduled_generated_session_changed",
        "scheduled generated session differs from accepted execution",
      );
    }
  }
  let workflowId = workflowIdForSession(session.id);
  if (generatedSession) {
    const goalSpec = task.agentConfig.goal ?? null;
    const started = await initializeSessionStartAtomically(input.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: input.acceptedExecution.resolvedReasoningEffort,
      createdEventPayload: {
        scheduledTaskId: task.id,
        scheduledTaskRunId: input.run.id,
      },
      goal: goalSpec
        ? {
            text: goalSpec.text,
            successCriteria: goalSpec.successCriteria ?? null,
            maxAutoContinuations: goalSpec.maxAutoContinuations ?? null,
            ...(goalSpec.mutationPolicy ? { mutationPolicy: goalSpec.mutationPolicy } : {}),
            createdBy: "scheduled_task",
          }
        : null,
      deferInitialTurn: true,
      deferredStatus: "queued",
    });
    workflowId = started.temporalWorkflowId;
    if (started.events.length > 0) {
      await publishDurableSessionEvents(input.bus, task.workspaceId, session.id, started.events);
    }
    if (task.runMode === "reusable_session") {
      await materializeScheduledTaskReusableSessionFromRun(input.db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        runId: input.run.id,
        sessionId: session.id,
        sourceTaskAuthorityRevision: input.run.taskAuthorityRevision!,
        sourceExecutionDigest: input.run.taskExecutionDigest!,
      });
    }
    // Same title the normal dispatch writes, from the same durable task row, in
    // the same position relative to session.created. A session the dead dispatch
    // already titled is left alone.
    const titleEvents = await stampScheduledSessionTitle(input.db, {
      workspaceId: task.workspaceId,
      sessionId: session.id,
      taskName: task.name,
    });
    if (titleEvents.length > 0) {
      await publishDurableSessionEvents(input.bus, task.workspaceId, session.id, titleEvents);
    }
  }
  if (!generatedSession && task.runMode === "reusable_session" && task.agentConfig.goal) {
    const goalEvents = await upsertScheduledSessionGoalForRun(input.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      sessionId: session.id,
      runId: input.run.id,
      text: task.agentConfig.goal.text,
      successCriteria: task.agentConfig.goal.successCriteria ?? null,
      maxAutoContinuations: task.agentConfig.goal.maxAutoContinuations ?? null,
      ...(task.agentConfig.goal.mutationPolicy
        ? { mutationPolicy: task.agentConfig.goal.mutationPolicy }
        : {}),
    });
    if (goalEvents.length > 0) {
      await publishDurableSessionEvents(input.bus, task.workspaceId, session.id, goalEvents);
    }
  }
  const scheduledUpdate = await addSessionSystemUpdateWithSourceMutation(
    input.db,
    {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      sessionId: session.id,
      kind: "scheduled_occurrence",
      classification: "info",
      sourceId: input.run.id,
      dedupeKey: `scheduled-task-run:${input.run.id}`,
      summary: task.agentConfig.prompt,
      payload: scheduledUserMessagePayload(
        task.agentConfig.prompt,
        task.agentConfig.resources,
        input.acceptedExecution.resolvedTools,
        task.id,
        input.run.id,
      ),
      lineage: {
        scheduledTaskId: task.id,
        scheduledTaskRunId: input.run.id,
        ...(input.acceptedExecution.causalHumanSubjectId
          ? { causalHumanSubjectId: input.acceptedExecution.causalHumanSubjectId }
          : {}),
        ...(input.acceptedExecution.connectionAuthoritySubjectId
          ? {
              connectionAuthoritySubjectId: input.acceptedExecution.connectionAuthoritySubjectId,
            }
          : {}),
        ...(input.acceptedExecution.xaiAuthoritySubjectId
          ? { xaiAuthoritySubjectId: input.acceptedExecution.xaiAuthoritySubjectId }
          : {}),
      },
      personalConnectionDelegations: input.acceptedExecution.personalConnectionDelegations,
      xaiProviderAccountAuthoritySnapshot:
        input.acceptedExecution.xaiProviderAccountAuthoritySnapshot,
      scheduledTaskRunId: input.run.id,
    },
    async (tx, wakeEventId) => {
      if (!wakeEventId) {
        await settleScheduledTaskRunInTransaction(tx, {
          workspaceId: task.workspaceId,
          runId: input.run.id,
          sessionId: session.id,
          triggerEventId: null,
          status: "skipped",
          error: "session_cancelled",
        });
        return;
      }
      await settleScheduledTaskRunInTransaction(tx, {
        workspaceId: task.workspaceId,
        runId: input.run.id,
        sessionId: session.id,
        triggerEventId: wakeEventId,
        status: "dispatched",
      });
    },
    input.acceptedExecution.incidentPreflightRequired
      ? {
          prepareSource: async (tx, sessionId) =>
            await prepareIncidentTelemetrySource({
              tx,
              settings: input.settings,
              taskId: task.id,
              workspaceId: task.workspaceId,
              sessionId,
              alertOccurrenceLabels: input.acceptedExecution.alertOccurrenceLabels,
              acceptedExecution: input.acceptedExecution,
            }),
        }
      : undefined,
  );
  if (scheduledUpdate.reason === "session_cancelled") {
    return { action: "blocked", reason: "scheduled_run_terminal" };
  }
  if (scheduledUpdate.added && scheduledUpdate.events.length > 0) {
    await publishDurableSessionEvents(
      input.bus,
      task.workspaceId,
      session.id,
      scheduledUpdate.events,
    );
  }
  await recordUsageEvent(input.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    eventType: "agent_run.created",
    quantity: 1,
    unit: "run",
    sourceResourceType: "scheduled_task_run",
    sourceResourceId: input.run.id,
    sessionId: session.id,
    initiator: input.acceptedExecution.triggerInitiator,
    initiatorContext: { scheduledTaskId: task.id, scheduledTaskRunId: input.run.id },
    origin: "scheduled_task",
    idempotencyKey:
      input.acceptedExecution.agentRunUsageIdempotencyKey ??
      `usage:agent_run.created:scheduled:${input.run.id}`,
  });
  const workflowWakeRevision = await enqueueSessionWorkflowWakeIfRunnable(input.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    sessionId: session.id,
    temporalWorkflowId: workflowId,
    reason: "scheduled_retry",
  });
  const result = {
    action: generatedSession ? "start" : "signal",
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    sessionId: session.id,
    triggerEventId: scheduledUpdate.wakeEventId,
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

async function replayScheduledTaskDispatch(input: {
  db: Database;
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
  task: ScheduledTask;
  run: ScheduledTaskRun;
  acceptedExecution: ScheduledTaskRunAcceptedExecution;
}): Promise<DispatchScheduledTaskRunResult> {
  if (!input.run.sessionId || !input.run.triggerEventId) {
    throw new Error("dispatched scheduled task run is missing its delivery identity");
  }
  const sessionId = input.run.sessionId;
  const triggerEventId = input.run.triggerEventId;
  await requireSession(input.db, input.task.workspaceId, sessionId);
  await recordUsageEvent(input.db, {
    accountId: input.task.accountId,
    workspaceId: input.task.workspaceId,
    eventType: "agent_run.created",
    quantity: 1,
    unit: "run",
    sourceResourceType: "scheduled_task_run",
    sourceResourceId: input.run.id,
    sessionId,
    initiator: input.acceptedExecution.triggerInitiator,
    initiatorContext: {
      scheduledTaskId: input.task.id,
      scheduledTaskRunId: input.run.id,
    },
    origin: "scheduled_task",
    idempotencyKey:
      input.acceptedExecution.agentRunUsageIdempotencyKey ??
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
    action: input.acceptedExecution.task.runMode === "new_session_per_run" ? "start" : "signal",
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
