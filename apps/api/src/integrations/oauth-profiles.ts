import { OPENGENI_PERSONAL_SLACK_MCP_URL, type ConnectionOwnership } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canonicalProviderDomain } from "./provider-domain";

/**
 * Provider OAuth quirks as data.
 *
 * Some providers do not support DCR or CIMD and need a pre-registered client
 * with pinned metadata; some issue personal tokens only; some reject RFC 8707's
 * `resource` parameter. Each used to be a hand-written branch set inside
 * `oauth-client.ts`; every quirk is now a field on an `OAuthProviderProfile`.
 * The flow reads exactly one resolved profile and contains no provider-name
 * conditional.
 *
 * Profiles come from two layers:
 *
 * 1. Built-in profiles below, for the providers whose fences are security
 *    invariants (hosted Slack MCP and official Gmail are personal-only, their
 *    authorization servers are origin-pinned). These live in code as data so
 *    the fences never depend on catalog import state.
 * 2. A validated `oauthProfile` object on a global catalog row (curated
 *    overlay -> importer -> `capability_catalog_items.metadata`). A catalog
 *    profile applies only when no built-in matches, and it can only narrow the
 *    default behavior, never loosen a built-in fence.
 */

export const OFFICIAL_SLACK_MCP_URL = OPENGENI_PERSONAL_SLACK_MCP_URL;
export const OFFICIAL_GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
export const OFFICIAL_GMAIL_MCP_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;

const SLACK_OAUTH_ORIGIN = "https://slack.com";
const SLACK_MCP_ORIGIN = "https://mcp.slack.com";
const GOOGLE_OAUTH_ISSUER_ORIGIN = "https://accounts.google.com";
const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";

/** The slice of discovered authorization-server metadata the pins constrain. */
export type PinnableAuthorizationServer = {
  issuer: string;
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
};

export type AuthorizationServerPins = {
  /** Origins `issuer` and `authorizationServer` must both belong to. */
  issuerOrigins: readonly string[];
  /** Origins the authorization endpoint must belong to. */
  authorizationEndpointOrigins: readonly string[];
  /** Origins the token endpoint must belong to. */
  tokenEndpointOrigins: readonly string[];
  /** Exact 422 message when a pin fails. */
  message: string;
  /** Skip enforcement in a local test environment (loopback fixtures). */
  skipInLocalTest: boolean;
};

export type OAuthProviderProfile = {
  /** Stable identity for guards, logs, and tests. */
  key: string;
  /** Built-in matching; catalog profiles match their own row's exact mcpUrl. */
  match: {
    mcpUrls?: readonly string[];
    providerDomains?: readonly string[];
  };
  /**
   * Canonical provider identity forced when the profile matches by URL, so a
   * caller cannot relabel a pinned resource under another domain.
   */
  canonicalProviderDomain?: string;
  /** Reject a caller-supplied manual OAuth client (deployment-managed only). */
  rejectCallerOAuthClient?: { message: string };
  /** The payload's explicit providerDomain must canonicalize to this domain. */
  requireProviderDomain?: { domain: string; message: string };
  /** Outside a local test environment, the start URL must be exactly this. */
  requireExactMcpUrl?: { url: string; message: string };
  /** Deployment-managed client credentials must be configured (503 otherwise). */
  requireDeploymentClient?: { key: DeploymentManagedClientKey; message: string };
  /** Ownerships a connection may take; a singleton also sets the default. */
  allowedOwnership: readonly ConnectionOwnership[];
  /** Exact 422 message when an explicit disallowed ownership is requested. */
  ownershipMessage?: string;
  /** Bind reconnect/dedupe to the exact mcpUrl, not just the provider domain. */
  exactMcpBinding: boolean;
  /** How an existing connection is chosen for reconnect coalescing. */
  connectionSelection: "canonical_personal" | "first_active";
  /** Post-discovery authorization-server origin pins. */
  authorizationServer?: AuthorizationServerPins;
  /**
   * Post-discovery identity check: the resolved providerDomain must equal this
   * domain (the reserved-authorization-server guard shares its message).
   */
  postDiscoveryProviderDomain?: { domain: string; message: string };
  /**
   * Client registration preference. `dcr` prefers the advertised registration
   * endpoint over CIMD (the Linear compatibility override, now data);
   * `deployment_managed`/`cimd` follow the ordinary resolution order, which
   * already tries operator and deployment clients first and CIMD next.
   */
  clientSource?: "deployment_managed" | "cimd" | "dcr";
  /** Send RFC 8707 `resource` on authorize and token requests. */
  sendResourceParameter: boolean;
  /** Extra authorize-URL query parameters (e.g. offline-consent opts). */
  extraAuthorizeParams?: Readonly<Record<string, string>>;
  /** Exact scope override; the caller can never widen past it. */
  requestedScopes?: readonly string[];
};

export const DEFAULT_OAUTH_PROFILE: OAuthProviderProfile = {
  key: "default",
  match: {},
  allowedOwnership: ["workspace", "personal"],
  exactMcpBinding: false,
  connectionSelection: "first_active",
  sendResourceParameter: true,
};

const HOSTED_SLACK_PROFILE: OAuthProviderProfile = {
  key: "hosted-slack-mcp",
  match: { mcpUrls: [OFFICIAL_SLACK_MCP_URL], providerDomains: ["slack.com"] },
  canonicalProviderDomain: "slack.com",
  rejectCallerOAuthClient: {
    message: "Slack OAuth client credentials are deployment-managed",
  },
  requireProviderDomain: {
    domain: "slack.com",
    message: "Slack provider identity does not match slack.com",
  },
  requireExactMcpUrl: {
    url: OFFICIAL_SLACK_MCP_URL,
    message: `Slack MCP OAuth must use ${OFFICIAL_SLACK_MCP_URL}`,
  },
  requireDeploymentClient: {
    key: "slack",
    message: "Slack MCP OAuth requires OPENGENI_SLACK_CLIENT_ID and OPENGENI_SLACK_CLIENT_SECRET",
  },
  allowedOwnership: ["personal"],
  ownershipMessage:
    "Slack's hosted MCP connection is personal only; install the OpenGeni Slack bot for workspace access",
  exactMcpBinding: true,
  connectionSelection: "canonical_personal",
  authorizationServer: {
    issuerOrigins: [SLACK_OAUTH_ORIGIN, SLACK_MCP_ORIGIN],
    authorizationEndpointOrigins: [SLACK_OAUTH_ORIGIN],
    tokenEndpointOrigins: [SLACK_OAUTH_ORIGIN],
    message: "Slack MCP authorization metadata did not remain bound to slack.com",
    skipInLocalTest: true,
  },
  sendResourceParameter: true,
};

const OFFICIAL_GMAIL_PROFILE: OAuthProviderProfile = {
  key: "official-gmail",
  match: { mcpUrls: [OFFICIAL_GMAIL_MCP_URL] },
  allowedOwnership: ["personal"],
  ownershipMessage:
    "Gmail connections are personal only; each workspace member must connect their own mailbox",
  exactMcpBinding: true,
  connectionSelection: "first_active",
  authorizationServer: {
    issuerOrigins: [GOOGLE_OAUTH_ISSUER_ORIGIN],
    authorizationEndpointOrigins: [GOOGLE_OAUTH_ISSUER_ORIGIN],
    tokenEndpointOrigins: [GOOGLE_TOKEN_ORIGIN],
    message: "Gmail MCP authorization metadata did not remain bound to Google",
    skipInLocalTest: false,
  },
  postDiscoveryProviderDomain: {
    domain: "gmailmcp.googleapis.com",
    message: `Google OAuth is allowed only for ${OFFICIAL_GMAIL_MCP_URL}`,
  },
  // Google's OAuth endpoints do not implement RFC 8707's `resource` parameter.
  sendResourceParameter: false,
  // Explicit offline consent is required to obtain the refresh token used by
  // the durable connection broker. These are Gmail profile data, not behavior
  // implied by suppressing the resource parameter.
  extraAuthorizeParams: {
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
  },
  // The Gmail PRM advertises broader grants, including full-mail access. The
  // reviewed connector never lets a caller widen the capability contract.
  requestedScopes: OFFICIAL_GMAIL_MCP_SCOPES,
};

const BUILT_IN_OAUTH_PROFILES: readonly OAuthProviderProfile[] = [
  HOSTED_SLACK_PROFILE,
  OFFICIAL_GMAIL_PROFILE,
];

/** Exact built-in profile by its stable key; throws on an unknown key. */
export function builtInOAuthProfileByKey(key: string): OAuthProviderProfile {
  const profile = BUILT_IN_OAUTH_PROFILES.find((candidate) => candidate.key === key);
  if (!profile) {
    throw new Error(`missing built-in OAuth profile: ${key}`);
  }
  return profile;
}

/**
 * Authorization servers reserved for exactly one profile: discovering one of
 * these identities on any other flow is rejected before registration.
 */
const RESERVED_AUTHORIZATION_SERVERS: readonly {
  issuerOrigins: readonly string[];
  allowedProfileKey: string;
  message: string;
}[] = [
  {
    issuerOrigins: [GOOGLE_OAUTH_ISSUER_ORIGIN],
    allowedProfileKey: OFFICIAL_GMAIL_PROFILE.key,
    message: `Google OAuth is allowed only for ${OFFICIAL_GMAIL_MCP_URL}`,
  },
  {
    // A URL variant that dodges the hosted-Slack profile match (for example a
    // trailing slash yielding providerDomain mcp.slack.com) must not reach
    // Slack's authorization server as a default-profile flow: that would mint
    // a workspace-ownable Slack identity with the deployment client.
    issuerOrigins: [SLACK_OAUTH_ORIGIN, SLACK_MCP_ORIGIN],
    allowedProfileKey: HOSTED_SLACK_PROFILE.key,
    message: `Slack OAuth is allowed only for ${OFFICIAL_SLACK_MCP_URL}`,
  },
];

/**
 * Issuers whose advertised CIMD support is broken and whose documented
 * interactive setup uses DCR; the simultaneously advertised registration
 * endpoint is preferred. Linear is the only known case.
 */
export const PREFER_DCR_ISSUERS: ReadonlySet<string> = new Set(["https://mcp.linear.app"]);

export type DeploymentManagedClientKey = "slack";

/**
 * Pre-registered deployment clients resolved from dedicated settings, keyed by
 * the authorization-server origins they serve. Consulted before the operator
 * clients JSON so a deployment-managed provider can never be shadowed.
 */
export const DEPLOYMENT_MANAGED_CLIENTS: readonly {
  key: DeploymentManagedClientKey;
  issuerOrigins: readonly string[];
  resolve: (settings: Settings) => {
    clientId: string;
    clientSecret: string;
    tokenEndpointAuthMethod: "client_secret_post";
  } | null;
}[] = [
  {
    key: "slack",
    issuerOrigins: [SLACK_OAUTH_ORIGIN, SLACK_MCP_ORIGIN],
    resolve: (settings) =>
      settings.slackClientId?.trim() && settings.slackClientSecret?.trim()
        ? {
            clientId: settings.slackClientId.trim(),
            clientSecret: settings.slackClientSecret.trim(),
            tokenEndpointAuthMethod: "client_secret_post",
          }
        : null,
  },
];

export function deploymentManagedClientFor(
  settings: Settings,
  key: DeploymentManagedClientKey,
): ReturnType<(typeof DEPLOYMENT_MANAGED_CLIENTS)[number]["resolve"]> {
  const entry = DEPLOYMENT_MANAGED_CLIENTS.find((candidate) => candidate.key === key);
  return entry ? entry.resolve(settings) : null;
}

/** Built-in profile for a start target, or null when only the default applies. */
export function builtInOAuthProfileFor(input: {
  mcpUrl: string;
  providerDomain?: string | undefined;
}): OAuthProviderProfile | null {
  for (const profile of BUILT_IN_OAUTH_PROFILES) {
    if (profile.match.mcpUrls?.includes(input.mcpUrl)) {
      return profile;
    }
    if (
      input.providerDomain !== undefined &&
      profile.match.providerDomains?.includes(canonicalProviderDomain(input.providerDomain))
    ) {
      return profile;
    }
  }
  return null;
}

/** Ownership an omitted request defaults to under a profile. */
export function defaultOwnershipFor(profile: OAuthProviderProfile): ConnectionOwnership {
  return profile.allowedOwnership.length === 1 && profile.allowedOwnership[0] === "personal"
    ? "personal"
    : "workspace";
}

/** Rejects an ownership outside the profile's allowed set with its exact message. */
export function assertOwnershipAllowed(
  profile: OAuthProviderProfile,
  ownership: ConnectionOwnership,
): void {
  if (profile.allowedOwnership.includes(ownership)) {
    return;
  }
  throw new HTTPException(422, {
    message:
      profile.ownershipMessage ??
      `this integration allows only ${profile.allowedOwnership.join(" or ")} connections`,
  });
}

/** Enforces a profile's authorization-server origin pins with its exact message. */
export function assertAuthorizationServerPins(
  as: PinnableAuthorizationServer,
  pins: Pick<
    AuthorizationServerPins,
    "issuerOrigins" | "authorizationEndpointOrigins" | "tokenEndpointOrigins" | "message"
  >,
): void {
  const issuerOrigins = [as.issuer, as.authorizationServer].map((value) => new URL(value).origin);
  const authorizationOrigin = new URL(as.authorizationEndpoint).origin;
  const tokenOrigin = new URL(as.tokenEndpoint).origin;
  if (
    issuerOrigins.some((origin) => !pins.issuerOrigins.includes(origin)) ||
    !pins.authorizationEndpointOrigins.includes(authorizationOrigin) ||
    !pins.tokenEndpointOrigins.includes(tokenOrigin)
  ) {
    throw new HTTPException(422, { message: pins.message });
  }
}

/**
 * Reserved-authorization-server guard: a discovered identity claimed by one
 * profile is rejected on every other flow with that guard's exact message.
 */
export function assertAuthorizationServerNotReserved(
  as: PinnableAuthorizationServer,
  profile: OAuthProviderProfile,
): void {
  const identities = [as.issuer, as.authorizationServer].map((value) => new URL(value).origin);
  for (const guard of RESERVED_AUTHORIZATION_SERVERS) {
    if (profile.key === guard.allowedProfileKey) {
      continue;
    }
    if (identities.some((origin) => guard.issuerOrigins.includes(origin))) {
      throw new HTTPException(422, { message: guard.message });
    }
  }
}

/**
 * Catalog-row profile: the declarative subset a curated row may carry. It can
 * only narrow the default flow; the fields that grant authority (deployment
 * client settings, reserved-server membership) are built-in-only by
 * construction because the schema cannot express them.
 */
/**
 * Authorize-URL parameters owned by the OAuth client itself. A profile's
 * `extraAuthorizeParams` may never name one: overriding `scope` or `resource`
 * would widen the grant past the recorded contract, and the rest carry the
 * PKCE/state security machinery. Enforced in this schema, in the curation
 * parser, and defensively again in `buildAuthorizationUrl`.
 */
export const RESERVED_AUTHORIZE_PARAMS: ReadonlySet<string> = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "resource",
  "response_type",
  "scope",
  "state",
]);

export const catalogOAuthProfileSchema = z
  .object({
    clientSource: z.enum(["deployment_managed", "cimd", "dcr"]).optional(),
    exactMcpUrl: z.string().url().optional(),
    pinnedIssuerOrigins: z.array(z.string().url()).min(1).optional(),
    pinnedEndpointOrigins: z.array(z.string().url()).min(1).optional(),
    sendResourceParameter: z.boolean().optional(),
    allowedOwnership: z
      .array(z.enum(["personal", "workspace"]))
      .min(1)
      .optional(),
    requestedScopes: z.array(z.string().min(1)).min(1).optional(),
    extraAuthorizeParams: z
      .record(z.string(), z.string())
      .optional()
      .refine(
        (value) => !value || Object.keys(value).every((key) => !RESERVED_AUTHORIZE_PARAMS.has(key)),
        { message: "extraAuthorizeParams may not name a reserved OAuth parameter" },
      ),
  })
  .strict();

export type CatalogOAuthProfile = z.infer<typeof catalogOAuthProfileSchema>;

function originOf(value: string): string {
  return new URL(value).origin;
}

/**
 * Canonical catalog lookup key for an MCP URL, mirroring the importer's
 * `canonicalMcpUrl` (`scripts/catalog-curation.ts`): no fragment, lowercase
 * host, default ports stripped, trailing slashes collapsed. Without this, a
 * trailing-slash or uppercase-host variant of a profiled URL would miss the
 * row and silently fall back to the default profile.
 */
export function catalogMcpUrlKey(value: string): string {
  const url = new URL(value);
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
}

/**
 * Applies a validated catalog profile over the default profile for a row with
 * no built-in. `deployment_managed` from catalog data resolves through the
 * operator clients JSON (issuer-keyed) only; named settings-backed clients
 * remain built-in-only.
 *
 * A present-but-invalid profile fails closed with a 422: the row's operator
 * declared constraints, and silently degrading to the default profile would
 * drop an ownership fence or origin pin on a JSON typo.
 */
export function oauthProfileFromCatalog(mcpUrl: string, raw: unknown): OAuthProviderProfile {
  const parsed = catalogOAuthProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(422, {
      message:
        "this integration's catalog OAuth profile is invalid; re-run the catalog import or fix the curated overlay",
    });
  }
  const data = parsed.data;
  const issuerOrigins = data.pinnedIssuerOrigins?.map(originOf);
  const endpointOrigins = data.pinnedEndpointOrigins?.map(originOf);
  const pins =
    issuerOrigins || endpointOrigins
      ? {
          issuerOrigins: issuerOrigins ?? endpointOrigins ?? [],
          authorizationEndpointOrigins: endpointOrigins ?? issuerOrigins ?? [],
          tokenEndpointOrigins: endpointOrigins ?? issuerOrigins ?? [],
          message: "authorization metadata did not remain bound to the reviewed provider origins",
          skipInLocalTest: false,
        }
      : undefined;
  return {
    key: `catalog:${mcpUrl}`,
    match: { mcpUrls: [mcpUrl] },
    allowedOwnership: data.allowedOwnership ?? DEFAULT_OAUTH_PROFILE.allowedOwnership,
    ...(data.allowedOwnership && !data.allowedOwnership.includes("workspace")
      ? {
          ownershipMessage:
            "this integration allows only personal connections; each workspace member must connect their own account",
        }
      : {}),
    exactMcpBinding: Boolean(data.exactMcpUrl),
    ...(data.exactMcpUrl
      ? {
          requireExactMcpUrl: {
            url: data.exactMcpUrl,
            message: `OAuth for this integration must use ${data.exactMcpUrl}`,
          },
        }
      : {}),
    connectionSelection: "first_active",
    ...(pins ? { authorizationServer: pins } : {}),
    ...(data.clientSource ? { clientSource: data.clientSource } : {}),
    sendResourceParameter: data.sendResourceParameter ?? true,
    ...(data.requestedScopes ? { requestedScopes: data.requestedScopes } : {}),
    ...(data.extraAuthorizeParams ? { extraAuthorizeParams: data.extraAuthorizeParams } : {}),
  };
}
