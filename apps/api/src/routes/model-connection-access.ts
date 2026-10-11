import { claudeProviderId, withClaudeConnectionCatalog } from "@opengeni/config";
import {
  configuredModels,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  withOrganizationGatewayCatalogProvider,
  withOrganizationOpenRouterCatalogProvider,
  withOrganizationOpperCatalogProvider,
} from "@opengeni/config";
import { ModelConnectionAccessPolicy, ModelConnectionAccessResponse } from "@opengeni/contracts";
import {
  requireAccessGrant,
  resolveWorkspaceCatalogSettings,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  deliverSubscriptionCoreWake,
  getModelConnectionAccess,
  listOrganizationAdministrationMembers,
  nestedPostgresSqlState,
  readSubscriptionCoreProviderModelConnectionAccess,
  ModelConnectionAccessForbiddenError,
  SubscriptionCoreAccessInvalidError,
  SubscriptionCoreAccessPeopleUnlistableError,
  SubscriptionCoreAccessPersonNotInOrganizationError,
  ModelConnectionWorkspaceNotInOrganizationError,
  updateModelConnectionAccess,
  updateSubscriptionCoreProviderModelConnectionAccess,
  getOrganizationAdministrationOverview,
  getXaiSubscriptionAccountAuthoritySnapshot,
  getClaudeSubscriptionAccountAuthoritySnapshot,
  listOrganizationModelProviderCustomModels,
  getWorkspaceProviderApiKeyConnectionMetadata,
  type ModelConnectionTarget,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  managedHumanOrAgent,
  requireOrganizationCodexHuman,
  requireSameOriginBrowserMutation,
} from "./codex";
import { codexRouteDisposition } from "./codex-core";
import { requireScopeMutation } from "./supergrok";
import { subscriptionCoreRoute } from "./subscription-pool-core";
import {
  requirePrivateSubscriptionHuman,
  requireSubscriptionScopeMutation,
} from "./subscription-pool-access";

const Kind = z.enum([
  "codex",
  "supergrok",
  "vercel_gateway",
  "openrouter",
  "anthropic",
  "claude_subscription",
  "opper",
]);
function modelPrefix(target: ModelConnectionTarget) {
  if (target.kind === "anthropic" || target.kind === "claude_subscription")
    return (
      claudeProviderId(target.kind, target.workspaceId === null ? "organization" : "workspace") +
      "/"
    );
  if (target.kind === "codex" || target.kind === "supergrok") return `${target.kind}/`;
  return `${target.workspaceId === null ? "organization" : "workspace"}-${target.kind === "vercel_gateway" ? "gateway" : target.kind === "opper" ? "opper" : "openrouter"}/`;
}

/**
 * Codex access policies follow the organization's Codex cutover row (M3 PR
 * 3): the legacy credential row without one; the shared core connection with
 * an enabled one (the legacy rows are frozen after 0680); a disabled row is
 * maintenance (typed 503 from `codexRouteDisposition`). SuperGrok's follow
 * its provider route (design 5.3, X2b): legacy without the `xai` cutover
 * receipt, the shared core connection with it, maintenance fails closed.
 */
async function coreAccessDisposition(
  deps: ApiRouteDeps,
  kind: ModelConnectionTarget["kind"],
  accountId: string,
): Promise<"legacy" | "core"> {
  if (kind === "codex") return await codexRouteDisposition(deps, accountId);
  if (kind === "supergrok")
    return await subscriptionCoreRoute(deps, "xai", "SuperGrok", async () => accountId);
  return "legacy";
}

/** The core wake reason of an access change, by connection kind. */
const CORE_ACCESS_WAKE: Partial<Record<ModelConnectionTarget["kind"], [string, string, string]>> = {
  codex: ["codex", "core_codex_access_changed", "Codex"],
  supergrok: ["xai", "core_xai_access_changed", "SuperGrok"],
};

export function registerModelConnectionAccessRoutes(app: Hono, deps: ApiRouteDeps) {
  for (const scope of ["organizations", "workspaces"] as const) {
    const path = `/v1/${scope}/:scopeId/model-connections/:kind/:connectionId/access`;
    async function target(
      c: Context,
      mutate: boolean,
    ): Promise<{ connection: ModelConnectionTarget; core: boolean }> {
      const kind = Kind.parse(c.req.param("kind"));
      if (kind === "claude_subscription" && !deps.settings.claudeSubscriptionEnabled)
        throw new HTTPException(404, { message: "Claude subscriptions are not enabled" });
      const scopeId = z.string().uuid().parse(c.req.param("scopeId"));
      let connectionId = c.req.param("connectionId")!;
      if (kind === "codex" || kind === "supergrok" || kind === "claude_subscription")
        connectionId = z.string().uuid().parse(connectionId);
      if (scope === "organizations") {
        if (mutate) requireSameOriginBrowserMutation(c, deps);
        const human = await requireOrganizationCodexHuman(c, deps, scopeId);
        return {
          connection: {
            kind,
            connectionId,
            accountId: scopeId,
            workspaceId: null,
            subjectId: human.subjectId,
          },
          core: (await coreAccessDisposition(deps, kind, scopeId)) === "core",
        };
      }
      const grant = await requireAccessGrant(c, deps, scopeId, "workspace:read");
      // On the core a SuperGrok access policy is a shared connection's, which
      // the core editor authorizes; only the legacy pools have private rows.
      const supergrokCore =
        kind === "supergrok" &&
        (await coreAccessDisposition(deps, kind, grant.accountId)) === "core";
      if (kind === "supergrok" && !supergrokCore) {
        const snapshot = await getXaiSubscriptionAccountAuthoritySnapshot(deps.db, {
          workspaceId: scopeId,
          subjectId: grant.subjectId,
          credentialId: connectionId,
        });
        if (!snapshot) throw new HTTPException(404, { message: "Subscription not found" });
        if (snapshot.scope === "user") {
          const human = await managedHumanOrAgent(c, deps);
          if (!human || human.subjectId !== grant.subjectId)
            throw new HTTPException(403, {
              message: "Subscription owner browser session required",
            });
        }
        if (mutate) await requireScopeMutation(c, deps, scopeId, snapshot.scope);
      } else if (kind === "claude_subscription") {
        const snapshot = await getClaudeSubscriptionAccountAuthoritySnapshot(deps.db, {
          workspaceId: scopeId,
          subjectId: grant.subjectId,
          credentialId: connectionId,
        });
        if (!snapshot) throw new HTTPException(404, { message: "Subscription not found" });
        if (snapshot.scope === "user") {
          const human = await requirePrivateSubscriptionHuman(c, deps, scopeId, "Claude");
          if (human.subjectId !== grant.subjectId)
            throw new HTTPException(403, { message: "Subscription owner required" });
        }
        if (mutate) {
          if (!c.req.header("authorization")) requireSameOriginBrowserMutation(c, deps);
          await requireSubscriptionScopeMutation(c, deps, scopeId, snapshot.scope, "Claude");
        }
      } else if (mutate) await requireAccessGrant(c, deps, scopeId, "workspace:admin");
      if (
        kind === "vercel_gateway" ||
        kind === "openrouter" ||
        kind === "anthropic" ||
        kind === "opper"
      ) {
        const metadata = await getWorkspaceProviderApiKeyConnectionMetadata(deps.db, scopeId, kind);
        if (!metadata || (connectionId !== "current" && metadata.connectionId !== connectionId))
          throw new HTTPException(404, { message: "Connection not found" });
        connectionId = metadata.connectionId;
      }
      return {
        connection: {
          kind,
          connectionId,
          accountId: grant.accountId,
          workspaceId: scopeId,
          subjectId: grant.subjectId,
        },
        core:
          kind === "supergrok"
            ? supergrokCore
            : (await coreAccessDisposition(deps, kind, grant.accountId)) === "core",
      };
    }
    app.get(path, async (c) => {
      c.header("cache-control", "private, no-store");
      const { connection, core } = await target(c, false);
      const coreAccess = core
        ? await readSubscriptionCoreProviderModelConnectionAccess(deps.db, connection)
        : null;
      const policy = core
        ? coreAccess && {
            ...coreAccess.policy,
            allowedPeople: coreAccess.policy.allowedPeople ?? undefined,
          }
        : await getModelConnectionAccess(deps.db, connection);
      if (!policy) throw new HTTPException(404, { message: "Connection not found" });
      // Shared core connections at organization scope can be limited to people
      // and report the workspaces that use them as their own (design 5.4).
      const organizationCore = coreAccess !== null && connection.workspaceId === null;
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
        if (connection.kind === "anthropic" || connection.kind === "claude_subscription") {
          const customModels = await listOrganizationModelProviderCustomModels(deps.db, {
            organizationId: connection.accountId,
            actorSubjectId: connection.subjectId,
            providerKind: connection.kind,
          });
          settings = withClaudeConnectionCatalog(settings, {
            [connection.kind]: { models: customModels },
          });
        }
        if (
          connection.kind === "vercel_gateway" ||
          connection.kind === "openrouter" ||
          connection.kind === "opper"
        ) {
          const models = await listOrganizationModelProviderCustomModels(deps.db, {
            ...actor,
            providerKind: connection.kind,
          });
          settings =
            connection.kind === "vercel_gateway"
              ? withOrganizationGatewayCatalogProvider(settings, models)
              : connection.kind === "opper"
                ? withOrganizationOpperCatalogProvider(settings, models)
                : withOrganizationOpenRouterCatalogProvider(settings, models);
        }
      }
      // The people an administrator can choose, or null when the account
      // can't be limited to people or the organization has more members than
      // its member list shows (people are then not offered).
      const people =
        organizationCore && coreAccess?.peopleSupported
          ? await listOrganizationAdministrationMembers(deps.db, {
              organizationId: connection.accountId,
              actorSubjectId: connection.subjectId,
            }).then(
              (members) =>
                members
                  .filter(
                    (member) =>
                      member.status === "active" &&
                      member.revokedAt === null &&
                      member.subjectId.startsWith("user:"),
                  )
                  .map(({ id, name, email }) => ({ id, name, email })),
              (error: unknown) => {
                // The member list refuses organizations above its bound
                // (SQLSTATE 54000); people are then not offered.
                if (nestedPostgresSqlState(error) === "54000") return null;
                throw error;
              },
            )
          : null;
      return c.json(
        ModelConnectionAccessResponse.parse({
          policy,
          workspaces,
          models: configuredModels(settings)
            .filter((model) => model.id.startsWith(modelPrefix(connection)))
            .map(({ id, label }) => ({ id, label })),
          personalWorkspacesSupported:
            connection.workspaceId === null &&
            (connection.kind === "codex" ||
              connection.kind === "supergrok" ||
              connection.kind === "claude_subscription"),
          ...(organizationCore
            ? {
                ...(people ? { peopleSupported: true, people } : { peopleSupported: false }),
                localWorkspaceIds: coreAccess.localWorkspaceIds,
                managedByWorkspaceId: coreAccess.managedByWorkspaceId,
              }
            : {}),
        }),
      );
    });
    app.put(path, async (c) => {
      // Access of a provider on the shared core lives there; the frozen legacy row is never written.
      const { connection, core } = await target(c, true);
      const parsed = ModelConnectionAccessPolicy.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        throw new HTTPException(422, { message: "Invalid connection access policy" });
      const policy = parsed.data;
      if (policy.allowedModels?.some((id) => !id.startsWith(modelPrefix(connection))))
        throw new HTTPException(422, {
          message: "Model belongs to a different connection provider",
        });
      if (
        connection.workspaceId !== null &&
        (policy.allowedWorkspaces !== null || policy.allowedPeople != null)
      )
        throw new HTTPException(422, {
          message: "Workspace connections cannot be assigned to other workspaces",
        });
      if (!core && policy.allowedPeople != null)
        throw new HTTPException(422, { message: "This account cannot be limited to people" });
      let updated;
      try {
        updated = core
          ? await updateSubscriptionCoreProviderModelConnectionAccess(deps.db, connection, policy)
          : await updateModelConnectionAccess(deps.db, connection, policy);
      } catch (error) {
        if (error instanceof ModelConnectionWorkspaceNotInOrganizationError)
          throw new HTTPException(422, { message: error.message });
        if (
          error instanceof SubscriptionCoreAccessPersonNotInOrganizationError ||
          error instanceof SubscriptionCoreAccessPeopleUnlistableError ||
          error instanceof SubscriptionCoreAccessInvalidError
        )
          throw new HTTPException(422, { message: error.message });
        if (error instanceof ModelConnectionAccessForbiddenError)
          throw new HTTPException(403, { message: error.message });
        throw error;
      }
      if (!updated)
        throw new HTTPException(409, {
          message: "Connection access changed. Reload before saving.",
        });
      const wake = core ? CORE_ACCESS_WAKE[connection.kind] : undefined;
      if (wake) {
        // A wider scope or model list can make waiting work placeable.
        try {
          await deliverSubscriptionCoreWake(
            deps.db,
            wake[0],
            { accountId: connection.accountId, reason: wake[1] },
            wake[2],
          );
        } catch {
          // Every core waiter has its own bounded recheck; a lost wake only delays.
        }
      }
      return c.json(updated);
    });
  }
}
