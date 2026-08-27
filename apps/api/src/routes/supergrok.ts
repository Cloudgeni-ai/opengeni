import {
  configuredModels,
  environmentsEncryptionKeyBytes,
  withXaiSubscriptionCatalogProvider,
} from "@opengeni/config";
import {
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  type XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import {
  disconnectXaiSubscriptionCredentialAndRepick,
  ensureXaiRotationSettings,
  getXaiRotationSettings,
  getXaiSubscriptionAccountAuthoritySnapshot,
  listXaiSubscriptionAccountsMetadata,
  materializeXaiCredentialForRun,
  refreshXaiSubscriptionCredentialSerialized,
  renameXaiSubscriptionAccount,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  setActiveXaiCredential,
  setInitialActiveXaiCredential,
  updateXaiAllocatorEligibility,
  updateXaiRotationSettings,
  upsertXaiSubscriptionCredential,
  wakeXaiCapacityWaiters,
  type XaiSubscriptionAccountMetadata,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import { getManagedSession, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  XAI_CLIENT_VERSION,
  XaiSubscriptionError,
  fetchXaiSubscriptionModels,
  pollXaiDeviceCode,
  refreshXaiToken,
  requestXaiDeviceCode,
  xaiAccessTokenExpiry,
  xaiIdentityFromDeviceTokens,
  type XaiFetch,
  type XaiProxyAuthContext,
} from "@opengeni/xai-subscription";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod/v4";
import { projectClientModel } from "../model-catalog";

type XaiAuthoritySnapshot = XaiProviderAccountAuthoritySnapshotV1;
type ManagedCookieHuman = { subjectId: string };

type SuperGrokConnectState = {
  workspaceId: string;
  scope: "workspace" | "user";
  subjectId: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresAt: number;
  iat: number;
};

const connectStartBody = z.object({
  scope: z.enum(["workspace", "user"]).default("workspace"),
});
const connectPollBody = z.object({ state: z.string().min(1).max(16_384) });
const allocatorBody = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive(),
});
const settingsBody = z.object({ rotationEnabled: z.boolean() });
const renameBody = z.object({ label: z.string().trim().max(200).nullable() });

async function managedCookieHuman(
  c: Context,
  deps: ApiRouteDeps,
): Promise<ManagedCookieHuman | null> {
  if (
    deps.settings.productAccessMode !== "managed" ||
    !deps.managedAuth ||
    !c.req.header("cookie") ||
    c.req.header("authorization")
  ) {
    return null;
  }
  const session = await getManagedSession(c, deps.managedAuth, {
    db: deps.db,
    sessionAdapter: deps.managedAuthSessionAdapter,
    sessionSetMode: deps.settings.managedAuthSessionSetMode,
  });
  return session?.user?.id ? { subjectId: `user:${session.user.id}` } : null;
}

function requireSameOriginBrowserMutation(c: Context, deps: ApiRouteDeps): void {
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HTTPException(403, { message: "JSON browser request required" });
  }
  if (!deps.settings.publicBaseUrl) {
    throw new HTTPException(503, {
      message: "managed browser origin is not configured",
    });
  }
  const expectedOrigin = new URL(deps.settings.publicBaseUrl).origin;
  if (c.req.header("origin") !== expectedOrigin) {
    throw new HTTPException(403, {
      message: "same-origin browser request required",
    });
  }
  if (c.req.header("sec-fetch-site")?.toLowerCase() !== "same-origin") {
    throw new HTTPException(403, {
      message: "same-origin fetch metadata required",
    });
  }
}

function requireEnabled(deps: ApiRouteDeps): void {
  if (!deps.settings.supergrokSubscriptionEnabled) {
    throw new HTTPException(404, {
      message: "SuperGrok subscriptions are not enabled",
    });
  }
}

async function requirePrivateHuman(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<{ accountId: string; subjectId: string }> {
  if (c.req.header("authorization")) {
    throw new HTTPException(403, {
      message: "authorization bearer is not allowed for private SuperGrok accounts",
    });
  }
  const human = await managedCookieHuman(c, deps);
  if (!human) {
    throw new HTTPException(401, {
      message: "managed browser session required",
    });
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
  if (grant.subjectId !== human.subjectId) {
    throw new HTTPException(403, {
      message: "managed browser identity mismatch",
    });
  }
  return { accountId: grant.accountId, subjectId: grant.subjectId };
}

async function requireScopeMutation(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  scope: "workspace" | "user",
): Promise<{ accountId: string; subjectId: string }> {
  if (scope === "user") {
    requireSameOriginBrowserMutation(c, deps);
    return await requirePrivateHuman(c, deps, workspaceId);
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
  return { accountId: grant.accountId, subjectId: grant.subjectId };
}

async function resolveReadAuthority(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<{
  accountId: string;
  subjectId: string;
  snapshot: XaiAuthoritySnapshot;
}> {
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
  const snapshot = await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(deps.db, {
    workspaceId,
    subjectId: grant.subjectId,
  });
  if (snapshot.scope === "workspace") {
    return { accountId: grant.accountId, subjectId: grant.subjectId, snapshot };
  }
  const human = await requirePrivateHuman(c, deps, workspaceId);
  if (human.subjectId !== grant.subjectId) {
    throw new HTTPException(403, {
      message: "managed browser identity mismatch",
    });
  }
  return { accountId: human.accountId, subjectId: human.subjectId, snapshot };
}

function xaiHttpError(error: unknown, fallback: string): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof XaiSubscriptionError) {
    const status =
      error.kind === "not_enabled" ? 409 : error.kind === "relogin_required" ? 401 : 502;
    return new HTTPException(status, { message: error.message });
  }
  return new HTTPException(502, { message: fallback });
}

function accountJson(row: XaiSubscriptionAccountMetadata, activeCredentialId: string | null) {
  return {
    id: row.id,
    scope: row.scope,
    subject: row.providerAccountId ?? row.accountEmail ?? row.id,
    email: row.accountEmail,
    label: row.label,
    status: row.status === "disabled" ? "error" : row.status,
    active: row.id === activeCredentialId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastRefreshAt: row.lastRefreshAt?.toISOString() ?? null,
    lastError: row.lastError,
    allocatorEnabled: row.allocatorEnabled,
    allocatorVersion: row.allocatorVersion,
    allocatorUpdatedAt: row.allocatorUpdatedAt?.toISOString() ?? null,
    exhaustedUntil: row.exhaustedUntil?.toISOString() ?? null,
    quota:
      row.quotaUsedPercent === null && row.quotaResetAt === null && row.quotaCheckedAt === null
        ? null
        : {
            usedPercent: row.quotaUsedPercent,
            periodStart: null,
            periodEnd: row.quotaResetAt?.toISOString() ?? null,
            subscriptionTier: row.planType,
            checkedAt: row.quotaCheckedAt?.toISOString() ?? null,
          },
  };
}

async function materializedAuthContext(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    credentialId: string;
    authoritySnapshot: XaiAuthoritySnapshot;
  },
): Promise<{
  context: XaiProxyAuthContext;
  account: XaiSubscriptionAccountMetadata;
}> {
  const encryptionKey = environmentsEncryptionKeyBytes(deps.settings);
  if (!encryptionKey) {
    throw new HTTPException(500, {
      message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
    });
  }
  let credential = await materializeXaiCredentialForRun(deps.db, {
    ...input,
    encryptionKey,
  });
  const tokenSnapshot = () => {
    if (!credential.secret.accessToken || !credential.providerAccountId) {
      throw new XaiSubscriptionError(
        "relogin_required",
        "The SuperGrok connection is missing an access token or verified identity",
      );
    }
    return {
      accessToken: credential.secret.accessToken,
      userId: credential.providerAccountId,
    };
  };
  return {
    account: credential,
    context: {
      clientVersion: XAI_CLIENT_VERSION,
      getToken: async () => tokenSnapshot(),
      refresh: async () => {
        const observedAccessToken = credential.secret.accessToken;
        const observedRefreshToken = credential.secret.refreshToken;
        if (!observedRefreshToken) {
          throw new XaiSubscriptionError(
            "relogin_required",
            "The SuperGrok connection cannot be refreshed",
          );
        }
        const result = await refreshXaiSubscriptionCredentialSerialized(deps.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          credentialId: input.credentialId,
          authoritySnapshot: input.authoritySnapshot,
          encryptionKey,
          observedAccessToken,
          observedRefreshToken,
          refresh: async (current) => {
            const refreshToken = current.secret.refreshToken;
            if (!refreshToken) {
              throw new XaiSubscriptionError(
                "relogin_required",
                "The SuperGrok connection cannot be refreshed",
              );
            }
            const tokens = await refreshXaiToken(refreshToken, {
              fetch: (deps.xaiFetch ?? fetch) as XaiFetch,
            });
            return {
              secret: {
                version: 1,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
              },
              expiresAt:
                xaiAccessTokenExpiry(tokens.accessToken) ??
                new Date(Date.now() + tokens.expiresInSeconds * 1_000),
            };
          },
        });
        credential = result.credential;
        return tokenSnapshot();
      },
    },
  };
}

async function authorityForAccountMutation(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  credentialId: string,
): Promise<{
  accountId: string;
  subjectId: string;
  snapshot: XaiAuthoritySnapshot;
}> {
  const readGrant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
  const snapshot = await getXaiSubscriptionAccountAuthoritySnapshot(deps.db, {
    workspaceId,
    subjectId: readGrant.subjectId,
    credentialId,
  });
  if (!snapshot) throw new HTTPException(404, { message: "SuperGrok account not found" });
  const mutation = await requireScopeMutation(c, deps, workspaceId, snapshot.scope);
  return { ...mutation, snapshot };
}

export function registerSuperGrokRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/workspaces/:workspaceId/supergrok/connect/start", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const parsed = connectStartBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid SuperGrok scope" });
    const authority = await requireScopeMutation(c, deps, workspaceId, parsed.data.scope);
    try {
      const start = await requestXaiDeviceCode({
        fetch: (deps.xaiFetch ?? fetch) as XaiFetch,
      });
      const expiresAt = Math.floor(Date.now() / 1_000) + start.expiresInSeconds;
      return c.json({
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        verificationUriComplete: start.verificationUriComplete,
        intervalSeconds: start.intervalSeconds,
        expiresInSeconds: start.expiresInSeconds,
        scope: parsed.data.scope,
        state: createSignedState(deps.githubStateSecret, {
          workspaceId,
          scope: parsed.data.scope,
          subjectId: authority.subjectId,
          deviceCode: start.deviceCode,
          intervalSeconds: start.intervalSeconds,
          expiresAt,
        }),
      });
    } catch (error) {
      throw xaiHttpError(error, "failed to start SuperGrok device login");
    }
  });

  app.post("/v1/workspaces/:workspaceId/supergrok/connect/poll", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const parsed = connectPollBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "SuperGrok state is required" });
    const state = readSignedState(
      parsed.data.state,
      deps.githubStateSecret,
    ) as SuperGrokConnectState | null;
    if (
      !state ||
      state.workspaceId !== workspaceId ||
      !["workspace", "user"].includes(state.scope) ||
      !state.subjectId ||
      !state.deviceCode ||
      !Number.isFinite(state.intervalSeconds) ||
      !Number.isFinite(state.expiresAt)
    ) {
      throw new HTTPException(400, {
        message: "SuperGrok connect state is invalid or expired",
      });
    }
    const authority = await requireScopeMutation(c, deps, workspaceId, state.scope);
    if (authority.subjectId !== state.subjectId) {
      throw new HTTPException(403, {
        message: "SuperGrok connect identity changed",
      });
    }
    if (Math.floor(Date.now() / 1_000) >= state.expiresAt) {
      return c.json({ status: "expired" as const });
    }
    let phase = "device_token_exchange";
    try {
      const poll = await pollXaiDeviceCode(
        {
          deviceCode: state.deviceCode,
          intervalSeconds: state.intervalSeconds,
        },
        { fetch: (deps.xaiFetch ?? fetch) as XaiFetch },
      );
      if (poll.status !== "authorized") return c.json(poll);
      phase = "token_identity";
      const identity = xaiIdentityFromDeviceTokens(poll.tokens);
      phase = "credential_persist";
      const encryptionKey = environmentsEncryptionKeyBytes(deps.settings);
      if (!encryptionKey) {
        throw new HTTPException(500, {
          message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
        });
      }
      const upserted = await upsertXaiSubscriptionCredential(deps.db, {
        accountId: authority.accountId,
        workspaceId,
        subjectId: authority.subjectId,
        scope: state.scope,
        encryptionKey,
        secret: {
          version: 1,
          accessToken: poll.tokens.accessToken,
          refreshToken: poll.tokens.refreshToken,
        },
        providerAccountId: identity.subject,
        label: identity.name ?? identity.email ?? identity.subject,
        accountEmail: identity.email,
        expiresAt:
          xaiAccessTokenExpiry(poll.tokens.accessToken) ??
          new Date(Date.now() + poll.tokens.expiresInSeconds * 1_000),
      });
      const rotation = await ensureXaiRotationSettings(deps.db, {
        accountId: authority.accountId,
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: upserted.authoritySnapshot,
      });
      let isActive = rotation.activeCredentialId === upserted.account.id;
      if (!isActive && rotation.activeCredentialId === null) {
        isActive = await setInitialActiveXaiCredential(deps.db, {
          accountId: authority.accountId,
          workspaceId,
          subjectId: authority.subjectId,
          authoritySnapshot: upserted.authoritySnapshot,
          credentialId: upserted.account.id,
        });
      }
      await wakeXaiCapacityWaiters(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: upserted.authoritySnapshot,
        reason: "xai_credential_connected",
      });
      return c.json({
        status: "connected" as const,
        accountId: upserted.account.id,
        scope: state.scope,
        isActive,
        email: identity.email,
      });
    } catch (error) {
      deps.observability?.warn("SuperGrok connection operation failed", {
        provider: "xai",
        providerApi: "oauth",
        op: phase,
        outcome: "failed",
        reason:
          error instanceof XaiSubscriptionError
            ? error.kind
            : error instanceof HTTPException
              ? "http_exception"
              : "unexpected",
        status:
          error instanceof XaiSubscriptionError
            ? error.status
            : error instanceof HTTPException
              ? error.status
              : undefined,
      });
      throw xaiHttpError(error, "SuperGrok device login failed");
    }
  });

  app.get("/v1/workspaces/:workspaceId/supergrok/accounts", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const authority = await resolveReadAuthority(c, deps, workspaceId);
    const [accounts, settings] = await Promise.all([
      listXaiSubscriptionAccountsMetadata(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
      }),
      getXaiRotationSettings(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: authority.snapshot,
      }),
    ]);
    const activeCredentialId = settings?.activeCredentialId ?? null;
    return c.json({
      accounts: accounts.map((account) => accountJson(account, activeCredentialId)),
      activeAccountId: activeCredentialId,
      settings: {
        rotationEnabled: settings?.rotationEnabled ?? true,
        rotationStrategy: "sharded" as const,
        activeCredentialId,
      },
    });
  });

  app.get("/v1/workspaces/:workspaceId/supergrok/status", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const authority = await resolveReadAuthority(c, deps, workspaceId);
    const [accounts, settings] = await Promise.all([
      listXaiSubscriptionAccountsMetadata(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
      }),
      getXaiRotationSettings(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: authority.snapshot,
      }),
    ]);
    const active = accounts.find((account) => account.id === settings?.activeCredentialId) ?? null;
    if (!active || !settings?.activeCredentialId) {
      return c.json({
        connected: accounts.length > 0,
        valid: false,
        accountCount: accounts.length,
      });
    }
    let valid = false;
    try {
      const auth = await materializedAuthContext(deps, {
        accountId: authority.accountId,
        workspaceId,
        subjectId: authority.subjectId,
        credentialId: active.id,
        authoritySnapshot: authority.snapshot,
      });
      await fetchXaiSubscriptionModels({
        context: auth.context,
        ...(deps.xaiFetch ? { fetch: deps.xaiFetch } : {}),
      });
      valid = true;
    } catch {
      valid = false;
    }
    const catalog = valid
      ? configuredModels(withXaiSubscriptionCatalogProvider(deps.settings))
          .filter(
            (model) =>
              model.credentialSource.kind === "connected_subscription" &&
              model.credentialSource.provider === "xai",
          )
          .map(projectClientModel)
      : [];
    return c.json({
      connected: true,
      valid,
      accountCount: accounts.length,
      models: catalog,
      activeAccount: {
        id: active.id,
        label: active.label,
        subject: active.providerAccountId,
        scope: active.scope,
      },
    });
  });

  app.post("/v1/workspaces/:workspaceId/supergrok/accounts/:accountId/activate", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const credentialId = c.req.param("accountId");
    const authority = await authorityForAccountMutation(c, deps, workspaceId, credentialId);
    const activated = await setActiveXaiCredential(deps.db, {
      accountId: authority.accountId,
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: authority.snapshot,
      credentialId,
    });
    if (!activated)
      throw new HTTPException(409, {
        message: "SuperGrok account requires relogin",
      });
    await wakeXaiCapacityWaiters(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: authority.snapshot,
      reason: "xai_active_credential_changed",
    });
    return c.json({ activated: true, accountId: credentialId });
  });

  app.patch("/v1/workspaces/:workspaceId/supergrok/settings", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const parsed = settingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "rotationEnabled is required" });
    const readAuthority = await resolveReadAuthority(c, deps, workspaceId);
    const authority = await requireScopeMutation(
      c,
      deps,
      workspaceId,
      readAuthority.snapshot.scope,
    );
    const current = await ensureXaiRotationSettings(deps.db, {
      accountId: authority.accountId,
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: readAuthority.snapshot,
    });
    const updated = await updateXaiRotationSettings(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: readAuthority.snapshot,
      expectedVersion: current.version,
      rotationEnabled: parsed.data.rotationEnabled,
    }).catch(() => null);
    if (!updated) throw new HTTPException(409, { message: "SuperGrok settings changed" });
    await wakeXaiCapacityWaiters(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: readAuthority.snapshot,
      reason: "xai_rotation_settings_changed",
    });
    return c.json({
      rotationEnabled: updated.rotationEnabled,
      rotationStrategy: "sharded" as const,
      activeCredentialId: updated.activeCredentialId,
    });
  });

  app.patch("/v1/workspaces/:workspaceId/supergrok/accounts/:accountId/allocator", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const credentialId = c.req.param("accountId");
    const authority = await authorityForAccountMutation(c, deps, workspaceId, credentialId);
    const parsed = allocatorBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: "enabled and expectedVersion are required",
      });
    }
    const result = await updateXaiAllocatorEligibility(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      credentialId,
      enabled: parsed.data.enabled,
      expectedVersion: parsed.data.expectedVersion,
    });
    if (result.kind === "not_found") {
      throw new HTTPException(404, {
        message: "SuperGrok account not found",
      });
    }
    const response = {
      allocatorEnabled: result.allocatorEnabled,
      allocatorVersion: result.allocatorVersion,
      allocatorUpdatedAt: result.allocatorUpdatedAt?.toISOString() ?? null,
      changed: result.kind === "updated",
    };
    if (result.kind === "updated") {
      await wakeXaiCapacityWaiters(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: authority.snapshot,
        reason: "xai_allocator_eligibility_changed",
      });
    }
    return result.kind === "conflict" ? c.json(response, 409) : c.json(response);
  });

  app.patch("/v1/workspaces/:workspaceId/supergrok/accounts/:accountId", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const credentialId = c.req.param("accountId");
    const authority = await authorityForAccountMutation(c, deps, workspaceId, credentialId);
    const parsed = renameBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "label is invalid" });
    const account = await renameXaiSubscriptionAccount(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      credentialId,
      label: parsed.data.label || null,
    });
    if (!account)
      throw new HTTPException(404, {
        message: "SuperGrok account not found",
      });
    const settings = await getXaiRotationSettings(deps.db, {
      workspaceId,
      subjectId: authority.subjectId,
      authoritySnapshot: authority.snapshot,
    });
    return c.json(accountJson(account, settings?.activeCredentialId ?? null));
  });

  app.delete("/v1/workspaces/:workspaceId/supergrok/accounts/:accountId", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const credentialId = c.req.param("accountId");
    const authority = await authorityForAccountMutation(c, deps, workspaceId, credentialId);
    if (authority.snapshot.scope === "user") {
      await wakeXaiCapacityWaiters(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: authority.snapshot,
        reason: "xai_credential_disconnecting",
      });
    }
    const result = await disconnectXaiSubscriptionCredentialAndRepick(deps.db, {
      accountId: authority.accountId,
      workspaceId,
      subjectId: authority.subjectId,
      credentialId,
      authoritySnapshot: authority.snapshot,
    });
    if (result.disconnected && authority.snapshot.scope === "workspace") {
      await wakeXaiCapacityWaiters(deps.db, {
        workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
        reason: "xai_credential_disconnected",
      });
    }
    return c.json({
      disconnected: result.disconnected,
      newActiveId: result.newActiveCredentialId,
    });
  });
}
