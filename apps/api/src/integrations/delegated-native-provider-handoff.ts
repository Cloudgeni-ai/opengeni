import {
  ApiIntegrationOAuthStartRequest,
  FikenOAuthStartRequest,
  OAuthStartRequest,
  OpenGeniSlackBotInstallRequest,
  SocialOAuthStartRequest,
  type Permission,
} from "@opengeni/contracts";
import { integrationDefinitionById } from "@opengeni/capabilities";
import { AtlassianOAuthStartRequest } from "@opengeni/contracts/atlassian";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import { GoogleDriveOAuthStartRequest } from "@opengeni/contracts/google-drive";
import {
  hasPermission,
  hasVerifiedOwningUserAuthorization,
  isVerifiedDelegatedHumanAuthorization,
  requireAccessGrantAuthorization,
  requireEnvironmentEncryption,
  requireResolvedAccessGrantAuthorization,
  verifiedDelegatedHumanAuthorizationForRequest,
  externalActorContinuationForAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  consumeIntegrationOAuthStateNonce,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getConnectAttempt,
  getConnectionMetadata,
  loadIntegrationOAuthPendingState,
  withDatabaseStatementTimeout,
} from "@opengeni/db";
import { withOrganizationIntegrationAcquisition } from "@opengeni/db/organization-integration-policy";
import { createSignedState, readSignedState } from "@opengeni/github";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCookie, setCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requirePersonPresentRouteAuthorization } from "../http/human-route-authorization";
import { startAtlassianOAuth } from "./atlassian";
import { requireConnectOwnerAuthority } from "./connect-authority";
import { startFikenOAuth } from "./fiken";
import { startGoogleDriveOAuth } from "./google-drive";
import { startSlackBotInstall } from "./slack-install";
import { startApiIntegrationProviderOAuth } from "./provider-oauth";
import { startSocialOAuth } from "./social-oauth";
import {
  integrationBaseUrl,
  oauthStateTtlMs,
  oauthStateFailureReturn,
  requireIntegrationsStateSecret,
  startMcpOAuth,
} from "./oauth-client";

export const NativeHandoffProvider = z.enum([
  "fiken",
  "google-drive",
  "atlassian",
  "slack-bot",
  "mcp-oauth",
  "provider-oauth",
  "social",
]);
type Provider = z.infer<typeof NativeHandoffProvider>;
const handoffKind = "delegated_native_provider_handoff";
const NativeIntent = z
  .object({
    kind: z.literal(handoffKind),
    version: z.literal(2),
    provider: NativeHandoffProvider,
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    subjectId: z.string().regex(/^user:[^\s\u0000-\u001f\u007f]+$/),
    permissions: z
      .array(z.enum(["connections:write", "workspace:read", "workspace:admin"]))
      .min(1)
      .max(2),
    encryptedPayload: z.string().min(1),
    connectionVersion: z.number().int().positive().optional(),
    connectAttemptId: z.string().uuid().optional(),
    connectAttemptRevision: z.number().int().positive().optional(),
    integrationKey: z.enum(["gmail", "slack-personal"]).optional(),
    nonce: z.string().min(1),
    iat: z.number().int(),
  })
  .strict();
const CallbackScope = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subjectId: z.string().min(1).max(1024),
  nonce: z.string().min(1),
  iat: z.number().int(),
});

function payloadFor(provider: Provider, raw: unknown) {
  const parsed =
    provider === "fiken"
      ? FikenOAuthStartRequest.safeParse(raw)
      : provider === "google-drive"
        ? GoogleDriveOAuthStartRequest.safeParse(raw)
        : provider === "atlassian"
          ? AtlassianOAuthStartRequest.safeParse(raw)
          : provider === "slack-bot"
            ? OpenGeniSlackBotInstallRequest.safeParse(raw)
            : provider === "mcp-oauth"
              ? OAuthStartRequest.safeParse(raw)
              : provider === "provider-oauth"
                ? ApiIntegrationOAuthStartRequest.safeParse(raw)
                : SocialOAuthStartRequest.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid provider start request" });
  return parsed.data;
}
function connectionIdFor(payload: ReturnType<typeof payloadFor>): string | undefined {
  return "connectionId" in payload ? payload.connectionId : undefined;
}
function permissionsFor(provider: Provider, payload: Record<string, unknown>): Permission[] {
  return provider === "social"
    ? [payload.ownership === "personal" ? "workspace:read" : "workspace:admin"]
    : ["connections:write"];
}
function integrationPolicyKey(
  provider: Provider,
  payload: Record<string, unknown>,
  integrationKey?: "gmail" | "slack-personal",
) {
  if (provider === "mcp-oauth") return integrationKey ?? "custom:mcp";
  if (provider === "social") return SocialOAuthStartRequest.parse(payload).provider;
  if (provider === "provider-oauth") {
    const definition = integrationDefinitionById(
      ApiIntegrationOAuthStartRequest.parse(payload).definitionId,
    );
    if (!definition) throw new HTTPException(404, { message: "Integration definition not found" });
    return definition.id;
  }
  return provider;
}
function requiresPersonalOwner(provider: Provider) {
  return provider === "google-drive" || provider === "atlassian";
}

function liveState(raw: string | undefined, deps: ApiRouteDeps): Record<string, unknown> | null {
  if (!raw) return null;
  const state = readSignedState(raw, requireIntegrationsStateSecret(deps.settings));
  const now = Math.floor(Date.now() / 1000);
  return state &&
    Number.isInteger(state.iat) &&
    now >= state.iat &&
    now - state.iat <= oauthStateTtlMs / 1000
    ? (state as Record<string, unknown>)
    : null;
}
async function providerStatePayload(
  provider: Provider,
  raw: string | undefined,
  deps: ApiRouteDeps,
): Promise<Record<string, unknown> | null> {
  let payload = liveState(raw, deps);
  if (!payload || payload.kind === handoffKind) return payload;
  if (provider === "mcp-oauth" && payload.kind === "mcp_oauth_reference") {
    const reference = z
      .object({
        accountId: z.string().uuid(),
        workspaceId: z.string().uuid(),
        id: z.string().uuid(),
      })
      .safeParse(payload);
    if (!reference.success) return null;
    const encrypted = await withDatabaseStatementTimeout(
      deps.db,
      Math.min(5_000, deps.oauthCallbackDeadlineMs ?? 30_000),
      (tx) => loadIntegrationOAuthPendingState(tx, reference.data),
    );
    if (!encrypted) return null;
    try {
      payload = liveState(
        decryptEnvironmentValue(requireEnvironmentEncryption(deps.settings), encrypted),
        deps,
      );
    } catch {
      return null;
    }
    if (
      !payload ||
      payload.accountId !== reference.data.accountId ||
      payload.workspaceId !== reference.data.workspaceId
    )
      return null;
  }
  if (!payload) return null;
  const valid =
    provider === "fiken"
      ? payload.kind === undefined &&
        payload.definitionId === undefined &&
        payload.mcpUrl === undefined
      : provider === "google-drive"
        ? payload.kind === "google_drive_oauth"
        : provider === "atlassian"
          ? payload.kind === "atlassian_oauth"
          : provider === "slack-bot"
            ? payload.kind === "slack_bot_install"
            : provider === "social"
              ? payload.kind === "social_oauth"
              : provider === "provider-oauth"
                ? payload.kind === undefined && typeof payload.definitionId === "string"
                : payload.kind === undefined &&
                  typeof payload.mcpUrl === "string" &&
                  payload.definitionId === undefined;
  return valid ? payload : null;
}
const NativeCallbackBinding = CallbackScope.extend({
  kind: z.literal("native_provider_callback_binding"),
  version: z.literal(1),
  provider: NativeHandoffProvider,
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  permissions: z
    .array(z.enum(["connections:write", "workspace:read", "workspace:admin"]))
    .min(1)
    .max(2),
  expiresAt: z.number().int().positive(),
}).strict();
function stateHash(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}
function bindingCookieName(provider: Provider, raw: string) {
  return `opengeni_oauth_${provider.replaceAll("-", "_")}_${stateHash(raw).slice(0, 24)}`;
}

/** Reject a conflicting authentication transport before any provider effects. */
export function requireNativeProviderStartTransport(
  context: Context,
  deps: ApiRouteDeps,
  authorization: AccessGrantAuthorization,
): void {
  requireResolvedAccessGrantAuthorization(authorization, authorization.grant.workspaceId);
  if (externalActorContinuationForAuthorization(authorization)) return;
  requireNativeProviderBrowserTransport(context, deps);
  requirePersonPresentRouteAuthorization(authorization);
}

/** Only a resolved browser may bind fresh provider state to its own callback. */
export function bindNativeProviderStart(
  context: Context,
  deps: ApiRouteDeps,
  input: {
    authorization: AccessGrantAuthorization;
    provider: Provider;
    authorizationUrl: string | null;
    expiresAt: string;
  },
): void {
  requireNativeProviderStartTransport(context, deps, input.authorization);
  if (externalActorContinuationForAuthorization(input.authorization)) return;
  if (!input.authorizationUrl)
    throw new HTTPException(503, { message: "Provider browser authorization unavailable" });
  const raw = new URL(input.authorizationUrl).searchParams.get("state");
  const grant = input.authorization.grant;
  if (!raw || liveState(raw, deps)?.kind === handoffKind)
    throw new HTTPException(403, { message: "Native provider consent state required" });
  const parsed = liveState(raw, deps);
  const permissions = permissionsFor(input.provider, parsed ?? {});
  if (permissions.some((permission) => !hasPermission(grant.permissions, permission)))
    throw new HTTPException(403, { message: "Provider setup permission required" });
  const expiresAt = Math.min(Date.parse(input.expiresAt), Date.now() + oauthStateTtlMs);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
    throw new HTTPException(403, { message: "Provider consent state expired" });
  const value = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    kind: "native_provider_callback_binding",
    version: 1,
    provider: input.provider,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    stateHash: stateHash(raw),
    permissions,
    expiresAt,
  });
  setCookie(context, bindingCookieName(input.provider, raw), value, {
    httpOnly: true,
    secure:
      new URL(integrationBaseUrl(deps.settings.publicBaseUrl, context.req.url)).protocol ===
      "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
  });
  context.header("Cache-Control", "no-store");
}

/** Delegation starts an intent, never the provider's consent/PKCE state. */
export async function delegatedNativeProviderStart(
  deps: ApiRouteDeps,
  input: {
    authorization: AccessGrantAuthorization;
    provider: Provider;
    payload: unknown;
    requestUrl: string;
    connectAttemptId?: string;
    connectAttemptRevision?: number;
    integrationKey?: "gmail" | "slack-personal";
  },
): Promise<{ state: string; authorizationUrl: string; expiresAt: string } | null> {
  const grant = requireResolvedAccessGrantAuthorization(
    input.authorization,
    input.authorization.grant.workspaceId,
  );
  if (!isVerifiedDelegatedHumanAuthorization(input.authorization)) {
    if (
      !hasVerifiedOwningUserAuthorization(input.authorization) &&
      !input.authorization.canonicalLocalHumanSession
    )
      throw new HTTPException(403, { message: "Verified provider setup owner required" });
    return null;
  }
  const payload = payloadFor(input.provider, input.payload);
  if (
    input.connectAttemptRevision !== undefined &&
    (!input.connectAttemptId ||
      !Number.isSafeInteger(input.connectAttemptRevision) ||
      input.connectAttemptRevision < 1)
  )
    throw new HTTPException(400, { message: "Invalid connection attempt revision" });
  const permissions = permissionsFor(input.provider, payload);
  if (permissions.some((permission) => !hasPermission(grant.permissions, permission)))
    throw new HTTPException(403, { message: "Provider setup permission required" });
  if (input.integrationKey && input.provider !== "mcp-oauth")
    throw new HTTPException(400, { message: "Invalid provider adapter" });
  if ("returnUrl" in payload && payload.returnUrl && !input.connectAttemptId)
    throw new HTTPException(422, {
      message: "Native provider handoff cannot select a host return URL",
    });
  const policyKey = integrationPolicyKey(input.provider, payload, input.integrationKey);
  await withOrganizationIntegrationAcquisition(deps.db, grant, [policyKey], async () => {});
  const connectionId = connectionIdFor(payload);
  const existing = connectionId
    ? await getConnectionMetadata(
        deps.db,
        grant.workspaceId,
        connectionId,
        input.provider === "fiken" ? null : grant.subjectId,
      )
    : null;
  if (
    connectionId &&
    (!existing ||
      existing.accountId !== grant.accountId ||
      existing.workspaceId !== grant.workspaceId)
  )
    throw new HTTPException(404, { message: "Connection not found" });
  if (
    existing &&
    input.provider !== "fiken" &&
    existing.subjectId !== grant.subjectId &&
    (requiresPersonalOwner(input.provider) || existing.subjectId !== null)
  )
    throw new HTTPException(403, { message: "Connection belongs to another person" });
  const intent = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    kind: handoffKind,
    version: 2,
    provider: input.provider,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    encryptedPayload: encryptEnvironmentValue(
      requireEnvironmentEncryption(deps.settings),
      JSON.stringify(payload),
    ),
    ...(input.integrationKey ? { integrationKey: input.integrationKey } : {}),
    ...(existing ? { connectionVersion: existing.version } : {}),
    // Fresh Connect attempts begin at revision one; resumable stages bind the
    // exact server-selected revision that will be committed with this URL.
    ...(input.connectAttemptId
      ? {
          connectAttemptId: input.connectAttemptId,
          connectAttemptRevision: input.connectAttemptRevision ?? 1,
        }
      : {}),
  });
  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(grant.workspaceId)}/connections/${input.provider}/oauth/native-start`,
    integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl),
  );
  url.searchParams.set("intent", intent);
  return {
    state: intent,
    authorizationUrl: url.toString(),
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  };
}

/** Separate native browser dispatch, not an agent continuing with cookie-shaped headers. */
export function requireNativeProviderBrowserTransport(context: Context, deps: ApiRouteDeps) {
  if (
    verifiedDelegatedHumanAuthorizationForRequest(context.req.raw) ||
    context.req.header("authorization") ||
    (deps.settings.productAccessMode !== "local" && !context.req.header("cookie"))
  )
    throw new HTTPException(403, { message: "Finish this action in your signed-in browser" });
}

export async function resumeDelegatedNativeProviderStart(
  deps: ApiRouteDeps,
  input: {
    authorization: AccessGrantAuthorization;
    provider: Provider;
    intent: string;
    requestUrl: string;
  },
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  requirePersonPresentRouteAuthorization(input.authorization);
  const grant = input.authorization.grant;
  const parsed = NativeIntent.safeParse(liveState(input.intent, deps));
  if (!parsed.success) throw new HTTPException(403, { message: "Invalid native provider handoff" });
  const intent = parsed.data;
  if (
    intent.provider !== input.provider ||
    intent.accountId !== grant.accountId ||
    intent.workspaceId !== grant.workspaceId ||
    intent.subjectId !== grant.subjectId
  )
    throw new HTTPException(403, {
      message: "Provider handoff belongs to another person or scope",
    });
  const encryptionKey = requireEnvironmentEncryption(deps.settings);
  let payload: ReturnType<typeof payloadFor>;
  try {
    payload = payloadFor(
      intent.provider,
      JSON.parse(decryptEnvironmentValue(encryptionKey, intent.encryptedPayload)),
    );
  } catch {
    throw new HTTPException(403, { message: "Invalid encrypted provider handoff" });
  }
  const connectionId = connectionIdFor(payload);
  const permissions = permissionsFor(intent.provider, payload);
  if (
    JSON.stringify(intent.permissions) !== JSON.stringify(permissions) ||
    permissions.some((permission) => !hasPermission(grant.permissions, permission))
  )
    throw new HTTPException(403, { message: "Provider setup permission changed" });
  if (intent.integrationKey && intent.provider !== "mcp-oauth")
    throw new HTTPException(403, { message: "Invalid provider adapter" });
  if (
    Boolean(connectionId) !== Boolean(intent.connectionVersion) ||
    Boolean(intent.connectAttemptId) !== Boolean(intent.connectAttemptRevision)
  )
    throw new HTTPException(403, { message: "Invalid provider handoff generation" });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
  };
  await requireConnectOwnerAuthority(
    deps.db,
    { ...scope, personalOwnerVerified: true },
    permissions[0]!,
  );
  if (intent.connectAttemptId) {
    const stored = await getConnectAttempt(deps.db, scope, intent.connectAttemptId);
    const providerId =
      intent.provider === "fiken"
        ? "fiken-oauth"
        : intent.provider === "atlassian"
          ? "atlassian"
          : intent.provider === "google-drive" &&
              "capability" in payload &&
              payload.capability === "publish"
            ? "google-drive-publish"
            : intent.provider === "google-drive"
              ? "google-drive-knowledge"
              : intent.provider === "slack-bot"
                ? "slack-bot"
                : intent.provider === "social"
                  ? SocialOAuthStartRequest.parse(payload).provider
                  : intent.provider === "provider-oauth"
                    ? ApiIntegrationOAuthStartRequest.parse(payload).definitionId
                    : (intent.integrationKey ?? "mcp-oauth");
    const ownership =
      intent.provider === "fiken" || intent.provider === "slack-bot"
        ? "workspace"
        : requiresPersonalOwner(intent.provider)
          ? "personal"
          : "ownership" in payload && payload.ownership
            ? payload.ownership
            : stored.attempt.ownership;
    if (
      stored.attempt.providerId !== providerId ||
      stored.attempt.ownership !== ownership ||
      stored.attempt.state !== "requires_user_action" ||
      stored.attempt.revision !== intent.connectAttemptRevision ||
      stored.operationInFlight
    )
      throw new HTTPException(409, { message: "Connection attempt changed" });
    if (
      "returnUrl" in payload &&
      payload.returnUrl !== undefined &&
      stored.returnUrl !== payload.returnUrl
    )
      throw new HTTPException(409, { message: "Connection return destination changed" });
  }
  if (connectionId) {
    const existing = await getConnectionMetadata(
      deps.db,
      grant.workspaceId,
      connectionId,
      intent.provider === "fiken" ? null : grant.subjectId,
    );
    if (
      !existing ||
      existing.accountId !== grant.accountId ||
      existing.workspaceId !== grant.workspaceId ||
      existing.version !== intent.connectionVersion ||
      (intent.provider !== "fiken" &&
        existing.subjectId !== grant.subjectId &&
        (requiresPersonalOwner(intent.provider) || existing.subjectId !== null))
    )
      throw new HTTPException(409, { message: "Connection generation changed" });
  }
  const policyKey = integrationPolicyKey(intent.provider, payload, intent.integrationKey);
  await withOrganizationIntegrationAcquisition(deps.db, scope, [policyKey], async () => {});
  if (
    !(await consumeIntegrationOAuthStateNonce(deps.db, {
      ...scope,
      nonce: intent.nonce,
      expiresAt: new Date(intent.iat * 1000 + oauthStateTtlMs),
      now: new Date(),
    }))
  )
    throw new HTTPException(409, { message: "Native provider handoff already used" });
  const common = {
    ...scope,
    requestUrl: input.requestUrl,
    ...(intent.connectAttemptId ? { connectAttemptId: intent.connectAttemptId } : {}),
  };
  const started =
    intent.provider === "fiken"
      ? await startFikenOAuth(deps, { ...common, payload: FikenOAuthStartRequest.parse(payload) })
      : intent.provider === "google-drive"
        ? await startGoogleDriveOAuth(deps, {
            ...common,
            payload: GoogleDriveOAuthStartRequest.parse(payload),
          })
        : intent.provider === "atlassian"
          ? await startAtlassianOAuth(deps, {
              ...common,
              payload: AtlassianOAuthStartRequest.parse(payload),
            })
          : intent.provider === "slack-bot"
            ? await startSlackBotInstall(deps, {
                ...common,
                ...(connectionId ? { connectionId } : {}),
              })
            : intent.provider === "provider-oauth"
              ? await startApiIntegrationProviderOAuth(deps, {
                  ...common,
                  personalOwnershipAllowed: true,
                  payload: ApiIntegrationOAuthStartRequest.parse(payload),
                })
              : intent.provider === "social"
                ? await startSocialOAuth(deps, {
                    ...common,
                    personalOwnershipAllowed: true,
                    payload: SocialOAuthStartRequest.parse(payload),
                  })
                : await startMcpOAuth(deps, {
                    ...common,
                    personalOwnershipAllowed: true,
                    ...(intent.integrationKey ? { integrationKey: intent.integrationKey } : {}),
                    payload: OAuthStartRequest.parse(payload),
                  });
  if (!started.authorizationUrl)
    throw new HTTPException(503, { message: "Provider browser authorization unavailable" });
  const state = await providerStatePayload(
    intent.provider,
    new URL(started.authorizationUrl).searchParams.get("state") ?? undefined,
    deps,
  );
  if (
    !state ||
    state.nonce === intent.nonce ||
    state.accountId !== grant.accountId ||
    state.workspaceId !== grant.workspaceId ||
    state.subjectId !== grant.subjectId ||
    state.connectAttemptId !== intent.connectAttemptId ||
    state.connectionId !== connectionId ||
    state.connectionVersion !== intent.connectionVersion
  )
    throw new HTTPException(409, {
      message: "Provider consent state no longer matches its handoff",
    });
  return { authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt };
}

/** Display-only failure routing; signed workspace hints never become authority. */
export function nativeProviderCallbackFailureUrl(
  deps: ApiRouteDeps,
  provider: Provider,
  raw: string | undefined,
  requestUrl: string,
): string {
  const failure = oauthStateFailureReturn(deps.settings, raw);
  const base = integrationBaseUrl(deps.settings.publicBaseUrl, requestUrl);
  const url = new URL(
    failure.returnPath,
    provider === "slack-bot" ? base : (deps.settings.webBaseUrl ?? base),
  );
  const flag =
    provider === "google-drive"
      ? "google_drive"
      : provider === "fiken"
        ? "fiken"
        : provider === "atlassian"
          ? "atlassian"
          : provider === "slack-bot"
            ? "slack"
            : provider === "social"
              ? "social_oauth"
              : "integration_oauth";
  url.searchParams.set(flag, "error");
  url.searchParams.set("reason", provider === "slack-bot" ? "http_400" : failure.reason);
  if (provider === "mcp-oauth") url.searchParams.set("stage", "state_verify");
  return provider === "social" ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

/** Return only state admitted for redemption. Unadmitted envelopes must use
 * display-only failure routing, never a lower provider adapter. */
export async function nativeProviderCallbackState(
  context: Context,
  deps: ApiRouteDeps,
  provider: Provider,
  raw: string | undefined,
): Promise<string | undefined> {
  if (
    raw &&
    (verifiedDelegatedHumanAuthorizationForRequest(context.req.raw) ||
      context.req.header("authorization"))
  )
    throw new HTTPException(403, { message: "Finish this action in your signed-in browser" });
  const payload = await providerStatePayload(provider, raw, deps);
  if (!payload) return undefined;
  if (payload.kind === handoffKind)
    throw new HTTPException(403, {
      message: "Provider consent must start in your signed-in browser",
    });
  const parsed = CallbackScope.safeParse(payload);
  if (!parsed.success) return undefined;
  if (
    verifiedDelegatedHumanAuthorizationForRequest(context.req.raw) ||
    context.req.header("authorization")
  )
    throw new HTTPException(403, { message: "Finish this action in your signed-in browser" });
  const scope = parsed.data;
  if (payload.encryptedExternalContinuation !== undefined) {
    try {
      const continuation = ExternalActorContinuation.parse(
        JSON.parse(
          decryptEnvironmentValue(
            requireEnvironmentEncryption(deps.settings),
            String(payload.encryptedExternalContinuation),
          ),
        ),
      );
      await requireConnectOwnerAuthority(
        deps.db,
        { ...scope, externalContinuation: continuation },
        permissionsFor(provider, payload)[0]!,
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(403, { message: "Invalid external provider continuation" });
    }
    return raw;
  }
  requireNativeProviderBrowserTransport(context, deps);
  const binding = NativeCallbackBinding.safeParse(
    liveState(getCookie(context, bindingCookieName(provider, raw!)), deps),
  );
  const required = permissionsFor(provider, payload);
  if (
    !binding.success ||
    binding.data.expiresAt <= Date.now() ||
    binding.data.provider !== provider ||
    binding.data.stateHash !== stateHash(raw!) ||
    binding.data.accountId !== scope.accountId ||
    binding.data.workspaceId !== scope.workspaceId ||
    binding.data.subjectId !== scope.subjectId ||
    JSON.stringify(binding.data.permissions) !== JSON.stringify(required)
  )
    throw new HTTPException(403, {
      message: "Provider callback requires its original browser consent binding",
    });
  const authorization = await requireAccessGrantAuthorization(
    context,
    deps,
    scope.workspaceId,
    required[0]!,
  );
  requirePersonPresentRouteAuthorization(authorization);
  if (
    authorization.grant.accountId !== scope.accountId ||
    authorization.grant.subjectId !== scope.subjectId ||
    required.some((permission) => !hasPermission(authorization.grant.permissions, permission))
  )
    throw new HTTPException(403, {
      message: "Provider callback belongs to another person or scope",
    });
  return raw;
}
