import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  InstallOnePasswordRequest,
  InstallOnePasswordResponse,
  ProviderVaultMeta,
  VAULT_ERROR_HTTP_STATUS,
} from "@opengeni/contracts";
import {
  ONEPASSWORD_CREDENTIAL_ROLE,
  ONEPASSWORD_PROVIDER_DOMAIN,
  externalActorContinuationForAuthorization,
  isOnePasswordConnection,
  loadOnePasswordConnectionToken,
  onePasswordCredentialBundle,
  requireAccessGrantAuthorization,
  requireEnvironmentEncryption,
  vaultErrorCodeForProvider,
  type ApiRouteDeps,
  type OnePasswordConnectionMetadata,
  type OnePasswordVaultProviderFactory,
} from "@opengeni/core";
import { createConnection, encryptEnvironmentValue, getConnectionMetadata } from "@opengeni/db";
import {
  isVaultProviderError,
  type VaultProvider,
  type VaultProviderContext,
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

export type LinkedVaultLookup = (input: {
  workspaceId: string;
  connectionId: string;
}) => Promise<ReadonlyMap<string, string>>;

export function registerVaultProviderRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: { linkedVaults?: LinkedVaultLookup } = {},
): void {
  const { db, settings } = deps;
  const linkedVaults: LinkedVaultLookup = options.linkedVaults ?? (async () => new Map());

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
    const { grant } = await requireAccessGrantAuthorization(c, deps, workspaceId, "secrets:list");
    try {
      const { provider } = await onePasswordProviderForConnection(deps, {
        workspaceId,
        connectionId,
        subjectId: grant.subjectId,
      });
      const [vaults, linked] = await Promise.all([
        provider.listVaults(routeProviderContext(connectionId)),
        linkedVaults({ workspaceId, connectionId }),
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
      return providerErrorResponse(c, error);
    }
  });
}
