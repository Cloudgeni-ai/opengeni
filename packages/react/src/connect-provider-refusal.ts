// Plain words for a service that refused a connection's OAuth setup, from the
// provider's own error (`error`, `error_description`). The API passes it on
// both when setup starts (the error's `details`) and when the sign-in comes
// back (the attempt's error code). No DOM.
import {
  OAUTH_PROVIDER_REFUSALS,
  oauthProviderErrorDescription,
  oauthProviderRefusal,
  type OAuthProviderRefusal,
} from "@opengeni/contracts/connect";
import type { ConnectAttempt } from "@opengeni/connect";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { OpenGeniText } from "./messages/runtime";

function refusalText(t: OpenGeniText, refusal: OAuthProviderRefusal): string {
  switch (refusal) {
    case "app_not_allowed":
      return t("sessionMcpCapabilityCard.serviceAllowsApprovedAppsOnly");
    case "access_not_accepted":
      return t("sessionMcpCapabilityCard.serviceRefusedTheAccess");
    case "provider_unavailable":
      return t("sessionMcpCapabilityCard.serviceCouldNotFinishSignIn");
  }
}

/**
 * What to tell the person when starting setup failed because the service
 * refused it, or null for any other failure (which keeps the card's plain
 * line). A refusal with no plainer wording shows the service's own reason.
 */
export function setupRefusalText(t: OpenGeniText, failure: unknown): string | null {
  if (!(failure instanceof OpenGeniApiError) || !failure.details) return null;
  const details = failure.details;
  const refusal = OAUTH_PROVIDER_REFUSALS.find((value) => value === details.providerRefusal);
  if (refusal) return refusalText(t, refusal);
  const code = typeof details.providerError === "string" ? details.providerError : null;
  const known = oauthProviderRefusal(code);
  if (known) return refusalText(t, known);
  const reason = oauthProviderErrorDescription(details.providerErrorDescription) ?? code;
  return reason ? t("sessionMcpCapabilityCard.serviceSaid", { reason }) : null;
}

/**
 * What to tell the person when a sign-in came back refused by the service
 * with a reason it has plain words for, or null.
 */
export function signInRefusalText(
  t: OpenGeniText,
  attempt: Pick<ConnectAttempt, "error"> | null | undefined,
): string | null {
  const refusal = oauthProviderRefusal(attempt?.error?.code);
  return refusal ? refusalText(t, refusal) : null;
}
