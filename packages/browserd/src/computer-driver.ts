import { randomUUID } from "node:crypto";
import {
  ComputerClipboard,
  ComputerObservation,
  ComputerTarget,
  type ComputerActionCommand,
  type ComputerClipboard as ComputerClipboardValue,
  type ComputerObservation as ComputerObservationValue,
  type ComputerSessionCapabilities,
  type ComputerTarget as ComputerTargetValue,
  type InteractionError,
} from "@opengeni/contracts";
import {
  InteractionControllerError,
  InteractionDefiniteDriverError,
  type ComputerInteractionDriver,
} from "@opengeni/interaction";
import {
  LatestComputerFrameSubscription,
  normalizeComputerFrameStreamOptions,
  sameComputerFrameOptions,
  type ComputerFrameStreamOptions,
  type ComputerFrameSubscription,
  type ComputerImageFrame,
  type NormalizedComputerFrameStreamOptions,
} from "./computer-media";
import {
  NativeComputerError,
  type NativeComputerActionCommand,
  type NativeComputerCaptureOptions,
  type NativeComputerFrame,
  type NativeComputerObservation,
  type NativeComputerTarget,
  type ComputerNativeTransport,
} from "./computer-native-client";

const MAX_FRAME_SUBSCRIBERS_PER_TARGET = 32;
const FRAME_INTERVAL_MS = 100;

type TargetFrameStream = {
  options: NormalizedComputerFrameStreamOptions;
  subscriptions: Map<string, LatestComputerFrameSubscription>;
  sequence: number;
  stopped: boolean;
  done: Promise<void> | null;
};

export type NativeComputerDriverOptions = {
  computerSessionId: string;
  controllerGeneration: string;
  client: ComputerNativeTransport;
  clientFactory?: (() => Promise<ComputerNativeTransport>) | undefined;
  now?: () => Date;
};

/** Provider-neutral Computer driver over one exact native-helper incarnation. */
export class NativeComputerDriver implements ComputerInteractionDriver {
  readonly platform: "linux" | "macos" | "windows";
  readonly adapterId: string;
  readonly capabilities: ComputerSessionCapabilities;
  private readonly computerSessionId: string;
  private readonly controllerGeneration: string;
  private client: ComputerNativeTransport;
  private readonly clientFactory: (() => Promise<ComputerNativeTransport>) | undefined;
  private recovery: Promise<ComputerNativeTransport> | null = null;
  private readonly now: () => Date;
  private readonly frameStreams = new Map<string, TargetFrameStream>();
  private closed = false;

  constructor(options: NativeComputerDriverOptions) {
    this.computerSessionId = options.computerSessionId;
    this.controllerGeneration = options.controllerGeneration;
    this.client = options.client;
    this.clientFactory = options.clientFactory;
    this.now = options.now ?? (() => new Date());
    this.platform = options.client.handshake.platform;
    this.adapterId = `opengeni.native.${this.platform}.v1`;
    this.capabilities = options.client.handshake.capabilities;
  }

  async listTargets(): Promise<ComputerTargetValue[]> {
    this.assertOpen();
    try {
      return (await this.readWithRecovery(async (client) => await client.targets())).map((target) =>
        this.projectTarget(target),
      );
    } catch (error) {
      throw predispatchError(error);
    }
  }

  async target(targetId: string): Promise<ComputerTargetValue | null> {
    return (await this.listTargets()).find((target) => target.id === targetId) ?? null;
  }

  async observe(targetId: string): Promise<ComputerObservationValue> {
    this.assertOpen();
    try {
      return this.projectObservation(
        await this.readWithRecovery(async (client) => await client.observe(targetId)),
      );
    } catch (error) {
      throw predispatchError(error);
    }
  }

  async validate(command: ComputerActionCommand): Promise<void> {
    this.assertOpen();
    try {
      await (await this.activeClient()).validate(nativeCommand(command));
    } catch (error) {
      throw predispatchError(error);
    }
  }

  async dispatch(command: ComputerActionCommand): Promise<ComputerObservationValue | null> {
    this.assertOpen();
    try {
      const observation = await (await this.activeClient()).dispatch(nativeCommand(command));
      return observation === null ? null : this.projectObservation(observation);
    } catch (error) {
      if (error instanceof NativeComputerError && !error.dispatched) {
        throw new InteractionDefiniteDriverError(
          interactionErrorCode(error.code),
          error.message,
          error.retryable,
        );
      }
      throw error;
    }
  }

  async capture(targetId: string): Promise<ComputerImageFrame> {
    this.assertOpen();
    try {
      return this.projectFrame(
        await this.readWithRecovery(async (client) => await client.capture(targetId)),
        0,
      );
    } catch (error) {
      throw predispatchError(error);
    }
  }

  async clipboard(): Promise<ComputerClipboardValue> {
    this.assertOpen();
    try {
      return ComputerClipboard.parse({
        computerSessionId: this.computerSessionId,
        controllerGeneration: this.controllerGeneration,
        ...(await this.readWithRecovery(async (client) => await client.clipboard())),
        observedAt: this.now().toISOString(),
      });
    } catch (error) {
      throw predispatchError(error);
    }
  }

  async subscribeFrames(
    targetId: string,
    options: ComputerFrameStreamOptions = {},
  ): Promise<ComputerFrameSubscription> {
    this.assertOpen();
    const normalized = normalizeComputerFrameStreamOptions(options);
    let stream = this.frameStreams.get(targetId);
    if (stream?.stopped) {
      await stream.done;
      stream = this.frameStreams.get(targetId);
    }
    let created = false;
    if (stream && !sameComputerFrameOptions(stream.options, normalized)) {
      throw new InteractionControllerError(
        "operation_conflict",
        "computer target already has a differently configured frame stream",
      );
    }
    if (!stream) {
      stream = {
        options: normalized,
        subscriptions: new Map(),
        sequence: 0,
        stopped: false,
        done: null,
      };
      this.frameStreams.set(targetId, stream);
      created = true;
    }
    if (stream.subscriptions.size >= MAX_FRAME_SUBSCRIBERS_PER_TARGET) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "computer target frame-subscriber bound was reached",
        true,
      );
    }
    const subscriptionId = randomUUID();
    const subscription = new LatestComputerFrameSubscription(async () => {
      this.releaseFrameSubscription(targetId, subscriptionId);
    });
    stream.subscriptions.set(subscriptionId, subscription);
    if (created) stream.done = this.runFrameStream(targetId, stream);
    return subscription;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const streams = [...this.frameStreams.values()];
    const subscriptions = streams.flatMap((stream) => {
      stream.stopped = true;
      return [...stream.subscriptions.values()];
    });
    this.frameStreams.clear();
    await Promise.allSettled(subscriptions.map(async (subscription) => await subscription.close()));
    // Let each producer observe `stopped` and send its explicit StopCapture
    // request before closing the native RPC pipe. Otherwise the helper retains
    // ScreenCaptureKit streams during EOF teardown, forcing the client through
    // its kill timeout and making an ordinary ComputerSession end exceed the
    // placement gateway deadline.
    await Promise.allSettled(
      streams.map(async (stream) => {
        if (stream.done) await stream.done;
      }),
    );
    await this.recovery?.catch(() => undefined);
    await this.client.close();
  }

  private projectTarget(target: NativeComputerTarget): ComputerTargetValue {
    return ComputerTarget.parse({
      ...target,
      computerSessionId: this.computerSessionId,
      controllerGeneration: this.controllerGeneration,
    });
  }

  private projectObservation(observation: NativeComputerObservation): ComputerObservationValue {
    return ComputerObservation.parse({
      protocolVersion: 1,
      observationId: observation.observationId,
      computerSessionId: this.computerSessionId,
      target: this.projectTarget(observation.target),
      frameId: observation.frameId,
      semantic: this.capabilities.semanticObservation
        ? { kind: "snapshot", roots: observation.roots, nodeCount: observation.nodeCount }
        : null,
      screenshot: null,
      focusedRef: observation.focusedRef,
      changedRegions: observation.changedRegions,
      observedAt: this.now().toISOString(),
    });
  }

  private async runFrameStream(targetId: string, stream: TargetFrameStream): Promise<void> {
    const captureOptions: NativeComputerCaptureOptions = {
      format: stream.options.format,
      quality: stream.options.quality,
      maxWidth: stream.options.maxWidth,
      maxHeight: stream.options.maxHeight,
    };
    let recoveryAttempted = false;
    try {
      while (!this.closed && !stream.stopped && stream.subscriptions.size > 0) {
        const client = await this.activeClient();
        let started = false;
        try {
          await client.startCapture(targetId, captureOptions);
          started = true;
          while (!this.closed && !stream.stopped && stream.subscriptions.size > 0) {
            const native = await client.capture(targetId, captureOptions);
            stream.sequence += 1;
            if (
              native.width > stream.options.maxWidth ||
              native.height > stream.options.maxHeight
            ) {
              throw new InteractionControllerError(
                "driver_failed",
                "native frame did not honor the requested stream dimensions",
              );
            }
            const sequenced = this.projectFrame(native, stream.sequence);
            for (const subscription of stream.subscriptions.values()) subscription.push(sequenced);
            await delay(FRAME_INTERVAL_MS * stream.options.everyNthFrame);
          }
          return;
        } catch (error) {
          if (
            !recoveryAttempted &&
            !this.closed &&
            !stream.stopped &&
            stream.subscriptions.size > 0 &&
            recoverableNativeFailure(error)
          ) {
            recoveryAttempted = true;
            await this.recoverClient(client);
            continue;
          }
          throw error;
        } finally {
          if (started) {
            try {
              await client.stopCapture(targetId);
            } catch {
              // Closing/replacing the helper is an equivalent teardown fence.
            }
          }
        }
      }
    } catch (error) {
      stream.stopped = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const subscription of stream.subscriptions.values()) subscription.fail(failure);
    } finally {
      stream.stopped = true;
      if (this.frameStreams.get(targetId) === stream) this.frameStreams.delete(targetId);
    }
  }

  private releaseFrameSubscription(targetId: string, subscriptionId: string): void {
    const stream = this.frameStreams.get(targetId);
    if (!stream) return;
    stream.subscriptions.delete(subscriptionId);
    if (stream.subscriptions.size === 0) stream.stopped = true;
  }

  private projectFrame(frame: NativeComputerFrame, sequence: number): ComputerImageFrame {
    return {
      frameId: frame.frameId,
      computerSessionId: this.computerSessionId,
      controllerGeneration: this.controllerGeneration,
      targetId: frame.targetId,
      targetGeneration: frame.targetGeneration,
      sequence,
      mediaType: frame.mimeType,
      width: frame.width,
      height: frame.height,
      data: frame.data,
      capturedAt: this.now().toISOString(),
    };
  }

  private assertOpen(): void {
    if (this.closed)
      throw new InteractionControllerError("controller_lost", "computer driver closed");
  }

  private async activeClient(): Promise<ComputerNativeTransport> {
    if (this.recovery) await this.recovery;
    this.assertOpen();
    return this.client;
  }

  private async readWithRecovery<T>(
    operation: (client: ComputerNativeTransport) => Promise<T>,
  ): Promise<T> {
    const client = await this.activeClient();
    try {
      return await operation(client);
    } catch (error) {
      // Typed adapter failures describe the OS operation and leave the helper
      // healthy. Everything else is a helper transport/protocol failure. Reads
      // are side-effect-free, so replace the poisoned process once and retry.
      if (error instanceof NativeComputerError) throw error;
      const replacement = await this.recoverClient(client);
      return await operation(replacement);
    }
  }

  private async recoverClient(
    failedClient: ComputerNativeTransport,
  ): Promise<ComputerNativeTransport> {
    if (this.client !== failedClient) return await this.activeClient();
    if (this.recovery) return await this.recovery;
    if (!this.clientFactory) {
      throw new Error("native computer helper recovery is unavailable");
    }
    const recovery = (async () => {
      await failedClient.close().catch(() => undefined);
      const replacement = await this.clientFactory!();
      if (
        replacement.handshake.platform !== this.platform ||
        replacement.handshake.protocolVersion !== failedClient.handshake.protocolVersion
      ) {
        await replacement.close().catch(() => undefined);
        throw new Error("replacement native computer helper is incompatible");
      }
      if (this.closed) {
        await replacement.close().catch(() => undefined);
        throw new Error("computer driver closed during native helper recovery");
      }
      this.client = replacement;
      return replacement;
    })();
    this.recovery = recovery;
    try {
      return await recovery;
    } finally {
      if (this.recovery === recovery) this.recovery = null;
    }
  }
}

function recoverableNativeFailure(error: unknown): boolean {
  if (!(error instanceof NativeComputerError)) return false;
  return (
    error.retryable &&
    (error.code === "timeout" || error.code === "driver_failed" || error.code === "unavailable")
  );
}

function nativeCommand(command: ComputerActionCommand): NativeComputerActionCommand {
  return {
    targetId: command.targetId,
    expectedTargetGeneration: command.expectedTargetGeneration,
    expectedObservationId: command.expectedObservationId,
    expectedFrameId: command.expectedFrameId,
    action: command.action,
  };
}

function predispatchError(error: unknown): Error {
  if (!(error instanceof NativeComputerError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new InteractionControllerError(
    interactionErrorCode(error.code),
    error.message,
    error.retryable,
  );
}

function interactionErrorCode(code: NativeComputerError["code"]): InteractionError["code"] {
  if (code === "unavailable") return "resource_unavailable";
  return code;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
