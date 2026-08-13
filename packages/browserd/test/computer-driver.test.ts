import { describe, expect, test } from "bun:test";
import type { ComputerActionCommand, ComputerSessionCapabilities } from "@opengeni/contracts";
import { ComputerInteractionController } from "@opengeni/interaction";
import {
  NativeComputerDriver,
  NativeComputerError,
  type ComputerNativeTransport,
  type NativeComputerActionCommand,
  type NativeComputerHandshake,
} from "../src";

const computerSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";

describe("NativeComputerDriver", () => {
  test("projects native targets, observations, causal actions, and latest-wins frames", async () => {
    const transport = new FixtureNativeTransport();
    const driver = new NativeComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    const controller = new ComputerInteractionController({
      computerSessionId,
      controllerGeneration,
      driver,
    });
    try {
      expect((await driver.listTargets())[0]).toMatchObject({
        id: "window-1",
        computerSessionId,
        controllerGeneration,
      });
      expect(await controller.observe("window-1")).toMatchObject({
        observationId: "observation-1",
        semantic: { kind: "snapshot", nodeCount: 1 },
      });
      const receipt = await controller.run(command());
      expect(receipt).toMatchObject({
        state: "completed",
        observation: { observationId: "observation-2" },
      });
      expect(transport.validated).toMatchObject({
        targetId: "window-1",
        expectedObservationId: "observation-1",
      });
      expect(transport.dispatched).toEqual(transport.validated);
      expect(await driver.clipboard()).toEqual({
        computerSessionId,
        controllerGeneration,
        text: "fixture clipboard",
        truncated: false,
        observedAt: "2026-08-10T12:00:00.000Z",
      });

      const frames = await driver.subscribeFrames("window-1", {
        format: "png",
        maxWidth: 100,
        maxHeight: 100,
      });
      const first = await frames[Symbol.asyncIterator]().next();
      expect(first).toMatchObject({
        done: false,
        value: {
          frameId: "frame-2",
          computerSessionId,
          controllerGeneration,
          sequence: 1,
        },
      });
      await frames.close();
    } finally {
      await driver.close();
    }
    expect(transport.closed).toBe(true);
  });

  test("preserves definite native lock failures in public receipts", async () => {
    const transport = new FixtureNativeTransport();
    transport.validateError = new NativeComputerError(
      "machine_locked",
      "Unlock the Mac to continue",
      true,
      false,
    );
    const driver = new NativeComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    const controller = new ComputerInteractionController({
      computerSessionId,
      controllerGeneration,
      driver,
    });
    try {
      expect(await controller.run(command())).toMatchObject({
        state: "failed",
        dispatchedAt: null,
        error: { code: "machine_locked", retryable: true },
      });
    } finally {
      await driver.close();
    }
  });

  test("settles a successful target-replacing action without fabricating an observation", async () => {
    const transport = new FixtureNativeTransport();
    transport.dispatchObservation = null;
    const driver = new NativeComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    const controller = new ComputerInteractionController({
      computerSessionId,
      controllerGeneration,
      driver,
    });
    try {
      expect(await controller.run(command())).toMatchObject({
        state: "completed",
        observation: null,
        error: null,
      });
      expect(transport.dispatched).toEqual(transport.validated);
    } finally {
      await driver.close();
    }
  });

  test("replaces a poisoned native helper once before failing the frame stream", async () => {
    const poisoned = new FixtureNativeTransport();
    poisoned.startCaptureError = new NativeComputerError(
      "timeout",
      "ScreenCaptureKit stream startup timed out",
      true,
      false,
    );
    const replacement = new FixtureNativeTransport();
    let recoveries = 0;
    const driver = new NativeComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: poisoned,
      clientFactory: async () => {
        recoveries += 1;
        return replacement;
      },
    });
    try {
      const frames = await driver.subscribeFrames("window-1");
      await expect(frames[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        done: false,
        value: { frameId: "frame-2", sequence: 1 },
      });
      await frames.close();
      expect(recoveries).toBe(1);
      expect(poisoned.closed).toBe(true);
    } finally {
      await driver.close();
    }
  });

  test("replaces a poisoned native helper once for safe target reads", async () => {
    const poisoned = new FixtureNativeTransport();
    poisoned.targetsError = new Error("native computer helper returned a malformed response");
    const replacement = new FixtureNativeTransport();
    let recoveries = 0;
    const driver = new NativeComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: poisoned,
      clientFactory: async () => {
        recoveries += 1;
        return replacement;
      },
    });
    try {
      await expect(driver.listTargets()).resolves.toMatchObject([
        { id: "window-1", computerSessionId, controllerGeneration },
      ]);
      expect(recoveries).toBe(1);
      expect(poisoned.closed).toBe(true);
    } finally {
      await driver.close();
    }
  });
});

class FixtureNativeTransport implements ComputerNativeTransport {
  readonly handshake: NativeComputerHandshake = {
    protocolVersion: 2,
    helperVersion: "fixture",
    platform: "linux",
    capabilities: capabilities(),
  };
  validated: NativeComputerActionCommand | null = null;
  dispatched: NativeComputerActionCommand | null = null;
  validateError: Error | null = null;
  startCaptureError: Error | null = null;
  targetsError: Error | null = null;
  dispatchObservation: ReturnType<typeof observation> | null = observation("observation-2");
  closed = false;

  async capabilities(): Promise<ComputerSessionCapabilities> {
    return this.handshake.capabilities;
  }

  async targets() {
    if (this.targetsError) throw this.targetsError;
    return [target()];
  }

  async observe() {
    return observation("observation-1");
  }

  async capture() {
    return {
      frameId: "frame-2",
      targetId: "window-1",
      targetGeneration: "target-generation-1",
      width: 20,
      height: 10,
      mimeType: "image/png" as const,
      sha256: "a".repeat(64),
      data: new Uint8Array([1, 2, 3]),
    };
  }

  async startCapture(): Promise<void> {
    if (this.startCaptureError) throw this.startCaptureError;
  }

  async stopCapture(): Promise<void> {}

  async clipboard() {
    return { text: "fixture clipboard", truncated: false };
  }

  async validate(nativeCommand: NativeComputerActionCommand): Promise<void> {
    if (this.validateError) throw this.validateError;
    this.validated = nativeCommand;
  }

  async dispatch(nativeCommand: NativeComputerActionCommand) {
    this.dispatched = nativeCommand;
    return this.dispatchObservation;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function capabilities(): ComputerSessionCapabilities {
  return {
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
}

function target() {
  return {
    id: "window-1",
    targetGeneration: "target-generation-1",
    kind: "window" as const,
    applicationId: "fixture.desktop",
    processId: 42,
    title: "Fixture",
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    focused: true,
  };
}

function observation(observationId: string) {
  return {
    observationId,
    target: target(),
    frameId: "frame-1",
    roots: [
      {
        ref: "e1",
        role: "button",
        name: "Save",
        states: ["enabled"],
        actions: ["invoke"],
      },
    ],
    nodeCount: 1,
    focusedRef: "e1",
    changedRegions: [],
  };
}

function command(): ComputerActionCommand {
  return {
    protocolVersion: 1,
    operationId: "22222222-2222-4222-8222-222222222222",
    computerSessionId,
    controllerGeneration,
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
