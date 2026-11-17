// The reaper's half of the plan's free-compute bounds (docs/deployment.md,
// "Free compute bounds").
//
// Admission refuses a new box, a join and a re-arm for an organization whose
// plan allows no sandbox (`compute_closed`: a held or denied organization that
// has not paid) or whose day's box time is used (`compute_daily_budget`), but
// a box already warm stays warm for as long as something holds it. For an
// organization on such a plan, each maintenance pass therefore drains every
// warm box no turn holds, whatever else holds it (a terminal, a process, a
// Browser/ComputerSession, a viewer). For a tier with `idleDrainAllHolders`
// it also drains such a box nobody used for the viewer idle window
// (`compute_idle`), not only a viewer-only one.
//
// An in-flight turn is never interrupted: a box a turn holds is not listed.
import type { SandboxPlanLimit } from "@opengeni/config";
import type { MeterableWarmLease, NoTurnWarmLease } from "@opengeni/db";
import {
  drainNoTurnLeaseForComputeBounds,
  listNoTurnWarmLeases,
  readOrganizationBoxSecondsToday,
  resolveSandboxPlanTierInWorkspace,
  sandboxPlanLimitFor,
  VIEWER_ONLY_EXEMPT_BACKENDS,
} from "@opengeni/db";
import { sandboxPlanLimits } from "@opengeni/config";
import { errorMessage } from "@opengeni/contracts/values";
import {
  recordSandboxComputeBoundsDrain,
  type SandboxComputeBoundsDrainReason,
} from "../observability-metrics";
import type { ControlActivityServices as ActivityServices } from "./types";

/** One organization's compute-bounds state this pass. */
export type OrganizationComputeBounds = {
  limit: SandboxPlanLimit;
  boxSecondsToday: number;
};

export type ComputeBoundsDrainDecision = {
  lease: NoTurnWarmLease;
  reason: SandboxComputeBoundsDrainReason;
};

/** Whether an organization's plan bounds call for this pass at all. */
export function organizationHasComputeBounds(limit: SandboxPlanLimit): boolean {
  return (
    limit.runningBoxesPerOrganization === 0 ||
    limit.boxSecondsPerOrganizationPerDay !== undefined ||
    limit.idleDrainAllHolders === true
  );
}

/**
 * Drains under the compute bounds. Pure: the caller rechecks every decision
 * under the lease lock. A box a capture, rotation or reaper hold owns is left
 * to that owner. An idle drain also skips a box whose sessions have open work;
 * an idle window of 0 disables idle draining.
 */
export function planComputeBoundsDrains(
  leases: readonly NoTurnWarmLease[],
  organizations: ReadonlyMap<string, OrganizationComputeBounds>,
  options: { idleDrainMs: number },
): ComputeBoundsDrainDecision[] {
  const drains: ComputeBoundsDrainDecision[] = [];
  for (const lease of leases) {
    const organization = organizations.get(lease.accountId);
    if (!organization || lease.transitioning) continue;
    const { limit } = organization;
    if (limit.runningBoxesPerOrganization === 0) {
      drains.push({ lease, reason: "compute_closed" });
      continue;
    }
    if (
      limit.boxSecondsPerOrganizationPerDay !== undefined &&
      organization.boxSecondsToday >= limit.boxSecondsPerOrganizationPerDay
    ) {
      drains.push({ lease, reason: "compute_daily_budget" });
      continue;
    }
    if (
      limit.idleDrainAllHolders === true &&
      options.idleDrainMs > 0 &&
      !lease.openSessionWork &&
      lease.observedAt.getTime() - lease.lastActiveAt.getTime() >= options.idleDrainMs
    ) {
      drains.push({ lease, reason: "compute_idle" });
    }
  }
  return drains;
}

export type ComputeBoundsResult = {
  inspected: number;
  drained: Record<SandboxComputeBoundsDrainReason, number>;
};

/** One maintenance pass of the compute bounds. Best-effort per organization,
 * workspace and box. */
export async function boundComputeBoundedWarmBoxes(
  services: Pick<ActivityServices, "db" | "settings" | "observability">,
  warmLeases: readonly MeterableWarmLease[],
  options: { concurrency?: number } = {},
): Promise<ComputeBoundsResult> {
  const { db, settings, observability } = services;
  const result: ComputeBoundsResult = {
    inspected: 0,
    drained: { compute_closed: 0, compute_daily_budget: 0, compute_idle: 0 },
  };
  const planLimits = sandboxPlanLimits(settings);
  const concurrency = Math.max(1, options.concurrency ?? 8);

  // Workspaces by organization; Connected Machines and compute boxes are
  // outside these bounds.
  const workspacesByAccount = new Map<string, Set<string>>();
  for (const lease of warmLeases) {
    if (VIEWER_ONLY_EXEMPT_BACKENDS.has(lease.backend)) continue;
    const workspaces = workspacesByAccount.get(lease.accountId) ?? new Set<string>();
    workspaces.add(lease.workspaceId);
    workspacesByAccount.set(lease.accountId, workspaces);
  }

  // Each organization's bounds, once. One whose tier could not be read is
  // left alone this pass.
  const organizations = new Map<string, OrganizationComputeBounds>();
  await forEachLimited([...workspacesByAccount], concurrency, async ([accountId, workspaces]) => {
    try {
      const workspaceId = [...workspaces][0]!;
      const tier = await resolveSandboxPlanTierInWorkspace(db, {
        accountId,
        workspaceId,
        limits: planLimits,
      });
      const limit = sandboxPlanLimitFor(planLimits, tier);
      if (!organizationHasComputeBounds(limit)) return;
      organizations.set(accountId, {
        limit,
        boxSecondsToday:
          limit.boxSecondsPerOrganizationPerDay === undefined
            ? 0
            : await readOrganizationBoxSecondsToday(db, accountId),
      });
    } catch (error) {
      observability.warn("sandbox reaper: compute-bounds plan read failed for organization", {
        accountId,
        error: errorMessage(error),
      });
    }
  });
  if (organizations.size === 0) return result;

  const inventory: NoTurnWarmLease[] = [];
  const targets = [...organizations.keys()].flatMap((accountId) =>
    [...(workspacesByAccount.get(accountId) ?? [])].map(
      (workspaceId) => [accountId, workspaceId] as const,
    ),
  );
  await forEachLimited(targets, concurrency, async ([accountId, workspaceId]) => {
    try {
      inventory.push(...(await listNoTurnWarmLeases(db, { accountId, workspaceId })));
    } catch (error) {
      observability.warn("sandbox reaper: compute-bounds box inventory failed for workspace", {
        accountId,
        workspaceId,
        error: errorMessage(error),
      });
    }
  });
  result.inspected = inventory.length;

  const idleDrainMs = settings.sandboxViewerIdleDrainMs;
  await forEachLimited(
    planComputeBoundsDrains(inventory, organizations, { idleDrainMs }),
    concurrency,
    async ({ lease, reason }) => {
      try {
        const outcome = await drainNoTurnLeaseForComputeBounds(db, {
          accountId: lease.accountId,
          workspaceId: lease.workspaceId,
          sandboxGroupId: lease.sandboxGroupId,
          expectedEpoch: lease.leaseEpoch,
          reason,
          quietForMs: idleDrainMs,
          idleGraceMs: settings.sandboxIdleGraceMs,
        });
        if (!outcome.drained) {
          observability.info("sandbox reaper: compute-bounded box kept", {
            reason,
            keptBecause: outcome.reason,
            accountId: lease.accountId,
            workspaceId: lease.workspaceId,
            sandboxGroupId: lease.sandboxGroupId,
          });
          return;
        }
        result.drained[reason] += 1;
        recordSandboxComputeBoundsDrain(observability, reason, outcome.mode);
        observability.info("sandbox reaper: drained compute-bounded box", {
          reason,
          mode: outcome.mode,
          accountId: lease.accountId,
          workspaceId: lease.workspaceId,
          sandboxGroupId: lease.sandboxGroupId,
          leaseEpoch: lease.leaseEpoch,
          releasedHolders: outcome.releasedHolders,
          holders: lease.holders,
          commandHolders: lease.commandHolders,
        });
      } catch (error) {
        observability.warn("sandbox reaper: compute-bounded box drain failed", {
          reason,
          accountId: lease.accountId,
          workspaceId: lease.workspaceId,
          sandboxGroupId: lease.sandboxGroupId,
          error: errorMessage(error),
        });
      }
    },
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
