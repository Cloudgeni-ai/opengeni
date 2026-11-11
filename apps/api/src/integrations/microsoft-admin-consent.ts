import type { IntegrationDefinition } from "@opengeni/capabilities";
import type { ConnectResultPageText } from "@opengeni/config";
import {
  MICROSOFT_ADMIN_CONSENT_STATE,
  microsoftAdminConsentUrl as adminConsentUrl,
} from "@opengeni/contracts/connect";
import { connectResultPage } from "./connect-finished-page";

/**
 * Microsoft 365 organizations can require an administrator to approve an app
 * before a user may grant it mail, calendar or contacts access (the default
 * Microsoft-managed consent policy does this for Exchange data). Microsoft then
 * shows its own "Need admin approval" page and, when the user returns, sends
 * the callback an error instead of a code. These helpers turn that dead end
 * into an approval link the user can pass to their administrator.
 */

/** State value that marks the admin-consent round trip on the shared callback. */
export { MICROSOFT_ADMIN_CONSENT_STATE };

// AADSTS65001 consent missing, 90093/90094/90095 the user may not grant these
// permissions and an administrator has to.
const ADMIN_REQUIRED_CODES = /AADSTS(65001|90093|90094|90095)\b/;

/**
 * Organization-wide approval link an administrator opens to approve the app,
 * for the Graph permissions of every given definition at once, so approving
 * mail also covers calendar and a person adding it later needs no new approval.
 */
export function microsoftAdminConsentUrl(input: {
  clientId: string;
  redirectUri: string;
  definitions: readonly IntegrationDefinition[];
}): string {
  return adminConsentUrl({
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scopes: [
      ...new Set(input.definitions.flatMap((definition) => definition.authentication.scopes)),
    ],
  });
}

/** True when Microsoft says only an administrator can grant the requested access. */
export function microsoftAdminConsentRequired(error: string, description?: string): boolean {
  if (error === "consent_required") return true;
  return ADMIN_REQUIRED_CODES.test(description ?? "");
}

/** Connect-attempt failure for a Microsoft authorization that returned without a code. */
export function microsoftAuthorizationNotGranted(input: {
  error: string;
  description?: string | undefined;
  adminConsentUrl: string;
}): {
  state: "cancelled" | "failed";
  error: { code: string; message: string; retryable: boolean };
} {
  if (microsoftAdminConsentRequired(input.error, input.description)) {
    return {
      state: "failed",
      error: {
        code: "admin_consent_required",
        message: `Your organization requires a Microsoft 365 administrator to approve this app first. Send your administrator this approval link: ${input.adminConsentUrl} After they approve, connect again.`,
        retryable: true,
      },
    };
  }
  // Microsoft reports a user who left its "Need admin approval" page the same
  // way as a user who pressed Cancel, so the approval link is offered for both.
  return {
    state: input.error === "access_denied" ? "cancelled" : "failed",
    error: {
      code: "provider_denied",
      message: `Microsoft did not grant access. If Microsoft said your organization needs an administrator to approve this app, send your administrator this approval link: ${input.adminConsentUrl} After they approve, connect again.`,
      retryable: true,
    },
  };
}

/**
 * Result page an administrator lands on after the approval link, in the
 * deployment's words (`OPENGENI_CONNECT_RESULT_PAGE_TEXT_JSON`).
 */
export function microsoftAdminConsentResultPage(
  query: {
    adminConsent?: string | undefined;
    error?: string | undefined;
  },
  text: ConnectResultPageText = {},
): Response {
  const granted = query.adminConsent?.toLowerCase() === "true" && !query.error;
  return connectResultPage({
    text,
    status: granted ? 200 : 400,
    title: granted
      ? (text.adminApprovedTitle ?? "Approved")
      : (text.adminNotApprovedTitle ?? "Not approved"),
    lines: [
      granted
        ? (text.adminApprovedBody ??
          "People in your organization can now connect their Microsoft 365 accounts. Ask them to connect again.")
        : (text.adminNotApprovedBody ??
          "Microsoft did not record an approval. Open the approval link again with a Microsoft 365 administrator account."),
      text.closeWindow ?? "You can close this window.",
    ],
  });
}
