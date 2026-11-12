// Claude usage routes on the shared subscription core (design 5.3, Claude
// track C2a, EP-N24 and EP-S13). The usage routes read the organization's
// Claude provider route once after authentication: missing or disabled
// receipts answer a typed 503; `core` projects the connection's quota in the legacy
// `ClaudeSubscriptionUsage` shape. Paths, auth checks and cache headers are
// the legacy ones. A refresh reads live: a shared connection of the
// workspace's pool through the core connection seam, the caller's own
// personal connection in their own Personal workspace through the owner-only
// seam, and an organization-pool connection on the organization route
// through the administrator seam (design 5.3, C2c).
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  ClaimClaudeLimitResetRequest,
  ClaimClaudeLimitResetResponse,
  ClaudeSubscriptionUsage,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  claimSubscriptionCoreClaudeOrganizationLimitReset,
  claimSubscriptionCoreClaudeWorkspaceLimitReset,
  deliverSubscriptionCoreProviderWake,
  projectSubscriptionCoreClaudeUsage,
  readSubscriptionCoreClaudeOrganizationUsageRow,
  readSubscriptionCoreClaudeWorkspaceUsageTarget,
  refreshSubscriptionCoreClaudeOrganizationUsage,
  refreshSubscriptionCoreClaudeWorkspaceUsage,
} from "@opengeni/db";
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
 * Wake the Claude core waiters after a reading that ended a stored
 * exhaustion. The reading already committed; a failed wake hint never fails
 * the read (every core waiter has its own recheck).
 */
async function wakeAfterRecovery(
  deps: ApiRouteDeps,
  accountId: string,
  result: { usage: ClaudeSubscriptionUsage; recovered: boolean },
): Promise<ClaudeSubscriptionUsage> {
  if (result.recovered) {
    await deliverSubscriptionCoreProviderWake(deps.db, "claude", {
      accountId,
      reason: "usage_recovered",
    }).catch(() => undefined);
  }
  return result.usage;
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
    if (!mutation) return projectSubscriptionCoreClaudeUsage(row);
    return await wakeAfterRecovery(
      deps,
      caller.accountId,
      await refreshSubscriptionCoreClaudeOrganizationUsage(
        deps.db,
        deps.settings,
        { organizationId: caller.accountId, subjectId: caller.subjectId, row },
        deps.claudeFetch ? { fetchImpl: deps.claudeFetch } : {},
      ),
    );
  }
  const workspaceId = caller.workspaceId;
  const target = await readSubscriptionCoreClaudeWorkspaceUsageTarget(deps.db, {
    accountId: caller.accountId,
    workspaceId,
    subjectId: caller.subjectId,
    accountIdParam: caller.accountIdParam,
  });
  if (!target) throw new HTTPException(404, { message: "Claude account not found" });
  // The legacy authority checks, by the scope the connection maps to. A
  // personal connection lives only in its owner's own Personal workspace on
  // the core (D-03), so its verified owner is checked there, never through
  // the legacy ordinary-workspace membership rule (which no Personal
  // workspace passes).
  if (target.scope === "user")
    await requirePrivateSubscriptionHuman(c, deps, workspaceId, "Claude", "personal_workspace");
  if (!mutation) return projectSubscriptionCoreClaudeUsage(target.row);
  await requireSubscriptionScopeMutation(
    c,
    deps,
    workspaceId,
    target.scope,
    "Claude",
    "personal_workspace",
  );
  return await wakeAfterRecovery(
    deps,
    caller.accountId,
    await refreshSubscriptionCoreClaudeWorkspaceUsage(
      deps.db,
      deps.settings,
      { accountId: caller.accountId, workspaceId, subjectId: caller.subjectId, target },
      deps.claudeFetch ? { fetchImpl: deps.claudeFetch } : {},
    ),
  );
}

/**
 * Claim one limit reset grant of a Claude account, then read its usage.
 * The same authority as a live refresh: an organization administrator on
 * the organization route; on a workspace route, whoever may change the
 * connection's scope (the owner of a personal connection, a workspace
 * administrator for the workspace's own accounts). Waiting turns are woken
 * when the read after the claim ended a stored block.
 */
export async function coreClaudeLimitResetClaim(
  c: Context,
  deps: ApiRouteDeps,
  caller: CoreClaudeUsageCaller,
  input: ClaimClaudeLimitResetRequest,
): Promise<ClaimClaudeLimitResetResponse> {
  const fetchDeps = deps.claudeFetch ? { fetchImpl: deps.claudeFetch } : {};
  if (caller.workspaceId === null) {
    const row = await readSubscriptionCoreClaudeOrganizationUsageRow(deps.db, {
      organizationId: caller.accountId,
      subjectId: caller.subjectId,
      accountIdParam: caller.accountIdParam,
    });
    if (!row) throw new HTTPException(404, { message: "Claude account not found" });
    const outcome = await claimSubscriptionCoreClaudeOrganizationLimitReset(
      deps.db,
      deps.settings,
      { organizationId: caller.accountId, subjectId: caller.subjectId, row, ...input },
      fetchDeps,
    );
    return {
      claim: outcome.claim,
      usage: await wakeAfterRecovery(deps, caller.accountId, outcome),
    };
  }
  const workspaceId = caller.workspaceId;
  const target = await readSubscriptionCoreClaudeWorkspaceUsageTarget(deps.db, {
    accountId: caller.accountId,
    workspaceId,
    subjectId: caller.subjectId,
    accountIdParam: caller.accountIdParam,
  });
  if (!target) throw new HTTPException(404, { message: "Claude account not found" });
  if (target.scope === "user")
    await requirePrivateSubscriptionHuman(c, deps, workspaceId, "Claude", "personal_workspace");
  await requireSubscriptionScopeMutation(
    c,
    deps,
    workspaceId,
    target.scope,
    "Claude",
    "personal_workspace",
  );
  const outcome = await claimSubscriptionCoreClaudeWorkspaceLimitReset(
    deps.db,
    deps.settings,
    { accountId: caller.accountId, workspaceId, subjectId: caller.subjectId, target, ...input },
    fetchDeps,
  );
  return { claim: outcome.claim, usage: await wakeAfterRecovery(deps, caller.accountId, outcome) };
}
