import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ComputerActionCommand,
  ComputerObservation,
  ComputerSessionCapabilities,
  ComputerTarget,
} from "@opengeni/contracts";
import {
  BrowserControlServer,
  BrowserSupervisor,
  ComputerSupervisor,
  LatestComputerFrameSubscription,
  type ComputerEnvironmentAllocator,
  type ComputerFrameStreamOptions,
  type ComputerImageFrame,
  type ComputerSupervisorDriver,
  type ComputerSupervisorDriverContext,
} from "@opengeni/browserd";
import {
  BrowserControlClient,
  ComputerFrameEvidenceMismatchError,
  type BrowserControlPlacementSession,
  type ComputerControlFrameMetadata,
} from "@opengeni/runtime/sandbox";
import { createInteractionAttemptToolDefinitions } from "@opengeni/runtime";
import { OpenGeniApiError, OpenGeniClient, type InteractionTransport } from "@opengeni/sdk";
import {
  captureModelComputerFrame,
  validateComputerFrameForApi,
} from "../src/routes/computer-sessions";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const sourceSessionId = "00000000-0000-4000-8000-000000000002";
const targetId = "screen:0";
const adminToken = `admin.${"a".repeat(48)}`;
const controlToken = `control.${"c".repeat(48)}`;
const viewToken = `view.${"v".repeat(48)}`;

describe("Computer frame evidence pipeline", () => {
  test.each([
    ["frame_session_mismatch", { computerSessionId: "00000000-0000-4000-8000-000000000099" }],
    ["frame_target_mismatch", { targetId: "screen:1" }],
    ["frame_controller_mismatch", { controllerGeneration: "controller:8" }],
  ] as const)("rejects %s at the controller-to-API boundary", (reason, metadata) => {
    expectApiMismatch(() => validateComputerFrameForApi(wireFrame(metadata), expected()), reason);
  });

  test("rejects MIME, invalid metadata digest, and altered body bytes at the API boundary", () => {
    expectApiMismatch(
      () =>
        validateComputerFrameForApi(
          wireFrame({ mediaType: "image/png", responseMediaType: "image/jpeg" }),
          expected(),
        ),
      "frame_media_mismatch",
    );
    expectApiMismatch(
      () => validateComputerFrameForApi(wireFrame({ sha256: "z".repeat(64) }), expected()),
      "frame_digest_mismatch",
    );
    const frame = wireFrame();
    frame.data = Uint8Array.from([...frame.data, 0]);
    expectApiMismatch(
      () => validateComputerFrameForApi(frame, expected()),
      "frame_digest_mismatch",
    );
  });

  test("couples an oversized browserd capture to its compact retry through API and SDK", async () => {
    await withPipeline(async ({ driver, reference, session }) => {
      const frame = await captureModelComputerFrame(session, {
        ...reference,
        targetId,
      });

      expect(driver.captureOptions).toEqual([
        { format: "jpeg", quality: 55, maxWidth: 1_024, maxHeight: 768 },
        { format: "jpeg", quality: 30, maxWidth: 640, maxHeight: 480 },
      ]);
      expect(frame.mediaType).toBe("image/jpeg");
      expect(frame.data.byteLength).toBeLessThanOrEqual(256 * 1024);
      expect(frame.metadata.sha256).toBe(
        new Bun.CryptoHasher("sha256").update(frame.data).digest("hex"),
      );

      let requestedUrl = "";
      const sdk = new OpenGeniClient({
        baseUrl: "https://api.example.test",
        fetch: async (input) => {
          requestedUrl = String(input);
          return apiFrameResponse(frame);
        },
      });
      const sdkFrame = await sdk.captureComputerTarget(
        workspaceId,
        reference.computerSessionId,
        targetId,
      );
      expect(requestedUrl).toContain("/targets/screen%3A0/screenshot");
      expect(sdkFrame.data).toEqual(frame.data);
      expect(sdkFrame.sha256).toBe(frame.metadata.sha256);

      const observation = await session.observe(targetId);
      const transport = {
        observeComputerTarget: async () => observation,
        captureComputerTarget: async () =>
          await sdk.captureComputerTarget(workspaceId, reference.computerSessionId, targetId),
      } as unknown as InteractionTransport;
      const [definition] = createInteractionAttemptToolDefinitions({
        transport,
        workspaceId,
        sessionId: sourceSessionId,
        selectedTools: ["computer_observe"],
        permissions: ["sessions:read"],
      });
      const result = await definition!.execute(
        { computerSessionId: reference.computerSessionId, targetId },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ ...observation, frameId: frame.metadata.frameId }),
        },
        {
          type: "image",
          data: Buffer.from(frame.data).toString("base64"),
          mimeType: "image/jpeg",
        },
      ]);
    });
  });

  test("forwards a PNG capture through the same controller-to-API and SDK evidence boundary", async () => {
    await withPipeline(async ({ reference, session }) => {
      const frame = validateComputerFrameForApi(
        await session.capture(targetId, { format: "png", maxWidth: 640, maxHeight: 480 }),
        { ...reference, targetId },
      );
      expect(frame.mediaType).toBe("image/png");

      const sdk = new OpenGeniClient({
        baseUrl: "https://api.example.test",
        fetch: async () => apiFrameResponse(frame),
      });
      await expect(
        sdk.captureComputerTarget(workspaceId, reference.computerSessionId, targetId),
      ).resolves.toMatchObject({
        computerSessionId: reference.computerSessionId,
        controllerGeneration: reference.controllerGeneration,
        targetId,
        mediaType: "image/png",
        data: frame.data,
      });
    });
  });

  test("keeps the SDK verifier fail-closed with a generic 502", async () => {
    const frame = wireFrame();
    const corrupted = Uint8Array.from([...frame.data, 0]);
    const sdk = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () => apiFrameResponse({ ...frame, data: corrupted }),
    });

    try {
      await sdk.captureComputerTarget(workspaceId, expected().computerSessionId, targetId);
      throw new Error("expected SDK frame evidence rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenGeniApiError);
      expect((error as OpenGeniApiError).status).toBe(502);
      expect((error as Error).message).toContain(
        "computer frame evidence does not match its request",
      );
      expect((error as Error).message).not.toContain("frame_digest_mismatch");
    }
  });
});

async function withPipeline(
  callback: (fixture: {
    driver: FixtureComputerDriver;
    reference: { computerSessionId: string; controllerGeneration: string };
    session: ReturnType<BrowserControlClient["computerSessionClient"]>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp("/tmp/og-computer-frame-pipeline-");
  const browserSupervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "browser-state"),
    socketRootDirectory: join(directory, "browser-sockets"),
    createDriver: async () => {
      throw new Error("browser driver must not be used by computer frame tests");
    },
  });
  let driver: FixtureComputerDriver | null = null;
  const computerSupervisor = await ComputerSupervisor.open({
    rootDirectory: join(directory, "computer-state"),
    environmentAllocator: fixtureEnvironmentAllocator(),
    createDriver: async (context) => (driver = new FixtureComputerDriver(context)),
  });
  const server = BrowserControlServer.start({
    supervisor: browserSupervisor,
    computerSupervisor,
    adminToken,
    port: 0,
  });
  const reference = {
    computerSessionId: randomUUID(),
    controllerGeneration: "controller:7",
  };
  const placement: BrowserControlPlacementSession = {
    resolveExposedPort: async () => ({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      path: "/",
      query: "",
    }),
  };
  try {
    const client = new BrowserControlClient(placement, { adminToken });
    await client.createComputerSession({
      ...reference,
      tokenGeneration: 1,
      controlToken,
      viewToken,
    });
    if (!driver) throw new Error("computer frame fixture driver was not created");
    await callback({
      driver,
      reference,
      session: client.computerSessionClient({ reference, controlToken, viewToken }),
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
  readonly captureOptions: ComputerFrameStreamOptions[] = [];
  private sequence = 0;

  constructor(private readonly context: ComputerSupervisorDriverContext) {}

  async listTargets(): Promise<ComputerTarget[]> {
    return [this.buildTarget()];
  }

  async target(candidate: string): Promise<ComputerTarget | null> {
    return candidate === targetId ? this.buildTarget() : null;
  }

  async observe(): Promise<ComputerObservation> {
    return this.observation();
  }

  async dispatch(_command: ComputerActionCommand): Promise<ComputerObservation> {
    return this.observation();
  }

  async capture(
    _targetId: string,
    options: ComputerFrameStreamOptions = {},
  ): Promise<ComputerImageFrame> {
    this.captureOptions.push({ ...options });
    const mediaType = options.format === "png" ? "image/png" : "image/jpeg";
    const compact = mediaType === "image/png" ? png() : jpeg();
    const data =
      mediaType === "image/jpeg" && options.maxWidth === 1_024
        ? padded(compact, 256 * 1024 + 1)
        : compact;
    return {
      frameId: `frame-${this.sequence}`,
      computerSessionId: this.context.computerSessionId,
      controllerGeneration: this.context.controllerGeneration,
      targetId,
      targetGeneration: "target-generation-1",
      sequence: this.sequence++,
      mediaType,
      width: 1,
      height: 1,
      data,
      capturedAt: "2026-08-30T10:00:00.000Z",
    };
  }

  async clipboard() {
    return {
      computerSessionId: this.context.computerSessionId,
      controllerGeneration: this.context.controllerGeneration,
      text: "fixture clipboard",
      truncated: false,
      observedAt: "2026-08-30T10:00:00.000Z",
    };
  }

  async subscribeFrames() {
    return new LatestComputerFrameSubscription(async () => undefined);
  }

  async close(): Promise<void> {}

  private buildTarget(): ComputerTarget {
    return {
      id: targetId,
      computerSessionId: this.context.computerSessionId,
      controllerGeneration: this.context.controllerGeneration,
      targetGeneration: "target-generation-1",
      kind: "screen",
      applicationId: null,
      processId: null,
      title: "Fixture screen",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      focused: true,
    };
  }

  private observation(): ComputerObservation {
    return {
      protocolVersion: 1,
      observationId: "observation-1",
      computerSessionId: this.context.computerSessionId,
      target: this.buildTarget(),
      frameId: null,
      semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
      screenshot: null,
      focusedRef: null,
      changedRegions: [],
      observedAt: "2026-08-30T10:00:00.000Z",
    };
  }
}

function fixtureEnvironmentAllocator(): ComputerEnvironmentAllocator {
  return {
    async allocate() {
      return {
        seatId: "seat-1",
        displayId: ":101",
        rfbPort: null,
        environment: { PATH: process.env.PATH ?? "/usr/bin" },
        async close() {},
      };
    },
  };
}

function apiFrameResponse(frame: {
  data: Uint8Array;
  mediaType: "image/jpeg" | "image/png";
  metadataHeader: string;
}): Response {
  return new Response(frame.data.slice().buffer, {
    status: 200,
    headers: {
      "content-type": frame.mediaType,
      "x-opengeni-computer-frame": frame.metadataHeader,
    },
  });
}

function expected() {
  return {
    computerSessionId: "00000000-0000-4000-8000-000000000014",
    controllerGeneration: "controller:7",
    targetId,
  } as const;
}

function wireFrame(
  overrides: Partial<ComputerControlFrameMetadata> & {
    responseMediaType?: "image/jpeg" | "image/png";
  } = {},
) {
  const { responseMediaType, ...metadataOverrides } = overrides;
  const data = png();
  const metadata: ComputerControlFrameMetadata = {
    frameId: "frame-1",
    ...expected(),
    targetGeneration: "target-generation-1",
    sequence: 1,
    mediaType: "image/png",
    width: 1,
    height: 1,
    capturedAt: "2026-08-30T10:00:00.000Z",
    sha256: createHash("sha256").update(data).digest("hex"),
    ...metadataOverrides,
  };
  return {
    data,
    mediaType: responseMediaType ?? metadata.mediaType,
    metadataHeader: Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
  };
}

function expectApiMismatch(
  run: () => unknown,
  reason: ComputerFrameEvidenceMismatchError["reason"],
): void {
  try {
    run();
    throw new Error("expected API frame evidence mismatch");
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerFrameEvidenceMismatchError);
    expect((error as ComputerFrameEvidenceMismatchError).reason).toBe(reason);
  }
}

function padded(source: Uint8Array, byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  output.set(source);
  return output;
}

function png(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
}

function jpeg(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
      "base64",
    ),
  );
}
