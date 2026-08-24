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
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import {
  advanceWorkspaceInteractionRevision,
  readWorkspaceInteractionRevision,
} from "./interaction-revisions";
import * as schema from "./schema";

const ATTACHED_DEVICE_LIVE_LIFECYCLES = ["starting", "active", "suspending", "restoring"] as const;
// `ending` stays off this list so an in-flight `/end` can finish physical
// teardown (`stopCapture` + helper exit) after Chrome reconnects.

const CONTROLLER_TRANSITION_EXPIRED = "controller_transition_expired";

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
        const generationChangedDeviceIds = new Set<string>();
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
          if (existing.connectionGeneration !== device.connectionGeneration) {
            generationChangedDeviceIds.add(device.id);
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

        if (
          await terminalizeStaleAttachedDeviceSessions(tx, {
            workspaceId: input.workspaceId,
            deviceIds: [...generationChangedDeviceIds],
          })
        ) {
          changed = true;
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

/** A new physical Chrome generation cannot inherit a prior controller token.
 *  Mark every still-live BrowserSession/ComputerSession on that exact device
 *  lost in place. Never rewrite placementInstanceId onto the successor. */
async function terminalizeStaleAttachedDeviceSessions(
  tx: Database,
  input: { workspaceId: string; deviceIds: readonly string[] },
): Promise<boolean> {
  if (input.deviceIds.length === 0) return false;

  const browserRows = await tx
    .select({ id: schema.browserSessions.id })
    .from(schema.browserSessions)
    .where(
      and(
        eq(schema.browserSessions.workspaceId, input.workspaceId),
        eq(schema.browserSessions.placementKind, "attached_device"),
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
 *  physical generation still matches this controller placement. */
export async function attachedDeviceGenerationMatches(
  tx: Database,
  input: { workspaceId: string; deviceId: string; placementInstanceId: string },
): Promise<boolean> {
  const [device] = await tx
    .select({
      connectionGeneration: schema.attachedBrowserDevices.connectionGeneration,
    })
    .from(schema.attachedBrowserDevices)
    .where(
      and(
        eq(schema.attachedBrowserDevices.workspaceId, input.workspaceId),
        eq(schema.attachedBrowserDevices.id, input.deviceId),
      ),
    )
    .for("update")
    .limit(1);
  return device?.connectionGeneration === input.placementInstanceId;
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
