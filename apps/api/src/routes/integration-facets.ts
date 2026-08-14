import {
  IntegrationFacetMutationResult,
  IntegrationFacetRemovalResult,
  IntegrationInstanceFacetsResponse,
  MutateIntegrationFacetRequest,
  UpsertIntegrationFacetRequest,
} from "@opengeni/contracts";
import {
  hasPermission,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  configureIntegrationFacet,
  integrationFacetConfigureRequestDigest,
  IntegrationFacetBindingOwnershipConflictError,
  IntegrationFacetBindingVersionConflictError,
  IntegrationFacetBindingVersionRequiredError,
  IntegrationFacetConfigError,
  IntegrationFacetConnectionError,
  IntegrationFacetNotFoundError,
  IntegrationFacetOperationIdempotencyError,
  listIntegrationInstanceFacets,
  removeIntegrationFacet,
  replayCompletedIntegrationFacetOperation,
  setIntegrationFacetLifecycle,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  browseGoogleDriveFacetSource,
  saveGoogleDriveFacetSource,
} from "../integrations/google-drive";

export function registerIntegrationFacetRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/browse",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "connections:read");
      try {
        return c.json(
          await browseGoogleDriveFacetSource(deps, {
            workspaceId,
            subjectId: grant.subjectId,
            capabilityId: decoded(c.req.param("capabilityId")),
            instanceKey: decoded(c.req.param("instanceKey")),
            facetKey: decoded(c.req.param("facetKey")),
            parentId: c.req.query("parentId") ?? "root",
            ...(c.req.query("pageToken") ? { pageToken: c.req.query("pageToken") } : {}),
          }),
        );
      } catch (error) {
        throw facetHttpError(error);
      }
    },
  );

  app.put(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/source",
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
          IntegrationFacetMutationResult.parse(
            await saveGoogleDriveFacetSource(deps, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              capabilityId: decoded(c.req.param("capabilityId")),
              instanceKey: decoded(c.req.param("instanceKey")),
              facetKey: decoded(c.req.param("facetKey")),
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
        throw facetHttpError(error);
      }
    },
  );

  app.get(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
      try {
        return c.json(
          IntegrationInstanceFacetsResponse.parse(
            await listIntegrationInstanceFacets(
              deps.db,
              workspaceId,
              grant.subjectId,
              decoded(c.req.param("capabilityId")),
              decoded(c.req.param("instanceKey")),
            ),
          ),
        );
      } catch (error) {
        throw facetHttpError(error);
      }
    },
  );

  app.put(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
      const payload = UpsertIntegrationFacetRequest.parse(await c.req.json());
      const capabilityId = decoded(c.req.param("capabilityId"));
      const instanceKey = decoded(c.req.param("instanceKey"));
      const facetKey = decoded(c.req.param("facetKey"));
      try {
        const replayed =
          await replayCompletedIntegrationFacetOperation<IntegrationFacetMutationResult>(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
            capabilityId,
            instanceKey,
            facetKey,
            idempotencyKey: payload.idempotencyKey,
            kind: "configure",
            expectedRequestDigest: integrationFacetConfigureRequestDigest({
              capabilityId,
              instanceKey,
              facetKey,
              displayName: payload.displayName,
              config: payload.config,
              ...(payload.expectedVersion !== undefined
                ? { expectedVersion: payload.expectedVersion }
                : {}),
            }),
          });
        if (replayed) {
          return c.json(
            IntegrationFacetMutationResult.parse(replayed),
            payload.expectedVersion === undefined ? 201 : 200,
          );
        }
        const instance = await listIntegrationInstanceFacets(
          deps.db,
          workspaceId,
          grant.subjectId,
          capabilityId,
          instanceKey,
        );
        const definition = instance.facets.find(
          (facet) => facet.definition.facetKey === facetKey,
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
          IntegrationFacetMutationResult.parse(
            await configureIntegrationFacet(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              capabilityId,
              instanceKey,
              facetKey,
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
        throw facetHttpError(error);
      }
    },
  );

  for (const action of ["pause", "resume"] as const) {
    app.post(
      `/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/${action}`,
      async (c) => {
        const workspaceId = c.req.param("workspaceId");
        const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
        const payload = MutateIntegrationFacetRequest.parse(await c.req.json());
        try {
          return c.json(
            IntegrationFacetMutationResult.parse(
              await setIntegrationFacetLifecycle(deps.db, {
                accountId: grant.accountId,
                workspaceId,
                subjectId: grant.subjectId,
                capabilityId: decoded(c.req.param("capabilityId")),
                instanceKey: decoded(c.req.param("instanceKey")),
                facetKey: decoded(c.req.param("facetKey")),
                action,
                expectedVersion: payload.expectedVersion,
                idempotencyKey: payload.idempotencyKey,
              }),
            ),
          );
        } catch (error) {
          throw facetHttpError(error);
        }
      },
    );
  }

  app.delete(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
      const payload = MutateIntegrationFacetRequest.parse(await c.req.json());
      try {
        return c.json(
          IntegrationFacetRemovalResult.parse(
            await removeIntegrationFacet(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              subjectId: grant.subjectId,
              capabilityId: decoded(c.req.param("capabilityId")),
              instanceKey: decoded(c.req.param("instanceKey")),
              facetKey: decoded(c.req.param("facetKey")),
              expectedVersion: payload.expectedVersion,
              idempotencyKey: payload.idempotencyKey,
            }),
          ),
        );
      } catch (error) {
        throw facetHttpError(error);
      }
    },
  );
}

function decoded(value: string): string {
  return decodeURIComponent(value);
}

function facetHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof IntegrationFacetNotFoundError) {
    return new HTTPException(404, { message: error.message });
  }
  if (
    error instanceof IntegrationFacetBindingVersionConflictError ||
    error instanceof IntegrationFacetBindingVersionRequiredError ||
    error instanceof IntegrationFacetBindingOwnershipConflictError ||
    error instanceof IntegrationFacetOperationIdempotencyError
  ) {
    return new HTTPException(409, {
      message:
        "The Integration facet changed, is shared, or reused an idempotency key. Refresh before retrying.",
    });
  }
  if (
    error instanceof IntegrationFacetConfigError ||
    error instanceof IntegrationFacetConnectionError
  ) {
    return new HTTPException(422, { message: error.message });
  }
  throw error;
}
