import {
  resolveTurnExecutionPolicyV1,
  WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
  WORKSPACE_OPENROUTER_MODEL_ID_PREFIX,
} from "@opengeni/config";
import {
  agentConfigMayResolve,
  applySessionAgentConfigWriteThrough,
  assertWorkspaceModelPolicyAllows,
  canonicalConfiguredModel,
  resolveSessionAgentConfigForCreate,
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
  requireWorkspace,
} from "@opengeni/db";
import { SessionSkills } from "@opengeni/contracts";
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
  /** Workspace read for agent-configuration defaults (tests inject it). */
  readWorkspace?: typeof requireWorkspace;
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
  const readWorkspace = options.readWorkspace ?? requireWorkspace;
  const admit = options.admit ?? agentRunAdmissionDenial;
  const assertModelPolicy = options.assertModelPolicy ?? assertWorkspaceModelPolicyAllows;
  const recordUsage = options.recordUsage ?? recordWorkspaceUsage;
  return {
    settleAutomationRunFailure: async (input: DispatchAutomationRunInput): Promise<void> => {
      const service = await services();
      await settle(service.db, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        status: "failed",
        errorCode: "dispatch_failed",
      });
    },
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
        return {
          action: "skipped",
          reason: run.errorCode ?? "authority_revoked",
        };
      }
      if (run.status === "failed") {
        return { action: "failed", reason: run.errorCode ?? "dispatch_failed" };
      }

      try {
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
        const catalogSettings =
          requestedModel.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX) ||
          requestedModel.startsWith(WORKSPACE_OPENROUTER_MODEL_ID_PREFIX)
            ? (
                await resolveWorkspaceCatalogSettings(service.db, catalogSourceSettings, {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  retainedProductModelId: requestedModel,
                })
              ).settings
            : deploymentCatalogSettings;
        const catalogService = { ...service, settings: catalogSettings };
        let model: string;
        try {
          const configuredModel = canonicalConfiguredModel(catalogSettings, requestedModel);
          if (!configuredModel) throw new Error("automation has no configured model");
          await assertModelPolicy(service.db, catalogSettings, input.workspaceId, configuredModel);
          model = configuredModel;
        } catch (error) {
          if (!isUnprocessableEntity(error)) throw error;
          await settle(service.db, {
            workspaceId: input.workspaceId,
            runId: run.id,
            status: "failed",
            errorCode: "dispatch_failed",
          });
          return { action: "failed", reason: "dispatch_failed" };
        }
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
          return { action: "failed", reason: denial };
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
          return {
            action: "skipped",
            reason: "interactive_compute_not_allowed",
          };
        }
        // Agent configuration for the generated session (null = legacy). The
        // template's explicit tools are its baseline; capabilities only narrow.
        let agentWriteThrough: {
          config: import("@opengeni/contracts").ResolvedAgentConfig | null;
          instructions: string | undefined;
          firstPartyMcpTools: typeof template.firstPartyMcpTools;
          tools: typeof template.tools;
        };
        try {
          const workspaceSettings = agentConfigMayResolve(catalogSettings, template.agent)
            ? (await readWorkspace(service.db, input.workspaceId)).settings
            : {};
          const resolution = resolveSessionAgentConfigForCreate({
            settings: catalogSettings,
            creator: "automation",
            request: template.agent,
            instructions: template.instructions ?? undefined,
            workspaceSettings,
            parent: null,
            goal: false,
          });
          const written = applySessionAgentConfigWriteThrough({
            config: resolution.config,
            firstPartyMcpTools: template.firstPartyMcpTools,
            tools: template.tools,
            toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
            productServerIds: template.tools.map((tool) => tool.id),
          });
          agentWriteThrough = {
            config: resolution.config,
            instructions: resolution.instructions,
            firstPartyMcpTools: written.firstPartyMcpTools,
            tools: written.tools,
          };
        } catch (error) {
          if (!isUnprocessableEntity(error)) throw error;
          await settle(service.db, {
            workspaceId: input.workspaceId,
            runId: run.id,
            status: "failed",
            errorCode: "dispatch_failed",
          });
          return { action: "failed", reason: "dispatch_failed" };
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
          surface: "automation",
          resources: template.resources,
          skills: SessionSkills.parse(template.skills),
          bundledSkillIds: template.bundledSkillIds,
          tools: agentWriteThrough.tools,
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
          instructions: agentWriteThrough.instructions ?? template.instructions,
          policyRole: template.policyRole,
          firstPartyMcpPermissions: template.firstPartyMcpPermissions,
          firstPartyMcpTools: agentWriteThrough.firstPartyMcpTools,
          ...(agentWriteThrough.config ? { agentConfig: agentWriteThrough.config } : {}),
          retainWorkspaceCustomModel:
            model.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX) ||
            model.startsWith(WORKSPACE_OPENROUTER_MODEL_ID_PREFIX),
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
        throw error;
      }
    },
  };
}

function isUnprocessableEntity(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as Error & { status?: unknown }).status === 422
  );
}
