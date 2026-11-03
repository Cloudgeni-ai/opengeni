import type { Settings } from "@opengeni/config";
import {
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT_TYPE,
  type AutoConnectSupport,
  type OrganizationConnectorAutoConnect,
} from "@opengeni/contracts";
import {
  createConnection,
  encryptEnvironmentValue,
  ensureOrganizationIdentityIssuerKey,
  exchangeIdJag,
  generateOrganizationIdentityKey,
  IdJagExchangeError,
  idJagCredentialBundle,
  listOrganizationConnectorsReachingWorkspace,
  mintOrganizationIdJag,
  organizationConnectorLogin,
  organizationIdentityIssuerUrl,
  organizationIdentityJwksUrl,
  updateConnection,
  type AuthorizeOrganizationConnectorAdministration,
  type Database,
  type OrganizationConnectorRow,
} from "@opengeni/db";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  OAUTH_MAX_RESPONSE_BYTES,
  parseMcpOAuthChallenge,
  pinnedFetch,
  readResponseJsonBounded,
  resolveMcpOAuthDiscovery,
  validateHttpUrl,
  type McpOAuthChallenge,
  type McpOAuthMetadataFetchResult,
} from "@opengeni/network";
import { listOwnConnectionMetadata, turnOnOwnLoginHere } from "./personal-connection-delegations";

/* ----------------------------------------------------------------------------
   MCP auto-connect, outbound: an organization connector whose members are
   connected for them (docs/integrations-design.md, "Auto-connect").

   An admin chooses "Connect everyone automatically" for a remote MCP server
   whose authorization server accepts the JWT bearer grant. Opengeni then
   becomes an identity issuer for the organization: the admin pastes the
   organization's issuer URL into the app's trusted-issuer setting, and from
   then on each member's first use signs an ID-JAG for them and redeems it for
   their own token. If the app refuses, the member can still sign in the usual
   way: the connector keeps its per-person OAuth reference.
   -------------------------------------------------------------------------- */

const PROBE_TIMEOUT_MS = 10_000;
/** Members connected per turn at most, so a turn never waits on many apps. */
const MAX_CONNECTORS_PER_TURN = 4;
/**
 * After an app refuses a member, their turns stop asking it for a while: the
 * usual sign-in prompt stands in, and an admin's fix is picked up soon after.
 */
const TURN_RETRY_AFTER_REFUSAL_MS = 10 * 60_000;
const turnRefusals = new Map<string, number>();
const MAX_REMEMBERED_REFUSALS = 5_000;

function refusalKey(connectorId: string, subjectId: string): string {
  return `${connectorId}\u0000${subjectId}`;
}

function recentlyRefused(connectorId: string, subjectId: string, now: number): boolean {
  const at = turnRefusals.get(refusalKey(connectorId, subjectId));
  if (at === undefined) return false;
  if (now - at < TURN_RETRY_AFTER_REFUSAL_MS) return true;
  turnRefusals.delete(refusalKey(connectorId, subjectId));
  return false;
}

function rememberRefusal(connectorId: string, subjectId: string, now: number): void {
  if (turnRefusals.size >= MAX_REMEMBERED_REFUSALS) {
    const oldest = turnRefusals.keys().next().value;
    if (oldest !== undefined) turnRefusals.delete(oldest);
  }
  turnRefusals.set(refusalKey(connectorId, subjectId), now);
}

/** Tests only. */
export function resetAutoConnectTurnRefusals(): void {
  turnRefusals.clear();
}

export type AutoConnectFetch = typeof fetch;

/** Stored on the connector as `config.autoConnect`. Nothing in it is secret. */
export type StoredAutoConnect = {
  authorizationServerIssuer: string;
  tokenEndpoint: string;
  clientId: string;
  resource: string | null;
  scopes: string[];
  mcpUrl: string;
  verifiedAt: string | null;
  lastError: { message: string; at: string } | null;
};

export type AutoConnectProbe = AutoConnectSupport & {
  setup: Omit<StoredAutoConnect, "clientId" | "verifiedAt" | "lastError"> & {
    clientIdMetadataDocumentSupported: boolean;
  };
};

/** Opengeni's client ID as a Client ID Metadata Document URL. */
export function opengeniClientMetadataDocumentUrl(settings: Settings): string | null {
  return settings.publicBaseUrl
    ? `${new URL(settings.publicBaseUrl).origin}/v1/integrations/oauth/client-metadata.json`
    : null;
}

export function storedAutoConnect(config: Record<string, unknown>): StoredAutoConnect | null {
  const value = config.autoConnect;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : null);
  const issuer = text("authorizationServerIssuer");
  const tokenEndpoint = text("tokenEndpoint");
  const clientId = text("clientId");
  const mcpUrl = text("mcpUrl");
  if (!issuer || !tokenEndpoint || !clientId || !mcpUrl) return null;
  const lastError =
    record.lastError && typeof record.lastError === "object"
      ? (record.lastError as { message?: unknown; at?: unknown })
      : null;
  return {
    authorizationServerIssuer: issuer,
    tokenEndpoint,
    clientId,
    resource: text("resource"),
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    mcpUrl,
    verifiedAt: text("verifiedAt"),
    lastError:
      lastError && typeof lastError.message === "string" && typeof lastError.at === "string"
        ? { message: lastError.message, at: lastError.at }
        : null,
  };
}

/** The connector's auto-connect setup as an admin sees it. */
export function organizationConnectorAutoConnectView(
  settings: Settings,
  row: Pick<OrganizationConnectorRow, "accountId" | "config">,
): OrganizationConnectorAutoConnect | null {
  const stored = storedAutoConnect(row.config);
  if (!stored || !settings.publicBaseUrl) return null;
  return {
    issuer: organizationIdentityIssuerUrl(settings.publicBaseUrl, row.accountId),
    authorizationServer: stored.authorizationServerIssuer,
    clientId: stored.clientId,
    verifiedAt: stored.verifiedAt,
    lastError: stored.lastError,
  };
}

/**
 * Whether a remote MCP server can connect people automatically: its
 * authorization server must accept the JWT bearer grant (ID-JAG redemption).
 * Never throws for the server's answer; the reason says what is missing.
 */
export async function probeMcpAutoConnectSupport(input: {
  settings: Settings;
  endpointUrl: string;
  fetchImpl?: AutoConnectFetch | undefined;
}): Promise<AutoConnectProbe | (AutoConnectSupport & { setup: null })> {
  const unsupported = (reason: string, authorizationServer: string | null = null) => ({
    supported: false,
    authorizationServer,
    reason,
    clientIdMetadataDocumentSupported: false,
    opengeniClientId: null,
    setup: null,
  });
  let challenge: McpOAuthChallenge;
  try {
    challenge = await probeChallenge(input);
  } catch {
    return unsupported("The server couldn't be reached");
  }
  let discovery;
  try {
    discovery = await resolveMcpOAuthDiscovery({
      resourceUrl: input.endpointUrl,
      challenge,
      purpose: "assertion_grant",
      fetchMetadata: ({ url }) => fetchMetadata(input, url),
      validateEndpoint: (url, label) =>
        validateHttpUrl(url, {
          label,
          allowLoopbackHttp: localTest(input.settings),
        }),
      canonicalizeResource: (value) => {
        const url = new URL(value.trim());
        url.hash = "";
        return url.toString();
      },
    });
  } catch {
    return unsupported("The server doesn't use OAuth sign-in");
  }
  const as = discovery.authorizationServerMetadata;
  // An ID-JAG's audience is the issuer exactly as the server spells it.
  const issuer = typeof as.raw.issuer === "string" && as.raw.issuer ? as.raw.issuer : as.issuer;
  const grantTypes = stringArray(as.raw.grant_types_supported);
  const profiles = stringArray(as.raw.authorization_grant_profiles_supported);
  if (!grantTypes.includes(JWT_BEARER_GRANT_TYPE) && !profiles.includes(ID_JAG_GRANT_PROFILE))
    return unsupported("This app doesn't support auto-connect yet", issuer);
  return {
    supported: true,
    authorizationServer: issuer,
    reason: null,
    clientIdMetadataDocumentSupported: as.clientIdMetadataDocumentSupported,
    opengeniClientId: as.clientIdMetadataDocumentSupported
      ? opengeniClientMetadataDocumentUrl(input.settings)
      : null,
    setup: {
      authorizationServerIssuer: issuer,
      tokenEndpoint: as.tokenEndpoint,
      resource: discovery.resource,
      scopes: [...discovery.protectedResourceMetadata.scopesSupported],
      mcpUrl: input.endpointUrl,
      clientIdMetadataDocumentSupported: as.clientIdMetadataDocumentSupported,
    },
  };
}

/**
 * The organization's signing key, created the first time an admin turns
 * auto-connect on for any connector.
 */
export async function ensureOrganizationIdentityIssuer(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  authorize: AuthorizeOrganizationConnectorAdministration;
}) {
  const key = await ensureOrganizationIdentityIssuerKey(
    input.db,
    { accountId: input.accountId },
    () => generateOrganizationIdentityKey(input.settings),
    input.authorize,
  );
  const publicBaseUrl = input.settings.publicBaseUrl!;
  return {
    issuer: organizationIdentityIssuerUrl(publicBaseUrl, input.accountId),
    jwksUri: organizationIdentityJwksUrl(publicBaseUrl, input.accountId),
    clientId: opengeniClientMetadataDocumentUrl(input.settings)!,
    createdAt: key.createdAt.toISOString(),
  };
}

export type AutoConnectAttempt =
  | { status: "connected"; connectionId: string | null }
  | { status: "refused"; message: string; permanent: boolean };

/**
 * Signs an ID-JAG for one member and redeems it at the app, without saving
 * anything: what an admin's Test does.
 */
export async function tryAutoConnect(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  subjectId: string;
  autoConnect: StoredAutoConnect;
  fetchImpl?: AutoConnectFetch | undefined;
}): Promise<
  | { status: "connected"; token: Awaited<ReturnType<typeof exchangeIdJag>> }
  | { status: "refused"; message: string; permanent: boolean }
> {
  let assertion: string;
  try {
    assertion = await mintOrganizationIdJag(input.db, input.settings, {
      accountId: input.accountId,
      subjectId: input.subjectId,
      audience: input.autoConnect.authorizationServerIssuer,
      clientId: input.autoConnect.clientId,
      resource: input.autoConnect.resource,
      scopes: input.autoConnect.scopes,
    });
  } catch (error) {
    return {
      status: "refused",
      message: error instanceof Error ? error.message : "Auto-connect is unavailable",
      permanent: true,
    };
  }
  try {
    const token = await exchangeIdJag(
      input.settings,
      {
        tokenEndpoint: input.autoConnect.tokenEndpoint,
        assertion,
        clientId: input.autoConnect.clientId,
        resource: input.autoConnect.resource,
        scopes: input.autoConnect.scopes,
      },
      input.fetchImpl ? { testFetch: input.fetchImpl } : {},
    );
    return { status: "connected", token };
  } catch (error) {
    if (error instanceof IdJagExchangeError)
      return {
        status: "refused",
        message: error.message,
        permanent: error.httpStatus >= 400 && error.httpStatus < 500,
      };
    throw error;
  }
}

/**
 * Connects one member to an auto-connect connector: signs and redeems an
 * ID-JAG and saves the token as their own login, turned on here. A member
 * who already has a working login to it is left as they are.
 */
export async function connectMemberAutomatically(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  connector: Pick<OrganizationConnectorRow, "id" | "config" | "accountId">;
  fetchImpl?: AutoConnectFetch | undefined;
}): Promise<AutoConnectAttempt> {
  const autoConnect = storedAutoConnect(input.connector.config);
  const ref = connectorRef(input.connector.config);
  if (!autoConnect || !ref)
    return { status: "refused", message: "Auto-connect isn't set up", permanent: true };
  const existing = (
    await listOwnConnectionMetadata(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      reach: "anywhere",
      includeInactive: true,
    })
  ).filter(
    (connection) =>
      connection.providerDomain.toLowerCase() === ref.providerDomain.toLowerCase() &&
      connection.kind === "oauth2" &&
      sameUrl(connection.metadata.mcpUrl, autoConnect.mcpUrl),
  );
  const working = existing.find((connection) => connection.status === "active");
  if (working) {
    if (!working.turnedOnHere && working.authorityId)
      await turnOnOwnLoginHere(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        authorityId: working.authorityId,
      }).catch(() => undefined);
    return { status: "connected", connectionId: working.id };
  }
  const attempt = await tryAutoConnect({ ...input, autoConnect });
  if (attempt.status === "refused") return attempt;
  const key = environmentsEncryptionKeyBytes(input.settings);
  if (!key)
    return {
      status: "refused",
      message: "Credential encryption is not configured",
      permanent: true,
    };
  const credentialEncrypted = encryptEnvironmentValue(
    key,
    JSON.stringify(
      idJagCredentialBundle(
        {
          connector_id: input.connector.id,
          token_endpoint: autoConnect.tokenEndpoint,
          client_id: autoConnect.clientId,
          audience: autoConnect.authorizationServerIssuer,
          ...(autoConnect.resource ? { resource: autoConnect.resource } : {}),
          mcp_url: autoConnect.mcpUrl,
          scopes: autoConnect.scopes,
        },
        attempt.token,
      ),
    ),
  );
  const grantedScopes = attempt.token.scope
    ? attempt.token.scope.split(/[\s,]+/u).filter(Boolean)
    : [...autoConnect.scopes];
  const metadata = {
    resource: autoConnect.resource,
    mcpUrl: autoConnect.mcpUrl,
    authorizationServer: autoConnect.authorizationServerIssuer,
    authorizationServerIssuer: autoConnect.authorizationServerIssuer,
    tokenEndpoint: autoConnect.tokenEndpoint,
    clientId: autoConnect.clientId,
    clientRegistrationMethod: "id_jag",
    autoConnect: true,
  };
  const stale = existing[0];
  const saved = stale
    ? await updateConnection(input.db, {
        workspaceId: stale.workspaceId,
        connectionId: stale.id,
        visibleToSubjectId: input.subjectId,
        expectedVersion: stale.version,
        subjectId: input.subjectId,
        status: "active",
        credentialEncrypted,
        grantedScopes,
        expiresAt: attempt.token.expiresAt,
        metadata: { ...stale.metadata, ...metadata },
        updatedBySubjectId: input.subjectId,
      })
    : await createConnection(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        providerDomain: ref.providerDomain,
        kind: "oauth2",
        status: "active",
        credentialEncrypted,
        grantedScopes,
        expiresAt: attempt.token.expiresAt,
        metadata,
        createdBySubjectId: input.subjectId,
      });
  if (saved?.authorityId)
    await turnOnOwnLoginHere(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      authorityId: saved.authorityId,
    }).catch(() => undefined);
  return { status: "connected", connectionId: saved?.id ?? null };
}

/**
 * Before a person's turn: connects them to each auto-connect connector the
 * turn may use that they have no login to yet. Bounded and best effort: a
 * refusal leaves the connector's usual sign-in prompt in place.
 */
export async function connectAutoConnectLoginsForTurn(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  /** Provider domains of the turn's per-person MCP servers. */
  providerDomains: ReadonlySet<string>;
  fetchImpl?: AutoConnectFetch | undefined;
}): Promise<void> {
  if (input.providerDomains.size === 0 || !input.subjectId.startsWith("user:")) return;
  const now = Date.now();
  let connectors: OrganizationConnectorRow[];
  try {
    const candidates = (
      await listOrganizationConnectorsReachingWorkspace(input.db, input.workspaceId)
    )
      .filter((connector) => organizationConnectorLogin(connector.config) === "auto_connect")
      .filter((connector) => {
        const ref = connectorRef(connector.config);
        return !!ref && input.providerDomains.has(ref.providerDomain.toLowerCase());
      })
      .filter((connector) => !recentlyRefused(connector.id, input.subjectId, now));
    if (candidates.length === 0) return;
    // Apps the person already has a working login to need nothing, so they
    // don't use up this turn's few attempts.
    const working = (
      await listOwnConnectionMetadata(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        reach: "anywhere",
        includeInactive: false,
      })
    ).filter((connection) => connection.kind === "oauth2" && connection.status === "active");
    connectors = autoConnectConnectorsToTry(candidates, working);
  } catch {
    return;
  }
  await Promise.all(
    connectors.map((connector) =>
      connectMemberAutomatically({ ...input, connector })
        .then((attempt) => {
          if (attempt.status === "refused") rememberRefusal(connector.id, input.subjectId, now);
        })
        .catch((error) => {
          rememberRefusal(connector.id, input.subjectId, now);
          console.warn("[auto-connect] could not connect a member automatically", {
            workspaceId: input.workspaceId,
            connectorId: connector.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    ),
  );
}

/**
 * A member's own "Connect" on an auto-connect connector that reaches this
 * workspace: connects them now, or says why the app refused (they can then
 * sign in the usual way).
 */
export async function connectMemberToOrganizationConnector(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  connectorId: string;
  fetchImpl?: AutoConnectFetch | undefined;
}): Promise<AutoConnectAttempt | null> {
  const connector = (
    await listOrganizationConnectorsReachingWorkspace(input.db, input.workspaceId)
  ).find(
    (row) =>
      row.id === input.connectorId && organizationConnectorLogin(row.config) === "auto_connect",
  );
  if (!connector) return null;
  const attempt = await connectMemberAutomatically({ ...input, connector });
  if (attempt.status === "connected")
    turnRefusals.delete(refusalKey(connector.id, input.subjectId));
  return attempt;
}

/**
 * The connectors a turn tries: those the person has no working login to,
 * at most a few. Logins they already have are left out before the limit, so
 * apps later in the list are never starved by ones that need nothing.
 */
export function autoConnectConnectorsToTry<C extends Pick<OrganizationConnectorRow, "config">>(
  candidates: readonly C[],
  working: readonly { providerDomain: string; metadata: { mcpUrl?: unknown } }[],
): C[] {
  return candidates
    .filter((connector) => {
      const ref = connectorRef(connector.config);
      const mcpUrl = storedAutoConnect(connector.config)?.mcpUrl;
      if (!ref || !mcpUrl) return true;
      return !working.some(
        (connection) =>
          connection.providerDomain.toLowerCase() === ref.providerDomain.toLowerCase() &&
          sameUrl(connection.metadata.mcpUrl, mcpUrl),
      );
    })
    .slice(0, MAX_CONNECTORS_PER_TURN);
}

function connectorRef(config: Record<string, unknown>): { providerDomain: string } | null {
  const ref = config.connectionRef;
  if (!ref || typeof ref !== "object") return null;
  const providerDomain = (ref as { providerDomain?: unknown }).providerDomain;
  return typeof providerDomain === "string" && providerDomain ? { providerDomain } : null;
}

function sameUrl(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.toString().replace(/\/$/u, "") === right.toString().replace(/\/$/u, "");
  } catch {
    return a === b;
  }
}

async function probeChallenge(input: {
  settings: Settings;
  endpointUrl: string;
  fetchImpl?: AutoConnectFetch | undefined;
}): Promise<McpOAuthChallenge> {
  const response = await request(input, input.endpointUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "auto-connect-discovery",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Opengeni", version: "1.0" },
      },
    }),
  });
  await response.body?.cancel().catch(() => undefined);
  return parseMcpOAuthChallenge(response.headers.get("www-authenticate"));
}

async function fetchMetadata(
  input: { settings: Settings; fetchImpl?: AutoConnectFetch | undefined },
  url: string,
): Promise<McpOAuthMetadataFetchResult> {
  const response = await request(input, url, { headers: { accept: "application/json" } });
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "absent", url, httpStatus: response.status };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`metadata request failed with HTTP ${response.status}`);
  }
  const document = await readResponseJsonBounded<unknown>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "OAuth metadata",
  );
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error("metadata was not a JSON object");
  return { status: "present", url, document: document as Record<string, unknown> };
}

async function request(
  input: { settings: Settings; fetchImpl?: AutoConnectFetch | undefined },
  url: string,
  init: RequestInit,
): Promise<Response> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  // A test transport answers for any host; production traffic is pinned to
  // public addresses.
  if (input.fetchImpl) return await input.fetchImpl(url, { ...init, redirect: "manual", signal });
  return await pinnedFetch(url, { ...init, redirect: "manual", signal }, input.settings, {
    label: "Auto-connect discovery",
    requireHttpsOutsideLocalTest: true,
  });
}

function localTest(settings: Settings): boolean {
  return settings.environment === "local" || settings.environment === "test";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
