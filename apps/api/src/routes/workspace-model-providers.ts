import { claudeProviderId } from "@opengeni/config";
import { requireSameOriginBrowserMutation } from "./codex";
import { createHash } from "node:crypto";
import {
  CreateWorkspaceGatewayCustomModelRequest,
  DeleteWorkspaceGatewayCustomModelRequest,
  WorkspaceGatewayCustomModel,
  WorkspaceGatewayCustomModelsResponse,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireWorkspaceSettingsGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createWorkspaceProviderCustomModel,
  deleteWorkspaceProviderCustomModel,
  listWorkspaceProviderCustomModels,
  replayWorkspaceProviderCustomModelCreate,
  nestedPostgresSqlState,
  WorkspaceClaudeCustomModelLimitError,
  type WorkspaceProviderCustomModel,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const Kind = z.enum(["anthropic", "claude_subscription"]);
function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function modelJson(model: WorkspaceProviderCustomModel) {
  return WorkspaceGatewayCustomModel.parse({
    ...model,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  });
}

/** Workspace-owned Claude models use the same immutable-generation protocol as gateway models. */
export function registerWorkspaceModelProviderRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/workspaces/:workspaceId/model-providers/:providerKind/custom-models";
  async function scope(c: Context, mutate: boolean) {
    const parsedKind = Kind.safeParse(c.req.param("providerKind"));
    if (!parsedKind.success) throw new HTTPException(404, { message: "Model provider not found" });
    const providerKind = parsedKind.data;
    if (providerKind === "claude_subscription" && !deps.settings.claudeSubscriptionEnabled)
      throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
    const workspaceId = c.req.param("workspaceId")!;
    const grant = mutate
      ? await requireWorkspaceSettingsGrant(c, deps, workspaceId)
      : await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    c.header("cache-control", "private, no-store");
    return { accountId: grant.accountId, workspaceId, providerKind, subjectId: grant.subjectId };
  }
  app.get(path, async (c) => {
    const input = await scope(c, false);
    const models = await listWorkspaceProviderCustomModels(deps.db, input);
    return c.json(WorkspaceGatewayCustomModelsResponse.parse({ models: models.map(modelJson) }));
  });
  const usagePath = "/v1/workspaces/:workspaceId/model-providers/:providerKind/usage";
  app.get(usagePath, async (c) => {
    const input = await scope(c, false);
    if (input.providerKind !== "claude_subscription")
      throw new HTTPException(404, { message: "Usage not available for this provider" });
    throw new HTTPException(410, { message: "Check usage on the individual Claude account." });
  });
  app.post(`${usagePath}/refresh`, async (c) => {
    requireSameOriginBrowserMutation(c, deps);
    const input = await scope(c, false);
    if (input.providerKind !== "claude_subscription")
      throw new HTTPException(404, { message: "Usage not available for this provider" });
    await requireAccessGrant(c, deps, input.workspaceId, "connections:write");
    throw new HTTPException(410, { message: "Check usage on the individual Claude account." });
  });
  app.post(path, async (c) => {
    const input = await scope(c, true);
    const parsed = CreateWorkspaceGatewayCustomModelRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) throw new HTTPException(422, { message: "Invalid custom model" });
    const payload = parsed.data;
    if (
      `${claudeProviderId(input.providerKind, "workspace")}/${payload.upstreamModelId}`.length > 256
    )
      throw new HTTPException(422, { message: "Claude model ID is too long" });
    const hash = requestHash({
      action: "create",
      upstreamModelId: payload.upstreamModelId,
      label: payload.label ?? null,
    });
    const replay = await replayWorkspaceProviderCustomModelCreate(deps.db, {
      ...input,
      operationId: payload.operationId,
      requestHash: hash,
    });
    if (replay.outcome === "conflict")
      throw new HTTPException(409, {
        message: "Custom model operation conflicts with current state",
      });
    if (replay.outcome === "success") return c.json(modelJson(replay.model), 201);
    try {
      const model = await createWorkspaceProviderCustomModel(deps.db, {
        ...input,
        ...payload,
        label: payload.label ?? null,
        requestHash: hash,
        createdBySubjectId: input.subjectId,
      });
      if (!model || model.retiredAt)
        throw new HTTPException(409, {
          message: "Custom model operation conflicts with current state",
        });
      return c.json(modelJson(model), 201);
    } catch (error) {
      if (error instanceof WorkspaceClaudeCustomModelLimitError)
        throw new HTTPException(422, { message: error.message });
      if (nestedPostgresSqlState(error) === "23505")
        throw new HTTPException(422, { message: "Custom model already exists" });
      throw error;
    }
  });
  app.delete(`${path}/:customModelId`, async (c) => {
    const input = await scope(c, true);
    const id = z.string().uuid().safeParse(c.req.param("customModelId"));
    const parsed = DeleteWorkspaceGatewayCustomModelRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!id.success || !parsed.success)
      throw new HTTPException(422, { message: "Invalid custom model deletion" });
    const customModelId = id.data;
    const removed = await deleteWorkspaceProviderCustomModel(deps.db, {
      ...input,
      ...parsed.data,
      customModelId,
      requestHash: requestHash({
        action: "delete",
        customModelId,
        expectedVersion: parsed.data.expectedVersion,
      }),
    });
    if (removed.outcome === "not_found")
      throw new HTTPException(404, { message: "Custom model not found" });
    if (removed.outcome === "conflict")
      throw new HTTPException(409, { message: "Custom model changed; reload and retry" });
    return c.body(null, 204);
  });
}
