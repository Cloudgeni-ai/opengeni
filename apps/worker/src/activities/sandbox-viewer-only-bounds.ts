// The reaper's bounds on warm boxes held only by viewers (docs/run-lifecycle.md,
// "Boxes held only by viewers").
//
// A viewer holder (an open session page) keeps its box warm for as long as its
// heartbeats arrive. Each maintenance pass:
//
//   1. idle drain: drains a box whose every holder is a viewer, whose sessions
//      have no open work, and where nothing (a viewer attach, interaction a
//      viewer reported, a message or turn) happened for the idle window;
//   2. per-account cap: counts, per account across its workspaces, the
//      remaining viewer-only boxes and drains the least recently active ones
//      over the cap; while an account is at the cap its workspaces are stamped
//      so a viewer attach does not warm another viewer-only box.
//
// Drains use the ordinary path (viewers released, lease warm -> draining), so
// the workspace is saved and a returning viewer just resumes the box.
import type { MeterableWarmLease, ViewerOnlyWarmLease } from "@opengeni/db";
import {
  drainViewerOnlyLease,
  listViewerOnlyWarmLeases,
  stampViewerOnlyCapGate,
  VIEWER_ONLY_CAP_EXEMPT_BACKENDS,
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
  /** Drain only if nothing on the box was active after this time. */
  activeAtOrBefore: Date;
};

export type ViewerOnlyDrainPlan = {
  drains: ViewerOnlyDrainDecision[];
  /** Accounts at their cap after the planned drains, with the workspaces that
   * hold their viewer-only boxes (stamped so attaches stop warming more). */
  cappedWorkspaces: { accountId: string; workspaceId: string }[];
};

/**
 * Decide which viewer-only boxes to drain. Pure: the caller rechecks every
 * decision under the lease lock before acting.
 *
 * - A box with open session work (a queued, running, recovering or waiting
 *   turn) is never drained and never counted against the cap.
 * - Idle: nothing happened for `idleDrainMs` (0 disables).
 * - Cap: of the remaining boxes of one account, the least recently active over
 *   `maxPerAccount` (0 disables) are drained. A box another owner is
 *   capturing or rotating still counts but is left to that owner.
 */
export function planViewerOnlyDrains(
  leases: readonly ViewerOnlyWarmLease[],
  options: { nowMs: number; idleDrainMs: number; maxPerAccount: number },
): ViewerOnlyDrainPlan {
  const drains: ViewerOnlyDrainDecision[] = [];
  const cappedWorkspaces: { accountId: string; workspaceId: string }[] = [];
  const idleCutoff = new Date(options.nowMs - options.idleDrainMs);
  const byAccount = new Map<string, ViewerOnlyWarmLease[]>();
  for (const lease of leases) {
    if (lease.openSessionWork) continue;
    if (
      options.idleDrainMs > 0 &&
      !lease.transitioning &&
      lease.lastActiveAt.getTime() <= idleCutoff.getTime()
    ) {
      drains.push({
        lease,
        reason: "viewer_idle",
        activeAtOrBefore: idleCutoff,
      });
      continue;
    }
    const accountLeases = byAccount.get(lease.accountId) ?? [];
    accountLeases.push(lease);
    byAccount.set(lease.accountId, accountLeases);
  }
  if (options.maxPerAccount <= 0) return { drains, cappedWorkspaces };
  for (const [accountId, accountLeases] of byAccount) {
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
      if (lease.transitioning) continue;
      drains.push({
        lease,
        reason: "viewer_account_cap",
        activeAtOrBefore: lease.lastActiveAt,
      });
      over -= 1;
    }
    const workspaceIds = new Set(accountLeases.map((lease) => lease.workspaceId));
    for (const workspaceId of [...workspaceIds].sort()) {
      cappedWorkspaces.push({ accountId, workspaceId });
    }
  }
  return { drains, cappedWorkspaces };
}

/** How long one cap stamp lasts: long enough to cover the gap to the next
 * maintenance pass, short enough that a lower count frees attaches soon. */
export function viewerOnlyCapGateMs(reaperPeriodMs: number): number {
  return Math.max(3 * reaperPeriodMs, 120_000);
}

export type ViewerOnlyBoundsResult = {
  inspected: number;
  drained: Record<SandboxViewerOnlyDrainReason, number>;
  cappedWorkspaces: number;
};

/** One maintenance pass of both bounds. Best-effort per workspace and box. */
export async function boundViewerOnlyWarmBoxes(
  services: Pick<ActivityServices, "db" | "settings" | "observability">,
  warmLeases: readonly MeterableWarmLease[],
  options: { nowMs?: number; concurrency?: number } = {},
): Promise<ViewerOnlyBoundsResult> {
  const { db, settings, observability } = services;
  const result: ViewerOnlyBoundsResult = {
    inspected: 0,
    drained: { viewer_idle: 0, viewer_account_cap: 0 },
    cappedWorkspaces: 0,
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
  const nowMs = options.nowMs ?? Date.now();
  const plan = planViewerOnlyDrains(viewerOnly, {
    nowMs,
    idleDrainMs,
    maxPerAccount,
  });

  await forEachLimited(plan.drains, concurrency, async (decision) => {
    const { lease } = decision;
    try {
      const outcome = await drainViewerOnlyLease(db, {
        accountId: lease.accountId,
        workspaceId: lease.workspaceId,
        sandboxGroupId: lease.sandboxGroupId,
        expectedEpoch: lease.leaseEpoch,
        activeAtOrBefore: decision.activeAtOrBefore,
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
      result.drained[decision.reason] += 1;
      recordSandboxViewerOnlyDrain(observability, decision.reason);
      observability.info("sandbox reaper: drained viewer-only box", {
        reason: decision.reason,
        accountId: lease.accountId,
        workspaceId: lease.workspaceId,
        sandboxGroupId: lease.sandboxGroupId,
        leaseEpoch: lease.leaseEpoch,
        releasedViewers: outcome.releasedViewers,
        inactiveForMs: Math.max(0, nowMs - lease.lastActiveAt.getTime()),
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
  });

  const gateMs = viewerOnlyCapGateMs(settings.sandboxLeaseReaperPeriodMs);
  await forEachLimited(plan.cappedWorkspaces, concurrency, async (target) => {
    try {
      await stampViewerOnlyCapGate(db, { ...target, forMs: gateMs });
      result.cappedWorkspaces += 1;
    } catch (error) {
      observability.warn("sandbox reaper: viewer-only cap stamp failed for workspace", {
        ...target,
        error: errorMessage(error),
      });
    }
  });
  if (plan.cappedWorkspaces.length > 0) {
    observability.info("sandbox reaper: accounts at the viewer-only warm box cap", {
      maxViewerOnlyWarmPerAccount: maxPerAccount,
      accounts: new Set(plan.cappedWorkspaces.map((target) => target.accountId)).size,
      workspaces: plan.cappedWorkspaces.length,
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
