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
} from "@opengeni/db";
import {
  requireAccessGrant,
  VIDEO_GENERATION_MODEL_CATALOG,
  videoGenerationCapabilitiesForPolicy,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerVideoGenerationRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/video-generation", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const [policy, connection] = await Promise.all([
      getWorkspaceVideoGenerationPolicy(deps.db, workspaceId),
      getWorkspaceVercelAiGatewayConnectionMetadata(deps.db, workspaceId),
    ]);
    const capabilities =
      connection && policy.defaultModelId && policy.enabledModelIds.length > 0
        ? videoGenerationCapabilitiesForPolicy({
            policy,
            credentialVersion: connection.version,
          })
        : null;
    return c.json(
      WorkspaceVideoGenerationSettings.parse({
        schemaVersion: 1,
        policy,
        providerConfigured: connection !== null,
        availableModels: VIDEO_GENERATION_MODEL_CATALOG,
        capabilities,
      }),
    );
  });

  app.put("/v1/workspaces/:workspaceId/video-generation/policy", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const payload = UpdateVideoGenerationPolicyRequest.parse(await c.req.json());
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
    if (!summary) throw new HTTPException(404, { message: "video generation operation not found" });
    return c.json(VideoGenerationOperationSummary.parse(summary));
  });
}
