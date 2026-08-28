import { resolveTurnExecutionPolicyV1, WORKSPACE_GATEWAY_MODEL_ID_PREFIX } from "@opengeni/config";
import {
  assertWorkspaceModelPolicyAllows,
  canonicalConfiguredModel,
  createAndStartSessionWithOutcome,
  recordWorkspaceUsage,
  resolveCatalogSettings,
  resolveWorkspaceCatalogSettings,
} from "@opengeni/core";
import {
  AutomationAuthorityRevokedError,
  assertAutomationRunAuthorityInTransaction,
  claimAutomationRun,
  settleAutomationRun,
} from "@opengeni/db";
import { agentRunAdmissionDenial } from "./agent-run-admission";
import type {
  ControlActivityServices,
  DispatchAutomationRunInput,
  DispatchAutomationRunResult,
} from "./types";

export type AutomationActivityOptions = {
  claim?: typeof claimAutomationRun;
  settle?: typeof settleAutomationRun;
  assertAuthority?: typeof assertAutomationRunAuthorityInTransaction;
  createSession?: typeof createAndStartSessionWithOutcome;
  admit?: typeof agentRunAdmissionDenial;
  assertModelPolicy?: typeof assertWorkspaceModelPolicyAllows;
  recordUsage?: typeof recordWorkspaceUsage;
};

export function createAutomationActivities(
  services: () => Promise<ControlActivityServices>,
  options: AutomationActivityOptions = {},
) {
  const claim = options.claim ?? claimAutomationRun;
  const settle = options.settle ?? settleAutomationRun;
  const assertAuthority = options.assertAuthority ?? assertAutomationRunAuthorityInTransaction;
  const createSession = options.createSession ?? createAndStartSessionWithOutcome;
  const admit = options.admit ?? agentRunAdmissionDenial;
  const assertModelPolicy = options.assertModelPolicy ?? assertWorkspaceModelPolicyAllows;
  const recordUsage = options.recordUsage ?? recordWorkspaceUsage;
  return {
    dispatchAutomationRun: async (
      input: DispatchAutomationRunInput,
    ): Promise<DispatchAutomationRunResult> => {
      const service = await services();
      const catalogSourceSettings = service.catalogSourceSettings ?? service.settings;
      const deploymentCatalogSettings = (
        await resolveCatalogSettings(service.db, catalogSourceSettings)
      ).settings;
      const run = await claim(service.db, input);
      if (!run) return { action: "not_found" };
      if (run.status === "dispatched") {
        if (!run.sessionId) throw new Error("dispatched automation run is missing its session");
        return { action: "already_dispatched", sessionId: run.sessionId };
      }
      if (run.status === "skipped") {
        return { action: "skipped", reason: run.errorCode ?? "authority_revoked" };
      }

      const accepted = run.acceptedExecution;
      if (
        accepted.accountId !== input.accountId ||
        accepted.workspaceId !== input.workspaceId ||
        accepted.sourceId !== run.sourceId ||
        accepted.triggerId !== run.triggerId ||
        accepted.triggerRevision !== run.triggerRevision ||
        accepted.eventId !== run.eventId
      ) {
        await settle(service.db, {
          workspaceId: input.workspaceId,
          runId: run.id,
          status: "skipped",
          errorCode: "accepted_execution_mismatch",
        });
        return { action: "skipped", reason: "accepted_execution_mismatch" };
      }

      const template = accepted.sessionTemplate;
      const requestedModel = template.model ?? deploymentCatalogSettings.openaiModel;
      const catalogSettings = requestedModel.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX)
        ? (
            await resolveWorkspaceCatalogSettings(service.db, catalogSourceSettings, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
            })
          ).settings
        : deploymentCatalogSettings;
      const catalogService = { ...service, settings: catalogSettings };
      const model = canonicalConfiguredModel(catalogSettings, requestedModel);
      if (!model) throw new Error("automation has no configured model");
      await assertModelPolicy(service.db, catalogSettings, input.workspaceId, model);
      const denial = await admit(catalogService, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        model,
        requestedAgentRuns: 1,
      });
      if (denial) {
        await settle(service.db, {
          workspaceId: input.workspaceId,
          runId: run.id,
          status: "failed",
          errorCode: denial,
        });
        throw new Error(`automation admission denied: ${denial}`);
      }
      const reasoningEffort = template.reasoningEffort ?? catalogSettings.openaiReasoningEffort;
      const sandboxBackend = template.sandboxBackend ?? catalogSettings.sandboxBackend;
      if (sandboxBackend === "selfhosted") {
        await settle(service.db, {
          workspaceId: input.workspaceId,
          runId: run.id,
          status: "skipped",
          errorCode: "interactive_compute_not_allowed",
        });
        return { action: "skipped", reason: "interactive_compute_not_allowed" };
      }
      const turnExecutionPolicy = resolveTurnExecutionPolicyV1(catalogSettings, {
        modelId: model,
        requestedModelId: template.model,
        modelSource: template.model ? "explicit" : "deployment",
        reasoningEffort,
        reasoningSource: template.reasoningEffort ? "explicit" : "deployment",
        latencyMode: "standard",
        latencyModeSource: "deployment",
      });

      try {
        const created = await createSession({
          db: service.db,
          bus: service.bus,
          workflowClient: {
            wakeSessionWorkflow: async (wake) => {
              await service.wakeSessionWorkflow?.(wake);
            },
          },
          beforeCreateCommit: async (tx, sessionId) => {
            await assertAuthority(tx, {
              workspaceId: input.workspaceId,
              runId: run.id,
              triggerId: accepted.triggerId,
              triggerRevision: accepted.triggerRevision,
              sourceId: accepted.sourceId,
              sourceVersion: accepted.sourceVersion,
              sessionId,
            });
          },
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          initialMessage: accepted.initialMessage,
          resources: template.resources,
          skills: template.skills,
          tools: template.tools,
          toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
          model,
          reasoningEffort,
          turnExecutionPolicy,
          sandboxBackend,
          metadata: {
            ...template.metadata,
            automationRunId: run.id,
            automationSourceId: run.sourceId,
            automationTriggerId: run.triggerId,
            automationTriggerRevision: run.triggerRevision,
          },
          createdBy: {
            kind: "service",
            subjectId: accepted.serviceSubjectId,
            label: accepted.serviceLabel,
          },
          createdByContext: accepted.provenance,
          instructions: template.instructions,
          policyRole: template.policyRole,
          firstPartyMcpPermissions: template.firstPartyMcpPermissions,
          firstPartyMcpTools: template.firstPartyMcpTools,
          createIdempotencyKey: `automation-run:${run.id}`,
          subjectId: accepted.serviceSubjectId,
        });
        await recordUsage(
          { db: service.db, settings: catalogSettings },
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: accepted.serviceSubjectId,
            eventType: "agent_run.created",
            quantity: 1,
            unit: "run",
            sourceResourceType: "automation_run",
            sourceResourceId: run.id,
            sessionId: created.session.id,
            initiator: created.session.createdBy,
            initiatorContext: created.session.createdByContext,
            origin: "system",
            idempotencyKey: `agent_run.created:automation:${run.id}`,
          },
        ).catch((error) => {
          service.observability.warn("automation usage recording failed", {
            workspaceId: input.workspaceId,
            runId: run.id,
            errorCategory: error instanceof Error ? error.name : "unknown",
          });
        });
        return { action: "started", sessionId: created.session.id };
      } catch (error) {
        if (error instanceof AutomationAuthorityRevokedError) {
          await settle(service.db, {
            workspaceId: input.workspaceId,
            runId: run.id,
            status: "skipped",
            errorCode: "authority_revoked",
          });
          return { action: "skipped", reason: "authority_revoked" };
        }
        await settle(service.db, {
          workspaceId: input.workspaceId,
          runId: run.id,
          status: "failed",
          errorCode: "dispatch_failed",
        });
        throw error;
      }
    },
  };
}
