import {
  assertOrganizationIntegrationAllowed,
  IntegrationFacetMutationResult,
  IntegrationFacetRemovalResult,
  IntegrationInstanceFacetsResponse,
  MutateIntegrationFacetRequest,
  UpsertIntegrationFacetRequest,
} from "@opengeni/contracts";
import { withOrganizationIntegrationPolicyFence } from "@opengeni/db/organization-integration-policy";
import { CORE_INTEGRATION_DEFINITIONS } from "@opengeni/capabilities";
import {
  canRemoveIntegration,
  hasIntegrationAdminPermission,
  MissingPermissionRefusal,
  requireAccessGrant,
  requireIntegrationSetupAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  configureIntegrationFacet,
  integrationFacetConfigureRequestDigest,
  IntegrationChangeRequiresAdminError,
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
  type IntegrationFacetAcquisitionAuthorizer,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE } from "@opengeni/contracts/knowledge-source-sync-retirement";

import { parseRequestJson } from "../http/request-body";

export function registerIntegrationFacetRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/browse",
    async (c) => {
      // Knowledge-source facets are retired: integrations give agents tools,
      // and recurring work is an ordinary agent schedule. The routes stay so
      // older clients get a clear answer.
      await requireAccessGrant(c, deps, c.req.param("workspaceId"), "connections:read");
      throw new HTTPException(410, { message: KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE });
    },
  );

  app.put(
    "/v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/source",
    async (c) => {
      await requireIntegrationSetupAuthorization(c, deps, c.req.param("workspaceId"));
      throw new HTTPException(410, { message: KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE });
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
              (installerSubjectId) => canRemoveIntegration(grant, installerSubjectId),
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
      const { grant } = await requireIntegrationSetupAuthorization(c, deps, workspaceId);
      const payload = await parseRequestJson(c, UpsertIntegrationFacetRequest);
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
        // Stored Knowledge-source facets stay readable, pausable and
        // removable, but can no longer be configured.
        if (definition?.kind === "knowledge_source") {
          throw new HTTPException(410, { message: KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE });
        }
        return c.json(
          IntegrationFacetMutationResult.parse(
            await withOrganizationIntegrationPolicyFence(
              deps.db,
              { accountId: grant.accountId, workspaceId },
              (tx, policy) =>
                configureIntegrationFacet(tx, {
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
                  beforeAcquire: async (_db, context) =>
                    assertOrganizationIntegrationAllowed(
                      policy,
                      installedFacetIntegrationKey(context),
                    ),
                }),
            ),
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
        const { grant } = await requireIntegrationSetupAuthorization(c, deps, workspaceId);
        const payload = await parseRequestJson(c, MutateIntegrationFacetRequest);
        try {
          return c.json(
            IntegrationFacetMutationResult.parse(
              await withOrganizationIntegrationPolicyFence(
                deps.db,
                { accountId: grant.accountId, workspaceId },
                (tx, policy) =>
                  setIntegrationFacetLifecycle(tx, {
                    accountId: grant.accountId,
                    workspaceId,
                    subjectId: grant.subjectId,
                    capabilityId: decoded(c.req.param("capabilityId")),
                    instanceKey: decoded(c.req.param("instanceKey")),
                    facetKey: decoded(c.req.param("facetKey")),
                    action,
                    expectedVersion: payload.expectedVersion,
                    idempotencyKey: payload.idempotencyKey,
                    beforeAcquire: async (_db, context) =>
                      assertOrganizationIntegrationAllowed(
                        policy,
                        installedFacetIntegrationKey(context),
                      ),
                  }),
              ),
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
      const { grant } = await requireIntegrationSetupAuthorization(c, deps, workspaceId);
      const payload = await parseRequestJson(c, MutateIntegrationFacetRequest);
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
              // Members remove only sources and settings they added.
              ...(hasIntegrationAdminPermission(grant) ? {} : { memberRemoval: true }),
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

/** The DB context comes from the matching installed API facet and immutable
 * server-authored version manifest, never request metadata or a provider domain.
 */
function installedFacetIntegrationKey(
  context: Parameters<IntegrationFacetAcquisitionAuthorizer>[1],
): string | null {
  if (context.apiProtocol !== "openapi" && context.apiProtocol !== "graphql") return null;
  if (context.definitionProvenance === "workspace") return `custom:${context.apiProtocol}`;
  if (
    context.definitionProvenance === "curated" &&
    CORE_INTEGRATION_DEFINITIONS.some((definition) => definition.id === context.definitionId)
  ) {
    return context.definitionId;
  }
  return null;
}

function facetHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof IntegrationChangeRequiresAdminError)
    throw new MissingPermissionRefusal("capabilities:manage", { message: error.message });
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
