/**
 * Vault REST routes (dossier §10B.1.10), all under `/v1/workspaces/:workspaceId`.
 * Each route checks the permission its operation needs; the 0738 routines
 * decide reach (which vaults this person sees) and integrity. Vault errors
 * answer `{ error, message, details? }` with the status from
 * `VAULT_ERROR_HTTP_STATUS`.
 */
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  CreateVaultItemRequest,
  CreateVaultRequest,
  DeleteVaultRequest,
  ListVaultItemsQuery,
  MoveVaultItemRequest,
  RestoreVaultFieldVersionRequest,
  RevealVaultFieldRequest,
  SetSessionVaultPolicyRequest,
  UpdateVaultItemRequest,
  UpdateVaultRequest,
  VAULT_ERROR_HTTP_STATUS,
  type AccessGrant,
  type VaultApiError,
} from "@opengeni/contracts";
import {
  createVaultService,
  isVaultError,
  requireAccessGrantAuthorization,
  requireLiteralPermission,
  requirePermission,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  VaultError,
  vaultErrorFromDatabase,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  type VaultRequestActor,
  type VaultService,
} from "@opengeni/core";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";
import { vaultProviderRegistryFor } from "./vault-providers";

const PREFIX = "/v1/workspaces/:workspaceId";

function actorFor(authorization: AccessGrantAuthorization): VaultRequestActor {
  return {
    grant: authorization.grant,
    accountAdmin: authorization.accountGrant?.permissions.includes("account:admin") === true,
  };
}

function isApiKeyGrant(grant: AccessGrant): boolean {
  return grant.principalKind === "api_key" || grant.principalKind === "configured_key";
}

/**
 * Plaintext reveal (AX-5): API keys need the literal `secrets:read`; people
 * need `secrets:use` and a human session (agents and services are refused).
 */
function requireRevealAuthority(grant: AccessGrant): void {
  if (isApiKeyGrant(grant)) {
    requireLiteralPermission(grant, "secrets:read");
    return;
  }
  if (grant.principalKind !== "human_session" || grant.serviceInitiator) {
    throw new VaultError(
      "vault_reveal_requires_human",
      "revealing a value needs a person signed in, or an API key with secrets:read",
    );
  }
  requirePermission(grant, "secrets:use");
}

function vaultErrorResponse(c: Context, error: VaultError): Response {
  const body: VaultApiError = {
    error: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
  return c.json(body, VAULT_ERROR_HTTP_STATUS[error.code] as ContentfulStatusCode);
}

/** Run a handler, answering vault errors with their contract status. */
async function vaultRoute(c: Context, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const vaultError = isVaultError(error) ? error : vaultErrorFromDatabase(error);
    if (vaultError) return vaultErrorResponse(c, vaultError);
    throw error;
  }
}

async function authorizeSession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  operation: "session.read" | "session.tool_policy.write",
): Promise<void> {
  try {
    await requireSessionAuthorization(deps, grant, { sessionId, operation, surface: "http" });
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) {
      throw new ApiHttpError(404, { code: "not_found", message: "Session not found." });
    }
    if (error instanceof SessionAuthorizationUnavailableError) {
      throw new ApiHttpError(503, {
        code: "upstream_unavailable",
        message: "Session authorization is temporarily unavailable.",
        retryable: true,
      });
    }
    throw error;
  }
}

export function registerVaultRoutes(app: Hono, deps: ApiRouteDeps): void {
  let service: VaultService | null = null;
  const vaults = (): VaultService =>
    (service ??= createVaultService({
      db: deps.db,
      encryptionKey: environmentsEncryptionKeyBytes(deps.settings) ?? null,
    }));
  /** Connected-vault values are read live through the request's providers (W5). */
  const vaultsWithProviders = (actor: VaultRequestActor, workspaceId: string): VaultService =>
    createVaultService({
      db: deps.db,
      encryptionKey: environmentsEncryptionKeyBytes(deps.settings) ?? null,
      providers: vaultProviderRegistryFor(deps, { workspaceId, subjectId: actor.grant.subjectId }),
    });

  async function authorize(c: Context, permission: "secrets:list" | "secrets:write") {
    const workspaceId = c.req.param("workspaceId")!;
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    requirePermission(authorization.grant, permission);
    return { workspaceId, actor: actorFor(authorization) };
  }

  /** The item must live in the vault the path names. */
  async function itemInVault(
    actor: VaultRequestActor,
    workspaceId: string,
    vaultId: string,
    itemId: string,
  ) {
    const item = await vaults().getItem(actor, workspaceId, itemId);
    if (item.vaultId !== vaultId) {
      throw new VaultError("vault_item_not_found", "item not found", { itemId });
    }
    return item;
  }

  // Vaults ------------------------------------------------------------------

  app.get(`${PREFIX}/vaults`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:list");
      return c.json({ vaults: await vaults().list(actor, workspaceId) });
    }),
  );

  app.post(`${PREFIX}/vaults`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const payload = await parseRequestJson(c, CreateVaultRequest);
      if (payload.ownerKind === "organization" && !actor.accountAdmin) {
        throw new ApiHttpError(403, {
          code: "forbidden",
          message: "missing permission: account:admin",
        });
      }
      return c.json(await vaults().create(actor, workspaceId, payload), 201);
    }),
  );

  app.get(`${PREFIX}/vaults/:vaultId`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:list");
      return c.json(await vaults().get(actor, workspaceId, c.req.param("vaultId")!));
    }),
  );

  app.patch(`${PREFIX}/vaults/:vaultId`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const payload = await parseRequestJson(c, UpdateVaultRequest);
      return c.json(await vaults().update(actor, workspaceId, c.req.param("vaultId")!, payload));
    }),
  );

  app.delete(`${PREFIX}/vaults/:vaultId`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const payload = await parseRequestJson(c, DeleteVaultRequest);
      await vaults().remove(actor, workspaceId, c.req.param("vaultId")!, payload.confirmName);
      return c.body(null, 204);
    }),
  );

  // Items -------------------------------------------------------------------

  app.get(`${PREFIX}/vaults/:vaultId/items`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:list");
      const parsed = ListVaultItemsQuery.safeParse(c.req.query());
      if (!parsed.success) {
        throw new ApiHttpError(422, {
          code: "validation_failed",
          message: "Invalid vault item query.",
          retryable: false,
        });
      }
      return c.json(
        await vaults().listItems(actor, workspaceId, c.req.param("vaultId")!, parsed.data),
      );
    }),
  );

  app.post(`${PREFIX}/vaults/:vaultId/items`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const payload = await parseRequestJson(c, CreateVaultItemRequest);
      return c.json(
        await vaultsWithProviders(actor, workspaceId).createItem(
          actor,
          workspaceId,
          c.req.param("vaultId")!,
          payload,
        ),
        201,
      );
    }),
  );

  app.get(`${PREFIX}/vaults/:vaultId/items/:itemId`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:list");
      return c.json(
        await itemInVault(actor, workspaceId, c.req.param("vaultId")!, c.req.param("itemId")!),
      );
    }),
  );

  app.patch(`${PREFIX}/vaults/:vaultId/items/:itemId`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const payload = await parseRequestJson(c, UpdateVaultItemRequest);
      const itemId = c.req.param("itemId")!;
      await itemInVault(actor, workspaceId, c.req.param("vaultId")!, itemId);
      return c.json(
        await vaultsWithProviders(actor, workspaceId).updateItem(
          actor,
          workspaceId,
          itemId,
          payload,
        ),
      );
    }),
  );

  app.delete(`${PREFIX}/vaults/:vaultId/items/:itemId`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const itemId = c.req.param("itemId")!;
      await itemInVault(actor, workspaceId, c.req.param("vaultId")!, itemId);
      if (c.req.query("permanent") === "true") {
        await vaults().deleteItemPermanently(actor, workspaceId, itemId);
      } else {
        await vaultsWithProviders(actor, workspaceId).archiveItem(actor, workspaceId, itemId);
      }
      return c.body(null, 204);
    }),
  );

  app.post(`${PREFIX}/vaults/:vaultId/items/:itemId/restore`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const itemId = c.req.param("itemId")!;
      await itemInVault(actor, workspaceId, c.req.param("vaultId")!, itemId);
      return c.json(await vaults().restoreItem(actor, workspaceId, itemId));
    }),
  );

  app.post(`${PREFIX}/vaults/:vaultId/items/:itemId/move`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const payload = await parseRequestJson(c, MoveVaultItemRequest);
      const itemId = c.req.param("itemId")!;
      await itemInVault(actor, workspaceId, c.req.param("vaultId")!, itemId);
      return c.json(await vaults().moveItem(actor, workspaceId, itemId, payload));
    }),
  );

  // Fields ------------------------------------------------------------------

  app.post(`${PREFIX}/vaults/:vaultId/items/:itemId/fields/:fieldId/reveal`, (c) =>
    vaultRoute(c, async () => {
      const workspaceId = c.req.param("workspaceId")!;
      const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
      requirePermission(authorization.grant, "secrets:list");
      requireRevealAuthority(authorization.grant);
      const payload = await parseRequestJson(c, RevealVaultFieldRequest);
      const actor = actorFor(authorization);
      const itemId = c.req.param("itemId")!;
      await itemInVault(actor, workspaceId, c.req.param("vaultId")!, itemId);
      return c.json(
        await vaultsWithProviders(actor, workspaceId).revealField(
          actor,
          workspaceId,
          c.req.param("fieldId")!,
          {
            ...payload,
            itemId,
          },
        ),
      );
    }),
  );

  app.get(`${PREFIX}/vaults/:vaultId/items/:itemId/fields/:fieldId/versions`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:list");
      const item = await itemInVault(
        actor,
        workspaceId,
        c.req.param("vaultId")!,
        c.req.param("itemId")!,
      );
      const fieldId = c.req.param("fieldId")!;
      if (!item.fields.some((field) => field.id === fieldId)) {
        throw new VaultError("vault_field_not_found", "field not found", { fieldId });
      }
      return c.json({ versions: await vaults().listFieldVersions(actor, workspaceId, fieldId) });
    }),
  );

  app.post(`${PREFIX}/vaults/:vaultId/items/:itemId/fields/:fieldId/restore`, (c) =>
    vaultRoute(c, async () => {
      const { workspaceId, actor } = await authorize(c, "secrets:write");
      const payload = await parseRequestJson(c, RestoreVaultFieldVersionRequest);
      const itemId = c.req.param("itemId")!;
      await itemInVault(actor, workspaceId, c.req.param("vaultId")!, itemId);
      return c.json(
        await vaults().restoreFieldVersion(
          actor,
          workspaceId,
          itemId,
          c.req.param("fieldId")!,
          payload.version,
        ),
      );
    }),
  );

  // Session policy ----------------------------------------------------------

  app.put(`${PREFIX}/sessions/:sessionId/vault-policy`, (c) =>
    vaultRoute(c, async () => {
      const workspaceId = c.req.param("workspaceId")!;
      const sessionId = c.req.param("sessionId")!;
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "sessions:control",
      );
      await authorizeSession(deps, authorization.grant, sessionId, "session.tool_policy.write");
      requirePermission(authorization.grant, "secrets:use");
      const payload = await parseRequestJson(c, SetSessionVaultPolicyRequest);
      return c.json(
        await vaults().setSessionPolicy(
          actorFor(authorization),
          workspaceId,
          sessionId,
          payload.policy,
        ),
      );
    }),
  );

  app.get(`${PREFIX}/sessions/:sessionId/secrets`, (c) =>
    vaultRoute(c, async () => {
      const workspaceId = c.req.param("workspaceId")!;
      const sessionId = c.req.param("sessionId")!;
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "sessions:read",
      );
      await authorizeSession(deps, authorization.grant, sessionId, "session.read");
      return c.json(await vaults().sessionSecrets(actorFor(authorization), workspaceId, sessionId));
    }),
  );
}
