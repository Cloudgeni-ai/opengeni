// The words of the connection-recovery row: who it is about, what the person
// can do and what happens afterwards. Renderer-neutral, so the web row and the
// React Native row say the same thing; no DOM here.
import type { OpenGeniText } from "./messages/runtime";
import type { AuthNeededItem } from "./timeline";

export type AuthNeededPresentation = {
  /** A calm human name: the agent's capability name or the provider's. */
  provider: string;
  title: string;
  /** Why the row is here, or the agent's reason for asking. */
  reasonLine: string;
  /** The button's words: Connect, Review or Reconnect (only for a lapsed connection). */
  actionLabel: string;
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
]);

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
  // "reconnect", which only fits an account that was connected before.
  const request = recommendation ?? item.setupRequest ?? null;
  const actionLabel = recommendation
    ? recommendation.action === "connect"
      ? t("messageTimeline.connect")
      : t("messageTimeline.review")
    : missing || request
      ? t("messageTimeline.connect")
      : t("messageTimeline.reconnect");
  const title = recommendation
    ? recommendation.action === "connect"
      ? t("messageTimeline.connectProvider", { provider })
      : recommendation.action === "add_credentials"
        ? t("messageTimeline.setUpProvider", { provider })
        : t("messageTimeline.enableProvider", { provider })
    : item.setupRequest
      ? t("messageTimeline.setUpProvider", { provider })
      : unavailable
        ? t("messageTimeline.providerToolsUnavailable", { provider })
        : `${actionLabel} ${provider}`;
  const reasonLine =
    recommendation?.rationale ?? item.setupRequest?.rationale ?? authReasonLine(t, item.reason);
  const hostManaged = item.authoritySource === "host";
  const firstTime = missing || !!request;
  return {
    provider,
    title,
    reasonLine,
    actionLabel,
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
        ? t("messageTimeline.setupUnavailableHere", { provider })
        : request
          ? t("messageTimeline.noAccessHasBeenGranted")
          : t(
              missing
                ? "messageTimeline.toolCallNotReplayedAfterConnecting"
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
  const host =
    domain
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0] ?? "";
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
    default:
      return t("messageTimeline.itsConnectionNeedsAttention");
  }
}
