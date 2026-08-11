import { randomUUID } from "node:crypto";
import {
  ComputerObservation,
  ComputerTarget,
  type ComputerActionCommand,
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
};

export type NativeComputerDriverOptions = {
  computerSessionId: string;
  controllerGeneration: string;
  client: ComputerNativeTransport;
  now?: () => Date;
};

/** Provider-neutral Computer driver over one exact native-helper incarnation. */
export class NativeComputerDriver implements ComputerInteractionDriver {
  readonly platform: "linux" | "macos" | "windows";
  readonly adapterId: string;
  readonly capabilities: ComputerSessionCapabilities;
  private readonly computerSessionId: string;
  private readonly controllerGeneration: string;
  private readonly client: ComputerNativeTransport;
  private readonly now: () => Date;
  private readonly frameStreams = new Map<string, TargetFrameStream>();
  private closed = false;

  constructor(options: NativeComputerDriverOptions) {
    this.computerSessionId = options.computerSessionId;
    this.controllerGeneration = options.controllerGeneration;
    this.client = options.client;
    this.now = options.now ?? (() => new Date());
    this.platform = options.client.handshake.platform;
    this.adapterId = `opengeni.native.${this.platform}.v1`;
    this.capabilities = options.client.handshake.capabilities;
  }

  async listTargets(): Promise<ComputerTargetValue[]> {
    this.assertOpen();
    return (await this.client.targets()).map((target) => this.projectTarget(target));
  }

  async target(targetId: string): Promise<ComputerTargetValue | null> {
    return (await this.listTargets()).find((target) => target.id === targetId) ?? null;
  }

  async observe(targetId: string): Promise<ComputerObservationValue> {
    this.assertOpen();
    try {
      return this.projectObservation(await this.client.observe(targetId));
    } catch (error) {
      throw predispatchError(error);
    }
  }

  async validate(command: ComputerActionCommand): Promise<void> {
    this.assertOpen();
    try {
      await this.client.validate(nativeCommand(command));
    } catch (error) {
      throw predispatchError(error);
    }
  }

  async dispatch(command: ComputerActionCommand): Promise<ComputerObservationValue> {
    this.assertOpen();
    try {
      return this.projectObservation(await this.client.dispatch(nativeCommand(command)));
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
      const frame = await this.client.capture(targetId);
      return {
        frameId: frame.frameId,
        computerSessionId: this.computerSessionId,
        controllerGeneration: this.controllerGeneration,
        targetId: frame.targetId,
        targetGeneration: frame.targetGeneration,
        sequence: 0,
        mediaType: frame.mimeType,
        width: frame.width,
        height: frame.height,
        data: frame.data,
        capturedAt: this.now().toISOString(),
      };
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
    if (normalized.format !== "png") {
      throw new InteractionControllerError(
        "unsupported",
        "native computer frames currently use lossless PNG",
      );
    }
    let stream = this.frameStreams.get(targetId);
    let created = false;
    if (stream && !sameComputerFrameOptions(stream.options, normalized)) {
      throw new InteractionControllerError(
        "operation_conflict",
        "computer target already has a differently configured frame stream",
      );
    }
    if (!stream) {
      stream = { options: normalized, subscriptions: new Map(), sequence: 0, stopped: false };
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
    if (created) void this.runFrameStream(targetId, stream);
    return subscription;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const subscriptions = [...this.frameStreams.values()].flatMap((stream) => {
      stream.stopped = true;
      return [...stream.subscriptions.values()];
    });
    this.frameStreams.clear();
    await Promise.allSettled(subscriptions.map(async (subscription) => await subscription.close()));
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
    try {
      while (!this.closed && !stream.stopped && stream.subscriptions.size > 0) {
        const frame = await this.capture(targetId);
        stream.sequence += 1;
        if (frame.width > stream.options.maxWidth || frame.height > stream.options.maxHeight) {
          throw new InteractionControllerError(
            "unsupported",
            "native frame exceeds the requested stream dimensions",
          );
        }
        if (stream.sequence % stream.options.everyNthFrame === 0) {
          const sequenced = { ...frame, sequence: stream.sequence };
          for (const subscription of stream.subscriptions.values()) subscription.push(sequenced);
        }
        await delay(FRAME_INTERVAL_MS);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const subscription of stream.subscriptions.values()) subscription.fail(failure);
    } finally {
      if (this.frameStreams.get(targetId) === stream) this.frameStreams.delete(targetId);
      stream.stopped = true;
    }
  }

  private releaseFrameSubscription(targetId: string, subscriptionId: string): void {
    const stream = this.frameStreams.get(targetId);
    if (!stream) return;
    stream.subscriptions.delete(subscriptionId);
    if (stream.subscriptions.size === 0) stream.stopped = true;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new InteractionControllerError("controller_lost", "computer driver closed");
  }
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
