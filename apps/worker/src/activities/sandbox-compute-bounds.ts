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
// (`compute_idle`), not only a viewer-only one. For an unpaid organization in
// its first day (fleet limits) in which no turn was ever started, once it has
// used the box time it gets before one (`youngTurnlessBoxSeconds`), it drains
// such a box once nothing on it was active for `youngTurnlessIdleMs`
// (`compute_turnless`): a desktop or viewer left open with no chat does not
// stay warm, but someone still using it is not cut off, and a box running
// commands or a Browser/ComputerSession is left alone. Starting a chat lifts
// it.
//
// An in-flight turn is never interrupted: a box a turn holds is not listed.
// Compute boxes are drained for a closed tier or a spent day only when no
// process or Browser/ComputerSession holds them (compute has no orderly
// provider-deadline stop), and never for being idle.
import type { SandboxPlanLimit } from "@opengeni/config";
import type { MeterableWarmLease, NoTurnWarmLease } from "@opengeni/db";
import {
  drainNoTurnLeaseForComputeBounds,
  listNoTurnWarmLeasePeople,
  listNoTurnWarmLeases,
  organizationBoxSecondsSince,
  organizationHasAnyTurn,
  readOrganizationBoxSecondsToday,
  readSandboxFleetPressure,
  readSandboxUnpaidFleet,
  resolveSandboxComputeStanding,
  resolveSandboxPlanStandingInWorkspace,
  sandboxPlanLimitFor,
} from "@opengeni/db";
import {
  paidSandboxPlanLimit,
  sandboxFleetLimits,
  sandboxPlanLimits,
  UNPAID_SANDBOX_PLAN_TIERS,
  sandboxPlanTierUnpaid,
  type SandboxFleetLimits,
} from "@opengeni/config";
import { errorMessage } from "@opengeni/contracts/values";
import {
  recordSandboxComputeBoundsDrain,
  recordUnpaidSandboxFleet,
  type SandboxComputeBoundsDrainReason,
  type UnpaidSandboxFleetState,
} from "../observability-metrics";
import type { ControlActivityServices as ActivityServices } from "./types";

/** One organization's compute-bounds state this pass. */
export type OrganizationComputeBounds = {
  limit: SandboxPlanLimit;
  boxSecondsToday: number;
  /** A young unpaid organization that never started a turn and used the box
   * time it gets before one. */
  turnlessYoung?: boolean;
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
  options: { idleDrainMs: number; turnlessIdleMs?: number },
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
    // A compute box keeps its state on its own disk and memory, which a drain
    // does not save: only a closed tier drains it.
    if (lease.backend === "compute") continue;
    if (
      limit.boxSecondsPerOrganizationPerDay !== undefined &&
      organization.boxSecondsToday >= limit.boxSecondsPerOrganizationPerDay
    ) {
      drains.push({ lease, reason: "compute_daily_budget" });
      continue;
    }
    if (
      organization.turnlessYoung === true &&
      !lease.openSessionWork &&
      lease.commandHolders === 0 &&
      lease.observedAt.getTime() - lease.lastActiveAt.getTime() >= (options.turnlessIdleMs ?? 0)
    ) {
      drains.push({ lease, reason: "compute_turnless" });
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
    drained: { compute_closed: 0, compute_daily_budget: 0, compute_idle: 0, compute_turnless: 0 },
  };
  const planLimits = sandboxPlanLimits(settings);
  const fleetLimits = sandboxFleetLimits(settings);
  const concurrency = Math.max(1, options.concurrency ?? 8);

  // Workspaces by organization; Connected Machines are outside these bounds.
  const workspacesByAccount = new Map<string, Set<string>>();
  for (const lease of warmLeases) {
    if (lease.backend === "selfhosted") continue;
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
      const standing = await resolveSandboxPlanStandingInWorkspace(db, {
        accountId,
        workspaceId,
        limits: planLimits,
      });
      // An organization that bought credit or paid is outside the unpaid-only
      // bounds (daily box time, idle drain of every holder).
      const tierLimit = sandboxPlanLimitFor(planLimits, standing.tier);
      const limit = standing.paidHistory ? paidSandboxPlanLimit(tierLimit) : tierLimit;
      const turnlessYoung = await youngOrganizationTurnless(db, fleetLimits, {
        accountId,
        unpaid:
          sandboxPlanTierUnpaid(standing.tier, {
            subscriptionPlansEnabled: settings.subscriptionPlansEnabled,
          }) && !standing.paidHistory,
        createdAt: standing.organizationCreatedAt,
      });
      if (!organizationHasComputeBounds(limit) && !turnlessYoung) return;
      organizations.set(accountId, {
        limit,
        boxSecondsToday:
          limit.boxSecondsPerOrganizationPerDay === undefined
            ? 0
            : await readOrganizationBoxSecondsToday(db, accountId),
        turnlessYoung,
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
  const turnlessIdleMs = fleetLimits.youngTurnlessIdleMs ?? 0;
  await forEachLimited(
    planComputeBoundsDrains(inventory, organizations, { idleDrainMs, turnlessIdleMs }),
    concurrency,
    async ({ lease, reason }) => {
      try {
        const outcome = await drainNoTurnLeaseForComputeBounds(db, {
          accountId: lease.accountId,
          workspaceId: lease.workspaceId,
          sandboxGroupId: lease.sandboxGroupId,
          expectedEpoch: lease.leaseEpoch,
          reason,
          quietForMs: reason === "compute_turnless" ? turnlessIdleMs : idleDrainMs,
          // A closed organization cannot re-arm its box: drain it in this
          // sweep rather than after the reconnect grace.
          idleGraceMs: reason === "compute_closed" ? 0 : settings.sandboxIdleGraceMs,
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

/** Whether an unpaid organization in its first day never started a turn
 * and has used the box time it gets before one. */
export async function youngOrganizationTurnless(
  db: ActivityServices["db"],
  limits: SandboxFleetLimits,
  input: { accountId: string; unpaid: boolean; createdAt: Date | null; now?: number },
): Promise<boolean> {
  if (
    !input.unpaid ||
    input.createdAt === null ||
    limits.youngTurnlessBoxSeconds === undefined ||
    limits.youngOrganizationAgeMs === undefined ||
    (input.now ?? Date.now()) - input.createdAt.getTime() >= limits.youngOrganizationAgeMs
  ) {
    return false;
  }
  const seconds = await organizationBoxSecondsSince(db, input.accountId, input.createdAt);
  if (seconds < limits.youngTurnlessBoxSeconds) return false;
  return !(await organizationHasAnyTurn(db, input.accountId));
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

/** The unpaid fleet's state from one pass's readings (see SandboxFleetLimits). */
export function unpaidSandboxFleetState(
  limits: SandboxFleetLimits,
  input: { pressureEngaged: boolean; unpaidBoxSecondsToday: number | null },
): UnpaidSandboxFleetState {
  if (
    limits.unpaidBoxSecondsPerDay !== undefined &&
    input.unpaidBoxSecondsToday !== null &&
    input.unpaidBoxSecondsToday >= limits.unpaidBoxSecondsPerDay
  ) {
    return "daily_budget_exhausted";
  }
  return input.pressureEngaged ? "pressure" : "normal";
}

/**
 * Observe the unpaid fleet once per reaper pass: fleet pressure, the unpaid
 * running boxes and today's unpaid box time. Admission enforces the limits;
 * this records them (a page fires while the day's unpaid box time is
 * exhausted) and logs while the fleet is not normal. Until the fleet definer
 * is granted (1486) only pressure is observed.
 */
export async function observeUnpaidSandboxFleet(
  services: Pick<ActivityServices, "db" | "settings" | "observability">,
): Promise<UnpaidSandboxFleetState> {
  const { db, settings, observability } = services;
  const limits = sandboxFleetLimits(settings);
  const pressure = await readSandboxFleetPressure(db, limits, {
    onReadFailure: (error) =>
      observability.warn("sandbox reaper: fleet warm count read failed", {
        error: errorMessage(error),
      }),
  });
  let unpaid: Awaited<ReturnType<typeof readSandboxUnpaidFleet>> = null;
  try {
    unpaid = await readSandboxUnpaidFleet(db, { excludeLeaseId: null, withBoxSeconds: true });
  } catch (error) {
    observability.warn("sandbox reaper: unpaid fleet read failed", { error: errorMessage(error) });
  }
  const state = unpaidSandboxFleetState(limits, {
    pressureEngaged: pressure.engaged,
    unpaidBoxSecondsToday: unpaid?.boxSecondsToday ?? null,
  });
  recordUnpaidSandboxFleet(observability, {
    state,
    warmBoxes: pressure.warmBoxes,
    unpaidRunningBoxes: unpaid?.runningBoxes ?? null,
    unpaidBoxSecondsToday: unpaid?.boxSecondsToday ?? null,
  });
  if (state !== "normal") {
    observability.warn("sandbox reaper: unpaid sandbox fleet limited", {
      state,
      warmBoxes: pressure.warmBoxes,
      unpaidRunningBoxes: unpaid?.runningBoxes ?? null,
      unpaidBoxSecondsToday: unpaid?.boxSecondsToday ?? null,
      unpaidBoxSecondsPerDay: limits.unpaidBoxSecondsPerDay ?? null,
    });
  }
  return state;
}

/**
 * The closed half of the compute bounds, run by the sweep's inventory phase
 * before it lists drainable boxes: a box of an organization that review just
 * held or denied is drained (without the reconnect grace) and dispatched in
 * the same sweep, instead of after a maintenance pass, the grace and another
 * sweep. An organization is closed by its own tier or, when unpaid, when its
 * self-serve owner or a person viewing its boxes runs another organization
 * that review held or denied. Boxes a turn holds are left to the turn, as in
 * the maintenance pass, and a read that fails leaves the organization to the
 * next pass.
 */
export async function drainClosedComputeOrganizations(
  services: Pick<ActivityServices, "db" | "settings" | "observability">,
  warmLeases: readonly MeterableWarmLease[],
  options: { concurrency?: number } = {},
): Promise<{ inspected: number; drained: number }> {
  const { db, settings, observability } = services;
  const planLimits = sandboxPlanLimits(settings);
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const workspacesByAccount = new Map<string, Set<string>>();
  for (const lease of warmLeases) {
    if (lease.backend === "selfhosted") continue;
    const workspaces = workspacesByAccount.get(lease.accountId) ?? new Set<string>();
    workspaces.add(lease.workspaceId);
    workspacesByAccount.set(lease.accountId, workspaces);
  }
  const closed: OrganizationComputeBounds = {
    limit: { ...sandboxPlanLimitFor(planLimits, "restricted"), runningBoxesPerOrganization: 0 },
    boxSecondsToday: 0,
  };
  const organizations = new Map<string, OrganizationComputeBounds>();
  const inventory: NoTurnWarmLease[] = [];
  await forEachLimited([...workspacesByAccount], concurrency, async ([accountId, workspaces]) => {
    try {
      const standing = await resolveSandboxPlanStandingInWorkspace(db, {
        accountId,
        workspaceId: [...workspaces][0]!,
        limits: planLimits,
      });
      const tierLimit = sandboxPlanLimitFor(planLimits, standing.tier);
      const limit = standing.paidHistory ? paidSandboxPlanLimit(tierLimit) : tierLimit;
      let isClosed = limit.runningBoxesPerOrganization === 0;
      const unpaid = UNPAID_SANDBOX_PLAN_TIERS.includes(standing.tier) && !standing.paidHistory;
      if (!isClosed && !unpaid) return;
      const leases: NoTurnWarmLease[] = [];
      for (const workspaceId of workspaces) {
        leases.push(...(await listNoTurnWarmLeases(db, { accountId, workspaceId })));
      }
      if (leases.length === 0) return;
      if (!isClosed) {
        const people = new Set<string>();
        for (const workspaceId of workspaces) {
          for (const subject of await listNoTurnWarmLeasePeople(db, { accountId, workspaceId })) {
            people.add(subject);
          }
        }
        for (const subject of people) {
          const person = await resolveSandboxComputeStanding(db, {
            accountId,
            limits: planLimits,
            actingSubjectId: subject,
            subscriptionPlansEnabled: settings.subscriptionPlansEnabled,
          });
          if (person.linkedRestricted) {
            isClosed = true;
            break;
          }
        }
      }
      if (!isClosed) return;
      organizations.set(accountId, closed);
      inventory.push(...leases);
    } catch (error) {
      observability.warn("sandbox reaper: closed compute read failed for organization", {
        accountId,
        error: errorMessage(error),
      });
    }
  });
  let drained = 0;
  await forEachLimited(
    planComputeBoundsDrains(inventory, organizations, { idleDrainMs: 0 }),
    concurrency,
    async ({ lease, reason }) => {
      try {
        const outcome = await drainNoTurnLeaseForComputeBounds(db, {
          accountId: lease.accountId,
          workspaceId: lease.workspaceId,
          sandboxGroupId: lease.sandboxGroupId,
          expectedEpoch: lease.leaseEpoch,
          reason,
          quietForMs: 0,
          idleGraceMs: 0,
        });
        if (!outcome.drained) return;
        drained += 1;
        recordSandboxComputeBoundsDrain(observability, reason, outcome.mode);
        observability.info("sandbox reaper: drained closed organization box", {
          reason,
          mode: outcome.mode,
          accountId: lease.accountId,
          workspaceId: lease.workspaceId,
          sandboxGroupId: lease.sandboxGroupId,
          leaseEpoch: lease.leaseEpoch,
        });
      } catch (error) {
        observability.warn("sandbox reaper: closed organization box drain failed", {
          accountId: lease.accountId,
          workspaceId: lease.workspaceId,
          sandboxGroupId: lease.sandboxGroupId,
          error: errorMessage(error),
        });
      }
    },
  );
  return { inspected: inventory.length, drained };
}
