import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Published Sites: a workspace Site served on its own hostname under a
 * configurable Sites domain (production `opengeni.site`, staging a separate
 * domain). Shared by the API, the Site gateway Worker, the console and the
 * SDK. See docs/design/published-sites-2026-10-14.md.
 *
 * Nothing here names a concrete domain: every domain is configuration.
 */

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

export const SITE_HOSTNAME_LABEL_MIN = 3;
export const SITE_HOSTNAME_LABEL_MAX = 63;
/** A released hostname stays reserved to its workspace for at least this long. */
export const SITE_HOSTNAME_RELEASE_HOLD_DAYS = 30;

/** Labels no Site may take: platform, mail, auth and infrastructure names. */
export const SITE_RESERVED_HOSTNAME_LABELS: readonly string[] = Object.freeze([
  "www",
  "api",
  "app",
  "admin",
  "auth",
  "login",
  "logout",
  "account",
  "accounts",
  "mail",
  "email",
  "smtp",
  "imap",
  "pop",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "status",
  "docs",
  "help",
  "support",
  "abuse",
  "security",
  "postmaster",
  "hostmaster",
  "webmaster",
  "noreply",
  "no-reply",
  "cdn",
  "static",
  "assets",
  "media",
  "og",
  "opengeni",
  "cloudgeni",
  "gateway",
  "edge",
  "internal",
  "staging",
  "preview",
  "dev",
  "test",
  "billing",
  "dashboard",
  "console",
  "root",
  "system",
  "autoconfig",
  "autodiscover",
  "wpad",
  "localhost",
]);

/**
 * Words that make a hostname look like a credential, payment or brand page.
 * A label containing any of them is refused (substring match on the label
 * with hyphens removed), whoever asks.
 */
export const SITE_BLOCKED_HOSTNAME_WORDS: readonly string[] = Object.freeze([
  "secure",
  "verify",
  "verification",
  "wallet",
  "signin",
  "login",
  "logon",
  "password",
  "passwd",
  "credential",
  "recovery",
  "unlock",
  "refund",
  "banking",
  "paypal",
  "stripe",
  "venmo",
  "coinbase",
  "binance",
  "metamask",
  "trezor",
  "seedphrase",
  "google",
  "gmail",
  "microsoft",
  "office365",
  "outlook",
  "azure",
  "apple",
  "icloud",
  "amazon",
  "facebook",
  "instagram",
  "whatsapp",
  "netflix",
  "linkedin",
  "github",
  "dropbox",
  "docusign",
  "okta",
  "opengeni",
  "cloudgeni",
]);

export type SiteHostnameLabelProblem =
  | "length"
  | "characters"
  | "hyphen"
  | "punycode"
  | "reserved"
  | "blocked";

export const SITE_HOSTNAME_PROBLEM_MESSAGES: Readonly<Record<SiteHostnameLabelProblem, string>> =
  Object.freeze({
    length: `Use ${SITE_HOSTNAME_LABEL_MIN} to ${SITE_HOSTNAME_LABEL_MAX} characters.`,
    characters: "Use lowercase letters, digits and hyphens only.",
    hyphen: "Start and end with a letter or digit.",
    punycode: "Names with -- in the third and fourth place are not allowed.",
    reserved: "This name is reserved.",
    blocked: "This name is not allowed.",
  });

/**
 * Validate one DNS label for a Site hostname. Pure and environment-neutral:
 * the API, the gateway and the console all call it. Availability (global
 * uniqueness and the release hold) is decided only by the API.
 */
export function siteHostnameLabelProblem(label: string): SiteHostnameLabelProblem | null {
  if (label.length < SITE_HOSTNAME_LABEL_MIN || label.length > SITE_HOSTNAME_LABEL_MAX)
    return "length";
  if (!/^[a-z0-9-]+$/u.test(label)) return "characters";
  if (label.startsWith("-") || label.endsWith("-")) return "hyphen";
  // IDNA reserves "--" in positions 3-4 (xn--, and future ACE prefixes).
  if (label.slice(2, 4) === "--") return "punycode";
  if (SITE_RESERVED_HOSTNAME_LABELS.includes(label)) return "reserved";
  const flat = label.replaceAll("-", "");
  if (SITE_BLOCKED_HOSTNAME_WORDS.some((word) => flat.includes(word))) return "blocked";
  return null;
}

export const SiteHostnameLabel = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .superRefine((label, ctx) => {
      const problem = siteHostnameLabelProblem(label);
      if (problem)
        ctx.addIssue({ code: "custom", message: SITE_HOSTNAME_PROBLEM_MESSAGES[problem] });
    })
    .describe(
      "One DNS label: 3-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen. The Site is served at <label>.<sites domain>.",
    ),
);
export type SiteHostnameLabel = z.infer<typeof SiteHostnameLabel>;

/**
 * Suggest a default label from a Site title: a slug plus a random
 * four-character suffix (`team-dashboard-4k9x`), always valid by
 * construction. `suffix` must be 4 chars of [a-z0-9]; callers supply it so
 * this stays pure.
 */
export function suggestSiteHostnameLabel(title: string, suffix: string): string {
  if (!/^[a-z0-9]{4}$/u.test(suffix)) throw new Error("suffix must be 4 chars of [a-z0-9]");
  const base = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, SITE_HOSTNAME_LABEL_MAX - 5)
    .replace(/-+$/u, "");
  const label = `${base || "site"}-${suffix}`;
  return siteHostnameLabelProblem(label) ? `site-${suffix}` : label;
}

/** Normalize a configured Sites domain (`opengeni.site`); throws when it is not a hostname. */
export function normalizeSitesDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.$/u, "");
  if (
    !/^(?=.{3,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      normalized,
    )
  )
    throw new Error("Invalid Sites domain");
  return normalized;
}

/** `<label>.<domain>` for a valid label and configured domain. */
export function siteHostname(label: string, sitesDomain: string): string {
  return `${label}.${normalizeSitesDomain(sitesDomain)}`;
}

/**
 * The label of a flat one-level Site hostname under the Sites domain, or null
 * for the apex, deeper names, other domains and invalid labels. A port and a
 * trailing dot are ignored.
 */
export function parseSiteHostname(host: string, sitesDomain: string): string | null {
  const domain = normalizeSitesDomain(sitesDomain);
  const name = host.trim().toLowerCase().replace(/:\d+$/u, "").replace(/\.$/u, "");
  if (!name.endsWith(`.${domain}`)) return null;
  const label = name.slice(0, -(domain.length + 1));
  if (!label || label.includes(".")) return null;
  return siteHostnameLabelProblem(label) === null ? label : null;
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/**
 * Who may open a published Site.
 * - members: signed-in members of the Site's workspace.
 * - invited: members plus people invited by email (they sign in to OpenGeni).
 * - public: anyone; anonymous visitors use a guest principal. On deployments
 *   configured login-only (staging), public means any signed-in Opengeni user.
 */
export const SiteAccessMode = /* @__PURE__ */ defineSchema(() =>
  z.enum(["members", "invited", "public"]),
);
export type SiteAccessMode = z.infer<typeof SiteAccessMode>;

/**
 * active: served. unpublished: the owner turned publishing off (the hostname
 * stays held). suspended: taken down by the owner, a workspace admin or a
 * platform moderator; the gateway serves a takedown page.
 */
export const SitePublicationStatus = /* @__PURE__ */ defineSchema(() =>
  z.enum(["active", "unpublished", "suspended"]),
);
export type SitePublicationStatus = z.infer<typeof SitePublicationStatus>;

export const SiteLimitProfileKind = /* @__PURE__ */ defineSchema(() =>
  z
    .enum(["free", "credits", "unlimited", "custom"])
    .describe(
      "free: strict platform defaults. credits: larger defaults paid from organization credits. unlimited: no Opengeni budget caps (flood brakes and per-conversation caps still apply). custom: explicit values.",
    ),
);
export type SiteLimitProfileKind = z.infer<typeof SiteLimitProfileKind>;

const NullableLimit = (description: string) =>
  z.number().int().nonnegative().nullable().describe(`${description} null means no limit.`);

/**
 * Effective limits for a published Site. Money is in micro-USD
 * (1_000_000 = $1). Cloudflare cannot cap spend, so the edge applies only
 * flood brakes; Opengeni enforces these values.
 */
export const SiteLimits = /* @__PURE__ */ defineSchema(() =>
  z.object({
    requestsPerMinutePerVisitor: NullableLimit("Site runtime requests per visitor per minute."),
    guestWritesPerMinute: NullableLimit("Data writes per guest visitor per minute."),
    agentsEnabled: z.boolean().describe("Viewers may start embedded agent conversations."),
    guestAgentsEnabled: z
      .boolean()
      .describe("Anonymous guests may start embedded agent conversations (public Sites)."),
    conversationsPerVisitorPerDay: NullableLimit("New agent conversations per visitor per day."),
    conversationsPerSitePerDay: NullableLimit(
      "New agent conversations per Site per UTC day, from every visitor together.",
    ),
    turnsPerConversation: NullableLimit("Messages a viewer may send in one conversation."),
    agentMicrosPerConversation: NullableLimit("Agent spend per conversation, micro-USD."),
    agentMicrosPerVisitorPerDay: NullableLimit("Agent spend per visitor per UTC day, micro-USD."),
    agentMicrosPerSitePerMonth: NullableLimit("Agent spend per Site per UTC month, micro-USD."),
    agentModels: z
      .array(z.string().min(1).max(200))
      .max(20)
      .nullable()
      .describe("Models embedded agents may use; null allows the workspace defaults."),
  }),
);
export type SiteLimits = z.infer<typeof SiteLimits>;

/** Platform default for the free profile; deployments override through settings. */
export const DEFAULT_FREE_SITE_LIMITS: Readonly<SiteLimits> = Object.freeze({
  requestsPerMinutePerVisitor: 120,
  guestWritesPerMinute: 30,
  agentsEnabled: true,
  guestAgentsEnabled: true,
  conversationsPerVisitorPerDay: 10,
  conversationsPerSitePerDay: 50,
  turnsPerConversation: 20,
  agentMicrosPerConversation: 20_000,
  agentMicrosPerVisitorPerDay: 200_000,
  agentMicrosPerSitePerMonth: 2_000_000,
  agentModels: null,
});

/** Hard caps that still apply under every profile, unlimited included. */
export const UNLIMITED_SITE_FLOOD_BRAKES = Object.freeze({
  requestsPerMinutePerVisitor: 600,
  conversationsPerSitePerDay: 10_000,
  agentMicrosPerConversation: 5_000_000,
});

export const SiteLimitProfile = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: SiteLimitProfileKind,
    /** Only for custom; ignored otherwise. Missing fields take the free defaults. */
    overrides: SiteLimits.partial().nullable().default(null),
  }),
);
export type SiteLimitProfile = z.infer<typeof SiteLimitProfile>;

export const SiteEmbeddedAgent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    enabled: z.boolean(),
    /** Model for new conversations; must be allowed by the effective limits. */
    model: z.string().min(1).max(200).nullable().default(null),
    /** Extra instructions for the Site's agent, appended to the platform's. */
    instructions: z.string().max(8000).nullable().default(null),
    /**
     * Workspace MCP connections (server ids) the agent may use. null or empty:
     * no workspace tools. Setting a non-empty list needs a workspace admin.
     */
    tools: z.array(z.string().min(1).max(300)).max(100).nullable().default(null),
    /**
     * Tools for everyone who isn't a workspace member or invited: whether
     * conversations of signed-in people outside the workspace (on a public
     * Site) and of anonymous guests get `tools` too. Off by default: only
     * members and invited viewers get workspace tools. The name is kept for
     * compatibility. Setting it needs a workspace admin.
     */
    guestTools: z.boolean().default(false),
  }),
);
export type SiteEmbeddedAgent = z.infer<typeof SiteEmbeddedAgent>;

/** Changes to the embedded agent; omitted fields keep their current value. */
export const SiteEmbeddedAgentChanges = /* @__PURE__ */ defineSchema(() =>
  z.object({
    enabled: z.boolean().optional(),
    model: z.string().min(1).max(200).nullable().optional(),
    instructions: z.string().max(8000).nullable().optional(),
    tools: z.array(z.string().min(1).max(300)).max(100).nullable().optional(),
    guestTools: z.boolean().optional(),
  }),
);
export type SiteEmbeddedAgentChanges = z.infer<typeof SiteEmbeddedAgentChanges>;

export const SitePublication = /* @__PURE__ */ defineSchema(() =>
  z.object({
    siteId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    label: z.string(),
    hostname: z.string(),
    url: z.string().url(),
    access: SiteAccessMode,
    status: SitePublicationStatus,
    /** True when search engines are asked not to index (always on staging). */
    noindex: z.boolean(),
    agent: SiteEmbeddedAgent,
    limitProfile: SiteLimitProfile,
    /** Limits after workspace and platform defaults are applied. */
    effectiveLimits: SiteLimits,
    invitedEmails: z.array(z.string().email()).max(500),
    moderation: z.object({
      openReports: z.number().int().nonnegative(),
      suspendedAt: z.string().nullable(),
      suspendedBy: z.enum(["owner", "admin", "platform"]).nullable(),
      suspendedReason: z.string().max(2000).nullable(),
    }),
    usage: z.object({
      agentMicrosThisMonth: z.number().int().nonnegative(),
      conversationsToday: z.number().int().nonnegative(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type SitePublication = z.infer<typeof SitePublication>;

/** PUT /v1/workspaces/:ws/published-artifacts/:siteId/publication */
export const UpsertSitePublicationRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    label: SiteHostnameLabel.optional().describe("Omit to keep the current or a suggested label."),
    access: SiteAccessMode.optional(),
    status: z.enum(["active", "unpublished"]).optional(),
    noindex: z.boolean().optional(),
    agent: SiteEmbeddedAgentChanges.optional(),
    limitProfile: SiteLimitProfile.optional(),
    invitedEmails: z.array(z.string().email()).max(500).optional(),
  }),
);
export type UpsertSitePublicationRequest = z.infer<typeof UpsertSitePublicationRequest>;

export const SiteHostnameAvailabilityProblem = /* @__PURE__ */ defineSchema(() =>
  z.enum(["length", "characters", "hyphen", "punycode", "reserved", "blocked", "taken", "held"]),
);
export type SiteHostnameAvailabilityProblem = z.infer<typeof SiteHostnameAvailabilityProblem>;

/** GET /v1/workspaces/:ws/site-hostnames/:label */
export const SiteHostnameAvailability = /* @__PURE__ */ defineSchema(() =>
  z.object({
    label: z.string(),
    hostname: z.string().nullable(),
    available: z.boolean(),
    problem: SiteHostnameAvailabilityProblem.nullable(),
    message: z.string().nullable(),
  }),
);
export type SiteHostnameAvailability = z.infer<typeof SiteHostnameAvailability>;

/** POST .../publication/takedown (owner, workspace admin) and the platform admin route. */
export const SiteTakedownRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ reason: z.string().trim().min(1).max(2000) }),
);
export type SiteTakedownRequest = z.infer<typeof SiteTakedownRequest>;

export const SiteAbuseCategory = /* @__PURE__ */ defineSchema(() =>
  z.enum(["phishing", "malware", "spam", "illegal", "harassment", "copyright", "other"]),
);
export type SiteAbuseCategory = z.infer<typeof SiteAbuseCategory>;

/** POST /_og/report on a Site host, forwarded to /v1/site-runtime/site/reports. */
export const SiteAbuseReportRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    category: SiteAbuseCategory,
    message: z.string().trim().max(4000).default(""),
    contactEmail: z.string().email().max(320).nullable().default(null),
  }),
);
export type SiteAbuseReportRequest = z.infer<typeof SiteAbuseReportRequest>;

export const SiteAbuseReport = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    siteId: z.string().uuid(),
    hostname: z.string(),
    category: SiteAbuseCategory,
    message: z.string(),
    contactEmail: z.string().nullable(),
    status: z.enum(["open", "dismissed", "actioned"]),
    createdAt: z.string(),
  }),
);
export type SiteAbuseReport = z.infer<typeof SiteAbuseReport>;

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

/**
 * The viewer as a Site sees it (`site.viewer`). Guests have no name or
 * email. `id` is stable per Site and is the Site Data owner principal
 * (`user:<subject>` or `guest:<visitor>`); it is not an Opengeni subject id
 * usable anywhere else.
 */
export const SiteViewer = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: z.enum(["member", "invited", "user", "guest"]),
    id: z.string().min(1).max(300),
    name: z.string().nullable(),
    email: z.string().nullable(),
    signedIn: z.boolean(),
  }),
);
export type SiteViewer = z.infer<typeof SiteViewer>;

/** GET /_og/api/site/config (gateway shell and `site.viewer`). */
export const SiteRuntimeConfig = /* @__PURE__ */ defineSchema(() =>
  z.object({
    siteId: z.string().uuid(),
    title: z.string(),
    hostname: z.string(),
    versionId: z.string().uuid(),
    access: SiteAccessMode,
    viewer: SiteViewer,
    agent: z.object({ enabled: z.boolean(), model: z.string().nullable() }),
    siteData: z.boolean(),
    noindex: z.boolean(),
    abuseEmail: z.string().email().nullable(),
  }),
);
export type SiteRuntimeConfig = z.infer<typeof SiteRuntimeConfig>;

// ---------------------------------------------------------------------------
// Viewer sign-in (app <-> gateway)
// ---------------------------------------------------------------------------

/**
 * POST /v1/site-auth/authorize, called by the console page
 * `/site-auth/authorize` with the signed-in user's ordinary credentials.
 * Returns a one-time code bound to the host, PKCE challenge and redirect.
 */
export const SiteAuthAuthorizeRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    host: z.string().min(1).max(253),
    state: z.string().min(16).max(256),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    codeChallengeMethod: z.literal("S256"),
    redirectUri: z.string().url(),
  }),
);
export type SiteAuthAuthorizeRequest = z.infer<typeof SiteAuthAuthorizeRequest>;

export const SiteAuthAuthorizeResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    redirectTo: z.string().url().describe("redirectUri with code and state appended."),
    site: z.object({ title: z.string(), hostname: z.string() }),
  }),
);
export type SiteAuthAuthorizeResponse = z.infer<typeof SiteAuthAuthorizeResponse>;

/** POST /v1/site-runtime/auth/exchange (gateway only, signed). */
export const SiteAuthExchangeRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    code: z.string().min(16).max(256),
    codeVerifier: z.string().min(43).max(128),
    redirectUri: z.string().url(),
  }),
);
export type SiteAuthExchangeRequest = z.infer<typeof SiteAuthExchangeRequest>;

export const SiteAuthExchangeResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Opaque; valid only for site-runtime on this one Site host. The API keeps only its hash. */
    sessionToken: z.string().min(32),
    expiresAt: z.string(),
    viewer: SiteViewer,
  }),
);
export type SiteAuthExchangeResponse = z.infer<typeof SiteAuthExchangeResponse>;

// ---------------------------------------------------------------------------
// Gateway <-> API
// ---------------------------------------------------------------------------

export const SITE_SESSION_COOKIE = "__Host-og_session";
export const SITE_VISITOR_COOKIE = "__Host-og_v";
export const SITE_LOGIN_COOKIE = "__Host-og_login";

/** Paths the gateway owns on every Site host. */
export const SITE_GATEWAY_PREFIX = "/_og";
export const SITE_GATEWAY_API_PREFIX = "/_og/api";
export const SITE_GATEWAY_VERSION_PREFIX = "/_og/v";
export const SITE_GATEWAY_LOGIN_PATH = "/_og/auth/login";
export const SITE_GATEWAY_CALLBACK_PATH = "/_og/auth/callback";
export const SITE_GATEWAY_LOGOUT_PATH = "/_og/auth/logout";
export const SITE_GATEWAY_REPORT_PATH = "/_og/report";

/** The API prefix the gateway forwards `/_og/api/*` to. */
export const SITE_RUNTIME_API_PREFIX = "/v1/site-runtime";

export const SITE_GATEWAY_TIMESTAMP_HEADER = "x-opengeni-gateway-timestamp";
export const SITE_GATEWAY_SIGNATURE_HEADER = "x-opengeni-gateway-signature";
export const SITE_GATEWAY_HOST_HEADER = "x-opengeni-site-host";
export const SITE_GATEWAY_SESSION_HEADER = "x-opengeni-site-session";
export const SITE_GATEWAY_VISITOR_HEADER = "x-opengeni-site-visitor";
export const SITE_GATEWAY_CLIENT_IP_HEADER = "x-opengeni-site-client-ip";
export const SITE_GATEWAY_HUMAN_HEADER = "x-opengeni-site-human";
/**
 * Lowercase hex SHA-256 of the exact body bytes: the same value the gateway
 * signs as `bodySha256`. When it is present the API verifies the signature
 * before it reads the body, then checks the body against it.
 */
export const SITE_GATEWAY_BODY_SHA256_HEADER = "x-opengeni-gateway-body-sha256";
/** Reject signed requests whose timestamp differs from the API clock by more. */
export const SITE_GATEWAY_MAX_SKEW_SECONDS = 30;
export const SITE_GATEWAY_SIGNATURE_VERSION = "v1";

export type SiteGatewaySignedFields = {
  method: string;
  /** Path and query exactly as sent to the API, starting with /v1/site-runtime. */
  pathWithQuery: string;
  /** Unix seconds. */
  timestamp: number;
  /** Lowercase hex SHA-256 of the exact request body bytes (of "" when empty). */
  bodySha256: string;
  host: string;
  /** Raw site-session token, or "" when the viewer is not signed in. */
  session: string;
  /** Gateway-minted visitor id, or "". */
  visitor: string;
  clientIp: string;
  /** "1" when the gateway verified a bot challenge for this visitor, else "". */
  human: string;
};

/**
 * The exact string both sides HMAC-SHA256 with the shared gateway secret.
 * The header carries `v1=<base64url signature>`; during secret rotation the
 * API accepts the current or the previous secret.
 */
export function siteGatewayCanonicalString(fields: SiteGatewaySignedFields): string {
  return [
    "OGSG1",
    fields.method.toUpperCase(),
    fields.host.toLowerCase(),
    fields.pathWithQuery,
    String(fields.timestamp),
    fields.bodySha256,
    fields.session,
    fields.visitor,
    fields.clientIp,
    fields.human,
  ].join("\n");
}

/**
 * The rebuildable host-map record the gateway reads from KV (`host:<hostname>`)
 * and, on a miss, from GET /v1/site-runtime/host. Postgres is the source of truth.
 */
export const SiteHostMapRecord = /* @__PURE__ */ defineSchema(() =>
  z.object({
    v: z.literal(1),
    hostname: z.string(),
    siteId: z.string().uuid(),
    status: SitePublicationStatus,
    access: SiteAccessMode,
    /** The version served at `/`; immutable HTML at /_og/v/<versionId>. */
    versionId: z.string().uuid().nullable(),
    title: z.string(),
    noindex: z.boolean(),
    /** Monotonic per hostname; a writer never replaces a newer generation. */
    generation: z.number().int().nonnegative(),
    updatedAt: z.string(),
  }),
);
export type SiteHostMapRecord = z.infer<typeof SiteHostMapRecord>;

export function siteHostMapKey(hostname: string): string {
  return `host:${hostname.toLowerCase()}`;
}

export * from "./site-operations";

// ---------------------------------------------------------------------------
// Bridge additions (protocol v2, additive)
// ---------------------------------------------------------------------------

/**
 * Additional MessagePort bridge request methods, served by both hosts:
 * - `viewer`: returns SiteViewer (console: the signed-in member).
 * - `auth.signIn`: asks the host to sign the viewer in. The gateway shell
 *   navigates the top window to /_og/auth/login; the console resolves
 *   immediately because its viewer is already signed in. Returns
 *   `{ started: boolean }`.
 * The ready message advertises them with `viewer: 1`.
 */
export const SITE_BRIDGE_VIEWER_METHOD = "viewer" as const;
export const SITE_BRIDGE_SIGN_IN_METHOD = "auth.signIn" as const;
