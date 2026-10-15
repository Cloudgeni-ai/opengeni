import type { Context, Hono } from "hono";
import { isDeepStrictEqual } from "node:util";
import { HTTPException } from "hono/http-exception";
import { createNativeExternalVaultFactories } from "../integrations/external-vault-providers";
import {
  CreateManagedProviderVaultRequest,
  DisconnectOnePasswordResponse,
  InstallOnePasswordRequest,
  InstallOnePasswordResponse,
  LinkProviderVaultRequest,
  ListOnePasswordConnectionsResponse,
  OnePasswordConnectionSummary,
  ProviderVaultMeta,
  ReplaceOnePasswordTokenRequest,
  InstallVaultProviderRequest,
  InstallVaultProviderResponse,
  ListVaultProviderConnectionsResponse,
  ReplaceVaultProviderCredentialsRequest,
  DisconnectVaultProviderResponse,
  VAULT_ERROR_HTTP_STATUS,
  type VaultApiError,
  type VaultSummary,
  type ExternalVaultProviderKind,
  type VaultProviderCredentials,
  type VaultProviderConnectionSummary,
  type ConnectionMetadata,
} from "@opengeni/contracts";
import {
  ONEPASSWORD_CREDENTIAL_ROLE,
  ONEPASSWORD_PROVIDER_DOMAIN,
  createWorkspaceVaultProviderRegistry,
  createRemoteExternalVaultFactories,
  externalActorContinuationForAuthorization,
  hasPermission,
  isVaultError,
  providerSecretName,
  requirePermission,
  syncLinkedProviderVault,
  toVaultSummary,
  vaultErrorFromDatabase,
  isOnePasswordConnection,
  loadOnePasswordConnectionToken,
  onePasswordCredentialBundle,
  onePasswordConnectionMetadata,
  requireAccessGrantAuthorization,
  requireEnvironmentEncryption,
  vaultErrorCodeForProvider,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
  type OnePasswordConnectionMetadata,
  type OnePasswordVaultProviderFactory,
  externalVaultConnectionDetails,
  externalVaultConnectionMetadata,
  externalVaultProviderDomain,
  externalVaultProviderForConnection,
  isExternalVaultConnection,
  StoredVaultProviderCredentials,
  type ExternalVaultConnectionDetails,
  type ExternalVaultProviderFactories,
  loadExternalVaultConnection,
  pendingVaultCredentialBundle,
} from "@opengeni/core";
import {
  createConnection,
  deleteVault,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getVault,
  linkProviderVault,
  listConnectionsMetadata,
  listVaultsForSubject,
  revokeConnection,
  updateConnection,
  type VaultDbContext,
  type VaultRow,
} from "@opengeni/db";
import {
  isVaultProviderError,
  VaultProviderError,
  type ProviderVault,
  type VaultProvider,
  type VaultProviderContext,
  type VaultProviderRegistry,
  type VaultProviderAuthority,
  createProviderCallBudget,
  listProviderVaults,
  providerOperations,
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
  input: {
    workspaceId: string;
    subjectId: string | null;
    executionContext?: Pick<
      VaultProviderAuthority,
      "sessionId" | "turnId" | "attemptId" | "siteId"
    >;
  },
): VaultProviderRegistry {
  return createWorkspaceVaultProviderRegistry({
    db: deps.db,
    settings: deps.settings,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    hostVaultProvider: deps.connectionCredentials?.vaultProvider ?? null,
    onePasswordVaultProvider:
      deps.onePasswordVaultProvider === null ? null : onePasswordFactoryFor(deps),
    externalVaultProviders: externalVaultFactoriesFor(deps),
    ...(input.executionContext ? { executionContext: input.executionContext } : {}),
  });
}

const defaultExternalVaultFactories = new WeakMap<ApiRouteDeps, ExternalVaultProviderFactories>();

export function externalVaultFactoriesFor(deps: ApiRouteDeps): ExternalVaultProviderFactories {
  if (deps.externalVaultProviders !== undefined) return deps.externalVaultProviders ?? {};
  let factories = defaultExternalVaultFactories.get(deps);
  if (!factories) {
    factories = {
      ...createRemoteExternalVaultFactories(deps.settings),
      ...createNativeExternalVaultFactories(deps.settings),
    };
    defaultExternalVaultFactories.set(deps, factories);
  }
  return factories;
}

/** Both native 1Password and the generic connection lifecycle use this catalog. */
async function providerForConnection(
  deps: ApiRouteDeps,
  input: { workspaceId: string; connectionId: string; subjectId: string | null },
): Promise<{ provider: VaultProvider; source: "onepassword" | ExternalVaultProviderKind }> {
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (connection && isOnePasswordConnection(connection)) {
    return { ...(await onePasswordProviderForConnection(deps, input)), source: "onepassword" };
  }
  if (!connection || !isExternalVaultConnection(connection) || connection.status === "revoked") {
    throw new HTTPException(404, { message: "Vault connection not found" });
  }
  const details = externalVaultConnectionDetails(connection.metadata)!;
  const factory = externalVaultFactoriesFor(deps)[details.provider];
  if (!factory)
    throw new VaultProviderError(
      "provider_unavailable",
      "This vault provider is not available in this deployment.",
    );
  return {
    source: details.provider,
    provider: await externalVaultProviderForConnection({
      ...input,
      db: deps.db,
      settings: deps.settings,
      provider: details.provider,
      factory,
    }),
  };
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

type OnePasswordConnectionRow = NonNullable<Awaited<ReturnType<typeof getConnectionMetadata>>>;

/**
 * Whether the caller may link vaults through a 1Password connection, replace
 * its token or disconnect it: the same authority that could have installed it.
 */
function canManageOnePasswordConnection(
  authorization: AccessGrantAuthorization,
  connection: OnePasswordConnectionRow,
  metadata: OnePasswordConnectionMetadata,
): boolean {
  const { grant } = authorization;
  if (!hasPermission(grant.permissions, "connections:write", grant.permissionMode)) return false;
  if (!hasPermission(grant.permissions, "secrets:write", grant.permissionMode)) return false;
  if (connection.subjectId !== null) return connection.subjectId === grant.subjectId;
  if (metadata.ownership === "organization") return isAccountAdmin(authorization);
  return true;
}

function onePasswordConnectionSummary(
  authorization: AccessGrantAuthorization,
  connection: OnePasswordConnectionRow,
): OnePasswordConnectionSummary {
  const metadata = onePasswordConnectionMetadata(connection.metadata)!;
  return OnePasswordConnectionSummary.parse({
    id: connection.id,
    ownership: connection.subjectId !== null ? "user" : metadata.ownership,
    accountName: metadata.accountName,
    label: metadata.label,
    planTier: metadata.planTier,
    verifiedAt: metadata.verifiedAt || connection.createdAt,
    createdAt: connection.createdAt,
    createdBySubjectId: connection.createdBySubjectId,
    canManage: canManageOnePasswordConnection(authorization, connection, metadata),
  });
}

/** A live (not revoked) 1Password connection the caller can see, or 404. */
async function requireOnePasswordConnection(
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
  workspaceId: string,
  connectionId: string,
): Promise<{ connection: OnePasswordConnectionRow; metadata: OnePasswordConnectionMetadata }> {
  const connection = await getConnectionMetadata(
    deps.db,
    workspaceId,
    connectionId,
    authorization.grant.subjectId,
  );
  if (!connection || !isOnePasswordConnection(connection) || connection.status === "revoked") {
    throw new HTTPException(404, { message: "1Password connection not found" });
  }
  return { connection, metadata: onePasswordConnectionMetadata(connection.metadata)! };
}

function requireManageOnePasswordConnection(
  authorization: AccessGrantAuthorization,
  connection: OnePasswordConnectionRow,
  metadata: OnePasswordConnectionMetadata,
): void {
  if (!canManageOnePasswordConnection(authorization, connection, metadata)) {
    throw new HTTPException(403, {
      message:
        metadata.ownership === "organization"
          ? "Only an organization admin can change this 1Password connection"
          : "You can't change this 1Password connection",
    });
  }
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
              row.source !== "opengeni" &&
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
      vaults = await listProviderVaults(provider, routeProviderContext(null));
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

  // The vaults a stored 1Password connection reaches, with the Opengeni vault
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
      const { provider } = await providerForConnection(deps, {
        workspaceId,
        connectionId,
        subjectId: grant.subjectId,
      });
      const [vaults, linked] = await Promise.all([
        listProviderVaults(provider, routeProviderContext(connectionId)),
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
            writeAccess: vault.writeAccess ?? "unknown",
            operations: providerOperations(provider.capabilities(), vault),
          }),
        ),
      });
    } catch (error) {
      return vaultRouteError(c, error);
    }
  });

  /**
   * Link a provider vault as an Opengeni vault, then mirror its metadata.
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
      if (payload.provider !== "host") {
        if (!payload.connectionId) {
          throw new HTTPException(422, {
            message: "connectionId is required for a connected provider",
          });
        }
        const resolved = await providerForConnection(deps, {
          workspaceId,
          connectionId: payload.connectionId,
          subjectId: authorization.grant.subjectId,
        });
        if (resolved.source !== payload.provider)
          throw new HTTPException(422, { message: "Connection provider does not match" });
        provider = resolved.provider;
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
      const connectionId = payload.provider !== "host" ? payload.connectionId! : null;
      const providerVault = findProviderVault(
        await listProviderVaults(provider, routeProviderContext(connectionId)),
        payload.externalVaultId,
      );
      const row = await linkProviderVault(db, context, {
        ownerKind: payload.ownerKind,
        name: payload.name ?? providerSecretName(providerVault.name, "Connected vault"),
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
        force: true,
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
        description: "Managed by Opengeni",
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

  /** The 1Password connections the caller can see, without their tokens. */
  app.get("/v1/workspaces/:workspaceId/connections/1password/service-accounts", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "secrets:list",
    );
    const rows = await listConnectionsMetadata(db, workspaceId, authorization.grant.subjectId);
    return c.json(
      ListOnePasswordConnectionsResponse.parse({
        connections: rows
          .filter((row) => isOnePasswordConnection(row) && row.status !== "revoked")
          .map((row) => onePasswordConnectionSummary(authorization, row)),
      }),
    );
  });

  // A new token for an existing connection (rotation, or after it expired).
  // Checked like an install, then stored on the same connection, so every
  // vault linked through it keeps its links and syncs again.
  app.put("/v1/workspaces/:workspaceId/connections/:connectionId/1password/token", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const connectionId = c.req.param("connectionId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    const grant = authorization.grant;
    const { connection, metadata } = await requireOnePasswordConnection(
      deps,
      authorization,
      workspaceId,
      connectionId,
    );
    requireManageOnePasswordConnection(authorization, connection, metadata);
    if (connection.subjectId !== null && !isPersonalConnectionOwnerPrincipal(authorization)) {
      throw new HTTPException(403, {
        message: "Only a signed-in person can change a personal 1Password connection",
      });
    }
    const payload = await parseRequestJson(c, ReplaceOnePasswordTokenRequest);
    const key = requireEnvironmentEncryption(settings);
    const token = payload.token.trim();
    const planTier = payload.planTier ?? metadata.planTier;
    let accountName: string | null;
    let vaults;
    try {
      const onePassword = await loadOnePasswordModule();
      accountName = onePassword.describeOnePasswordToken(token, {
        allowFakeTokens: settings.onePasswordFakeTokens,
      }).accountName;
      if (metadata.accountName && accountName && accountName !== metadata.accountName) {
        return c.json(
          {
            error: "provider_conflict",
            message: `This token is for ${accountName}, not ${metadata.accountName}. Connect it as another 1Password account instead.`,
          },
          409,
        );
      }
      const provider = await onePasswordFactoryFor(deps)({
        token,
        planTier,
        allowFakeTokens: settings.onePasswordFakeTokens,
      });
      vaults = await listProviderVaults(provider, routeProviderContext(connectionId));
    } catch (error) {
      return providerErrorResponse(c, error);
    }
    const nextMetadata: OnePasswordConnectionMetadata = {
      ...metadata,
      planTier,
      accountName: accountName ?? metadata.accountName,
      verifiedAt: new Date().toISOString(),
    };
    const credentialEncrypted = encryptEnvironmentValue(
      key,
      JSON.stringify(onePasswordCredentialBundle(token)),
    );
    const continuation = externalActorContinuationForAuthorization(authorization);
    const updated = await db.transaction(async (tx) => {
      await requireConnectOwnerAuthority(tx, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
        ...(continuation ? { externalContinuation: continuation } : {}),
      });
      return await updateConnection(tx, {
        workspaceId,
        connectionId,
        visibleToSubjectId: grant.subjectId,
        expectedVersion: connection.version,
        status: "active",
        credentialEncrypted,
        metadata: { ...connection.metadata, ...nextMetadata },
        updatedBySubjectId: grant.subjectId,
      });
    });
    if (!updated) {
      throw new HTTPException(409, {
        message: "This 1Password connection changed while you were editing it. Try again.",
      });
    }
    // Linked vaults sync with the new token now; each records its own outcome.
    const context = vaultContextFor(authorization, workspaceId);
    const linked = await linkedVaultRows(context, workspaceId, connectionId);
    const providers = vaultProviderRegistryFor(deps, { workspaceId, subjectId: grant.subjectId });
    for (const row of linked) {
      await syncLinkedProviderVault({ db, context, vaultId: row.id, providers, force: true }).catch(
        () => undefined,
      );
    }
    const linkedByRef = new Map(linked.map((row) => [row.providerVaultRef, row.id]));
    return c.json(
      InstallOnePasswordResponse.parse({
        connectionId,
        accountName: nextMetadata.accountName,
        vaults: vaults.map((vault) => ({
          externalVaultId: vault.externalVaultId,
          name: vault.name,
          itemCount: vault.itemCount,
          linkedVaultId: linkedByRef.get(vault.externalVaultId) ?? null,
        })),
      }),
    );
  });

  // Disconnect: unlink every vault linked through the connection (nothing is
  // deleted in 1Password), then revoke the stored token. Vault removal runs
  // first, so a refusal leaves the connection intact and the request can be
  // retried.
  app.delete("/v1/workspaces/:workspaceId/connections/:connectionId/1password", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const connectionId = c.req.param("connectionId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    const grant = authorization.grant;
    const { connection, metadata } = await requireOnePasswordConnection(
      deps,
      authorization,
      workspaceId,
      connectionId,
    );
    requireManageOnePasswordConnection(authorization, connection, metadata);
    const context = vaultContextFor(authorization, workspaceId);
    const unlinkedVaultIds: string[] = [];
    try {
      for (const row of await linkedVaultRows(context, workspaceId, connectionId)) {
        await deleteVault(db, context, {
          vaultId: row.id,
          confirmName: row.name,
          allowOrganization: isAccountAdmin(authorization),
        });
        unlinkedVaultIds.push(row.id);
      }
    } catch (error) {
      return vaultRouteError(c, error);
    }
    const revoked = await revokeConnection(
      db,
      workspaceId,
      connectionId,
      grant.subjectId,
      connection.version,
    );
    if (!revoked) {
      throw new HTTPException(409, {
        message: "This 1Password connection changed while you were disconnecting it. Try again.",
      });
    }
    return c.json(DisconnectOnePasswordResponse.parse({ unlinkedVaultIds }));
  });

  /** Metadata-only unified catalog; listing never decrypts a provider token. */
  app.get("/v1/workspaces/:workspaceId/vault-providers/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "secrets:list",
    );
    const factories = externalVaultFactoriesFor(deps);
    const rows = await listConnectionsMetadata(db, workspaceId, authorization.grant.subjectId);
    const connections = rows
      .filter((row) => row.status !== "revoked")
      .flatMap<VaultProviderConnectionSummary>((row) => {
        if (isOnePasswordConnection(row)) {
          return [
            {
              ...onePasswordConnectionSummary(authorization, row),
              provider: "onepassword" as const,
              // The published legacy 1Password port has no granular override.
              operations: providerOperations({
                write: true,
                createVault: true,
                totp: true,
                files: false,
                groupGrants: true,
                passkeys: false,
              }),
              available: deps.onePasswordVaultProvider !== null,
            },
          ];
        }
        if (!isExternalVaultConnection(row)) return [];
        const details = externalVaultConnectionDetails(row.metadata)!;
        return [
          {
            id: row.id,
            provider: details.provider,
            ownership: details.ownership,
            accountName: details.accountName,
            label: details.label,
            verifiedAt: details.verifiedAt,
            createdAt: row.createdAt,
            createdBySubjectId: row.createdBySubjectId,
            canManage: canManageExternal(authorization, row, details),
            operations: details.operations,
            available: Boolean(factories[details.provider]),
            verificationStatus: details.verificationStatus ?? "ready",
          },
        ];
      });
    const providers = (
      ["onepassword", "external", "protonpass", "keeper", "bitwarden"] as const
    ).map((provider) => {
      const available =
        provider === "onepassword"
          ? deps.onePasswordVaultProvider !== null
          : Boolean(factories[provider]);
      return { provider, available, reason: available ? null : ("not_enabled" as const) };
    });
    return c.json(ListVaultProviderConnectionsResponse.parse({ connections, providers }));
  });

  app.post("/v1/workspaces/:workspaceId/vault-providers/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireSetupAuthority(c, workspaceId);
    const { grant } = authorization;
    const payload = await parseRequestJson(c, InstallVaultProviderRequest);
    requireOwnership(authorization, payload.ownership);
    const key = requireEnvironmentEncryption(settings);
    if (!externalVaultFactoriesFor(deps)[payload.credentials.provider]) {
      return vaultRouteError(
        c,
        new VaultProviderError(
          "provider_unavailable",
          "This vault provider is not available in this deployment.",
        ),
      );
    }
    const details: ExternalVaultConnectionDetails = {
      version: 1,
      provider: payload.credentials.provider,
      ownership: payload.ownership,
      accountId: null,
      accountName: null,
      label: payload.label ?? null,
      verifiedAt: new Date().toISOString(),
      verificationStatus: "pending",
      operations: providerOperations({
        write: false,
        createVault: false,
        totp: false,
        files: false,
        groupGrants: false,
        passkeys: false,
      }),
    };
    const continuation = externalActorContinuationForAuthorization(authorization);
    // Reserve identity before a remote call or one-time-token binding. No
    // usable credential (in particular no bootstrap token) is stored here.
    const connection = await db.transaction(async (tx) => {
      await requireConnectOwnerAuthority(tx, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
        ...(continuation ? { externalContinuation: continuation } : {}),
      });
      return createConnection(tx, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: payload.ownership === "user" ? grant.subjectId : null,
        providerDomain: externalVaultProviderDomain(details.provider),
        kind: "api_key",
        status: "needs_reauth",
        credentialEncrypted: encryptEnvironmentValue(key, "{}"),
        grantedScopes: [],
        expiresAt: null,
        metadata: externalVaultConnectionMetadata(details),
        createdBySubjectId: grant.subjectId,
      });
    });
    try {
      const result = await finishExternalSetup({
        authorization,
        workspaceId,
        connection,
        credentials: payload.credentials,
        currentCredentials: null,
        isNew: true,
      });
      return c.json(result.body, result.status);
    } catch (error) {
      return vaultRouteError(c, error);
    }
  });

  app.put(
    "/v1/workspaces/:workspaceId/vault-providers/connections/:connectionId/credentials",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const connectionId = c.req.param("connectionId");
      const authorization = await requireSetupAuthority(c, workspaceId);
      const { grant } = authorization;
      const connection = await getConnectionMetadata(
        db,
        workspaceId,
        connectionId,
        grant.subjectId,
      );
      if (
        !connection ||
        !isExternalVaultConnection(connection) ||
        connection.status === "revoked"
      ) {
        throw new HTTPException(404, { message: "Vault connection not found" });
      }
      const details = externalVaultConnectionDetails(connection.metadata)!;
      if (!canManageExternal(authorization, connection, details))
        throw new HTTPException(403, { message: "You cannot change this vault connection" });
      requireOwnership(authorization, details.ownership);
      const payload = await parseRequestJson(c, ReplaceVaultProviderCredentialsRequest);
      if (payload.credentials.provider !== details.provider)
        throw new HTTPException(422, { message: "Connection provider does not match" });
      try {
        const loaded = await loadExternalVaultConnection(db, settings, {
          workspaceId,
          connectionId,
          subjectId: grant.subjectId,
          provider: details.provider,
          allowPendingVerification: true,
        });
        const result = await finishExternalSetup({
          authorization,
          workspaceId,
          connection: loaded.connection,
          credentials: payload.credentials,
          currentCredentials: loaded.currentCredentials,
          pendingCredentials: loaded.pendingCredentials,
          isNew: false,
        });
        return c.json(result.body, result.status);
      } catch (error) {
        return vaultRouteError(c, error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/vault-providers/connections/:connectionId/verify",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const connectionId = c.req.param("connectionId");
      const authorization = await requireSetupAuthority(c, workspaceId);
      const connection = await getConnectionMetadata(
        db,
        workspaceId,
        connectionId,
        authorization.grant.subjectId,
      );
      if (!connection || !isExternalVaultConnection(connection) || connection.status === "revoked")
        throw new HTTPException(404, { message: "Vault connection not found" });
      const details = externalVaultConnectionDetails(connection.metadata)!;
      if (!canManageExternal(authorization, connection, details))
        throw new HTTPException(403, { message: "You cannot verify this vault connection" });
      requireOwnership(authorization, details.ownership);
      try {
        const loaded = await loadExternalVaultConnection(db, settings, {
          workspaceId,
          connectionId,
          subjectId: authorization.grant.subjectId,
          provider: details.provider,
          allowPendingVerification: true,
        });
        const result = await finishExternalSetup({
          authorization,
          workspaceId,
          connection: loaded.connection,
          credentials: loaded.credentials,
          currentCredentials: loaded.currentCredentials,
          pendingCredentials: loaded.pendingCredentials,
          isNew: false,
        });
        return c.json(result.body, result.status);
      } catch (error) {
        return vaultRouteError(c, error);
      }
    },
  );

  app.delete("/v1/workspaces/:workspaceId/vault-providers/connections/:connectionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const connectionId = c.req.param("connectionId");
    const authorization = await requireSetupAuthority(c, workspaceId);
    const { grant } = authorization;
    const connection = await getConnectionMetadata(db, workspaceId, connectionId, grant.subjectId);
    if (!connection || connection.status === "revoked")
      throw new HTTPException(404, { message: "Vault connection not found" });
    if (isOnePasswordConnection(connection)) {
      requireManageOnePasswordConnection(
        authorization,
        connection,
        onePasswordConnectionMetadata(connection.metadata)!,
      );
    } else {
      const details = externalVaultConnectionDetails(connection.metadata);
      if (!details || !isExternalVaultConnection(connection))
        throw new HTTPException(404, { message: "Vault connection not found" });
      if (!canManageExternal(authorization, connection, details))
        throw new HTTPException(403, { message: "You cannot disconnect this vault connection" });
    }
    try {
      // Local unlink and credential revocation commit together; no vendor mutation.
      const unlinkedVaultIds = await db.transaction(async (tx) => {
        const context = vaultContextFor(authorization, workspaceId);
        const rows = await listVaultsForSubject(tx, context, { workspaceId });
        const unlinked: string[] = [];
        for (const row of rows.filter(
          (candidate) => candidate.providerConnectionId === connectionId,
        )) {
          await deleteVault(tx, context, {
            vaultId: row.id,
            confirmName: row.name,
            allowOrganization: isAccountAdmin(authorization),
          });
          unlinked.push(row.id);
        }
        const revoked = await revokeConnection(
          tx,
          workspaceId,
          connectionId,
          grant.subjectId,
          connection.version,
        );
        if (!revoked)
          throw new HTTPException(409, {
            message: "This vault connection changed. Reload it before disconnecting.",
          });
        return unlinked;
      });
      return c.json(DisconnectVaultProviderResponse.parse({ unlinkedVaultIds }));
    } catch (error) {
      return vaultRouteError(c, error);
    }
  });

  async function requireSetupAuthority(
    c: Context,
    workspaceId: string,
  ): Promise<AccessGrantAuthorization> {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    requirePermission(authorization.grant, "secrets:write");
    return authorization;
  }

  function requireOwnership(
    authorization: AccessGrantAuthorization,
    ownership: "user" | "workspace" | "organization",
  ): void {
    if (ownership === "organization" && !isAccountAdmin(authorization))
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    if (ownership === "user" && !isPersonalConnectionOwnerPrincipal(authorization))
      throw new HTTPException(403, {
        message: "Only a signed-in person can manage a personal vault connection",
      });
  }

  function canManageExternal(
    authorization: AccessGrantAuthorization,
    connection: OnePasswordConnectionRow,
    details: ExternalVaultConnectionDetails,
  ): boolean {
    const grant = authorization.grant;
    return (
      hasPermission(grant.permissions, "connections:write", grant.permissionMode) &&
      hasPermission(grant.permissions, "secrets:write", grant.permissionMode) &&
      (connection.subjectId !== null
        ? connection.subjectId === grant.subjectId &&
          isPersonalConnectionOwnerPrincipal(authorization)
        : details.ownership !== "organization" || isAccountAdmin(authorization))
    );
  }

  function catalogVault(
    provider: VaultProvider,
    vault: ProviderVault,
    linkedVaultId: string | null,
  ): ProviderVaultMeta {
    return {
      externalVaultId: vault.externalVaultId,
      name: vault.name,
      itemCount: vault.itemCount,
      linkedVaultId,
      writeAccess: vault.writeAccess ?? "unknown",
      operations: providerOperations(provider.capabilities(), vault),
    };
  }

  async function finishExternalSetup(input: {
    authorization: AccessGrantAuthorization;
    workspaceId: string;
    connection: ConnectionMetadata;
    credentials: VaultProviderCredentials | StoredVaultProviderCredentials;
    currentCredentials: StoredVaultProviderCredentials | null;
    pendingCredentials?: StoredVaultProviderCredentials | null;
    isNew: boolean;
  }): Promise<{ body: InstallVaultProviderResponse; status: 200 | 201 | 202 }> {
    const { authorization, workspaceId } = input;
    const { grant } = authorization;
    const key = requireEnvironmentEncryption(settings);
    const details = externalVaultConnectionDetails(input.connection.metadata)!;
    const context = vaultContextFor(authorization, workspaceId);
    const linked = await linkedVaultRows(context, workspaceId, input.connection.id);
    let connection = input.connection;
    let saved = false;
    let hasPending = Boolean(input.pendingCredentials);
    let storedBundle: unknown = input.pendingCredentials
      ? pendingVaultCredentialBundle(input.currentCredentials, input.pendingCredentials)
      : (input.currentCredentials ?? {});
    const continuation = externalActorContinuationForAuthorization(authorization);
    const persist = async (
      credentials: StoredVaultProviderCredentials,
      ready?: ExternalVaultConnectionDetails,
    ) => {
      const unchangedCurrent =
        input.currentCredentials !== null &&
        isDeepStrictEqual(credentials, input.currentCredentials);
      const pending = !ready && !unchangedCurrent;
      const nextMetadata = ready ?? {
        ...details,
        verificationStatus: pending ? ("pending" as const) : ("ready" as const),
      };
      const nextBundle = pending
        ? pendingVaultCredentialBundle(input.currentCredentials, credentials)
        : credentials;
      const nextStatus = pending ? connection.status : ("active" as const);
      const previousDetails = externalVaultConnectionDetails(connection.metadata);
      // A read-only verification must not invalidate in-flight provider calls.
      // Actual credential, status or capability changes still advance the fence.
      const generationChanged =
        !isDeepStrictEqual(nextBundle, storedBundle) ||
        nextStatus !== connection.status ||
        !isDeepStrictEqual(previousDetails?.operations, nextMetadata.operations);
      if (!generationChanged && isDeepStrictEqual(previousDetails, nextMetadata)) {
        saved = true;
        hasPending = pending;
        return;
      }
      const updated = await db.transaction(async (tx) => {
        await requireConnectOwnerAuthority(tx, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          personalOwnerVerified: isPersonalConnectionOwnerPrincipal(authorization),
          ...(continuation ? { externalContinuation: continuation } : {}),
        });
        return updateConnection(tx, {
          workspaceId,
          connectionId: connection.id,
          visibleToSubjectId: grant.subjectId,
          expectedVersion: connection.version,
          status: nextStatus,
          ...(generationChanged
            ? { credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify(nextBundle)) }
            : {}),
          metadata: { ...connection.metadata, ...externalVaultConnectionMetadata(nextMetadata) },
          updatedBySubjectId: grant.subjectId,
        });
      });
      if (!updated)
        throw new HTTPException(409, {
          message: "This vault connection changed. Reload it before continuing setup.",
        });
      connection = updated;
      saved = true;
      hasPending = pending;
      storedBundle = nextBundle;
    };
    try {
      const checked = await prepareExternal(
        input.credentials,
        authorization,
        workspaceId,
        connection.id,
        persist,
      );
      const sameAccount =
        details.accountId !== null
          ? checked.accountId === details.accountId
          : linked.length === 0 ||
            linked.every((row) =>
              checked.vaults.some((vault) => vault.externalVaultId === row.providerVaultRef),
            );
      if (!sameAccount)
        throw new VaultProviderError(
          "provider_conflict",
          "These credentials do not reach the same account and linked vaults. Connect them separately instead.",
        );
      const ready: ExternalVaultConnectionDetails = {
        ...details,
        accountId: checked.accountId ?? details.accountId,
        accountName: checked.accountName,
        operations: checked.operations,
        verifiedAt: new Date().toISOString(),
        verificationStatus: "ready",
      };
      await persist(checked.credentials, ready);
      const providers = vaultProviderRegistryFor(deps, { workspaceId, subjectId: grant.subjectId });
      for (const row of linked) {
        await syncLinkedProviderVault({
          db,
          context,
          vaultId: row.id,
          providers,
          force: true,
        }).catch(() => undefined);
      }
      const linkedIds = new Map(linked.map((row) => [row.providerVaultRef, row.id]));
      return {
        status: input.isNew ? 201 : 200,
        body: InstallVaultProviderResponse.parse({
          connectionId: connection.id,
          provider: details.provider,
          accountName: ready.accountName,
          operations: ready.operations,
          vaults: checked.vaults.map((vault) =>
            catalogVault(checked.provider, vault, linkedIds.get(vault.externalVaultId) ?? null),
          ),
        }),
      };
    } catch (error) {
      if (isVaultProviderError(error) && error.code === "provider_conflict" && hasPending) {
        if (input.currentCredentials) {
          // Reject the candidate, not the working connection. CAS prevents this
          // rollback from overwriting a concurrent reconnect or disconnect.
          await persist(input.currentCredentials, { ...details, verificationStatus: "ready" });
        } else {
          await revokeConnection(
            db,
            workspaceId,
            connection.id,
            grant.subjectId,
            connection.version,
          );
        }
        throw error;
      }
      // A bound key is durable even if later discovery fails. Never tell the
      // person to repeat a consumed bootstrap token or overwrite working keys.
      if (saved && hasPending && isVaultProviderError(error)) {
        return {
          status: 202,
          body: InstallVaultProviderResponse.parse({
            connectionId: connection.id,
            provider: details.provider,
            accountName: details.accountName,
            operations: details.operations,
            vaults: [],
            discoveryPending: true,
            errorCode: error.code,
          }),
        };
      }
      if (!saved && input.isNew) {
        await revokeConnection(db, workspaceId, connection.id, grant.subjectId, connection.version);
      }
      throw error;
    }
  }

  async function prepareExternal(
    credentials: VaultProviderCredentials | StoredVaultProviderCredentials,
    authorization: AccessGrantAuthorization,
    workspaceId: string,
    connectionId: string | null,
    persistCredentials: (credentials: StoredVaultProviderCredentials) => Promise<void>,
  ) {
    const factory = externalVaultFactoriesFor(deps)[credentials.provider];
    if (!factory)
      throw new VaultProviderError(
        "provider_unavailable",
        "This vault provider is not available in this deployment.",
      );
    let rotated: StoredVaultProviderCredentials | undefined;
    const signal = AbortSignal.timeout(30_000);
    const prepared = await factory({
      credentials,
      ...(connectionId ? { connectionId } : {}),
      signal,
      persistCredentials: async (next) => {
        const parsed = StoredVaultProviderCredentials.safeParse(next);
        if (!parsed.success || parsed.data.provider !== credentials.provider)
          throw new VaultProviderError(
            "provider_unavailable",
            "The provider returned invalid connection state.",
          );
        rotated = parsed.data;
        await persistCredentials(parsed.data);
      },
    });
    if (prepared.provider.id !== credentials.provider)
      throw new VaultProviderError(
        "provider_unavailable",
        "The configured adapter does not match this connection.",
      );
    const preparedCredentials = StoredVaultProviderCredentials.safeParse(prepared.credentials);
    if (!preparedCredentials.success || preparedCredentials.data.provider !== credentials.provider)
      throw new VaultProviderError(
        "provider_unavailable",
        "The provider returned invalid connection state.",
      );
    if (!rotated) await persistCredentials(preparedCredentials.data);
    const ctx: VaultProviderContext = {
      connectionId,
      budget: createProviderCallBudget(50),
      signal,
      forceRefresh: true,
      authority: {
        accountId: authorization.grant.accountId,
        workspaceId,
        connectionWorkspaceId: workspaceId,
        subjectId: authorization.grant.subjectId,
      },
    };
    const validated = await prepared.provider.validate(ctx);
    const vaults = await listProviderVaults(prepared.provider, ctx);
    const stored = StoredVaultProviderCredentials.safeParse(rotated ?? prepared.credentials);
    if (!stored.success || stored.data.provider !== credentials.provider)
      throw new VaultProviderError(
        "provider_unavailable",
        "The provider returned invalid connection state.",
      );
    return {
      provider: prepared.provider,
      credentials: stored.data,
      vaults,
      accountId: validated.accountId ?? null,
      accountName: validated.accountName,
      operations: providerOperations(prepared.provider.capabilities()),
    };
  }

  async function linkedVaultRows(
    context: VaultDbContext,
    workspaceId: string,
    connectionId: string,
  ): Promise<(VaultRow & { providerVaultRef: string })[]> {
    const rows = await listVaultsForSubject(db, context, { workspaceId });
    return rows.filter(
      (row): row is VaultRow & { providerVaultRef: string } =>
        row.source !== "opengeni" &&
        row.providerConnectionId === connectionId &&
        row.providerVaultRef !== null,
    );
  }
}
