import {
  configuredModels,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  withOrganizationGatewayCatalogProvider,
  withOrganizationOpenRouterCatalogProvider,
} from "@opengeni/config";
import { ModelConnectionAccessPolicy, ModelConnectionAccessResponse } from "@opengeni/contracts";
import {
  requireAccessGrant,
  resolveWorkspaceCatalogSettings,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getModelConnectionAccess,
  updateModelConnectionAccess,
  getOrganizationAdministrationOverview,
  getXaiSubscriptionAccountAuthoritySnapshot,
  listOrganizationModelProviderCustomModels,
  getWorkspaceVercelAiGatewayConnectionMetadata,
  getWorkspaceOpenRouterConnectionMetadata,
  type ModelConnectionTarget,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireOrganizationCodexHuman, requireSameOriginBrowserMutation } from "./codex";
import { managedCookieHuman, requireScopeMutation } from "./supergrok";

const Kind = z.enum(["codex", "supergrok", "vercel_gateway", "openrouter"]);
function modelPrefix(target: ModelConnectionTarget) {
  if (target.kind === "codex" || target.kind === "supergrok") return `${target.kind}/`;
  return `${target.workspaceId === null ? "organization" : "workspace"}-${target.kind === "vercel_gateway" ? "gateway" : "openrouter"}/`;
}

export function registerModelConnectionAccessRoutes(app: Hono, deps: ApiRouteDeps) {
  for (const scope of ["organizations", "workspaces"] as const) {
    const path = `/v1/${scope}/:scopeId/model-connections/:kind/:connectionId/access`;
    async function target(c: Context, mutate: boolean): Promise<ModelConnectionTarget> {
      const kind = Kind.parse(c.req.param("kind"));
      const scopeId = z.string().uuid().parse(c.req.param("scopeId"));
      let connectionId = c.req.param("connectionId")!;
      if (kind === "codex" || kind === "supergrok")
        connectionId = z.string().uuid().parse(connectionId);
      if (scope === "organizations") {
        if (mutate) requireSameOriginBrowserMutation(c, deps);
        const human = await requireOrganizationCodexHuman(c, deps, scopeId);
        return {
          kind,
          connectionId,
          accountId: scopeId,
          workspaceId: null,
          subjectId: human.subjectId,
        };
      }
      const grant = await requireAccessGrant(c, deps, scopeId, "workspace:read");
      if (kind === "supergrok") {
        const snapshot = await getXaiSubscriptionAccountAuthoritySnapshot(deps.db, {
          workspaceId: scopeId,
          subjectId: grant.subjectId,
          credentialId: connectionId,
        });
        if (!snapshot) throw new HTTPException(404, { message: "Subscription not found" });
        if (snapshot.scope === "user") {
          const human = await managedCookieHuman(c, deps);
          if (!human || human.subjectId !== grant.subjectId)
            throw new HTTPException(403, {
              message: "Subscription owner browser session required",
            });
        }
        if (mutate) await requireScopeMutation(c, deps, scopeId, snapshot.scope);
      } else if (mutate) await requireAccessGrant(c, deps, scopeId, "workspace:admin");
      if (kind === "vercel_gateway" || kind === "openrouter") {
        const metadata = await (
          kind === "vercel_gateway"
            ? getWorkspaceVercelAiGatewayConnectionMetadata
            : getWorkspaceOpenRouterConnectionMetadata
        )(deps.db, scopeId);
        if (!metadata || (connectionId !== "current" && metadata.connectionId !== connectionId))
          throw new HTTPException(404, { message: "Connection not found" });
        connectionId = metadata.connectionId;
      }
      return {
        kind,
        connectionId,
        accountId: grant.accountId,
        workspaceId: scopeId,
        subjectId: grant.subjectId,
      };
    }
    app.get(path, async (c) => {
      c.header("cache-control", "private, no-store");
      const connection = await target(c, false);
      const policy = await getModelConnectionAccess(deps.db, connection);
      if (!policy) throw new HTTPException(404, { message: "Connection not found" });
      let settings =
        connection.workspaceId === null
          ? (await deps.resolveCatalogSettings()).settings
          : (
              await resolveWorkspaceCatalogSettings(deps.db, deps.settings, {
                accountId: connection.accountId,
                workspaceId: connection.workspaceId,
              })
            ).settings;
      settings = withCodexCatalogProvider(withXaiSubscriptionCatalogProvider(settings));
      let workspaces: Array<{ id: string; name: string }> = [];
      if (connection.workspaceId === null) {
        const actor = {
          organizationId: connection.accountId,
          actorSubjectId: connection.subjectId,
        };
        workspaces = (await getOrganizationAdministrationOverview(deps.db, actor)).workspaces.map(
          ({ id, name }) => ({ id, name }),
        );
        if (connection.kind === "vercel_gateway" || connection.kind === "openrouter") {
          const models = await listOrganizationModelProviderCustomModels(deps.db, {
            ...actor,
            providerKind: connection.kind,
          });
          settings =
            connection.kind === "vercel_gateway"
              ? withOrganizationGatewayCatalogProvider(settings, models)
              : withOrganizationOpenRouterCatalogProvider(settings, models);
        }
      }
      return c.json(
        ModelConnectionAccessResponse.parse({
          policy,
          workspaces,
          models: configuredModels(settings)
            .filter((model) => model.id.startsWith(modelPrefix(connection)))
            .map(({ id, label }) => ({ id, label })),
          personalWorkspacesSupported:
            connection.workspaceId === null &&
            (connection.kind === "codex" || connection.kind === "supergrok"),
        }),
      );
    });
    app.put(path, async (c) => {
      const connection = await target(c, true);
      const parsed = ModelConnectionAccessPolicy.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        throw new HTTPException(422, { message: "Invalid connection access policy" });
      const policy = parsed.data;
      if (policy.allowedModels?.some((id) => !id.startsWith(modelPrefix(connection))))
        throw new HTTPException(422, {
          message: "Model belongs to a different connection provider",
        });
      if (connection.workspaceId !== null && policy.allowedWorkspaces !== null)
        throw new HTTPException(422, {
          message: "Workspace connections cannot be assigned to other workspaces",
        });
      const updated = await updateModelConnectionAccess(deps.db, connection, policy);
      if (!updated)
        throw new HTTPException(409, {
          message: "Connection access changed. Reload before saving.",
        });
      return c.json(updated);
    });
  }
}
