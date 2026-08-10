import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ComputerActionCommand,
  ComputerObservation,
  ComputerSessionCapabilities,
  ComputerTarget,
} from "@opengeni/contracts";
import {
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BrowserControlServer,
  BrowserSupervisor,
  COMPUTER_CONTROL_WEBSOCKET_PROTOCOL,
  ComputerSupervisor,
  type ComputerEnvironmentAllocator,
  LatestComputerFrameSubscription,
  decodeComputerFrameMessage,
  decodeComputerFrameMetadataHeader,
  type ComputerFrameSubscription,
  type ComputerImageFrame,
  type ComputerSupervisorDriver,
  type ComputerSupervisorDriverContext,
} from "../src";

const adminToken = `admin.${"a".repeat(48)}`;
const controlToken = `control.${"c".repeat(48)}`;
const viewToken = `view.${"v".repeat(48)}`;
const rotatedControlToken = `control.${"d".repeat(48)}`;
const rotatedViewToken = `view.${"w".repeat(48)}`;

describe("Computer routes on the placement interaction server", () => {
  test("share Browser authority, fencing, media, rotation, and lifecycle semantics", async () => {
    await withServer(async ({ server, reference }) => {
      expect(
        (
          await request(server, "/v1/computer-sessions", {
            method: "POST",
            body: createBody(reference),
          })
        ).status,
      ).toBe(401);
      const created = await request(server, "/v1/computer-sessions", {
        method: "POST",
        token: adminToken,
        body: createBody(reference),
      });
      expect(created.status).toBe(201);
      expect((await json(created)).data).toMatchObject({
        computerSessionId: reference.computerSessionId,
        platform: "linux",
        adapter: "fixture.atspi.v1",
        seatId: "seat-1",
        displayId: ":101",
      });

      const targets = await request(
        server,
        `/v1/computer-sessions/${reference.computerSessionId}/targets`,
        { token: viewToken },
      );
      expect(targets.status).toBe(200);
      const target = (await json(targets)).data[0] as ComputerTarget;
      expect(target).toMatchObject({
        id: "window-1",
        computerSessionId: reference.computerSessionId,
      });
      const clipboard = await request(
        server,
        `/v1/computer-sessions/${reference.computerSessionId}/clipboard`,
        { token: viewToken },
      );
      expect(clipboard.status).toBe(200);
      expect((await json(clipboard)).data).toMatchObject({
        computerSessionId: reference.computerSessionId,
        controllerGeneration: reference.controllerGeneration,
        text: "fixture clipboard",
        truncated: false,
      });
      expect(
        (
          await request(
            server,
            `/v1/computer-sessions/${reference.computerSessionId}/targets/missing/observation`,
            { token: viewToken },
          )
        ).status,
      ).toBe(404);

      expect(
        (
          await request(server, `/v1/computer-sessions/${reference.computerSessionId}/actions`, {
            method: "POST",
            token: viewToken,
            body: command(reference),
          })
        ).status,
      ).toBe(401);
      const acted = await request(
        server,
        `/v1/computer-sessions/${reference.computerSessionId}/actions`,
        { method: "POST", token: controlToken, body: command(reference) },
      );
      expect((await json(acted)).data).toMatchObject({ state: "completed" });

      expect(
        (
          await request(server, `/v1/computer-sessions/${reference.computerSessionId}/heartbeat`, {
            method: "POST",
            token: viewToken,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(server, `/v1/computer-sessions/${reference.computerSessionId}/heartbeat`, {
            method: "POST",
            token: controlToken,
          })
        ).status,
      ).toBe(200);

      const screenshot = await request(
        server,
        `/v1/computer-sessions/${reference.computerSessionId}/targets/window-1/screenshot`,
        { token: viewToken },
      );
      expect(screenshot.status).toBe(200);
      expect(
        decodeComputerFrameMetadataHeader(screenshot.headers.get("x-opengeni-computer-frame")!),
      ).toMatchObject({
        computerSessionId: reference.computerSessionId,
        targetId: "window-1",
      });
      expect([...new Uint8Array(await screenshot.arrayBuffer())]).toEqual([...png()]);

      const websocket = new WebSocket(
        `${server.url.replace("http:", "ws:")}/v1/computer-sessions/${reference.computerSessionId}/targets/window-1/frames`,
        [
          COMPUTER_CONTROL_WEBSOCKET_PROTOCOL,
          `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${viewToken}`,
        ],
      );
      websocket.binaryType = "arraybuffer";
      const message = await websocketMessage(websocket);
      expect(websocket.protocol).toBe(COMPUTER_CONTROL_WEBSOCKET_PROTOCOL);
      expect(decodeComputerFrameMessage(new Uint8Array(message))).toMatchObject({
        computerSessionId: reference.computerSessionId,
        targetId: "window-1",
        sequence: 1,
      });
      const closed = websocketClosed(websocket);

      expect(
        (
          await request(server, "/v1/computer-sessions", {
            method: "POST",
            token: adminToken,
            body: createBody(reference, {
              tokenGeneration: 2,
              controlToken: rotatedControlToken,
              viewToken: rotatedViewToken,
            }),
          })
        ).status,
      ).toBe(200);
      expect((await closed).code).toBe(1008);
      expect(
        (
          await request(server, `/v1/computer-sessions/${reference.computerSessionId}/targets`, {
            token: viewToken,
          })
        ).status,
      ).toBe(401);

      const ended = await request(
        server,
        `/v1/computer-sessions/${reference.computerSessionId}/end`,
        {
          method: "POST",
          token: adminToken,
          body: { controllerGeneration: reference.controllerGeneration, removeState: true },
        },
      );
      expect(ended.status).toBe(200);
    });
  });
});

async function withServer(
  callback: (fixture: {
    server: BrowserControlServer;
    reference: { computerSessionId: string; controllerGeneration: string };
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp("/tmp/og-computer-server-");
  const browserSupervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "browser-state"),
    socketRootDirectory: join(directory, "browser-sockets"),
    createDriver: async () => {
      throw new Error("browser driver must not be used by computer routes");
    },
  });
  const computerSupervisor = await ComputerSupervisor.open({
    rootDirectory: join(directory, "computer-state"),
    environmentAllocator: fixtureEnvironmentAllocator(),
    createDriver: async (context) => new FixtureComputerDriver(context),
  });
  const server = BrowserControlServer.start({
    supervisor: browserSupervisor,
    computerSupervisor,
    adminToken,
    port: 0,
  });
  try {
    await callback({
      server,
      reference: { computerSessionId: randomUUID(), controllerGeneration: "controller-1" },
    });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

class FixtureComputerDriver implements ComputerSupervisorDriver {
  readonly platform = "linux" as const;
  readonly adapterId = "fixture.atspi.v1";
  readonly capabilities: ComputerSessionCapabilities = {
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
  };

  constructor(private readonly context: ComputerSupervisorDriverContext) {}

  async listTargets(): Promise<ComputerTarget[]> {
    return [this.buildTarget()];
  }

  async target(targetId: string): Promise<ComputerTarget | null> {
    return targetId === "window-1" ? this.buildTarget() : null;
  }

  async observe(): Promise<ComputerObservation> {
    return this.observation();
  }

  async dispatch(): Promise<ComputerObservation> {
    return this.observation();
  }

  async capture(): Promise<ComputerImageFrame> {
    return this.frame(0);
  }

  async clipboard() {
    return {
      computerSessionId: this.context.computerSessionId,
      controllerGeneration: this.context.controllerGeneration,
      text: "fixture clipboard",
      truncated: false,
      observedAt: "2026-08-11T12:00:00.000Z",
    };
  }

  async subscribeFrames(): Promise<ComputerFrameSubscription> {
    const subscription = new LatestComputerFrameSubscription(async () => undefined);
    queueMicrotask(() => subscription.push(this.frame(1)));
    return subscription;
  }

  async close(): Promise<void> {}

  private buildTarget(): ComputerTarget {
    return {
      id: "window-1",
      computerSessionId: this.context.computerSessionId,
      controllerGeneration: this.context.controllerGeneration,
      targetGeneration: "target-generation-1",
      kind: "window",
      applicationId: "fixture.desktop",
      processId: 42,
      title: "Fixture",
      bounds: { x: 0, y: 0, width: 3, height: 2 },
      focused: true,
    };
  }

  private observation(): ComputerObservation {
    return {
      protocolVersion: 1,
      observationId: "observation-1",
      computerSessionId: this.context.computerSessionId,
      target: this.buildTarget(),
      frameId: "frame-1",
      semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
      screenshot: null,
      focusedRef: null,
      changedRegions: [],
      observedAt: "2026-08-10T12:00:00.000Z",
    };
  }

  private frame(sequence: number): ComputerImageFrame {
    return {
      frameId: "frame-1",
      computerSessionId: this.context.computerSessionId,
      controllerGeneration: this.context.controllerGeneration,
      targetId: "window-1",
      targetGeneration: "target-generation-1",
      sequence,
      mediaType: "image/png",
      width: 3,
      height: 2,
      data: png(),
      capturedAt: "2026-08-10T12:00:00.000Z",
    };
  }
}

function createBody(
  reference: { computerSessionId: string; controllerGeneration: string },
  overrides: Partial<{ tokenGeneration: number; controlToken: string; viewToken: string }> = {},
) {
  return {
    ...reference,
    tokenGeneration: 1,
    controlToken,
    viewToken,
    ...overrides,
  };
}

function fixtureEnvironmentAllocator(): ComputerEnvironmentAllocator {
  return {
    async allocate() {
      return {
        seatId: "seat-1",
        displayId: ":101",
        environment: { PATH: process.env.PATH ?? "/usr/bin" },
        async close() {},
      };
    },
  };
}

function command(reference: {
  computerSessionId: string;
  controllerGeneration: string;
}): ComputerActionCommand {
  return {
    protocolVersion: 1,
    operationId: "22222222-2222-4222-8222-222222222222",
    ...reference,
    targetId: "window-1",
    expectedTargetGeneration: "target-generation-1",
    expectedObservationId: "observation-1",
    expectedFrameId: null,
    actor: { kind: "agent", subjectId: "agent:fixture" },
    action: {
      type: "semantic",
      locator: { kind: "ref", ref: "e1" },
      action: "invoke",
    },
  };
}

function png(): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2,
  ]);
}

async function request(
  server: BrowserControlServer,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  return await fetch(`${server.url}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function json(response: Response): Promise<any> {
  return await response.json();
}

async function websocketMessage(websocket: WebSocket): Promise<ArrayBuffer> {
  return await new Promise((resolve, reject) => {
    websocket.addEventListener("message", (event) => resolve(event.data as ArrayBuffer), {
      once: true,
    });
    websocket.addEventListener("error", () => reject(new Error("websocket failed")), {
      once: true,
    });
  });
}

async function websocketClosed(websocket: WebSocket): Promise<CloseEvent> {
  return await new Promise((resolve) =>
    websocket.addEventListener("close", (event) => resolve(event), { once: true }),
  );
}
