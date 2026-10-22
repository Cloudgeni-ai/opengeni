// Claude's account routes on the shared subscription core (design
// docs/design/subscription-core-2026-10-07.md, 5.3 "Claude track", C2b).
// Every caller requires the organization's Claude cutover receipt. Missing
// or disabled receipts fail closed; legacy tables are never a runtime fallback.
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
  deliverPoolCoreWake,
  requireSubscriptionCoreRoute,
  type SubscriptionPoolCore,
} from "./routes/subscription-pool-core";

/** The runtime serving Claude for the organization (one receipt read; maintenance is a typed 503). */
export const claudeCoreRoute = (deps: ApiRouteDeps, accountId: () => Promise<string>) =>
  requireSubscriptionCoreRoute(deps, "claude", "Claude", accountId);

/** Deliver a core Claude wake after commit (best effort, as every pool wake). */
export const deliverClaudeCoreWake = (
  deps: ApiRouteDeps,
  wake: Parameters<typeof deliverPoolCoreWake>[2],
) => deliverPoolCoreWake(deps, { binding: SUBSCRIPTION_CORE_CLAUDE }, wake);

/**
 * Claude on the shared core for the neutral pool routes. The listings add
 * the legacy usage reading beside the account (`listedAccountJson`); every
 * other route answers the plain legacy `accountJson`.
 */
export function claudePoolCore(
  accountJson: (account: SubscriptionCoreClaudeAccount, activeId: string | null) => object,
): SubscriptionPoolCore {
  return {
    binding: SUBSCRIPTION_CORE_CLAUDE,
    workspaceProjection: getSubscriptionCoreClaudeWorkspaceProjection,
    organizationProjection: getSubscriptionCoreClaudeOrganizationProjection,
    listedAccountJson: (account, activeId) => {
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
 * id resolves through the cutover aliases as the caller may see them
 * (`canonicalConnectionId`, which resolves a personal account's legacy id
 * only for its owner in their Personal workspace). Null when the caller's
 * listing does not show it.
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

/** What a person who cannot reconnect this way is told to do instead. */
const RECONNECT_REFUSED: Record<
  "different_account" | "setup_token_over_sign_in" | "sign_in_over_unverified",
  string
> = {
  different_account:
    "Sign in to the same Claude account to reconnect. Use Add account for a different subscription.",
  setup_token_over_sign_in:
    "A setup token can't replace a signed-in Claude account. Add it as a new account.",
  sign_in_over_unverified:
    "This account was added without a verified sign-in. Add it again with Sign in, then remove the old one.",
};

/** The legacy response for a refused core Claude connect. */
export function claudeCoreConnectRefused(
  result: Extract<SubscriptionCoreClaudeConnectResult, { kind: "refused" }>,
  personal: boolean,
  changedMessage: string,
): HTTPException | ReturnType<typeof coreConnectRefused> {
  if (
    result.reason === "different_account" ||
    result.reason === "setup_token_over_sign_in" ||
    result.reason === "sign_in_over_unverified"
  )
    return new HTTPException(409, { message: RECONNECT_REFUSED[result.reason] });
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
