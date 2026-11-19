// The words of the connection-recovery row: who it is about, what the person
// can do and what happens afterwards. Renderer-neutral, so the web row and the
// React Native row say the same thing; no DOM here.
import type { OpenGeniText } from "./messages/runtime";
import type { AuthNeededItem } from "./timeline/types";
import { connectorProviderDomain } from "@opengeni/contracts/nango";

export type AuthNeededPresentation = {
  /** A calm human name: the agent's capability name or the provider's. */
  provider: string;
  title: string;
  /** Why the row is here, or the agent's reason for asking. */
  reasonLine: string;
  /** The button's words: Connect, Review or Reconnect (only for a lapsed connection). */
  actionLabel: string;
  /** The button's words while its sign-in is open ("Waiting for Google…"). */
  pendingLabel: string;
  /** What the card says once the person finished it ("Allowed"). */
  doneLabel: string;
  /**
   * A connected account is asked to allow one more kind of action (OAuth
   * step-up). Repeats of the same ask show one card.
   */
  moreAccess: boolean;
  /** "Provider: example.com" under an agent's request, otherwise null. */
  providerLine: string | null;
  /** The variables an agent's request needs, otherwise null. */
  variablesLine: string | null;
  /** What happens next, or null when the tools are unavailable anyway. */
  footnote: string | null;
  /** The tools cannot run here at all; no action is offered. */
  unavailable: boolean;
  /** A first-time connection rather than a lapsed one. */
  missing: boolean;
  /** A pre-minted link the host or server provides, when one may be offered. */
  authorizationUrl: string | null;
  /** Whether the row's own action may start recovery (never for host-managed or unavailable). */
  canRecover: boolean;
  /** "Couldn't start connecting Provider. Try again." after a failed start. */
  startFailed: string;
};

const UNAVAILABLE_REASONS = new Set<AuthNeededItem["reason"]>([
  "personal_authority_unavailable",
  "unsupported_auth",
  "resource_scope_unavailable",
  "account_scope_fixed",
]);

/**
 * Plain words for access a reviewed connector asks for later (incremental
 * consent): the action it allows, for the title, and what that includes.
 */
type AdditionalAccess = {
  action:
    | "messageTimeline.accessOrganizeProvider"
    | "messageTimeline.accessWriteAndSendFromProvider";
  includes:
    | "messageTimeline.accessOrganizeMailboxIncludes"
    | "messageTimeline.accessWriteAndSendIncludes";
};
const ADDITIONAL_ACCESS: Record<string, AdditionalAccess> = {
  "https://www.googleapis.com/auth/gmail.compose": {
    action: "messageTimeline.accessWriteAndSendFromProvider",
    includes: "messageTimeline.accessWriteAndSendIncludes",
  },
  "https://www.googleapis.com/auth/gmail.modify": {
    action: "messageTimeline.accessOrganizeProvider",
    includes: "messageTimeline.accessOrganizeMailboxIncludes",
  },
};

/**
 * Who shows the consent page for a scope, by the scope's host: Google's
 * scopes are approved at Google, whichever Google service needs them.
 */
const CONSENT_HOSTS: ReadonlyArray<readonly [suffix: string, name: string]> = [
  ["googleapis.com", "Google"],
  ["google.com", "Google"],
  ["microsoft.com", "Microsoft"],
  ["microsoftonline.com", "Microsoft"],
];

function consentName(scopes: readonly string[]): string | null {
  for (const scope of scopes) {
    let host: string;
    try {
      host = new URL(scope).hostname.toLowerCase();
    } catch {
      continue;
    }
    const match = CONSENT_HOSTS.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`));
    if (match) return match[1];
  }
  return null;
}

/**
 * How an approval names access its account still lacks: who asks for it (the
 * consent page's owner, "Google") and the line saying so ("Google will ask you
 * to allow Opengeni to organize your Gmail (one time).").
 */
export function accessNeededWording(
  t: OpenGeniText,
  access: { providerDomain: string; scopes: readonly string[] },
): { consent: string; line: string; missingLine: string } {
  const provider = providerLabel(t, access.providerDomain);
  const consent = consentName(access.scopes) ?? provider;
  const known = [...new Set(access.scopes.flatMap((scope) => ADDITIONAL_ACCESS[scope] ?? []))];
  return {
    consent,
    // For a surface that can't ask the provider itself: running the action
    // then asks in the chat.
    missingLine: t("approvalSurface.accessStillMissing", { provider }),
    line:
      known.length > 0
        ? t("approvalSurface.consentAsksFirst", {
            consent,
            access: known
              .map((entry) => t(entry.action, { provider }))
              .join(t("messageTimeline.accessJoin")),
          })
        : t("approvalSurface.consentAsksFirstMoreAccess", { consent, provider }),
  };
}

/** Service names for connection identities whose domain says nothing to a person. */
const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  "gmailmcp.googleapis.com": "Gmail",
  "drivemcp.googleapis.com": "Google Drive",
  "calendarmcp.googleapis.com": "Google Calendar",
};

/**
 * The connection an agent's capability card asks to reconnect: one of the
 * person's accounts that stopped working (its provider rejected the saved
 * sign-in). Undefined for a first connection.
 */
export function capabilityReconnectConnectionId(item: AuthNeededItem): string | undefined {
  return item.capability &&
    item.connectionId &&
    (item.reason === "expired" || item.reason === "refresh_failed")
    ? item.connectionId
    : undefined;
}

/**
 * Present one auth notice. `setupUnavailable`: this person cannot set an
 * agent's request up from here, so say so instead of offering a review.
 */
export function authNeededPresentation(
  t: OpenGeniText,
  item: AuthNeededItem,
  options: { setupUnavailable?: boolean | undefined } = {},
): AuthNeededPresentation {
  const recommendation = item.capability ?? null;
  const provider =
    recommendation?.name ??
    item.setupRequest?.name ??
    (item.serverId === "codex_apps"
      ? t("messageTimeline.codexApps")
      : providerLabel(t, item.providerDomain));
  const unavailable = UNAVAILABLE_REASONS.has(item.reason);
  const missing = item.reason === "missing_connection";
  // An agent's request to set something up is a first connection: never
  // "reconnect", which only fits an account that was connected before; unless
  // the agent asked to reconnect one exact account that stopped working.
  const reconnect = capabilityReconnectConnectionId(item) !== undefined;
  const request = reconnect ? null : (recommendation ?? item.setupRequest ?? null);
  // A connected account that needs more access is asked to allow it, not to
  // "reconnect": nothing lapsed.
  const moreAccess = !request && item.reason === "insufficient_scope" && !!item.connectionId;
  const access = moreAccess
    ? [...new Set(item.scopes.flatMap((scope) => ADDITIONAL_ACCESS[scope] ?? []))]
    : [];
  // The step-up opens the provider's own consent page: the button says so.
  const consent = moreAccess ? (consentName(item.scopes) ?? provider) : provider;
  // A plugin is installed for the workspace, not connected to an account.
  const plugin = recommendation?.kind === "plugin";
  const actionLabel = reconnect
    ? t("messageTimeline.reconnect")
    : recommendation
      ? recommendation.action === "connect"
        ? t("messageTimeline.connect")
        : t("messageTimeline.review")
      : missing || request
        ? t("messageTimeline.connect")
        : moreAccess
          ? t("messageTimeline.allowInConsent", { consent })
          : t("messageTimeline.reconnect");
  const title = reconnect
    ? `${actionLabel} ${provider}`
    : recommendation
      ? plugin
        ? t("messageTimeline.installProvider", { provider })
        : recommendation.action === "connect"
          ? t("messageTimeline.connectProvider", { provider })
          : recommendation.action === "add_credentials"
            ? t("messageTimeline.setUpProvider", { provider })
            : t("messageTimeline.enableProvider", { provider })
      : item.setupRequest
        ? t("messageTimeline.setUpProvider", { provider })
        : item.reason === "account_scope_fixed"
          ? t("messageTimeline.providerCantDoThisWithAccount", { provider })
          : unavailable
            ? t("messageTimeline.providerToolsUnavailable", { provider })
            : moreAccess
              ? access.length > 0
                ? t("messageTimeline.allowProductTo", {
                    access: access
                      .map((entry) => t(entry.action, { provider }))
                      .join(t("messageTimeline.accessJoin")),
                  })
                : t("messageTimeline.allowProductMoreProviderAccess", { provider })
              : `${actionLabel} ${provider}`;
  // A step-up says what the new kind of action includes, and that the
  // person's approval settings still decide what runs without asking: the
  // provider's permission is what Opengeni can do, not what runs on its own.
  const reasonLine =
    recommendation?.rationale ??
    item.setupRequest?.rationale ??
    (moreAccess
      ? [
          ...(access.length > 0
            ? access.map((entry) => t(entry.includes))
            : [t("messageTimeline.accessOneMoreKindOfAction", { consent })]),
          t("messageTimeline.accessApprovalSettingsStillDecide"),
        ].join(" ")
      : authReasonLine(t, item.reason));
  const hostManaged = item.authoritySource === "host";
  const firstTime = missing || !!request;
  return {
    provider,
    title,
    reasonLine,
    actionLabel,
    pendingLabel: moreAccess
      ? t("messageTimeline.waitingForConsent", { consent })
      : t("messageTimeline.opening"),
    doneLabel: moreAccess
      ? t("messageTimeline.allowed")
      : firstTime
        ? t("messageTimeline.connected")
        : t("messageTimeline.reconnected"),
    moreAccess,
    providerLine: request
      ? t("messageTimeline.providerProviderdomain", { providerDomain: item.providerDomain })
      : null,
    variablesLine:
      recommendation && recommendation.requiredVariables.length > 0
        ? t("messageTimeline.needsVariablesJoin", {
            join: recommendation.requiredVariables.join(", "),
          })
        : null,
    footnote: unavailable
      ? null
      : request && options.setupUnavailable
        ? t(
            plugin
              ? "messageTimeline.pluginSetupUnavailableHere"
              : "messageTimeline.setupUnavailableHere",
            { provider },
          )
        : request
          ? t("messageTimeline.noAccessHasBeenGranted")
          : t(
              missing
                ? "messageTimeline.toolCallNotReplayedAfterConnecting"
                : moreAccess
                  ? "messageTimeline.agentCarriesOnAfterAllowing"
                  : "messageTimeline.toolCallNotReplayedAfterReconnecting",
            ),
    unavailable,
    missing: firstTime,
    authorizationUrl: hostManaged
      ? (item.authorizationUrl ?? null)
      : unavailable
        ? null
        : (item.authorizationUrl ?? null),
    canRecover: !hostManaged && !unavailable,
    startFailed: `${t("messageTimeline.couldnTStart")} ${
      firstTime ? t("messageTimeline.connecting") : t("messageTimeline.reconnecting")
    } ${t("messageTimeline.providerTryAgain", { provider })}`,
  };
}

/** "linear.app" -> "Linear": the first domain label, capitalized. A calm human
    name for the provider — never the raw domain shown as a label. */
export function providerLabel(t: OpenGeniText, domain: string): string {
  // An integration platform's domain ("nango:gmail") names the connector it
  // serves ("gmailmcp.googleapis.com").
  const host =
    connectorProviderDomain(domain)
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0] ?? "";
  const known = KNOWN_PROVIDER_NAMES[host.toLowerCase()];
  if (known) return known;
  const first = host.split(".")[0] ?? host;
  if (!first) {
    return t("messageTimeline.thisService");
  }
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** A calm, human helper line per reauth reason — the `reason` informs the copy
    but is never rendered as a raw enum/code. */
export function authReasonLine(t: OpenGeniText, reason: AuthNeededItem["reason"]): string {
  switch (reason) {
    case "insufficient_scope":
      return t("messageTimeline.itNeedsAdditionalAccessTo");
    case "missing_connection":
      return t("messageTimeline.itIsnTConnectedYet");
    case "expired":
    case "refresh_failed":
      return t("messageTimeline.itsAccessExpired");
    case "personal_authority_unavailable":
      return t("messageTimeline.thisAutomationWasNotGranted");
    case "unsupported_auth":
      return t("messageTimeline.thisConnectionCannotAuthenticateThe");
    case "resource_scope_unavailable":
      return t("messageTimeline.thisToolEndpointCannotEnforce");
    case "account_scope_fixed":
      return t("messageTimeline.connectedAccountLacksThisAccess");
    default:
      return t("messageTimeline.itsConnectionNeedsAttention");
  }
}
