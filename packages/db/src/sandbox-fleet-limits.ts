// Fleet-wide bounds on unpaid sandbox compute (docs/deployment.md, "Unpaid
// fleet limits"). The per-organization and per-person plan limits bound what
// one organization or person runs; these bound what every unpaid
// organization together runs, so many fresh accounts cannot add up to an
// unbounded fleet:
//
// - the unpaid running boxes and today's unpaid box time, read through the
//   cross-tenant definer opengeni_private.sandbox_unpaid_fleet_v1 (1485) over
//   the boxes admission stamped `compute_unpaid`;
// - fleet pressure: the warm count of every plan (the warm-fleet alert's own
//   source, count_sandbox_leases_by_liveness) with hysteresis, kept per
//   process. Every process reads the same count, so they agree within a read
//   interval.
import { sql } from "drizzle-orm";
import type { SandboxFleetLimits } from "@opengeni/config";
import type { Database } from "./database";
import { rawRows } from "./database";

export const SANDBOX_UNPAID_FLEET_ROUTINE =
  "opengeni_private.sandbox_unpaid_fleet_v1(uuid, boolean)";

/** Fleet pressure as admission sees it. `failed`: no warm count could be read
 * recently, so admission fails closed for unpaid organizations. */
export type SandboxFleetPressure = {
  engaged: boolean;
  warmBoxes: number | null;
  failed: boolean;
};

/** How long one process reuses a warm count. */
const FLEET_PRESSURE_READ_INTERVAL_MS = 15_000;
/** How long a good reading stands in for failed reads. */
const FLEET_PRESSURE_STALE_AFTER_MS = 120_000;

const fleetPressureState: {
  engaged: boolean;
  warmBoxes: number | null;
  readAt: number;
  succeededAt: number;
  inflight: Promise<void> | null;
} = { engaged: false, warmBoxes: null, readAt: 0, succeededAt: 0, inflight: null };

/** Forget the process's fleet state (tests). */
export function resetSandboxFleetState(): void {
  fleetPressureState.engaged = false;
  fleetPressureState.warmBoxes = null;
  fleetPressureState.readAt = 0;
  fleetPressureState.succeededAt = 0;
  fleetPressureState.inflight = null;
  unpaidFleetRoutine.available = null;
  unpaidFleetBoxSeconds.value = null;
  unpaidFleetBoxSeconds.readAt = 0;
  unpaidFleetBoxSeconds.inflight = null;
}

function fleetPressureConfigured(limits: SandboxFleetLimits): boolean {
  return limits.pressureEngageWarmBoxes !== undefined;
}

/**
 * Apply one warm count to the pressure state: engage when it exceeds
 * `pressureEngageWarmBoxes`, release when it falls to
 * `pressureReleaseWarmBoxes` (or the engage level when unset) or below.
 * Returns the transition, if any.
 */
export function observeSandboxFleetWarmBoxes(
  limits: SandboxFleetLimits,
  warmBoxes: number,
  now = Date.now(),
): "engaged" | "released" | null {
  fleetPressureState.warmBoxes = warmBoxes;
  fleetPressureState.readAt = now;
  fleetPressureState.succeededAt = now;
  const engageAt = limits.pressureEngageWarmBoxes;
  if (engageAt === undefined) {
    const wasEngaged = fleetPressureState.engaged;
    fleetPressureState.engaged = false;
    return wasEngaged ? "released" : null;
  }
  const releaseAt = Math.min(limits.pressureReleaseWarmBoxes ?? engageAt, engageAt);
  if (!fleetPressureState.engaged && warmBoxes > engageAt) {
    fleetPressureState.engaged = true;
    console.warn("sandbox fleet pressure engaged: new unpaid boxes are limited", {
      warmBoxes,
      engageAt,
      unpaidRunningBoxes: limits.pressureUnpaidRunningBoxes ?? null,
    });
    return "engaged";
  }
  if (fleetPressureState.engaged && warmBoxes <= releaseAt) {
    fleetPressureState.engaged = false;
    console.warn("sandbox fleet pressure released", { warmBoxes, releaseAt });
    return "released";
  }
  return null;
}

function currentFleetPressure(now: number): SandboxFleetPressure {
  const fresh =
    fleetPressureState.succeededAt > 0 &&
    now - fleetPressureState.succeededAt < FLEET_PRESSURE_STALE_AFTER_MS;
  return {
    engaged: fleetPressureState.engaged,
    warmBoxes: fleetPressureState.warmBoxes,
    failed: !fresh,
  };
}

/** Boxes of every plan that are starting or warm. */
async function readFleetWarmBoxes(db: Database): Promise<number> {
  const rows = await rawRows<{ liveness: string; count: number | string }>(
    db,
    sql`select liveness, count from opengeni_private.count_sandbox_leases_by_liveness()`,
  );
  return rows
    .filter((row) => row.liveness === "warming" || row.liveness === "warm")
    .reduce((total, row) => total + Number(row.count), 0);
}

/**
 * Fleet pressure for one admission, reading the warm count at most every
 * fifteen seconds per process. A failed read keeps the last good reading for
 * two minutes and then reports `failed`.
 */
export async function readSandboxFleetPressure(
  db: Database,
  limits: SandboxFleetLimits,
  options: { onReadFailure?: (error: unknown) => void; now?: number } = {},
): Promise<SandboxFleetPressure> {
  if (!fleetPressureConfigured(limits)) return { engaged: false, warmBoxes: null, failed: false };
  const now = options.now ?? Date.now();
  if (now - fleetPressureState.readAt >= FLEET_PRESSURE_READ_INTERVAL_MS) {
    fleetPressureState.inflight ??= (async () => {
      try {
        observeSandboxFleetWarmBoxes(limits, await readFleetWarmBoxes(db));
      } catch (error) {
        // Wait a full interval before the next read; the last good reading
        // stands until it goes stale.
        fleetPressureState.readAt = Date.now();
        options.onReadFailure?.(error);
      } finally {
        fleetPressureState.inflight = null;
      }
    })();
    await fleetPressureState.inflight;
  }
  return currentFleetPressure(options.now ?? Date.now());
}

/** The unpaid running boxes (excluding one lease) and, when asked for, the
 * unpaid box seconds metered since 00:00 UTC. */
export type SandboxUnpaidFleetCounts = {
  runningBoxes: number;
  boxSecondsToday: number | null;
};

const unpaidFleetRoutine: { available: { value: boolean; at: number } | null } = {
  available: null,
};
/** A missing grant is rechecked every minute; once granted it stays so. */
const UNPAID_FLEET_ROUTINE_RECHECK_MS = 60_000;

/**
 * Whether this database lets the runtime call the unpaid-fleet definer. 1485
 * creates it with EXECUTE withheld, because the previous release rejects a
 * runtime grant on a definer it doesn't know; a later migration grants it.
 * Until then the unpaid running cap and fleet box-time budget are inactive.
 */
export async function sandboxUnpaidFleetAvailable(db: Database, now = Date.now()) {
  const cached = unpaidFleetRoutine.available;
  if (cached && (cached.value || now - cached.at < UNPAID_FLEET_ROUTINE_RECHECK_MS)) {
    return cached.value;
  }
  const [row] = await rawRows<{ available: boolean | null }>(
    db,
    sql`select coalesce(pg_catalog.has_function_privilege(
        pg_catalog.to_regprocedure(${SANDBOX_UNPAID_FLEET_ROUTINE}), 'EXECUTE'), false) as available`,
  );
  const value = row?.available === true;
  unpaidFleetRoutine.available = { value, at: now };
  return value;
}

/** Read the unpaid fleet; null when the definer is not available yet. */
export async function readSandboxUnpaidFleet(
  db: Database,
  input: { excludeLeaseId: string | null; withBoxSeconds: boolean },
): Promise<SandboxUnpaidFleetCounts | null> {
  if (!(await sandboxUnpaidFleetAvailable(db))) return null;
  const [row] = await rawRows<{
    running_boxes: number | string;
    box_seconds_today: number | string | null;
  }>(
    db,
    sql`select running_boxes, box_seconds_today
      from opengeni_private.sandbox_unpaid_fleet_v1(
        ${input.excludeLeaseId}::uuid, ${input.withBoxSeconds}::boolean)`,
  );
  return {
    runningBoxes: Number(row?.running_boxes ?? 0),
    boxSecondsToday:
      input.withBoxSeconds && row?.box_seconds_today != null ? Number(row.box_seconds_today) : null,
  };
}

/** How long one process reuses today's unpaid box time. */
const UNPAID_FLEET_BOX_SECONDS_READ_INTERVAL_MS = 60_000;
const unpaidFleetBoxSeconds: {
  value: number | null;
  readAt: number;
  inflight: Promise<void> | null;
} = { value: null, readAt: 0, inflight: null };

/**
 * Today's unpaid box time for one admission, read at most every minute per
 * process. Null when the definer is not available yet. Throws when the read
 * fails, so admission can fail closed.
 */
export async function readSandboxUnpaidFleetBoxSecondsToday(
  db: Database,
  now = Date.now(),
): Promise<number | null> {
  const dayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  if (
    unpaidFleetBoxSeconds.readAt > dayStart &&
    now - unpaidFleetBoxSeconds.readAt < UNPAID_FLEET_BOX_SECONDS_READ_INTERVAL_MS
  ) {
    return unpaidFleetBoxSeconds.value;
  }
  unpaidFleetBoxSeconds.inflight ??= (async () => {
    try {
      const counts = await readSandboxUnpaidFleet(db, {
        excludeLeaseId: null,
        withBoxSeconds: true,
      });
      unpaidFleetBoxSeconds.value = counts?.boxSecondsToday ?? null;
      unpaidFleetBoxSeconds.readAt = Date.now();
    } finally {
      unpaidFleetBoxSeconds.inflight = null;
    }
  })();
  await unpaidFleetBoxSeconds.inflight;
  return unpaidFleetBoxSeconds.value;
}

/**
 * Serialize new unpaid boxes across the fleet, so two admissions cannot both
 * take the last slot. Taken after the organization's own limit lock.
 */
export async function lockSandboxUnpaidFleet(tx: Database): Promise<void> {
  await tx.execute(
    sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sandbox-unpaid-fleet', 0))`,
  );
}
