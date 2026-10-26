import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  ATTACHED_BROWSER_SESSION_CAPABILITIES,
  activateBrowserSession,
  activateComputerSession,
  AttachedBrowserDeviceNotFoundError,
  completeBrowserSessionEnd,
  createDb,
  createOrganizationInvitation,
  createSession,
  dispatchBrowserSessionOperation,
  dispatchComputerSessionOperation,
  ensureManagedAccessForUser,
  getAttachedBrowserDevice,
  getBrowserSession,
  getComputerSessionControlRecord,
  interactionControllerGone,
  listAttachedBrowserDevices,
  prepareBrowserSessionCreate,
  prepareBrowserSessionEnd,
  prepareComputerSessionCreate,
  reconcileAttachedBrowserInventory,
  revokeEnrollment,
  touchBrowserSessionController,
  touchComputerSessionController,
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

/** A live machine enrolled by the owner, for the workspace, the whole
 *  organization or Only me; by default in the shared workspace. */
async function machine(
  org: Org,
  scope: "workspace" | "organization" | "user",
  workspaceId = org.workspaceId,
) {
  const pubkey = `ed25519:browser-${crypto.randomUUID()}`;
  const row = (await app.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${org.accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true),
      set_config('opengeni.subject_id', ${org.owner}, true)`;
    const [created] = await tx<Array<{ enrollmentId: string }>>`
      select enrollment_id as "enrollmentId"
      from finalize_scoped_enrollment(
        ${org.accountId}::uuid, ${workspaceId}::uuid,
        ${scope === "organization" ? "workspace" : scope}, ${pubkey},
        true, false, 'macos', 'arm64', 'Laptop', false
      )`;
    return created!;
  })) as { enrollmentId: string };
  // Enrolling for the whole organization takes account authority; share an
  // enrolled workspace machine with everyone instead, as an admin would.
  if (scope === "organization") {
    await shared.admin`
      update enrollments set authority_scope = 'organization' where id = ${row.enrollmentId}`;
  }
  await shared.admin`
    update enrollments set connection_instance_id = 'connection-1',
      connection_lease_expires_at = now() + interval '1 hour', workspace_root = '/srv/workspace'
    where id = ${row.enrollmentId}`;
  const deviceId = crypto.randomUUID();
  await reconcileAttachedBrowserInventory(client.db, {
    accountId: org.accountId,
    workspaceId,
    enrollmentId: row.enrollmentId,
    snapshot: {
      bridgeGeneration: "bridge-1",
      revision: 1,
      devices: [profile(deviceId, "extension-1", 1)],
    },
  });
  return { enrollmentId: row.enrollmentId, deviceId };
}

function profile(id: string, connectionGeneration: string, inventoryRevision: number) {
  return {
    id,
    name: "Chrome",
    profileLabel: "Work",
    browserName: "Google Chrome",
    browserVersion: "151.0.7922.108",
    extensionVersion: "1.0.0",
    platform: "macos" as const,
    architecture: "arm64" as const,
    connectionGeneration,
    inventoryRevision,
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
  };
}

/** An active attached-Chrome BrowserSession in `scope` on `deviceId`, whose
 *  profile is recorded in `deviceWorkspaceId` (default: the session's own). */
async function activeAttachedBrowser(
  org: Org,
  scope: { accountId: string; workspaceId: string },
  deviceId: string,
  deviceWorkspaceId?: string,
) {
  const chat = await createSession(client.db, {
    ...scope,
    initialMessage: "Use my Chrome",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const operationId = crypto.randomUUID();
  const browser = await prepareBrowserSessionCreate(client.db, {
    ...scope,
    operationId,
    associatedSessionId: chat.id,
    actorSubjectId: org.owner,
    name: "Attached Chrome",
    initialUrl: null,
    placement: { kind: "attached_device" as const, deviceId },
    driverId: "opengeni.attached-chrome.v1",
    engine: "chrome" as const,
    headless: false,
    identityId: null,
    baseRevisionId: null,
    capabilities: ATTACHED_BROWSER_SESSION_CAPABILITIES,
    ...(deviceWorkspaceId ? { attachedDeviceWorkspaceId: deviceWorkspaceId } : {}),
  });
  const controller = {
    controllerId: "browserd:attached-test",
    controllerGeneration: crypto.randomUUID(),
    placementInstanceId: "extension-1",
  };
  await dispatchBrowserSessionOperation(client.db, {
    ...scope,
    operationId,
    browserSessionId: browser.session.id,
    controllerGeneration: controller.controllerGeneration,
    controller,
  });
  await activateBrowserSession(client.db, {
    ...scope,
    operationId,
    browserSessionId: browser.session.id,
    controller,
    engineVersion: "151.0.7922.108",
  });
  return { browser, controller };
}

/** End, as the End route does: a controller nobody here can reach again is
 *  gone, so the end completes in the control plane under its generation. */
async function expectEndsInControlPlane(
  org: Org,
  scope: { accountId: string; workspaceId: string },
  browserSessionId: string,
  controller: { controllerGeneration: string },
  placement: Parameters<typeof interactionControllerGone>[2],
) {
  expect(await interactionControllerGone(client.db, viewer(org, org.owner), placement)).toBe(true);
  const operationId = crypto.randomUUID();
  await prepareBrowserSessionEnd(client.db, {
    ...scope,
    browserSessionId,
    operationId,
    actorSubjectId: org.owner,
  });
  const completed = await completeBrowserSessionEnd(client.db, {
    ...scope,
    operationId,
    browserSessionId,
    expectedControllerGeneration: controller.controllerGeneration,
  });
  expect(completed.session.lifecycle).toBe("ended");
  expect(await getBrowserSession(client.db, { ...scope, browserSessionId })).toMatchObject({
    lifecycle: "ended",
  });
}

async function personalWorkspaceOf(org: Org, subjectId: string): Promise<string> {
  const [row] = await shared.admin<Array<{ personalWorkspaceId: string | null }>>`
    select personal_workspace_id as "personalWorkspaceId" from organization_memberships
    where account_id = ${org.accountId} and subject_id = ${subjectId}`;
  if (!row?.personalWorkspaceId) throw new Error("subject has no personal workspace");
  return row.personalWorkspaceId;
}

async function interactionRevision(workspaceId: string): Promise<number> {
  const [row] = await shared.admin<Array<{ revision: string }>>`
    select revision::text as revision from workspace_interaction_revisions
    where workspace_id = ${workspaceId}`;
  return Number(row?.revision ?? 0);
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

  test("a hidden Connected Machine is never gone; a Chrome profile nobody here can reach is", async () => {
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
    // A Chrome session holds no Opengeni process; one this person cannot
    // reach ends in the control plane rather than never.
    expect(
      await interactionControllerGone(client.db, asMember, {
        kind: "attached_device",
        deviceId: personal.deviceId,
      }),
    ).toBe(true);
    expect(
      await interactionControllerGone(client.db, viewer(org, org.owner), {
        kind: "connected_machine",
        sandboxId,
      }),
    ).toBe(true);
  });
});

// A personal or organization machine is usable from other workspaces than
// the one it is enrolled in; its Chrome profiles are stored where it is
// enrolled. They follow the machine everywhere it is visible, and nowhere else.
describe("attached browsers on a machine enrolled in another workspace", () => {
  test("a personal machine's profiles reach its owner in their other workspaces only", async () => {
    const org = await organization();
    const personalWorkspaceId = await personalWorkspaceOf(org, org.owner);
    expect(personalWorkspaceId).not.toBe(org.workspaceId);
    const sharedBefore = await interactionRevision(org.workspaceId);

    const personal = await machine(org, "user", personalWorkspaceId);
    // Hidden from the shared workspace: only usable where it is enrolled.
    const homeOnly = await machine(org, "workspace", personalWorkspaceId);

    // The heartbeat writes only the machine's own workspace.
    expect(await interactionRevision(org.workspaceId)).toBe(sharedBefore);

    const asOwner = await listAttachedBrowserDevices(client.db, viewer(org, org.owner));
    expect(asOwner.devices.map((device) => device.id)).toEqual([personal.deviceId]);
    expect(asOwner.devices[0]).toMatchObject({
      state: "connected",
      enrollmentId: personal.enrollmentId,
      workspaceId: personalWorkspaceId,
    });
    expect(asOwner.bridges).toEqual([
      expect.objectContaining({
        enrollmentId: personal.enrollmentId,
        state: "online",
        connectedProfileCount: 1,
        machineName: "Laptop",
        sandboxId: expect.any(String),
      }),
    ]);
    expect(asOwner.revision).toBe(await interactionRevision(org.workspaceId));
    expect(
      await getAttachedBrowserDevice(client.db, {
        ...viewer(org, org.owner),
        deviceId: personal.deviceId,
      }),
    ).toMatchObject({ id: personal.deviceId, state: "connected" });
    // An existing session pins the copy it was placed on.
    expect(
      await getAttachedBrowserDevice(client.db, {
        ...viewer(org, org.owner),
        deviceId: personal.deviceId,
        deviceWorkspaceId: personalWorkspaceId,
      }),
    ).toMatchObject({ id: personal.deviceId, workspaceId: personalWorkspaceId });
    await expect(
      getAttachedBrowserDevice(client.db, {
        ...viewer(org, org.owner),
        deviceId: personal.deviceId,
        deviceWorkspaceId: org.workspaceId,
      }),
    ).rejects.toBeInstanceOf(AttachedBrowserDeviceNotFoundError);
    await expect(
      getAttachedBrowserDevice(client.db, {
        ...viewer(org, org.owner),
        deviceId: homeOnly.deviceId,
      }),
    ).rejects.toBeInstanceOf(AttachedBrowserDeviceNotFoundError);

    // Another member of the shared workspace never sees the owner's machine.
    const asMember = await listAttachedBrowserDevices(client.db, {
      ...viewer(org, org.member),
      includeDisconnected: true,
    });
    expect(asMember.devices).toEqual([]);
    expect(asMember.bridges).toEqual([]);
    await expect(
      getAttachedBrowserDevice(client.db, {
        ...viewer(org, org.member),
        deviceId: personal.deviceId,
      }),
    ).rejects.toBeInstanceOf(AttachedBrowserDeviceNotFoundError);
    // Nothing the member could reach: ending such a session completes here.
    expect(
      await interactionControllerGone(client.db, viewer(org, org.member), {
        kind: "attached_device",
        deviceId: personal.deviceId,
      }),
    ).toBe(true);
    // The owner still reaches it on its current generation, not on an old one.
    expect(
      await interactionControllerGone(client.db, viewer(org, org.owner), {
        kind: "attached_device",
        deviceId: personal.deviceId,
        deviceWorkspaceId: personalWorkspaceId,
        placementInstanceId: "extension-1",
      }),
    ).toBe(false);
    expect(
      await interactionControllerGone(client.db, viewer(org, org.owner), {
        kind: "attached_device",
        deviceId: personal.deviceId,
        deviceWorkspaceId: personalWorkspaceId,
        placementInstanceId: "extension-0",
      }),
    ).toBe(true);

    // Disconnecting there is seen here on the next read.
    await reconcileAttachedBrowserInventory(client.db, {
      accountId: org.accountId,
      workspaceId: personalWorkspaceId,
      enrollmentId: personal.enrollmentId,
      snapshot: { bridgeGeneration: "bridge-1", revision: 2, devices: [] },
    });
    expect((await listAttachedBrowserDevices(client.db, viewer(org, org.owner))).devices).toEqual(
      [],
    );
    expect(
      await interactionControllerGone(client.db, viewer(org, org.owner), {
        kind: "attached_device",
        deviceId: personal.deviceId,
      }),
    ).toBe(true);
  });

  test("an organization machine's profiles reach every member of every workspace", async () => {
    const org = await organization();
    const personalWorkspaceId = await personalWorkspaceOf(org, org.owner);
    const everyone = await machine(org, "organization", personalWorkspaceId);
    const asMember = await listAttachedBrowserDevices(client.db, viewer(org, org.member));
    expect(asMember.devices.map((device) => device.id)).toEqual([everyone.deviceId]);
    expect(asMember.bridges.map((bridge) => bridge.enrollmentId)).toEqual([everyone.enrollmentId]);
  });

  test("a session here runs on that profile, is fenced by it and ends with it", async () => {
    const org = await organization();
    const personalWorkspaceId = await personalWorkspaceOf(org, org.owner);
    const personal = await machine(org, "user", personalWorkspaceId);
    const chat = await createSession(client.db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      initialMessage: "Use my Chrome",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    const scope = { accountId: org.accountId, workspaceId: org.workspaceId };
    const browserInput = {
      ...scope,
      associatedSessionId: chat.id,
      actorSubjectId: org.owner,
      name: "Attached Chrome",
      initialUrl: null,
      placement: { kind: "attached_device" as const, deviceId: personal.deviceId },
      driverId: "opengeni.attached-chrome.v1",
      engine: "chrome" as const,
      headless: false,
      identityId: null,
      baseRevisionId: null,
      capabilities: ATTACHED_BROWSER_SESSION_CAPABILITIES,
    };

    const browserOperationId = crypto.randomUUID();
    const browser = await prepareBrowserSessionCreate(client.db, {
      ...browserInput,
      operationId: browserOperationId,
      attachedDeviceWorkspaceId: personalWorkspaceId,
    });
    const [stored] = await shared.admin<Array<{ deviceWorkspaceId: string }>>`
      select device_workspace_id as "deviceWorkspaceId" from browser_sessions
      where id = ${browser.session.id}`;
    expect(stored?.deviceWorkspaceId).toBe(personalWorkspaceId);
    const browserController = {
      controllerId: "browserd:attached-test",
      controllerGeneration: crypto.randomUUID(),
      placementInstanceId: "extension-1",
    };
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId: browserOperationId,
      browserSessionId: browser.session.id,
      controllerGeneration: browserController.controllerGeneration,
      controller: browserController,
    });
    await activateBrowserSession(client.db, {
      ...scope,
      operationId: browserOperationId,
      browserSessionId: browser.session.id,
      controller: browserController,
      engineVersion: "151.0.7922.108",
    });

    const computerOperationId = crypto.randomUUID();
    const computer = await prepareComputerSessionCreate(client.db, {
      ...scope,
      operationId: computerOperationId,
      associatedSessionId: chat.id,
      actorSubjectId: org.owner,
      name: "Attached Chrome computer",
      placement: { kind: "attached_device", deviceId: personal.deviceId },
      attachedDeviceWorkspaceId: personalWorkspaceId,
    });
    const computerController = {
      controllerId: "browserd:attached-test",
      controllerGeneration: crypto.randomUUID(),
      placementInstanceId: "extension-1",
    };
    await dispatchComputerSessionOperation(client.db, {
      ...scope,
      operationId: computerOperationId,
      computerSessionId: computer.session.id,
      controllerGeneration: computerController.controllerGeneration,
      controller: computerController,
    });
    await activateComputerSession(client.db, {
      ...scope,
      operationId: computerOperationId,
      computerSessionId: computer.session.id,
      controller: computerController,
      platform: "macos",
      adapter: "opengeni.ax.v1",
      seatId: "console",
      displayId: "main",
      capabilities: {
        semanticObservation: true,
        appDiscovery: true,
        appLaunch: true,
        windowCapture: true,
        screenCapture: true,
        semanticActions: true,
        pointerInput: true,
        keyboardInput: true,
        clipboard: true,
        backgroundActions: true,
        parallelApps: true,
      },
    });

    // The controller is fenced by the profile's live generation over there.
    expect(
      await touchBrowserSessionController(client.db, {
        ...scope,
        browserSessionId: browser.session.id,
        controllerGeneration: browserController.controllerGeneration,
      }),
    ).toBe(true);
    expect(
      await touchComputerSessionController(client.db, {
        ...scope,
        computerSessionId: computer.session.id,
        controllerGeneration: computerController.controllerGeneration,
      }),
    ).toBe(true);

    // Chrome restarts on the machine. The heartbeat touches only the
    // machine's own workspace; the next controller check here fails and ends
    // both sessions on the old Chrome at once.
    const before = await interactionRevision(org.workspaceId);
    await reconcileAttachedBrowserInventory(client.db, {
      accountId: org.accountId,
      workspaceId: personalWorkspaceId,
      enrollmentId: personal.enrollmentId,
      snapshot: {
        bridgeGeneration: "bridge-1",
        revision: 2,
        devices: [profile(personal.deviceId, "extension-2", 2)],
      },
    });
    expect(await interactionRevision(org.workspaceId)).toBe(before);
    expect(
      await touchBrowserSessionController(client.db, {
        ...scope,
        browserSessionId: browser.session.id,
        controllerGeneration: browserController.controllerGeneration,
      }),
    ).toBe(false);
    expect(await interactionRevision(org.workspaceId)).toBeGreaterThan(before);
    expect(
      await getBrowserSession(client.db, { ...scope, browserSessionId: browser.session.id }),
    ).toMatchObject({ lifecycle: "lost", failureCode: "controller_transition_expired" });
    expect(
      (
        await getComputerSessionControlRecord(client.db, {
          ...scope,
          computerSessionId: computer.session.id,
        })
      ).session,
    ).toMatchObject({ lifecycle: "lost", failureCode: "controller_transition_expired" });
    expect(
      await touchComputerSessionController(client.db, {
        ...scope,
        computerSessionId: computer.session.id,
        controllerGeneration: computerController.controllerGeneration,
      }),
    ).toBe(false);
  });

  test("a session recorded against the wrong profile workspace never passes the fence", async () => {
    const org = await organization();
    const personalWorkspaceId = await personalWorkspaceOf(org, org.owner);
    const personal = await machine(org, "user", personalWorkspaceId);
    const scope = { accountId: org.accountId, workspaceId: org.workspaceId };
    const { browser, controller } = await activeAttachedBrowser(org, scope, personal.deviceId);
    expect(
      await touchBrowserSessionController(client.db, {
        ...scope,
        browserSessionId: browser.session.id,
        controllerGeneration: controller.controllerGeneration,
      }),
    ).toBe(false);
    expect(
      await getBrowserSession(client.db, { ...scope, browserSessionId: browser.session.id }),
    ).toMatchObject({ lifecycle: "lost" });
  });

  test("deleting a profile's workspace is never blocked by sessions elsewhere that used it", async () => {
    const org = await organization();
    const personalWorkspaceId = await personalWorkspaceOf(org, org.owner);
    const personal = await machine(org, "user", personalWorkspaceId);
    const scope = { accountId: org.accountId, workspaceId: org.workspaceId };
    const { browser, controller } = await activeAttachedBrowser(
      org,
      scope,
      personal.deviceId,
      personalWorkspaceId,
    );
    // The owner leaves: their Personal workspace and its profile rows go,
    // as organization retention deletion removes them.
    await shared.admin.begin(async (tx) => {
      await tx`update organization_memberships
        set personal_workspace_id = null, status = 'revoked', revoked_at = now()
        where account_id = ${org.accountId} and subject_id = ${org.owner}`;
      await tx`delete from workspaces where id = ${personalWorkspaceId}`;
    });
    const [left] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from attached_browser_devices where id = ${personal.deviceId}`;
    expect(left?.count).toBe(0);
    // The session here fails closed and ends.
    expect(
      await touchBrowserSessionController(client.db, {
        ...scope,
        browserSessionId: browser.session.id,
        controllerGeneration: controller.controllerGeneration,
      }),
    ).toBe(false);
    expect(
      await getBrowserSession(client.db, { ...scope, browserSessionId: browser.session.id }),
    ).toMatchObject({ lifecycle: "lost" });
  });

  test("a session elsewhere still ends once its profile's workspace is deleted", async () => {
    const org = await organization();
    const personalWorkspaceId = await personalWorkspaceOf(org, org.owner);
    const personal = await machine(org, "user", personalWorkspaceId);
    const scope = { accountId: org.accountId, workspaceId: org.workspaceId };
    const { browser, controller } = await activeAttachedBrowser(
      org,
      scope,
      personal.deviceId,
      personalWorkspaceId,
    );
    await shared.admin.begin(async (tx) => {
      await tx`update organization_memberships
        set personal_workspace_id = null, status = 'revoked', revoked_at = now()
        where account_id = ${org.accountId} and subject_id = ${org.owner}`;
      await tx`delete from workspaces where id = ${personalWorkspaceId}`;
    });
    await expectEndsInControlPlane(org, scope, browser.session.id, controller, {
      kind: "attached_device",
      deviceId: personal.deviceId,
      deviceWorkspaceId: personalWorkspaceId,
      placementInstanceId: controller.placementInstanceId,
    });
  });

  test("a session elsewhere still ends once its machine stops being shared there", async () => {
    const org = await organization();
    const personalWorkspaceId = await personalWorkspaceOf(org, org.owner);
    const everyone = await machine(org, "organization", personalWorkspaceId);
    const scope = { accountId: org.accountId, workspaceId: org.workspaceId };
    const { browser, controller } = await activeAttachedBrowser(
      org,
      scope,
      everyone.deviceId,
      personalWorkspaceId,
    );
    const placement = {
      kind: "attached_device",
      deviceId: everyone.deviceId,
      deviceWorkspaceId: personalWorkspaceId,
      placementInstanceId: controller.placementInstanceId,
    };
    expect(await interactionControllerGone(client.db, viewer(org, org.owner), placement)).toBe(
      false,
    );
    // Narrowed to the workspace it is enrolled in: the profile row and its
    // generation are unchanged, but nobody here can reach it any more.
    await shared.admin`
      update enrollments set authority_scope = 'workspace' where id = ${everyone.enrollmentId}`;
    await expect(
      getAttachedBrowserDevice(client.db, {
        ...viewer(org, org.owner),
        deviceId: everyone.deviceId,
        deviceWorkspaceId: personalWorkspaceId,
      }),
    ).rejects.toBeInstanceOf(AttachedBrowserDeviceNotFoundError);
    await expectEndsInControlPlane(org, scope, browser.session.id, controller, placement);
  });

  test("a session from before profiles recorded their workspace still ends with its profile", async () => {
    const org = await organization();
    const personalWorkspaceId = await personalWorkspaceOf(org, org.owner);
    const personal = await machine(org, "user", personalWorkspaceId);
    const scope = { accountId: org.accountId, workspaceId: personalWorkspaceId };
    const chat = await createSession(client.db, {
      ...scope,
      initialMessage: "Use my Chrome",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    const operationId = crypto.randomUUID();
    const browser = await prepareBrowserSessionCreate(client.db, {
      ...scope,
      operationId,
      associatedSessionId: chat.id,
      actorSubjectId: org.owner,
      name: "Attached Chrome",
      initialUrl: null,
      placement: { kind: "attached_device" as const, deviceId: personal.deviceId },
      driverId: "opengeni.attached-chrome.v1",
      engine: "chrome" as const,
      headless: false,
      identityId: null,
      baseRevisionId: null,
      capabilities: ATTACHED_BROWSER_SESSION_CAPABILITIES,
    });
    // Rows written before migration 0919 have no device workspace; that
    // means their own. Recreate one with the defaulting trigger bypassed.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update browser_sessions set device_workspace_id = null
        where id = ${browser.session.id}`;
    });
    const controller = {
      controllerId: "browserd:attached-test",
      controllerGeneration: crypto.randomUUID(),
      placementInstanceId: "extension-1",
    };
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: browser.session.id,
      controllerGeneration: controller.controllerGeneration,
      controller,
    });
    await activateBrowserSession(client.db, {
      ...scope,
      operationId,
      browserSessionId: browser.session.id,
      controller,
      engineVersion: "151.0.7922.108",
    });
    const [legacy] = await shared.admin<Array<{ deviceWorkspaceId: string | null }>>`
      select device_workspace_id as "deviceWorkspaceId" from browser_sessions
      where id = ${browser.session.id}`;
    expect(legacy?.deviceWorkspaceId).toBeNull();
    expect(
      await touchBrowserSessionController(client.db, {
        ...scope,
        browserSessionId: browser.session.id,
        controllerGeneration: controller.controllerGeneration,
      }),
    ).toBe(true);

    await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      enrollmentId: personal.enrollmentId,
      snapshot: {
        bridgeGeneration: "bridge-1",
        revision: 2,
        devices: [profile(personal.deviceId, "extension-2", 2)],
      },
    });
    expect(
      await getBrowserSession(client.db, { ...scope, browserSessionId: browser.session.id }),
    ).toMatchObject({ lifecycle: "lost", failureCode: "controller_transition_expired" });
  });
});
