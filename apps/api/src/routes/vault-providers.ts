import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  CreateManagedProviderVaultRequest,
  InstallOnePasswordRequest,
  InstallOnePasswordResponse,
  LinkProviderVaultRequest,
  ProviderVaultMeta,
  VAULT_ERROR_HTTP_STATUS,
  type VaultApiError,
  type VaultSummary,
} from "@opengeni/contracts";
import {
  ONEPASSWORD_CREDENTIAL_ROLE,
  ONEPASSWORD_PROVIDER_DOMAIN,
  createWorkspaceVaultProviderRegistry,
  externalActorContinuationForAuthorization,
  isVaultError,
  providerSecretName,
  requirePermission,
  syncLinkedProviderVault,
  toVaultSummary,
  vaultErrorFromDatabase,
  isOnePasswordConnection,
  loadOnePasswordConnectionToken,
  onePasswordCredentialBundle,
  requireAccessGrantAuthorization,
  requireEnvironmentEncryption,
  vaultErrorCodeForProvider,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  type OnePasswordConnectionMetadata,
  type OnePasswordVaultProviderFactory,
} from "@opengeni/core";
import {
  createConnection,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getVault,
  linkProviderVault,
  listVaultsForSubject,
  type VaultDbContext,
} from "@opengeni/db";
import {
  isVaultProviderError,
  VaultProviderError,
  type ProviderVault,
  type VaultProvider,
  type VaultProviderContext,
  type VaultProviderRegistry,
} from "@opengeni/vaults";
import { isPersonalConnectionOwnerPrincipal } from "../connection-ownership";
import { parseRequestJson } from "../http/request-body";
import { requireConnectOwnerAuthority } from "../integrations/connect-authority";
import {
  loadOnePasswordModule,
  loadOnePasswordVaultProvider,
} from "../integrations/onepassword-vault-provider";

/** Human-initiated provider calls (install, list, link, sync) are not attempt-budgeted. */
function routeProviderContext(connectionId: string | null): VaultProviderContext {
  return { connectionId, budget: { take() {} } };
}

function providerErrorResponse(c: Context, error: unknown, write = false) {
  if (!isVaultProviderError(error)) throw error;
  const code = vaultErrorCodeForProvider(error.code, write ? "write" : "vault");
  const status = VAULT_ERROR_HTTP_STATUS[code] ?? 503;
  if (error.retryAfterMs) c.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
  return c.json(
    {
      error: code,
      message: error.message,
      ...(error.retryAfterMs
        ? { details: { retryAt: new Date(Date.now() + error.retryAfterMs).toISOString() } }
        : {}),
    },
    status as 401,
  );
}

export function onePasswordFactoryFor(deps: ApiRouteDeps): OnePasswordVaultProviderFactory {
  if (deps.onePasswordVaultProvider === null) {
    return async () => {
      throw new HTTPException(404, { message: "1Password is not available in this deployment" });
    };
  }
  return deps.onePasswordVaultProvider ?? loadOnePasswordVaultProvider;
}

/**
 * The 1Password provider for a stored connection the caller can see, plus its
 * metadata. Throws 404 for other connections.
 */
export async function onePasswordProviderForConnection(
  deps: ApiRouteDeps,
  input: { workspaceId: string; connectionId: string; subjectId: string | null },
): Promise<{ provider: VaultProvider; metadata: OnePasswordConnectionMetadata }> {
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!connection || !isOnePasswordConnection(connection)) {
    throw new HTTPException(404, { message: "1Password connection not found" });
  }
  const { token, metadata } = await loadOnePasswordConnectionToken(deps.db, deps.settings, input);
  const provider = await onePasswordFactoryFor(deps)({
    token,
    planTier: metadata.planTier,
    allowFakeTokens: deps.settings.onePasswordFakeTokens,
  });
  return { provider, metadata };
}

/**
 * The provider registry for one request: 1Password vaults load their
 * connection token for the acting subject in this workspace; host vaults use
 * the embedder's `connectionCredentials.vaultProvider`.
 */
export function vaultProviderRegistryFor(
  deps: ApiRouteDeps,
  input: { workspaceId: string; subjectId: string | null },
): VaultProviderRegistry {
  return createWorkspaceVaultProviderRegistry({
    db: deps.db,
    settings: deps.settings,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    hostVaultProvider: deps.connectionCredentials?.vaultProvider ?? null,
    onePasswordVaultProvider:
      deps.onePasswordVaultProvider === null ? null : onePasswordFactoryFor(deps),
  });
}

function vaultContextFor(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): VaultDbContext {
  return {
    kind: "subject",
    accountId: authorization.grant.accountId,
    workspaceId,
    subjectId: authorization.grant.subjectId,
  };
}

function isAccountAdmin(authorization: AccessGrantAuthorization): boolean {
  return authorization.accountGrant?.permissions.includes("account:admin") === true;
}

async function vaultSummaryFor(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  vaultId: string,
): Promise<VaultSummary> {
  const row = await getVault(deps.db, vaultContextFor(authorization, workspaceId), { vaultId });
  return toVaultSummary(row, { write: true, accountAdmin: isAccountAdmin(authorization) });
}

/** Vault and provider errors as `{ error, message, details? }`; anything else rethrows. */
function vaultRouteError(c: Context, error: unknown, write = false) {
  if (isVaultProviderError(error)) return providerErrorResponse(c, error, write);
  const vaultError = isVaultError(error) ? error : vaultErrorFromDatabase(error);
  if (!vaultError) throw error;
  const body: VaultApiError = {
    error: vaultError.code,
    message: vaultError.message,
    ...(vaultError.details ? { details: vaultError.details } : {}),
  };
  return c.json(body, VAULT_ERROR_HTTP_STATUS[vaultError.code] as 401);
}

function findProviderVault(vaults: ProviderVault[], externalVaultId: string): ProviderVault {
  const found = vaults.find((vault) => vault.externalVaultId === externalVaultId);
  if (!found) {
    throw new VaultProviderError(
      "provider_not_found",
      "that vault does not exist or is not shared with this connection",
    );
  }
  return found;
}

export type LinkedVaultLookup = (input: {
  workspaceId: string;
  connectionId: string;
  context: VaultDbContext;
}) => Promise<ReadonlyMap<string, string>>;

export function registerVaultProviderRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: { linkedVaults?: LinkedVaultLookup } = {},
): void {
  const { db, settings } = deps;
  const linkedVaults: LinkedVaultLookup =
    options.linkedVaults ??
    (async ({ workspaceId, connectionId, context }) => {
      const rows = await listVaultsForSubject(db, context, { workspaceId });
      return new Map(
        rows
          .filter(
            (row) =>
              row.source === "onepassword" &&
              row.providerConnectionId === connectionId &&
              row.providerVaultRef,
          )
          .map((row) => [row.providerVaultRef!, row.id]),
      );
    });

  // Verified paste-a-token install (§10.9): an offline token check, then one
  // `vaults.list` call, then the token enters the encrypted connection store.
  // The response lists the reachable vaults; it never echoes the token.
  app.post("/v1/workspaces/:workspaceId/connections/1password/install", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    const grant = authorization.grant;
    const payload = await parseRequestJson(c, InstallOnePasswordRequest);
    if (
      payload.ownership === "organization" &&
      authorization.accountGrant?.permissions.includes("account:admin") !== true
    ) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    if (payload.ownership === "user" && !isPersonalConnectionOwnerPrincipal(authorization)) {
      throw new HTTPException(403, {
        message: "Only a signed-in person can connect a personal 1Password account",
      });
    }
    const key = requireEnvironmentEncryption(settings);
    const token = payload.token.trim();
    let accountName: string | null;
    let vaults;
    try {
      const onePassword = await loadOnePasswordModule();
      accountName = onePassword.describeOnePasswordToken(token, {
        allowFakeTokens: settings.onePasswordFakeTokens,
      }).accountName;
      const provider = await onePasswordFactoryFor(deps)({
        token,
        planTier: payload.planTier,
        allowFakeTokens: settings.onePasswordFakeTokens,
      });
      vaults = await provider.listVaults(routeProviderContext(null));
    } catch (error) {
      return providerErrorResponse(c, error);
    }
    const metadata: OnePasswordConnectionMetadata = {
      credentialRole: ONEPASSWORD_CREDENTIAL_ROLE,
      planTier: payload.planTier,
      ownership: payload.ownership,
      accountName,
      label: payload.label ?? null,
      verifiedAt: new Date().toISOString(),
    };
    const credentialEncrypted = encryptEnvironmentValue(
      key,
      JSON.stringify(onePasswordCredentialBundle(token)),
    );
    const continuation = externalActorContinuationForAuthorization(authorization);
    const connection = await db.transaction(async (tx) => {
      await requireConnectOwnerAuthority(tx, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
        ...(continuation ? { externalContinuation: continuation } : {}),
      });
      return await createConnection(tx, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: payload.ownership === "user" ? grant.subjectId : null,
        providerDomain: ONEPASSWORD_PROVIDER_DOMAIN,
        kind: "api_key",
        credentialEncrypted,
        grantedScopes: [],
        expiresAt: null,
        metadata,
        createdBySubjectId: grant.subjectId,
      });
    });
    return c.json(
      InstallOnePasswordResponse.parse({
        connectionId: connection.id,
        accountName,
        vaults: vaults.map((vault) => ({
          externalVaultId: vault.externalVaultId,
          name: vault.name,
          itemCount: vault.itemCount,
          linkedVaultId: null,
        })),
      }),
      201,
    );
  });

  // The vaults a stored 1Password connection reaches, with the OpenGeni vault
  // each one is linked to (if any). One `vaults.list` request.
  app.get("/v1/workspaces/:workspaceId/connections/:connectionId/provider-vaults", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const connectionId = c.req.param("connectionId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "secrets:list",
    );
    const { grant } = authorization;
    try {
      const { provider } = await onePasswordProviderForConnection(deps, {
        workspaceId,
        connectionId,
        subjectId: grant.subjectId,
      });
      const [vaults, linked] = await Promise.all([
        provider.listVaults(routeProviderContext(connectionId)),
        linkedVaults({
          workspaceId,
          connectionId,
          context: vaultContextFor(authorization, workspaceId),
        }),
      ]);
      return c.json({
        vaults: vaults.map((vault) =>
          ProviderVaultMeta.parse({
            externalVaultId: vault.externalVaultId,
            name: vault.name,
            itemCount: vault.itemCount,
            linkedVaultId: linked.get(vault.externalVaultId) ?? null,
          }),
        ),
      });
    } catch (error) {
      return vaultRouteError(c, error);
    }
  });

  /**
   * Link a provider vault as an OpenGeni vault, then mirror its metadata.
   * The link stands even if the first sync fails; its status says why.
   */
  app.post("/v1/workspaces/:workspaceId/vaults/link", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    requirePermission(authorization.grant, "secrets:write");
    const payload = await parseRequestJson(c, LinkProviderVaultRequest);
    if (payload.ownerKind === "organization" && !isAccountAdmin(authorization)) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    const context = vaultContextFor(authorization, workspaceId);
    try {
      let provider: VaultProvider;
      if (payload.provider === "onepassword") {
        if (!payload.connectionId) {
          throw new HTTPException(422, { message: "connectionId is required for 1Password" });
        }
        ({ provider } = await onePasswordProviderForConnection(deps, {
          workspaceId,
          connectionId: payload.connectionId,
          subjectId: authorization.grant.subjectId,
        }));
      } else {
        const host = deps.connectionCredentials?.vaultProvider;
        if (!host) {
          throw new VaultProviderError(
            "provider_unavailable",
            "this deployment has no host vault provider",
          );
        }
        provider = host;
      }
      const connectionId = payload.provider === "onepassword" ? payload.connectionId! : null;
      const providerVault = findProviderVault(
        await provider.listVaults(routeProviderContext(connectionId)),
        payload.externalVaultId,
      );
      const row = await linkProviderVault(db, context, {
        ownerKind: payload.ownerKind,
        name: payload.name ?? providerSecretName(providerVault.name, "1Password vault"),
        source: payload.provider,
        providerConnectionId: connectionId,
        providerVaultRef: providerVault.externalVaultId,
        mode: payload.mode,
        ...(payload.availability ? { availability: payload.availability } : {}),
        allowOrganization: isAccountAdmin(authorization),
      });
      await syncLinkedProviderVault({
        db,
        context,
        vaultId: row.id,
        providers: vaultProviderRegistryFor(deps, {
          workspaceId,
          subjectId: authorization.grant.subjectId,
        }),
        force: true,
      });
      return c.json(await vaultSummaryFor(deps, authorization, workspaceId, row.id), 201);
    } catch (error) {
      return vaultRouteError(c, error);
    }
  });

  /**
   * Refresh a linked vault's metadata mirror. Cheap when nothing changed (one
   * `vaults.list`); skipped while the provider's rate limit is in force.
   */
  app.post("/v1/workspaces/:workspaceId/vaults/:vaultId/sync", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const vaultId = c.req.param("vaultId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    requirePermission(authorization.grant, "secrets:write");
    try {
      const result = await syncLinkedProviderVault({
        db,
        context: vaultContextFor(authorization, workspaceId),
        vaultId,
        providers: vaultProviderRegistryFor(deps, {
          workspaceId,
          subjectId: authorization.grant.subjectId,
        }),
      });
      const rateLimitedUntil =
        result.status === "skipped_rate_limited" ||
        (result.status === "failed" && result.rateLimitedUntil)
          ? result.rateLimitedUntil
          : null;
      if (rateLimitedUntil) {
        c.header(
          "retry-after",
          String(Math.max(1, Math.ceil((rateLimitedUntil.getTime() - Date.now()) / 1000))),
        );
      }
      return c.json(await vaultSummaryFor(deps, authorization, workspaceId, vaultId));
    } catch (error) {
      return vaultRouteError(c, error);
    }
  });

  /**
   * Create a new vault in the connected 1Password account (admins keep
   * access; an optional group grant on TEAMS/BUSINESS) and link it read-write.
   */
  app.post("/v1/workspaces/:workspaceId/connections/:connectionId/managed-vaults", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const connectionId = c.req.param("connectionId");
    const authorization = await requireAccessGrantAuthorization(c, deps, workspaceId);
    requirePermission(authorization.grant, "secrets:write");
    const payload = await parseRequestJson(c, CreateManagedProviderVaultRequest);
    if (payload.ownerKind === "organization" && !isAccountAdmin(authorization)) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    const context = vaultContextFor(authorization, workspaceId);
    try {
      const { provider } = await onePasswordProviderForConnection(deps, {
        workspaceId,
        connectionId,
        subjectId: authorization.grant.subjectId,
      });
      if (!provider.createVault || !provider.capabilities().createVault) {
        throw new VaultProviderError(
          "provider_unavailable",
          "this 1Password connection cannot create vaults",
        );
      }
      const created = await provider.createVault(routeProviderContext(connectionId), {
        name: payload.name,
        description: "Managed by OpenGeni",
        allowAdminsAccess: true,
        ...(payload.groupId ? { groupId: payload.groupId } : {}),
      });
      const row = await linkProviderVault(db, context, {
        ownerKind: payload.ownerKind,
        name: payload.name,
        source: "onepassword",
        providerConnectionId: connectionId,
        providerVaultRef: created.externalVaultId,
        mode: "read_write",
        allowOrganization: isAccountAdmin(authorization),
      });
      await syncLinkedProviderVault({
        db,
        context,
        vaultId: row.id,
        providers: vaultProviderRegistryFor(deps, {
          workspaceId,
          subjectId: authorization.grant.subjectId,
        }),
        force: true,
      });
      return c.json(await vaultSummaryFor(deps, authorization, workspaceId, row.id), 201);
    } catch (error) {
      return vaultRouteError(c, error, true);
    }
  });
}
