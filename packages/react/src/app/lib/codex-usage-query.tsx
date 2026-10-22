/**
 * The console's private seam to the Codex account and live-usage cache keys
 * inside `@opengeni/react`, used by Settings > Models and its Codex sign-in.
 *
 * These live apart from `./shared-query` on purpose: that module is startup
 * code, and re-exporting the Codex hooks from it routes their whole module
 * graph (the provider, session context and site HTTP contracts) into the web
 * console's startup chunks.
 */
export {
  codexAccountsQueryKey,
  codexLiveUsageQueryKey,
  recordCodexLiveUsage,
  type CodexLiveUsageSnapshot,
} from "../../hooks/use-codex-accounts";
