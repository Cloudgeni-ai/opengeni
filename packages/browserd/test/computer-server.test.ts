import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type {
  ComputerActionCommand,
  ComputerObservation,
  ComputerSessionCapabilities,
  ComputerTarget,
} from "@opengeni/contracts";
import { COMPUTER_RFB_WEBSOCKET_PROTOCOL } from "@opengeni/contracts";
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
  test("includes an open computer controller in the private update idle proof", async () => {
    await withServer(async ({ server, reference }) => {
      const idle = async () =>
        await json(await request(server, "/v1/runtime", { token: adminToken }));
      expect((await idle()).data).toEqual({ idle: true });
      expect(
        (
          await request(server, "/v1/computer-sessions", {
            method: "POST",
            token: adminToken,
            body: createBody(reference),
          })
        ).status,
      ).toBe(201);
      expect((await idle()).data).toEqual({ idle: false });
      expect(
        (
          await request(server, `/v1/computer-sessions/${reference.computerSessionId}/end`, {
            method: "POST",
            token: adminToken,
            body: { controllerGeneration: reference.controllerGeneration, removeState: false },
          })
        ).status,
      ).toBe(200);
      expect((await idle()).data).toEqual({ idle: true });
    });
  });

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

  test("forwards a complete raw-sized RFB response without pausing mid-rectangle", async () => {
    const expected = new Uint8Array(1_440 * 900 * 4);
    for (let index = 0; index < expected.byteLength; index += 1) expected[index] = index % 251;
    const upstream = createServer((socket) => {
      for (let offset = 0; offset < expected.byteLength; offset += 64 * 1024) {
        socket.write(expected.subarray(offset, Math.min(offset + 64 * 1024, expected.byteLength)));
      }
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("RFB fixture did not bind TCP");
    try {
      await withServer(
        async ({ server, reference }) => {
          const created = await request(server, "/v1/computer-sessions", {
            method: "POST",
            token: adminToken,
            body: createBody(reference),
          });
          expect(created.status).toBe(201);
          const websocket = new WebSocket(
            `${server.url.replace("http:", "ws:")}/v1/computer-sessions/${reference.computerSessionId}/targets/screen-1/rfb`,
            [
              "binary",
              COMPUTER_RFB_WEBSOCKET_PROTOCOL,
              `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${viewToken}`,
            ],
          );
          websocket.binaryType = "arraybuffer";
          expect(await websocketBytes(websocket, expected.byteLength)).toEqual(expected);
          websocket.close(1000, "fixture complete");
        },
        { rfbPort: address.port },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("keeps RFB pixel requests available but rejects input from session view tokens", async () => {
    const received: number[] = [];
    const upstream = createServer((socket) =>
      socket.on("data", (chunk) =>
        received.push(...(typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
      ),
    );
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("RFB fixture did not bind TCP");
    try {
      await withServer(
        async ({ server, reference }) => {
          await request(server, "/v1/computer-sessions", {
            method: "POST",
            token: adminToken,
            body: createBody(reference),
          });
          const socket = await openRfb(server, reference.computerSessionId, viewToken);
          const handshake = new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 1, 1]);
          const frameRequest = Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 20, 0, 10);
          socket.send(handshake);
          socket.send(frameRequest);
          await waitUntil(() => received.length === handshake.length + frameRequest.length);
          const closed = new Promise<number>((resolve) =>
            socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
          );
          socket.send(Uint8Array.of(4, 1, 0, 0, 0, 0, 0, 65));
          expect(await Promise.race([closed, Bun.sleep(500).then(() => null)])).toBe(1008);
          expect(received).toEqual([...handshake, ...frameRequest]);
        },
        { rfbPort: address.port },
      );
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("owns rapid browser RFB input packets until TCP consumes them", async () => {
    const handshake = new TextEncoder().encode("RFB 003.008\n\u0001\u0001");
    const packets = Array.from({ length: 512 }, (_, index) =>
      Uint8Array.of(4, index & 1, 0, 0, 0, 0, 0, index & 0xff),
    );
    const expected = new Uint8Array(
      handshake.length + packets.reduce((length, packet) => length + packet.length, 0),
    );
    expected.set(handshake);
    let offset = handshake.length;
    for (const packet of packets) {
      expected.set(packet, offset);
      offset += packet.length;
    }
    let resolveReceived!: (value: Uint8Array) => void;
    const received = new Promise<Uint8Array>((resolve) => {
      resolveReceived = resolve;
    });
    const upstream = createServer((socket) => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      socket.on("data", (chunk) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        chunks.push(bytes.slice());
        length += bytes.byteLength;
        if (length < expected.byteLength) return;
        const value = new Uint8Array(length);
        let writeOffset = 0;
        for (const current of chunks) {
          value.set(current, writeOffset);
          writeOffset += current.byteLength;
        }
        resolveReceived(value);
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("RFB fixture did not bind TCP");
    try {
      await withServer(
        async ({ server, reference }) => {
          const created = await request(server, "/v1/computer-sessions", {
            method: "POST",
            token: adminToken,
            body: createBody(reference),
          });
          expect(created.status).toBe(201);
          const inputToken = `rfb.${"i".repeat(48)}`;
          const grant = await request(
            server,
            `/v1/computer-sessions/${reference.computerSessionId}/view-grants`,
            {
              method: "POST",
              token: adminToken,
              body: {
                grantId: randomUUID(),
                controllerGeneration: reference.controllerGeneration,
                token: inputToken,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                targetId: "screen-1",
                targetGeneration: "target-generation-1",
                inputAllowed: true,
              },
            },
          );
          expect(grant.status).toBe(201);
          const websocket = await openRfb(server, reference.computerSessionId, inputToken);
          websocket.send(handshake);
          for (const packet of packets) websocket.send(packet);
          expect(await Promise.race([received, Bun.sleep(5_000).then(() => null)])).toEqual(
            expected,
          );
          websocket.close(1000, "fixture complete");
        },
        { rfbPort: address.port },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("binds a prepared RFB grant once to an exact screen generation and input posture", async () => {
    await withRfbServer(async ({ server, reference, driver, received }) => {
      const prepared = rfbGrantBody(reference, false);
      const path = `/v1/computer-sessions/${reference.computerSessionId}/view-grants`;
      const { targetId, targetGeneration, inputAllowed: _inputAllowed, ...oldBody } = prepared;
      expect(
        (
          await json(
            await request(server, path, { method: "POST", token: adminToken, body: oldBody }),
          )
        ).data,
      ).toMatchObject({ scopedRfbInput: true });
      for (const body of [prepared, prepared, oldBody]) {
        const response = await request(server, path, { method: "POST", token: adminToken, body });
        expect(response.status).toBe(200);
        expect((await json(response)).data).toMatchObject({
          targetId,
          targetGeneration,
          inputAllowed: false,
        });
      }
      expect(
        (
          await request(server, path, {
            method: "POST",
            token: adminToken,
            body: { ...prepared, inputAllowed: true },
          })
        ).status,
      ).toBe(409);
      const wrongTarget = await rfbUpgradeResponse(
        server,
        reference.computerSessionId,
        prepared.token,
        "screen-2",
      );
      expect(wrongTarget.status).toBe(401);
      const socket = await openRfb(server, reference.computerSessionId, prepared.token);
      socket.send(rfbHandshake());
      await waitUntil(() => received.length === rfbHandshake().length);
      const closed = websocketClosed(socket);
      socket.send(Uint8Array.of(5, 1, 0, 1, 0, 1));
      expect((await closed).code).toBe(1008);
      expect(received).toEqual([...rfbHandshake()]);
      driver.capabilities.keyboardInput = false;
      const nativeDenied = await request(server, path, {
        method: "POST",
        token: adminToken,
        body: rfbGrantBody(reference, true),
      });
      expect(nativeDenied.status).toBe(403);
    });
  });

  test.each(["target", "native", "rotation", "end"] as const)(
    "rejects buffered RFB input after %s revocation",
    async (revocation) => {
      await withRfbServer(async ({ server, reference, driver, received }) => {
        const grant = rfbGrantBody(reference, true);
        expect(
          (
            await request(
              server,
              `/v1/computer-sessions/${reference.computerSessionId}/view-grants`,
              { method: "POST", token: adminToken, body: grant },
            )
          ).status,
        ).toBe(201);
        const socket = await openRfb(server, reference.computerSessionId, grant.token);
        socket.send(rfbHandshake());
        await waitUntil(() => received.length === rfbHandshake().length);
        let release!: () => void;
        let reached!: () => void;
        const entered = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        driver.beforeTarget = async () => {
          reached();
          await blocked;
        };
        const closed = websocketClosed(socket);
        // A partial input message is still fenced before entering the parser.
        socket.send(Uint8Array.of(4, 1, 0, 0));
        await entered;
        if (revocation === "target") driver.screenGeneration = "target-generation-2";
        else if (revocation === "native") driver.capabilities.pointerInput = false;
        else if (revocation === "rotation") {
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
        } else {
          expect(
            (
              await request(server, `/v1/computer-sessions/${reference.computerSessionId}/end`, {
                method: "POST",
                token: adminToken,
                body: { controllerGeneration: reference.controllerGeneration, removeState: false },
              })
            ).status,
          ).toBe(200);
        }
        release();
        expect((await closed).code).toBe(revocation === "end" ? 1001 : 1008);
        expect(received).toEqual([...rfbHandshake()]);
      });
    },
  );

  test("expires an RFB grant while a handshake packet awaits native validation", async () => {
    await withRfbServer(async ({ server, reference, driver, received }) => {
      const grant = {
        ...rfbGrantBody(reference, true),
        expiresAt: new Date(Date.now() + 250).toISOString(),
      };
      expect(
        (
          await request(
            server,
            `/v1/computer-sessions/${reference.computerSessionId}/view-grants`,
            { method: "POST", token: adminToken, body: grant },
          )
        ).status,
      ).toBe(201);
      const socket = await openRfb(server, reference.computerSessionId, grant.token);
      let release!: () => void;
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      driver.beforeTarget = async () => {
        reached();
        await blocked;
      };
      const closed = websocketClosed(socket);
      socket.send(rfbHandshake());
      await entered;
      expect((await closed).code).toBe(1008);
      release();
      await Bun.sleep(10);
      expect(received).toEqual([]);
    });
  });
});

function rfbHandshake(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode("RFB 003.008\n\u0001\u0001");
}

function rfbGrantBody(reference: { controllerGeneration: string }, inputAllowed: boolean) {
  return {
    grantId: randomUUID(),
    controllerGeneration: reference.controllerGeneration,
    token: `rfb.${randomUUID()}.${"r".repeat(32)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    targetId: "screen-1",
    targetGeneration: "target-generation-1",
    inputAllowed,
  };
}

async function rfbUpgradeResponse(
  server: BrowserControlServer,
  computerSessionId: string,
  token: string,
  targetId: string,
): Promise<Response> {
  return await fetch(
    `${server.url}/v1/computer-sessions/${computerSessionId}/targets/${targetId}/rfb`,
    {
      headers: {
        "sec-websocket-protocol": [
          "binary",
          COMPUTER_RFB_WEBSOCKET_PROTOCOL,
          `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${token}`,
        ].join(", "),
      },
    },
  );
}

async function withRfbServer(
  callback: (fixture: {
    server: BrowserControlServer;
    reference: { computerSessionId: string; controllerGeneration: string };
    driver: FixtureComputerDriver;
    received: number[];
  }) => Promise<void>,
): Promise<void> {
  const received: number[] = [];
  const upstream = createServer((socket) =>
    socket.on("data", (chunk) =>
      received.push(...(typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
    ),
  );
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("RFB fixture did not bind TCP");
  try {
    await withServer(
      async ({ server, reference, getDriver }) => {
        expect(
          (
            await request(server, "/v1/computer-sessions", {
              method: "POST",
              token: adminToken,
              body: createBody(reference),
            })
          ).status,
        ).toBe(201);
        await callback({ server, reference, driver: getDriver(), received });
      },
      { rfbPort: address.port },
    );
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

async function withServer(
  callback: (fixture: {
    server: BrowserControlServer;
    reference: { computerSessionId: string; controllerGeneration: string };
    getDriver: () => FixtureComputerDriver;
  }) => Promise<void>,
  options: { rfbPort?: number } = {},
): Promise<void> {
  const directory = await mkdtemp("/tmp/og-computer-server-");
  const browserSupervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "browser-state"),
    socketRootDirectory: join(directory, "browser-sockets"),
    createDriver: async () => {
      throw new Error("browser driver must not be used by computer routes");
    },
  });
  let driver: FixtureComputerDriver | null = null;
  const computerSupervisor = await ComputerSupervisor.open({
    rootDirectory: join(directory, "computer-state"),
    environmentAllocator: fixtureEnvironmentAllocator(options.rfbPort ?? null),
    createDriver: async (context) => {
      driver = new FixtureComputerDriver(context, options.rfbPort !== undefined);
      return driver;
    },
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
      getDriver: () => {
        if (!driver) throw new Error("fixture driver has not opened");
        return driver;
      },
    });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

class FixtureComputerDriver implements ComputerSupervisorDriver {
  screenGeneration = "target-generation-1";
  beforeTarget: (() => Promise<void>) | null = null;
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

  constructor(
    private readonly context: ComputerSupervisorDriverContext,
    private readonly includeScreen = false,
  ) {}

  async listTargets(): Promise<ComputerTarget[]> {
    return this.includeScreen
      ? [this.buildTarget(), this.buildScreenTarget()]
      : [this.buildTarget()];
  }

  async target(targetId: string): Promise<ComputerTarget | null> {
    await this.beforeTarget?.();
    if (targetId === "window-1") return this.buildTarget();
    if (targetId === "screen-1" && this.includeScreen) return this.buildScreenTarget();
    return null;
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

  private buildScreenTarget(): ComputerTarget {
    return {
      ...this.buildTarget(),
      id: "screen-1",
      targetGeneration: this.screenGeneration,
      kind: "screen",
      applicationId: null,
      processId: null,
      title: "Fixture screen",
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
      // Native RPC returns a view into a larger framed Buffer allocation.
      data: Buffer.concat([Buffer.from("head"), Buffer.from(png()), Buffer.from("tail")]).subarray(
        4,
        4 + png().length,
      ),
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

function fixtureEnvironmentAllocator(rfbPort: number | null = null): ComputerEnvironmentAllocator {
  return {
    async allocate() {
      return {
        seatId: "seat-1",
        displayId: ":101",
        rfbPort,
        environment: { PATH: process.env.PATH ?? "/usr/bin" },
        async close() {},
      };
    },
  };
}

async function openRfb(
  server: BrowserControlServer,
  computerSessionId: string,
  token: string,
): Promise<WebSocket> {
  const socket = new WebSocket(
    `${server.url.replace("http:", "ws:")}/v1/computer-sessions/${computerSessionId}/targets/screen-1/rfb`,
    [
      "binary",
      COMPUTER_RFB_WEBSOCKET_PROTOCOL,
      `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${token}`,
    ],
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("RFB fixture socket failed")), {
      once: true,
    });
  });
  return socket;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("RFB fixture did not reach expected state");
    await Bun.sleep(2);
  }
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

async function websocketBytes(websocket: WebSocket, expectedLength: number): Promise<Uint8Array> {
  return await new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const timer = setTimeout(
      () => reject(new Error(`RFB fixture received ${length} bytes`)),
      5_000,
    );
    websocket.addEventListener("message", (event) => {
      const chunk = new Uint8Array(event.data as ArrayBuffer);
      chunks.push(chunk);
      length += chunk.byteLength;
      if (length < expectedLength) return;
      clearTimeout(timer);
      const received = new Uint8Array(length);
      let offset = 0;
      for (const value of chunks) {
        received.set(value, offset);
        offset += value.byteLength;
      }
      resolve(received);
    });
    websocket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("RFB fixture websocket failed"));
      },
      { once: true },
    );
  });
}

async function websocketClosed(websocket: WebSocket): Promise<CloseEvent> {
  return await new Promise((resolve) =>
    websocket.addEventListener("close", (event) => resolve(event), { once: true }),
  );
}
