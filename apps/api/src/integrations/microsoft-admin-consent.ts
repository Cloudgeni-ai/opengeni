import type { IntegrationDefinition } from "@opengeni/capabilities";
import { htmlPageResponse } from "../http/html-page-security";
import {
  MICROSOFT_ADMIN_CONSENT_STATE,
  microsoftAdminConsentUrl as adminConsentUrl,
} from "@opengeni/contracts/connect";

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

/** Result page an administrator lands on after the approval link. */
export function microsoftAdminConsentResultPage(query: {
  adminConsent?: string | undefined;
  error?: string | undefined;
}): Response {
  const granted = query.adminConsent?.toLowerCase() === "true" && !query.error;
  const title = granted ? "Approved" : "Not approved";
  const body = granted
    ? "People in your organization can now connect their Microsoft 365 accounts. Ask them to connect again."
    : "Microsoft did not record an approval. Open the approval link again with a Microsoft 365 administrator account.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5;color:#1f2328}h1{font-size:1.4rem}</style></head><body><h1>${title}</h1><p>${body}</p><p>You can close this window.</p></body></html>`;
  return htmlPageResponse(html, { status: granted ? 200 : 400 });
}
