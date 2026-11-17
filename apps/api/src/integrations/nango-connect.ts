import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { Settings } from "@opengeni/config";
import {
  NangoClient,
  nangoTagsMatchAttempt,
  nangoAttemptTags,
  nangoToolsIntegrationKeyFromMcpUrl,
  nativeNangoIntegrationForMcpUrl,
  parseNangoAuthWebhook,
  readIdentityField,
  verifyNangoWebhookSignature,
  type EffectiveNangoIntegration,
  type NangoConnectionCredential,
} from "@opengeni/capabilities";
import {
  NANGO_DEFAULT_API_BASE_URL,
  NANGO_DEPLOYMENT_TAG,
  nangoDeploymentTag,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  OAuthStartResponse,
  type ConnectionMetadata,
  type ConnectionOwnership,
} from "@opengeni/contracts";
import {
  connectSetupPermission,
  listOwnConnectionMetadata,
  listPersonNangoConnections,
  nangoBackendsFor,
  nangoAccountLabelOf,
  nangoConnectionIdOf,
  releaseNangoConnections,
  requireConnectOwnerAuthority,
  requireEnvironmentEncryption,
  nangoAccountIdentityKey,
  nangoAccountName,
  shareNangoConnection,
  turnOnOwnLoginHere,
} from "@opengeni/core";
import {
  consumeIntegrationOAuthStateNonce,
  createConnection,
  encryptEnvironmentValue,
  getConnectAttempt,
  isConnectionAccountIdentityConflict,
  listConnectionsMetadata,
  lockNangoPersonIntegration,
  recordNangoUsageEvent,
  revokeConnection,
  setConnectionStatus,
  updateConnection,
  type Database,
} from "@opengeni/db";
import { withOrganizationIntegrationAcquisition } from "@opengeni/db/organization-integration-policy";
import { createSignedState, readSignedState } from "@opengeni/github";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import {
  assertConnectionOwnershipAllowedForPrincipal,
  connectOwnerStateFields,
  personalOwnerStateAccepted,
} from "../connection-ownership";
import { htmlPageContentSecurityPolicy } from "../http/html-page-security";
import {
  callbackReturnPath,
  claimOAuthAcquisition,
  finishOAuthAcquisition,
  INTEGRATIONS_FALLBACK_PATH,
  integrationBaseUrl,
  requireIntegrationsStateSecret,
  workspaceIntegrationsPath,
  type OAuthStartContext,
} from "./oauth-client";
import {
  OAUTH_BROWSER_MISMATCH_MESSAGE,
  oauthCallbackBrowserAccepted,
  oauthStateBrowserBinding,
  type OAuthCallbackBrowser,
  type OAuthStateBrowserBinding,
} from "./oauth-browser-binding";
import { safeReturnPath } from "./oauth-return-path";

/**
 * Nango Connect behind the ordinary Connect card (docs/nango.md).
 *
 * `startMcpOAuth` hands a Nango-backed integration to `startNangoConnect`,
 * whose authorization URL is an Opengeni page. That page opens a Nango connect
 * session for exactly one integration, tagged with this attempt, and runs
 * Nango's Connect UI. Completion is verified server-side: the Nango
 * connection must carry this attempt's tags and integration before it is
 * stored as an ordinary `oauth2` connection whose credential only names the
 * Nango connection. The webhook is a backup finalizer and reports refresh
 * failures and deletions.
 */

type NangoDeps = {
  db: Database;
  settings: Settings;
  fetchImpl?: typeof fetch;
  /** The effective backend switch; defaults to the cached deployment setting. */
  nangoBackends?: () => Promise<ReadonlyMap<string, EffectiveNangoIntegration>>;
};

async function backendsFor(deps: NangoDeps) {
  return deps.nangoBackends
    ? await deps.nangoBackends()
    : await nangoBackendsFor(deps.db, deps.settings);
}

export const NANGO_CONNECT_PATH = "/v1/integrations/nango/connect";
export const NANGO_CONNECT_COMPLETE_PATH = "/v1/integrations/nango/connect/complete";
export const NANGO_WEBHOOK_PATH = "/v1/integrations/nango/webhook";

const ACCOUNT_IDENTITY_KEYS: Record<string, string> = {
  gmail: "gmailEmail",
  "google-calendar": "googleCalendarEmail",
  "google-drive": "googleDriveEmail",
};

function nangoClient(deps: NangoDeps): NangoClient {
  if (!deps.settings.nangoSecretKey)
    throw new HTTPException(503, { message: "Nango is not configured for this deployment" });
  return new NangoClient({
    secretKey: deps.settings.nangoSecretKey,
    baseUrl: deps.settings.nangoApiBaseUrl,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

/** The Nango-backed integration a connect target names right now, if any. */
export async function nangoIntegrationForConnectTarget(
  deps: NangoDeps,
  mcpUrl: string | null | undefined,
): Promise<EffectiveNangoIntegration | null> {
  if (!mcpUrl || !deps.settings.nangoSecretKey) return null;
  const key =
    nativeNangoIntegrationForMcpUrl(mcpUrl)?.integrationKey ??
    nangoToolsIntegrationKeyFromMcpUrl(mcpUrl);
  if (!key) return null;
  return (await backendsFor(deps)).get(key) ?? null;
}

function integrationOwnership(_integration: EffectiveNangoIntegration): ConnectionOwnership {
  // A Nango connection acts as the person who connected it; never a shared account.
  return "personal";
}

function connectMcpUrl(integration: EffectiveNangoIntegration): string {
  return (
    integration.native?.mcpUrl ??
    `https://nango.opengeni.invalid/tools/${integration.integrationKey}`
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type NangoConnectState = {
  kind: "nango_connect";
  accountId: string;
  workspaceId: string;
  subjectId: string;
  personalOwnerVerified: boolean;
  ownership: ConnectionOwnership;
  integrationKey: string;
  providerConfigKey: string;
  providerDomain: string;
  mcpUrl: string;
  returnPath: string;
  returnUrl?: string;
  connectAttemptId?: string;
  encryptedExternalContinuation?: string;
  nonce: string;
  iat: number;
} & Partial<OAuthStateBrowserBinding>;

function text(value: unknown, max = 4096): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

export function readNangoConnectState(settings: Settings, token: string): NangoConnectState {
  const payload = readSignedState(token, requireIntegrationsStateSecret(settings)) as Record<
    string,
    unknown
  > | null;
  if (!payload || payload.kind !== "nango_connect")
    throw new HTTPException(400, { message: "invalid or expired connection state" });
  const required = (key: string) => {
    const value = text(payload[key]);
    if (!value) throw new HTTPException(400, { message: "invalid connection state" });
    return value;
  };
  const ownership = payload.ownership === "workspace" ? "workspace" : "personal";
  const binding = oauthStateBrowserBinding(payload);
  return {
    kind: "nango_connect",
    accountId: required("accountId"),
    workspaceId: required("workspaceId"),
    subjectId: required("subjectId"),
    personalOwnerVerified: payload.personalOwnerVerified === true,
    ownership,
    integrationKey: required("integrationKey"),
    providerConfigKey: required("providerConfigKey"),
    providerDomain: required("providerDomain"),
    mcpUrl: required("mcpUrl"),
    returnPath: safeReturnPath(text(payload.returnPath) ?? INTEGRATIONS_FALLBACK_PATH),
    ...(text(payload.returnUrl) ? { returnUrl: text(payload.returnUrl)! } : {}),
    ...(text(payload.connectAttemptId)
      ? { connectAttemptId: text(payload.connectAttemptId)! }
      : {}),
    ...(text(payload.encryptedExternalContinuation, 16384)
      ? { encryptedExternalContinuation: text(payload.encryptedExternalContinuation, 16384)! }
      : {}),
    nonce: required("nonce"),
    iat: typeof payload.iat === "number" ? payload.iat : 0,
    ...(binding ?? {}),
  };
}

function withDeploymentTag(settings: Settings): Record<string, string> {
  const deployment = nangoDeploymentTag(settings);
  return deployment ? { [NANGO_DEPLOYMENT_TAG]: deployment } : {};
}

function attemptTags(state: NangoConnectState) {
  return {
    accountId: state.accountId,
    workspaceId: state.workspaceId,
    subjectId: state.subjectId,
    attemptId: state.nonce,
    integrationKey: state.integrationKey,
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startNangoConnect(
  deps: NangoDeps,
  context: OAuthStartContext,
  integration: EffectiveNangoIntegration,
): Promise<OAuthStartResponse> {
  const ownership: ConnectionOwnership = integrationOwnership(integration);
  if (context.payload.ownership && context.payload.ownership !== "personal")
    throw new HTTPException(422, {
      message: `${integration.native?.displayName ?? integration.definition.displayName ?? "This integration"} connects only your own account`,
    });
  assertConnectionOwnershipAllowedForPrincipal(ownership, context.personalOwnershipAllowed);
  await withOrganizationIntegrationAcquisition(
    deps.db,
    context,
    [integration.integrationKey],
    async () => {},
  );
  const returnPath = safeReturnPath(
    context.payload.returnPath ?? workspaceIntegrationsPath(context.workspaceId),
  );
  const externalContinuation = context.externalContinuation
    ? ExternalActorContinuation.parse(context.externalContinuation)
    : undefined;
  const state = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    kind: "nango_connect",
    ...connectOwnerStateFields(context, context.personalOwnershipAllowed),
    ownership,
    integrationKey: integration.integrationKey,
    providerConfigKey: integration.providerConfigKey,
    providerDomain: integration.providerDomain,
    mcpUrl: connectMcpUrl(integration),
    returnPath,
    ...(context.payload.returnUrl ? { returnUrl: context.payload.returnUrl } : {}),
    ...(context.connectAttemptId ? { connectAttemptId: context.connectAttemptId } : {}),
    ...(externalContinuation
      ? {
          encryptedExternalContinuation: encryptEnvironmentValue(
            requireEnvironmentEncryption(deps.settings),
            JSON.stringify(externalContinuation),
          ),
        }
      : {}),
    ...context.browserBinding,
  });
  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, context.requestUrl);
  return OAuthStartResponse.parse({
    state,
    authorizationUrl: `${baseUrl}${NANGO_CONNECT_PATH}?state=${encodeURIComponent(state)}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// The hosted page
// ---------------------------------------------------------------------------

function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
}

/**
 * The Nango Connect embedding handshake (as @nangohq/frontend's ConnectUI):
 * the iframe posts `{type:"ready"}`, the page answers with
 * `{type:"session_token", sessionToken}`, and the iframe reports `connect`
 * and `close` events (bare or wrapped as `{type:"event", ev}`). On connect the
 * page finishes with a short backoff; meanwhile a slow, bounded backoff poll
 * covers a missed event until the session expires or the window closes. The
 * webhook remains the backup finalizer.
 */
const PAGE_SCRIPT = `(() => {
  const data = JSON.parse(document.getElementById("nango-connect").textContent);
  const status = document.getElementById("status");
  const frame = document.getElementById("nango-frame");
  let done = false;
  let closed = false;
  let pollTimer = null;
  async function complete(retryConflict) {
    if (done) return true;
    try {
      const response = await fetch(data.completeUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", [data.contractHeader]: data.contractRevision },
        body: JSON.stringify({ state: data.state }),
      });
      const body = await response.json().catch(() => ({}));
      if (body.status === "complete" && typeof body.redirectTo === "string") {
        done = true;
        status.textContent = data.text.done;
        window.location.replace(body.redirectTo);
        return true;
      }
      // 429 and 5xx are retried; so is 409 (the connection changed
      // meanwhile) within the short backoff after connect.
      if (
        !response.ok &&
        !(retryConflict && response.status === 409) &&
        response.status !== 429 &&
        response.status < 500
      ) {
        done = true;
        status.textContent = data.text.failed;
        return true;
      }
    } catch {}
    return false;
  }
  function stopPolling() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }
  async function finishAfterConnect() {
    stopPolling();
    for (const delay of [0, 500, 1000, 2000, 4000, 8000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (await complete(true)) return;
    }
    if (!done) status.textContent = data.text.failed;
  }
  function poll(delay) {
    if (done || closed || Date.now() + delay > data.expiresAtMs) return;
    pollTimer = setTimeout(async () => {
      if (await complete(false)) return;
      poll(Math.min(delay * 2, 30000));
    }, delay);
  }
  window.addEventListener("message", (event) => {
    if (event.origin !== data.connectOrigin || event.source !== frame.contentWindow) return;
    const message = event.data && typeof event.data === "object" ? event.data : null;
    if (!message) return;
    const type = message.type === "event" && message.ev ? message.ev.type : message.type;
    if (type === "ready") {
      frame.contentWindow.postMessage(
        { type: "session_token", sessionToken: data.sessionToken },
        data.connectOrigin,
      );
    } else if (type === "connect") {
      void finishAfterConnect();
    } else if (type === "close") {
      closed = true;
      stopPolling();
      // A connection made just before closing still finishes once.
      void complete(false).then((finished) => {
        if (!finished) status.textContent = data.text.closed;
      });
    }
  });
  poll(5000);
})();`;

const PAGE_STYLE =
  "body{margin:0;font-family:system-ui,sans-serif}iframe{border:0;width:100%;height:calc(100vh - 2.5rem)}p{margin:.75rem 1rem;font-size:.875rem;color:#555}";

export async function nangoConnectPage(
  deps: NangoDeps,
  input: { state: string | undefined; browser: OAuthCallbackBrowser; requestUrl: string },
): Promise<Response> {
  if (!input.state) throw new HTTPException(400, { message: "missing connection state" });
  const state = readNangoConnectState(deps.settings, input.state);
  if (!oauthCallbackBrowserAccepted(state, input.browser))
    throw new HTTPException(403, { message: OAUTH_BROWSER_MISMATCH_MESSAGE });
  // Tags are minted only for an owner the start verified; the webhook relies on it.
  if (!personalOwnerStateAccepted(state))
    throw new HTTPException(422, { message: "This account cannot own a personal connection" });
  const integration = (await backendsFor(deps)).get(state.integrationKey);
  if (!integration || integration.providerConfigKey !== state.providerConfigKey)
    throw new HTTPException(409, {
      message: "This integration is no longer connected through Nango",
    });
  const session = await nangoClient(deps).createConnectSession({
    tags: {
      ...nangoAttemptTags(attemptTags(state)),
      // Only this deployment's sweep may delete the connection.
      ...withDeploymentTag(deps.settings),
    },
    allowedIntegrations: [state.providerConfigKey],
  });
  if (!session.connectLink)
    throw new HTTPException(502, { message: "Nango did not return a connect link" });
  const connectOrigin = new URL(session.connectLink).origin;
  // The session token travels by postMessage, never in the frame URL. A
  // non-default Nango API is named the way ConnectUI names it.
  const frameUrl = new URL(`${connectOrigin}/`);
  const apiBase = (deps.settings.nangoApiBaseUrl ?? NANGO_DEFAULT_API_BASE_URL).replace(
    /\/+$/u,
    "",
  );
  if (apiBase !== NANGO_DEFAULT_API_BASE_URL) frameUrl.searchParams.set("apiURL", apiBase);
  const expiresAtMs = session.expiresAt ? Date.parse(session.expiresAt) : Number.NaN;
  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const data = {
    state: input.state,
    completeUrl: `${baseUrl}${NANGO_CONNECT_COMPLETE_PATH}`,
    // This page is rendered by the deployment that completes it; a page
    // left open across a rollout is refused like any stale client.
    contractHeader: OPENGENI_API_CONTRACT_HEADER,
    contractRevision: OPENGENI_API_CONTRACT_REVISION,
    connectOrigin,
    sessionToken: session.token,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 30 * 60 * 1000,
    text: {
      done: "Connected. You can close this window.",
      failed: "The connection could not be completed. Close this window and try again.",
      closed: "Closed without connecting. Close this window and try again.",
    },
  };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect</title><style>${PAGE_STYLE}</style></head><body><p id="status">Sign in to continue.</p><iframe id="nango-frame" title="Connect" src="${frameUrl.toString().replace(/"/gu, "&quot;")}" allow="clipboard-write"></iframe><script type="application/json" id="nango-connect">${escapeJsonForHtml(data)}</script><script>${PAGE_SCRIPT}</script></body></html>`;
  const policy = `${htmlPageContentSecurityPolicy(html)}; frame-src ${connectOrigin}; connect-src 'self'`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": policy,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export type NangoConnectCompletion =
  | { status: "pending" }
  | { status: "complete"; redirectTo: string; exactReturn: boolean };

type ConnectionIdentity = { label: string | null; metadata: Record<string, unknown> };

/** The account could not be read this time; nothing is decided about it. */
class IdentityReadRetryable extends HTTPException {
  constructor() {
    super(503, { message: "The connected account could not be verified yet. Try again." });
  }
}

/**
 * Stop billing for an attempt's connection that will not be stored, unless a
 * row already stands for it (a replayed page, or the webhook finishing first).
 */
async function releaseAttemptConnection(
  deps: NangoDeps,
  input: { subjectId: string; workspaceId: string; providerConfigKey: string },
  nangoConnectionId: string,
): Promise<void> {
  await releaseNangoConnections(deps, {
    subjectId: input.subjectId,
    providerConfigKey: input.providerConfigKey,
    nangoConnectionIds: [nangoConnectionId],
    knownWorkspaceIds: [input.workspaceId],
    freshAttempt: true,
  }).catch(() => undefined);
}

async function readConnectionIdentity(
  client: NangoClient,
  integration: EffectiveNangoIntegration,
  nangoConnectionId: string,
): Promise<ConnectionIdentity> {
  const identity = integration.native?.accountIdentity ?? integration.definition.accountIdentity;
  if (!identity) return { label: null, metadata: {} };
  // A network error, rate limit or server error says nothing about the
  // account: the attempt is retried and its connection is kept meanwhile.
  const response = await client
    .proxyGet({
      url: identity.url,
      nangoConnectionId,
      providerConfigKey: integration.providerConfigKey,
    })
    .catch(() => {
      throw new IdentityReadRetryable();
    });
  if (response.status === 429 || response.status >= 500) throw new IdentityReadRetryable();
  if (response.status < 200 || response.status >= 300)
    throw new HTTPException(502, { message: "The connected account could not be verified" });
  const label = readIdentityField(response.body, identity.field);
  if (!label)
    throw new HTTPException(502, { message: "The connected account could not be verified" });
  const key = ACCOUNT_IDENTITY_KEYS[integration.integrationKey];
  return { label, metadata: key ? { [key]: label, accountEmail: label } : { accountLabel: label } };
}

/**
 * Best effort: the provider's actual grants, or null to use the app's fixed
 * scopes. `refreshFailed` when Nango could not refresh the connection (424).
 */
async function readGrantedScopes(
  client: NangoClient,
  integration: EffectiveNangoIntegration,
  nangoConnectionId: string,
): Promise<{ scopes: string[] | null; refreshFailed: boolean }> {
  const connection = await client
    .getConnection(nangoConnectionId, integration.providerConfigKey)
    .catch(() => null);
  return {
    scopes: connection?.scopes ?? null,
    refreshFailed: connection?.refreshFailed === true,
  };
}

function nangoMetadata(
  integration: EffectiveNangoIntegration,
  mcpUrl: string,
  nangoConnectionId: string,
  identity: ConnectionIdentity,
): Record<string, unknown> {
  return {
    mcpUrl,
    resource: mcpUrl,
    integrationBackend: "nango",
    nangoIntegrationKey: integration.integrationKey,
    nangoProviderConfigKey: integration.providerConfigKey,
    nangoConnectionId,
    ...identity.metadata,
  };
}

function encryptedNangoCredential(
  settings: Settings,
  integration: EffectiveNangoIntegration,
  nangoConnectionId: string,
): string {
  const credential: NangoConnectionCredential = {
    type: "nango",
    nangoConnectionId,
    providerConfigKey: integration.providerConfigKey,
    integrationKey: integration.integrationKey,
  };
  return encryptEnvironmentValue(
    requireEnvironmentEncryption(settings),
    JSON.stringify(credential),
  );
}

async function ownerConnections(
  db: Database,
  owner: { accountId: string; workspaceId: string; subjectId: string | null },
  providerDomain: string,
): Promise<ConnectionMetadata[]> {
  const all = owner.subjectId
    ? await listOwnConnectionMetadata(db, {
        accountId: owner.accountId,
        workspaceId: owner.workspaceId,
        subjectId: owner.subjectId,
        reach: "anywhere",
        includeInactive: true,
      })
    : (await listConnectionsMetadata(db, owner.workspaceId, null)).filter(
        (connection) => connection.subjectId === null,
      );
  return all.filter(
    (connection) => connection.providerDomain === providerDomain && connection.status !== "revoked",
  );
}

/**
 * Store (or reuse) the Opengeni connection for one verified Nango connection.
 * Idempotent by Nango connection id: the page and the webhook may both finish.
 * Reconnecting the same account replaces its Nango connection in place.
 */
async function persistNangoConnection(
  db: Database,
  settings: Settings,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    ownership: ConnectionOwnership;
    integration: EffectiveNangoIntegration;
    mcpUrl: string;
    nangoConnectionId: string;
    identity: ConnectionIdentity;
    /** Scopes Nango reports for the connection; null when it reports none. */
    grantedScopes: string[] | null;
  },
): Promise<{
  connection: ConnectionMetadata;
  created: boolean;
  replacedNangoConnectionId: string | null;
}> {
  const ownerSubjectId = input.ownership === "personal" ? input.subjectId : null;
  // One writer at a time per person and integration, deployment-wide: the
  // same account connected twice at once still ends in one row here.
  await lockNangoPersonIntegration(db, {
    subjectId: input.subjectId,
    providerConfigKey: input.integration.providerConfigKey,
  });
  const existing = await ownerConnections(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId, subjectId: ownerSubjectId },
    input.integration.providerDomain,
  );
  const same = existing.find(
    (connection) => connection.metadata.nangoConnectionId === input.nangoConnectionId,
  );
  if (same) return { connection: same, created: false, replacedNangoConnectionId: null };
  const metadata = nangoMetadata(
    input.integration,
    input.mcpUrl,
    input.nangoConnectionId,
    input.identity,
  );
  // Only scopes Nango reported are a grant; without the report the stored
  // scopes are the app's defaults, and sharing never treats them as a grant
  // that covers another organization's row.
  if (input.grantedScopes !== null) metadata.nangoScopesConfirmed = true;
  const credentialEncrypted = encryptedNangoCredential(
    settings,
    input.integration,
    input.nangoConnectionId,
  );
  // The scopes the provider granted, as Nango reports them; otherwise the
  // fixed scopes of the integration's app. The reviewed bridges then admit
  // exactly the tools those scopes cover.
  const grantedScopes = [
    ...(input.grantedScopes ??
      input.integration.definition.scopes ??
      input.integration.native?.managedScopes ??
      []),
  ];
  // The same account connected again keeps its connection, settings and
  // grants. Without a verified account identity every connection is a new
  // account: nothing is ever merged on a guess.
  const sameAccounts = input.identity.label
    ? existing.filter((connection) =>
        Object.values(input.identity.metadata).some(
          (value) =>
            typeof value === "string" &&
            nangoAccountName(value) === nangoAccountLabelOf(connection),
        ),
      )
    : [];
  // One live row per owner and verified account, held by the database too.
  const accountIdentityKey = input.identity.label
    ? nangoAccountIdentityKey(input.integration.providerConfigKey, input.identity.label)
    : null;
  // Legacy duplicates of one account (saved before keys) may match several
  // rows; the one already holding the key is the one the database accepts.
  for (const [index, sameAccount] of sameAccounts.entries()) {
    const last = index === sameAccounts.length - 1;
    const update = (savepoint: Database) =>
      updateConnection(savepoint, {
        workspaceId: sameAccount.workspaceId,
        connectionId: sameAccount.id,
        visibleToSubjectId: input.subjectId,
        expectedVersion: sameAccount.version,
        subjectId: ownerSubjectId,
        providerDomain: input.integration.providerDomain,
        kind: "oauth2",
        status: "active",
        credentialEncrypted,
        grantedScopes,
        expiresAt: null,
        metadata,
        accountIdentityKey,
        // Matched on the verified account: a row saved before keys existed is
        // the same account, so accepted work keeps using it.
        previousAccountIdentityKey: accountIdentityKey,
        updatedBySubjectId: input.subjectId,
      });
    let updated: Awaited<ReturnType<typeof update>>;
    try {
      // A savepoint, so a conflict on one duplicate leaves the lock intact.
      updated = await db.transaction(async (savepoint) => update(savepoint as unknown as Database));
    } catch (error) {
      if (!last && isConnectionAccountIdentityConflict(error)) continue;
      alreadyConnected(error);
    }
    if (!updated) throw new HTTPException(409, { message: "connection changed; try again" });
    const previous = sameAccount.metadata.nangoConnectionId;
    return {
      connection: updated,
      created: false,
      replacedNangoConnectionId: typeof previous === "string" ? previous : null,
    };
  }
  const connection = await createConnection(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: ownerSubjectId,
    providerDomain: input.integration.providerDomain,
    kind: "oauth2",
    status: "active",
    credentialEncrypted,
    grantedScopes,
    expiresAt: null,
    metadata,
    accountIdentityKey,
    createdBySubjectId: input.subjectId,
  }).catch(alreadyConnected);
  return { connection, created: true, replacedNangoConnectionId: null };
}

function absoluteRedirect(settings: Settings, redirectTo: string, exact: boolean): string {
  if (exact || !settings.webBaseUrl) return redirectTo;
  return new URL(redirectTo, settings.webBaseUrl).toString();
}

/** A refusal that retrying the same attempt cannot change (authority, policy). */
function refusal(error: unknown): boolean {
  return error instanceof HTTPException && [401, 403, 422].includes(error.status);
}

/** Another live connection of this owner already holds the account. */
function alreadyConnected(error: unknown): never {
  if (isConnectionAccountIdentityConflict(error))
    throw new HTTPException(422, { message: "This account is already connected" });
  throw error;
}

export async function completeNangoConnect(
  deps: NangoDeps,
  input: { state: string; browser: OAuthCallbackBrowser },
): Promise<NangoConnectCompletion> {
  const state = readNangoConnectState(deps.settings, input.state);
  if (!oauthCallbackBrowserAccepted(state, input.browser))
    throw new HTTPException(403, { message: OAUTH_BROWSER_MISMATCH_MESSAGE });
  if (!personalOwnerStateAccepted(state))
    throw new HTTPException(422, { message: "This account cannot own a personal connection" });
  const integration = (await backendsFor(deps)).get(state.integrationKey);
  if (!integration || integration.providerConfigKey !== state.providerConfigKey)
    throw new HTTPException(409, {
      message: "This integration is no longer connected through Nango",
    });
  const client = nangoClient(deps);
  const tags = attemptTags(state);
  // Attempt tags are unique to this connect attempt; the integration is
  // matched here rather than by a Nango query filter.
  const match = (await client.listConnections({ tags: nangoAttemptTags(tags) })).find(
    (connection) =>
      connection.providerConfigKey === state.providerConfigKey &&
      nangoTagsMatchAttempt(connection.tags, tags),
  );
  if (!match) return { status: "pending" };
  let identity: ConnectionIdentity;
  try {
    identity = await readConnectionIdentity(client, integration, match.connectionId);
  } catch (error) {
    // An account we cannot name is never stored; stop its Nango billing too.
    if (!(error instanceof IdentityReadRetryable))
      await releaseAttemptConnection(deps, state, match.connectionId);
    throw error;
  }
  const granted = await readGrantedScopes(client, integration, match.connectionId);
  if (granted.refreshFailed) {
    // Nango cannot refresh this connection: never store it as active.
    await releaseAttemptConnection(deps, state, match.connectionId);
    throw new HTTPException(422, { message: "The account could not be verified. Connect again." });
  }
  const grantedScopes = granted.scopes;
  const success = (connection: ConnectionMetadata): NangoConnectCompletion => {
    if (state.returnUrl && (state.connectAttemptId || state.encryptedExternalContinuation))
      return { status: "complete", redirectTo: state.returnUrl, exactReturn: true };
    return {
      status: "complete",
      exactReturn: false,
      redirectTo: absoluteRedirect(
        deps.settings,
        callbackReturnPath(state.returnPath, "success", {
          connectionId: connection.id,
          providerDomain: connection.providerDomain,
          ownership: state.ownership,
        }),
        false,
      ),
    };
  };
  let outcome: Awaited<ReturnType<typeof persistNangoConnection>> | null = null;
  const persist = async (db: Database) => {
    outcome = await persistNangoConnection(db, deps.settings, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
      ownership: state.ownership,
      integration,
      mcpUrl: state.mcpUrl,
      nangoConnectionId: match.connectionId,
      identity,
      grantedScopes,
    });
    return outcome.connection;
  };
  try {
    if (state.connectAttemptId) {
      const stored = await getConnectAttempt(deps.db, state, state.connectAttemptId);
      if (stored.attempt.ownership !== state.ownership || stored.returnUrl !== state.returnUrl)
        throw new HTTPException(403, { message: "connection attempt mismatch" });
      const permission = connectSetupPermission(stored.attempt);
      const operation = {
        attemptId: state.connectAttemptId,
        operationId: `nango:${state.nonce}`,
        inputDigest: createHash("sha256").update(input.state).digest("hex"),
      };
      const authorize = (
        tx: Database,
        _attempt: unknown,
        origin: ExternalActorContinuation | null,
      ) => requireConnectOwnerAuthority(tx, state, permission, origin);
      const claim = await claimOAuthAcquisition(
        deps.db,
        state,
        { ...operation, expectedRevision: stored.attempt.revision, authorize },
        integration.integrationKey,
      );
      if (claim.status === "replayed")
        return { status: "complete", redirectTo: stored.returnUrl!, exactReturn: true };
      await finishOAuthAcquisition(
        deps.db,
        state,
        {
          ...operation,
          authorize,
          commit: async (tx, current) => {
            const connection = await persist(tx);
            return {
              ...current,
              revision: current.revision + 1,
              state: "complete",
              completionRequirement: "connection",
              credentialsCommitted: true,
              nextAction: { type: "none" },
              account: {
                id: connection.id,
                version: connection.version,
                providerId: current.providerId,
                label: identity.label ?? integration.integrationKey,
                ownership: current.ownership,
                status: "connected",
              },
            };
          },
        },
        integration.integrationKey,
      );
    } else {
      await withOrganizationIntegrationAcquisition(
        deps.db,
        state,
        [integration.integrationKey],
        async (tx) => {
          await requireConnectOwnerAuthority(
            tx,
            state,
            state.ownership === "personal" ? "connections:personal" : "connections:write",
          );
          const done = await persist(tx);
          // One stored connection per verified attempt; a replay reuses it.
          if ((outcome as { created: boolean } | null)?.created)
            await consumeIntegrationOAuthStateNonce(tx, {
              accountId: state.accountId,
              workspaceId: state.workspaceId,
              subjectId: state.subjectId,
              nonce: state.nonce,
              expiresAt: new Date(state.iat * 1000 + 60 * 60 * 1000),
              now: new Date(),
            });
          return done;
        },
      );
    }
  } catch (error) {
    // Refused for good (authority or policy): this attempt's Nango connection
    // is never stored here, so stop its billing unless some row stands for it.
    if (refusal(error))
      await releaseNangoConnections(deps, {
        subjectId: state.subjectId,
        providerConfigKey: state.providerConfigKey,
        nangoConnectionIds: [match.connectionId],
        knownWorkspaceIds: [state.workspaceId],
        freshAttempt: true,
      }).catch(() => undefined);
    throw error;
  }
  const result = outcome as Awaited<ReturnType<typeof persistNangoConnection>> | null;
  if (!result) throw new HTTPException(409, { message: "connection changed; try again" });
  await afterNangoConnectionStored(deps, state, integration, result, match.connectionId);
  return success(result.connection);
}

async function afterNangoConnectionStored(
  deps: NangoDeps,
  owner: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    ownership: ConnectionOwnership;
  },
  integration: EffectiveNangoIntegration,
  result: Awaited<ReturnType<typeof persistNangoConnection>>,
  nangoConnectionId: string,
): Promise<void> {
  if (result.created || result.replacedNangoConnectionId)
    recordNangoUsageEvent(deps.db, {
      accountId: owner.accountId,
      workspaceId: result.connection.workspaceId,
      subjectId: owner.subjectId,
      integrationKey: integration.integrationKey,
      providerConfigKey: integration.providerConfigKey,
      connectionId: result.connection.id,
      nangoConnectionId,
      kind: result.created ? "connection_created" : "connection_reconnected",
    });
  const knownWorkspaceIds = [owner.workspaceId, result.connection.workspaceId];
  // The same account's rows in the person's other organizations now stand
  // for this connection too, and the ones they stood for are deleted. A
  // failure here is repaired by the sweep.
  await shareNangoConnection(deps, {
    subjectId: owner.subjectId,
    providerConfigKey: integration.providerConfigKey,
    accountLabel: nangoAccountLabelOf(result.connection),
    nangoConnectionId,
    grantedScopes: result.connection.grantedScopes,
    knownWorkspaceIds,
  }).catch((error: unknown) =>
    console.warn("[nango] sharing a connection failed; the sweep retries tagged connections", {
      connectionId: result.connection.id,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const replaced = result.replacedNangoConnectionId;
  if (replaced && replaced !== nangoConnectionId) {
    recordNangoUsageEvent(deps.db, {
      accountId: owner.accountId,
      workspaceId: result.connection.workspaceId,
      subjectId: owner.subjectId,
      integrationKey: integration.integrationKey,
      providerConfigKey: integration.providerConfigKey,
      connectionId: result.connection.id,
      nangoConnectionId: replaced,
      kind: "connection_deleted",
    });
    // Deleted in Nango unless another row still stands for it.
    await releaseNangoConnections(deps, {
      subjectId: owner.subjectId,
      providerConfigKey: integration.providerConfigKey,
      nangoConnectionIds: [replaced],
      knownWorkspaceIds,
    }).catch(() => undefined);
  }
  if (owner.ownership === "personal" && result.connection.authorityId)
    await turnOnOwnLoginHere(deps.db, {
      accountId: owner.accountId,
      workspaceId: owner.workspaceId,
      subjectId: owner.subjectId,
      authorityId: result.connection.authorityId,
    }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

/**
 * After an Opengeni Nango connection is removed: delete it in Nango so
 * billing stops, unless the same person's row in another organization still
 * stands for it (then the last one to go deletes it).
 */
export async function deleteNangoConnectionFor(
  deps: NangoDeps,
  connection: ConnectionMetadata,
): Promise<void> {
  const nangoConnectionId = connection.metadata.nangoConnectionId;
  const providerConfigKey = connection.metadata.nangoProviderConfigKey;
  const integrationKey = connection.metadata.nangoIntegrationKey;
  if (
    connection.metadata.integrationBackend !== "nango" ||
    typeof nangoConnectionId !== "string" ||
    typeof providerConfigKey !== "string" ||
    !connection.subjectId ||
    !deps.settings.nangoSecretKey
  )
    return;
  // This organization stops using it either way.
  recordNangoUsageEvent(deps.db, {
    accountId: connection.accountId,
    workspaceId: connection.workspaceId,
    subjectId: connection.subjectId,
    integrationKey: typeof integrationKey === "string" ? integrationKey : "unknown",
    providerConfigKey,
    connectionId: connection.id,
    nangoConnectionId,
    kind: "connection_deleted",
  });
  // A failed deletion of a deployment-tagged connection is retried by the
  // sweep; an untagged (pre-tag) one needs `integrations:nango orphans`.
  await releaseNangoConnections(deps, {
    subjectId: connection.subjectId,
    providerConfigKey,
    nangoConnectionIds: [nangoConnectionId],
    knownWorkspaceIds: [connection.workspaceId],
  }).catch((error: unknown) =>
    console.warn("[nango] connection release failed; the sweep retries tagged connections", {
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export type NangoWebhookOutcome =
  | "ignored"
  | "finalized"
  | "needs_reauth"
  | "recovered"
  | "deleted"
  | "unknown_connection";

export async function handleNangoWebhook(
  deps: NangoDeps,
  input: { rawBody: string; signature: string | null | undefined },
): Promise<NangoWebhookOutcome> {
  const signingKey = deps.settings.nangoWebhookSigningKey;
  if (!deps.settings.nangoSecretKey || !signingKey)
    throw new HTTPException(404, { message: "not found" });
  if (!verifyNangoWebhookSignature(input.rawBody, input.signature, [signingKey]))
    throw new HTTPException(401, { message: "invalid signature" });
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw new HTTPException(400, { message: "invalid webhook body" });
  }
  const event = parseNangoAuthWebhook(payload);
  if (!event) return "ignored";
  const accountId = event.tags.organization_id;
  const workspaceId = event.tags.opengeni_workspace_id;
  const subjectId = event.tags.end_user_id;
  const integrationKey = event.tags.opengeni_integration;
  const attemptId = event.tags.opengeni_attempt_id;
  if (!accountId || !workspaceId || !subjectId || !integrationKey || !attemptId) return "ignored";
  const backends = await backendsFor(deps);
  const integration = backends.get(integrationKey);
  // Attempt tags are minted only after the page verified a signed start for
  // this owner (nangoConnectPage), so they carry that verification.
  const owner = { accountId, workspaceId, subjectId, personalOwnerVerified: true };
  const ownership = integration ? integrationOwnership(integration) : "personal";
  // Every live row of this person, in any organization, that stands for the
  // Nango connection: rows in several organizations may share one.
  const person = await listPersonNangoConnections(deps.db, {
    subjectId,
    providerConfigKey: event.providerConfigKey,
    knownWorkspaceIds: [workspaceId],
  }).catch(() => ({ rows: [] as ConnectionMetadata[], complete: false, readFailed: true }));
  const standing = person.rows.filter(
    (connection) => nangoConnectionIdOf(connection) === event.connectionId,
  );
  // A failed read is not "no row stands for it": answer so Nango retries.
  if (person.readFailed && standing.length === 0 && event.operation !== "creation")
    throw new HTTPException(503, { message: "Connections could not be read; retry" });
  const usage = (
    stored: ConnectionMetadata,
    kind: "connection_needs_reauth" | "connection_deleted" | "connection_reconnected",
  ) =>
    recordNangoUsageEvent(deps.db, {
      accountId: stored.accountId,
      workspaceId: stored.workspaceId,
      subjectId,
      integrationKey,
      providerConfigKey: event.providerConfigKey,
      connectionId: stored.id,
      nangoConnectionId: event.connectionId,
      kind,
    });
  switch (event.operation) {
    case "creation":
    case "override": {
      if (standing.length > 0) return "ignored";
      if (!event.success || !integration) return "unknown_connection";
      if (integration.providerConfigKey !== event.providerConfigKey) return "ignored";
      // Backup finalizer: the page did not finish (closed early). The tags
      // were set by this server for one signed, verified attempt.
      const client = nangoClient(deps);
      const current = await client.getConnection(event.connectionId, integration.providerConfigKey);
      // The webhook's tags are signed by Nango; tags the connection reports
      // now must match too when Nango returns them.
      const tagsMatch =
        current !== null &&
        nangoTagsMatchAttempt(event.tags, { ...owner, attemptId, integrationKey }) &&
        (current.tags === null ||
          nangoTagsMatchAttempt(current.tags, { ...owner, attemptId, integrationKey }));
      if (!current || !tagsMatch) return "unknown_connection";
      // A connection whose token Nango cannot refresh (424) is not stored;
      // the user connects again. Its billing stops now, as on the page.
      const attempt = {
        subjectId,
        workspaceId,
        providerConfigKey: integration.providerConfigKey,
      };
      if (current.refreshFailed) {
        await releaseAttemptConnection(deps, attempt, event.connectionId);
        return "unknown_connection";
      }
      let identity: ConnectionIdentity;
      try {
        identity = await readConnectionIdentity(client, integration, event.connectionId);
      } catch (error) {
        // An account we cannot name is never stored; stop its Nango billing too.
        if (!(error instanceof IdentityReadRetryable))
          await releaseAttemptConnection(deps, attempt, event.connectionId);
        throw error;
      }
      const grantedScopes = current.scopes;
      let outcome: Awaited<ReturnType<typeof persistNangoConnection>> | null = null;
      try {
        await withOrganizationIntegrationAcquisition(
          deps.db,
          owner,
          [integrationKey],
          async (tx) => {
            await requireConnectOwnerAuthority(
              tx,
              owner,
              ownership === "personal" ? "connections:personal" : "connections:write",
            );
            outcome = await persistNangoConnection(tx, deps.settings, {
              ...owner,
              ownership,
              integration,
              mcpUrl: connectMcpUrl(integration),
              nangoConnectionId: event.connectionId,
              identity,
              grantedScopes,
            });
          },
        );
      } catch (error) {
        if (refusal(error))
          await releaseNangoConnections(deps, {
            subjectId,
            providerConfigKey: integration.providerConfigKey,
            nangoConnectionIds: [event.connectionId],
            knownWorkspaceIds: [workspaceId],
            freshAttempt: true,
          }).catch(() => undefined);
        throw error;
      }
      const result = outcome as Awaited<ReturnType<typeof persistNangoConnection>> | null;
      if (result)
        await afterNangoConnectionStored(
          deps,
          { ...owner, ownership },
          integration,
          result,
          event.connectionId,
        );
      return "finalized";
    }
    case "refresh": {
      if (standing.length === 0) return "unknown_connection";
      // A signed webhook can still be replayed or arrive late: act only on
      // what Nango reports now. The list read returns errors without
      // refreshing (GET /connections/{id} would refresh and answer 424).
      const current = (
        await nangoClient(deps).listConnections({ connectionId: event.connectionId })
      ).find(
        (connection) =>
          connection.connectionId === event.connectionId &&
          connection.providerConfigKey === event.providerConfigKey,
      );
      if (!current) return "ignored";
      const failing = current.authErrors > 0;
      let outcome: NangoWebhookOutcome = "ignored";
      for (const stored of standing) {
        if (!event.success && failing && stored.status === "active") {
          if (
            await setConnectionStatus(
              deps.db,
              stored.workspaceId,
              "needs_reauth",
              "nango_refresh_failed",
              { id: stored.id, version: stored.version, subjectId: stored.subjectId },
            )
          )
            usage(stored, "connection_needs_reauth");
          outcome = "needs_reauth";
        } else if (event.success && !failing && stored.status === "needs_reauth") {
          if (
            await setConnectionStatus(deps.db, stored.workspaceId, "active", null, {
              id: stored.id,
              version: stored.version,
              subjectId: stored.subjectId,
            })
          )
            usage(stored, "connection_reconnected");
          outcome = "recovered";
        }
      }
      return outcome;
    }
    case "deletion": {
      if (standing.length === 0) return "unknown_connection";
      // Rows already asking to reconnect keep asking: their connection was
      // deleted because Nango could no longer refresh it.
      let outcome: NangoWebhookOutcome = "ignored";
      for (const stored of standing) {
        if (stored.status === "needs_reauth") continue;
        await revokeConnection(deps.db, stored.workspaceId, stored.id, subjectId, stored.version);
        usage(stored, "connection_deleted");
        outcome = "deleted";
      }
      return outcome;
    }
    default:
      return "ignored";
  }
}
