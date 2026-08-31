import {
  listCodexAccountStatuses,
  fetchCodexUsageForAccount,
  type CodexAccountStatus,
} from "@opengeni/db";
import { type RegistryProviderKind, type Settings } from "@opengeni/config";
import { codexAccountNeedsLiveCapacityRefresh } from "../codex-rotation";
import {
  refreshCodexUsageAndRepairCapacityWaiters,
  signalPendingCodexCapacityWakeTargets,
} from "../codex-capacity";
import type { TurnActivityServices as ActivityServices } from "../types";
import { createHash } from "node:crypto";

export function codexWorkspaceMetricKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
}

/** Stable public request identity across partial resumes and activity retries. */
export function acceptsPromptCacheKeyForTurn(
  resolvedModel: {
    provider: { kind: RegistryProviderKind; builtin?: boolean };
  } | null,
): boolean {
  if (!resolvedModel) {
    return true;
  }
  return (
    resolvedModel.provider.builtin === true || resolvedModel.provider.kind === "codex-subscription"
  );
}

/**
 * SELF-HEAL helper for the all-capped rotation idle (invariant 4: BOUNDED, no thrash).
 * The turn hot path never refreshes Codex usage — only the usage API route does — so a
 * window that has actually reset still reads OVER-threshold from the stale cache, which
 * would idle-loop forever. Before idling, refresh LIVE usage for every connected account
 * the cache marks exhausted (bounded to the account count), which re-writes the
 * cache columns, then return the re-read rows so the ranker can pick up a genuinely-reset
 * window THIS turn. Typed quota cooldowns are also refreshed because the provider may
 * replace an allowance cycle before its original reset; revision fencing makes that
 * repair safe. Generic backpressure and legacy-unknown cooldowns are never reconciled.
 * A refresh/read failure is swallowed (fall back to the pre-refresh rows + bounded idle).
 */
export async function refreshCappedCodexUsageRows(
  db: ActivityServices["db"],
  settings: Settings,
  workspaceId: string,
  accounts: Array<
    Pick<
      CodexAccountStatus,
      | "id"
      | "status"
      | "primaryUsedPercent"
      | "secondaryUsedPercent"
      | "exhaustedUntil"
      | "exhaustedKind"
    >
  >,
  capacitySignals: {
    signalCodexCapacityWorkflow?: ActivityServices["signalCodexCapacityWorkflow"] | undefined;
    wakeSessionWorkflow: ActivityServices["wakeSessionWorkflow"];
  },
): Promise<
  Array<
    Pick<
      CodexAccountStatus,
      | "id"
      | "status"
      | "primaryUsedPercent"
      | "secondaryUsedPercent"
      | "exhaustedUntil"
      | "exhaustedKind"
    >
  >
> {
  const now = new Date();
  const stale = accounts.filter(
    (account) => account.status === "active" && codexAccountNeedsLiveCapacityRefresh(account, now),
  );
  if (stale.length === 0) {
    return accounts;
  }
  await refreshCodexUsageAndRepairCapacityWaiters(
    stale.map((account) => () => fetchCodexUsageForAccount(db, settings, workspaceId, account.id)),
    () => signalPendingCodexCapacityWakeTargets({ db, ...capacitySignals }, workspaceId),
  );
  return listCodexAccountStatuses(db, workspaceId).catch(() => accounts);
}

/**
 * True once the lifetime last confirmed by Postgres is no longer trustworthy.
 * A missing or malformed deadline fails closed for a holder that claims to be
 * leased; callers check this before accepting an in-flight heartbeat promise.
 */
export function codexCredentialLeaseDeadlineExpired(
  confirmedUntilMs: number | null,
  nowMs: number = performance.now(),
): boolean {
  return (
    confirmedUntilMs === null || !Number.isFinite(confirmedUntilMs) || confirmedUntilMs <= nowMs
  );
}
