/**
 * The typed codes a stopped Site tool call reaches Site code with, and the
 * viewer's sentence for each. Shared by the Opengeni frame's bridge and the
 * published-host shell, which has no Opengeni frame.
 */

/**
 * Why a Site's tool call didn't complete, as the viewer and Site code see it.
 * Site code reads the same `code` on the error (or on the result's
 * `structuredContent.error` for a provider's refusal).
 * - `site_tool_reconnect_required`: the viewer's connection must sign in again.
 * - `site_tool_permission_denied`: the provider refused it for the viewer's account.
 * - `site_tool_not_available_for_viewer`: the Site's tool can't run for this viewer.
 * - `site_tool_blocked`: tool permissions block it on the viewer's account.
 * - `site_tool_open_in_opengeni`: it needs the viewer to confirm in Opengeni
 *   (a published address has no Opengeni frame).
 * - `site_tool_upstream_unavailable`: the tool's server couldn't be reached and
 *   nothing was sent; trying again is safe.
 * - `site_tool_outcome_unknown`: it may have run; check before trying again.
 * - `site_tool_unavailable`: anything else that stopped it.
 */
export type SiteToolFailureCode =
  | "site_tool_reconnect_required"
  | "site_tool_permission_denied"
  | "site_tool_not_available_for_viewer"
  | "site_tool_blocked"
  | "site_tool_open_in_opengeni"
  | "site_tool_upstream_unavailable"
  | "site_tool_outcome_unknown"
  | "site_tool_unavailable";
/**
 * Server answers that already say what the viewer can do next, by the API's
 * `details.code`, as the Site's typed code. Nothing ran for any of them.
 */
export const SITE_TOOL_TYPED_ANSWERS: Readonly<
  Record<string, { code: SiteToolFailureCode; retryable: boolean }>
> = Object.freeze({
  tool_blocked: { code: "site_tool_blocked", retryable: false },
  site_tool_consent_requires_opengeni: { code: "site_tool_open_in_opengeni", retryable: false },
  // Retryable only while the server says nothing was sent (outcomeUnknown false).
  tool_server_unreachable: { code: "site_tool_upstream_unavailable", retryable: true },
});

/** The viewer's sentence for a failure; it names the system when known. */
export function siteToolFailureMessage(code: SiteToolFailureCode, system: string | null): string {
  switch (code) {
    case "site_tool_reconnect_required":
      return system ? `Sign in to ${system} again to continue.` : "Sign in again to continue.";
    case "site_tool_permission_denied":
      return system
        ? `${system} didn't allow this for your account.`
        : "This wasn't allowed for your account.";
    case "site_tool_not_available_for_viewer":
      return "This isn't available to you on this Site.";
    case "site_tool_blocked":
      return system
        ? `Your ${system} tool permissions don't allow this.`
        : "Your tool permissions don't allow this.";
    case "site_tool_open_in_opengeni":
      return "Open this Site in Opengeni to do this.";
    case "site_tool_upstream_unavailable":
      return system
        ? `Couldn't reach ${system}. Nothing was sent.`
        : "Couldn't reach the service. Nothing was sent.";
    case "site_tool_outcome_unknown":
      return system
        ? `Couldn't confirm this finished. Check ${system} before trying again.`
        : "Couldn't confirm this finished. Check before trying again.";
    case "site_tool_unavailable":
      return system ? `Couldn't get this from ${system}.` : "This didn't work.";
  }
}
