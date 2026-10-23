import {
  AttachedBrowserDevice,
  AttachedBrowserDeviceCapabilities,
  AttachedBrowserDeviceListResponse,
  AttachedBrowserInventorySnapshot,
  type AttachedBrowserDevice as AttachedBrowserDeviceValue,
  type AttachedBrowserDeviceAnnouncement,
  type AttachedBrowserDeviceListResponse as AttachedBrowserDeviceListResponseValue,
  type AttachedBrowserInventorySnapshot as AttachedBrowserInventorySnapshotValue,
} from "@opengeni/contracts";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { type Database, rawRows, setSubjectRlsContext, withRlsContext } from "./database";
import {
  advanceWorkspaceInteractionRevision,
  readWorkspaceInteractionRevision,
} from "./interaction-revisions";
import * as schema from "./schema";

const ATTACHED_DEVICE_LIVE_LIFECYCLES = ["starting", "active", "suspending", "restoring"] as const;
// `ending` stays off this list so an in-flight `/end` can finish physical
// teardown (`stopCapture` + helper exit) after Chrome reconnects.

const CONTROLLER_TRANSITION_EXPIRED = "controller_transition_expired";
const CONNECTION_HISTORY_LIMIT = 50;

type ConnectionHistoryEntry = schema.AttachedBrowserConnectionHistoryEntry;

/** Merge newly observed connection ends into a profile's bounded history.
 *  One entry per generation: the machine bridge's own observation replaces a
 *  server inference, never the reverse. Returns null when nothing changed,
 *  including an addition too old to survive the bound. */
export function mergeAttachedBrowserConnectionHistory(
  history: readonly ConnectionHistoryEntry[],
  additions: readonly ConnectionHistoryEntry[],
): ConnectionHistoryEntry[] | null {
  const byGeneration = new Map(history.map((entry) => [entry.connectionGeneration, entry]));
  for (const entry of additions) {
    const existing = byGeneration.get(entry.connectionGeneration);
    if (existing && (existing.source === "agent" || entry.source === "server")) continue;
    byGeneration.set(entry.connectionGeneration, entry);
  }
  const merged = [...byGeneration.values()]
    .sort((left, right) => left.endedAt.localeCompare(right.endedAt))
    .slice(-CONNECTION_HISTORY_LIMIT);
  const unchanged =
    merged.length === history.length && merged.every((entry, index) => entry === history[index]);
  return unchanged ? null : merged;
}

type DeviceRow = typeof schema.attachedBrowserDevices.$inferSelect;

const CONSISTENT_READ = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

export class AttachedBrowserDeviceNotFoundError extends Error {
  readonly name = "AttachedBrowserDeviceNotFoundError";
}

export class AttachedBrowserInventoryConflictError extends Error {
  readonly name = "AttachedBrowserInventoryConflictError";
}

export type ReconcileAttachedBrowserInventoryResult = {
  accepted: boolean;
  changed: boolean;
  revision: number;
};

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is outside safe range`);
  return value;
}

/** Who is looking at a workspace's attached browsers. Personal (Only me)
 *  machines show their browsers only to their owner, exactly like the machines
 *  themselves; for an agent this is the person its turn acts for. */
export type AttachedBrowserViewer = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
};

type EnrollmentVisibility = {
  active: Set<string>;
  /** Revoked machines the viewer may still see, with when they were revoked. */
  revoked: Map<string, Date | null>;
  /** Each visible machine's sandbox and plain name, as the Machines list shows it. */
  machines: Map<string, { sandboxId: string | null; machineName: string }>;
  /** Where each visible machine is enrolled, which is where its Chrome
   *  profiles are stored. An organization or personal machine can be
   *  enrolled in another workspace than the viewer's. */
  workspaces: Map<string, string>;
};

/** The machines this viewer may see here, through the same owner-aware
 *  machine listing used everywhere else (`list_scoped_enrollments`). */
async function visibleEnrollments(
  db: Database,
  viewer: AttachedBrowserViewer,
): Promise<EnrollmentVisibility> {
  return await withRlsContext(db, viewer, async (scopedDb) => {
    await setSubjectRlsContext(scopedDb, viewer.subjectId);
    const rows = await rawRows<{
      id: string;
      workspaceId: string;
      status: string;
      revokedAt: string | null;
      sandboxId: string | null;
      sandboxName: string | null;
      os: string;
    }>(
      scopedDb,
      sql`select value->>'id' as id, value->>'workspaceId' as "workspaceId",
          value->>'status' as status, value->>'revokedAt' as "revokedAt",
          value->>'sandboxId' as "sandboxId", value->>'sandboxName' as "sandboxName",
          value->>'os' as os
        from list_scoped_enrollments(
          ${viewer.accountId}::uuid, ${viewer.workspaceId}::uuid, null, 'active') value
        union all
        select value->>'id', value->>'workspaceId', value->>'status', value->>'revokedAt',
          value->>'sandboxId', value->>'sandboxName', value->>'os'
        from list_scoped_enrollments(
          ${viewer.accountId}::uuid, ${viewer.workspaceId}::uuid, null, 'revoked') value`,
    );
    const visibility: EnrollmentVisibility = {
      active: new Set(),
      revoked: new Map(),
      machines: new Map(),
      workspaces: new Map(),
    };
    for (const row of rows) {
      if (row.status === "active") visibility.active.add(row.id);
      else visibility.revoked.set(row.id, row.revokedAt ? new Date(row.revokedAt) : null);
      visibility.workspaces.set(row.id, row.workspaceId);
      // The same name the Machines list gives this machine.
      visibility.machines.set(row.id, {
        sandboxId: row.sandboxId,
        machineName: row.sandboxName ?? `${row.os} machine`,
      });
    }
    return visibility;
  });
}

/** Run `read` once per workspace holding visible machines, the viewer's own
 *  workspace first, each under that workspace's row-level security, inside
 *  the caller's transaction. The viewer's machine listing already authorized
 *  every enrollment passed to `read`. */
async function readVisibleWorkspaces<T>(
  scopedDb: Database,
  viewer: AttachedBrowserViewer,
  visibility: EnrollmentVisibility,
  read: (db: Database, workspaceId: string, enrollmentIds: string[]) => Promise<T[]>,
): Promise<T[]> {
  const byWorkspace = new Map<string, string[]>();
  for (const [enrollmentId, workspaceId] of visibility.workspaces) {
    const ids = byWorkspace.get(workspaceId) ?? [];
    ids.push(enrollmentId);
    byWorkspace.set(workspaceId, ids);
  }
  const workspaceIds = [...byWorkspace.keys()].sort((left, right) => {
    if (left === viewer.workspaceId) return -1;
    if (right === viewer.workspaceId) return 1;
    return left.localeCompare(right);
  });
  const results: T[] = [];
  for (const workspaceId of workspaceIds) {
    const enrollmentIds = (byWorkspace.get(workspaceId) ?? []).sort();
    results.push(
      ...(workspaceId === viewer.workspaceId
        ? await read(scopedDb, workspaceId, enrollmentIds)
        : await withRlsContext(
            scopedDb,
            { accountId: viewer.accountId, workspaceId },
            async (workspaceDb) => await read(workspaceDb, workspaceId, enrollmentIds),
          )),
    );
  }
  return results;
}

/** List order: connected first, then most recently disconnected and updated. */
function compareDeviceRows(left: DeviceRow, right: DeviceRow): number {
  const leftDisconnected = left.disconnectedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightDisconnected = right.disconnectedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftDisconnected !== rightDisconnected) return rightDisconnected - leftDisconnected;
  const updated = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updated !== 0) return updated;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0;
}

/** One Chrome profile id can be stored twice when the same computer is
 *  enrolled in two workspaces. Address the connected one, preferring the
 *  viewer's own workspace, then the most recent. */
function preferredDevice(
  devices: readonly AttachedBrowserDeviceValue[],
  viewerWorkspaceId: string,
): AttachedBrowserDeviceValue | null {
  const ranked = [...devices].sort(
    (left, right) =>
      Number(left.state !== "connected") - Number(right.state !== "connected") ||
      Number(left.workspaceId !== viewerWorkspaceId) -
        Number(right.workspaceId !== viewerWorkspaceId) ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  return ranked[0] ?? null;
}

/** A device as this viewer may see it: null when its machine is hidden from
 *  them; disconnected whenever its machine is no longer enrolled. */
function visibleDevice(
  row: DeviceRow,
  visibility: EnrollmentVisibility,
  observedAt: Date | null = null,
): AttachedBrowserDeviceValue | null {
  // A full accepted snapshot observes every still-connected profile. Keep that
  // liveness once per enrollment, not as a repeated write to every device row.
  // Disconnected rows freeze their last observation when they transition.
  if (row.disconnectedAt === null && observedAt && observedAt > row.lastSeenAt) {
    row = { ...row, lastSeenAt: observedAt };
  }
  if (visibility.active.has(row.enrollmentId)) return deviceFromRow(row);
  if (!visibility.revoked.has(row.enrollmentId)) return null;
  const revokedAt = visibility.revoked.get(row.enrollmentId) ?? row.updatedAt;
  return deviceFromRow({ ...row, disconnectedAt: row.disconnectedAt ?? revokedAt });
}

function deviceFromRow(row: DeviceRow): AttachedBrowserDeviceValue {
  return AttachedBrowserDevice.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    enrollmentId: row.enrollmentId,
    name: row.name,
    profileLabel: row.profileLabel,
    browserName: row.browserName,
    browserVersion: row.browserVersion,
    extensionVersion: row.extensionVersion,
    platform: row.platform,
    architecture: row.architecture,
    state: row.disconnectedAt ? "disconnected" : "connected",
    connectionGeneration: row.connectionGeneration,
    inventoryRevision: safeInteger(row.inventoryRevision, "attached browser inventory revision"),
    tabCount: safeInteger(row.tabCount, "attached browser tab count"),
    capabilities: row.capabilities,
    lastSeenAt: row.lastSeenAt.toISOString(),
    disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function sameAnnouncement(row: DeviceRow, value: AttachedBrowserDeviceAnnouncement): boolean {
  return (
    row.name === value.name &&
    row.profileLabel === value.profileLabel &&
    row.browserName === value.browserName &&
    row.browserVersion === value.browserVersion &&
    row.extensionVersion === value.extensionVersion &&
    row.platform === value.platform &&
    row.architecture === value.architecture &&
    row.connectionGeneration === value.connectionGeneration &&
    row.inventoryRevision === value.inventoryRevision &&
    row.tabCount === value.tabCount &&
    JSON.stringify(AttachedBrowserDeviceCapabilities.parse(row.capabilities)) ===
      JSON.stringify(value.capabilities) &&
    row.disconnectedAt === null
  );
}

/** The announcement as another workspace's list shows it: everything but
 *  the tab count and inventory revision, which change with every tab. */
function sameListing(row: DeviceRow, value: AttachedBrowserDeviceAnnouncement): boolean {
  return sameAnnouncement(row, {
    ...value,
    tabCount: row.tabCount,
    inventoryRevision: row.inventoryRevision,
  });
}

/** Reconcile one full browser-bridge snapshot. The enrollment row serializes
 *  concurrent heartbeats; a lower revision from the same bridge generation is
 *  ignored, and a replay only refreshes liveness. */
export async function reconcileAttachedBrowserInventory(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
    snapshot: AttachedBrowserInventorySnapshotValue;
  },
): Promise<ReconcileAttachedBrowserInventoryResult> {
  const snapshot = AttachedBrowserInventorySnapshot.parse(input.snapshot);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const [enrollment] = await tx
          .select({
            id: schema.enrollments.id,
            accountId: schema.enrollments.accountId,
            workspaceId: schema.enrollments.workspaceId,
            status: schema.enrollments.status,
            authorityScope: schema.enrollments.authorityScope,
          })
          .from(schema.enrollments)
          .where(
            and(
              eq(schema.enrollments.id, input.enrollmentId),
              eq(schema.enrollments.accountId, input.accountId),
              eq(schema.enrollments.workspaceId, input.workspaceId),
            ),
          )
          .for("update")
          .limit(1);
        if (!enrollment || enrollment.status !== "active") {
          throw new AttachedBrowserInventoryConflictError(
            "attached browser inventory belongs to an unavailable enrollment",
          );
        }

        const [cursor] = await tx
          .select()
          .from(schema.attachedBrowserInventories)
          .where(
            and(
              eq(schema.attachedBrowserInventories.workspaceId, input.workspaceId),
              eq(schema.attachedBrowserInventories.enrollmentId, input.enrollmentId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          cursor?.bridgeGeneration === snapshot.bridgeGeneration &&
          snapshot.revision < cursor.revision
        ) {
          return {
            accepted: false,
            changed: false,
            revision: await readWorkspaceInteractionRevision(tx, input.workspaceId),
          };
        }

        const now = new Date();
        // The enrollment lock serializes its snapshots and excludes revocation /
        // cross-enrollment reclaim. An unchanged snapshot needs no device locks:
        // those create WAL and contend with controller operations even without
        // an UPDATE. Re-read under the existing device locks before changing any
        // material state, including reclaim, generation changes and disconnects.
        const announcedIds = snapshot.devices.map((device) => device.id);
        const ownedOrAnnounced =
          announcedIds.length > 0
            ? or(
                eq(schema.attachedBrowserDevices.enrollmentId, input.enrollmentId),
                inArray(schema.attachedBrowserDevices.id, announcedIds),
              )
            : eq(schema.attachedBrowserDevices.enrollmentId, input.enrollmentId);
        const readRows = () =>
          tx
            .select()
            .from(schema.attachedBrowserDevices)
            .where(
              and(
                eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
                ownedOrAnnounced,
              ),
            );
        let rows = await readRows();
        const observed = new Map(rows.map((row) => [row.id, row]));
        const announced = new Set(announcedIds);
        const materialChange =
          snapshot.devices.some((device) => {
            const row = observed.get(device.id);
            return (
              !row || row.enrollmentId !== input.enrollmentId || !sameAnnouncement(row, device)
            );
          }) ||
          rows.some(
            (row) =>
              row.enrollmentId === input.enrollmentId &&
              row.disconnectedAt === null &&
              !announced.has(row.id),
          );
        if (materialChange) rows = await readRows().for("update");
        const byId = new Map(rows.map((row) => [row.id, row]));
        const generationChangedDeviceIds = new Set<string>();
        const insertedDeviceIds = new Set<string>();
        let changed = false;
        // Whether other workspaces listing this machine's profiles see a
        // difference: not for tab counts and inventory revisions alone.
        let listingChanged = false;
        for (const device of snapshot.devices) {
          const existing = byId.get(device.id);
          let reclaimingRevokedEnrollment = false;
          if (existing && existing.enrollmentId !== input.enrollmentId) {
            const [previousEnrollment] = await tx
              .select({ status: schema.enrollments.status })
              .from(schema.enrollments)
              .where(
                and(
                  eq(schema.enrollments.id, existing.enrollmentId),
                  eq(schema.enrollments.accountId, input.accountId),
                  eq(schema.enrollments.workspaceId, input.workspaceId),
                ),
              )
              .limit(1);
            if (previousEnrollment?.status !== "revoked") {
              throw new AttachedBrowserInventoryConflictError(
                "attached browser device id is already owned by another active enrollment",
              );
            }
            reclaimingRevokedEnrollment = true;
          }
          if (!existing) {
            await tx.insert(schema.attachedBrowserDevices).values({
              id: device.id,
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              enrollmentId: input.enrollmentId,
              name: device.name,
              profileLabel: device.profileLabel,
              browserName: device.browserName,
              browserVersion: device.browserVersion,
              extensionVersion: device.extensionVersion,
              platform: device.platform,
              architecture: device.architecture,
              connectionGeneration: device.connectionGeneration,
              inventoryRevision: device.inventoryRevision,
              tabCount: device.tabCount,
              capabilities: device.capabilities,
              lastSeenAt: now,
              disconnectedAt: null,
              createdAt: now,
              updatedAt: now,
            });
            insertedDeviceIds.add(device.id);
            changed = true;
            listingChanged = true;
            continue;
          }
          if (existing.connectionGeneration !== device.connectionGeneration) {
            generationChangedDeviceIds.add(device.id);
          }
          const materialChanged =
            reclaimingRevokedEnrollment || !sameAnnouncement(existing, device);
          if (materialChanged)
            await tx
              .update(schema.attachedBrowserDevices)
              .set({
                enrollmentId: input.enrollmentId,
                name: device.name,
                profileLabel: device.profileLabel,
                browserName: device.browserName,
                browserVersion: device.browserVersion,
                extensionVersion: device.extensionVersion,
                platform: device.platform,
                architecture: device.architecture,
                connectionGeneration: device.connectionGeneration,
                inventoryRevision: device.inventoryRevision,
                tabCount: device.tabCount,
                capabilities: device.capabilities,
                lastSeenAt: new Date(
                  Math.max(
                    now.getTime(),
                    existing.lastSeenAt.getTime(),
                    cursor?.observedAt.getTime() ?? 0,
                  ),
                ),
                disconnectedAt: null,
                updatedAt: new Date(Math.max(now.getTime(), existing.updatedAt.getTime())),
              })
              .where(
                and(
                  eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
                  eq(schema.attachedBrowserDevices.id, device.id),
                ),
              );
          changed ||= materialChanged;
          listingChanged ||= reclaimingRevokedEnrollment || !sameListing(existing, device);
        }

        let audience: string[] | undefined;
        const readAudience = async () =>
          (audience ??= await attachedBrowserAudience(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            authorityScope: enrollment.authorityScope,
          }));
        if (
          generationChangedDeviceIds.size > 0 &&
          (await terminalizeStaleAttachedDeviceSessions(tx, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            deviceIds: [...generationChangedDeviceIds],
            audience: await readAudience(),
          }))
        ) {
          changed = true;
          listingChanged = true;
        }

        const disconnectedIds = rows
          .filter(
            (row) =>
              row.enrollmentId === input.enrollmentId &&
              row.disconnectedAt === null &&
              !announced.has(row.id),
          )
          .map((row) => row.id);
        if (disconnectedIds.length > 0) {
          await tx
            .update(schema.attachedBrowserDevices)
            .set({
              disconnectedAt: now,
              updatedAt: sql`greatest(${schema.attachedBrowserDevices.updatedAt}, ${now.toISOString()}::timestamptz)`,
              lastSeenAt: cursor
                ? sql`greatest(${schema.attachedBrowserDevices.lastSeenAt}, ${cursor.observedAt.toISOString()}::timestamptz)`
                : schema.attachedBrowserDevices.lastSeenAt,
            })
            .where(
              and(
                eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
                eq(schema.attachedBrowserDevices.enrollmentId, input.enrollmentId),
                inArray(schema.attachedBrowserDevices.id, disconnectedIds),
                isNull(schema.attachedBrowserDevices.disconnectedAt),
              ),
            );
          changed = true;
          listingChanged = true;
        }

        await recordAttachedBrowserConnectionEnds(tx, {
          workspaceId: input.workspaceId,
          enrollmentId: input.enrollmentId,
          snapshot,
          rows,
          insertedDeviceIds,
          disconnectedIds,
          bridgeRestarted:
            cursor !== undefined && cursor.bridgeGeneration !== snapshot.bridgeGeneration,
          now,
        });

        if (cursor) {
          await tx
            .update(schema.attachedBrowserInventories)
            .set({
              observedAt: sql`greatest(${schema.attachedBrowserInventories.observedAt}, ${now.toISOString()}::timestamptz)`,
              ...(cursor.bridgeGeneration !== snapshot.bridgeGeneration ||
              cursor.revision !== snapshot.revision
                ? {
                    bridgeGeneration: snapshot.bridgeGeneration,
                    revision: snapshot.revision,
                    updatedAt: sql`greatest(${schema.attachedBrowserInventories.updatedAt}, ${now.toISOString()}::timestamptz)`,
                  }
                : {}),
            })
            .where(
              and(
                eq(schema.attachedBrowserInventories.workspaceId, input.workspaceId),
                eq(schema.attachedBrowserInventories.enrollmentId, input.enrollmentId),
              ),
            );
        } else {
          await tx.insert(schema.attachedBrowserInventories).values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            enrollmentId: input.enrollmentId,
            bridgeGeneration: snapshot.bridgeGeneration,
            revision: snapshot.revision,
            observedAt: now,
            updatedAt: now,
          });
        }
        const revision = changed
          ? await advanceInteractionRevisions(tx, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              workspaceIds: listingChanged ? await readAudience() : [input.workspaceId],
            })
          : await readWorkspaceInteractionRevision(tx, input.workspaceId);
        return { accepted: true, changed, revision };
      }),
  );
}

/** Persist why profile connection generations ended. The bridge's own
 *  report wins; a generation that ended without one is still recorded, as
 *  `agent_restarted` when the whole bridge was replaced, otherwise
 *  `unreported` (an agent too old to report). History is diagnostic only: it
 *  never changes device state, `updatedAt`, or the interaction revision. */
async function recordAttachedBrowserConnectionEnds(
  tx: Database,
  input: {
    workspaceId: string;
    enrollmentId: string;
    snapshot: AttachedBrowserInventorySnapshotValue;
    rows: readonly DeviceRow[];
    insertedDeviceIds: ReadonlySet<string>;
    disconnectedIds: readonly string[];
    bridgeRestarted: boolean;
    now: Date;
  },
): Promise<void> {
  const announced = new Map(input.snapshot.devices.map((device) => [device.id, device]));
  const histories = new Map<string, readonly ConnectionHistoryEntry[]>();
  for (const row of input.rows) {
    if (row.enrollmentId === input.enrollmentId || announced.has(row.id)) {
      histories.set(row.id, row.connectionHistory);
    }
  }
  for (const deviceId of input.insertedDeviceIds) histories.set(deviceId, []);

  const additions = new Map<string, ConnectionHistoryEntry[]>();
  const add = (deviceId: string, entry: ConnectionHistoryEntry) => {
    if (!histories.has(deviceId)) return;
    const list = additions.get(deviceId) ?? [];
    list.push(entry);
    additions.set(deviceId, list);
  };
  for (const end of input.snapshot.connectionEnds ?? []) {
    add(end.deviceId, {
      connectionGeneration: end.connectionGeneration,
      reason: end.reason,
      detail: end.detail,
      endedAt: end.endedAt,
      connectedMs: end.connectedMs,
      source: "agent",
    });
  }
  const inferredReason = input.bridgeRestarted ? "agent_restarted" : "unreported";
  const inferred = (row: DeviceRow, endedAt: Date): ConnectionHistoryEntry => ({
    connectionGeneration: row.connectionGeneration,
    reason: inferredReason,
    detail: null,
    endedAt: endedAt.toISOString(),
    connectedMs: null,
    source: "server",
  });
  const disconnected = new Set(input.disconnectedIds);
  for (const row of input.rows) {
    const device = announced.get(row.id);
    if (device && device.connectionGeneration !== row.connectionGeneration) {
      add(row.id, inferred(row, row.disconnectedAt ?? input.now));
    } else if (disconnected.has(row.id)) {
      add(row.id, inferred(row, input.now));
    }
  }

  for (const [deviceId, entries] of additions) {
    const merged = mergeAttachedBrowserConnectionHistory(histories.get(deviceId) ?? [], entries);
    if (!merged) continue;
    await tx
      .update(schema.attachedBrowserDevices)
      .set({ connectionHistory: merged })
      .where(
        and(
          eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
          eq(schema.attachedBrowserDevices.id, deviceId),
          eq(schema.attachedBrowserDevices.enrollmentId, input.enrollmentId),
        ),
      );
  }
}

/** A new physical Chrome generation cannot inherit a prior controller token.
 *  Mark every still-live BrowserSession/ComputerSession on that exact device
 *  lost in place, in every workspace that can use the device. Never rewrite
 *  placementInstanceId onto the successor. Returns whether any session
 *  changed; the caller advances the audience's interaction revisions. */
async function terminalizeStaleAttachedDeviceSessions(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    deviceIds: readonly string[];
    audience: readonly string[];
  },
): Promise<boolean> {
  if (input.deviceIds.length === 0) return false;
  const deviceIds = [...input.deviceIds].sort();
  let changed = false;
  for (const workspaceId of input.audience) {
    const target = { workspaceId, deviceWorkspaceId: input.workspaceId, deviceIds };
    changed =
      (workspaceId === input.workspaceId
        ? await terminalizeWorkspaceAttachedDeviceSessions(tx, target)
        : await withRlsContext(
            tx,
            { accountId: input.accountId, workspaceId },
            async (otherDb) => await terminalizeWorkspaceAttachedDeviceSessions(otherDb, target),
          )) || changed;
  }
  return changed;
}

async function terminalizeWorkspaceAttachedDeviceSessions(
  tx: Database,
  input: { workspaceId: string; deviceWorkspaceId: string; deviceIds: readonly string[] },
): Promise<boolean> {
  const browserRows = await tx
    .select({ id: schema.browserSessions.id })
    .from(schema.browserSessions)
    .where(
      and(
        eq(schema.browserSessions.workspaceId, input.workspaceId),
        eq(schema.browserSessions.placementKind, "attached_device"),
        deviceWorkspaceMatches(schema.browserSessions, input),
        inArray(schema.browserSessions.deviceId, [...input.deviceIds]),
        inArray(schema.browserSessions.lifecycle, [...ATTACHED_DEVICE_LIVE_LIFECYCLES]),
      ),
    );
  const computerRows = await tx
    .select({ id: schema.computerSessions.id })
    .from(schema.computerSessions)
    .where(
      and(
        eq(schema.computerSessions.workspaceId, input.workspaceId),
        eq(schema.computerSessions.placementKind, "attached_device"),
        deviceWorkspaceMatches(schema.computerSessions, input),
        inArray(schema.computerSessions.deviceId, [...input.deviceIds]),
        inArray(schema.computerSessions.lifecycle, [...ATTACHED_DEVICE_LIVE_LIFECYCLES]),
      ),
    );
  if (browserRows.length === 0 && computerRows.length === 0) return false;

  const browserIds = browserRows.map((row) => row.id).sort();
  const computerIds = computerRows.map((row) => row.id).sort();
  const resourceIds = [...browserIds, ...computerIds];
  const operations = await tx
    .select({ operationId: schema.interactionOperations.operationId })
    .from(schema.interactionOperations)
    .where(
      and(
        eq(schema.interactionOperations.workspaceId, input.workspaceId),
        inArray(schema.interactionOperations.resourceId, resourceIds),
        inArray(schema.interactionOperations.state, ["prepared", "dispatched"]),
      ),
    );
  const operationIds = operations.map((row) => row.operationId).sort();
  for (const operationId of operationIds) {
    await tx.execute(sql`
      select operation_id from interaction_operations
      where workspace_id = ${input.workspaceId} and operation_id = ${operationId}
      for update
    `);
  }
  for (const browserSessionId of browserIds) {
    await tx.execute(sql`
      select id from browser_sessions
      where workspace_id = ${input.workspaceId} and id = ${browserSessionId}
      for update
    `);
  }
  for (const computerSessionId of computerIds) {
    await tx.execute(sql`
      select id from computer_sessions
      where workspace_id = ${input.workspaceId} and id = ${computerSessionId}
      for update
    `);
  }

  const now = new Date();
  if (operationIds.length > 0) {
    await tx
      .update(schema.interactionOperations)
      .set({
        state: "outcome_unknown",
        errorCode: "outcome_unknown",
        errorMessage: "Attached Chrome connection generation changed",
        errorRetryable: false,
        errorDetails: { reason: "connection_generation_changed" },
        settledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.interactionOperations.workspaceId, input.workspaceId),
          inArray(schema.interactionOperations.operationId, operationIds),
          inArray(schema.interactionOperations.state, ["prepared", "dispatched"]),
        ),
      );
  }
  if (browserIds.length > 0) {
    await tx
      .update(schema.browserSessions)
      .set({
        lifecycle: "lost",
        failureCode: CONTROLLER_TRANSITION_EXPIRED,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.browserSessions.workspaceId, input.workspaceId),
          inArray(schema.browserSessions.id, browserIds),
          inArray(schema.browserSessions.lifecycle, [...ATTACHED_DEVICE_LIVE_LIFECYCLES]),
        ),
      );
  }
  if (computerIds.length > 0) {
    await tx
      .update(schema.computerSessions)
      .set({
        lifecycle: "lost",
        failureCode: CONTROLLER_TRANSITION_EXPIRED,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.computerSessions.workspaceId, input.workspaceId),
          inArray(schema.computerSessions.id, computerIds),
          inArray(schema.computerSessions.lifecycle, [...ATTACHED_DEVICE_LIVE_LIFECYCLES]),
        ),
      );
  }
  return true;
}

/** Lock the device row first (same order as inventory) and prove the live
 *  physical generation still matches this controller placement. The device
 *  row lives in `deviceWorkspaceId`, which is the session's own workspace
 *  unless the session runs on a machine shared from another workspace. */
export async function attachedDeviceGenerationMatches(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    deviceWorkspaceId: string;
    deviceId: string;
    placementInstanceId: string;
  },
): Promise<boolean> {
  const read = async (deviceDb: Database) => {
    const [device] = await deviceDb
      .select({
        connectionGeneration: schema.attachedBrowserDevices.connectionGeneration,
      })
      .from(schema.attachedBrowserDevices)
      .where(
        and(
          eq(schema.attachedBrowserDevices.workspaceId, input.deviceWorkspaceId),
          eq(schema.attachedBrowserDevices.id, input.deviceId),
        ),
      )
      .for("update")
      .limit(1);
    return device?.connectionGeneration === input.placementInstanceId;
  };
  if (input.deviceWorkspaceId === input.workspaceId) return await read(tx);
  return await withRlsContext(
    tx,
    { accountId: input.accountId, workspaceId: input.deviceWorkspaceId },
    read,
  );
}

/** Sessions placed on a Chrome profile stored in `deviceWorkspaceId`. A row
 *  written before sessions recorded it has none, which means its own
 *  workspace. */
function deviceWorkspaceMatches(
  table: typeof schema.browserSessions | typeof schema.computerSessions,
  input: { workspaceId: string; deviceWorkspaceId: string },
) {
  return input.workspaceId === input.deviceWorkspaceId
    ? or(eq(table.deviceWorkspaceId, input.deviceWorkspaceId), isNull(table.deviceWorkspaceId))
    : eq(table.deviceWorkspaceId, input.deviceWorkspaceId);
}

/** Every workspace whose people can use a machine, so whose lists show its
 *  Chrome profiles, in workspace order. A workspace machine is used where it
 *  is enrolled. An organization machine is used in every workspace of the
 *  account. A personal machine is used by its owner in every workspace they
 *  can reach; their membership is not readable here, so this is every
 *  workspace of the account too. Only interaction revisions use this list:
 *  a workspace that cannot use the machine refreshes and still sees nothing. */
async function attachedBrowserAudience(
  tx: Database,
  input: { accountId: string; workspaceId: string; authorityScope: string },
): Promise<string[]> {
  if (input.authorityScope === "workspace") return [input.workspaceId];
  const rows = await tx
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.accountId, input.accountId));
  return [...new Set([input.workspaceId, ...rows.map((row) => row.id)])].sort();
}

/** Advance each workspace's interaction revision so its clients refetch, in
 *  workspace order: two machines with overlapping audiences never wait on
 *  each other's revisions in opposite order. Returns this workspace's new
 *  revision. */
async function advanceInteractionRevisions(
  tx: Database,
  input: { accountId: string; workspaceId: string; workspaceIds: readonly string[] },
): Promise<number> {
  let own: number | undefined;
  for (const workspaceId of [...new Set([input.workspaceId, ...input.workspaceIds])].sort()) {
    if (workspaceId === input.workspaceId) {
      own = await advanceWorkspaceInteractionRevision(tx, input.accountId, workspaceId);
      continue;
    }
    await withRlsContext(
      tx,
      { accountId: input.accountId, workspaceId },
      async (otherDb) =>
        await advanceWorkspaceInteractionRevision(otherDb, input.accountId, workspaceId),
    );
  }
  if (own === undefined) throw new Error("Workspace interaction revision could not be advanced");
  return own;
}

/** Immediately mark every live Chrome profile on a cleanly disconnected agent
 *  offline. Historical endpoint rows remain discoverable and reconnect in place. */
export async function disconnectAttachedBrowserDevices(
  db: Database,
  input: { accountId: string; workspaceId: string; enrollmentId: string },
): Promise<{ changed: boolean; revision: number }> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        // Serialize the disconnect with accepted snapshots so their shared
        // observation is frozen at the same boundary as connection state.
        const [enrollment] = await tx
          .select({ authorityScope: schema.enrollments.authorityScope })
          .from(schema.enrollments)
          .where(
            and(
              eq(schema.enrollments.id, input.enrollmentId),
              eq(schema.enrollments.accountId, input.accountId),
              eq(schema.enrollments.workspaceId, input.workspaceId),
            ),
          )
          .for("update");
        const now = new Date();
        const rows = await tx
          .update(schema.attachedBrowserDevices)
          .set({
            disconnectedAt: now,
            updatedAt: sql`greatest(${schema.attachedBrowserDevices.updatedAt}, ${now.toISOString()}::timestamptz)`,
            lastSeenAt: sql`greatest(${schema.attachedBrowserDevices.lastSeenAt}, (
              select ${schema.attachedBrowserInventories.observedAt}
              from ${schema.attachedBrowserInventories}
              where ${schema.attachedBrowserInventories.workspaceId} = ${schema.attachedBrowserDevices.workspaceId}
                and ${schema.attachedBrowserInventories.enrollmentId} = ${schema.attachedBrowserDevices.enrollmentId}
            ))`,
          })
          .where(
            and(
              eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
              eq(schema.attachedBrowserDevices.enrollmentId, input.enrollmentId),
              isNull(schema.attachedBrowserDevices.disconnectedAt),
            ),
          )
          .returning({ id: schema.attachedBrowserDevices.id });
        const revision = rows.length
          ? await advanceInteractionRevisions(tx, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              workspaceIds: await attachedBrowserAudience(tx, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                authorityScope: enrollment?.authorityScope ?? "workspace",
              }),
            })
          : await readWorkspaceInteractionRevision(tx, input.workspaceId);
        return { changed: rows.length > 0, revision };
      }),
  );
}

/** Every Chrome profile on a machine this viewer can use, wherever that
 *  machine is enrolled: the same machines the viewer's Machines list shows. */
export async function listAttachedBrowserDevices(
  db: Database,
  input: AttachedBrowserViewer & { includeDisconnected?: boolean },
): Promise<AttachedBrowserDeviceListResponseValue> {
  const visibility = await visibleEnrollments(db, input);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const rows = (
        await readVisibleWorkspaces(
          scopedDb,
          input,
          visibility,
          async (workspaceDb, workspaceId, enrollmentIds) =>
            await workspaceDb
              .select()
              .from(schema.attachedBrowserDevices)
              .where(
                and(
                  eq(schema.attachedBrowserDevices.workspaceId, workspaceId),
                  inArray(schema.attachedBrowserDevices.enrollmentId, enrollmentIds),
                  input.includeDisconnected
                    ? undefined
                    : isNull(schema.attachedBrowserDevices.disconnectedAt),
                ),
              ),
        )
      ).sort(compareDeviceRows);
      const inventories = (
        await readVisibleWorkspaces(
          scopedDb,
          input,
          visibility,
          async (workspaceDb, workspaceId, enrollmentIds) =>
            await workspaceDb
              .select({
                enrollmentId: schema.attachedBrowserInventories.enrollmentId,
                bridgeGeneration: schema.attachedBrowserInventories.bridgeGeneration,
                revision: schema.attachedBrowserInventories.revision,
                observedAt: schema.attachedBrowserInventories.observedAt,
                enrollmentStatus: schema.enrollments.status,
                connectionLeaseExpiresAt: schema.enrollments.connectionLeaseExpiresAt,
                wentOfflineAt: schema.enrollments.wentOfflineAt,
              })
              .from(schema.attachedBrowserInventories)
              .innerJoin(
                schema.enrollments,
                and(
                  eq(schema.enrollments.id, schema.attachedBrowserInventories.enrollmentId),
                  eq(schema.enrollments.workspaceId, schema.attachedBrowserInventories.workspaceId),
                ),
              )
              .where(
                and(
                  eq(schema.attachedBrowserInventories.workspaceId, workspaceId),
                  inArray(schema.attachedBrowserInventories.enrollmentId, enrollmentIds),
                ),
              ),
        )
      ).sort(
        (left, right) =>
          right.observedAt.getTime() - left.observedAt.getTime() ||
          left.enrollmentId.localeCompare(right.enrollmentId),
      );
      const observations = new Map(
        inventories.map((inventory) => [inventory.enrollmentId, inventory.observedAt]),
      );
      const visibleDevices = rows
        .map((row) => visibleDevice(row, visibility, observations.get(row.enrollmentId) ?? null))
        .filter(
          (device): device is AttachedBrowserDeviceValue =>
            device !== null && (input.includeDisconnected === true || device.state === "connected"),
        );
      // A profile id stored in two workspaces is listed once, as the copy
      // getAttachedBrowserDevice addresses.
      const preferred = new Map<string, AttachedBrowserDeviceValue>();
      for (const device of visibleDevices) {
        const current = preferred.get(device.id);
        preferred.set(
          device.id,
          current ? (preferredDevice([current, device], input.workspaceId) ?? device) : device,
        );
      }
      const devices = visibleDevices.filter((device) => preferred.get(device.id) === device);
      const connectedProfilesByEnrollment = new Map<string, number>();
      for (const device of devices) {
        if (device.state !== "connected") continue;
        connectedProfilesByEnrollment.set(
          device.enrollmentId,
          (connectedProfilesByEnrollment.get(device.enrollmentId) ?? 0) + 1,
        );
      }
      return AttachedBrowserDeviceListResponse.parse({
        revision: await readWorkspaceInteractionRevision(scopedDb, input.workspaceId),
        bridges: inventories
          .filter(
            (inventory) =>
              visibility.active.has(inventory.enrollmentId) ||
              visibility.revoked.has(inventory.enrollmentId),
          )
          .map((inventory) => ({
            enrollmentId: inventory.enrollmentId,
            sandboxId: visibility.machines.get(inventory.enrollmentId)?.sandboxId ?? null,
            machineName: visibility.machines.get(inventory.enrollmentId)?.machineName ?? null,
            state:
              inventory.enrollmentStatus === "active" &&
              inventory.wentOfflineAt === null &&
              inventory.connectionLeaseExpiresAt !== null &&
              inventory.connectionLeaseExpiresAt.getTime() > Date.now()
                ? "online"
                : "offline",
            bridgeGeneration: inventory.bridgeGeneration,
            inventoryRevision: inventory.revision,
            connectedProfileCount: connectedProfilesByEnrollment.get(inventory.enrollmentId) ?? 0,
            lastSeenAt: inventory.observedAt.toISOString(),
          })),
        devices,
      });
    },
    CONSISTENT_READ,
  );
}

export async function getAttachedBrowserDevice(
  db: Database,
  input: AttachedBrowserViewer & { deviceId: string },
): Promise<AttachedBrowserDeviceValue> {
  const visibility = await visibleEnrollments(db, input);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const rows = await readVisibleWorkspaces(
        scopedDb,
        input,
        visibility,
        async (workspaceDb, workspaceId, enrollmentIds) =>
          await workspaceDb
            .select({
              device: schema.attachedBrowserDevices,
              observedAt: schema.attachedBrowserInventories.observedAt,
            })
            .from(schema.attachedBrowserDevices)
            .leftJoin(
              schema.attachedBrowserInventories,
              and(
                eq(
                  schema.attachedBrowserInventories.workspaceId,
                  schema.attachedBrowserDevices.workspaceId,
                ),
                eq(
                  schema.attachedBrowserInventories.enrollmentId,
                  schema.attachedBrowserDevices.enrollmentId,
                ),
              ),
            )
            .where(
              and(
                eq(schema.attachedBrowserDevices.workspaceId, workspaceId),
                eq(schema.attachedBrowserDevices.id, input.deviceId),
                inArray(schema.attachedBrowserDevices.enrollmentId, enrollmentIds),
              ),
            )
            .limit(1),
      );
      const device = preferredDevice(
        rows
          .map((row) => visibleDevice(row.device, visibility, row.observedAt))
          .filter((value): value is AttachedBrowserDeviceValue => value !== null),
        input.workspaceId,
      );
      if (!device) throw new AttachedBrowserDeviceNotFoundError("Attached browser not found");
      return device;
    },
    CONSISTENT_READ,
  );
}

/** Where a browser or computer's controller runs, as far as ending it needs. */
export type InteractionControllerPlacement =
  | { kind: "connected_machine"; sandboxId: string }
  | { kind: "attached_device"; deviceId: string }
  | { kind: string };

/** True when a browser or computer's controller can never be reached again,
 * so ending it completes in the control plane:
 *  - on a Connected Machine that was removed (revoked); that machine can no
 *    longer run or keep it;
 *  - in a person's own Chrome whose device is disconnected, or whose machine
 *    was removed. Such a session holds no Opengeni process or profile; the
 *    tabs it opened stay with the person as ordinary tabs.
 * A machine that is only offline still holds its sessions' processes and
 * private profiles, so it is not gone. Both checks go through the viewer's
 * own owner-aware machine listing: a machine hidden from them is never gone. */
export async function interactionControllerGone(
  db: Database,
  viewer: AttachedBrowserViewer,
  placement: InteractionControllerPlacement | null,
): Promise<boolean> {
  if (placement && "sandboxId" in placement && placement.kind === "connected_machine") {
    const sandboxId = placement.sandboxId;
    return await withRlsContext(db, viewer, async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, viewer.subjectId);
      const rows = await rawRows<{ id: string }>(
        scopedDb,
        sql`select value->>'id' as id
          from list_scoped_enrollments(
            ${viewer.accountId}::uuid, ${viewer.workspaceId}::uuid, null, 'revoked') value
          where value->>'sandboxId' = ${sandboxId}
          limit 1`,
      );
      return rows.length > 0;
    });
  }
  if (placement && "deviceId" in placement && placement.kind === "attached_device") {
    try {
      const device = await getAttachedBrowserDevice(db, {
        ...viewer,
        deviceId: placement.deviceId,
      });
      return device.state !== "connected";
    } catch (error) {
      if (error instanceof AttachedBrowserDeviceNotFoundError) return false;
      throw error;
    }
  }
  return false;
}
