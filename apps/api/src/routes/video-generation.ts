import {
  UpdateVideoGenerationPolicyRequest,
  VideoGenerationOperationSummary,
  VideoGenerationPolicy,
  WorkspaceVideoGenerationSettings,
} from "@opengeni/contracts";
import {
  getVideoGenerationOperationSummary,
  withSessionRlsActorContext,
  getWorkspaceVercelAiGatewayConnectionMetadata,
  getWorkspaceModelPolicy,
  getWorkspaceVideoGenerationPolicy,
  updateWorkspaceVideoGenerationPolicy,
  VideoGenerationConflictError,
} from "@opengeni/db";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  fileOwnerContextForAccess,
  requireWorkspaceSettingsGrant,
  VIDEO_GENERATION_MODEL_CATALOG,
  videoGenerationModelSupportsFundingSource,
  videoGenerationCapabilitiesForPolicy,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseRequestJson } from "../http/request-body";
import { workspaceXaiOperationAvailable } from "../xai-subscription-core";

export function registerVideoGenerationRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/video-generation", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const [policy, connection, supergrokConfigured, modelPolicy] = await Promise.all([
      getWorkspaceVideoGenerationPolicy(deps.db, workspaceId),
      getWorkspaceVercelAiGatewayConnectionMetadata(deps.db, workspaceId),
      workspaceXaiOperationAvailable(deps.db, deps.settings, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
      }),
      getWorkspaceModelPolicy(deps.db, workspaceId),
    ]);
    const fundingOptions = videoGenerationFundingOptions({
      managedConfigured: managedVideoGenerationConfigured(deps),
      creditsDisabled: modelPolicy?.allowCreditModels === false,
      workspaceGatewayConfigured: connection !== null,
      supergrokConfigured,
    });
    const selectedFunding = fundingOptions.find((option) => option.source === policy.fundingSource);
    const capabilities =
      selectedFunding?.available && policy.defaultModelId && policy.enabledModelIds.length > 0
        ? videoGenerationCapabilitiesForPolicy({
            policy,
            credentialVersion:
              policy.fundingSource === "workspace_gateway" ? (connection?.version ?? 0) : 1,
          })
        : null;
    return c.json(
      WorkspaceVideoGenerationSettings.parse({
        schemaVersion: 1,
        policy,
        fundingOptions,
        availableModels: VIDEO_GENERATION_MODEL_CATALOG,
        capabilities,
      }),
    );
  });

  app.put("/v1/workspaces/:workspaceId/video-generation/policy", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireWorkspaceSettingsGrant(c, deps, workspaceId);
    const payload = await parseRequestJson(c, UpdateVideoGenerationPolicyRequest);
    const [connection, supergrokConfigured, modelPolicy] = await Promise.all([
      getWorkspaceVercelAiGatewayConnectionMetadata(deps.db, workspaceId),
      workspaceXaiOperationAvailable(deps.db, deps.settings, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
      }),
      getWorkspaceModelPolicy(deps.db, workspaceId),
    ]);
    const fundingOptions = videoGenerationFundingOptions({
      managedConfigured: managedVideoGenerationConfigured(deps),
      creditsDisabled: modelPolicy?.allowCreditModels === false,
      workspaceGatewayConfigured: connection !== null,
      supergrokConfigured,
    });
    const selectedFunding = fundingOptions.find(
      (option) => option.source === payload.fundingSource,
    );
    if (payload.enabledModelIds.length > 0 && !selectedFunding?.available) {
      throw new HTTPException(422, {
        message: selectedFunding?.unavailableReason ?? "Video generation funding is unavailable",
      });
    }
    if (
      payload.enabledModelIds.some(
        (modelId) => !videoGenerationModelSupportsFundingSource(modelId, payload.fundingSource),
      )
    ) {
      throw new HTTPException(422, {
        message: "The selected video model is unavailable for this funding source",
      });
    }
    try {
      const policy = await updateWorkspaceVideoGenerationPolicy(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        ...payload,
      });
      return c.json(VideoGenerationPolicy.parse(policy));
    } catch (error) {
      if (error instanceof VideoGenerationConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      if (error instanceof Error && error.message.startsWith("Unknown video generation model:")) {
        throw new HTTPException(422, { message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/video-generation/operations/:operationId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "workspace:read");
    const actor = await fileOwnerContextForAccess(deps, access, "workspace:read");
    const summary = await withSessionRlsActorContext(actor, () =>
      getVideoGenerationOperationSummary(deps.db, workspaceId, c.req.param("operationId")),
    );
    if (!summary)
      throw new HTTPException(404, {
        message: "video generation operation not found",
      });
    return c.json(VideoGenerationOperationSummary.parse(summary));
  });
}

function managedVideoGenerationConfigured(deps: ApiRouteDeps): boolean {
  return Boolean(deps.settings.vercelAiGatewayApiKey && deps.settings.environmentsEncryptionKey);
}

function videoGenerationFundingOptions(input: {
  managedConfigured: boolean;
  /** The workspace turned Opengeni credits off (model policy). */
  creditsDisabled: boolean;
  workspaceGatewayConfigured: boolean;
  supergrokConfigured: boolean;
}) {
  return [
    {
      source: "opengeni_credits" as const,
      label: "Opengeni",
      description: "Uses Opengeni credits through the managed Gateway route.",
      available: input.managedConfigured && !input.creditsDisabled,
      unavailableReason: !input.managedConfigured
        ? "Opengeni-managed video generation is not configured."
        : input.creditsDisabled
          ? "Opengeni credits are turned off in this workspace."
          : null,
    },
    {
      source: "supergrok_subscription" as const,
      label: "SuperGrok",
      description: "Uses your connected SuperGrok subscription.",
      available: input.supergrokConfigured,
      unavailableReason: input.supergrokConfigured
        ? null
        : "Connect an eligible SuperGrok account first.",
    },
    {
      source: "workspace_gateway" as const,
      label: "Your Gateway",
      description: "Uses your workspace Vercel AI Gateway key.",
      available: input.workspaceGatewayConfigured,
      unavailableReason: input.workspaceGatewayConfigured
        ? null
        : "Connect a workspace Vercel AI Gateway key first.",
    },
  ];
}
