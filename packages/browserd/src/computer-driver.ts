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
  InteractionOutcomeUnknownDriverError,
  type ComputerInteractionDriver,
} from "@opengeni/interaction";
import {
  LatestComputerFrameSubscription,
  computerFrameStreamProfileKey,
  normalizeComputerFrameStreamOptions,
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

const MAX_FRAME_PROFILES_PER_TARGET = 8;
const MAX_FRAME_SUBSCRIBERS_PER_TARGET = 32;
const FRAME_INTERVAL_MS = 100;

type TargetFrameProfile = {
  key: string;
  options: NormalizedComputerFrameStreamOptions;
  subscriptions: Map<string, LatestComputerFrameSubscription>;
  sequence: number;
  stopped: boolean;
  done: Promise<void> | null;
};

type TargetFrameGroup = {
  profiles: Map<string, TargetFrameProfile>;
  sourceClient: ComputerNativeTransport | null;
  sourceKey: string | null;
  sourceTransition: Promise<void>;
  stopping: boolean;
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
  private readonly frameStreams = new Map<string, TargetFrameGroup>();
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
      const observation = await this.readWithRecovery(async (client) => {
        const observed = await client.observe(targetId);
        if (observed.frameId !== null || observed.target.kind === "app") return observed;
        const capturable =
          observed.target.kind === "screen"
            ? this.capabilities.screenCapture
            : this.capabilities.windowCapture;
        if (!capturable) return observed;

        // Native observations intentionally reference the latest exact capture.
        // A target that has not yet been viewed therefore has no frame fence,
        // making its first pointer action impossible. Prime one frame only for
        // that cold path; an active viewer already keeps frameId populated and
        // pays no additional capture cost.
        const frame = await client.capture(targetId);
        if (
          frame.targetId !== observed.target.id ||
          frame.targetGeneration !== observed.target.targetGeneration
        ) {
          throw new InteractionControllerError(
            "target_stale",
            "computer target changed while establishing its frame fence",
            true,
          );
        }
        return { ...observed, frameId: frame.frameId };
      });
      return this.projectObservation(observation);
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
      if (error instanceof NativeComputerError) {
        const code = interactionErrorCode(error.code);
        if (!error.dispatched) {
          throw new InteractionDefiniteDriverError(code, error.message, error.retryable);
        }
        throw new InteractionOutcomeUnknownDriverError(code, error.message, false);
      }
      throw error;
    }
  }

  async capture(
    targetId: string,
    options: ComputerFrameStreamOptions = {},
  ): Promise<ComputerImageFrame> {
    this.assertOpen();
    const normalized = normalizeComputerFrameStreamOptions(options);
    try {
      return this.projectFrame(
        await this.readWithRecovery(
          async (client) =>
            await client.capture(targetId, {
              format: normalized.format,
              quality: normalized.quality,
              maxWidth: normalized.maxWidth,
              maxHeight: normalized.maxHeight,
            }),
        ),
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
    let group = this.frameStreams.get(targetId);
    while (group?.stopping) {
      await group.done;
      group = this.frameStreams.get(targetId);
    }
    if (!group) {
      group = {
        profiles: new Map(),
        sourceClient: null,
        sourceKey: null,
        sourceTransition: Promise.resolve(),
        stopping: false,
        done: null,
      };
      this.frameStreams.set(targetId, group);
    }
    const key = computerFrameStreamProfileKey(normalized);
    let profile = group.profiles.get(key);
    if (profile?.stopped) {
      await profile.done;
      profile = group.profiles.get(key);
    }
    let created = false;
    if (!profile) {
      if (group.profiles.size >= MAX_FRAME_PROFILES_PER_TARGET) {
        throw new InteractionControllerError(
          "resource_unavailable",
          "computer target frame-profile bound was reached",
          true,
        );
      }
      profile = {
        key,
        options: normalized,
        subscriptions: new Map(),
        sequence: 0,
        stopped: false,
        done: null,
      };
      group.profiles.set(key, profile);
      created = true;
    }
    const subscriptionCount = [...group.profiles.values()].reduce(
      (sum, candidate) => sum + candidate.subscriptions.size,
      0,
    );
    if (subscriptionCount >= MAX_FRAME_SUBSCRIBERS_PER_TARGET) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "computer target frame-subscriber bound was reached",
        true,
      );
    }
    const subscriptionId = randomUUID();
    const subscription = new LatestComputerFrameSubscription(async () => {
      this.releaseFrameSubscription(targetId, key, subscriptionId);
    });
    profile.subscriptions.set(subscriptionId, subscription);
    if (created) profile.done = this.runFrameStream(targetId, group, profile);
    return subscription;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const groups = [...this.frameStreams.entries()];
    const profiles = groups.flatMap(([, group]) => [...group.profiles.values()]);
    const subscriptions = profiles.flatMap((profile) => {
      profile.stopped = true;
      return [...profile.subscriptions.values()];
    });
    await Promise.allSettled(subscriptions.map(async (subscription) => await subscription.close()));
    // Let each producer observe `stopped` and send its explicit StopCapture
    // request before closing the native RPC pipe. Otherwise the helper retains
    // ScreenCaptureKit streams during EOF teardown, forcing the client through
    // its kill timeout and making an ordinary ComputerSession end exceed the
    // placement gateway deadline.
    await Promise.allSettled(
      profiles.map(async (profile) => {
        if (profile.done) await profile.done;
      }),
    );
    await Promise.allSettled(
      groups.map(async ([targetId, group]) => {
        if (!group.stopping) this.beginStopFrameGroup(targetId, group);
        if (group.done) await group.done;
      }),
    );
    this.frameStreams.clear();
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

  private async runFrameStream(
    targetId: string,
    group: TargetFrameGroup,
    profile: TargetFrameProfile,
  ): Promise<void> {
    const captureOptions: NativeComputerCaptureOptions = {
      format: profile.options.format,
      quality: profile.options.quality,
      maxWidth: profile.options.maxWidth,
      maxHeight: profile.options.maxHeight,
    };
    let recoveryAttempted = false;
    try {
      while (!this.closed && !profile.stopped && profile.subscriptions.size > 0) {
        let client = await this.activeClient();
        try {
          client = await this.ensureFrameSource(targetId, group);
          while (!this.closed && !profile.stopped && profile.subscriptions.size > 0) {
            const native = await client.capture(targetId, captureOptions);
            profile.sequence += 1;
            if (
              native.width > profile.options.maxWidth ||
              native.height > profile.options.maxHeight
            ) {
              throw new InteractionControllerError(
                "driver_failed",
                "native frame did not honor the requested stream dimensions",
              );
            }
            const sequenced = this.projectFrame(native, profile.sequence);
            for (const subscription of profile.subscriptions.values()) subscription.push(sequenced);
            await delay(FRAME_INTERVAL_MS * profile.options.everyNthFrame);
          }
          return;
        } catch (error) {
          if (
            !recoveryAttempted &&
            !this.closed &&
            !profile.stopped &&
            profile.subscriptions.size > 0 &&
            recoverableNativeFailure(error)
          ) {
            recoveryAttempted = true;
            await this.recoverClient(client);
            group.sourceClient = null;
            group.sourceKey = null;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      profile.stopped = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const subscription of profile.subscriptions.values()) subscription.fail(failure);
    } finally {
      profile.stopped = true;
      if (group.profiles.get(profile.key) === profile) group.profiles.delete(profile.key);
      if (group.profiles.size === 0 && this.frameStreams.get(targetId) === group) {
        this.beginStopFrameGroup(targetId, group);
      }
    }
  }

  private releaseFrameSubscription(
    targetId: string,
    profileKey: string,
    subscriptionId: string,
  ): void {
    const profile = this.frameStreams.get(targetId)?.profiles.get(profileKey);
    if (!profile) return;
    profile.subscriptions.delete(subscriptionId);
    if (profile.subscriptions.size === 0) profile.stopped = true;
  }

  private async ensureFrameSource(
    targetId: string,
    group: TargetFrameGroup,
  ): Promise<ComputerNativeTransport> {
    const transition = group.sourceTransition
      .catch(() => undefined)
      .then(async () => {
        this.assertOpen();
        if (group.stopping) throw new Error("computer frame source is stopping");
        const activeProfiles = [...group.profiles.values()].filter(
          (profile) => !profile.stopped && profile.subscriptions.size > 0,
        );
        if (activeProfiles.length === 0) throw new Error("computer frame source has no viewers");
        const client = await this.activeClient();
        const sourceOptions: NativeComputerCaptureOptions = {
          format: "png",
          quality: 100,
          maxWidth: Math.max(...activeProfiles.map((profile) => profile.options.maxWidth)),
          maxHeight: Math.max(...activeProfiles.map((profile) => profile.options.maxHeight)),
        };
        const sourceKey = [
          sourceOptions.format,
          sourceOptions.quality,
          sourceOptions.maxWidth,
          sourceOptions.maxHeight,
        ].join(":");
        if (group.sourceClient === client && group.sourceKey === sourceKey) return;
        await client.startCapture(targetId, sourceOptions);
        group.sourceClient = client;
        group.sourceKey = sourceKey;
      });
    group.sourceTransition = transition;
    await transition;
    if (!group.sourceClient) throw new Error("computer frame source did not start");
    return group.sourceClient;
  }

  private async stopCapturesOnClient(client: ComputerNativeTransport): Promise<void> {
    await Promise.allSettled(
      [...this.frameStreams.entries()].map(async ([targetId, group]) => {
        await group.sourceTransition.catch(() => undefined);
        if (group.sourceClient !== client) return;
        try {
          await client.stopCapture(targetId);
        } catch {
          // Closing/replacing the helper is the remaining teardown fence.
        }
        group.sourceClient = null;
        group.sourceKey = null;
      }),
    );
  }

  private beginStopFrameGroup(targetId: string, group: TargetFrameGroup): void {
    if (group.stopping) return;
    group.stopping = true;
    group.done = group.sourceTransition
      .catch(() => undefined)
      .then(async () => {
        if (group.sourceClient) {
          try {
            await group.sourceClient.stopCapture(targetId);
          } catch {
            // Closing/replacing the helper is an equivalent teardown fence.
          }
        }
      })
      .finally(() => {
        if (this.frameStreams.get(targetId) === group) this.frameStreams.delete(targetId);
      });
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
      // EOF/SIGKILL without StopCapture leaves ScreenCaptureKit streams in
      // replayd. Stop every live producer on this incarnation first.
      await this.stopCapturesOnClient(failedClient);
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
