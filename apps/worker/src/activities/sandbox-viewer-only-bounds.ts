// The reaper's bounds on warm boxes held only by viewers (docs/run-lifecycle.md,
// "Boxes held only by viewers").
//
// A viewer holder (an open session page) keeps its box warm for as long as its
// heartbeats arrive. Each maintenance pass:
//
//   1. idle drain: drains a box whose every holder is a viewer, whose sessions
//      have no open work, and where nobody used it (reported viewer
//      interaction, the attach of a page that never reported any, a message or
//      turn) for the idle window;
//   2. per-account cap: counts, per account across its workspaces, the boxes
//      still warm and drains the least recently active ones over the cap,
//      but only those nobody used for VIEWER_ONLY_CAP_QUIET_MS: a box in use
//      is never evicted. While an account is at the cap every workspace of it
//      is stamped, so a viewer attach does not warm another viewer-only box.
//
// Drains use the ordinary path (viewers released, lease warm -> draining), so
// the workspace is saved and a returning person just resumes the box.
import type { MeterableWarmLease, ViewerOnlyWarmLease } from "@opengeni/db";
import {
  drainViewerOnlyLease,
  listViewerOnlyWarmLeases,
  stampViewerOnlyCapGate,
  VIEWER_ONLY_CAP_EXEMPT_BACKENDS,
  VIEWER_ONLY_CAP_QUIET_MS,
} from "@opengeni/db";
import { errorMessage } from "@opengeni/contracts/values";
import {
  recordSandboxViewerOnlyDrain,
  type SandboxViewerOnlyDrainReason,
} from "../observability-metrics";
import type { ControlActivityServices as ActivityServices } from "./types";

export type ViewerOnlyDrainDecision = {
  lease: ViewerOnlyWarmLease;
  reason: SandboxViewerOnlyDrainReason;
  /** Drain only if nothing on the box was active for this long. */
  quietForMs: number;
  /** And nothing was active after this time (cap: the ranked activity). */
  activeAtOrBefore?: Date;
};

function inactiveForMs(lease: ViewerOnlyWarmLease): number {
  return lease.observedAt.getTime() - lease.lastActiveAt.getTime();
}

/**
 * Idle drains. Pure: the caller rechecks every decision under the lease lock.
 * A box with open session work (a queued, running, recovering or waiting
 * turn) or one another owner is capturing or rotating is never drained. An
 * idle window of 0 disables idle draining.
 */
export function planViewerOnlyIdleDrains(
  leases: readonly ViewerOnlyWarmLease[],
  options: { idleDrainMs: number },
): ViewerOnlyDrainDecision[] {
  if (options.idleDrainMs <= 0) return [];
  return leases
    .filter(
      (lease) =>
        !lease.openSessionWork &&
        !lease.transitioning &&
        inactiveForMs(lease) >= options.idleDrainMs,
    )
    .map((lease) => ({ lease, reason: "viewer_idle", quietForMs: options.idleDrainMs }));
}

export type ViewerOnlyCapPlan = {
  drains: ViewerOnlyDrainDecision[];
  /** Accounts at their cap (one of their workspaces each, for the RLS
   * context); every workspace of them is stamped. */
  cappedAccounts: { accountId: string; workspaceId: string }[];
};

/**
 * Cap drains over the boxes still warm. Pure. Boxes with open session work
 * are not counted. Of each account's boxes over `maxPerAccount` (0 disables),
 * the least recently active are drained, skipping any used within
 * `quietMs` or held by a capture or rotation (those still count).
 */
export function planViewerOnlyCapDrains(
  leases: readonly ViewerOnlyWarmLease[],
  options: { maxPerAccount: number; quietMs?: number },
): ViewerOnlyCapPlan {
  const drains: ViewerOnlyDrainDecision[] = [];
  const cappedAccounts: { accountId: string; workspaceId: string }[] = [];
  if (options.maxPerAccount <= 0) return { drains, cappedAccounts };
  const quietMs = options.quietMs ?? VIEWER_ONLY_CAP_QUIET_MS;
  const byAccount = new Map<string, ViewerOnlyWarmLease[]>();
  for (const lease of leases) {
    if (lease.openSessionWork) continue;
    const accountLeases = byAccount.get(lease.accountId) ?? [];
    accountLeases.push(lease);
    byAccount.set(lease.accountId, accountLeases);
  }
  for (const [accountId, accountLeases] of [...byAccount].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (accountLeases.length < options.maxPerAccount) continue;
    // Least recently active first; the group id only makes ties stable.
    const ordered = [...accountLeases].sort(
      (left, right) =>
        left.lastActiveAt.getTime() - right.lastActiveAt.getTime() ||
        left.sandboxGroupId.localeCompare(right.sandboxGroupId),
    );
    let over = ordered.length - options.maxPerAccount;
    for (const lease of ordered) {
      if (over <= 0) break;
      if (lease.transitioning || inactiveForMs(lease) < quietMs) continue;
      drains.push({
        lease,
        reason: "viewer_account_cap",
        quietForMs: quietMs,
        activeAtOrBefore: lease.lastActiveAt,
      });
      over -= 1;
    }
    cappedAccounts.push({ accountId, workspaceId: ordered[0]!.workspaceId });
  }
  return { drains, cappedAccounts };
}

/** How long one cap stamp lasts: long enough to cover the gap to the next
 * maintenance pass, short enough that a lower count frees attaches soon. */
export function viewerOnlyCapGateMs(reaperPeriodMs: number): number {
  return Math.max(3 * reaperPeriodMs, 120_000);
}

export type ViewerOnlyBoundsResult = {
  inspected: number;
  drained: Record<SandboxViewerOnlyDrainReason, number>;
  cappedAccounts: number;
};

/** One maintenance pass of both bounds. Best-effort per workspace and box. */
export async function boundViewerOnlyWarmBoxes(
  services: Pick<ActivityServices, "db" | "settings" | "observability">,
  warmLeases: readonly MeterableWarmLease[],
  options: { concurrency?: number } = {},
): Promise<ViewerOnlyBoundsResult> {
  const { db, settings, observability } = services;
  const result: ViewerOnlyBoundsResult = {
    inspected: 0,
    drained: { viewer_idle: 0, viewer_account_cap: 0 },
    cappedAccounts: 0,
  };
  const idleDrainMs = settings.sandboxViewerIdleDrainMs;
  const maxPerAccount = settings.sandboxMaxViewerOnlyWarmPerAccount;
  if (idleDrainMs <= 0 && maxPerAccount <= 0) return result;

  const workspaces = new Map<string, string>();
  for (const lease of warmLeases) {
    if (VIEWER_ONLY_CAP_EXEMPT_BACKENDS.has(lease.backend)) continue;
    workspaces.set(lease.workspaceId, lease.accountId);
  }
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const viewerOnly: ViewerOnlyWarmLease[] = [];
  await forEachLimited([...workspaces], concurrency, async ([workspaceId, accountId]) => {
    try {
      viewerOnly.push(...(await listViewerOnlyWarmLeases(db, { accountId, workspaceId })));
    } catch (error) {
      observability.warn("sandbox reaper: viewer-only box inventory failed for workspace", {
        accountId,
        workspaceId,
        error: errorMessage(error),
      });
    }
  });
  result.inspected = viewerOnly.length;

  const drained = new Set<string>();
  const execute = async (decision: ViewerOnlyDrainDecision): Promise<void> => {
    const { lease } = decision;
    try {
      const outcome = await drainViewerOnlyLease(db, {
        accountId: lease.accountId,
        workspaceId: lease.workspaceId,
        sandboxGroupId: lease.sandboxGroupId,
        expectedEpoch: lease.leaseEpoch,
        reason: decision.reason,
        quietForMs: decision.quietForMs,
        ...(decision.activeAtOrBefore ? { activeAtOrBefore: decision.activeAtOrBefore } : {}),
        idleGraceMs: settings.sandboxIdleGraceMs,
      });
      if (!outcome.drained) {
        observability.info("sandbox reaper: viewer-only box kept", {
          reason: decision.reason,
          keptBecause: outcome.reason,
          accountId: lease.accountId,
          workspaceId: lease.workspaceId,
          sandboxGroupId: lease.sandboxGroupId,
        });
        return;
      }
      drained.add(`${lease.workspaceId}:${lease.sandboxGroupId}`);
      result.drained[decision.reason] += 1;
      recordSandboxViewerOnlyDrain(observability, decision.reason);
      observability.info("sandbox reaper: drained viewer-only box", {
        reason: decision.reason,
        accountId: lease.accountId,
        workspaceId: lease.workspaceId,
        sandboxGroupId: lease.sandboxGroupId,
        leaseEpoch: lease.leaseEpoch,
        releasedViewers: outcome.releasedViewers,
        inactiveForMs: Math.max(0, inactiveForMs(lease)),
        interactionReported: lease.interactionReported,
        ...(decision.reason === "viewer_idle"
          ? { idleDrainMs }
          : { maxViewerOnlyWarmPerAccount: maxPerAccount }),
      });
    } catch (error) {
      observability.warn("sandbox reaper: viewer-only box drain failed", {
        reason: decision.reason,
        accountId: lease.accountId,
        workspaceId: lease.workspaceId,
        sandboxGroupId: lease.sandboxGroupId,
        error: errorMessage(error),
      });
    }
  };

  // Idle drains first; the cap then counts only what is still warm, so an
  // idle drain the recheck refused still counts against the cap.
  await forEachLimited(planViewerOnlyIdleDrains(viewerOnly, { idleDrainMs }), concurrency, execute);
  const remaining = viewerOnly.filter(
    (lease) => !drained.has(`${lease.workspaceId}:${lease.sandboxGroupId}`),
  );
  const cap = planViewerOnlyCapDrains(remaining, { maxPerAccount });
  await forEachLimited(cap.drains, concurrency, execute);

  const gateMs = viewerOnlyCapGateMs(settings.sandboxLeaseReaperPeriodMs);
  await forEachLimited(cap.cappedAccounts, concurrency, async (target) => {
    try {
      await stampViewerOnlyCapGate(db, { ...target, forMs: gateMs });
      result.cappedAccounts += 1;
    } catch (error) {
      observability.warn("sandbox reaper: viewer-only cap stamp failed for account", {
        ...target,
        error: errorMessage(error),
      });
    }
  });
  if (cap.cappedAccounts.length > 0) {
    observability.info("sandbox reaper: accounts at the viewer-only warm box cap", {
      maxViewerOnlyWarmPerAccount: maxPerAccount,
      accounts: cap.cappedAccounts.length,
    });
  }
  return result;
}

async function forEachLimited<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(values.length, concurrency) }, async () => {
      while (next < values.length) {
        const value = values[next]!;
        next += 1;
        await visit(value);
      }
    }),
  );
}
