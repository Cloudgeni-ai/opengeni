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
};
let permissions: AccessGrant["permissions"] = ["stream:view", "sessions:control"];
let principalKind: AccessGrant["principalKind"] = "human_session";
let controlDenied = false;
let controlUnavailable = false;
let inputAvailable = true;
let controllerUrl = "";
const sourceOperations: string[] = [];
const helpers: Array<ReturnType<typeof Bun.serve>> = [];

function record(): ComputerSessionControlRecord {
  const session: ComputerSession = {
    id: computerSessionId,
    accountId,
    workspaceId,
    name: "Fixture Desktop",
    lifecycle: "active",
    placement: { kind: "sandbox_group", sandboxGroupId },
    controller: {
      controllerId: "fixture-controller",
      controllerGeneration: "controller-1",
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
  ) => (args[0] === fakeDb ? true : await dbFunctions.touchComputerSessionController(...args)),
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
  sourceOperations.length = 0;
});

function helper(scopedRfbInput: boolean, targetKind: "screen" | "window" = "screen") {
  const grants: Array<Record<string, unknown>> = [];
  const controller = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
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

describe("registered ComputerSession RFB attachment authority", () => {
  test("binds interactive RFB only after native and source control authority", async () => {
    const grants = helper(true);
    const response = await attach(app());
    expect(response.status).toBe(201);
    const attachment = await response.json();
    expect(attachment.stream).toMatchObject({ kind: "direct_rfb", inputAllowed: true });
    expect(grants).toHaveLength(2);
    expect(Object.keys(grants[0]!).sort()).toEqual([
      "controllerGeneration",
      "expiresAt",
      "grantId",
      "token",
    ]);
    expect(grants[1]).toMatchObject({
      targetId: "screen-1",
      targetGeneration: "target-1",
      inputAllowed: true,
    });
    expect(grants[1]!.grantId).toBe(grants[0]!.grantId);
    expect(grants[1]!.token).toBe(grants[0]!.token);
    expect(sourceOperations).toEqual(["session.viewer.read", "session.control"]);
  });

  test.each(["permission", "source", "native", "policy", "agent"] as const)(
    "keeps authorized viewing when %s does not permit RFB input",
    async (reason) => {
      const grants = helper(true);
      if (reason === "permission") permissions = ["stream:view"];
      if (reason === "source") controlDenied = true;
      if (reason === "native") inputAvailable = false;
      if (reason === "agent") principalKind = "agent_attempt";
      const response = await attach(app(reason !== "policy"));
      expect(response.status).toBe(201);
      expect((await response.json()).stream).toMatchObject({
        kind: "direct_rfb",
        inputAllowed: false,
      });
      expect(grants[1]).toMatchObject({ inputAllowed: false });
    },
  );

  test("refuses an unavailable source-control decision instead of granting input", async () => {
    const grants = helper(true);
    controlUnavailable = true;
    expect((await attach(app())).status).toBe(503);
    expect(grants).toHaveLength(1);
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
      expect(sourceOperations).toEqual(["session.viewer.read"]);
    },
  );
});
