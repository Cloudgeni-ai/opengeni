import type { CodexAccountOverview, CodexUsage } from "@opengeni/sdk";

/** One Codex account's usage as its list row and its page both show it. */
export type CodexOverviewUsage = CodexUsage & {
  /**
   * Why the live check failed ("needs_relogin", "unavailable", ...), or null.
   * The reading is then the account's last saved one, when it has one.
   */
  checkError: string | null;
  /** Where the reading came from. */
  source: CodexAccountOverview["usage"]["source"];
};

/**
 * The one reading of an account overview's usage, for every Codex surface (an
 * organization or workspace list row, the account's page, the session account
 * switcher). When the live check fails the overview still carries the last
 * saved reading, and that reading is shown everywhere: the usage is
 * "unavailable" only when there is no reading at all. The page says that the
 * check failed and when the reading was saved.
 */
export function codexOverviewUsage(usage: CodexAccountOverview["usage"]): CodexOverviewUsage {
  const value = usage.value ?? null;
  return {
    status: value?.status ?? (usage.error ? "error" : "no-data"),
    usage: value,
    checkError: usage.error,
    source: usage.source,
  };
}
