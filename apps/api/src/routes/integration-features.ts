import {
  IntegrationFeatureMutationResult,
  IntegrationFeatureRemovalResult,
  IntegrationInstanceFeaturesResponse,
  MutateIntegrationFeatureRequest,
  UpsertIntegrationFeatureRequest,
} from "@opengeni/contracts";
import {
  hasPermission,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
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

import {
  browseGoogleDriveIntegrationSource,
  saveGoogleDriveIntegrationSource,
} from "../integrations/google-drive";

export function registerIntegrationFeatureRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features/:featureKey/browse",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
      try {
        return c.json(
          await browseGoogleDriveIntegrationSource(deps, {
            workspaceId,
            subjectId: grant.subjectId,
            capabilityId: decoded(c.req.param("capabilityId")),
            instanceKey: decoded(c.req.param("instanceKey")),
            featureKey: decoded(c.req.param("featureKey")),
            parentId: c.req.query("parentId") ?? "root",
            ...(c.req.query("pageToken") ? { pageToken: c.req.query("pageToken") } : {}),
          }),
        );
      } catch (error) {
        throw featureHttpError(error);
      }
    },
  );

  app.put(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features/:featureKey/source",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "workspace:admin",
      );
      const { grant } = authorization;
      try {
        return c.json(
          IntegrationFeatureMutationResult.parse(
            await saveGoogleDriveIntegrationSource(deps, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              capabilityId: decoded(c.req.param("capabilityId")),
              instanceKey: decoded(c.req.param("instanceKey")),
              featureKey: decoded(c.req.param("featureKey")),
              payload: await c.req.json(),
              canManageOrganizationDestination:
                authorization.accountGrant?.permissions.includes("account:admin") === true,
              canManageWorkspaceDestination: hasPermission(grant.permissions, "workspace:admin"),
              canManagePersonalDestination:
                authorization.contextIntegrity &&
                authorization.authenticatedSubjectId === grant.subjectId,
            }),
          ),
        );
      } catch (error) {
        throw featureHttpError(error);
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
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
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
      const payload = UpsertIntegrationFeatureRequest.parse(await c.req.json());
      const capabilityId = decoded(c.req.param("capabilityId"));
      const instanceKey = decoded(c.req.param("instanceKey"));
      const featureKey = decoded(c.req.param("featureKey"));
      try {
        const instance = await listIntegrationInstanceFeatures(
          deps.db,
          workspaceId,
          grant.subjectId,
          capabilityId,
          instanceKey,
        );
        const definition = instance.features.find(
          (feature) => feature.definition.featureKey === featureKey,
        )?.definition;
        if (
          definition?.kind === "knowledge_source" &&
          definition.capabilities.provider === "google-drive"
        ) {
          throw new HTTPException(422, {
            message:
              "Google Drive source configuration requires the provider-specific source route",
          });
        }
        return c.json(
          IntegrationFeatureMutationResult.parse(
            await configureIntegrationFeature(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              capabilityId,
              instanceKey,
              featureKey,
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
        const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
        const payload = MutateIntegrationFeatureRequest.parse(await c.req.json());
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
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
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
