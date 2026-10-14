import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  AttachedBrowserDeviceNotFoundError,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUser,
  getAttachedBrowserDevice,
  interactionControllerGone,
  listAttachedBrowserDevices,
  reconcileAttachedBrowserInventory,
  revokeEnrollment,
  type DbClient,
} from "../src/index";

// Attached browsers follow their machine's audience: a personal (Only me)
// machine's browsers are seen only by its owner, and a revoked machine's
// browsers are never presented as connected. Real migrated schema, FORCE-RLS
// app role.
let shared: SharedTestDatabase;
let client: DbClient;
let app: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("attached-browser-access");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  app = postgres(shared.appUrl, { max: 2, prepare: false, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function organization() {
  const ownerUserId = `browser-owner-${crypto.randomUUID()}`;
  const memberUserId = `browser-member-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const member = `user:${memberUserId}`;
  const ownerAccess = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Machine owner",
  });
  await ensureManagedAccessForUser(client.db, {
    userId: memberUserId,
    email: `${memberUserId}@example.test`,
    name: "Workspace member",
  });
  const grant = ownerAccess.workspaceGrants.find(
    (candidate) => candidate.workspaceId === ownerAccess.defaultWorkspaceId,
  );
  if (!grant) throw new Error("owner has no shared workspace grant");
  const { accountId, workspaceId } = grant;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${memberUserId}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${member}, 'member',
      '["sessions:read","sessions:create","sessions:control"]'::jsonb)`;
  return { accountId, workspaceId, owner, member };
}

type Org = Awaited<ReturnType<typeof organization>>;

/** A live machine enrolled by the owner, for the workspace or Only me. */
async function machine(org: Org, scope: "workspace" | "user") {
  const pubkey = `ed25519:browser-${crypto.randomUUID()}`;
  const row = (await app.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${org.accountId}, true),
      set_config('opengeni.workspace_id', ${org.workspaceId}, true),
      set_config('opengeni.subject_id', ${org.owner}, true)`;
    const [created] = await tx<Array<{ enrollmentId: string }>>`
      select enrollment_id as "enrollmentId"
      from finalize_scoped_enrollment(
        ${org.accountId}::uuid, ${org.workspaceId}::uuid, ${scope}, ${pubkey},
        true, false, 'macos', 'arm64', 'Laptop', false
      )`;
    return created!;
  })) as { enrollmentId: string };
  await shared.admin`
    update enrollments set connection_instance_id = 'connection-1',
      connection_lease_expires_at = now() + interval '1 hour', workspace_root = '/srv/workspace'
    where id = ${row.enrollmentId}`;
  const deviceId = crypto.randomUUID();
  await reconcileAttachedBrowserInventory(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    enrollmentId: row.enrollmentId,
    snapshot: {
      bridgeGeneration: "bridge-1",
      revision: 1,
      devices: [
        {
          id: deviceId,
          name: "Chrome",
          profileLabel: "Work",
          browserName: "Google Chrome",
          browserVersion: "151.0.7922.108",
          extensionVersion: "1.0.0",
          platform: "macos",
          architecture: "arm64",
          connectionGeneration: "extension-1",
          inventoryRevision: 1,
          tabCount: 4,
          capabilities: {
            tabInventory: true,
            debuggerAttachment: true,
            semanticObservation: true,
            screenshots: true,
            liveFrames: true,
            humanInput: true,
            diagnostics: true,
            rawCdp: false,
            linkedComputer: true,
          },
        },
      ],
    },
  });
  return { enrollmentId: row.enrollmentId, deviceId };
}

function viewer(org: Org, subjectId: string) {
  return { accountId: org.accountId, workspaceId: org.workspaceId, subjectId };
}

describe("attached browsers follow their machine's audience", () => {
  test("a personal machine's browsers are visible only to its owner", async () => {
    const org = await organization();
    const personal = await machine(org, "user");
    const team = await machine(org, "workspace");

    const asOwner = await listAttachedBrowserDevices(client.db, viewer(org, org.owner));
    expect(asOwner.devices.map((device) => device.id).sort()).toEqual(
      [personal.deviceId, team.deviceId].sort(),
    );
    expect(asOwner.bridges.map((bridge) => bridge.enrollmentId).sort()).toEqual(
      [personal.enrollmentId, team.enrollmentId].sort(),
    );

    const asMember = await listAttachedBrowserDevices(client.db, {
      ...viewer(org, org.member),
      includeDisconnected: true,
    });
    expect(asMember.devices.map((device) => device.id)).toEqual([team.deviceId]);
    expect(asMember.bridges.map((bridge) => bridge.enrollmentId)).toEqual([team.enrollmentId]);
    await expect(
      getAttachedBrowserDevice(client.db, {
        ...viewer(org, org.member),
        deviceId: personal.deviceId,
      }),
    ).rejects.toBeInstanceOf(AttachedBrowserDeviceNotFoundError);
    expect(
      (
        await getAttachedBrowserDevice(client.db, {
          ...viewer(org, org.owner),
          deviceId: personal.deviceId,
        })
      ).state,
    ).toBe("connected");

    // Callers acting for nobody (keys, services) never see personal machines.
    const asService = await listAttachedBrowserDevices(client.db, viewer(org, "service:test"));
    expect(asService.devices.map((device) => device.id)).toEqual([team.deviceId]);
  });

  test("a revoked machine's browsers are disconnected and leave discovery", async () => {
    const org = await organization();
    const revoked = await machine(org, "workspace");
    expect(
      await revokeEnrollment(client.db, {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        enrollmentId: revoked.enrollmentId,
      }),
    ).toEqual({ revoked: true });

    const live = await listAttachedBrowserDevices(client.db, viewer(org, org.owner));
    expect(live.devices).toEqual([]);
    const history = await listAttachedBrowserDevices(client.db, {
      ...viewer(org, org.owner),
      includeDisconnected: true,
    });
    expect(history.devices).toHaveLength(1);
    expect(history.devices[0]).toMatchObject({ id: revoked.deviceId, state: "disconnected" });
    expect(history.devices[0]!.disconnectedAt).not.toBeNull();
    expect(history.bridges).toEqual([
      expect.objectContaining({ enrollmentId: revoked.enrollmentId, connectedProfileCount: 0 }),
    ]);
    expect(
      (
        await getAttachedBrowserDevice(client.db, {
          ...viewer(org, org.owner),
          deviceId: revoked.deviceId,
        })
      ).state,
    ).toBe("disconnected");
  });
});

describe("ending a browser whose controller can never be reached again", () => {
  async function sandboxOf(enrollmentId: string): Promise<string> {
    const [row] = await shared.admin<Array<{ id: string }>>`
      select id from sandboxes where enrollment_id = ${enrollmentId}`;
    if (!row) throw new Error("machine has no sandbox");
    return row.id;
  }

  test("a removed machine's browsers are gone; a live or offline one's are not", async () => {
    const org = await organization();
    const team = await machine(org, "workspace");
    const sandboxId = await sandboxOf(team.enrollmentId);
    const managed = { kind: "connected_machine", sandboxId };
    const attached = { kind: "attached_device", deviceId: team.deviceId };
    const asOwner = viewer(org, org.owner);
    expect(await interactionControllerGone(client.db, asOwner, managed)).toBe(false);
    expect(await interactionControllerGone(client.db, asOwner, attached)).toBe(false);

    // Offline is not gone: the machine still holds the browser's process and profile.
    await shared.admin`
      update enrollments set connection_lease_expires_at = now() - interval '1 minute'
      where id = ${team.enrollmentId}`;
    expect(await interactionControllerGone(client.db, asOwner, managed)).toBe(false);

    await revokeEnrollment(client.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      enrollmentId: team.enrollmentId,
    });
    expect(await interactionControllerGone(client.db, asOwner, managed)).toBe(true);
    expect(await interactionControllerGone(client.db, asOwner, attached)).toBe(true);
    expect(await interactionControllerGone(client.db, viewer(org, org.member), managed)).toBe(true);
    const sandboxGroup = { kind: "sandbox_group", sandboxGroupId: crypto.randomUUID() };
    expect(await interactionControllerGone(client.db, asOwner, sandboxGroup)).toBe(false);
  });

  test("a disconnected Chrome device is gone while its machine stays enrolled", async () => {
    const org = await organization();
    const team = await machine(org, "workspace");
    const attached = { kind: "attached_device", deviceId: team.deviceId };
    await reconcileAttachedBrowserInventory(client.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      enrollmentId: team.enrollmentId,
      snapshot: { bridgeGeneration: "bridge-1", revision: 2, devices: [] },
    });
    expect(await interactionControllerGone(client.db, viewer(org, org.owner), attached)).toBe(true);
  });

  test("someone else's personal machine is never judged gone for a person it is hidden from", async () => {
    const org = await organization();
    const personal = await machine(org, "user");
    const sandboxId = await sandboxOf(personal.enrollmentId);
    await revokeEnrollment(client.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      enrollmentId: personal.enrollmentId,
    });
    const asMember = viewer(org, org.member);
    expect(
      await interactionControllerGone(client.db, asMember, {
        kind: "connected_machine",
        sandboxId,
      }),
    ).toBe(false);
    expect(
      await interactionControllerGone(client.db, asMember, {
        kind: "attached_device",
        deviceId: personal.deviceId,
      }),
    ).toBe(false);
    expect(
      await interactionControllerGone(client.db, viewer(org, org.owner), {
        kind: "connected_machine",
        sandboxId,
      }),
    ).toBe(true);
  });
});
