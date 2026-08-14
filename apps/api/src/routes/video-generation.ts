import {
  UpdateVideoGenerationPolicyRequest,
  VideoGenerationOperationSummary,
  VideoGenerationPolicy,
  WorkspaceVideoGenerationSettings,
} from "@opengeni/contracts";
import {
  getVideoGenerationOperationSummary,
  getWorkspaceVercelAiGatewayConnectionMetadata,
  getWorkspaceVideoGenerationPolicy,
  updateWorkspaceVideoGenerationPolicy,
  VideoGenerationConflictError,
  workspaceXaiSubscriptionActive,
} from "@opengeni/db";
import {
  requireAccessGrant,
  VIDEO_GENERATION_MODEL_CATALOG,
  videoGenerationModelSupportsFundingSource,
  videoGenerationCapabilitiesForPolicy,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerVideoGenerationRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/video-generation", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const [policy, connection, supergrokConfigured] = await Promise.all([
      getWorkspaceVideoGenerationPolicy(deps.db, workspaceId),
      getWorkspaceVercelAiGatewayConnectionMetadata(deps.db, workspaceId),
      workspaceXaiSubscriptionActive(deps.db, deps.settings, workspaceId, grant.subjectId),
    ]);
    const fundingOptions = videoGenerationFundingOptions({
      managedConfigured: managedVideoGenerationConfigured(deps),
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = UpdateVideoGenerationPolicyRequest.parse(await c.req.json());
    const [connection, supergrokConfigured] = await Promise.all([
      getWorkspaceVercelAiGatewayConnectionMetadata(deps.db, workspaceId),
      workspaceXaiSubscriptionActive(deps.db, deps.settings, workspaceId, grant.subjectId),
    ]);
    const fundingOptions = videoGenerationFundingOptions({
      managedConfigured: managedVideoGenerationConfigured(deps),
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
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const summary = await getVideoGenerationOperationSummary(
      deps.db,
      workspaceId,
      c.req.param("operationId"),
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
  workspaceGatewayConfigured: boolean;
  supergrokConfigured: boolean;
}) {
  return [
    {
      source: "opengeni_credits" as const,
      label: "OpenGeni",
      description: "Uses OpenGeni credits through the managed Gateway route.",
      available: input.managedConfigured,
      unavailableReason: input.managedConfigured
        ? null
        : "OpenGeni-managed video generation is not configured.",
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
