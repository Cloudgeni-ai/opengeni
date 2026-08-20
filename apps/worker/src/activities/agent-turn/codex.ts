import {
  listCodexAccountStatuses,
  fetchCodexUsageForAccount,
  type CodexAccountStatus,
} from "@opengeni/db";
import { type RegistryProviderKind, type Settings } from "@opengeni/config";
import { CODEX_USAGE_EXHAUSTED_PCT } from "../codex-rotation";
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
 * window THIS turn. A refresh/read failure is swallowed (fall back to the pre-refresh rows
 * + the bounded idle). Cooling (429'd) accounts are NOT refreshed: their exhaustedUntil
 * cooldown is authoritative, and refreshing them would burn a provider call for nothing.
 */
export async function refreshCappedCodexUsageRows(
  db: ActivityServices["db"],
  settings: Settings,
  workspaceId: string,
  accounts: Array<
    Pick<
      CodexAccountStatus,
      "id" | "status" | "primaryUsedPercent" | "secondaryUsedPercent" | "exhaustedUntil"
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
      "id" | "status" | "primaryUsedPercent" | "secondaryUsedPercent" | "exhaustedUntil"
    >
  >
> {
  const stale = accounts.filter(
    (a) =>
      a.status === "active" &&
      ((a.primaryUsedPercent ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT ||
        (a.secondaryUsedPercent ?? 0) >= CODEX_USAGE_EXHAUSTED_PCT),
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
