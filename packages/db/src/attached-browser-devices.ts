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
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import {
  advanceWorkspaceInteractionRevision,
  readWorkspaceInteractionRevision,
} from "./interaction-revisions";
import * as schema from "./schema";

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
        const rows = await tx
          .select()
          .from(schema.attachedBrowserDevices)
          .where(eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId))
          .for("update");
        const byId = new Map(rows.map((row) => [row.id, row]));
        let changed = false;
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
            changed = true;
            continue;
          }
          const materialChanged =
            reclaimingRevokedEnrollment || !sameAnnouncement(existing, device);
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
              lastSeenAt: now,
              disconnectedAt: null,
              updatedAt: materialChanged ? now : existing.updatedAt,
            })
            .where(
              and(
                eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
                eq(schema.attachedBrowserDevices.id, device.id),
              ),
            );
          changed ||= materialChanged;
        }

        const announced = new Set(snapshot.devices.map((device) => device.id));
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
            .set({ disconnectedAt: now, updatedAt: now })
            .where(
              and(
                eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
                eq(schema.attachedBrowserDevices.enrollmentId, input.enrollmentId),
                inArray(schema.attachedBrowserDevices.id, disconnectedIds),
                isNull(schema.attachedBrowserDevices.disconnectedAt),
              ),
            );
          changed = true;
        }

        if (cursor) {
          await tx
            .update(schema.attachedBrowserInventories)
            .set({
              bridgeGeneration: snapshot.bridgeGeneration,
              revision: snapshot.revision,
              observedAt: now,
              updatedAt: now,
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
          ? await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId)
          : await readWorkspaceInteractionRevision(tx, input.workspaceId);
        return { accepted: true, changed, revision };
      }),
  );
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
        const now = new Date();
        const rows = await tx
          .update(schema.attachedBrowserDevices)
          .set({ disconnectedAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
              eq(schema.attachedBrowserDevices.enrollmentId, input.enrollmentId),
              isNull(schema.attachedBrowserDevices.disconnectedAt),
            ),
          )
          .returning({ id: schema.attachedBrowserDevices.id });
        const revision = rows.length
          ? await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId)
          : await readWorkspaceInteractionRevision(tx, input.workspaceId);
        return { changed: rows.length > 0, revision };
      }),
  );
}

export async function listAttachedBrowserDevices(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    includeDisconnected?: boolean;
  },
): Promise<AttachedBrowserDeviceListResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const rows = await scopedDb
        .select()
        .from(schema.attachedBrowserDevices)
        .where(
          input.includeDisconnected
            ? eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId)
            : and(
                eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
                isNull(schema.attachedBrowserDevices.disconnectedAt),
              ),
        )
        .orderBy(
          desc(schema.attachedBrowserDevices.disconnectedAt),
          desc(schema.attachedBrowserDevices.updatedAt),
          asc(schema.attachedBrowserDevices.name),
          asc(schema.attachedBrowserDevices.id),
        );
      const inventories = await scopedDb
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
        .where(eq(schema.attachedBrowserInventories.workspaceId, input.workspaceId))
        .orderBy(
          desc(schema.attachedBrowserInventories.observedAt),
          asc(schema.attachedBrowserInventories.enrollmentId),
        );
      const connectedProfilesByEnrollment = new Map<string, number>();
      for (const row of rows) {
        if (row.disconnectedAt !== null) continue;
        connectedProfilesByEnrollment.set(
          row.enrollmentId,
          (connectedProfilesByEnrollment.get(row.enrollmentId) ?? 0) + 1,
        );
      }
      return AttachedBrowserDeviceListResponse.parse({
        revision: await readWorkspaceInteractionRevision(scopedDb, input.workspaceId),
        bridges: inventories.map((inventory) => ({
          enrollmentId: inventory.enrollmentId,
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
        devices: rows.map(deviceFromRow),
      });
    },
    CONSISTENT_READ,
  );
}

export async function getAttachedBrowserDevice(
  db: Database,
  input: { accountId: string; workspaceId: string; deviceId: string },
): Promise<AttachedBrowserDeviceValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.attachedBrowserDevices)
        .where(
          and(
            eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
            eq(schema.attachedBrowserDevices.id, input.deviceId),
          ),
        )
        .limit(1);
      if (!row) throw new AttachedBrowserDeviceNotFoundError("Attached browser not found");
      return deviceFromRow(row);
    },
    CONSISTENT_READ,
  );
}
