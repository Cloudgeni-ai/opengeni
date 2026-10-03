import { registerSubscriptionAccountPoolRoutes } from "./subscription-account-pools";
import {
  managedCookieHuman,
  requireSameOriginBrowserMutation,
  requirePrivateSubscriptionHuman,
  requireSubscriptionScopeMutation,
} from "./subscription-pool-access";
export { managedCookieHuman } from "./subscription-pool-access";
import { requireOrganizationCodexHuman } from "./codex";
import {
  listOrganizationXaiSubscriptions,
  upsertOrganizationXaiSubscription,
  updateOrganizationXaiSubscription,
  updateOrganizationXaiRotation,
} from "@opengeni/db";
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
  encryptEnvironmentValue,
  decryptEnvironmentValue,
  getWorkspaceGrant,
  type XaiSubscriptionAccountMetadata,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  getManagedSession,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  externalActorContinuationForAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
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
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import { requireConnectOwnerAuthority } from "../integrations/connect-authority";

type XaiAuthoritySnapshot = XaiProviderAccountAuthoritySnapshotV1;

type SuperGrokConnectState = {
  externalContinuationEncrypted?: string;
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

function requireEnabled(deps: ApiRouteDeps): void {
  if (!deps.settings.supergrokSubscriptionEnabled) {
    throw new HTTPException(404, {
      message: "SuperGrok subscriptions are not enabled",
    });
  }
}

const requirePrivateHuman = (c: Context, deps: ApiRouteDeps, workspaceId: string) =>
  requirePrivateSubscriptionHuman(c, deps, workspaceId, "SuperGrok");
export const requireScopeMutation = (
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  scope: "workspace" | "user" | "organization",
) => requireSubscriptionScopeMutation(c, deps, workspaceId, scope, "SuperGrok");

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
  if (snapshot.scope !== "user") {
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
    plan: row.planType,
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
  registerSubscriptionAccountPoolRoutes(app, deps, {
    provider: "xai",
    route: "supergrok",
    displayName: "SuperGrok",
    enabled: () => deps.settings.supergrokSubscriptionEnabled,
    accountJson,
    repository: {
      listOrganizationSubscriptions: listOrganizationXaiSubscriptions,
      updateOrganizationSubscription: updateOrganizationXaiSubscription,
      updateOrganizationSubscriptionRotation: updateOrganizationXaiRotation,
      listSubscriptionAccountsMetadata: listXaiSubscriptionAccountsMetadata,
      getSubscriptionRotationSettings: getXaiRotationSettings,
      ensureSubscriptionRotationSettings: ensureXaiRotationSettings,
      getSubscriptionAccountAuthoritySnapshot: getXaiSubscriptionAccountAuthoritySnapshot,
      resolveSubscriptionProviderAccountAuthoritySnapshotForAcceptance:
        resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
      setActiveSubscriptionCredential: setActiveXaiCredential,
      updateSubscriptionRotationSettings: updateXaiRotationSettings,
      updateSubscriptionAllocatorEligibility: updateXaiAllocatorEligibility,
      renameSubscriptionAccount: renameXaiSubscriptionAccount,
      disconnectSubscriptionCredentialAndRepick: disconnectXaiSubscriptionCredentialAndRepick,
      wakeSubscriptionCapacityWaiters: wakeXaiCapacityWaiters,
    },
  });
  const { db } = deps;

  const organizationPath = "/v1/organizations/:organizationId/supergrok";
  const organizationActor = async (c: Context, mutation = false) => {
    requireEnabled(deps);
    if (mutation) requireSameOriginBrowserMutation(c, deps);
    const organizationId = c.req.param("organizationId")!;
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    return { organizationId, actorSubjectId: human.subjectId };
  };
  app.post(`${organizationPath}/connect/start`, async (c) => {
    const actor = await organizationActor(c, true);
    try {
      const start = await requestXaiDeviceCode({ fetch: (deps.xaiFetch ?? fetch) as XaiFetch });
      const expiresAt = Math.floor(Date.now() / 1000) + start.expiresInSeconds;
      return c.json({
        ...start,
        scope: "organization",
        state: createSignedState(deps.githubStateSecret, {
          ...actor,
          deviceCode: start.deviceCode,
          intervalSeconds: start.intervalSeconds,
          expiresAt,
        }),
        deviceCode: undefined,
      });
    } catch (error) {
      throw xaiHttpError(error, "Failed to start SuperGrok device login");
    }
  });
  app.post(`${organizationPath}/connect/poll`, async (c) => {
    const actor = await organizationActor(c, true);
    const parsed = connectPollBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "SuperGrok state is required" });
    const state = readSignedState(parsed.data.state, deps.githubStateSecret) as {
      organizationId?: string;
      actorSubjectId?: string;
      deviceCode?: string;
      intervalSeconds?: number;
      expiresAt?: number;
    } | null;
    if (
      !state ||
      state.organizationId !== actor.organizationId ||
      state.actorSubjectId !== actor.actorSubjectId ||
      !state.deviceCode ||
      !Number.isFinite(state.intervalSeconds) ||
      !Number.isFinite(state.expiresAt)
    ) {
      throw new HTTPException(400, { message: "SuperGrok connect state is invalid or expired" });
    }
    if (Math.floor(Date.now() / 1000) >= state.expiresAt!) return c.json({ status: "expired" });
    try {
      const poll = await pollXaiDeviceCode(
        { deviceCode: state.deviceCode, intervalSeconds: state.intervalSeconds! },
        { fetch: (deps.xaiFetch ?? fetch) as XaiFetch },
      );
      if (poll.status !== "authorized") return c.json(poll);
      const identity = xaiIdentityFromDeviceTokens(poll.tokens);
      const encryptionKey = environmentsEncryptionKeyBytes(deps.settings);
      if (!encryptionKey)
        throw new HTTPException(500, { message: "Connection encryption is not configured" });
      const connected = await upsertOrganizationXaiSubscription(db, {
        ...actor,
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
          new Date(Date.now() + poll.tokens.expiresInSeconds * 1000),
      });
      return c.json({
        status: "connected",
        accountId: connected.account.id,
        scope: "organization",
        isActive: connected.isActive,
        email: identity.email,
      });
    } catch (error) {
      throw xaiHttpError(error, "SuperGrok device login failed");
    }
  });
  app.post("/v1/workspaces/:workspaceId/supergrok/connect/start", async (c) => {
    requireEnabled(deps);
    const workspaceId = c.req.param("workspaceId");
    const parsed = connectStartBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HTTPException(400, { message: "invalid SuperGrok scope" });
    const authority = await requireScopeMutation(c, deps, workspaceId, parsed.data.scope);
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      parsed.data.scope === "workspace" ? "workspace:admin" : "connections:write",
    );
    const continuation = externalActorContinuationForAuthorization(authorization);
    const encryptionKey = environmentsEncryptionKeyBytes(deps.settings);
    if (continuation && !encryptionKey)
      throw new HTTPException(503, { message: "Credential encryption is unavailable" });
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
          ...(continuation
            ? {
                externalContinuationEncrypted: encryptEnvironmentValue(
                  encryptionKey!,
                  JSON.stringify(continuation),
                ),
              }
            : {}),
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
    const originKey = environmentsEncryptionKeyBytes(deps.settings);
    const origin =
      state.externalContinuationEncrypted && originKey
        ? ExternalActorContinuation.parse(
            JSON.parse(decryptEnvironmentValue(originKey, state.externalContinuationEncrypted)),
          )
        : null;
    if (state.externalContinuationEncrypted && !origin)
      throw new HTTPException(503, { message: "Connection origin unavailable" });
    const requireOrigin = async () => {
      if (origin)
        await requireConnectOwnerAuthority(
          deps.db,
          {
            accountId: authority.accountId,
            workspaceId,
            subjectId: authority.subjectId,
            externalContinuation: origin,
          },
          state.scope === "workspace" ? "workspace:admin" : "connections:write",
          origin,
        );
    };
    await requireOrigin();
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
      await requireOrigin();
      const liveAuthority = await requireScopeMutation(c, deps, workspaceId, state.scope);
      if (
        liveAuthority.accountId !== authority.accountId ||
        liveAuthority.subjectId !== authority.subjectId
      )
        throw new HTTPException(403, { message: "SuperGrok connection identity changed" });
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
    const catalogSettings = valid ? (await deps.resolveCatalogSettings()).settings : null;
    const catalog = catalogSettings
      ? configuredModels(withXaiSubscriptionCatalogProvider(catalogSettings))
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
}
