// Claude's account routes on the shared subscription core (design
// docs/design/subscription-core-2026-10-07.md, 5.3 "Claude track", C2b).
// Dormant: every caller first reads the organization's `claude` provider
// route (`claudeCoreRoute`); without the Claude cutover receipt it is
// `legacy` and the legacy handlers run unchanged.
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  connectSubscriptionCoreClaudeConnection,
  getSubscriptionCoreClaudeOrganizationProjection,
  getSubscriptionCoreClaudeWorkspaceProjection,
  namedSubjectPersonalWorkspaceId,
  SUBSCRIPTION_CORE_CLAUDE,
  type Database,
  type SubscriptionCoreClaudeAccount,
  type SubscriptionCoreClaudeConnectResult,
} from "@opengeni/db";
import {
  canonicalConnectionId,
  coreConnectRefused,
  subscriptionCoreRoute,
  type SubscriptionPoolCore,
} from "./routes/subscription-pool-core";

/** The runtime serving Claude for the organization (one receipt read; maintenance is a typed 503). */
export const claudeCoreRoute = (deps: ApiRouteDeps, accountId: () => Promise<string>) =>
  subscriptionCoreRoute(deps, "claude", "Claude", accountId);

/** Claude on the shared core for the neutral pool routes. */
export function claudePoolCore(
  accountJson: (account: SubscriptionCoreClaudeAccount, activeId: string | null) => object,
): SubscriptionPoolCore {
  return {
    binding: SUBSCRIPTION_CORE_CLAUDE,
    workspaceProjection: getSubscriptionCoreClaudeWorkspaceProjection,
    organizationProjection: getSubscriptionCoreClaudeOrganizationProjection,
    accountJson: (account, activeId) => {
      const claude = account as SubscriptionCoreClaudeAccount;
      // The legacy listing's usage fields, from the core quota reading.
      return {
        ...accountJson(claude, activeId),
        usage: claude.usage,
        ...(claude.usage.refreshStatus === "reconnect"
          ? { status: "needs_relogin", lastError: "Sign in to Claude again." }
          : {}),
      };
    },
  };
}

type ClaudeCoreScope = { accountId: string; workspaceId: string | null; subjectId: string };

/**
 * The account a reconnect names, as this caller's listing shows it: a legacy
 * id resolves through the cutover aliases; personal accounts only to their
 * owner in their Personal workspace. Null when the caller cannot see it.
 */
export async function claudeCoreAccount(
  deps: ApiRouteDeps,
  scope: ClaudeCoreScope,
  routeId: string,
): Promise<SubscriptionCoreClaudeAccount | null> {
  const id = await canonicalConnectionId(deps, SUBSCRIPTION_CORE_CLAUDE, { ...scope, routeId });
  const projection = scope.workspaceId
    ? await getSubscriptionCoreClaudeWorkspaceProjection(deps.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        viewerSubjectId: scope.subjectId,
      })
    : await getSubscriptionCoreClaudeOrganizationProjection(deps.db, {
        organizationId: scope.accountId,
        subjectId: scope.subjectId,
      });
  return projection.accounts.find((account) => account.id === id) ?? null;
}

/**
 * A private (`user`) Claude account is connected on the core only in the
 * person's own Personal workspace (strictest reading of the personal rule);
 * elsewhere, including any shared workspace, it is refused before a sign-in
 * starts. The connect writer checks the same rule with the exact owner
 * membership and authority generation in its transaction.
 */
export async function requireClaudeCorePersonalWorkspace(
  deps: ApiRouteDeps,
  scope: { accountId: string; workspaceId: string | null; subjectId: string },
): Promise<void> {
  const own = scope.subjectId.startsWith("user:")
    ? await namedSubjectPersonalWorkspaceId(deps.db, scope)
    : null;
  if (own === null || own !== scope.workspaceId)
    throw new HTTPException(403, {
      message: "Connect a private Claude account from your own Personal workspace.",
    });
}

/** The legacy response for a refused core Claude connect. */
export function claudeCoreConnectRefused(
  result: Extract<SubscriptionCoreClaudeConnectResult, { kind: "refused" }>,
  personal: boolean,
  changedMessage: string,
): HTTPException | ReturnType<typeof coreConnectRefused> {
  if (result.reason === "different_account")
    return new HTTPException(409, {
      message:
        "Sign in to the same Claude account to reconnect. Use Add account for a different subscription.",
    });
  if (result.reason === "changed") return new HTTPException(409, { message: changedMessage });
  if (result.reason === "forbidden" && personal)
    return new HTTPException(403, {
      message: "Connect a private Claude account from your own Personal workspace.",
    });
  return coreConnectRefused(result.reason, "Claude", personal);
}

/** Connect through the neutral writer; throws the legacy refusal, returns the connection. */
export async function connectClaudeCore(
  db: Database,
  input: Parameters<typeof connectSubscriptionCoreClaudeConnection>[1],
  changedMessage: string,
) {
  const result = await connectSubscriptionCoreClaudeConnection(db, input);
  if (result.kind === "refused")
    throw claudeCoreConnectRefused(result, input.personal === true, changedMessage);
  // The Claude writer always asks for the version (the legacy credential version).
  if (result.version === undefined) throw new Error("core Claude connect reported no version");
  return { id: result.id, version: result.version, wake: result.wake };
}
