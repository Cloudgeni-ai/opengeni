// The reaper's bounds on warm boxes held only by viewers (docs/run-lifecycle.md,
// "Boxes held only by viewers").
//
// A viewer holder (an open session page) keeps its box warm for as long as its
// heartbeats arrive. Admission refuses a viewer that would warm one more
// viewer-only box beyond the limits, but a box a turn, process or readiness
// hold kept warm becomes viewer-only when that holder leaves. Each maintenance
// pass therefore:
//
//   1. idle drain: drains a box whose every holder is a viewer, whose sessions
//      have no open work, and where nobody used it (reported viewer
//      interaction, the attach of a page that never reported any, a message or
//      turn) for the idle window;
//   2. over-limit drain: counts the boxes still warm per workspace
//      (OPENGENI_SANDBOX_MAX_VIEWER_ONLY_BOXES_PER_WORKSPACE) and per
//      organization (the plan tier's viewerOnlyBoxesPerOrganization) and
//      drains the least recently active ones over a limit, but only those
//      nobody used for VIEWER_ONLY_LIMIT_QUIET_MS: a box in use is never
//      evicted, and admission keeps new boxes within the limits.
//
// An organization that is not self-serve (the `embedded` tier) is outside both
// bounds: its host may hold viewers without reporting interaction.
//
// Drains use the ordinary path (viewers released, lease warm -> draining), so
// the workspace is saved and a returning person just resumes the box.
import type { MeterableWarmLease, ViewerOnlyWarmLease } from "@opengeni/db";
import {
  drainViewerOnlyLease,
  listViewerOnlyWarmLeases,
  resolveSandboxPlanTierInWorkspace,
  SANDBOX_EMBEDDED_PLAN_TIER,
  sandboxPlanLimitFor,
  VIEWER_ONLY_EXEMPT_BACKENDS,
  VIEWER_ONLY_LIMIT_QUIET_MS,
} from "@opengeni/db";
import { sandboxPlanLimits } from "@opengeni/config";
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
  /** And nothing was active after this time (over-limit: the ranked activity). */
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

/**
 * Over-limit drains over the boxes still warm. Pure. Boxes with open session
 * work are not counted. Per organization, boxes are visited least recently
 * active first; one is drained while its workspace holds more than
 * `maxPerWorkspace` (0 = unbounded) or its organization more than its
 * `organizationLimits` entry (absent = unbounded), skipping any used within
 * `quietMs` or held by a capture or rotation (those still count).
 */
export function planViewerOnlyLimitDrains(
  leases: readonly ViewerOnlyWarmLease[],
  options: {
    maxPerWorkspace: number;
    organizationLimits: ReadonlyMap<string, number | undefined>;
    quietMs?: number;
  },
): ViewerOnlyDrainDecision[] {
  const drains: ViewerOnlyDrainDecision[] = [];
  const quietMs = options.quietMs ?? VIEWER_ONLY_LIMIT_QUIET_MS;
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
    const organizationLimit = options.organizationLimits.get(accountId);
    let organizationCount = accountLeases.length;
    const workspaceCounts = new Map<string, number>();
    for (const lease of accountLeases) {
      workspaceCounts.set(lease.workspaceId, (workspaceCounts.get(lease.workspaceId) ?? 0) + 1);
    }
    // Least recently active first; the group id only makes ties stable.
    const ordered = [...accountLeases].sort(
      (left, right) =>
        left.lastActiveAt.getTime() - right.lastActiveAt.getTime() ||
        left.sandboxGroupId.localeCompare(right.sandboxGroupId),
    );
    for (const lease of ordered) {
      const workspaceCount = workspaceCounts.get(lease.workspaceId) ?? 0;
      const overWorkspace = options.maxPerWorkspace > 0 && workspaceCount > options.maxPerWorkspace;
      const overOrganization =
        organizationLimit !== undefined && organizationCount > organizationLimit;
      if (!overWorkspace && !overOrganization) continue;
      if (lease.transitioning || inactiveForMs(lease) < quietMs) continue;
      drains.push({
        lease,
        reason: overWorkspace ? "viewer_workspace_limit" : "viewer_organization_limit",
        quietForMs: quietMs,
        activeAtOrBefore: lease.lastActiveAt,
      });
      workspaceCounts.set(lease.workspaceId, workspaceCount - 1);
      organizationCount -= 1;
    }
  }
  return drains;
}

export type ViewerOnlyBoundsResult = {
  inspected: number;
  drained: Record<SandboxViewerOnlyDrainReason, number>;
  /** Organizations outside both bounds this pass (embedded, or tier unknown). */
  exemptOrganizations: number;
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
    drained: { viewer_idle: 0, viewer_workspace_limit: 0, viewer_organization_limit: 0 },
    exemptOrganizations: 0,
  };
  const idleDrainMs = settings.sandboxViewerIdleDrainMs;
  const maxPerWorkspace = settings.sandboxMaxViewerOnlyBoxesPerWorkspace;
  const planLimits = sandboxPlanLimits(settings);

  const workspaces = new Map<string, string>();
  for (const lease of warmLeases) {
    if (VIEWER_ONLY_EXEMPT_BACKENDS.has(lease.backend)) continue;
    workspaces.set(lease.workspaceId, lease.accountId);
  }
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const inventory: ViewerOnlyWarmLease[] = [];
  await forEachLimited([...workspaces], concurrency, async ([workspaceId, accountId]) => {
    try {
      inventory.push(...(await listViewerOnlyWarmLeases(db, { accountId, workspaceId })));
    } catch (error) {
      observability.warn("sandbox reaper: viewer-only box inventory failed for workspace", {
        accountId,
        workspaceId,
        error: errorMessage(error),
      });
    }
  });
  result.inspected = inventory.length;
  if (inventory.length === 0) return result;

  // Each organization's plan tier, once. An embedded organization, or one
  // whose tier could not be read, is left alone this pass.
  const accounts = new Map<string, string>();
  for (const lease of inventory) {
    if (!accounts.has(lease.accountId)) accounts.set(lease.accountId, lease.workspaceId);
  }
  const organizationLimits = new Map<string, number | undefined>();
  const exempt = new Set<string>();
  await forEachLimited([...accounts], concurrency, async ([accountId, workspaceId]) => {
    try {
      const tier = await resolveSandboxPlanTierInWorkspace(db, {
        accountId,
        workspaceId,
        limits: planLimits,
      });
      if (tier === SANDBOX_EMBEDDED_PLAN_TIER) {
        exempt.add(accountId);
        return;
      }
      organizationLimits.set(
        accountId,
        sandboxPlanLimitFor(planLimits, tier).viewerOnlyBoxesPerOrganization,
      );
    } catch (error) {
      exempt.add(accountId);
      observability.warn("sandbox reaper: viewer-only plan tier read failed for organization", {
        accountId,
        error: errorMessage(error),
      });
    }
  });
  result.exemptOrganizations = exempt.size;
  const viewerOnly = inventory.filter((lease) => !exempt.has(lease.accountId));

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
          : decision.reason === "viewer_workspace_limit"
            ? { limit: maxPerWorkspace }
            : { limit: organizationLimits.get(lease.accountId) }),
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

  // Idle drains first; the limits then count only what is still warm, so an
  // idle drain the recheck refused still counts against them.
  await forEachLimited(planViewerOnlyIdleDrains(viewerOnly, { idleDrainMs }), concurrency, execute);
  const remaining = viewerOnly.filter(
    (lease) => !drained.has(`${lease.workspaceId}:${lease.sandboxGroupId}`),
  );
  await forEachLimited(
    planViewerOnlyLimitDrains(remaining, { maxPerWorkspace, organizationLimits }),
    concurrency,
    execute,
  );
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
