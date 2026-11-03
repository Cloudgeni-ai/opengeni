import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { OrganizationAccessPolicy } from "./organization-access";

/* ----------------------------------------------------------------------------
   Auto-connect (MCP Enterprise-Managed Authorization,
   `io.modelcontextprotocol/enterprise-managed-authorization`).

   An Identity Assertion JWT Authorization Grant (ID-JAG,
   draft-ietf-oauth-identity-assertion-authz-grant) is a short-lived JWT an
   identity issuer signs for one person and one MCP client. The client trades
   it at the MCP server's authorization server (RFC 7523 JWT bearer grant) for
   an access token, with no sign-in screen and no refresh token.

   Both directions are supported:
   - Inbound: an organization trusts an issuer (Claude's per-organization
     issuer, or its own identity provider), and its members are connected to
     the organization MCP server (`/v1/mcp`) the first time their AI app uses
     it. These are "trusted issuers".
   - Outbound: Opengeni is the issuer. An organization connector set to
     `auto_connect` connects each member to an outside MCP app the first time
     they use it, once the app trusts the organization's Opengeni issuer.
   -------------------------------------------------------------------------- */

/** The MCP extension both sides implement. */
export const ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION =
  "io.modelcontextprotocol/enterprise-managed-authorization" as const;
/** RFC 7523 JWT bearer grant type, used to redeem an ID-JAG. */
export const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer" as const;
/** RFC 8693 token exchange grant type, used to request an ID-JAG from an issuer. */
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange" as const;
/** `authorization_grant_profiles_supported` value for the ID-JAG profile. */
export const ID_JAG_GRANT_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag" as const;
/** Token type an issuer advertises in `identity_chaining_requested_token_types_supported`. */
export const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag" as const;
/** The JWT `typ` header every ID-JAG carries. */
export const ID_JAG_JWT_TYPE = "oauth-id-jag+jwt" as const;
/** How long an ID-JAG Opengeni issues stays valid. */
export const ID_JAG_LIFETIME_SECONDS = 5 * 60;
/** The longest ID-JAG lifetime Opengeni accepts from an issuer (exp - iat). */
export const ID_JAG_MAX_ACCEPTED_LIFETIME_SECONDS = 60 * 60;
/** Clock skew tolerated on iat/exp. */
export const ID_JAG_CLOCK_SKEW_SECONDS = 60;

/* --------------------------- Inbound: trusted issuers --------------------------- */

/**
 * Which kind of issuer this is. Only the setup guidance differs; every issuer
 * is validated the same way.
 */
export const McpTrustedIssuerProvider = /* @__PURE__ */ defineSchema(() =>
  z.enum(["claude", "okta", "other"]),
);
export type McpTrustedIssuerProvider = z.infer<typeof McpTrustedIssuerProvider>;

/** Why an auto-connect attempt was refused, as shown to organization admins. */
export const McpAutoConnectRefusalReason = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "malformed",
    "wrong_type",
    "issuer_disabled",
    "signature_invalid",
    "keys_unavailable",
    "wrong_audience",
    "wrong_resource",
    "client_mismatch",
    "client_not_allowed",
    "unknown_client",
    "expired",
    "replayed",
    "email_unverified",
    "no_matching_member",
    "several_organizations",
  ]),
);
export type McpAutoConnectRefusalReason = z.infer<typeof McpAutoConnectRefusalReason>;

/** Same values as CapabilityInstallationStatus; kept unnamed so the API surface names one. */
const trustedIssuerStatus = () => z.enum(["active", "disabled"]);
export type McpTrustedIssuerStatus = "active" | "disabled";

const IssuerUrl = /* @__PURE__ */ defineSchema(() =>
  primitives.string
    .trim()
    .url()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" ||
            (url.protocol === "http:" &&
              (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "Use the issuer's https URL, without a query or fragment"),
);

const ClientIds = /* @__PURE__ */ defineSchema(() =>
  z
    .array(primitives.string.trim().min(1).max(256))
    .max(20)
    .refine((values) => new Set(values).size === values.length, "Duplicate client IDs"),
);

export const McpTrustedIssuer = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    organizationId: primitives.uuid,
    name: primitives.string,
    provider: McpTrustedIssuerProvider,
    issuer: primitives.string,
    /** Set only when an admin gave the key set URL instead of letting it be discovered. */
    jwksUri: primitives.nullableString,
    /** The apps this issuer may connect, or null for any app it vouches for. */
    allowedClientIds: z.array(primitives.string).nullable(),
    /** What every auto-connected app can do, and where. Never more than each person can. */
    access: OrganizationAccessPolicy,
    status: trustedIssuerStatus(),
    /** People this issuer has connected at least once. */
    connectedPeople: primitives.nonnegativeInteger,
    lastConnectedAt: primitives.nullableString,
    /** The most recent refusal, when it is newer than the last connection. */
    lastRefusal: z
      .object({ reason: McpAutoConnectRefusalReason, at: primitives.string })
      .nullable(),
    createdAt: primitives.string,
    updatedAt: primitives.string,
  }),
);
export type McpTrustedIssuer = z.infer<typeof McpTrustedIssuer>;

export const ListMcpTrustedIssuersResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    trustedIssuers: z.array(McpTrustedIssuer),
    /** The organization MCP server URL to give the app. */
    mcpUrl: primitives.string,
    /** The authorization server issuer an ID-JAG must name as its audience. */
    audience: primitives.string,
  }),
);
export type ListMcpTrustedIssuersResponse = z.infer<typeof ListMcpTrustedIssuersResponse>;

export const CreateMcpTrustedIssuerRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: primitives.string.trim().min(1).max(80),
      provider: McpTrustedIssuerProvider,
      issuer: IssuerUrl,
      jwksUri: IssuerUrl.nullable().optional(),
      allowedClientIds: ClientIds.nullable().optional(),
      access: OrganizationAccessPolicy,
    })
    .strict(),
);
export type CreateMcpTrustedIssuerRequest = z.infer<typeof CreateMcpTrustedIssuerRequest>;

export const UpdateMcpTrustedIssuerRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: primitives.string.trim().min(1).max(80).optional(),
      jwksUri: IssuerUrl.nullable().optional(),
      allowedClientIds: ClientIds.nullable().optional(),
      access: OrganizationAccessPolicy.optional(),
      status: trustedIssuerStatus().optional(),
    })
    .strict(),
);
export type UpdateMcpTrustedIssuerRequest = z.infer<typeof UpdateMcpTrustedIssuerRequest>;

/** Look an issuer up before trusting it: where its keys are and whether they load. */
export const CheckMcpTrustedIssuerRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ issuer: IssuerUrl, jwksUri: IssuerUrl.nullable().optional() }).strict(),
);
export type CheckMcpTrustedIssuerRequest = z.infer<typeof CheckMcpTrustedIssuerRequest>;

export const CheckMcpTrustedIssuerResponse = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      issuer: primitives.string,
      jwksUri: primitives.string,
      /** Signing keys the issuer publishes. */
      keyCount: primitives.positiveInteger,
      algorithms: z.array(primitives.string),
    }),
    z.object({
      status: z.literal("failed"),
      issuer: primitives.string,
      /** Plain words for the admin, never the issuer's own response text. */
      message: primitives.string,
    }),
  ]),
);
export type CheckMcpTrustedIssuerResponse = z.infer<typeof CheckMcpTrustedIssuerResponse>;

/** One recent auto-connect attempt for a trusted issuer. */
export const McpTrustedIssuerEvent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    outcome: z.enum(["connected", "refused"]),
    reason: McpAutoConnectRefusalReason.nullable(),
    /** The member it connected, when it matched one. */
    person: z.object({ subjectId: primitives.string, name: primitives.string }).nullable(),
    /** The email the issuer asserted, when it sent one. */
    email: primitives.nullableString,
    clientName: primitives.nullableString,
    at: primitives.string,
  }),
);
export type McpTrustedIssuerEvent = z.infer<typeof McpTrustedIssuerEvent>;

export const ListMcpTrustedIssuerEventsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ events: z.array(McpTrustedIssuerEvent) }),
);
export type ListMcpTrustedIssuerEventsResponse = z.infer<typeof ListMcpTrustedIssuerEventsResponse>;

/* ------------------------- Outbound: Opengeni as issuer ------------------------- */

/**
 * The organization's Opengeni issuer: what an outside app needs to trust it.
 * The issuer exists once an admin turns on auto-connect for any connector.
 */
export const OrganizationIdentityIssuer = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** The issuer URL to paste into an app's "ID-JAG issuer" (or "trusted issuer") setting. */
    issuer: primitives.string,
    jwksUri: primitives.string,
    /** Opengeni's client ID: its Client ID Metadata Document URL. */
    clientId: primitives.string,
    createdAt: primitives.string,
  }),
);
export type OrganizationIdentityIssuer = z.infer<typeof OrganizationIdentityIssuer>;

/** An organization connector's auto-connect setup: where it redeems and how it last went. */
export const OrganizationConnectorAutoConnect = /* @__PURE__ */ defineSchema(() =>
  z.object({
    issuer: primitives.string,
    /** The app's authorization server, the audience of every ID-JAG. */
    authorizationServer: primitives.string,
    /** Opengeni's client ID at that authorization server. */
    clientId: primitives.string,
    /** When a test or a member's connection last succeeded. */
    verifiedAt: primitives.nullableString,
    /** The app's answer the last time it refused, in plain words. */
    lastError: z.object({ message: primitives.string, at: primitives.string }).nullable(),
  }),
);
export type OrganizationConnectorAutoConnect = z.infer<typeof OrganizationConnectorAutoConnect>;

/** Result of trying auto-connect as the admin who asks. */
export const TestOrganizationConnectorAutoConnectResponse = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("connected"),
      autoConnect: OrganizationConnectorAutoConnect,
      /** The connector's generation after the outcome was saved. */
      generation: primitives.positiveInteger,
    }),
    z.object({
      status: z.literal("refused"),
      message: primitives.string,
      autoConnect: OrganizationConnectorAutoConnect,
      generation: primitives.positiveInteger,
    }),
  ]),
);
export type TestOrganizationConnectorAutoConnectResponse = z.infer<
  typeof TestOrganizationConnectorAutoConnectResponse
>;

/** What the app advertises: whether it can redeem Opengeni's ID-JAGs at all. */
export const AutoConnectSupport = /* @__PURE__ */ defineSchema(() =>
  z.object({
    supported: primitives.boolean,
    authorizationServer: primitives.nullableString,
    /** Why it can't, in plain words; null when supported. */
    reason: primitives.nullableString,
    /**
     * Whether the app reads Opengeni's Client ID Metadata Document. When it
     * doesn't, the admin enters the client ID the app gave Opengeni.
     */
    clientIdMetadataDocumentSupported: primitives.boolean,
    /** The client ID Opengeni uses when the app reads its document. */
    opengeniClientId: primitives.nullableString,
  }),
);
export type AutoConnectSupport = z.infer<typeof AutoConnectSupport>;
