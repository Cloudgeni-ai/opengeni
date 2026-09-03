import { createHash } from "node:crypto";

export type McpOAuthDiscoveryMode = "rfc9728_protected_resource" | "legacy_2025_03_26_metadata";

export type McpOAuthDiscoveryClassification =
  | "oauth_rfc9728"
  | "oauth_legacy_same_origin_metadata"
  | "oauth_legacy_default_endpoints_unverified"
  | "oauth_requires_profile"
  | "oauth_discovery_broken";

export type McpOAuthChallenge = {
  scheme: "bearer" | "oauth" | null;
  resourceMetadata?: string;
  scope: string[];
  error?: string;
};

export type McpProtectedResourceMetadata = {
  resource?: string;
  authorizationServers: string[];
  scopesSupported: string[];
  raw: Record<string, unknown>;
  metadataUrl: string;
};

export type McpAuthorizationServerMetadata = {
  issuer: string;
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientIdMetadataDocumentSupported: boolean;
  tokenEndpointAuthMethodsSupported: string[];
  codeChallengeMethodsSupported: string[];
  raw: Record<string, unknown>;
  metadataUrl: string;
};

export type McpOAuthMetadataKind = "protected_resource" | "authorization_server";

export type McpOAuthMetadataFetchResult =
  | {
      status: "present";
      url: string;
      document: Record<string, unknown>;
    }
  | {
      status: "absent";
      url: string;
      httpStatus: 404 | 410;
    };

export type McpOAuthDiscoveryResult = {
  mode: McpOAuthDiscoveryMode;
  classification: Extract<
    McpOAuthDiscoveryClassification,
    "oauth_rfc9728" | "oauth_legacy_same_origin_metadata"
  >;
  challenge: McpOAuthChallenge;
  resource: string;
  protectedResourceMetadata: McpProtectedResourceMetadata;
  authorizationServerMetadata: McpAuthorizationServerMetadata;
  provenance: {
    protectedResourceMetadataUrl: string | null;
    authorizationServerMetadataUrl: string;
    metadataSha256: string;
  };
};

export class McpOAuthDiscoveryError extends Error {
  constructor(
    readonly stage: "protected_resource_metadata" | "authorization_server_metadata",
    readonly classification: Exclude<
      McpOAuthDiscoveryClassification,
      "oauth_rfc9728" | "oauth_legacy_same_origin_metadata"
    >,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "McpOAuthDiscoveryError";
  }
}

export type ResolveMcpOAuthDiscoveryInput = {
  resourceUrl: string;
  challenge: McpOAuthChallenge;
  fetchMetadata: (input: {
    kind: McpOAuthMetadataKind;
    url: string;
  }) => Promise<McpOAuthMetadataFetchResult>;
  validateEndpoint: (rawUrl: string, label: string) => string;
  canonicalizeResource: (rawResource: string) => string;
};

/**
 * Resolve modern MCP OAuth discovery first, with the 2025-03-26 same-origin
 * metadata profile as a narrowly bounded compatibility fallback.
 *
 * Only an explicit 404/410 result is absence. Callers must throw for network,
 * redirect, destination-policy, body, JSON, and other HTTP failures so none of
 * those failures can silently downgrade a server to the legacy profile.
 */
export async function resolveMcpOAuthDiscovery(
  input: ResolveMcpOAuthDiscoveryInput,
): Promise<McpOAuthDiscoveryResult> {
  const prmCandidates = protectedResourceMetadataCandidates(
    input.resourceUrl,
    input.challenge.resourceMetadata,
  );
  let prmDocument: (McpOAuthMetadataFetchResult & { status: "present" }) | null = null;
  for (const candidate of prmCandidates) {
    const fetched = await input.fetchMetadata({ kind: "protected_resource", url: candidate });
    if (fetched.status === "absent") continue;
    prmDocument = fetched;
    break;
  }

  if (prmDocument) {
    const prm = parseProtectedResourceMetadata(prmDocument, input);
    const authorizationServer = prm.authorizationServers[0]!;
    const as = await discoverAuthorizationServerMetadata(authorizationServer, "modern", input);
    return discoveryResult({
      mode: "rfc9728_protected_resource",
      classification: "oauth_rfc9728",
      challenge: input.challenge,
      resource: prm.resource ?? input.canonicalizeResource(input.resourceUrl),
      prm,
      as,
    });
  }

  if (input.challenge.resourceMetadata) {
    throw new McpOAuthDiscoveryError(
      "protected_resource_metadata",
      "oauth_discovery_broken",
      "MCP advertised protected resource metadata, but no metadata document was found",
    );
  }
  if (!input.challenge.scheme) {
    throw new McpOAuthDiscoveryError(
      "protected_resource_metadata",
      "oauth_discovery_broken",
      "MCP protected resource metadata was absent and the server returned no Bearer/OAuth challenge",
    );
  }

  const resource = input.canonicalizeResource(input.resourceUrl);
  const resourceOrigin = new URL(resource).origin;
  const as = await discoverAuthorizationServerMetadata(resourceOrigin, "legacy", input);
  if (new URL(as.issuer).origin !== resourceOrigin) {
    throw new McpOAuthDiscoveryError(
      "authorization_server_metadata",
      "oauth_requires_profile",
      "legacy MCP OAuth discovery requires the authorization server issuer to share the MCP server origin",
    );
  }
  const syntheticPrm: McpProtectedResourceMetadata = {
    resource,
    authorizationServers: [as.issuer],
    scopesSupported: [...input.challenge.scope],
    raw: {
      resource,
      authorization_servers: [as.issuer],
      scopes_supported: [...input.challenge.scope],
    },
    metadataUrl: "",
  };
  return discoveryResult({
    mode: "legacy_2025_03_26_metadata",
    classification: "oauth_legacy_same_origin_metadata",
    challenge: input.challenge,
    resource,
    prm: syntheticPrm,
    as,
  });
}

export function parseMcpOAuthChallenge(header: string | null): McpOAuthChallenge {
  if (!header) return { scheme: null, scope: [] };
  const schemeMatch = /(?:^|,)\s*(Bearer|OAuth)(?=\s|,|$)/i.exec(header);
  if (!schemeMatch) return { scheme: null, scope: [] };
  const scheme = schemeMatch[1]!.toLowerCase() as "bearer" | "oauth";
  const paramsText = challengeParametersText(header, schemeMatch.index + schemeMatch[0].length);
  const params: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(paramsText)) !== null) {
    const raw = match[2]!;
    params[match[1]!.toLowerCase()] = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/\\"/g, '"')
      : raw;
  }
  return {
    scheme,
    scope: params.scope ? params.scope.split(/\s+/).filter(Boolean) : [],
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

function challengeParametersText(header: string, start: number): string {
  let quoted = false;
  let escaped = false;
  for (let index = start; index < header.length; index += 1) {
    const character = header[index]!;
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character !== ",") continue;

    let cursor = index + 1;
    while (/\s/.test(header[cursor] ?? "")) cursor += 1;
    const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/.exec(header.slice(cursor))?.[0];
    if (!token) continue;
    cursor += token.length;
    while (/\s/.test(header[cursor] ?? "")) cursor += 1;
    if (header[cursor] !== "=") {
      return header.slice(start, index);
    }
  }
  return header.slice(start);
}

export function protectedResourceMetadataCandidates(
  resourceUrl: string,
  advertisedUrl?: string,
): string[] {
  return uniqueStrings([
    ...(advertisedUrl ? [advertisedUrl] : []),
    ...oauthWellKnownCandidates(resourceUrl, "oauth-protected-resource"),
  ]);
}

export function authorizationServerMetadataCandidates(authorizationServer: string): string[] {
  return uniqueStrings([
    ...oauthWellKnownCandidates(authorizationServer, "oauth-authorization-server"),
    ...oauthWellKnownCandidates(authorizationServer, "openid-configuration"),
    authorizationServer,
  ]);
}

export function legacyAuthorizationServerMetadataCandidates(resourceUrl: string): string[] {
  const origin = new URL(resourceUrl).origin;
  return [`${origin}/.well-known/oauth-authorization-server`];
}

function oauthWellKnownCandidates(rawUrl: string, name: string): string[] {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  return uniqueStrings([
    `${url.origin}/.well-known/${name}${path ? `/${path}` : ""}`,
    `${url.origin}${path ? `/${path}` : ""}/.well-known/${name}`,
    `${url.origin}/.well-known/${name}`,
  ]);
}

function parseProtectedResourceMetadata(
  fetched: McpOAuthMetadataFetchResult & { status: "present" },
  input: ResolveMcpOAuthDiscoveryInput,
): McpProtectedResourceMetadata {
  const authorizationServers = stringArray(fetched.document.authorization_servers).map((value) =>
    validateDiscoveryEndpoint(
      input,
      value,
      "OAuth authorization server",
      "protected_resource_metadata",
    ),
  );
  if (authorizationServers.length === 0) {
    throw new McpOAuthDiscoveryError(
      "protected_resource_metadata",
      "oauth_discovery_broken",
      "MCP protected resource metadata did not advertise an authorization server",
    );
  }
  const resourceValue = stringValue(fetched.document.resource);
  return {
    authorizationServers,
    scopesSupported: stringArray(fetched.document.scopes_supported),
    raw: fetched.document,
    metadataUrl: fetched.url,
    ...(resourceValue ? { resource: input.canonicalizeResource(resourceValue) } : {}),
  };
}

async function discoverAuthorizationServerMetadata(
  authorizationServer: string,
  profile: "modern" | "legacy",
  input: ResolveMcpOAuthDiscoveryInput,
): Promise<McpAuthorizationServerMetadata> {
  const safeAuthorizationServer = validateDiscoveryEndpoint(
    input,
    authorizationServer,
    "OAuth authorization server",
    "authorization_server_metadata",
  ).replace(/\/+$/, "");
  const candidates =
    profile === "legacy"
      ? legacyAuthorizationServerMetadataCandidates(safeAuthorizationServer)
      : authorizationServerMetadataCandidates(safeAuthorizationServer);
  let fetched: (McpOAuthMetadataFetchResult & { status: "present" }) | null = null;
  for (const candidate of candidates) {
    const result = await input.fetchMetadata({ kind: "authorization_server", url: candidate });
    if (result.status === "absent") continue;
    fetched = result;
    break;
  }
  if (!fetched) {
    throw new McpOAuthDiscoveryError(
      "authorization_server_metadata",
      profile === "legacy" ? "oauth_legacy_default_endpoints_unverified" : "oauth_discovery_broken",
      profile === "legacy"
        ? "legacy MCP OAuth metadata was absent; default authorization endpoints require explicit verification"
        : "could not discover OAuth authorization server metadata",
    );
  }

  const authorizationEndpoint = requiredString(
    fetched.document.authorization_endpoint,
    "authorization_endpoint",
    "authorization_server_metadata",
  );
  const tokenEndpoint = requiredString(
    fetched.document.token_endpoint,
    "token_endpoint",
    "authorization_server_metadata",
  );
  const issuerValue = stringValue(fetched.document.issuer);
  if (profile === "legacy" && !issuerValue) {
    throw new McpOAuthDiscoveryError(
      "authorization_server_metadata",
      "oauth_discovery_broken",
      "legacy MCP OAuth metadata did not include issuer",
    );
  }
  const issuer = validateDiscoveryEndpoint(
    input,
    issuerValue ?? safeAuthorizationServer,
    "OAuth issuer",
    "authorization_server_metadata",
  );
  if (
    profile === "legacy" &&
    normalizedIssuerIdentifier(issuer) !== normalizedIssuerIdentifier(safeAuthorizationServer)
  ) {
    const crossOrigin = new URL(issuer).origin !== new URL(safeAuthorizationServer).origin;
    throw new McpOAuthDiscoveryError(
      "authorization_server_metadata",
      crossOrigin ? "oauth_requires_profile" : "oauth_discovery_broken",
      "OAuth authorization server metadata issuer did not match the selected authorization server",
    );
  }
  const registrationEndpoint = stringValue(fetched.document.registration_endpoint);
  const parsed: McpAuthorizationServerMetadata = {
    issuer,
    authorizationServer: safeAuthorizationServer,
    authorizationEndpoint: validateDiscoveryEndpoint(
      input,
      authorizationEndpoint,
      "OAuth authorization endpoint",
      "authorization_server_metadata",
    ),
    tokenEndpoint: validateDiscoveryEndpoint(
      input,
      tokenEndpoint,
      "OAuth token endpoint",
      "authorization_server_metadata",
    ),
    clientIdMetadataDocumentSupported:
      fetched.document.client_id_metadata_document_supported === true,
    tokenEndpointAuthMethodsSupported: stringArray(
      fetched.document.token_endpoint_auth_methods_supported,
    ),
    codeChallengeMethodsSupported: stringArray(fetched.document.code_challenge_methods_supported),
    raw: fetched.document,
    metadataUrl: fetched.url,
    ...(registrationEndpoint
      ? {
          registrationEndpoint: validateDiscoveryEndpoint(
            input,
            registrationEndpoint,
            "OAuth registration endpoint",
            "authorization_server_metadata",
          ),
        }
      : {}),
  };
  if (!parsed.codeChallengeMethodsSupported.includes("S256")) {
    throw new McpOAuthDiscoveryError(
      "authorization_server_metadata",
      "oauth_discovery_broken",
      "authorization server does not support required PKCE S256",
    );
  }
  return parsed;
}

function discoveryResult(input: {
  mode: McpOAuthDiscoveryMode;
  classification: "oauth_rfc9728" | "oauth_legacy_same_origin_metadata";
  challenge: McpOAuthChallenge;
  resource: string;
  prm: McpProtectedResourceMetadata;
  as: McpAuthorizationServerMetadata;
}): McpOAuthDiscoveryResult {
  const protectedResourceMetadataUrl = input.prm.metadataUrl || null;
  return {
    mode: input.mode,
    classification: input.classification,
    challenge: input.challenge,
    resource: input.resource,
    protectedResourceMetadata: input.prm,
    authorizationServerMetadata: input.as,
    provenance: {
      protectedResourceMetadataUrl,
      authorizationServerMetadataUrl: input.as.metadataUrl,
      metadataSha256: createHash("sha256")
        .update(
          stableJson({
            mode: input.mode,
            resource: input.resource,
            challenge: input.challenge,
            protectedResourceMetadata: {
              url: protectedResourceMetadataUrl,
              document: input.prm.raw,
            },
            authorizationServerMetadata: {
              url: input.as.metadataUrl,
              document: input.as.raw,
            },
          }),
        )
        .digest("hex"),
    },
  };
}

function validateDiscoveryEndpoint(
  input: ResolveMcpOAuthDiscoveryInput,
  rawUrl: string,
  label: string,
  stage: McpOAuthDiscoveryError["stage"],
): string {
  try {
    return input.validateEndpoint(rawUrl, label);
  } catch (error) {
    throw new McpOAuthDiscoveryError(
      stage,
      "oauth_discovery_broken",
      error instanceof Error ? error.message : `${label} was invalid`,
      error,
    );
  }
}

function normalizedIssuerIdentifier(value: string): string {
  return value.replace(/\/+$/, "");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((entry): entry is string => typeof entry === "string"))
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(
  value: unknown,
  field: string,
  stage: McpOAuthDiscoveryError["stage"],
): string {
  const parsed = stringValue(value);
  if (!parsed) {
    throw new McpOAuthDiscoveryError(
      stage,
      "oauth_discovery_broken",
      `OAuth metadata did not include ${field}`,
    );
  }
  return parsed;
}
