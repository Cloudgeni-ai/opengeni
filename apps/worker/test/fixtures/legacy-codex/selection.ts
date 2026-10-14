/** TEST ONLY: historical Codex regression fixture, snapshot 8c43a921512078d302f671ae590d43645669f88d. Never import from production. */
import { connectionModelAllowed, type CodexCredentialLeaseSessionState, type CodexCredentialLeaseSelectionContext } from "@opengeni/db";

import { type Settings } from "@opengeni/config";



import { loadCodexAccountsLackingModel } from "../../../../../packages/core/test/fixtures/legacy-codex-model-availability";



import { selectCodexCredentialLeaseForTurn } from "./rotation";





import type { TurnActivityServices as ActivityServices } from "../../../src/activities/types";















import { createLogThrottle, type LogThrottle } from "@opengeni/observability";











export const CODEX_POOL_LOW_WARNING_INTERVAL_MS = 10 * 60_000;

export const CODEX_MODEL_SUPPORT_LOOKUP_TIMEOUT_MS = 2_000;

export async function codexAccountsLackingTurnModel(
  db: ActivityServices["db"],
  settings: Settings,
  workspaceId: string,
  upstreamModelId: string | null | undefined,
  lookup: typeof loadCodexAccountsLackingModel = loadCodexAccountsLackingModel,
  timeoutMs = CODEX_MODEL_SUPPORT_LOOKUP_TIMEOUT_MS,
): Promise<Set<string>> {
  if (!upstreamModelId) return new Set();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(db, settings, workspaceId, upstreamModelId),
      new Promise<Set<string>>((resolve) => {
        timer = setTimeout(() => resolve(new Set()), timeoutMs);
      }),
    ]);
  } catch {
    return new Set();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function selectCodexTurnAccount(input: {
  context: CodexCredentialLeaseSelectionContext;
  session: CodexCredentialLeaseSessionState;
  sessionId: string;
  productModelId: string;
  lackingModel: ReadonlySet<string>;
}) {
  const { context, session: lockedSessionCodexState } = input;
  const allowed = context.accounts.filter((account) =>
    connectionModelAllowed(account.allowedModelIds, input.productModelId),
  );
  if (context.accounts.length > 0 && allowed.length === 0)
    throw new Error("This model is disabled for the connected Codex subscriptions");
  const sessionPin = lockedSessionCodexState.pinnedCredentialId;
  if (
    sessionPin &&
    lockedSessionCodexState.pinSource !== "policy" &&
    context.accounts.some((account) => account.id === sessionPin) &&
    !allowed.some((account) => account.id === sessionPin)
  )
    throw new Error("This model is disabled for the pinned Codex subscription");
  // An explicit session pin is honored as is; otherwise prefer accounts
  // that serve the model, keeping the full list when none is known to.
  const explicitPin = Boolean(sessionPin && lockedSessionCodexState.pinSource !== "policy");
  const serving = allowed.filter((account) => !input.lackingModel.has(account.id));
  const candidates = explicitPin || serving.length === 0 ? allowed : serving;
  return selectCodexCredentialLeaseForTurn({
    // The accepted product model also scopes proven plan entitlement:
    // an account whose current plan excludes it is not a candidate.
    context: {
      ...context,
      accounts: candidates,
      modelId: input.productModelId,
    },
    sessionId: input.sessionId,
    sessionPinnedCredentialId: lockedSessionCodexState.pinnedCredentialId,
    sessionPinSource: lockedSessionCodexState.pinSource,
    sessionLastCredentialId: lockedSessionCodexState.lastCredentialId,
    now: new Date(),
  });
}

const codexPoolLowWarningThrottle = createLogThrottle({
  intervalMs: CODEX_POOL_LOW_WARNING_INTERVAL_MS,
  maxKeys: 1_024,
});

export function warnCodexPoolLow(
  observability: Pick<ActivityServices["observability"], "warn">,
  input: {
    workspaceKey: string;
    workspaceId: string;
    eligibleCount: number;
    connectedCount: number;
    depth: "zero" | "one";
  },
  throttle: LogThrottle = codexPoolLowWarningThrottle,
): void {
  const admission = throttle.admit(`${input.workspaceKey}:${input.depth}`);
  if (!admission) return;
  observability.warn("Codex eligible credential pool is low", {
    workspaceId: input.workspaceId,
    eligibleCount: input.eligibleCount,
    connectedCount: input.connectedCount,
    depth: input.depth,
    reason: input.depth === "zero" ? "eligible_pool_zero" : "eligible_pool_one",
    ...(admission.suppressedCount > 0 ? { suppressedCount: admission.suppressedCount } : {}),
  });
}
