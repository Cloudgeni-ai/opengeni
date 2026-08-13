import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  AttachedBrowserInventoryConflictError,
  bootstrapWorkspace,
  createDb,
  createEnrollment,
  disconnectAttachedBrowserDevices,
  getAttachedBrowserDevice,
  listAttachedBrowserDevices,
  reconcileAttachedBrowserInventory,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("attached-browser-devices");
  if (!shared) {
    available = false;
    console.warn("[attached-browser-devices] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `attached-browser-account-${suffix}`,
    accountName: "Attached browser test",
    workspaceExternalSource: "test",
    workspaceExternalId: `attached-browser-workspace-${suffix}`,
    workspaceName: "Attached browser test",
    subjectId: `attached-browser-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const enrollment = await createEnrollment(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    pubkey: `ed25519:${suffix}`,
    os: "macos",
    arch: "arm64",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    enrollmentId: enrollment.id,
  };
}

const capabilities = {
  tabInventory: true,
  debuggerAttachment: true,
  semanticObservation: true,
  screenshots: true,
  liveFrames: true,
  humanInput: true,
  diagnostics: true,
  rawCdp: false,
  linkedComputer: true,
} as const;

function device(id: string, name: string, inventoryRevision = 1) {
  return {
    id,
    name,
    profileLabel: name,
    browserName: "Google Chrome",
    browserVersion: "151.0.7922.108",
    extensionVersion: "1.0.0",
    platform: "macos" as const,
    architecture: "arm64" as const,
    connectionGeneration: "extension-1",
    inventoryRevision,
    tabCount: 2,
    capabilities,
  };
}

describe("attached browser endpoint registry", () => {
  test("reconciles full snapshots, ignores stale revisions, and preserves offline history", async () => {
    if (!available) return;
    const scope = await fixture();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();

    const created = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-1",
        revision: 1,
        devices: [device(firstId, "Primary Chrome"), device(secondId, "Work Chrome")],
      },
    });
    expect(created).toMatchObject({ accepted: true, changed: true });
    const initial = await listAttachedBrowserDevices(client.db, scope);
    expect(initial.bridges).toHaveLength(1);
    expect(initial.bridges[0]).toMatchObject({
      enrollmentId: scope.enrollmentId,
      state: "offline",
      bridgeGeneration: "bridge-1",
      inventoryRevision: 1,
      connectedProfileCount: 2,
    });
    expect(initial.devices.map((entry) => entry.id).sort()).toEqual([firstId, secondId].sort());
    expect(initial.devices.every((entry) => entry.state === "connected")).toBe(true);

    const replay = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-1",
        revision: 1,
        devices: [device(firstId, "Primary Chrome"), device(secondId, "Work Chrome")],
      },
    });
    expect(replay).toEqual({
      accepted: true,
      changed: false,
      revision: created.revision,
    });

    const stale = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: { bridgeGeneration: "bridge-1", revision: 0, devices: [] },
    });
    expect(stale).toEqual({
      accepted: false,
      changed: false,
      revision: created.revision,
    });
    expect((await listAttachedBrowserDevices(client.db, scope)).devices).toHaveLength(2);

    const changed = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-1",
        revision: 2,
        devices: [{ ...device(firstId, "Personal Chrome", 2), tabCount: 3 }],
      },
    });
    expect(changed.changed).toBe(true);
    expect(changed.revision).toBeGreaterThan(created.revision);
    const live = await listAttachedBrowserDevices(client.db, scope);
    expect(live.bridges[0]).toMatchObject({
      bridgeGeneration: "bridge-1",
      inventoryRevision: 2,
      connectedProfileCount: 1,
    });
    expect(live.devices).toHaveLength(1);
    expect(live.devices[0]).toMatchObject({
      id: firstId,
      name: "Personal Chrome",
      state: "connected",
      tabCount: 3,
    });
    const history = await listAttachedBrowserDevices(client.db, {
      ...scope,
      includeDisconnected: true,
    });
    expect(history.devices).toHaveLength(2);
    expect(history.devices.find((entry) => entry.id === secondId)).toMatchObject({
      state: "disconnected",
    });

    const disconnected = await disconnectAttachedBrowserDevices(client.db, scope);
    expect(disconnected.changed).toBe(true);
    expect(
      (
        await getAttachedBrowserDevice(client.db, {
          ...scope,
          deviceId: firstId,
        })
      ).state,
    ).toBe("disconnected");

    const reconnected = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-2",
        revision: 0,
        devices: [
          {
            ...device(firstId, "Personal Chrome", 0),
            connectionGeneration: "extension-2",
          },
        ],
      },
    });
    expect(reconnected).toMatchObject({ accepted: true, changed: true });
    expect(
      (
        await getAttachedBrowserDevice(client.db, {
          ...scope,
          deviceId: firstId,
        })
      ).state,
    ).toBe("connected");
  });

  test("does not let another machine claim an existing endpoint id", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-a",
        revision: 1,
        devices: [device(deviceId, "First Chrome")],
      },
    });
    const other = await createEnrollment(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      os: "macos",
      arch: "arm64",
    });
    await expect(
      reconcileAttachedBrowserInventory(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        enrollmentId: other.id,
        snapshot: {
          bridgeGeneration: "bridge-b",
          revision: 1,
          devices: [device(deviceId, "Stolen Chrome")],
        },
      }),
    ).rejects.toBeInstanceOf(AttachedBrowserInventoryConflictError);
  });
});
