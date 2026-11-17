// Bounds on warm boxes held only by viewers (docs/run-lifecycle.md, "Boxes
// held only by viewers").
//
// A viewer holder (an open session page heartbeating its live planes) keeps
// its box warm for as long as heartbeats arrive. Admission already refuses a
// viewer that would warm one more viewer-only box beyond the workspace or
// plan limits, but a box a turn, process or readiness hold kept warm becomes
// viewer-only when that holder leaves, and nothing ended a viewer-only hold.
// These are the database halves of the reaper's two bounds:
//
//   - idle drain: a box whose every holder is a viewer, whose sessions have no
//     open work, and that saw no viewer attach, reported viewer interaction,
//     message or turn for the idle window is released and drained;
//   - over-limit drain: beyond the workspace or plan limit on viewer-only
//     boxes, the least recently active boxes nobody has used for a short
//     quiet period are drained; a box someone is using is never evicted.
//
// Both drains go through the ordinary drain path: the viewer holders are
// deleted and the lease moves warm -> draining with the normal idle grace, so
// the reaper saves the workspace and stops the box exactly as it does when the
// last tab closes. A person who returns re-attaches and the box resumes.
//
// Everything runs in the workspace's own RLS context. The cross-workspace
// inventory comes from the existing list_meterable_warm_leases definer.
//
// A viewer's activity is the last interaction it reported, or its attach time
// when it never reported one (an older client). The box's activity also
// includes turns created or finished in its sessions.
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext } from "./database";

/** Session statuses that mean work is open (a turn is queued, running,
 * recovering, waiting for capacity or waiting on a person). A box whose
 * sessions have one is never drained or counted as viewer-only idle. */
export const VIEWER_ONLY_OPEN_SESSION_STATUSES = [
  "queued",
  "running",
  "requires_action",
  "recovering",
  "waiting_capacity",
] as const;

/** Backends whose warm boxes are outside these bounds: compute boxes are not
 * drained when idle by design, and selfhosted machines are not leased boxes. */
export const VIEWER_ONLY_EXEMPT_BACKENDS: ReadonlySet<string> = new Set(["compute", "selfhosted"]);

export type ViewerOnlyDrainReason =
  | "viewer_idle"
  | "viewer_workspace_limit"
  | "viewer_organization_limit";

/** The over-limit drain takes only boxes nobody has used for at least this
 * long (several viewer heartbeats), so a person using a box is never evicted. */
export const VIEWER_ONLY_LIMIT_QUIET_MS = 5 * 60_000;

const EXEMPT_BACKENDS_SQL = sql.raw(
  [...VIEWER_ONLY_EXEMPT_BACKENDS].map((backend) => `'${backend}'`).join(", "),
);
/** The compute-bounds drains (any holder) take compute boxes too, for a
 * closed tier or a spent day; only Connected Machines are outside them. */
const COMPUTE_BOUNDS_EXEMPT_BACKENDS_SQL = sql.raw("'selfhosted'");

export type ViewerOnlyWarmLease = {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  leaseEpoch: number;
  viewerHolders: number;
  /** Newest of: each viewer's last reported interaction (its attach time when
   * it never reported one), a turn created or finished in one of the box's
   * sessions. */
  lastActiveAt: Date;
  /** Database time of the read; decisions measure inactivity against it. */
  observedAt: Date;
  /** Whether any viewer on the box reported interaction (a current client). */
  interactionReported: boolean;
  /** A session of the box has open work; never drained here. */
  openSessionWork: boolean;
  /** A capture, rotation or reaper hold owns the box right now. It still
   * counts against the limits but is left to that owner this sweep. */
  transitioning: boolean;
};

type ViewerOnlyLeaseRow = {
  id: string;
  account_id: string;
  workspace_id: string;
  sandbox_group_id: string;
  lease_epoch: number | string;
  backend?: string | null;
  viewers: number | string;
  total?: number | string;
  commands?: number | string;
  interaction_reported: boolean | null;
  last_active_at: Date | string;
  observed_at: Date | string;
  open_session_work: boolean | null;
  transitioning: boolean;
};

const OPEN_STATUS_SQL = sql.raw(
  VIEWER_ONLY_OPEN_SESSION_STATUSES.map((status) => `'${status}'`).join(", "),
);

/** Warm, viewer-only leases of one workspace (optionally one group) with
 * their activity, or with `anyHolder` every warm lease no turn holds (viewer,
 * direct request, process or Browser/ComputerSession). Caller supplies the
 * RLS-scoped executor. */
function viewerOnlyLeaseQuery(
  workspaceId: string,
  sandboxGroupId: string | null,
  anyHolder = false,
) {
  return sql`
    select
      lease.id,
      lease.account_id,
      lease.workspace_id,
      lease.sandbox_group_id,
      lease.lease_epoch,
      lease.backend,
      holders.viewers,
      holders.total,
      holders.commands,
      holders.interaction_reported,
      greatest(holders.last_attach_or_interaction, sessions_activity.last_turn_activity)
        as last_active_at,
      now() as observed_at,
      coalesce(sessions_activity.open_work, false) as open_session_work,
      (
        lease.archive_capture_id is not null
        or lease.rotation_requested_at is not null
        or (lease.reaper_hold_id is not null and lease.reaper_hold_until > now())
      ) as transitioning
    from sandbox_leases lease
    cross join lateral (
      select
        count(*)::int as total,
        count(*) filter (where holder.kind = 'viewer')::int as viewers,
        count(*) filter (where holder.kind in ('process', 'interaction'))::int as commands,
        bool_or(holder.last_interaction_at is not null) as interaction_reported,
        max(coalesce(holder.last_interaction_at, holder.created_at)) as last_attach_or_interaction
      from sandbox_lease_holders holder
      where holder.lease_id = lease.id
    ) holders
    left join lateral (
      select
        bool_or(chat.status in (${OPEN_STATUS_SQL})) as open_work,
        max(greatest(newest.created_at, finished.finished_at)) as last_turn_activity
      from sessions chat
      left join lateral (
        select turn.created_at
        from session_turns turn
        where turn.workspace_id = chat.workspace_id and turn.session_id = chat.id
        order by turn.position desc
        limit 1
      ) newest on true
      left join lateral (
        select turn.finished_at
        from session_turns turn
        where turn.workspace_id = chat.workspace_id
          and turn.session_id = chat.id
          and turn.finished_at is not null
        order by turn.finished_at desc
        limit 1
      ) finished on true
      where chat.workspace_id = lease.workspace_id
        and chat.sandbox_group_id = lease.sandbox_group_id
    ) sessions_activity on true
    where lease.workspace_id = ${workspaceId}
      ${sandboxGroupId === null ? sql`` : sql`and lease.sandbox_group_id = ${sandboxGroupId}`}
      and lease.liveness = 'warm'
      and lease.turn_holders = 0
      and lease.backend not in (${anyHolder ? COMPUTE_BOUNDS_EXEMPT_BACKENDS_SQL : EXEMPT_BACKENDS_SQL})
      and holders.total > 0
      ${anyHolder ? sql`` : sql`and holders.total = holders.viewers`}
    order by lease.sandbox_group_id
  `;
}

function mapViewerOnlyLease(row: ViewerOnlyLeaseRow): ViewerOnlyWarmLease {
  return {
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sandboxGroupId: row.sandbox_group_id,
    leaseEpoch: Number(row.lease_epoch),
    viewerHolders: Number(row.viewers),
    lastActiveAt: new Date(row.last_active_at),
    observedAt: new Date(row.observed_at),
    interactionReported: row.interaction_reported === true,
    openSessionWork: row.open_session_work === true,
    transitioning: row.transitioning === true,
  };
}

/** Warm boxes of one workspace held only by viewers, with their activity. */
export async function listViewerOnlyWarmLeases(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<ViewerOnlyWarmLease[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await rawRows<ViewerOnlyLeaseRow>(
        scopedDb,
        viewerOnlyLeaseQuery(input.workspaceId, null),
      );
      return rows.map(mapViewerOnlyLease);
    },
  );
}

export type ViewerOnlyDrainOutcome =
  | { drained: true; releasedViewers: number }
  | {
      drained: false;
      reason:
        | "not_viewer_only"
        | "epoch_changed"
        | "open_session_work"
        | "transitioning"
        | "active_since_decision"
        | "compute_commands";
    };

/**
 * Release every viewer holder of one warm, viewer-only box and move it to
 * draining through the ordinary path (normal idle grace; the reaper then saves
 * the workspace and stops it). Everything the decision relied on is checked
 * again under the lease row lock, which heartbeats and attaches also take, so
 * a viewer that reported interaction or a turn that started after the reaper's
 * read keeps the box.
 */
export async function drainViewerOnlyLease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    reason: ViewerOnlyDrainReason;
    /** The box is drained only if nothing on it was active for this long,
     * measured on the database clock under the lease lock. */
    quietForMs: number;
    /** And, when given, nothing was active after this time (the activity the
     * over-limit decision ranked). */
    activeAtOrBefore?: Date;
    idleGraceMs: number;
  },
): Promise<ViewerOnlyDrainOutcome> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw): Promise<ViewerOnlyDrainOutcome> => {
        const tx = txRaw as unknown as Database;
        // Canonical lock order lease -> holder, as heartbeats and attaches.
        const locked = await rawRows<{
          id: string;
          lease_epoch: number | string;
        }>(
          tx,
          sql`
            select id, lease_epoch from sandbox_leases
            where workspace_id = ${input.workspaceId}
              and sandbox_group_id = ${input.sandboxGroupId}
            for update
          `,
        );
        const lease = locked[0];
        if (!lease) return { drained: false, reason: "not_viewer_only" };
        if (Number(lease.lease_epoch) !== input.expectedEpoch) {
          return { drained: false, reason: "epoch_changed" };
        }
        const current = (
          await rawRows<ViewerOnlyLeaseRow>(
            tx,
            viewerOnlyLeaseQuery(input.workspaceId, input.sandboxGroupId),
          )
        ).map(mapViewerOnlyLease)[0];
        if (!current) return { drained: false, reason: "not_viewer_only" };
        if (current.openSessionWork) return { drained: false, reason: "open_session_work" };
        if (current.transitioning) return { drained: false, reason: "transitioning" };
        const quietCutoffMs =
          current.observedAt.getTime() - Math.max(0, Math.floor(input.quietForMs));
        if (
          current.lastActiveAt.getTime() > quietCutoffMs ||
          (input.activeAtOrBefore !== undefined &&
            current.lastActiveAt.getTime() > input.activeAtOrBefore.getTime())
        ) {
          return { drained: false, reason: "active_since_decision" };
        }
        const released = await rawRows<{ id: string }>(
          tx,
          sql`
            delete from sandbox_lease_holders
            where lease_id = ${lease.id} and kind = 'viewer'
            returning id
          `,
        );
        await tx.execute(sql`
          update sandbox_leases set
            refcount = 0, turn_holders = 0, viewer_holders = 0,
            liveness = 'draining',
            expires_at = now() + (${String(input.idleGraceMs)} || ' milliseconds')::interval,
            ${input.reason === "viewer_idle" ? sql`viewer_idle_drained_at = now(),` : sql``}
            updated_at = now()
          where id = ${lease.id}
            and liveness = 'warm'
            and lease_epoch = ${input.expectedEpoch}
        `);
        return { drained: true, releasedViewers: released.length };
      }),
  );
}

// ============================================================================
// Free-compute bounds over every holder kind (docs/deployment.md, "Free compute
// bounds"). For an organization whose plan sets them, the reaper also drains a
// warm box no turn holds, whatever holds it:
//
//   - compute_closed: the plan allows no sandbox (a held or denied
//     organization that has not paid);
//   - compute_daily_budget: the organization or its people used today's box
//     time;
//   - compute_idle: nothing on it was used (a new request, process, browser
//     or desktop session, reported viewer interaction, message or turn) for
//     the idle window.
//
// A box held only by viewers and in-flight requests drains like a viewer-only
// box. A box that still runs commands or holds a Browser/ComputerSession gets
// the orderly stop a box gets before its provider lifetime ends (a
// provider-deadline rotation): new arrivals are fenced, its commands are
// asked to stop, /workspace is saved and the box ends. Nothing restarts it
// until someone is admitted again.
// ============================================================================

export type ComputeBoundsDrainReason = "compute_closed" | "compute_daily_budget" | "compute_idle";

export type NoTurnWarmLease = ViewerOnlyWarmLease & {
  /** The box's backend (`compute` boxes are listed but never idle-drained). */
  backend: string;
  /** Every holder (viewer, direct request, process, Browser/ComputerSession). */
  holders: number;
  /** Process and Browser/ComputerSession holders. */
  commandHolders: number;
};

function mapNoTurnLease(row: ViewerOnlyLeaseRow): NoTurnWarmLease {
  return {
    ...mapViewerOnlyLease(row),
    backend: row.backend ?? "",
    holders: Number(row.total ?? 0),
    commandHolders: Number(row.commands ?? 0),
  };
}

/** Warm boxes of one workspace that no turn holds, with their activity. */
export async function listNoTurnWarmLeases(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<NoTurnWarmLease[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await rawRows<ViewerOnlyLeaseRow>(
        scopedDb,
        viewerOnlyLeaseQuery(input.workspaceId, null, true),
      );
      return rows.map(mapNoTurnLease);
    },
  );
}

export type ComputeBoundsDrainOutcome =
  | { drained: true; mode: "drained" | "stop_requested"; releasedHolders: number }
  | {
      drained: false;
      reason:
        | "not_held"
        | "epoch_changed"
        | "open_session_work"
        | "transitioning"
        | "active_since_decision"
        | "compute_commands";
    };

/**
 * Drain one warm box no turn holds under the plan's compute bounds. The
 * decision is checked again under the lease row lock: a turn that arrived
 * keeps the box, and for `compute_idle` so does any activity since the read
 * or open session work. Viewer and direct-request holders are released; a box
 * still holding processes or a Browser/ComputerSession instead gets a
 * provider-deadline rotation request (see above).
 */
export async function drainNoTurnLeaseForComputeBounds(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    reason: ComputeBoundsDrainReason;
    /** compute_idle only: nothing on the box was active for this long. */
    quietForMs: number;
    idleGraceMs: number;
  },
): Promise<ComputeBoundsDrainOutcome> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw): Promise<ComputeBoundsDrainOutcome> => {
        const tx = txRaw as unknown as Database;
        const locked = await rawRows<{ id: string; lease_epoch: number | string }>(
          tx,
          sql`
            select id, lease_epoch from sandbox_leases
            where workspace_id = ${input.workspaceId}
              and sandbox_group_id = ${input.sandboxGroupId}
            for update
          `,
        );
        const lease = locked[0];
        if (!lease) return { drained: false, reason: "not_held" };
        if (Number(lease.lease_epoch) !== input.expectedEpoch) {
          return { drained: false, reason: "epoch_changed" };
        }
        const current = (
          await rawRows<ViewerOnlyLeaseRow>(
            tx,
            viewerOnlyLeaseQuery(input.workspaceId, input.sandboxGroupId, true),
          )
        ).map(mapNoTurnLease)[0];
        if (!current) return { drained: false, reason: "not_held" };
        if (current.transitioning) return { drained: false, reason: "transitioning" };
        // A compute box is never idle-drained, and its commands have no
        // orderly provider-deadline stop: such a box with live processes or
        // Browser/ComputerSessions is left to them.
        if (
          current.backend === "compute" &&
          (input.reason === "compute_idle" || current.commandHolders > 0)
        ) {
          return { drained: false, reason: "compute_commands" };
        }
        if (input.reason === "compute_idle") {
          if (current.openSessionWork) return { drained: false, reason: "open_session_work" };
          const quietCutoffMs =
            current.observedAt.getTime() - Math.max(0, Math.floor(input.quietForMs));
          if (current.lastActiveAt.getTime() > quietCutoffMs) {
            return { drained: false, reason: "active_since_decision" };
          }
        }
        const released = await rawRows<{ id: string }>(
          tx,
          sql`
            delete from sandbox_lease_holders
            where lease_id = ${lease.id} and kind in ('viewer', 'direct')
            returning id
          `,
        );
        if (current.commandHolders === 0) {
          await tx.execute(sql`
            update sandbox_leases set
              refcount = 0, turn_holders = 0, viewer_holders = 0,
              liveness = 'draining',
              expires_at = now() + (${String(input.idleGraceMs)} || ' milliseconds')::interval,
              updated_at = now()
            where id = ${lease.id}
              and liveness = 'warm'
              and lease_epoch = ${input.expectedEpoch}
          `);
          return { drained: true, mode: "drained", releasedHolders: released.length };
        }
        await tx.execute(sql`
          update sandbox_leases set
            rotation_requested_at = coalesce(rotation_requested_at, now()),
            rotation_reason = 'provider_deadline',
            refcount = (select count(*)::int from sandbox_lease_holders holder
              where holder.lease_id = ${lease.id}),
            viewer_holders = 0,
            updated_at = now()
          where id = ${lease.id}
            and liveness = 'warm'
            and lease_epoch = ${input.expectedEpoch}
        `);
        return { drained: true, mode: "stop_requested", releasedHolders: released.length };
      }),
  );
}
