import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ComputerActionCommand,
  ComputerActionReceipt,
  ComputerObservation,
  ComputerSessionCapabilities,
  ComputerTarget,
} from "@opengeni/contracts";
import {
  ComputerInteractionController,
  InteractionControllerError,
  type ComputerInteractionAuthority,
  type ComputerInteractionDriver,
} from "@opengeni/interaction";
import { NativeComputerDriver } from "./computer-driver";
import {
  ExistingComputerEnvironmentAllocator,
  type ComputerEnvironmentAllocator,
  type ComputerEnvironmentLease,
} from "./computer-environment";
import { SqliteComputerOperationJournal } from "./computer-journal";
import type {
  ComputerFrameStreamOptions,
  ComputerFrameSubscription,
  ComputerImageFrame,
} from "./computer-media";
import { ComputerNativeClient } from "./computer-native-client";

const DEFAULT_MAX_SESSIONS = 64;

export type ComputerSessionReference = {
  computerSessionId: string;
  controllerGeneration: string;
};

export type ComputerSupervisorSessionOptions = ComputerSessionReference & {
  authority?: ComputerInteractionAuthority;
};

export type ComputerSupervisorSession = ComputerSessionReference & {
  platform: "linux" | "macos" | "windows";
  adapter: string;
  seatId: string;
  displayId: string;
  capabilities: ComputerSessionCapabilities;
  targets: ComputerTarget[];
};

export type ComputerSupervisorDriver = ComputerInteractionDriver & {
  readonly platform: "linux" | "macos" | "windows";
  readonly adapterId: string;
  readonly capabilities: ComputerSessionCapabilities;
  listTargets(): Promise<ComputerTarget[]>;
  capture(targetId: string): Promise<ComputerImageFrame>;
  subscribeFrames(
    targetId: string,
    options?: ComputerFrameStreamOptions,
  ): Promise<ComputerFrameSubscription>;
  close(): Promise<void>;
};

export type ComputerSupervisorDriverContext = ComputerSessionReference & {
  sessionDirectory: string;
  seatId: string;
  displayId: string;
  environment: NodeJS.ProcessEnv;
};

export type ComputerSupervisorOptions = {
  rootDirectory: string;
  nativeBinaryPath?: string;
  maxSessions?: number;
  environmentAllocator?: ComputerEnvironmentAllocator;
  baseEnvironment?: NodeJS.ProcessEnv;
  createDriver?: (context: ComputerSupervisorDriverContext) => Promise<ComputerSupervisorDriver>;
};

type ValidatedSessionOptions = ComputerSupervisorSessionOptions;

type Runtime = {
  options: ValidatedSessionOptions;
  sessionDirectory: string;
  environmentLease: ComputerEnvironmentLease;
  journal: SqliteComputerOperationJournal;
  driver: ComputerSupervisorDriver;
  controller: ComputerInteractionController;
  lifecycle: "active" | "ending";
};

/** Computer half of the one placement-local interaction authority. */
export class ComputerSupervisor {
  readonly rootDirectory: string;
  private readonly maxSessions: number;
  private readonly createDriver: (
    context: ComputerSupervisorDriverContext,
  ) => Promise<ComputerSupervisorDriver>;
  private readonly environmentAllocator: ComputerEnvironmentAllocator;
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, Runtime>();
  private readonly creating = new Map<string, Promise<Runtime>>();
  private readonly ending = new Map<string, Promise<void>>();
  private closed = false;

  private constructor(options: ComputerSupervisorOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.maxSessions = boundedPositiveInteger(
      options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      "maxSessions",
    );
    this.environmentAllocator =
      options.environmentAllocator ?? new ExistingComputerEnvironmentAllocator();
    this.baseEnvironment = { ...(options.baseEnvironment ?? process.env) };
    this.createDriver =
      options.createDriver ??
      (async (context) => {
        if (!options.nativeBinaryPath) {
          throw new Error("nativeBinaryPath is required for native ComputerSessions");
        }
        const client = await ComputerNativeClient.open({
          binaryPath: resolve(options.nativeBinaryPath),
          env: context.environment,
          cwd: context.sessionDirectory,
        });
        return new NativeComputerDriver({
          computerSessionId: context.computerSessionId,
          controllerGeneration: context.controllerGeneration,
          client,
        });
      });
  }

  static async open(options: ComputerSupervisorOptions): Promise<ComputerSupervisor> {
    const supervisor = new ComputerSupervisor(options);
    await mkdir(join(supervisor.rootDirectory, "computer-sessions"), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(supervisor.rootDirectory, 0o700);
    return supervisor;
  }

  async createSession(
    optionsInput: ComputerSupervisorSessionOptions,
  ): Promise<ComputerSupervisorSession> {
    this.assertOpen();
    const options = validateSessionOptions(optionsInput);
    const active = this.sessions.get(options.computerSessionId);
    if (active) {
      this.assertSameBinding(active, options);
      return await this.describe(active);
    }
    const pending = this.creating.get(options.computerSessionId);
    if (pending) {
      const runtime = await pending;
      this.assertSameBinding(runtime, options);
      return await this.describe(runtime);
    }
    if (this.sessions.size + this.creating.size >= this.maxSessions) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "computer supervisor session capacity is exhausted",
        true,
      );
    }
    const creation = this.buildRuntime(options);
    this.creating.set(options.computerSessionId, creation);
    try {
      const runtime = await creation;
      if (this.closed) {
        await this.disposeRuntime(runtime, false);
        throw new InteractionControllerError(
          "resource_unavailable",
          "computer supervisor is closed",
        );
      }
      this.sessions.set(options.computerSessionId, runtime);
      return await this.describe(runtime);
    } finally {
      if (this.creating.get(options.computerSessionId) === creation) {
        this.creating.delete(options.computerSessionId);
      }
    }
  }

  listSessions(): Array<
    ComputerSessionReference & {
      platform: "linux" | "macos" | "windows";
      adapter: string;
      seatId: string;
      displayId: string;
      capabilities: ComputerSessionCapabilities;
    }
  > {
    return [...this.sessions.values()]
      .filter((runtime) => runtime.lifecycle === "active")
      .map((runtime) => ({
        ...binding(runtime),
        platform: runtime.driver.platform,
        adapter: runtime.driver.adapterId,
        seatId: runtime.environmentLease.seatId,
        displayId: runtime.environmentLease.displayId,
        capabilities: runtime.driver.capabilities,
      }));
  }

  async listTargets(reference: ComputerSessionReference): Promise<ComputerTarget[]> {
    return await this.requireActive(reference).driver.listTargets();
  }

  /** A copy of the already-allocated graphical environment for an exact
   * same-placement process. The lease remains owned by this ComputerSession. */
  launchEnvironment(reference: ComputerSessionReference): NodeJS.ProcessEnv {
    return { ...this.requireActive(reference).environmentLease.environment };
  }

  async observe(
    reference: ComputerSessionReference,
    targetId: string,
  ): Promise<ComputerObservation> {
    return await this.requireActive(reference).controller.observe(targetId);
  }

  action(command: ComputerActionCommand): Promise<ComputerActionReceipt> {
    return this.requireActive({
      computerSessionId: command.computerSessionId,
      controllerGeneration: command.controllerGeneration,
    }).controller.run(command);
  }

  receipt(reference: ComputerSessionReference, operationId: string): ComputerActionReceipt | null {
    return this.requireBound(reference).controller.receipt(operationId);
  }

  async capture(
    reference: ComputerSessionReference,
    targetId: string,
  ): Promise<ComputerImageFrame> {
    return await this.requireActive(reference).driver.capture(targetId);
  }

  async subscribeFrames(
    reference: ComputerSessionReference,
    targetId: string,
    options?: ComputerFrameStreamOptions,
  ): Promise<ComputerFrameSubscription> {
    return await this.requireActive(reference).driver.subscribeFrames(targetId, options);
  }

  async heartbeat(reference: ComputerSessionReference): Promise<void> {
    await this.requireActive(reference).driver.listTargets();
  }

  async endSession(
    reference: ComputerSessionReference,
    options: { removeState?: boolean } = {},
  ): Promise<void> {
    const pending = this.creating.get(reference.computerSessionId);
    if (pending) await pending;
    const runtime = this.requireBound(reference);
    const existing = this.ending.get(reference.computerSessionId);
    if (existing) return await existing;
    runtime.lifecycle = "ending";
    const ending = this.disposeRuntime(runtime, options.removeState ?? false);
    this.ending.set(reference.computerSessionId, ending);
    try {
      await ending;
      this.sessions.delete(reference.computerSessionId);
    } finally {
      if (this.ending.get(reference.computerSessionId) === ending) {
        this.ending.delete(reference.computerSessionId);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.creating.values()]);
    const results = await Promise.allSettled(
      [...this.sessions.values()].map(async (runtime) => await this.endSession(binding(runtime))),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "computer supervisor shutdown failed");
    }
  }

  private async buildRuntime(options: ValidatedSessionOptions): Promise<Runtime> {
    const sessionDirectory = join(
      this.rootDirectory,
      "computer-sessions",
      options.computerSessionId,
    );
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionDirectory, 0o700);
    const journal = await SqliteComputerOperationJournal.open({
      path: join(sessionDirectory, "operations.sqlite"),
      computerSessionId: options.computerSessionId,
      controllerGeneration: options.controllerGeneration,
    });
    let environmentLease: ComputerEnvironmentLease | null = null;
    let driver: ComputerSupervisorDriver | null = null;
    try {
      const initialJournal = journal.loadAndRecover();
      environmentLease = await this.environmentAllocator.allocate({
        computerSessionId: options.computerSessionId,
        controllerGeneration: options.controllerGeneration,
        sessionDirectory,
        baseEnvironment: this.baseEnvironment,
      });
      const seatId = boundedOpaque(environmentLease.seatId, "allocated seatId");
      const displayId = boundedOpaque(environmentLease.displayId, "allocated displayId");
      const environment = validateEnvironment(environmentLease.environment);
      driver = await this.createDriver({
        computerSessionId: options.computerSessionId,
        controllerGeneration: options.controllerGeneration,
        sessionDirectory,
        seatId,
        displayId,
        environment,
      });
      let runtime: Runtime | undefined;
      const controller = new ComputerInteractionController({
        computerSessionId: options.computerSessionId,
        controllerGeneration: options.controllerGeneration,
        driver,
        initialJournal,
        onJournalRecord: (record) => journal.write(record),
        authority: {
          authorizeDispatch: async (command) => {
            if (runtime?.lifecycle !== "active") {
              throw new InteractionControllerError(
                "resource_unavailable",
                "computer session is changing state",
                true,
              );
            }
            await runtime.options.authority?.authorizeDispatch(command);
          },
        },
      });
      runtime = {
        options,
        sessionDirectory,
        environmentLease,
        journal,
        driver,
        controller,
        lifecycle: "active",
      };
      await driver.listTargets();
      return runtime;
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await driver?.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        await environmentLease?.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        journal.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        await rm(sessionDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        const cleanupFailure = new Error("computer runtime creation cleanup failed", {
          cause: error,
        });
        Object.defineProperty(cleanupFailure, "errors", { value: failures });
        throw cleanupFailure;
      }
      throw error;
    }
  }

  private async describe(runtime: Runtime): Promise<ComputerSupervisorSession> {
    return {
      ...binding(runtime),
      platform: runtime.driver.platform,
      adapter: runtime.driver.adapterId,
      seatId: runtime.environmentLease.seatId,
      displayId: runtime.environmentLease.displayId,
      capabilities: runtime.driver.capabilities,
      targets: await runtime.driver.listTargets(),
    };
  }

  private assertSameBinding(runtime: Runtime, requested: ValidatedSessionOptions): void {
    if (runtime.options.controllerGeneration !== requested.controllerGeneration) {
      throw new InteractionControllerError(
        "controller_stale",
        "computer session is already owned by another controller generation",
      );
    }
  }

  private requireActive(reference: ComputerSessionReference): Runtime {
    const runtime = this.requireBound(reference);
    if (runtime.lifecycle !== "active") {
      throw new InteractionControllerError("resource_unavailable", "computer session is ending");
    }
    return runtime;
  }

  private requireBound(reference: ComputerSessionReference): Runtime {
    const runtime = this.sessions.get(reference.computerSessionId);
    if (!runtime) {
      throw new InteractionControllerError("resource_not_found", "computer session is not active");
    }
    if (runtime.options.controllerGeneration !== reference.controllerGeneration) {
      throw new InteractionControllerError(
        "controller_stale",
        "computer request targets a stale controller generation",
      );
    }
    return runtime;
  }

  private async disposeRuntime(runtime: Runtime, removeState: boolean): Promise<void> {
    const failures: unknown[] = [];
    let driverClosed = false;
    let environmentClosed = false;
    let journalClosed = false;
    try {
      await runtime.driver.close();
      driverClosed = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      await runtime.environmentLease.close();
      environmentClosed = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      runtime.journal.close();
      journalClosed = true;
    } catch (error) {
      failures.push(error);
    }
    if (removeState && driverClosed && environmentClosed && journalClosed) {
      try {
        await rm(runtime.sessionDirectory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "computer session cleanup did not complete cleanly");
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new InteractionControllerError("resource_unavailable", "computer supervisor is closed");
    }
  }
}

function binding(runtime: Runtime): ComputerSessionReference {
  return {
    computerSessionId: runtime.options.computerSessionId,
    controllerGeneration: runtime.options.controllerGeneration,
  };
}

function validateSessionOptions(
  options: ComputerSupervisorSessionOptions,
): ValidatedSessionOptions {
  if (!isUuid(options.computerSessionId)) throw new Error("computerSessionId must be a UUID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(options.controllerGeneration)) {
    throw new Error("controllerGeneration is invalid");
  }
  return {
    computerSessionId: options.computerSessionId,
    controllerGeneration: options.controllerGeneration,
    ...(options.authority ? { authority: options.authority } : {}),
  };
}

function validateEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value === undefined) continue;
    if (Buffer.byteLength(value) > 16 * 1024 || value.includes("\0")) {
      throw new Error(`computer environment value ${name} is invalid`);
    }
    environment[name] = value;
  }
  return environment;
}

function boundedOpaque(value: string, label: string): string {
  if (!/^[^\u0000-\u001f\u007f]{1,512}$/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
