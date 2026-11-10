import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { secretValue } from "./secret-value";
import { z } from "zod";
import { IntegrationInstanceKey, IntegrationSource } from "./index";
import { PreparedMcpSetup } from "./prepared-mcp-setup";

export { PreparedMcpSetup, preparedMcpHeaders } from "./prepared-mcp-setup";

const opaqueId = /* @__PURE__ */ defineSchema(() => z.string().min(1).max(512));
/**
 * More provider access asked for when reconnecting an existing account, for
 * example the Gmail permission a later tool call needs. The server bounds it by
 * the reviewed connector's own permission list; it can never widen past it.
 */
const ConnectRequestedScopes = /* @__PURE__ */ defineSchema(() =>
  z.array(z.string().min(1).max(512)).min(1).max(16),
);
const PROVIDERS_ACCEPTING_REQUESTED_SCOPES = new Set([
  "mcp-oauth",
  "slack-personal",
  "gmail",
  "google-drive",
  "google-calendar",
]);
/**
 * Whether a reconnect of this Connect provider may carry `requestedScopes`.
 * Other providers keep their fixed permission set and reject the field.
 */
export function connectProviderAcceptsRequestedScopes(providerId: string): boolean {
  return PROVIDERS_ACCEPTING_REQUESTED_SCOPES.has(providerId);
}
export const ConnectOwnership = /* @__PURE__ */ defineSchema(() =>
  z.enum(["personal", "workspace"]),
);
export type ConnectOwnership = z.infer<typeof ConnectOwnership>;
export const ConnectProvider = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: opaqueId,
      label: z.string().min(1).max(256),
      family: opaqueId,
      readiness: z.enum(["available", "needs_configuration", "operator_only", "unsupported"]),
      reason: z.string().max(1024).optional(),
      ownership: z.array(ConnectOwnership).max(2),
      setup: z
        .array(
          z.enum(["none", "oauth", "credentials", "device", "installation", "openapi", "graphql"]),
        )
        .max(7),
    })
    .strict(),
);
export type ConnectProvider = z.infer<typeof ConnectProvider>;
export const ConnectAccount = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: opaqueId,
      providerId: opaqueId,
      version: z.number().int().positive().optional(),
      label: z.string().max(256),
      ownership: ConnectOwnership,
      status: z.enum(["connected", "auth_needed", "disabled"]),
    })
    .strict(),
);
export type ConnectAccount = z.infer<typeof ConnectAccount>;
export const ConnectResource = /* @__PURE__ */ defineSchema(() =>
  z.object({ id: opaqueId, label: z.string().max(512), kind: opaqueId }).strict(),
);
export type ConnectResource = z.infer<typeof ConnectResource>;
export const ConnectNextAction = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("authorize"),
        url: z.string().url().max(16_384),
        /**
         * Where the person's organization approves the app once for everyone,
         * covering every service this workspace connects through it (Microsoft
         * work accounts). Absent when the provider has no organization approval.
         */
        organizationApprovalUrl: z.string().url().max(16_384).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("credentials"),
        fields: z
          .array(
            z
              .object({
                name: opaqueId,
                label: z.string().max(256),
                required: primitives.boolean,
                secret: primitives.boolean,
                options: z
                  .array(z.object({ value: opaqueId, label: z.string().max(512) }).strict())
                  .max(1000)
                  .optional(),
              })
              .strict(),
          )
          .max(32),
      })
      .strict(),
    z
      .object({
        type: z.literal("wait"),
        pollAfterMs: z.number().int().min(250).max(60_000),
        userCode: z.string().max(128).optional(),
        verificationUrl: z.string().url().max(2048).optional(),
      })
      .strict(),
    z
      .object({ type: z.literal("select_account"), accounts: z.array(ConnectAccount).max(100) })
      .strict(),
    z
      .object({
        type: z.literal("select_resources"),
        resources: z.array(ConnectResource).max(100),
        cursor: z.string().max(2048).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("preview"),
        previewId: opaqueId,
        contentHash: opaqueId,
        operations: z.array(ConnectResource).max(2000),
      })
      .strict(),
    z.object({ type: z.literal("none") }).strict(),
  ]),
);
export type ConnectNextAction = z.infer<typeof ConnectNextAction>;
export const ConnectInstallationTarget = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      instanceKey: IntegrationInstanceKey,
      displayName: z.string().min(1).max(200),
      expectedInstanceVersion: z.number().int().positive().optional(),
    })
    .strict(),
);
export type ConnectInstallationTarget = z.infer<typeof ConnectInstallationTarget>;
export const ConnectAttemptState = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "ready",
    "requires_user_action",
    "credential_input",
    "provider_wait",
    "account_selection",
    "resource_selection",
    "preview",
    "installing",
    "connected_but_incomplete",
    "complete",
    "cancelled",
    "expired",
    "failed",
    "uncertain",
  ]),
);
export const ConnectAttempt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: opaqueId,
      workspaceId: opaqueId,
      providerId: opaqueId,
      ownership: ConnectOwnership,
      revision: primitives.positiveInteger,
      state: ConnectAttemptState,
      credentialsCommitted: primitives.boolean,
      integrationInstalled: primitives.boolean,
      completionRequirement: z.enum(["connection", "integration", "provider_setup"]),
      nextAction: ConnectNextAction,
      expiresAt: primitives.string.datetime({ offset: true }),
      account: ConnectAccount.optional(),
      installationTarget: ConnectInstallationTarget.optional(),
      source: IntegrationSource.optional(),
      mcpSetup: PreparedMcpSetup.optional(),
      /** Exact installed catalog identity after a verified prepared MCP setup. */
      mcpCapabilityId: opaqueId.optional(),
      /** Additional access this reconnect asks the provider for. */
      requestedScopes: ConnectRequestedScopes.optional(),
      error: z
        .object({ code: opaqueId, message: z.string().max(2048), retryable: primitives.boolean })
        .strict()
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.state === "complete" &&
        value.completionRequirement === "integration" &&
        !value.integrationInstalled
      ) {
        context.addIssue({
          code: "custom",
          message: "Complete setup requires an installed integration",
        });
      }
      if (
        value.state === "complete" &&
        value.completionRequirement === "connection" &&
        !value.credentialsCommitted
      ) {
        context.addIssue({
          code: "custom",
          message: "Connection setup requires committed credentials",
        });
      }
      if (
        ["complete", "cancelled", "expired"].includes(value.state) &&
        value.nextAction.type !== "none"
      ) {
        context.addIssue({ code: "custom", message: "A terminal setup has no next action" });
      }
    }),
);
export type ConnectAttempt = z.infer<typeof ConnectAttempt>;
export const ConnectAdvance = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("credentials"),
        values: secretValue(z.record(z.string().max(256), z.string().max(16_384))),
      })
      .strict(),
    z.object({ type: z.literal("account"), accountId: opaqueId }).strict(),
    z.object({ type: z.literal("resources"), resourceIds: z.array(opaqueId).max(1000) }).strict(),
    z
      .object({
        type: z.literal("install"),
        previewId: opaqueId,
        contentHash: opaqueId,
        operationIds: z.array(opaqueId).max(2000),
      })
      .strict(),
    z.object({ type: z.literal("retry") }).strict(),
  ]),
);
export type ConnectAdvance = z.infer<typeof ConnectAdvance>;
export const ConnectOperationRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedRevision: primitives.positiveInteger.safe(),
      idempotencyKey: opaqueId,
    })
    .strict(),
);
export const AdvanceConnectRequest = /* @__PURE__ */ defineSchema(() =>
  ConnectOperationRequest.extend({ action: ConnectAdvance }),
);
export const BeginConnectRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      providerId: opaqueId,
      ownership: ConnectOwnership,
      // URL parsing validates separately; never transform this original string.
      returnUrl: z.string().min(1).max(4096),
      /**
       * Sign-in runs in a popup window the client opened for it. The provider
       * then returns that window to a small Opengeni page that closes it (or
       * says it can be closed) instead of loading `returnUrl`, so the popup
       * never shows a second copy of the host page. The client follows the
       * attempt's state as usual.
       */
      finishInPopup: z.literal(true).optional(),
      idempotencyKey: opaqueId,
      reconnectAccountId: opaqueId.optional(),
      installationTarget: ConnectInstallationTarget.optional(),
      mcpSetup: PreparedMcpSetup.optional(),
      /** Additional access to ask for; only meaningful with `reconnectAccountId`. */
      requestedScopes: ConnectRequestedScopes.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.mcpSetup && value.providerId !== "mcp-headers")
        context.addIssue({
          code: "custom",
          path: ["mcpSetup"],
          message: "Prepared header setup requires the MCP headers provider",
        });
      if (value.requestedScopes && !value.reconnectAccountId)
        context.addIssue({
          code: "custom",
          path: ["requestedScopes"],
          message: "Additional access can only be requested when reconnecting an account",
        });
    }),
);
export type BeginConnectRequest = z.infer<typeof BeginConnectRequest>;

/**
 * Organizations can require an administrator to approve an app before their
 * people may connect it (Microsoft Entra consent policies, Google Workspace
 * API controls). The provider then stops the person on its own page and may
 * never send them back. These helpers derive what an administrator needs from
 * the sign-in URL itself, so any sign-in can offer it without provider
 * configuration. Nothing here is secret: a sign-in URL's client ID, redirect
 * and scopes are public; its state and PKCE challenge are never copied.
 */
export type OrganizationAppApproval = {
  /** A link an administrator opens to approve the app for the whole organization, when the provider has one. */
  approvalUrl: string | null;
  /** The app's OAuth client ID, which administrators use to find and allow an app. */
  appId: string;
};

/** State on the Microsoft approval link, so the shared callback can tell an administrator's return from a sign-in. */
export const MICROSOFT_ADMIN_CONSENT_STATE = "microsoft_admin_consent";

const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com";
const MICROSOFT_GRAPH_RESOURCE = "https://graph.microsoft.com";
const OPENID_SCOPES = new Set(["offline_access", "openid", "profile", "email"]);

/**
 * Microsoft's organization-wide admin consent link for an app's delegated Graph
 * permissions. `tenant` defaults to `organizations`: the administrator's own
 * sign-in picks their organization.
 */
export function microsoftAdminConsentUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  tenant?: string | undefined;
}): string {
  const scopes = input.scopes
    .filter((scope) => !OPENID_SCOPES.has(scope))
    .map((scope) => (scope.includes("://") ? scope : `${MICROSOFT_GRAPH_RESOURCE}/${scope}`));
  const url = new URL(
    `${MICROSOFT_LOGIN_ORIGIN}/${encodeURIComponent(input.tenant ?? "organizations")}/v2.0/adminconsent`,
  );
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", MICROSOFT_ADMIN_CONSENT_STATE);
  return url.toString();
}

/**
 * What an organization's administrator needs to approve the app a sign-in URL
 * asks for, or null when the provider has no organization approval (or the URL
 * is not a provider sign-in it recognizes). `organizationApprovalUrl` is the
 * server's link covering every service of the app (the sign-in step's
 * `organizationApprovalUrl`); without it the link covers this sign-in's scopes.
 */
export function organizationAppApproval(
  authorizeUrl: string,
  organizationApprovalUrl?: string | undefined,
): OrganizationAppApproval | null {
  let url: URL;
  try {
    url = new URL(authorizeUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const appId = url.searchParams.get("client_id")?.trim();
  if (!appId || appId.length > 256) return null;
  if (url.origin === MICROSOFT_LOGIN_ORIGIN) {
    const tenant = /^\/([^/]+)\/oauth2\/v2\.0\/authorize$/.exec(url.pathname)?.[1];
    const redirectUri = url.searchParams.get("redirect_uri");
    // Personal Microsoft accounts have no organization to approve anything.
    if (!tenant || tenant === "consumers" || !redirectUri) return null;
    return {
      approvalUrl:
        microsoftApprovalLinkFor(organizationApprovalUrl, appId) ??
        microsoftAdminConsentUrl({
          clientId: appId,
          redirectUri,
          scopes: (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean),
          tenant: tenant === "common" ? "organizations" : tenant,
        }),
      appId,
    };
  }
  // Google Workspace administrators allow an app by its client ID.
  if (url.origin === "https://accounts.google.com") return { approvalUrl: null, appId };
  return null;
}

/** The given link when it is Microsoft's admin consent for this same app. */
function microsoftApprovalLinkFor(link: string | undefined, appId: string): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.origin === MICROSOFT_LOGIN_ORIGIN &&
      /^\/[^/]+\/v2\.0\/adminconsent$/.test(url.pathname) &&
      url.searchParams.get("client_id") === appId
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
