import { describe, expect, test } from "bun:test";
import {
  type ComputerActionCommand,
  type ComputerSessionCapabilities,
  parseSecretReference,
  referenceKey,
} from "@opengeni/contracts";
import { ComputerInteractionController } from "@opengeni/interaction";
import {
  ComputerDriver,
  ComputerBackendError,
  type ComputerBackendCaptureOptions,
  type ComputerBackend,
  type ComputerBackendActionCommand,
  type NativeComputerHandshake,
} from "../src";
import { UnsettledCleanupError } from "../src/cleanup-error";

const computerSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";

describe("ComputerDriver", () => {
  test("does not start helper recovery after a pending read is closed", async () => {
    const transport = new FixtureNativeTransport();
    let rejectRead!: (error: Error) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    transport.targets = async () =>
      await new Promise<ReturnType<typeof target>[]>((_, reject) => {
        rejectRead = reject;
        readStarted();
      });
    let replacements = 0;
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
      clientFactory: async () => {
        replacements += 1;
        return new FixtureNativeTransport();
      },
    });
    const outcome = driver.listTargets().then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    await driver.close();
    rejectRead(new Error("native computer helper pipe closed"));
    expect(await outcome).toMatchObject({ code: "controller_lost" });
    expect(replacements).toBe(0);
  });

  test("joins retirement and refuses recovery startup when closing during cleanup", async () => {
    const transport = new FixtureNativeTransport();
    transport.targetsError = new Error("native computer helper pipe closed");
    let releaseRetirement!: () => void;
    let retired!: () => void;
    const retirementStarted = new Promise<void>((resolve) => {
      retired = resolve;
    });
    const retirement = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    transport.close = async () => {
      retired();
      await retirement;
      transport.closed = true;
    };
    let replacements = 0;
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
      clientFactory: async () => {
        replacements += 1;
        return new FixtureNativeTransport();
      },
    });
    const outcome = driver.listTargets().then(
      () => null,
      (error: unknown) => error,
    );
    await retirementStarted;
    const closing = driver.close();
    releaseRetirement();
    await closing;
    expect(await outcome).toMatchObject({ code: "controller_lost" });
    expect(transport.closed).toBe(true);
    expect(replacements).toBe(0);
  });

  test("rejects continuation before native delivery unless the active helper advertised support", async () => {
    for (const supported of [false, true]) {
      const transport = new FixtureNativeTransport();
      if (supported) transport.handshake.capabilities.pointerClickContinuation = true;
      const driver = new ComputerDriver({
        computerSessionId,
        controllerGeneration,
        client: transport,
      });
      const continuation: ComputerActionCommand = {
        ...command(),
        expectedObservationId: null,
        expectedFrameId: "frame-1",
        action: {
          type: "pointer",
          action: "click",
          clickCount: 2,
          continuationOfOperationId: "22222222-2222-4222-8222-222222222222",
          frameId: "frame-1",
          x: 20,
          y: 10,
        },
      };
      try {
        if (supported) {
          await driver.validate(continuation);
          await driver.dispatch(continuation);
          expect(transport.validated?.action).toEqual(continuation.action);
          expect(transport.dispatched?.action).toEqual(continuation.action);
          expect(transport.dispatched?.operationId).toBe(continuation.operationId);
        } else {
          await expect(driver.validate(continuation)).rejects.toMatchObject({
            code: "unsupported",
          });
          await expect(driver.dispatch(continuation)).rejects.toMatchObject({
            code: "unsupported",
          });
          expect(transport.validated).toBeNull();
          expect(transport.dispatched).toBeNull();
          const legacy: ComputerActionCommand = {
            ...continuation,
            action: { type: "pointer", action: "double_click", frameId: "frame-1", x: 20, y: 10 },
          };
          await driver.validate(legacy);
          await driver.dispatch(legacy);
          expect(transport.dispatched?.action).toEqual(legacy.action);
        }
      } finally {
        await driver.close();
      }
    }
  });

  test("does not use a retired helper's continuation capability after recovery", async () => {
    const retired = new FixtureNativeTransport();
    retired.handshake.capabilities.pointerClickContinuation = true;
    retired.targetsError = new Error("native computer helper returned a malformed response");
    const older = new FixtureNativeTransport();
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: retired,
      clientFactory: async () => older,
    });
    try {
      await driver.listTargets();
      const continuation: ComputerActionCommand = {
        ...command(),
        expectedObservationId: null,
        expectedFrameId: "frame-1",
        action: {
          type: "pointer",
          action: "click",
          clickCount: 2,
          continuationOfOperationId: "22222222-2222-4222-8222-222222222222",
          frameId: "frame-1",
          x: 20,
          y: 10,
        },
      };
      await expect(driver.validate(continuation)).rejects.toMatchObject({ code: "unsupported" });
      await expect(driver.dispatch(continuation)).rejects.toMatchObject({ code: "unsupported" });
      expect(retired.closed).toBe(true);
      expect(older.validated).toBeNull();
      expect(older.dispatched).toBeNull();
    } finally {
      await driver.close();
    }
  });

  test("captures a sized still before any viewer starts without consuming a live stream", async () => {
    const transport = new FixtureNativeTransport();
    const capture = transport.capture.bind(transport);
    transport.capture = async () => {
      throw new Error("no live stream started");
    };
    transport.captureStill = capture;
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    try {
      const frame = await driver.capture("window-1", {
        format: "jpeg",
        quality: 55,
        maxWidth: 1024,
        maxHeight: 768,
      });
      expect(frame.frameId).toBe("frame-2");
    } finally {
      await driver.close();
    }
  });
  test("renews a subscription while the last viewer is retiring", async () => {
    const transport = new FixtureNativeTransport();
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    try {
      const first = await driver.subscribeFrames("window-1");
      await first[Symbol.asyncIterator]().next();
      await first.close();
      const renewed = await driver.subscribeFrames("window-1");
      await expect(renewed[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        done: false,
        value: { frameId: "frame-2" },
      });
      await renewed.close();
    } finally {
      await driver.close();
    }
  });

  test("projects native targets, observations, causal actions, and latest-wins frames", async () => {
    const transport = new FixtureNativeTransport();
    const driver = new ComputerDriver({
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
    expect(transport.stoppedCaptures).toBe(1);
  });

  test("preserves definite native lock failures in public receipts", async () => {
    const transport = new FixtureNativeTransport();
    transport.validateError = new ComputerBackendError(
      "machine_locked",
      "Unlock the Mac to continue",
      true,
      false,
    );
    const driver = new ComputerDriver({
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

  test("primes one frame fence for a cold visual target and reuses warm observations", async () => {
    const transport = new FixtureNativeTransport();
    transport.observationFrameId = null;
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    try {
      await expect(driver.observe("window-1")).resolves.toMatchObject({ frameId: "frame-2" });
      expect(transport.captures).toBe(1);

      transport.observationFrameId = "frame-2";
      await expect(driver.observe("window-1")).resolves.toMatchObject({ frameId: "frame-2" });
      expect(transport.captures).toBe(1);
    } finally {
      await driver.close();
    }
  });

  test("preserves a typed native diagnosis when dispatch outcome is unknown", async () => {
    const transport = new FixtureNativeTransport();
    transport.dispatchError = new ComputerBackendError(
      "outcome_unknown",
      "The exact macOS window did not confirm focus",
      false,
      true,
    );
    const driver = new ComputerDriver({
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
        state: "outcome_unknown",
        dispatchedAt: expect.any(String),
        error: {
          code: "outcome_unknown",
          message: "The exact macOS window did not confirm focus",
          retryable: false,
        },
      });
    } finally {
      await driver.close();
    }
  });

  test("settles a successful target-replacing action without fabricating an observation", async () => {
    const transport = new FixtureNativeTransport();
    transport.dispatchObservation = null;
    const driver = new ComputerDriver({
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
    poisoned.startCaptureError = new ComputerBackendError(
      "timeout",
      "ScreenCaptureKit stream startup timed out",
      true,
      false,
    );
    const replacement = new FixtureNativeTransport();
    let recoveries = 0;
    const driver = new ComputerDriver({
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

  test("stops live capture on a poisoned helper before opening a replacement", async () => {
    const poisoned = new FixtureNativeTransport();
    poisoned.captureError = new ComputerBackendError(
      "timeout",
      "ScreenCaptureKit frame wait timed out",
      true,
      false,
    );
    const replacement = new FixtureNativeTransport();
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: poisoned,
      clientFactory: async () => replacement,
    });
    try {
      const frames = await driver.subscribeFrames("window-1");
      await expect(frames[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        done: false,
        value: { frameId: "frame-2", sequence: 1 },
      });
      await frames.close();
      expect(poisoned.stoppedCaptures).toBeGreaterThanOrEqual(1);
      expect(poisoned.closed).toBe(true);
      expect(poisoned.teardown[0]).toBe("stop");
      expect(poisoned.teardown.at(-1)).toBe("close");
      expect(poisoned.teardown.indexOf("stop")).toBeLessThan(poisoned.teardown.indexOf("close"));
    } finally {
      await driver.close();
    }
  });

  test("replaces a poisoned native helper once for safe target reads", async () => {
    const poisoned = new FixtureNativeTransport();
    poisoned.targetsError = new Error("native computer helper returned a malformed response");
    const replacement = new FixtureNativeTransport();
    let recoveries = 0;
    const driver = new ComputerDriver({
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

  test("fails clearly and does not create a replacement when a failed helper may still run", async () => {
    const poisoned = new FixtureNativeTransport();
    poisoned.targetsError = new Error("fixture transport failed");
    poisoned.close = async () => {
      throw new Error("fixture helper did not stop");
    };
    let factories = 0;
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: poisoned,
      clientFactory: async () => {
        factories++;
        return new FixtureNativeTransport();
      },
    });
    await expect(driver.listTargets()).rejects.toMatchObject({
      name: "InteractionControllerError",
      code: "controller_lost",
    });
    await expect(driver.listTargets()).rejects.toMatchObject({ code: "controller_lost" });
    expect(factories).toBe(0);
    await expect(driver.close()).rejects.toThrow("computer driver cleanup failed");
    await expect(driver.close()).rejects.toThrow("computer driver cleanup failed");
  });

  test("replaces a crashed helper whose process already exited", async () => {
    const crashed = new FixtureNativeTransport();
    crashed.targetsError = new Error("native computer helper exited");
    crashed.close = async () => {
      throw new UnsettledCleanupError([], "native computer helper cleanup was not confirmed", {
        processExited: true,
      });
    };
    let factories = 0;
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: crashed,
      clientFactory: async () => {
        factories++;
        return new FixtureNativeTransport();
      },
    });
    await expect(driver.listTargets()).resolves.toMatchObject([{ id: "window-1" }]);
    await expect(driver.listTargets()).resolves.toMatchObject([{ id: "window-1" }]);
    expect(factories).toBe(1);
    await driver.close();
  });

  test("reports a retryable unavailable helper when its replacement cannot start", async () => {
    const crashed = new FixtureNativeTransport();
    crashed.targetsError = new Error("native computer helper exited");
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: crashed,
      clientFactory: async () => {
        throw new Error("fixture helper failed to start");
      },
    });
    await expect(driver.listTargets()).rejects.toMatchObject({
      name: "InteractionControllerError",
      code: "resource_unavailable",
      retryable: true,
    });
    await driver.close();
  });

  test("fans one native source out to independent concurrent frame profiles", async () => {
    const transport = new FixtureNativeTransport();
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    try {
      const full = await driver.subscribeFrames("window-1", {
        format: "png",
        maxWidth: 100,
        maxHeight: 100,
      });
      const compact = await driver.subscribeFrames("window-1", {
        format: "jpeg",
        quality: 55,
        maxWidth: 10,
        maxHeight: 10,
        everyNthFrame: 2,
      });
      const [fullFrame, compactFrame] = await Promise.all([
        full[Symbol.asyncIterator]().next(),
        compact[Symbol.asyncIterator]().next(),
      ]);
      expect(fullFrame).toMatchObject({
        done: false,
        value: { mediaType: "image/png", width: 20, height: 10, sequence: 1 },
      });
      expect(compactFrame).toMatchObject({
        done: false,
        value: { mediaType: "image/jpeg", width: 10, height: 5, sequence: 1 },
      });
      expect(transport.startedCaptureOptions).toEqual([
        { format: "png", quality: 100, maxWidth: 100, maxHeight: 100 },
      ]);

      await compact.close();
      await expect(full[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        done: false,
        value: { mediaType: "image/png", sequence: 2 },
      });
      await full.close();
    } finally {
      await driver.close();
    }
    expect(transport.stoppedCaptures).toBe(1);
  });

  test("pastes text the native keymap refused before typing any key", async () => {
    const transport = new UntypeableTextTransport();
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    const typing = typeCommand("ÆØÅ–π密");
    await expect(driver.dispatch(typing)).resolves.toMatchObject({
      observationId: "observation-2",
    });
    expect(transport.calls).toEqual([
      ["dispatch", { type: "keyboard", action: "type", value: "ÆØÅ–π密" }],
      ["validate", { type: "clipboard", operation: "write", text: "ÆØÅ–π密" }],
      ["validate", { type: "clipboard", operation: "paste" }],
      ["dispatch", { type: "clipboard", operation: "write", text: "ÆØÅ–π密" }],
      ["dispatch", { type: "clipboard", operation: "paste" }],
    ]);
    expect(transport.dispatched).toMatchObject({
      operationId: typing.operationId,
      targetId: typing.targetId,
      expectedTargetGeneration: typing.expectedTargetGeneration,
      expectedObservationId: typing.expectedObservationId,
    });
  });

  test("never pastes after possible input, for keys with their own effect, or without a clipboard", async () => {
    const cases: Array<[string, (transport: UntypeableTextTransport) => ComputerActionCommand]> = [
      [
        "outcome_unknown",
        (transport) => {
          transport.refusal = new ComputerBackendError(
            "outcome_unknown",
            transport.refusal.message,
            false,
            true,
          );
          return typeCommand("ÆØÅ");
        },
      ],
      ["unsupported", () => typeCommand("Æ\n")],
      [
        "unsupported",
        () => ({ ...typeCommand("Æ"), action: { type: "keyboard", action: "press", value: "Æ" } }),
      ],
      [
        "unsupported",
        (transport) => {
          transport.refusal = new ComputerBackendError(
            "unsupported",
            "X11 window input route is not verified: XKB is unavailable",
            false,
            false,
          );
          return typeCommand("Æ");
        },
      ],
      [
        "unsupported",
        (transport) => {
          transport.handshake.capabilities.clipboard = false;
          return typeCommand("Æ");
        },
      ],
    ];
    for (const [code, arrange] of cases) {
      const transport = new UntypeableTextTransport();
      const typing = arrange(transport);
      const driver = new ComputerDriver({
        computerSessionId,
        controllerGeneration,
        client: transport,
      });
      await expect(driver.dispatch(typing)).rejects.toMatchObject({ code });
      expect(transport.calls).toEqual([["dispatch", typing.action]]);
    }
  });

  test("a backend's failure text is redacted in full before it is bounded", async () => {
    const raw = ["{{", "secret:Desk/token", "}}"].join("");
    for (const secret of [
      "line-one\nline-two-secret",
      `long-${"x".repeat(3_000)}-secret`,
      "trailing-secret \n",
    ]) {
      const transport = new FixtureNativeTransport();
      transport.dispatchError = new ComputerBackendError(
        "driver_failed",
        `CUA type_text refused the operation: could not type ${secret} into the field`,
        false,
        false,
      );
      const driver = new ComputerDriver({
        computerSessionId,
        controllerGeneration,
        client: transport,
      });
      const error = await driver
        .dispatch({
          ...typeCommand(raw),
          secretValues: { [referenceKey(parseSecretReference(raw))]: secret },
        })
        .then(
          () => null,
          (caught: unknown) => caught as Error,
        );
      expect(error?.message).toBe(
        "CUA type_text refused the operation: could not type [secret] into the field",
      );
    }
  });

  test("never pastes text that carries a resolved secret", async () => {
    const transport = new UntypeableTextTransport();
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    const raw = "{{secret:Desk/password}}";
    const typing: ComputerActionCommand = {
      ...typeCommand(raw),
      secretValues: { [referenceKey(parseSecretReference(raw))]: "pÆss密" },
    };
    const error = await driver.dispatch(typing).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toMatchObject({ code: "unsupported" });
    expect(error?.message).not.toContain("pÆss密");
    expect(transport.calls).toEqual([
      ["dispatch", { type: "keyboard", action: "type", value: "pÆss密" }],
    ]);
  });
  test("redacts a typed secret from later observations of the field that holds it", async () => {
    const transport = new EchoingFieldTransport();
    const driver = new ComputerDriver({
      computerSessionId,
      controllerGeneration,
      client: transport,
    });
    const raw = ["{{", "secret:Desk/api key", "}}"].join("");
    const secret = "sk-live-0123456789abcdef";
    const typed = await driver.dispatch({
      ...typeCommand(raw),
      secretValues: { [referenceKey(parseSecretReference(raw))]: secret },
    });
    expect(JSON.stringify(typed)).not.toContain(secret);
    expect(transport.typed).toBe(secret);
    // A later observation carries no secret of its own, yet the desktop
    // still shows the field's value: it stays redacted.
    const later = await driver.observe("window-1");
    expect(JSON.stringify(later)).not.toContain(secret);
    expect(later.semantic?.kind === "snapshot" && later.semantic.roots[0]).toMatchObject({
      role: "textbox",
      value: "[secret]",
    });
    expect(JSON.stringify(await driver.listTargets())).not.toContain(secret);
  });
});

class FixtureNativeTransport implements ComputerBackend {
  readonly identity = { adapterId: "opengeni.native.linux.v1", platform: "linux" as const };
  get initialCapabilities() {
    return this.handshake.capabilities;
  }
  readonly handshake: NativeComputerHandshake = {
    protocolVersion: 3,
    helperVersion: "fixture",
    platform: "linux",
    capabilities: capabilities(),
  };
  validated: ComputerBackendActionCommand | null = null;
  dispatched: ComputerBackendActionCommand | null = null;
  validateError: Error | null = null;
  startCaptureError: Error | null = null;
  captureError: Error | null = null;
  targetsError: Error | null = null;
  dispatchObservation: ReturnType<typeof observation> | null = observation("observation-2");
  dispatchError: Error | null = null;
  closed = false;
  stoppedCaptures = 0;
  teardown: Array<"stop" | "close"> = [];
  startedCaptureOptions: ComputerBackendCaptureOptions[] = [];
  observationFrameId: string | null = "frame-1";
  captures = 0;

  async capabilities(): Promise<ComputerSessionCapabilities> {
    return this.handshake.capabilities;
  }

  async targets() {
    if (this.targetsError) throw this.targetsError;
    return [target()];
  }

  async observe() {
    return { ...observation("observation-1"), frameId: this.observationFrameId };
  }

  async capture(_targetId: string, options?: ComputerBackendCaptureOptions) {
    if (this.captureError) throw this.captureError;
    this.captures += 1;
    const width = Math.min(20, options?.maxWidth ?? 20);
    const height = Math.min(10, Math.max(1, Math.floor((width / 20) * 10)));
    const jpeg = options?.format === "jpeg";
    return {
      frameId: "frame-2",
      targetId: "window-1",
      targetGeneration: "target-generation-1",
      width,
      height,
      mimeType: jpeg ? ("image/jpeg" as const) : ("image/png" as const),
      sha256: "a".repeat(64),
      data: new Uint8Array([1, 2, 3]),
    };
  }

  async captureStill(targetId: string, options: ComputerBackendCaptureOptions) {
    return await this.capture(targetId, options);
  }

  async startCapture(_targetId: string, options: ComputerBackendCaptureOptions): Promise<void> {
    if (this.startCaptureError) throw this.startCaptureError;
    this.startedCaptureOptions.push(options);
  }

  async stopCapture(): Promise<void> {
    this.stoppedCaptures += 1;
    this.teardown.push("stop");
  }

  async clipboard() {
    return { text: "fixture clipboard", truncated: false };
  }

  async validate(nativeCommand: ComputerBackendActionCommand): Promise<void> {
    if (this.validateError) throw this.validateError;
    this.validated = nativeCommand;
  }

  async dispatch(nativeCommand: ComputerBackendActionCommand) {
    this.dispatched = nativeCommand;
    if (this.dispatchError) throw this.dispatchError;
    return this.dispatchObservation;
  }

  async close(): Promise<void> {
    this.teardown.push("close");
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

/** Refuses keyboard text like the Linux X11 keymap does, before any key. */
class UntypeableTextTransport extends FixtureNativeTransport {
  calls: Array<["validate" | "dispatch", ComputerBackendActionCommand["action"]]> = [];
  refusal = new ComputerBackendError(
    "unsupported",
    "X11 keymap cannot type Unicode scalar U+00C6; use clipboard paste",
    false,
    false,
  );

  override async validate(nativeCommand: ComputerBackendActionCommand): Promise<void> {
    this.calls.push(["validate", nativeCommand.action]);
    await super.validate(nativeCommand);
  }

  override async dispatch(nativeCommand: ComputerBackendActionCommand) {
    this.calls.push(["dispatch", nativeCommand.action]);
    if (nativeCommand.action.type === "keyboard") throw this.refusal;
    return await super.dispatch(nativeCommand);
  }
}

function typeCommand(value: string): ComputerActionCommand {
  return { ...command(), action: { type: "keyboard", action: "type", value } };
}

/** A desktop whose text field (and window title) shows what was typed into it. */
class EchoingFieldTransport extends FixtureNativeTransport {
  typed = "";

  private field(observationId: string) {
    return {
      ...observation(observationId),
      roots: [
        { ref: "e1", role: "textbox", name: "API key", value: this.typed, states: [], actions: [] },
      ],
    };
  }

  override async observe() {
    return { ...this.field("observation-1"), frameId: this.observationFrameId };
  }

  override async targets() {
    return (await super.targets()).map((entry) => ({ ...entry, title: `Settings ${this.typed}` }));
  }

  override async dispatch(nativeCommand: ComputerBackendActionCommand) {
    if (nativeCommand.action.type === "keyboard" && nativeCommand.action.action === "type")
      this.typed = nativeCommand.action.value;
    return this.field("observation-2");
  }
}
