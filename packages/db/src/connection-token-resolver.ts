import {
  environmentsEncryptionKeyBytes,
  type McpServerConnectionRef,
  type Settings,
} from "@opengeni/config";
import type {
  ConnectionCredentialPlacement,
  ConnectionKind,
  ConnectionCredentialsPort,
  ConnectionStatus,
  McpConnectionResourceScope,
  McpCredentialAuthNeededReason,
  McpCredentialsRequest,
  TurnInitiator,
  TurnInitiatorContext,
} from "@opengeni/contracts";
import {
  ConnectionUseAuthoritySnapshot,
  type ConnectionUseAttribution,
  type ConnectionUseAuthorizationResult,
} from "@opengeni/contracts/connection-authority";
import {
  OAUTH_MAX_RESPONSE_BYTES,
  pinnedFetch,
  readResponseJsonBounded,
  undiciFetch,
  validateHttpUrl,
  type DnsLookup,
  type FetchLike,
} from "@opengeni/network";
export { isPrivateAddress } from "@opengeni/network";
import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { encryptEnvironmentValue } from "./environment-crypto";
import type { Database } from "./database";
import type {
  AcceptedConnectionUseContext,
  AcceptedConnectionUseResolution,
} from "./connection-authority";
import { connectionScopeKey } from "./connection-scopes";

const MAX_CREDENTIAL_PLACEMENTS = 32;
const MAX_CREDENTIAL_NAME_BYTES = 256;
const MAX_CREDENTIAL_VALUE_BYTES = 16_384;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const QUERY_NAME_PATTERN = /^[A-Za-z0-9._~-]+$/;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type ConnectionCredentialForBroker = {
  id: string;
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  providerDomain: string;
  kind: ConnectionKind;
  status: ConnectionStatus;
  credential: Record<string, unknown>;
  grantedScopes: string[];
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  version: number;
  /** Immutable execution authority generation; distinct from token refresh version. */
  authorityGeneration?: number;
  metadata: Record<string, unknown>;
};

export type ConnectionCredentialLookupInput = {
  workspaceId: string;
  connectionId?: string;
  providerDomain: string;
  kind?: ConnectionKind;
  subjectId?: string | null;
  allowSubjectOwned?: boolean;
  expectedAuthorityGeneration?: number;
};

export type ConnectionTokenRefreshInput = {
  id: string;
  version: number;
  workspaceId: string;
  credentialEncrypted: string;
  expiresAt: Date | null;
  grantedScopes?: string[];
  lastRefreshAt: Date;
  subjectId?: string | null;
};

export type ConnectionStatusGuard = {
  id: string;
  version: number;
  subjectId?: string | null;
};

export type ResolveConnectionCredentialResult =
  | {
      status: "ok";
      headers: Record<string, string>;
      /** Present when the credential bundle or embedding host supplied explicit placements. */
      placements?: ConnectionCredentialPlacement[];
      connectionId: string;
      /** Exact durable version when the credential came from the local connection store. */
      connectionVersion?: number;
      /** Metadata-only owner attribution from the immediate pre-use fence. */
      connectionUseAttribution?: ConnectionUseAttribution;
      /**
       * Revalidate the exact accepted attempt immediately before one target
       * provider request. Credential lookup/refresh is a separate audited
       * boundary and must not manufacture a provider-request fact by itself.
       */
      authorizeProviderRequest?: () => Promise<boolean>;
      expiresAt?: Date | null;
    }
  | {
      status: "auth_needed";
      reason: McpCredentialAuthNeededReason;
      providerDomain: string;
      provider?: string;
      connectionId?: string;
      scopes?: string[];
      resource?: string;
      selectedResources?: McpConnectionResourceScope[];
      authorizationUrl?: string;
    };
type AuthNeededReason = Extract<
  ResolveConnectionCredentialResult,
  { status: "auth_needed" }
>["reason"];

export type ResolveConnectionCredentialInput = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  toolName?: string;
  /** @deprecated Use toolName. Retained for the API's pre-existing broker call shape. */
  toolId?: string;
  connectionRef: McpServerConnectionRef;
  /** Exact MCP destination whose request would receive the resolved headers. */
  destinationUrl: string;
  /** Defaults to header-only MCP transport. */
  credentialTarget?: "mcp" | "http_api";
  forceRefresh?: boolean;
  /** Exact immutable accepted-work authority; never credential-bearing. */
  connectionUseAuthority?: unknown;
  /** Exact accepted attempt plus one stable physical-provider request id. */
  connectionUseContext?: AcceptedConnectionUseContext;
};

export type HostMcpCredentialResolverContext = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  rootSessionId: string;
  turnId: string;
  attemptId: string | null;
  executionGeneration: number;
  initiator: TurnInitiator;
  initiatorContext: TurnInitiatorContext;
  surface: McpCredentialsRequest["surface"];
  allowOfficialGmailRestDestination?: boolean;
};

export class HostMcpCredentialScopeError extends Error {
  constructor(field: "accountId" | "workspaceId" | "sessionId") {
    super(`host MCP credential ${field} scope mismatch`);
    this.name = "HostMcpCredentialScopeError";
  }
}

export class HostMcpCredentialBindingError extends Error {
  constructor(
    field:
      | "provider"
      | "providerDomain"
      | "connectionId"
      | "scopes"
      | "resource"
      | "selectedResources"
      | "destinationUrl"
      | "credentialPlacements",
  ) {
    super(`host MCP credential ${field} binding mismatch`);
    this.name = "HostMcpCredentialBindingError";
  }
}

const OFFICIAL_GMAIL_MCP_RESOURCE = "https://gmailmcp.googleapis.com/mcp/v1";
const OFFICIAL_GMAIL_REST_HOST = "gmail.googleapis.com";

/**
 * The opt-in Gmail REST adapter reuses the exact OAuth grant created for
 * Google's hosted Gmail MCP while the preview endpoint is unavailable. Keep
 * this exception narrower than ordinary provider-domain binding: HTTPS only,
 * Google's canonical Gmail API host, and the authenticated `users/me` path.
 */
function isOfficialGmailRestDestination(
  destinationUrl: string,
  ref: McpServerConnectionRef,
): boolean {
  if (
    ref.providerDomain.toLowerCase() !== "gmailmcp.googleapis.com" ||
    ref.kind !== "oauth2" ||
    ref.subjectScope !== "subject"
  ) {
    return false;
  }
  const destination = new URL(destinationUrl);
  return (
    destination.protocol === "https:" &&
    destination.hostname.toLowerCase() === OFFICIAL_GMAIL_REST_HOST &&
    (destination.pathname === "/gmail/v1/users/me" ||
      destination.pathname.startsWith("/gmail/v1/users/me/"))
  );
}

/**
 * Adapts the public embedding credential port to the runtime's connection
 * resolver contract. Scope echoes are checked before credential headers can
 * reach a request; the returned object is a fresh copy so a host cannot mutate
 * headers after resolution.
 */
export function buildHostConnectionTokenResolver(
  resolve: NonNullable<ConnectionCredentialsPort["mcpCredentials"]>,
  context: HostMcpCredentialResolverContext,
): (input: ResolveConnectionCredentialInput) => Promise<ResolveConnectionCredentialResult> {
  return async (input) => {
    if (input.workspaceId !== context.workspaceId) {
      throw new HostMcpCredentialScopeError("workspaceId");
    }
    const destinationUrl = canonicalHttpUrl(input.destinationUrl);
    if (
      !destinationUrl ||
      (!destinationHostMatchesProvider(destinationUrl, input.connectionRef.providerDomain) &&
        !(
          context.allowOfficialGmailRestDestination === true &&
          isOfficialGmailRestDestination(destinationUrl, input.connectionRef)
        ))
    ) {
      throw new HostMcpCredentialBindingError("destinationUrl");
    }
    const toolName = input.toolName ?? input.toolId;
    const request: McpCredentialsRequest = {
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      rootSessionId: context.rootSessionId,
      turnId: context.turnId,
      attemptId: context.attemptId,
      executionGeneration: context.executionGeneration,
      initiator: context.initiator,
      initiatorContext: { ...context.initiatorContext },
      surface: context.surface,
      destinationUrl,
      credentialTarget: input.credentialTarget ?? "mcp",
      serverId: input.serverId,
      connectionRef: {
        providerDomain: input.connectionRef.providerDomain,
        ...(input.connectionRef.provider ? { provider: input.connectionRef.provider } : {}),
        ...(input.connectionRef.connectionId
          ? { connectionId: input.connectionRef.connectionId }
          : {}),
        ...(input.connectionRef.kind ? { kind: input.connectionRef.kind } : {}),
        ...(input.connectionRef.scopes ? { scopes: [...input.connectionRef.scopes] } : {}),
        ...(input.connectionRef.resource ? { resource: input.connectionRef.resource } : {}),
        ...(input.connectionRef.selectedResources
          ? { selectedResources: copySelectedResources(input.connectionRef.selectedResources) }
          : {}),
        ...(input.connectionRef.subjectScope
          ? { subjectScope: input.connectionRef.subjectScope }
          : {}),
      },
      forceRefresh: input.forceRefresh === true,
      ...(input.connectionUseAuthority !== undefined
        ? { connectionUseAuthority: input.connectionUseAuthority }
        : {}),
      ...(input.connectionUseContext
        ? { connectionUseRequestId: input.connectionUseContext.physicalRequestId }
        : {}),
      ...(toolName ? { toolName } : {}),
      ...(input.subjectId ? { callerSubjectId: input.subjectId } : {}),
    };
    const result = await resolve(request);
    assertHostMcpCredentialScope(result, context);
    assertHostMcpCredentialBinding(result, input.connectionRef);
    if (result.status === "auth_needed") {
      const authorizationUrl = normalizedAuthorizationUrl(result.authorizationUrl);
      return {
        status: "auth_needed",
        reason: result.reason,
        providerDomain: result.providerDomain,
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.connectionId ? { connectionId: result.connectionId } : {}),
        ...(result.scopes ? { scopes: [...result.scopes] } : {}),
        ...(result.resource ? { resource: result.resource } : {}),
        ...(result.selectedResources
          ? { selectedResources: copySelectedResources(result.selectedResources) }
          : {}),
        ...(authorizationUrl ? { authorizationUrl } : {}),
      };
    }
    if (result.connectionId.length === 0) {
      throw new Error("host MCP credential returned an empty connectionId");
    }
    const explicitPlacements =
      result.placements === undefined
        ? undefined
        : normalizedCredentialPlacements(result.placements);
    const headers = normalizedHostCredentialHeaders(
      result.headers,
      explicitPlacements !== undefined,
    );
    if (explicitPlacements) {
      if (!sameHeaderMap(headers, headerMapForPlacements(explicitPlacements))) {
        throw new HostMcpCredentialBindingError("credentialPlacements");
      }
      if (
        (input.credentialTarget ?? "mcp") !== "http_api" &&
        explicitPlacements.some((placement) => placement.carrier !== "header")
      ) {
        throw new HostMcpCredentialBindingError("credentialPlacements");
      }
    }
    const expiresAt = parseHostCredentialExpiry(result.expiresAt);
    return {
      status: "ok",
      headers,
      ...(explicitPlacements ? { placements: explicitPlacements } : {}),
      connectionId: result.connectionId,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  };
}

function assertHostMcpCredentialBinding(
  result: Awaited<ReturnType<NonNullable<ConnectionCredentialsPort["mcpCredentials"]>>>,
  requested: McpServerConnectionRef,
): void {
  if (result.providerDomain !== requested.providerDomain) {
    throw new HostMcpCredentialBindingError("providerDomain");
  }
  if (result.provider !== requested.provider) {
    throw new HostMcpCredentialBindingError("provider");
  }
  if (requested.connectionId && result.connectionId !== requested.connectionId) {
    throw new HostMcpCredentialBindingError("connectionId");
  }
  if (!sameSelectedResources(result.selectedResources, requested.selectedResources)) {
    throw new HostMcpCredentialBindingError("selectedResources");
  }
  if (result.status === "ok") {
    if (!sameStringSet(result.scopes, requested.scopes)) {
      throw new HostMcpCredentialBindingError("scopes");
    }
    if (result.resource !== requested.resource) {
      throw new HostMcpCredentialBindingError("resource");
    }
  }
}

function sameStringSet(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sameSelectedResources(
  left: McpConnectionResourceScope[] | undefined,
  right: McpConnectionResourceScope[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftKeys = copySelectedResources(left)
    .map((resource) => `${resource.kind}\0${resource.id}`)
    .sort();
  const rightKeys = copySelectedResources(right)
    .map((resource) => `${resource.kind}\0${resource.id}`)
    .sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index])
  );
}

function copySelectedResources(
  resources: McpConnectionResourceScope[],
): McpConnectionResourceScope[] {
  if (resources.length === 0 || resources.length > 256) {
    throw new Error("host MCP credential returned an invalid selected resource count");
  }
  const seen = new Set<string>();
  return resources.map((resource) => {
    if (
      resource.kind !== "repository" ||
      typeof resource.id !== "string" ||
      resource.id.length === 0 ||
      resource.id.length > 512
    ) {
      throw new Error("host MCP credential returned an invalid selected resource");
    }
    const key = `${resource.kind}\0${resource.id}`;
    if (seen.has(key)) {
      throw new Error("host MCP credential returned duplicate selected resources");
    }
    seen.add(key);
    return { kind: resource.kind, id: resource.id };
  });
}

function assertHostMcpCredentialScope(
  result: { accountId: string; workspaceId: string; sessionId: string },
  context: HostMcpCredentialResolverContext,
): void {
  for (const field of ["accountId", "workspaceId", "sessionId"] as const) {
    if (result[field] !== context[field]) {
      throw new HostMcpCredentialScopeError(field);
    }
  }
}

function normalizedHostCredentialHeaders(
  headers: Record<string, string>,
  allowEmpty = false,
): Record<string, string> {
  const entries = Object.entries(headers);
  if ((!allowEmpty && entries.length === 0) || entries.length > 32) {
    throw new Error("host MCP credential returned an invalid header count");
  }
  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      name.length > 256 ||
      !HEADER_NAME_PATTERN.test(name) ||
      value.length === 0 ||
      value.length > 16_384 ||
      /[\r\n\0]/.test(value) ||
      FORBIDDEN_CREDENTIAL_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase().startsWith("sec-")
    ) {
      throw new Error("host MCP credential returned an invalid header");
    }
    if (Object.keys(normalized).some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      throw new Error("host MCP credential returned duplicate headers");
    }
    normalized[name] = value;
  }
  return normalized;
}

function normalizedCredentialPlacements(value: unknown): ConnectionCredentialPlacement[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CREDENTIAL_PLACEMENTS) {
    throw new Error("connection credential returned an invalid placement count");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("connection credential returned an invalid placement");
    }
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => key !== "carrier" && key !== "name" && key !== "value" && key !== "prefix",
      )
    ) {
      throw new Error("connection credential returned an invalid placement");
    }
    const carrier = record.carrier;
    const name = record.name;
    const credentialValue = record.value;
    const prefix = record.prefix;
    if (
      (carrier !== "header" && carrier !== "query" && carrier !== "cookie") ||
      typeof name !== "string" ||
      name.length === 0 ||
      Buffer.byteLength(name) > MAX_CREDENTIAL_NAME_BYTES ||
      typeof credentialValue !== "string" ||
      credentialValue.length === 0 ||
      (typeof prefix !== "undefined" && typeof prefix !== "string") ||
      /[\r\n\0]/.test(name) ||
      /[\r\n\0]/.test(credentialValue) ||
      (typeof prefix === "string" && /[\r\n\0]/.test(prefix)) ||
      Buffer.byteLength(`${typeof prefix === "string" ? prefix : ""}${credentialValue}`) >
        MAX_CREDENTIAL_VALUE_BYTES
    ) {
      throw new Error("connection credential returned an invalid placement");
    }
    const normalizedName = carrier === "header" ? name.toLowerCase() : name;
    if (
      (carrier === "header" &&
        (!HEADER_NAME_PATTERN.test(name) ||
          FORBIDDEN_CREDENTIAL_HEADERS.has(normalizedName) ||
          normalizedName.startsWith("sec-"))) ||
      (carrier === "query" && !QUERY_NAME_PATTERN.test(name)) ||
      (carrier === "cookie" &&
        (!COOKIE_NAME_PATTERN.test(name) || /;/.test(`${prefix ?? ""}${credentialValue}`)))
    ) {
      throw new Error("connection credential returned an invalid placement");
    }
    const key = `${carrier}\0${normalizedName}`;
    if (seen.has(key)) {
      throw new Error("connection credential returned duplicate placements");
    }
    seen.add(key);
    return {
      carrier,
      name,
      value: credentialValue,
      ...(typeof prefix === "string" && prefix.length > 0 ? { prefix } : {}),
    };
  });
}

function headerMapForPlacements(
  placements: readonly ConnectionCredentialPlacement[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const placement of placements) {
    if (placement.carrier === "header") {
      headers[placement.name] = `${placement.prefix ?? ""}${placement.value}`;
    }
  }
  return headers;
}

function sameHeaderMap(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const canonical = (headers: Readonly<Record<string, string>>) =>
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  const leftEntries = canonical(left);
  const rightEntries = canonical(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([name, value], index) =>
        rightEntries[index]?.[0] === name && rightEntries[index]?.[1] === value,
    )
  );
}

function normalizedAuthorizationUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("host MCP credential returned an invalid authorizationUrl");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("host MCP credential returned an invalid authorizationUrl");
  }
  return url.toString();
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  if (isIP(hostname) !== 4) return false;
  const [first] = hostname.split(".");
  return first === "127";
}

function parseHostCredentialExpiry(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("host MCP credential returned an invalid expiresAt");
  }
  return parsed;
}

export type ConnectionBrokerDeps = {
  loadCredential: (
    db: Database,
    settings: Settings,
    input: ConnectionCredentialLookupInput,
  ) => Promise<ConnectionCredentialForBroker | null>;
  recordRefresh: (db: Database, input: ConnectionTokenRefreshInput) => Promise<boolean>;
  setStatus: (
    db: Database,
    workspaceId: string,
    status: ConnectionStatus,
    lastError: string | null,
    guard: ConnectionStatusGuard,
  ) => Promise<boolean>;
  recordUsed: (
    db: Database,
    workspaceId: string,
    connectionId: string,
    subjectId?: string | null,
  ) => Promise<void>;
  refresh: typeof refreshOAuthConnectionCredential;
  encrypt: typeof encryptEnvironmentValue;
  keyBytes: typeof environmentsEncryptionKeyBytes;
  now: () => Date;
  authorizeUse?: (
    db: Database,
    input: { snapshot: unknown },
  ) => Promise<ConnectionUseAuthorizationResult>;
  authorizeAcceptedUse?: (
    db: Database,
    input: AcceptedConnectionUseContext & {
      serverId: string;
      connectionId?: string;
      providerDomain: string;
      connectionKind?: ConnectionKind;
      subjectScope?: "workspace" | "subject";
      ownerSubjectId?: string;
    },
  ) => Promise<AcceptedConnectionUseResolution>;
};

export type PermanentConnectionRefreshFailure = {
  workspaceId: string;
  connectionId: string;
  connectionVersion: number;
  subjectId: string | null;
  providerDomain: string;
  httpStatus: number;
  oauthErrorCode: string | null;
};

export type ConnectionTokenResolverOptions = {
  /** Provider-aware transport override used by local/integration adapters. */
  refreshTransport?: RefreshTransportOptions;
  /**
   * Optional provider adapter for an atomic, metadata-aware permanent refresh
   * transition. Returning true means the adapter owned the transition (even if
   * its CAS lost to newer truth); false falls back to generic needs_reauth.
   */
  transitionPermanentRefreshFailure?: (
    failure: PermanentConnectionRefreshFailure,
  ) => Promise<boolean>;
};

export type RefreshTransportOptions = {
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookup;
};

const inflight = new Map<string, Promise<ConnectionCredentialForBroker>>();
const REFRESH_WINDOW_MS = 60_000;
const CONNECTION_REFRESH_TIMEOUT_MS = 10_000;

export function buildConnectionTokenResolver(
  db: Database,
  settings: Settings,
  deps: ConnectionBrokerDeps,
  options: ConnectionTokenResolverOptions = {},
): (input: ResolveConnectionCredentialInput) => Promise<ResolveConnectionCredentialResult> {
  type CredentialLookupInput = Pick<
    ResolveConnectionCredentialInput,
    "workspaceId" | "connectionRef" | "subjectId"
  > & { expectedAuthorityGeneration?: number };
  const load = async (
    input: CredentialLookupInput,
  ): Promise<ConnectionCredentialForBroker | null> => {
    const subjectOwned = input.connectionRef.subjectScope === "subject";
    if (subjectOwned && !input.subjectId) {
      return null;
    }
    const request: ConnectionCredentialLookupInput = {
      workspaceId: input.workspaceId,
      providerDomain: input.connectionRef.providerDomain,
      allowSubjectOwned: subjectOwned,
      ...(subjectOwned ? { subjectId: input.subjectId! } : {}),
      ...(input.expectedAuthorityGeneration !== undefined
        ? { expectedAuthorityGeneration: input.expectedAuthorityGeneration }
        : {}),
    };
    if (input.connectionRef.connectionId !== undefined) {
      request.connectionId = input.connectionRef.connectionId;
    }
    if (input.connectionRef.kind !== undefined) {
      request.kind = input.connectionRef.kind;
    }
    const credential = await deps.loadCredential(db, settings, request);
    if (!credential) return null;
    if (
      input.expectedAuthorityGeneration !== undefined &&
      credential.authorityGeneration !== input.expectedAuthorityGeneration
    ) {
      return null;
    }
    if (subjectOwned) {
      return credential.subjectId === input.subjectId ? credential : null;
    }
    return credential.subjectId === null ? credential : null;
  };

  const snapshot = async (
    cred: ConnectionCredentialForBroker,
    ref: McpServerConnectionRef,
    destinationUrl: string,
    inputCredentialTarget: "mcp" | "http_api",
    connectionUseAttribution?: ConnectionUseAttribution,
  ): Promise<ResolveConnectionCredentialResult> => {
    if (cred.status !== "active") {
      return authNeededForStatus(cred, ref);
    }
    if (!connectionBindingMatches(cred, ref, destinationUrl, settings.gmailRestAdapterEnabled)) {
      return authNeeded(ref, "missing_connection", cred.id);
    }
    const missingScopes = missingRequestedScopes(
      ref.scopes,
      cred.grantedScopes,
      cred.providerDomain,
    );
    if (missingScopes.length > 0) {
      return {
        status: "auth_needed",
        reason: "insufficient_scope",
        providerDomain: ref.providerDomain,
        ...(ref.provider ? { provider: ref.provider } : {}),
        connectionId: cred.id,
        scopes: missingScopes,
        ...(ref.resource ? { resource: ref.resource } : {}),
        ...(ref.selectedResources
          ? { selectedResources: copySelectedResources(ref.selectedResources) }
          : {}),
      };
    }
    const material = credentialMaterialForConnection(cred, inputCredentialTarget);
    if (material.status !== "ok") {
      return {
        status: "auth_needed",
        reason: material.status === "unsupported" ? "unsupported_auth" : "refresh_failed",
        providerDomain: ref.providerDomain,
        ...(ref.provider ? { provider: ref.provider } : {}),
        connectionId: cred.id,
        ...(ref.scopes ? { scopes: ref.scopes } : {}),
        ...(ref.resource ? { resource: ref.resource } : {}),
        ...(ref.selectedResources
          ? { selectedResources: copySelectedResources(ref.selectedResources) }
          : {}),
      };
    }
    await deps.recordUsed(db, cred.workspaceId, cred.id, cred.subjectId);
    return {
      status: "ok",
      headers: material.headers,
      ...(material.placements ? { placements: material.placements } : {}),
      connectionId: cred.id,
      connectionVersion: cred.version,
      ...(connectionUseAttribution ? { connectionUseAttribution } : {}),
      expiresAt: cred.expiresAt,
    };
  };

  const performRefresh = async (
    cred: ConnectionCredentialForBroker,
    ref: McpServerConnectionRef,
  ): Promise<ConnectionCredentialForBroker> => {
    const key = deps.keyBytes(settings);
    if (!key) {
      throw new Error("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured");
    }
    const refreshed = await deps.refresh(cred, ref, settings, options.refreshTransport);
    const refreshRecord: ConnectionTokenRefreshInput = {
      id: cred.id,
      version: cred.version,
      workspaceId: cred.workspaceId,
      credentialEncrypted: deps.encrypt(key, JSON.stringify(refreshed.credential)),
      expiresAt: refreshed.expiresAt,
      lastRefreshAt: deps.now(),
      subjectId: cred.subjectId,
    };
    if (refreshed.grantedScopes !== undefined) {
      refreshRecord.grantedScopes = refreshed.grantedScopes;
    }
    const persisted = await deps.recordRefresh(db, refreshRecord);
    if (persisted) {
      const current = await load({
        workspaceId: cred.workspaceId,
        connectionRef: { ...ref, connectionId: cred.id },
        ...(cred.subjectId ? { subjectId: cred.subjectId } : {}),
      });
      if (current) {
        return current;
      }
    }
    const winner = await load({
      workspaceId: cred.workspaceId,
      connectionRef: { ...ref, connectionId: cred.id },
      ...(cred.subjectId ? { subjectId: cred.subjectId } : {}),
    });
    if (winner?.status === "active") {
      return winner;
    }
    throw new Error("connection credential changed during token refresh");
  };

  const refreshSingleFlight = (
    cred: ConnectionCredentialForBroker,
    ref: McpServerConnectionRef,
  ): Promise<ConnectionCredentialForBroker> => {
    const key = `${cred.subjectId ?? "workspace"}:${cred.id}:${cred.version}`;
    const existing = inflight.get(key);
    if (existing) {
      return existing;
    }
    const promise = performRefresh(cred, ref).finally(() => {
      if (inflight.get(key) === promise) {
        inflight.delete(key);
      }
    });
    inflight.set(key, promise);
    return promise;
  };

  return async (input) => {
    let ref = input.connectionRef;
    let subjectId = input.subjectId;
    let credentialWorkspaceId = input.workspaceId;
    let expectedAuthorityGeneration: number | undefined;
    let connectionUseAttribution: ConnectionUseAttribution | undefined;
    // Repository-scoped provider bindings require a broker that can prove the
    // selected-resource boundary. The generic standalone credential store has
    // no provider-specific containment adapter, so it must fail closed instead
    // of handing an account-wide token to the configured endpoint.
    if (ref.selectedResources) {
      return authNeeded(ref, "resource_scope_unavailable", ref.connectionId);
    }
    if (input.connectionUseContext !== undefined) {
      if (!deps.authorizeAcceptedUse) {
        return authNeeded(
          ref,
          ref.subjectScope === "subject" ? "personal_authority_unavailable" : "missing_connection",
          ref.connectionId,
        );
      }
      const authorization = await deps.authorizeAcceptedUse(db, {
        ...input.connectionUseContext,
        serverId: input.serverId,
        ...(ref.connectionId ? { connectionId: ref.connectionId } : {}),
        providerDomain: ref.providerDomain,
        ...(ref.kind ? { connectionKind: ref.kind } : {}),
        subjectScope: ref.subjectScope === "subject" ? "subject" : "workspace",
        // An owner binding belongs only to the personal lanes. Interactive
        // turns stamp the initiating human's subjectId on every credential
        // request regardless of ref scope; forwarding it for a workspace ref
        // would make the 0279 workspace lane deny the ambient shared row.
        ...(ref.subjectScope === "subject" && subjectId ? { ownerSubjectId: subjectId } : {}),
      });
      if (authorization.status === "denied") {
        return authNeeded(
          ref,
          ref.subjectScope === "subject" ? "personal_authority_unavailable" : "missing_connection",
          ref.connectionId,
        );
      }
      connectionUseAttribution = authorization.attribution;
      expectedAuthorityGeneration = authorization.attribution.connectionGeneration;
      const expectedPersonal = authorization.attribution.scope !== "workspace";
      credentialWorkspaceId = authorization.originWorkspaceId;
      subjectId = authorization.attribution.ownerSubjectId ?? undefined;
      ref = {
        ...ref,
        connectionId: authorization.attribution.connectionId,
        kind: authorization.connectionKind,
        subjectScope: expectedPersonal ? "subject" : "workspace",
      };
    } else if (input.connectionUseAuthority !== undefined) {
      const authority = ConnectionUseAuthoritySnapshot.parse(input.connectionUseAuthority);
      const expectedPersonal = authority.scope === "user";
      if (
        authority.targetWorkspaceId !== input.workspaceId ||
        authority.providerDomain.toLowerCase() !== ref.providerDomain.toLowerCase() ||
        (ref.connectionId !== undefined && ref.connectionId !== authority.connectionId) ||
        (ref.kind !== undefined && ref.kind !== authority.connectionKind) ||
        (ref.subjectScope === "subject") !== expectedPersonal ||
        !deps.authorizeUse
      ) {
        return authNeeded(
          ref,
          expectedPersonal ? "personal_authority_unavailable" : "missing_connection",
          ref.connectionId,
        );
      }
      const authorization = await deps.authorizeUse(db, { snapshot: authority });
      if (authorization.status === "denied") {
        return authNeeded(
          ref,
          expectedPersonal ? "personal_authority_unavailable" : "missing_connection",
          authority.connectionId,
        );
      }
      connectionUseAttribution = authorization.attribution;
      expectedAuthorityGeneration = authority.connectionGeneration;
      // Personal resources are organization-user owned and may originate in a
      // different workspace from the session using them. Authorization is
      // evaluated against the target workspace above; the exact credential is
      // then loaded from its frozen physical origin, never rediscovered in the
      // target workspace.
      credentialWorkspaceId = expectedPersonal
        ? authority.originWorkspaceId
        : authority.targetWorkspaceId;
      subjectId = authority.ownerSubjectId ?? undefined;
      ref = {
        ...ref,
        connectionId: authority.connectionId,
        kind: authority.connectionKind,
        subjectScope: expectedPersonal ? "subject" : "workspace",
      };
    }
    if (ref.subjectScope === "subject" && !subjectId) {
      return authNeeded(ref, "personal_authority_unavailable", ref.connectionId);
    }
    let cred: ConnectionCredentialForBroker | null;
    try {
      cred = await load({
        workspaceId: credentialWorkspaceId,
        connectionRef: ref,
        ...(subjectId ? { subjectId } : {}),
        ...(expectedAuthorityGeneration !== undefined ? { expectedAuthorityGeneration } : {}),
      });
    } catch {
      return authNeeded(ref, "refresh_failed");
    }
    if (!cred) {
      return authNeeded(ref, "missing_connection");
    }
    if (cred.status !== "active") {
      return authNeededForStatus(cred, ref);
    }
    // Reject an audience/destination mismatch before any provider-side refresh
    // or usage update. Refreshing first would still create an unauthorized
    // external side effect even though the token was never sent to the target.
    if (
      !connectionBindingMatches(cred, ref, input.destinationUrl, settings.gmailRestAdapterEnabled)
    ) {
      return authNeeded(ref, "missing_connection", cred.id);
    }
    if (shouldRefresh(cred, input.forceRefresh === true, deps.now())) {
      try {
        cred = await refreshSingleFlight(cred, ref);
      } catch (error) {
        // Only a rejected grant may poison the connection; transient failures
        // (network errors, AS 5xx) leave it active so the next resolve retries.
        if (isPermanentRefreshError(error)) {
          let handled = false;
          if (options.transitionPermanentRefreshFailure) {
            try {
              handled = await options.transitionPermanentRefreshFailure({
                workspaceId: cred.workspaceId,
                connectionId: cred.id,
                connectionVersion: cred.version,
                subjectId: cred.subjectId,
                providerDomain: cred.providerDomain,
                httpStatus: error.httpStatus,
                oauthErrorCode: error.oauthErrorCode,
              });
            } catch {
              handled = false;
            }
          }
          if (!handled) {
            await deps
              .setStatus(db, input.workspaceId, "needs_reauth", error.message, {
                id: cred.id,
                version: cred.version,
                subjectId: cred.subjectId,
              })
              .catch(() => undefined);
          }
        }
        return authNeeded(ref, "refresh_failed", cred.id);
      }
    }
    if (
      expectedAuthorityGeneration !== undefined &&
      cred.authorityGeneration !== expectedAuthorityGeneration
    ) {
      return authNeeded(ref, authorityReasonForScope(ref.subjectScope === "subject"), cred.id);
    }
    return await snapshot(
      cred,
      ref,
      input.destinationUrl,
      input.credentialTarget ?? "mcp",
      connectionUseAttribution,
    );
  };
}

function authorityReasonForScope(personal: boolean): AuthNeededReason {
  return personal ? "personal_authority_unavailable" : "missing_connection";
}

function connectionBindingMatches(
  cred: ConnectionCredentialForBroker,
  ref: McpServerConnectionRef,
  destinationUrl: string,
  gmailRestAdapterEnabled: boolean,
): boolean {
  if (cred.providerDomain.toLowerCase() !== ref.providerDomain.toLowerCase()) return false;
  if (ref.kind && cred.kind !== ref.kind) return false;

  const credential = cred.credential as Record<string, unknown>;
  const metadata = cred.metadata as Record<string, unknown>;
  const boundMcpUrl = stringValue(credential.mcp_url) ?? stringValue(metadata.mcpUrl);
  const destination = canonicalHttpUrl(destinationUrl);
  if (!destination) return false;
  if (boundMcpUrl) {
    const binding = canonicalHttpUrl(boundMcpUrl);
    if (
      !binding ||
      (destination !== binding &&
        !(
          gmailRestAdapterEnabled &&
          binding === canonicalHttpUrl(OFFICIAL_GMAIL_MCP_RESOURCE) &&
          isOfficialGmailRestDestination(destination, ref)
        ))
    ) {
      return false;
    }
  } else if (!destinationHostMatchesProvider(destination, cred.providerDomain)) {
    // Legacy/manual API-key rows may predate mcpUrl metadata. They are still
    // host-bound to their canonical provider domain, never usable as an
    // arbitrary bearer/header source for an unrelated MCP destination.
    return false;
  }
  if (cred.kind !== "oauth2") return true;
  const boundResource = stringValue(credential.resource) ?? stringValue(metadata.resource);
  if (ref.resource) {
    if (!boundResource) return false;
    if (canonicalResource(ref.resource) !== canonicalResource(boundResource)) return false;
  }
  return true;
}

function destinationHostMatchesProvider(destinationUrl: string, providerDomain: string): boolean {
  const destinationHost = new URL(destinationUrl).hostname.toLowerCase();
  const provider = providerDomain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  return (
    Boolean(provider) && (destinationHost === provider || destinationHost.endsWith(`.${provider}`))
  );
}

function canonicalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function canonicalResource(value: string): string {
  return canonicalHttpUrl(value) ?? value.trim();
}

export class ConnectionRefreshHttpError extends Error {
  readonly httpStatus: number;
  readonly oauthErrorCode: string | null;

  constructor(httpStatus: number, oauthErrorCode: string | null = null) {
    super(`connection refresh failed with HTTP ${httpStatus}`);
    this.name = "ConnectionRefreshHttpError";
    this.httpStatus = httpStatus;
    this.oauthErrorCode = oauthErrorCode;
  }
}

// The token endpoint rejecting the grant itself means re-auth is the only way
// forward. 429 (throttling) and 408 are transient despite being 4xx; network
// failures and AS 5xx are likewise retryable.
function isPermanentRefreshError(error: unknown): error is ConnectionRefreshHttpError {
  return (
    error instanceof ConnectionRefreshHttpError &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500 &&
    error.httpStatus !== 408 &&
    error.httpStatus !== 429
  );
}

function shouldRefresh(cred: ConnectionCredentialForBroker, force: boolean, now: Date): boolean {
  if (cred.kind !== "oauth2") {
    return false;
  }
  if (force) {
    return true;
  }
  if (!cred.expiresAt) {
    return false;
  }
  return cred.expiresAt.getTime() <= now.getTime() + REFRESH_WINDOW_MS;
}

function authNeeded(
  ref: McpServerConnectionRef,
  reason: AuthNeededReason,
  connectionId?: string,
): ResolveConnectionCredentialResult {
  return {
    status: "auth_needed",
    reason,
    providerDomain: ref.providerDomain,
    ...(ref.provider ? { provider: ref.provider } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(ref.scopes ? { scopes: ref.scopes } : {}),
    ...(ref.resource ? { resource: ref.resource } : {}),
    ...(ref.selectedResources
      ? { selectedResources: copySelectedResources(ref.selectedResources) }
      : {}),
  };
}

function authNeededForStatus(
  cred: ConnectionCredentialForBroker,
  ref: McpServerConnectionRef,
): ResolveConnectionCredentialResult {
  if (cred.status === "revoked") {
    return authNeeded(ref, "missing_connection", cred.id);
  }
  return authNeeded(
    ref,
    cred.expiresAt && cred.expiresAt.getTime() <= Date.now() ? "expired" : "refresh_failed",
    cred.id,
  );
}

function missingRequestedScopes(
  requested: string[] | undefined,
  granted: string[],
  providerDomain: string,
): string[] {
  if (!requested?.length) {
    return [];
  }
  const grantedSet = new Set(granted.map((scope) => connectionScopeKey(providerDomain, scope)));
  return requested.filter((scope) => !grantedSet.has(connectionScopeKey(providerDomain, scope)));
}

/**
 * Normalizes an OAuth token_type into the Authorization scheme to send. RFC 6750
 * says the scheme is case-insensitive, but some MCP servers (e.g. Linear) reject
 * a lowercase `bearer` — so a `bearer`/`BEARER` (or absent) token_type is sent as
 * the canonical `Bearer`. A non-bearer scheme is passed through unchanged.
 */
export function normalizeBearerScheme(tokenType: string | null | undefined): string {
  return !tokenType || /^bearer$/i.test(tokenType) ? "Bearer" : tokenType;
}

type ConnectionCredentialMaterial =
  | {
      status: "ok";
      headers: Record<string, string>;
      placements?: ConnectionCredentialPlacement[];
    }
  | { status: "invalid" | "unsupported" };

function credentialMaterialForConnection(
  cred: ConnectionCredentialForBroker,
  target: "mcp" | "http_api",
): ConnectionCredentialMaterial {
  if (cred.kind === "oauth2") {
    const accessToken = stringValue((cred.credential as { access_token?: unknown }).access_token);
    if (!accessToken) {
      return { status: "invalid" };
    }
    return {
      status: "ok",
      headers: {
        authorization: `${normalizeBearerScheme(stringValue((cred.credential as { token_type?: unknown }).token_type))} ${accessToken}`,
      },
    };
  }
  const rawPlacements = (cred.credential as { placements?: unknown }).placements;
  if (rawPlacements !== undefined) {
    let placements: ConnectionCredentialPlacement[];
    try {
      placements = normalizedCredentialPlacements(rawPlacements);
    } catch {
      return { status: "invalid" };
    }
    if (target !== "http_api" && placements.some((placement) => placement.carrier !== "header")) {
      return { status: "unsupported" };
    }
    return {
      status: "ok",
      headers: headerMapForPlacements(placements),
      placements,
    };
  }
  try {
    const headers = normalizedHostCredentialHeaders(
      stringRecord((cred.credential as { headers?: unknown }).headers) ?? {},
    );
    return { status: "ok", headers };
  } catch {
    return { status: "invalid" };
  }
}

export async function refreshOAuthConnectionCredential(
  cred: ConnectionCredentialForBroker,
  ref: McpServerConnectionRef,
  settings: Settings,
  transportOptions: RefreshTransportOptions = {},
): Promise<{
  credential: Record<string, unknown>;
  expiresAt: Date | null;
  grantedScopes?: string[];
}> {
  if (cred.kind !== "oauth2") {
    return {
      credential: cred.credential,
      expiresAt: cred.expiresAt,
      grantedScopes: cred.grantedScopes,
    };
  }
  const refreshToken = stringValue((cred.credential as { refresh_token?: unknown }).refresh_token);
  const tokenEndpoint =
    stringValue((cred.credential as { token_endpoint?: unknown }).token_endpoint) ??
    stringValue((cred.metadata as { tokenEndpoint?: unknown }).tokenEndpoint) ??
    stringValue((cred.metadata as { token_endpoint?: unknown }).token_endpoint);
  if (!refreshToken || !tokenEndpoint) {
    throw new Error("connection has no refresh token endpoint");
  }
  let validatedTokenEndpoint: string;
  try {
    validatedTokenEndpoint = validateHttpUrl(tokenEndpoint, {
      label: "OAuth refresh token endpoint",
      allowLoopbackHttp: settings.environment === "local" || settings.environment === "test",
    });
  } catch {
    throw new Error("connection has an invalid refresh token endpoint");
  }
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  // Public clients (token_endpoint_auth_method "none") must identify themselves
  // in the token request body (RFC 6749 §3.2.1); grant flows persist the
  // client_id they authorized with into the bundle/metadata.
  const clientId =
    stringValue((cred.credential as { client_id?: unknown }).client_id) ??
    stringValue((cred.metadata as { clientId?: unknown }).clientId) ??
    stringValue((cred.metadata as { client_id?: unknown }).client_id);
  const clientSecret = stringValue((cred.credential as { client_secret?: unknown }).client_secret);
  const authMethod =
    stringValue(
      (cred.credential as { token_endpoint_auth_method?: unknown }).token_endpoint_auth_method,
    ) ?? "none";
  if (clientId) {
    body.set("client_id", clientId);
  }
  const tokenRequestEncoding =
    stringValue(
      (cred.credential as { token_request_encoding?: unknown }).token_request_encoding,
    ) === "json"
      ? "json"
      : "form";
  const headers: Record<string, string> = {
    "content-type":
      tokenRequestEncoding === "json" ? "application/json" : "application/x-www-form-urlencoded",
  };
  if (clientSecret && authMethod === "client_secret_post") {
    body.set("client_secret", clientSecret);
  } else if (clientId && clientSecret && authMethod === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  const resource =
    ref.resource ?? stringValue((cred.credential as { resource?: unknown }).resource);
  const resourceParameterSupported =
    (cred.credential as { resource_parameter_supported?: unknown }).resource_parameter_supported !==
    false;
  if (resource && resourceParameterSupported) {
    body.set("resource", resource);
  }
  if (ref.scopes?.length) {
    body.set("scope", ref.scopes.join(" "));
  }
  const requestBody: BodyInit =
    tokenRequestEncoding === "json" ? JSON.stringify(Object.fromEntries(body.entries())) : body;
  const response = await pinnedFetch(
    validatedTokenEndpoint,
    {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(CONNECTION_REFRESH_TIMEOUT_MS),
    },
    settings,
    {
      fetchImpl: transportOptions.fetchImpl ?? undiciFetch,
      ...(transportOptions.dnsLookup ? { dnsLookup: transportOptions.dnsLookup } : {}),
      label: "OAuth token endpoint",
      requireHttpsOutsideLocalTest: true,
    },
  );
  if (response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    throw new ConnectionRefreshHttpError(response.status);
  }
  if (!response.ok) {
    throw new ConnectionRefreshHttpError(
      response.status,
      await readOAuthRefreshErrorCode(response),
    );
  }
  const payload = await readResponseJsonBounded<Record<string, unknown>>(
    response,
    OAUTH_MAX_RESPONSE_BYTES,
    "OAuth refresh token response",
  );
  const accessToken = stringValue(payload.access_token);
  if (!accessToken) {
    throw new Error("connection refresh response did not include access_token");
  }
  const expiresAt = expiresAtFromTokenResponse(payload, cred.expiresAt);
  const scopeText = stringValue(payload.scope);
  const nextCredential = {
    ...cred.credential,
    access_token: accessToken,
    refresh_token: stringValue(payload.refresh_token) ?? refreshToken,
    token_type:
      stringValue(payload.token_type) ??
      stringValue((cred.credential as { token_type?: unknown }).token_type) ??
      "Bearer",
    ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
    ...(resource ? { resource } : {}),
    ...(scopeText ? { scope: scopeText } : {}),
    ...(clientSecret
      ? { client_secret: clientSecret, token_endpoint_auth_method: authMethod }
      : {}),
  };
  return {
    credential: nextCredential,
    expiresAt,
    ...(scopeText ? { grantedScopes: scopeText.split(/\s+/).filter(Boolean) } : {}),
  };
}

async function readOAuthRefreshErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = await readResponseJsonBounded<Record<string, unknown>>(
      response,
      OAUTH_MAX_RESPONSE_BYTES,
      "OAuth refresh error response",
    );
    const code = stringValue(payload.error);
    return code && /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : null;
  } catch {
    await cancelResponseBody(response);
    return null;
  }
}

function expiresAtFromTokenResponse(
  payload: Record<string, unknown>,
  fallback: Date | null,
): Date | null {
  const expiresAt = stringValue(payload.expires_at);
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  if (expiresIn && Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }
  return fallback;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      return null;
    }
    out[key] = raw;
  }
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
