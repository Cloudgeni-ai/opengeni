import type { SiteViewer } from "@opengeni/contracts";

/** Per-page data the gateway embeds in the shell as inert JSON (`#og-shell-config`). */
export type ShellConfig = {
  /** Known when the gateway already confirmed a site session; otherwise fetched on demand. */
  viewer: SiteViewer | null;
  /** Set only when Turnstile is configured. */
  turnstileSiteKey: string | null;
};

/** API error code that asks the shell to run the optional human check. */
export const SITE_HUMAN_CHECK_REQUIRED = "site_human_check_required";
export const SITE_GATEWAY_HUMAN_PATH = "/_og/human";
