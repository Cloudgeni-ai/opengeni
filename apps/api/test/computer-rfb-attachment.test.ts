import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type AccessGrant,
  type ComputerSession,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import type { ComputerSessionControlRecord } from "@opengeni/db";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { InteractionFrameProxyTransport } from "../src/interaction-frame-proxy";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const computerSessionId = "33333333-3333-4333-8333-333333333333";
const sandboxGroupId = "44444444-4444-4444-8444-444444444444";
const sourceSessionId = "55555555-5555-4555-8555-555555555555";
const rootSecret = "computer-rfb-fixture-authority-with-enough-entropy";
const fakeDb = {};
const realCore = await import("@opengeni/core");
const realDb = await import("@opengeni/db");
const coreFunctions = {
  requireAccessGrant: realCore.requireAccessGrant,
  requireSessionAuthorization: realCore.requireSessionAuthorization,
};
const dbFunctions = {
  getComputerSessionControlRecord: realDb.getComputerSessionControlRecord,
  touchComputerSessionController: realDb.touchComputerSessionController,
  readLease: realDb.readLease,
  getSession: realDb.getSession,
  getAttachedBrowserDevice: realDb.getAttachedBrowserDevice,
  getLiveEnrollmentConnection: realDb.getLiveEnrollmentConnection,
};
let permissions: AccessGrant["permissions"] = ["stream:view", "sessions:control"];
let principalKind: AccessGrant["principalKind"] = "human_session";
let controlDenied = false;
let controlUnavailable = false;
let inputAvailable = true;
let controllerUrl = "";
let controllerGeneration = "controller-1";
let controllerAdmitted = true;
let attachedPlacement = false;
let screenControlAllowed = false;
const sourceOperations: string[] = [];
const helperPaths: string[] = [];
const dispatchedActions: Array<Record<string, unknown>> = [];
const helpers: Array<ReturnType<typeof Bun.serve>> = [];

function record(): ComputerSessionControlRecord {
  const session: ComputerSession = {
    id: computerSessionId,
    accountId,
    workspaceId,
    name: "Fixture Desktop",
    lifecycle: "active",
    placement: attachedPlacement
      ? { kind: "attached_device", deviceId: "66666666-6666-4666-8666-666666666666" }
      : { kind: "sandbox_group", sandboxGroupId },
    controller: {
      controllerId: "fixture-controller",
      controllerGeneration,
      placementInstanceId: "placement-1",
    },
    platform: "linux",
    adapter: "fixture.desktop.v1",
    seatId: "seat-1",
    displayId: ":101",
    capabilities: {
      semanticObservation: true,
      appDiscovery: true,
      appLaunch: true,
      windowCapture: true,
      screenCapture: true,
      semanticActions: true,
      pointerInput: true,
      keyboardInput: inputAvailable,
      clipboard: true,
      backgroundActions: true,
      parallelApps: true,
    },
    associations: [],
    createdBySubjectId: "user:fixture",
    createdAt: "2026-08-10T12:00:00.000Z",
    lastUsedAt: "2026-08-10T12:00:00.000Z",
    failureCode: null,
  };
  return {
    session,
    tokenGeneration: 1,
    sourceSessionId,
    createOperationId: computerSessionId,
    operation: null,
  };
}

mock.module("@opengeni/core", () => ({
  ...realCore,
  requireAccessGrant: async (...args: Parameters<typeof realCore.requireAccessGrant>) => {
    if (args[1].db !== fakeDb) return await coreFunctions.requireAccessGrant(...args);
    if (args[3] && !realCore.hasPermission(permissions, args[3])) throw new HTTPException(403);
    return {
      accountId,
      workspaceId,
      subjectId: "user:fixture",
      permissions,
      principalKind,
    } as AccessGrant;
  },
  requireSessionAuthorization: async (
    ...args: Parameters<typeof realCore.requireSessionAuthorization>
  ) => {
    if (args[0].db !== fakeDb) return await coreFunctions.requireSessionAuthorization(...args);
    expect(args[2].sessionId).toBe(sourceSessionId);
    sourceOperations.push(args[2].operation);
    if (args[2].operation === "session.control") {
      if (controlUnavailable) throw new realCore.SessionAuthorizationUnavailableError();
      if (controlDenied) throw new realCore.SessionAuthorizationDeniedError("revoked");
    }
    return {};
  },
}));
mock.module("@opengeni/db", () => ({
  ...realDb,
  getComputerSessionControlRecord: async (
    ...args: Parameters<typeof realDb.getComputerSessionControlRecord>
  ) => (args[0] === fakeDb ? record() : await dbFunctions.getComputerSessionControlRecord(...args)),
  touchComputerSessionController: async (
    ...args: Parameters<typeof realDb.touchComputerSessionController>
  ) =>
    args[0] === fakeDb
      ? controllerAdmitted
      : await dbFunctions.touchComputerSessionController(...args),
  readLease: async (...args: Parameters<typeof realDb.readLease>) =>
    args[0] === fakeDb
      ? {
          sandboxGroupId,
          instanceId: "placement-1",
          leaseEpoch: 1,
          liveness: "warm",
          backend: "modal",
          controllerDataPlaneUrl: controllerUrl,
        }
      : await dbFunctions.readLease(...args),
  getSession: async (...args: Parameters<typeof realDb.getSession>) =>
    args[0] === fakeDb
      ? ({ id: sourceSessionId, workspaceId, sandboxGroupId } as Awaited<
          ReturnType<typeof realDb.getSession>
        >)
      : await dbFunctions.getSession(...args),
  getAttachedBrowserDevice: async (...args: Parameters<typeof realDb.getAttachedBrowserDevice>) =>
    args[0] === fakeDb
      ? ({
          state: "connected",
          enrollmentId: "77777777-7777-4777-8777-777777777777",
          connectionGeneration: "placement-1",
        } as Awaited<ReturnType<typeof realDb.getAttachedBrowserDevice>>)
      : await dbFunctions.getAttachedBrowserDevice(...args),
  getLiveEnrollmentConnection: async (
    ...args: Parameters<typeof realDb.getLiveEnrollmentConnection>
  ) =>
    args[0] === fakeDb
      ? ({
          status: "active",
          connectionInstanceId: "connection-1",
          workspaceRoot: "/fixture/workspace",
          hasDisplay: true,
          desktopUnavailableReason: null,
          allowScreenControl: screenControlAllowed,
          agentCapabilities: {},
          operationPolicy: null,
        } as Awaited<ReturnType<typeof realDb.getLiveEnrollmentConnection>>)
      : await dbFunctions.getLiveEnrollmentConnection(...args),
}));
const { registerComputerSessionRoutes } = await import("../src/routes/computer-sessions");
afterAll(() => mock.restore());
afterEach(() => {
  for (const controller of helpers.splice(0)) controller.stop(true);
});
beforeEach(() => {
  permissions = ["stream:view", "sessions:control"];
  principalKind = "human_session";
  controlDenied = false;
  controlUnavailable = false;
  inputAvailable = true;
  controllerGeneration = "controller-1";
  controllerAdmitted = true;
  attachedPlacement = false;
  screenControlAllowed = false;
  sourceOperations.length = 0;
  helperPaths.length = 0;
  dispatchedActions.length = 0;
});

function helper(scopedRfbInput: boolean, targetKind: "screen" | "window" = "screen") {
  const grants: Array<Record<string, unknown>> = [];
  const controller = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      helperPaths.push(path);
      if (path.endsWith("/targets"))
        return success([
          {
            id: `${targetKind}-1`,
            computerSessionId,
            controllerGeneration: "controller-1",
            targetGeneration: "target-1",
            kind: targetKind,
            applicationId: null,
            processId: null,
            title: "Fixture screen",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            focused: false,
          },
        ]);
      if (path.endsWith("/view-grants")) {
        const body = (await request.json()) as Record<string, unknown>;
        grants.push(body);
        if (
          !scopedRfbInput &&
          Object.keys(body).some(
            (key) => !["grantId", "controllerGeneration", "token", "expiresAt"].includes(key),
          )
        )
          return new Response("old helper rejects new keys", { status: 400 });
        return success({
          grantId: body.grantId,
          expiresAt: body.expiresAt,
          ...(scopedRfbInput ? { scopedRfbInput: true } : {}),
          ...(body.targetId
            ? {
                targetId: body.targetId,
                targetGeneration: body.targetGeneration,
                inputAllowed: body.inputAllowed,
              }
            : {}),
        });
      }
      if (path.endsWith("/rfb")) {
        const offered = request.headers.get("sec-websocket-protocol")?.split(/,\s*/u) ?? [];
        return new Response("fixture RFB authorization", {
          status: grants.some((grant) => offered.includes(`opengeni.auth.${grant.token}`))
            ? 200
            : 401,
        });
      }
      if (path.endsWith("/actions")) {
        const command = (await request.json()) as Record<string, unknown>;
        dispatchedActions.push(command);
        return success({
          protocolVersion: 1,
          operationId: command.operationId,
          computerSessionId,
          controllerGeneration: "controller-1",
          targetId: command.targetId,
          state: "completed",
          dispatchedAt: new Date().toISOString(),
          settledAt: new Date().toISOString(),
          observation: null,
          error: null,
        });
      }
      return new Response("fixture route missing", { status: 404 });
    },
  });
  helpers.push(controller);
  controllerUrl = `ws://127.0.0.1:${controller.port}`;
  return grants;
}

function success(data: unknown) {
  return Response.json({ protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION, ok: true, data });
}
function app(interactive = true) {
  const instance = new Hono();
  registerComputerSessionRoutes(instance, {
    db: fakeDb,
    bus: new MemoryEventBus(),
    settings: testSettings({
      delegationSecret: rootSecret,
      publicBaseUrl: "https://api.example.test",
      sandboxDesktopInteractive: interactive,
    }),
  } as unknown as ApiRouteDeps);
  return instance;
}
async function attach(instance: Hono, targetId = "screen-1") {
  return await instance.request(
    `https://api.example.test/v1/workspaces/${workspaceId}/computer-sessions/${computerSessionId}/attachments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId }),
    },
  );
}

function input(instance: Hono) {
  return instance.request(
    `https://api.example.test/v1/workspaces/${workspaceId}/computer-sessions/${computerSessionId}/actions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        targetId: "screen-1",
        expectedTargetGeneration: "target-1",
        expectedObservationId: null,
        expectedFrameId: "frame-painted-1",
        action: { type: "pointer", frameId: "frame-painted-1", action: "click", x: 10, y: 20 },
      }),
    },
  );
}

describe("registered canonical ComputerSession attachment and action authority", () => {
  test("app posture rechecks attached-machine screen consent while retaining read permission", async () => {
    permissions = ["sessions:read", "sessions:control"];
    attachedPlacement = true;
    const instance = app();
    const denied = await posture(instance);
    expect(denied.status).toBe(200);
    expect((await denied.json()).inputAllowed).toBe(false);
    expect(sourceOperations).toEqual(["session.read"]);
    screenControlAllowed = true;
    const allowed = await posture(instance);
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).inputAllowed).toBe(true);
    screenControlAllowed = false;
    const revoked = await posture(instance);
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).inputAllowed).toBe(false);
    const rejectedAction = await input(instance);
    expect(rejectedAction.status).toBe(403);
    expect(helperPaths).toEqual([]);
    expect(dispatchedActions).toEqual([]);
  });

  test.each([true, false])(
    "reads human posture without native or media requests (%p)",
    async (interactive) => {
      permissions = ["sessions:read", "sessions:control"];
      const grants = helper(false);
      const response = await posture(app(interactive));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        computerSessionId,
        controllerGeneration: "controller-1",
        inputAllowed: interactive,
      });
      expect(grants).toEqual([]);
      expect(dispatchedActions).toEqual([]);
      expect(helperPaths).toEqual([]);
      expect(sourceOperations).toEqual(
        interactive ? ["session.read", "session.control"] : ["session.read"],
      );
    },
  );

  test.each(["revoked", "unavailable", "no_control", "agent"] as const)(
    "denies app posture from %s authority",
    async (reason) => {
      permissions =
        reason === "no_control" ? ["sessions:read"] : ["sessions:read", "sessions:control"];
      controlDenied = reason === "revoked";
      controlUnavailable = reason === "unavailable";
      principalKind = reason === "agent" ? "agent_attempt" : "human_session";
      helper(false);
      const response = await posture(app());
      expect(response.status).toBe(200);
      expect((await response.json()).inputAllowed).toBe(false);
      expect(helperPaths).toEqual([]);
    },
  );

  test("rechecks source control and current controller without granting action authority", async () => {
    permissions = ["sessions:read", "sessions:control"];
    helper(false);
    const instance = app();
    expect((await (await posture(instance)).json()).inputAllowed).toBe(true);
    controlDenied = true;
    expect((await (await posture(instance)).json()).inputAllowed).toBe(false);
    expect((await input(instance)).status).toBe(404);
    controllerGeneration = "controller-2";
    controlDenied = false;
    expect(await (await posture(instance)).json()).toEqual({
      computerSessionId,
      controllerGeneration: "controller-2",
      inputAllowed: true,
    });
    controllerAdmitted = false;
    expect((await posture(instance)).status).toBe(409);
    expect(helperPaths).toEqual([]);
    expect(dispatchedActions).toEqual([]);
  });
  test("uses canonical screen frames without minting RFB input authority", async () => {
    const grants = helper(true);
    const response = await attach(app());
    expect(response.status).toBe(201);
    const attachment = await response.json();
    expect(attachment.stream.kind).toBe("direct_websocket");
    expect(attachment.stream.url).toContain("/targets/screen-1/frames");
    expect(attachment.inputAllowed).toBe(true);
    expect(grants).toHaveLength(1);
    expect(grants[0]).not.toHaveProperty("inputAllowed");
    expect(sourceOperations).toEqual(["session.viewer.read", "session.control"]);
  });

  test.each([false, true])(
    "forwards the painted frame fence through canonical actions (scoped helper %p)",
    async (scopedHelper) => {
      const grants = helper(scopedHelper);
      const instance = app();
      expect((await attach(instance)).status).toBe(201);
      const response = await input(instance);
      expect(response.status).toBe(200);
      expect((await response.json()).state).toBe("completed");
      expect(grants).toHaveLength(1);
      expect(Object.keys(grants[0]!).sort()).toEqual([
        "controllerGeneration",
        "expiresAt",
        "grantId",
        "token",
      ]);
      expect(dispatchedActions).toHaveLength(1);
      expect(dispatchedActions[0]).toMatchObject({
        computerSessionId,
        controllerGeneration: "controller-1",
        targetId: "screen-1",
        expectedTargetGeneration: "target-1",
        expectedObservationId: null,
        expectedFrameId: "frame-painted-1",
        action: { type: "pointer", frameId: "frame-painted-1", action: "click", x: 10, y: 20 },
      });
      expect(sourceOperations).toEqual([
        "session.viewer.read",
        "session.control",
        "session.control",
      ]);
    },
  );

  test.each(["permission", "source", "policy", "agent"] as const)(
    "keeps canonical viewing when %s does not permit human input",
    async (reason) => {
      const grants = helper(true);
      if (reason === "permission") permissions = ["stream:view"];
      if (reason === "source") controlDenied = true;
      if (reason === "agent") principalKind = "agent_attempt";
      const response = await attach(app(reason !== "policy"));
      expect(response.status).toBe(201);
      const attachment = await response.json();
      expect(attachment.inputAllowed).toBe(false);
      expect(attachment.stream.kind).toBe("direct_websocket");
      expect(grants).toHaveLength(1);
      expect(grants[0]).not.toHaveProperty("inputAllowed");
    },
  );

  test("keeps viewing but refuses input while source-control authorization is unavailable", async () => {
    const grants = helper(true);
    controlUnavailable = true;
    const instance = app();
    const response = await attach(instance);
    expect(response.status).toBe(201);
    expect((await response.json()).inputAllowed).toBe(false);
    expect(grants).toHaveLength(1);
    expect((await input(instance)).status).toBe(503);
    expect(dispatchedActions).toEqual([]);
  });

  test("keeps partial native capabilities independent of human source authority", async () => {
    helper(true);
    inputAvailable = false;
    const response = await attach(app());
    expect(response.status).toBe(201);
    expect((await response.json()).inputAllowed).toBe(true);
    expect(record().session.capabilities).toMatchObject({
      pointerInput: true,
      keyboardInput: false,
    });
  });

  test.each(["permission", "source", "policy"] as const)(
    "rejects %s loss before native action dispatch even after an allowed attachment",
    async (reason) => {
      helper(true);
      const instance = app();
      const response = await attach(instance);
      expect(response.status).toBe(201);
      expect((await response.json()).inputAllowed).toBe(true);
      if (reason === "permission") permissions = ["stream:view"];
      if (reason === "source") controlDenied = true;
      expect((await input(reason === "policy" ? app(false) : instance)).status).toBe(
        reason === "source" ? 404 : 403,
      );
      expect(dispatchedActions).toEqual([]);
    },
  );

  test("human sandbox policy does not disable authorized agent tool actions", async () => {
    helper(true);
    principalKind = "agent_attempt";
    const instance = app(false);
    expect((await input(instance)).status).toBe(200);
    expect(dispatchedActions).toHaveLength(1);
    expect(sourceOperations).toEqual(["session.control"]);
  });

  test.each(["screen", "window"] as const)(
    "old strict-key helpers retain %s frames behind an encrypted proxy",
    async (targetKind) => {
      const grants = helper(false, targetKind);
      const response = await attach(app(), `${targetKind}-1`);
      expect(response.status).toBe(201);
      const attachment = await response.json();
      expect(attachment.stream.kind).toBe("direct_websocket");
      expect(attachment.stream.url).toBe("wss://api.example.test/v1/interaction/frame-proxy");
      expect(grants).toHaveLength(1);
      expect(JSON.stringify(attachment)).not.toContain(grants[0]!.token as string);
      expect(JSON.stringify(attachment)).not.toContain(controllerUrl);
      expect(
        attachment.stream.protocols.some((protocol: string) =>
          protocol.startsWith("opengeni.auth."),
        ),
      ).toBe(false);
      // The opaque proxy grant is neither an RFB bearer nor a reusable raw
      // upstream credential. Its authenticated URL is fixed to /frames.
      const guessed = await fetch(
        `${controllerUrl.replace("ws:", "http:")}/v1/computer-sessions/${computerSessionId}/targets/screen-1/rfb`,
        { headers: { "sec-websocket-protocol": attachment.stream.protocols.join(", ") } },
      );
      expect(guessed.status).toBe(401);
      const proxy = new InteractionFrameProxyTransport(rootSecret);
      expect(
        proxy.upgrade(
          new Request(attachment.stream.url, {
            headers: {
              "sec-websocket-protocol": ["binary", attachment.stream.protocols[1]].join(", "),
            },
          }),
          {
            upgrade: () => {
              throw new Error("wrong response protocol must not upgrade");
            },
          },
        )?.status,
      ).toBe(426);
      expect(sourceOperations).toEqual(["session.viewer.read", "session.control"]);
    },
  );
});

function posture(instance: Hono) {
  return instance.request(
    `https://api.example.test/v1/workspaces/${workspaceId}/computer-sessions/${computerSessionId}/input-posture`,
  );
}
