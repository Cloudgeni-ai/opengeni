// Claude usage routes on the shared subscription core (design 5.3, Claude
// track C2a, EP-N24 and EP-S13). The usage routes read the organization's
// Claude provider route once after authentication: `legacy` (no cutover
// receipt) runs the legacy handlers unchanged, `maintenance` answers a typed
// 503, and `core` projects the connection's core quota in the legacy
// `ClaudeSubscriptionUsage` shape. Paths, auth checks and cache headers are
// the legacy ones.
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  deliverSubscriptionCoreProviderWake,
  projectSubscriptionCoreClaudeUsage,
  readSubscriptionCoreClaudeOrganizationUsageRow,
  readSubscriptionCoreClaudeWorkspaceUsageTarget,
  readSubscriptionCoreProviderRouteForWorkspace,
  refreshSubscriptionCoreClaudeWorkspaceUsage,
  type SubscriptionCoreClaudeUsageRow,
} from "@opengeni/db";
import { ApiHttpError } from "../http/api-error";
import { SUBSCRIPTION_CORE_CUTOVER_DISABLED } from "./codex-core";
import {
  requirePrivateSubscriptionHuman,
  requireSubscriptionScopeMutation,
} from "./subscription-pool-access";

/** An authenticated usage caller whose organization serves Claude from the core. */
export type CoreClaudeUsageCaller = {
  core: true;
  accountId: string;
  /** Null on the organization path. */
  workspaceId: string | null;
  subjectId: string;
  /** The route's account id: a canonical connection id or a cutover alias. */
  accountIdParam: string;
};

/**
 * Claude's provider route for one authenticated usage caller: `legacy` or
 * `core`; maintenance fails closed with the typed 503 the Codex routes use.
 */
export async function claudeUsageRoute(
  deps: ApiRouteDeps,
  accountId: string,
  workspaceId: string | null,
): Promise<"legacy" | "core"> {
  const route = await readSubscriptionCoreProviderRouteForWorkspace(deps.db, {
    accountId,
    workspaceId,
    provider: "claude",
  });
  if (route === "maintenance") {
    throw new ApiHttpError(503, {
      code: "upstream_unavailable",
      message: "Claude subscriptions are paused for maintenance in this organization",
      retryable: true,
      outcomeUnknown: false,
      details: { reason: SUBSCRIPTION_CORE_CUTOVER_DISABLED },
    });
  }
  return route;
}

/**
 * The stored projection of a connection this context cannot read live (a
 * personal connection, or the organization path, which has no workspace
 * context for the credential seam). Nothing is refreshed: like the Codex
 * core usage routes, an unreadable connection reports no new data, and its
 * refresh status is `unavailable` (never `available` for a read that did not
 * happen), unless the connection itself needs a new sign-in or lacks the
 * usage scope.
 */
function unreadableUsage(row: SubscriptionCoreClaudeUsageRow): ClaudeSubscriptionUsage {
  const stored = projectSubscriptionCoreClaudeUsage(row);
  return stored.refreshStatus === "reconnect" || stored.refreshStatus === "scope_required"
    ? stored
    : projectSubscriptionCoreClaudeUsage(row, { status: "unavailable", checkedAt: null });
}

/** GET or POST refresh of one Claude account's usage on the core. */
export async function coreClaudeUsage(
  c: Context,
  deps: ApiRouteDeps,
  caller: CoreClaudeUsageCaller,
  mutation: boolean,
): Promise<ClaudeSubscriptionUsage> {
  if (caller.workspaceId === null) {
    const row = await readSubscriptionCoreClaudeOrganizationUsageRow(deps.db, {
      organizationId: caller.accountId,
      subjectId: caller.subjectId,
      accountIdParam: caller.accountIdParam,
    });
    if (!row) throw new HTTPException(404, { message: "Claude account not found" });
    return mutation ? unreadableUsage(row) : projectSubscriptionCoreClaudeUsage(row);
  }
  const workspaceId = caller.workspaceId;
  const target = await readSubscriptionCoreClaudeWorkspaceUsageTarget(deps.db, {
    accountId: caller.accountId,
    workspaceId,
    subjectId: caller.subjectId,
    accountIdParam: caller.accountIdParam,
  });
  if (!target) throw new HTTPException(404, { message: "Claude account not found" });
  // The legacy authority checks, by the scope the connection maps to.
  if (target.scope === "user")
    await requirePrivateSubscriptionHuman(c, deps, workspaceId, "Claude");
  if (!mutation) return projectSubscriptionCoreClaudeUsage(target.row);
  await requireSubscriptionScopeMutation(c, deps, workspaceId, target.scope, "Claude");
  if (target.scope === "user") return unreadableUsage(target.row);
  const { usage, recovered } = await refreshSubscriptionCoreClaudeWorkspaceUsage(
    deps.db,
    deps.settings,
    {
      accountId: caller.accountId,
      workspaceId,
      subjectId: caller.subjectId,
      target,
    },
    deps.claudeFetch ? { fetchImpl: deps.claudeFetch } : {},
  );
  if (recovered) {
    // The reading already committed; a failed wake hint never fails the read
    // (every core waiter has its own recheck).
    await deliverSubscriptionCoreProviderWake(deps.db, "claude", {
      accountId: caller.accountId,
      reason: "usage_recovered",
    }).catch(() => undefined);
  }
  return usage;
}
