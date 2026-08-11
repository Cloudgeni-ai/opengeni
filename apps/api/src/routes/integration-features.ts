import {
  IntegrationFeatureMutationResult,
  IntegrationFeatureRemovalResult,
  IntegrationInstanceFeaturesResponse,
  MutateIntegrationFeatureRequest,
  UpsertIntegrationFeatureRequest,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  configureIntegrationFeature,
  IntegrationFeatureBindingOwnershipConflictError,
  IntegrationFeatureBindingVersionConflictError,
  IntegrationFeatureBindingVersionRequiredError,
  IntegrationFeatureConfigError,
  IntegrationFeatureConnectionError,
  IntegrationFeatureNotFoundError,
  IntegrationFeatureOperationIdempotencyError,
  listIntegrationInstanceFeatures,
  removeIntegrationFeature,
  setIntegrationFeatureLifecycle,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerIntegrationFeatureRoutes(
  app: Hono,
  deps: ApiRouteDeps,
): void {
  app.get(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(
        c,
        deps,
        workspaceId,
        "workspace:read",
      );
      try {
        return c.json(
          IntegrationInstanceFeaturesResponse.parse(
            await listIntegrationInstanceFeatures(
              deps.db,
              workspaceId,
              grant.subjectId,
              decoded(c.req.param("capabilityId")),
              decoded(c.req.param("instanceKey")),
            ),
          ),
        );
      } catch (error) {
        throw featureHttpError(error);
      }
    },
  );

  app.put(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features/:featureKey",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(
        c,
        deps,
        workspaceId,
        "workspace:admin",
      );
      const payload = UpsertIntegrationFeatureRequest.parse(await c.req.json());
      try {
        return c.json(
          IntegrationFeatureMutationResult.parse(
            await configureIntegrationFeature(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              capabilityId: decoded(c.req.param("capabilityId")),
              instanceKey: decoded(c.req.param("instanceKey")),
              featureKey: decoded(c.req.param("featureKey")),
              displayName: payload.displayName,
              config: payload.config,
              ...(payload.expectedVersion !== undefined
                ? { expectedVersion: payload.expectedVersion }
                : {}),
              idempotencyKey: payload.idempotencyKey,
            }),
          ),
          payload.expectedVersion === undefined ? 201 : 200,
        );
      } catch (error) {
        throw featureHttpError(error);
      }
    },
  );

  for (const action of ["pause", "resume"] as const) {
    app.post(
      `/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features/:featureKey/${action}`,
      async (c) => {
        const workspaceId = c.req.param("workspaceId");
        const grant = await requireAccessGrant(
          c,
          deps,
          workspaceId,
          "workspace:admin",
        );
        const payload = MutateIntegrationFeatureRequest.parse(
          await c.req.json(),
        );
        try {
          return c.json(
            IntegrationFeatureMutationResult.parse(
              await setIntegrationFeatureLifecycle(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                subjectId: grant.subjectId,
                capabilityId: decoded(c.req.param("capabilityId")),
                instanceKey: decoded(c.req.param("instanceKey")),
                featureKey: decoded(c.req.param("featureKey")),
                action,
                expectedVersion: payload.expectedVersion,
                idempotencyKey: payload.idempotencyKey,
              }),
            ),
          );
        } catch (error) {
          throw featureHttpError(error);
        }
      },
    );
  }

  app.delete(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features/:featureKey",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(
        c,
        deps,
        workspaceId,
        "workspace:admin",
      );
      const payload = MutateIntegrationFeatureRequest.parse(await c.req.json());
      try {
        return c.json(
          IntegrationFeatureRemovalResult.parse(
            await removeIntegrationFeature(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              capabilityId: decoded(c.req.param("capabilityId")),
              instanceKey: decoded(c.req.param("instanceKey")),
              featureKey: decoded(c.req.param("featureKey")),
              expectedVersion: payload.expectedVersion,
              idempotencyKey: payload.idempotencyKey,
            }),
          ),
        );
      } catch (error) {
        throw featureHttpError(error);
      }
    },
  );
}

function decoded(value: string): string {
  return decodeURIComponent(value);
}

function featureHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof IntegrationFeatureNotFoundError) {
    return new HTTPException(404, { message: error.message });
  }
  if (
    error instanceof IntegrationFeatureBindingVersionConflictError ||
    error instanceof IntegrationFeatureBindingVersionRequiredError ||
    error instanceof IntegrationFeatureBindingOwnershipConflictError ||
    error instanceof IntegrationFeatureOperationIdempotencyError
  ) {
    return new HTTPException(409, {
      message:
        "The Integration feature changed, is shared, or reused an idempotency key. Refresh before retrying.",
    });
  }
  if (
    error instanceof IntegrationFeatureConfigError ||
    error instanceof IntegrationFeatureConnectionError
  ) {
    return new HTTPException(422, { message: error.message });
  }
  throw error;
}
