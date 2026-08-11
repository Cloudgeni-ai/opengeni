import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  BrowserActionCommand,
  BrowserActionReceipt,
  BrowserDiagnosticBatch,
  BrowserDiagnosticKind,
  BrowserObservation,
  BrowserRevisionMaterialization,
  BrowserTarget,
} from "@opengeni/contracts";
import {
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  BrowserRevisionMaterialization as BrowserRevisionMaterializationSchema,
} from "@opengeni/contracts";
import {
  BrowserInteractionController,
  InteractionControllerError,
  type BrowserInteractionAuthority,
  type BrowserInteractionDriver,
} from "@opengeni/interaction";
import { createAttachedChromeTransport } from "./attached-cdp";
import { AgentBrowserDriver, type BrowserRuntimeSnapshot } from "./cdp-driver";
import type { ResolvedAgentBrowserBinary } from "./binary";
import {
  type BrowserFrameStreamOptions,
  type BrowserFrameSubscription,
  type BrowserImageFrame,
  type BrowserScreenshotOptions,
} from "./media";
import { AgentBrowserJsonRunner, browserProfileCryptoPolicy } from "./runner";
import { SqliteBrowserOperationJournal } from "./journal";
import {
  captureEncryptedBrowserProfile,
  restoreEncryptedBrowserProfile,
  type BrowserProfileManifest,
} from "./state-artifact";
import {
  BrowserStateDownloadError,
  downloadBrowserStateArtifact,
  validateDownloadAuthority,
  type BrowserStateDownloadAuthority,
} from "./state-download";
import {
  BrowserStateTransferConflictError,
  BrowserStateTransferOutcomeUnknownError,
  SqliteBrowserStateTransferJournal,
  type BrowserStateCaptureReceipt,
} from "./state-journal";
import {
  uploadBrowserStateArtifact,
  validateUploadAuthority,
  type BrowserStateUploadAuthority,
} from "./state-upload";

const DEFAULT_MAX_SESSIONS = 64;
const BROWSER_DRIVER_ID = "opengeni.cdp.v1";
const BROWSER_DRIVER_SCHEMA_VERSION = 1;
const MAX_STATE_AAD_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function aggregateFailure(
  errors: readonly unknown[],
  message: string,
  cause: unknown,
): AggregateError {
  return new AggregateError(errors, message, { cause });
}

export type BrowserSessionReference = {
  browserSessionId: string;
  controllerGeneration: string;
};

export type BrowserSupervisorSessionOptions = BrowserSessionReference & {
  initialUrl?: string;
  headed: boolean;
  browserExecutablePath?: string;
  authority?: BrowserInteractionAuthority;
  restore?: BrowserStateRestoreInput;
  transport?: BrowserSupervisorTransport;
  linkedComputer?: { computerSessionId: string; controllerGeneration: string };
  launchEnvironment?: NodeJS.ProcessEnv;
};

export type BrowserSupervisorTransport =
  | { kind: "managed" }
  | {
      kind: "attached_chrome";
      deviceId: string;
      connectionGeneration: string;
      browserName: string;
      browserVersion: string;
      authorityFile?: string;
    };

export type BrowserStateRestoreInput = {
  objectKey: string;
  format: typeof BROWSER_PROFILE_ARTIFACT_FORMAT;
  artifactDigest: string;
  contentDigest: string;
  manifestDigest: string;
  sizeBytes: number;
  dataKey: Uint8Array;
  aad: Uint8Array;
  materialization: BrowserRevisionMaterialization;
  download: BrowserStateDownloadAuthority;
};

export type BrowserSupervisorSession = BrowserSessionReference & {
  observation: BrowserObservation;
};

export type BrowserStateCaptureInput = BrowserSessionReference & {
  operationId: string;
  objectKey: string;
  afterCapture: "restart" | "stop";
  dataKey: Uint8Array;
  aad: Uint8Array;
  upload: BrowserStateUploadAuthority;
};

export type BrowserSupervisorDriver = BrowserInteractionDriver & {
  start(url?: string): Promise<BrowserObservation>;
  listTargets(): Promise<BrowserTarget[]>;
  openTarget(url?: string): Promise<BrowserObservation>;
  selectTarget(targetId: string): Promise<BrowserObservation>;
  closeTarget(targetId: string): Promise<BrowserTarget[]>;
  captureScreenshot(
    targetId: string,
    options?: BrowserScreenshotOptions,
  ): Promise<BrowserImageFrame>;
  subscribeFrames(
    targetId: string,
    options?: BrowserFrameStreamOptions,
  ): Promise<BrowserFrameSubscription>;
  debug(
    targetId: string,
    options?: {
      kinds?: readonly BrowserDiagnosticKind[];
      afterSequence?: number;
      limit?: number;
    },
  ): Promise<BrowserDiagnosticBatch>;
  runtimeSnapshot(): Promise<BrowserRuntimeSnapshot>;
  close(): Promise<void>;
};

export type BrowserSupervisorDriverContext = BrowserSessionReference & {
  sessionDirectory: string;
  socketDirectory: string;
  profileDirectory: string;
  downloadDirectory: string;
  screenshotDirectory: string;
  headed: boolean;
  transport: BrowserSupervisorTransport;
  browserExecutablePath?: string;
  launchEnvironment?: NodeJS.ProcessEnv;
};

export type BrowserSupervisorOptions = {
  rootDirectory: string;
  socketRootDirectory?: string;
  maxSessions?: number;
  agentBrowserBinary?: ResolvedAgentBrowserBinary;
  createDriver?: (context: BrowserSupervisorDriverContext) => Promise<BrowserSupervisorDriver>;
  uploadArtifact?: (artifactPath: string, authority: BrowserStateUploadAuthority) => Promise<void>;
};

type Runtime = {
  options: BrowserRuntimeOptions;
  sessionDirectory: string;
  driverContext: BrowserSupervisorDriverContext;
  journal: SqliteBrowserOperationJournal;
  stateJournal: SqliteBrowserStateTransferJournal;
  driver: BrowserSupervisorDriver;
  controller: BrowserInteractionController;
  lifecycle: "active" | "capturing" | "captured" | "ending";
};

type BrowserRuntimeOptions = Omit<
  BrowserSupervisorSessionOptions,
  "restore" | "transport" | "launchEnvironment"
> & {
  transport: BrowserSupervisorTransport;
  restoreAuthorityDigest: string | null;
};

type ValidatedBrowserStateRestoreInput = Omit<BrowserStateRestoreInput, "dataKey" | "aad"> & {
  dataKey: Buffer;
  aad: Buffer;
};

type ValidatedBrowserSupervisorSessionOptions = Omit<
  BrowserSupervisorSessionOptions,
  "restore" | "transport"
> & {
  transport: BrowserSupervisorTransport;
  restore?: ValidatedBrowserStateRestoreInput;
};

/** One placement-local authority hosting many independently fenced browser sessions. */
export class BrowserSupervisor {
  readonly rootDirectory: string;
  readonly socketRootDirectory: string;
  private readonly maxSessions: number;
  private readonly createDriver: (
    context: BrowserSupervisorDriverContext,
  ) => Promise<BrowserSupervisorDriver>;
  private readonly uploadArtifact: (
    artifactPath: string,
    authority: BrowserStateUploadAuthority,
  ) => Promise<void>;
  private readonly sessions = new Map<string, Runtime>();
  private readonly creating = new Map<string, Promise<Runtime>>();
  private readonly ending = new Map<string, Promise<void>>();
  private readonly stateTransferTails = new Map<string, Promise<void>>();
  private closed = false;

  private constructor(options: BrowserSupervisorOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.socketRootDirectory = resolve(
      options.socketRootDirectory ?? defaultSocketRoot(this.rootDirectory),
    );
    this.maxSessions = boundedPositiveInteger(
      options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      "maxSessions",
    );
    this.createDriver =
      options.createDriver ??
      (async (context) => await createBrowserDriver(context, options.agentBrowserBinary));
    this.uploadArtifact = options.uploadArtifact ?? uploadBrowserStateArtifact;
  }

  static async open(options: BrowserSupervisorOptions): Promise<BrowserSupervisor> {
    const supervisor = new BrowserSupervisor(options);
    await mkdir(join(supervisor.rootDirectory, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(supervisor.socketRootDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(supervisor.rootDirectory, 0o700);
    await chmod(supervisor.socketRootDirectory, 0o700);
    return supervisor;
  }

  async createSession(
    optionsInput: BrowserSupervisorSessionOptions,
  ): Promise<BrowserSupervisorSession> {
    this.assertOpen();
    const options = validateSessionOptions(optionsInput);
    try {
      const active = this.sessions.get(options.browserSessionId);
      if (active) {
        this.assertSameBinding(active, options);
        return {
          ...binding(active),
          observation: await this.currentObservation(active),
        };
      }
      const pending = this.creating.get(options.browserSessionId);
      if (pending) {
        const runtime = await pending;
        this.assertSameBinding(runtime, options);
        return {
          ...binding(runtime),
          observation: await this.currentObservation(runtime),
        };
      }
      if (this.sessions.size + this.creating.size >= this.maxSessions) {
        throw new InteractionControllerError(
          "resource_unavailable",
          "browser supervisor session capacity is exhausted",
          true,
        );
      }
      const creation = this.buildRuntime(options);
      this.creating.set(options.browserSessionId, creation);
      try {
        const runtime = await creation;
        if (this.closed) {
          await this.disposeRuntime(runtime, false);
          throw new InteractionControllerError(
            "resource_unavailable",
            "browser supervisor is closed",
          );
        }
        this.sessions.set(options.browserSessionId, runtime);
        return {
          ...binding(runtime),
          observation: await this.currentObservation(runtime),
        };
      } finally {
        if (this.creating.get(options.browserSessionId) === creation) {
          this.creating.delete(options.browserSessionId);
        }
      }
    } finally {
      options.restore?.dataKey.fill(0);
      options.restore?.aad.fill(0);
    }
  }

  listSessions(): BrowserSessionReference[] {
    return [...this.sessions.values()]
      .filter((runtime) => runtime.lifecycle === "active")
      .map(binding);
  }

  async listTargets(reference: BrowserSessionReference): Promise<BrowserTarget[]> {
    return await this.requireActive(reference).driver.listTargets();
  }

  async openTarget(reference: BrowserSessionReference, url?: string): Promise<BrowserObservation> {
    return await this.requireActive(reference).driver.openTarget(url);
  }

  async selectTarget(
    reference: BrowserSessionReference,
    targetId: string,
  ): Promise<BrowserObservation> {
    return await this.requireActive(reference).driver.selectTarget(targetId);
  }

  async closeTarget(
    reference: BrowserSessionReference,
    targetId: string,
  ): Promise<BrowserTarget[]> {
    return await this.requireActive(reference).driver.closeTarget(targetId);
  }

  async observe(reference: BrowserSessionReference, targetId: string): Promise<BrowserObservation> {
    return await this.requireActive(reference).controller.observe(targetId);
  }

  action(command: BrowserActionCommand): Promise<BrowserActionReceipt> {
    return this.requireActive({
      browserSessionId: command.browserSessionId,
      controllerGeneration: command.controllerGeneration,
    }).controller.run(command);
  }

  receipt(reference: BrowserSessionReference, operationId: string): BrowserActionReceipt | null {
    return this.requireBound(reference).controller.receipt(operationId);
  }

  async screenshot(
    reference: BrowserSessionReference,
    targetId: string,
    options?: BrowserScreenshotOptions,
  ): Promise<BrowserImageFrame> {
    return await this.requireActive(reference).driver.captureScreenshot(targetId, options);
  }

  async subscribeFrames(
    reference: BrowserSessionReference,
    targetId: string,
    options?: BrowserFrameStreamOptions,
  ): Promise<BrowserFrameSubscription> {
    return await this.requireActive(reference).driver.subscribeFrames(targetId, options);
  }

  async debug(
    reference: BrowserSessionReference,
    targetId: string,
    options?: {
      kinds?: readonly BrowserDiagnosticKind[];
      afterSequence?: number;
      limit?: number;
    },
  ): Promise<BrowserDiagnosticBatch> {
    return await this.requireActive(reference).driver.debug(targetId, options);
  }

  captureState(inputValue: BrowserStateCaptureInput): Promise<BrowserStateCaptureReceipt> {
    this.assertOpen();
    const input = validateCaptureInput(inputValue);
    const previous = this.stateTransferTails.get(input.browserSessionId) ?? Promise.resolve();
    const result = previous
      .then(async () => await this.performCapture(input))
      .finally(() => {
        input.dataKey.fill(0);
        input.aad.fill(0);
      });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.stateTransferTails.set(input.browserSessionId, tail);
    void tail.finally(() => {
      if (this.stateTransferTails.get(input.browserSessionId) === tail) {
        this.stateTransferTails.delete(input.browserSessionId);
      }
    });
    return result;
  }

  async endSession(
    reference: BrowserSessionReference,
    options: { removeState?: boolean } = {},
  ): Promise<void> {
    const pending = this.creating.get(reference.browserSessionId);
    if (pending) await pending;
    const stateTransfer = this.stateTransferTails.get(reference.browserSessionId);
    if (stateTransfer) await stateTransfer.catch(() => undefined);
    const runtime = this.requireBound(reference);
    const existing = this.ending.get(reference.browserSessionId);
    if (existing) return await existing;
    const driverAlreadyClosed = runtime.lifecycle === "captured";
    runtime.lifecycle = "ending";
    const ending = this.disposeRuntime(runtime, options.removeState ?? false, driverAlreadyClosed);
    this.ending.set(reference.browserSessionId, ending);
    try {
      await ending;
      this.sessions.delete(reference.browserSessionId);
    } finally {
      if (this.ending.get(reference.browserSessionId) === ending) {
        this.ending.delete(reference.browserSessionId);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.creating.values()]);
    const active = [...this.sessions.values()];
    await Promise.allSettled(
      active.map(async (runtime) => await this.endSession(binding(runtime))),
    );
  }

  private async buildRuntime(options: ValidatedBrowserSupervisorSessionOptions): Promise<Runtime> {
    const sessionDirectory = join(this.rootDirectory, "sessions", options.browserSessionId);
    const socketDirectory = join(this.socketRootDirectory, shortDigest(options.browserSessionId));
    const profileDirectory = join(sessionDirectory, "profile");
    const downloadDirectory = join(sessionDirectory, "downloads");
    const screenshotDirectory = join(sessionDirectory, "screenshots");
    for (const directory of [
      sessionDirectory,
      socketDirectory,
      downloadDirectory,
      screenshotDirectory,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    let restoredManifest: BrowserProfileManifest | null = null;
    let restoredProfileMaterialized = false;
    if (options.restore) {
      restoredManifest = await materializeRestoredProfile({
        sessionDirectory,
        profileDirectory,
        restore: options.restore,
      });
      restoredProfileMaterialized = true;
    } else {
      await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
      await chmod(profileDirectory, 0o700);
    }
    const journal = await SqliteBrowserOperationJournal.open({
      path: join(sessionDirectory, "operations.sqlite"),
      browserSessionId: options.browserSessionId,
      controllerGeneration: options.controllerGeneration,
    });
    let stateJournal: SqliteBrowserStateTransferJournal;
    try {
      stateJournal = await SqliteBrowserStateTransferJournal.open({
        path: join(sessionDirectory, "state-transfers.sqlite"),
        browserSessionId: options.browserSessionId,
        controllerGeneration: options.controllerGeneration,
      });
    } catch (error) {
      journal.close();
      throw error;
    }
    const driverContext: BrowserSupervisorDriverContext = {
      browserSessionId: options.browserSessionId,
      controllerGeneration: options.controllerGeneration,
      sessionDirectory,
      socketDirectory,
      profileDirectory,
      downloadDirectory,
      screenshotDirectory,
      headed: options.headed,
      transport: options.transport,
      ...(options.browserExecutablePath
        ? { browserExecutablePath: options.browserExecutablePath }
        : {}),
      ...(options.launchEnvironment ? { launchEnvironment: options.launchEnvironment } : {}),
    };
    let driver: BrowserSupervisorDriver | null = null;
    try {
      const initialJournal = journal.loadAndRecover();
      driver = await this.createDriver(driverContext);
      const runtime = {
        options: runtimeOptions(options),
        sessionDirectory,
        driverContext,
        journal,
        stateJournal,
        driver,
        lifecycle: "active" as const,
        controller: null as unknown as BrowserInteractionController,
      };
      runtime.controller = this.createController(runtime, driver, initialJournal);
      if (restoredManifest) {
        await restoreTabs(
          driver,
          options.initialUrl
            ? [{ url: options.initialUrl, selected: true }]
            : restoredManifest.tabs,
        );
        assertRestoredRuntimeCompatible(restoredManifest, await driver.runtimeSnapshot());
      } else {
        await driver.start(options.initialUrl);
      }
      return runtime;
    } catch (error) {
      const failures: unknown[] = [error];
      let driverClosed = driver === null;
      try {
        await driver?.close();
        driverClosed = true;
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (restoredProfileMaterialized && driverClosed) {
        try {
          await rm(profileDirectory, { recursive: true, force: true });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      try {
        journal.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        stateJournal.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        throw aggregateFailure(failures, "browser session creation did not clean up safely", error);
      }
      throw error;
    }
  }

  private async performCapture(input: ValidatedBrowserStateCaptureInput) {
    const runtime = this.requireBound(input);
    if (runtime.options.transport.kind === "attached_chrome") {
      throw new InteractionControllerError(
        "unsupported",
        "attached Chrome does not support placement-managed profile capture",
      );
    }
    const requestDigest = captureRequestDigest(input);
    let replay: BrowserStateCaptureReceipt | null;
    try {
      replay = runtime.stateJournal.begin(input.operationId, requestDigest);
    } catch (error) {
      if (error instanceof BrowserStateTransferOutcomeUnknownError) {
        throw new InteractionControllerError(
          "outcome_unknown",
          "browser state upload outcome is unknown and must be reconciled before retry",
        );
      }
      if (error instanceof BrowserStateTransferConflictError) {
        throw new InteractionControllerError(
          "operation_conflict",
          "browser state operation id is already bound to another request",
        );
      }
      throw error;
    }
    if (replay) return replay;
    if (runtime.lifecycle !== "active") {
      runtime.stateJournal.abandonPrepared(input.operationId, requestDigest);
      throw new InteractionControllerError(
        "resource_unavailable",
        "browser session is not available for state capture",
      );
    }

    const transferDirectory = join(runtime.sessionDirectory, "state-transfers");
    const artifactPath = join(transferDirectory, `${input.operationId}.ogbs`);
    await mkdir(transferDirectory, { recursive: true, mode: 0o700 });
    await rm(artifactPath, { force: true });
    let snapshot: BrowserRuntimeSnapshot | null = null;
    let driverClosed = false;
    let uploadDispatched = false;
    try {
      runtime.lifecycle = "capturing";
      await runtime.controller.waitForIdle();
      snapshot = await runtime.driver.runtimeSnapshot();
      await runtime.driver.close();
      driverClosed = true;
      const manifest = profileManifest(runtime, snapshot);
      const artifact = await captureEncryptedBrowserProfile({
        profileDirectory: runtime.driverContext.profileDirectory,
        artifactPath,
        dataKey: input.dataKey,
        aad: input.aad,
        manifest,
      });
      if (input.afterCapture === "restart") {
        await this.restartRuntime(runtime, snapshot);
        driverClosed = false;
        runtime.lifecycle = "active";
      }

      runtime.stateJournal.markDispatched(input.operationId, requestDigest);
      uploadDispatched = true;
      await this.uploadArtifact(artifactPath, input.upload);
      const receipt = runtime.stateJournal.complete(input.operationId, requestDigest, {
        operationId: input.operationId,
        browserSessionId: input.browserSessionId,
        controllerGeneration: input.controllerGeneration,
        objectKey: input.objectKey,
        ...artifact,
      });
      if (input.afterCapture === "stop") runtime.lifecycle = "captured";
      return receipt;
    } catch (error) {
      const failures: unknown[] = [error];
      if (driverClosed && snapshot) {
        try {
          await this.restartRuntime(runtime, snapshot);
          driverClosed = false;
          runtime.lifecycle = "active";
        } catch (restartError) {
          failures.push(restartError);
        }
      } else if (runtime.lifecycle === "capturing") {
        runtime.lifecycle = "active";
      }
      try {
        if (uploadDispatched) {
          runtime.stateJournal.markOutcomeUnknown(input.operationId, requestDigest);
        } else {
          runtime.stateJournal.abandonPrepared(input.operationId, requestDigest);
        }
      } catch (journalError) {
        failures.push(journalError);
      }
      if (failures.length > 1) {
        throw aggregateFailure(failures, "browser state capture did not recover cleanly", error);
      }
      throw error;
    } finally {
      await rm(artifactPath, { force: true }).catch(() => undefined);
    }
  }

  private async restartRuntime(runtime: Runtime, snapshot: BrowserRuntimeSnapshot): Promise<void> {
    const driver = await this.createDriver(runtime.driverContext);
    try {
      await restoreTabs(driver, snapshot.tabs);
      runtime.driver = driver;
      runtime.controller = this.createController(runtime, driver, runtime.journal.loadAndRecover());
    } catch (error) {
      await driver.close().catch(() => undefined);
      throw error;
    }
  }

  private createController(
    runtime: Runtime,
    driver: BrowserSupervisorDriver,
    initialJournal: ReturnType<SqliteBrowserOperationJournal["loadAndRecover"]>,
  ): BrowserInteractionController {
    return new BrowserInteractionController({
      browserSessionId: runtime.options.browserSessionId,
      controllerGeneration: runtime.options.controllerGeneration,
      driver,
      initialJournal,
      onJournalRecord: (record) => runtime.journal.write(record),
      authority: {
        authorizeDispatch: async (command) => {
          if (runtime.lifecycle !== "active") {
            throw new InteractionControllerError(
              "resource_unavailable",
              "browser session is changing state",
              true,
            );
          }
          await runtime.options.authority?.authorizeDispatch(command);
        },
      },
    });
  }

  private async currentObservation(runtime: Runtime): Promise<BrowserObservation> {
    const targets = await runtime.driver.listTargets();
    const selected = targets.find((target) => target.selected) ?? targets[0];
    if (selected) return await runtime.controller.observe(selected.id);
    return await runtime.driver.openTarget();
  }

  private assertSameBinding(
    runtime: Runtime,
    requested: ValidatedBrowserSupervisorSessionOptions,
  ): void {
    if (runtime.options.controllerGeneration !== requested.controllerGeneration) {
      throw new InteractionControllerError(
        "controller_stale",
        "browser session is already owned by another controller generation",
      );
    }
    if (
      runtime.options.headed !== requested.headed ||
      runtime.options.browserExecutablePath !== requested.browserExecutablePath ||
      runtime.options.initialUrl !== requested.initialUrl ||
      canonicalJson(runtime.options.transport) !== canonicalJson(requested.transport) ||
      canonicalJson(runtime.options.linkedComputer ?? null) !==
        canonicalJson(requested.linkedComputer ?? null) ||
      runtime.options.restoreAuthorityDigest !== restoreAuthorityDigest(requested.restore)
    ) {
      throw new InteractionControllerError(
        "operation_conflict",
        "browser session is already active with different launch options",
      );
    }
  }

  private requireActive(reference: BrowserSessionReference): Runtime {
    const runtime = this.requireBound(reference);
    if (runtime.lifecycle !== "active") {
      throw new InteractionControllerError("resource_unavailable", "browser session is ending");
    }
    return runtime;
  }

  private requireBound(reference: BrowserSessionReference): Runtime {
    const runtime = this.sessions.get(reference.browserSessionId);
    if (!runtime) {
      throw new InteractionControllerError("resource_not_found", "browser session is not active");
    }
    if (runtime.options.controllerGeneration !== reference.controllerGeneration) {
      throw new InteractionControllerError(
        "controller_stale",
        "browser request targets a stale controller generation",
      );
    }
    return runtime;
  }

  private async disposeRuntime(
    runtime: Runtime,
    removeState: boolean,
    driverAlreadyClosed = false,
  ): Promise<void> {
    const failures: unknown[] = [];
    let driverClosed = driverAlreadyClosed;
    let actionJournalClosed = false;
    let stateJournalClosed = false;
    if (!driverAlreadyClosed) {
      try {
        await runtime.driver.close();
        driverClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      runtime.journal.close();
      actionJournalClosed = true;
    } catch (error) {
      failures.push(error);
    }
    try {
      runtime.stateJournal.close();
      stateJournalClosed = true;
    } catch (error) {
      failures.push(error);
    }
    if (driverClosed) {
      try {
        await rm(join(this.socketRootDirectory, shortDigest(runtime.options.browserSessionId)), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (removeState && driverClosed && actionJournalClosed && stateJournalClosed) {
      try {
        await rm(runtime.sessionDirectory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "browser session cleanup did not complete cleanly");
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new InteractionControllerError("resource_unavailable", "browser supervisor is closed");
    }
  }
}

async function createBrowserDriver(
  context: BrowserSupervisorDriverContext,
  binary?: ResolvedAgentBrowserBinary,
): Promise<BrowserSupervisorDriver> {
  if (context.transport.kind === "attached_chrome") {
    const attached = await createAttachedChromeTransport({
      deviceId: context.transport.deviceId,
      connectionGeneration: context.transport.connectionGeneration,
      browserName: context.transport.browserName,
      browserVersion: context.transport.browserVersion,
      ...(context.transport.authorityFile
        ? { authorityFile: context.transport.authorityFile }
        : {}),
    });
    return new AgentBrowserDriver({
      browserSessionId: context.browserSessionId,
      controllerGeneration: context.controllerGeneration,
      runner: attached.runner,
      connect: async () => attached.connection,
      engine: "chrome",
    });
  }
  const runner = await AgentBrowserJsonRunner.create({
    namespace: "og",
    // A close followed immediately by another daemon using the same socket
    // name races agent-browser's asynchronous socket teardown. Every physical
    // driver lifecycle therefore gets a private socket identity; durable state
    // lives solely in the explicitly supplied profile directory.
    sessionName: `b${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    socketDirectory: context.socketDirectory,
    profileDirectory: context.profileDirectory,
    downloadDirectory: context.downloadDirectory,
    screenshotDirectory: context.screenshotDirectory,
    headed: context.headed,
    ...(context.browserExecutablePath
      ? { browserExecutablePath: context.browserExecutablePath }
      : {}),
    ...(context.launchEnvironment ? { environment: context.launchEnvironment } : {}),
    ...(binary ? { binary } : {}),
  });
  return new AgentBrowserDriver({
    browserSessionId: context.browserSessionId,
    controllerGeneration: context.controllerGeneration,
    runner,
  });
}

function binding(runtime: Runtime): BrowserSessionReference {
  return {
    browserSessionId: runtime.options.browserSessionId,
    controllerGeneration: runtime.options.controllerGeneration,
  };
}

function validateSessionOptions(
  options: BrowserSupervisorSessionOptions,
): ValidatedBrowserSupervisorSessionOptions {
  if (!isUuid(options.browserSessionId)) throw new Error("browserSessionId must be a UUID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(options.controllerGeneration)) {
    throw new Error("controllerGeneration is invalid");
  }
  if (options.initialUrl !== undefined && Buffer.byteLength(options.initialUrl) > 16_384) {
    throw new Error("initialUrl exceeds its byte envelope");
  }
  const transport = validateBrowserTransport(options.transport ?? { kind: "managed" });
  if (options.linkedComputer) {
    if (transport.kind !== "managed" || !options.headed) {
      throw new InteractionControllerError(
        "unsupported",
        "linked ComputerSessions require a managed headed browser",
      );
    }
    if (!isUuid(options.linkedComputer.computerSessionId)) {
      throw new Error("linked ComputerSession id must be a UUID");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(options.linkedComputer.controllerGeneration)) {
      throw new Error("linked ComputerSession controller generation is invalid");
    }
    if (!options.launchEnvironment) {
      throw new Error("linked ComputerSession launch environment is absent");
    }
  } else if (options.launchEnvironment) {
    throw new Error("browser launch environment requires a linked ComputerSession");
  }
  if (transport.kind === "attached_chrome") {
    if (!options.headed) throw new Error("attached Chrome sessions are always headed");
    if (options.restore) {
      throw new InteractionControllerError(
        "unsupported",
        "attached Chrome uses its live profile and cannot restore a BrowserIdentity revision",
      );
    }
    if (options.browserExecutablePath) {
      throw new Error("attached Chrome cannot select another browser executable");
    }
  }
  const { restore, transport: _transport, ...session } = options;
  return {
    ...session,
    transport,
    ...(restore ? { restore: validateRestoreInput(restore) } : {}),
  };
}

function validateBrowserTransport(input: BrowserSupervisorTransport): BrowserSupervisorTransport {
  if (input.kind === "managed") return { kind: "managed" };
  if (input.kind !== "attached_chrome") throw new Error("browser transport is unsupported");
  if (!isUuid(input.deviceId)) throw new Error("attached browser id must be a UUID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input.connectionGeneration)) {
    throw new Error("attached browser connection generation is invalid");
  }
  const browserName = boundedText(input.browserName, 1, 100, "attached browser name");
  const browserVersion = boundedText(input.browserVersion, 1, 256, "attached browser version");
  return {
    kind: "attached_chrome",
    deviceId: input.deviceId,
    connectionGeneration: input.connectionGeneration,
    browserName,
    browserVersion,
    ...(input.authorityFile ? { authorityFile: resolve(input.authorityFile) } : {}),
  };
}

function validateRestoreInput(input: BrowserStateRestoreInput): ValidatedBrowserStateRestoreInput {
  if (
    typeof input.objectKey !== "string" ||
    Buffer.byteLength(input.objectKey) > 2_048 ||
    !/^workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/browser-state\/[A-Za-z0-9._=-]+(?:\/[A-Za-z0-9._=-]+)*$/iu.test(
      input.objectKey,
    )
  ) {
    throw new Error("browser state restore object key is invalid");
  }
  if (input.format !== BROWSER_PROFILE_ARTIFACT_FORMAT) {
    throw new Error("browser state restore format is unsupported");
  }
  for (const [value, label] of [
    [input.artifactDigest, "artifact digest"],
    [input.contentDigest, "content digest"],
    [input.manifestDigest, "manifest digest"],
  ] as const) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw new Error(`browser state restore ${label} is invalid`);
    }
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new Error("browser state restore size is invalid");
  }
  if (!(input.dataKey instanceof Uint8Array) || input.dataKey.byteLength !== 32) {
    throw new Error("browser state restore data key must be exactly 32 bytes");
  }
  if (
    !(input.aad instanceof Uint8Array) ||
    input.aad.byteLength < 1 ||
    input.aad.byteLength > MAX_STATE_AAD_BYTES
  ) {
    throw new Error("browser state restore associated data is invalid");
  }
  const materialization = BrowserRevisionMaterializationSchema.parse(input.materialization);
  if (
    materialization.engine !== "chromium" ||
    materialization.driverId !== BROWSER_DRIVER_ID ||
    materialization.driverSchemaVersion !== BROWSER_DRIVER_SCHEMA_VERSION
  ) {
    throw new InteractionControllerError(
      "unsupported",
      "saved browser state requires another browser driver",
    );
  }
  return {
    objectKey: input.objectKey,
    format: BROWSER_PROFILE_ARTIFACT_FORMAT,
    artifactDigest: input.artifactDigest,
    contentDigest: input.contentDigest,
    manifestDigest: input.manifestDigest,
    sizeBytes: input.sizeBytes,
    dataKey: Buffer.from(input.dataKey),
    aad: Buffer.from(input.aad),
    materialization,
    download: validateDownloadAuthority(input.download),
  };
}

function runtimeOptions(options: ValidatedBrowserSupervisorSessionOptions): BrowserRuntimeOptions {
  const { restore, launchEnvironment: _launchEnvironment, ...runtime } = options;
  return {
    ...runtime,
    restoreAuthorityDigest: restoreAuthorityDigest(restore),
  };
}

function restoreAuthorityDigest(
  restore: ValidatedBrowserStateRestoreInput | undefined,
): string | null {
  if (!restore) return null;
  return createHash("sha256")
    .update(
      canonicalJson({
        version: 1,
        objectKey: restore.objectKey,
        format: restore.format,
        artifactDigest: restore.artifactDigest,
        contentDigest: restore.contentDigest,
        manifestDigest: restore.manifestDigest,
        sizeBytes: restore.sizeBytes,
        dataKeyDigest: createHash("sha256").update(restore.dataKey).digest("hex"),
        associatedDataDigest: createHash("sha256").update(restore.aad).digest("hex"),
        materialization: restore.materialization,
      }),
      "utf8",
    )
    .digest("hex");
}

async function materializeRestoredProfile(input: {
  sessionDirectory: string;
  profileDirectory: string;
  restore: ValidatedBrowserStateRestoreInput;
}): Promise<BrowserProfileManifest> {
  const transferDirectory = join(input.sessionDirectory, "state-restores");
  const artifactPath = join(transferDirectory, `${input.restore.artifactDigest}.ogbs`);
  const stagingDirectory = join(
    input.sessionDirectory,
    `profile.restore.${input.restore.artifactDigest.slice(0, 16)}`,
  );
  await rm(artifactPath, { force: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  try {
    await downloadBrowserStateArtifact(
      artifactPath,
      input.restore.download,
      input.restore.sizeBytes,
    );
    const receipt = await restoreEncryptedBrowserProfile({
      artifactPath,
      outputProfileDirectory: stagingDirectory,
      dataKey: input.restore.dataKey,
      aad: input.restore.aad,
      expectedArtifactDigest: input.restore.artifactDigest,
      expectedContentDigest: input.restore.contentDigest,
      expectedSizeBytes: input.restore.sizeBytes,
    });
    assertRestoredManifestAuthority(receipt.manifest, input.restore);
    await rm(input.profileDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, input.profileDirectory);
    await chmod(input.profileDirectory, 0o700);
    return receipt.manifest;
  } catch (error) {
    if (error instanceof InteractionControllerError) throw error;
    if (error instanceof BrowserStateDownloadError) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "saved browser state is temporarily unavailable",
        true,
      );
    }
    throw new InteractionControllerError(
      "driver_failed",
      "saved browser state failed authenticated restoration",
    );
  } finally {
    await rm(artifactPath, { force: true }).catch(() => undefined);
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function assertRestoredManifestAuthority(
  manifest: BrowserProfileManifest,
  restore: ValidatedBrowserStateRestoreInput,
): void {
  const expected = restore.materialization;
  if (browserManifestDigest(manifest) !== restore.manifestDigest) {
    throw new Error("browser profile manifest digest does not match its revision");
  }
  if (
    manifest.engine !== expected.engine ||
    manifest.engineVersion !== expected.engineVersion ||
    manifest.driverId !== expected.driverId ||
    manifest.driverSchemaVersion !== expected.driverSchemaVersion ||
    manifest.profileCrypto !== expected.profileCrypto ||
    manifest.platform !== expected.platform ||
    manifest.architecture !== expected.architecture
  ) {
    throw new Error("browser profile manifest does not match its materialization");
  }
  const platform = browserRuntimePlatform();
  const architecture = browserRuntimeArchitecture();
  if (
    !platform ||
    !architecture ||
    manifest.platform !== platform ||
    manifest.architecture !== architecture ||
    manifest.profileCrypto !== browserProfileCryptoPolicy(process.platform)
  ) {
    throw new InteractionControllerError(
      "unsupported",
      "saved browser state is incompatible with this placement",
    );
  }
}

function assertRestoredRuntimeCompatible(
  manifest: BrowserProfileManifest,
  snapshot: BrowserRuntimeSnapshot,
): void {
  if (snapshot.engine !== manifest.engine || snapshot.engineVersion !== manifest.engineVersion) {
    throw new InteractionControllerError(
      "unsupported",
      "saved browser state requires another Chromium build",
    );
  }
}

function browserManifestDigest(manifest: BrowserProfileManifest): string {
  return createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
}

function browserRuntimePlatform(): BrowserProfileManifest["platform"] | null {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return null;
}

function browserRuntimeArchitecture(): BrowserProfileManifest["architecture"] | null {
  return process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) {
        throw new Error("canonical JSON cannot contain undefined");
      }
      output[key] = canonicalValue(input[key]);
    }
    return output;
  }
  throw new Error("value cannot be represented as canonical JSON");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function defaultSocketRoot(rootDirectory: string): string {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(base, "ogb-s", shortDigest(resolve(rootDirectory)));
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

type ValidatedBrowserStateCaptureInput = BrowserSessionReference & {
  operationId: string;
  objectKey: string;
  afterCapture: "restart" | "stop";
  dataKey: Buffer;
  aad: Buffer;
  upload: BrowserStateUploadAuthority;
};

function validateCaptureInput(input: BrowserStateCaptureInput): ValidatedBrowserStateCaptureInput {
  if (!isUuid(input.browserSessionId)) throw new Error("browserSessionId must be a UUID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.controllerGeneration)) {
    throw new Error("controllerGeneration is invalid");
  }
  if (!isUuid(input.operationId)) throw new Error("browser state operation id must be a UUID");
  if (input.afterCapture !== "restart" && input.afterCapture !== "stop") {
    throw new Error("browser state post-capture behavior is invalid");
  }
  if (
    typeof input.objectKey !== "string" ||
    Buffer.byteLength(input.objectKey) > 2_048 ||
    !/^workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/browser-state\/[A-Za-z0-9._=-]+(?:\/[A-Za-z0-9._=-]+)*$/iu.test(
      input.objectKey,
    )
  ) {
    throw new Error("browser state object key is invalid");
  }
  if (!(input.dataKey instanceof Uint8Array) || input.dataKey.byteLength !== 32) {
    throw new Error("browser state data key must be exactly 32 bytes");
  }
  if (
    !(input.aad instanceof Uint8Array) ||
    input.aad.byteLength < 1 ||
    input.aad.byteLength > MAX_STATE_AAD_BYTES
  ) {
    throw new Error("browser state associated data is invalid");
  }
  const upload = validateUploadAuthority(input.upload);
  const dataKey = Buffer.from(input.dataKey);
  const aad = Buffer.from(input.aad);
  return {
    browserSessionId: input.browserSessionId,
    controllerGeneration: input.controllerGeneration,
    operationId: input.operationId,
    objectKey: input.objectKey,
    afterCapture: input.afterCapture,
    dataKey,
    aad,
    upload,
  };
}

function captureRequestDigest(input: ValidatedBrowserStateCaptureInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        operationId: input.operationId,
        browserSessionId: input.browserSessionId,
        controllerGeneration: input.controllerGeneration,
        objectKey: input.objectKey,
        afterCapture: input.afterCapture,
        dataKeyDigest: createHash("sha256").update(input.dataKey).digest("hex"),
        associatedDataDigest: createHash("sha256").update(input.aad).digest("hex"),
      }),
      "utf8",
    )
    .digest("hex");
}

function profileManifest(
  runtime: Runtime,
  snapshot: BrowserRuntimeSnapshot,
): BrowserProfileManifest {
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : null;
  const architecture = process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
  if (!platform || !architecture) {
    throw new Error("browser profile capture does not support this placement architecture");
  }
  return {
    schemaVersion: 1,
    browserSessionId: runtime.options.browserSessionId,
    controllerGeneration: runtime.options.controllerGeneration,
    capturedAt: new Date().toISOString(),
    engine: snapshot.engine,
    engineVersion: snapshot.engineVersion,
    driverId: BROWSER_DRIVER_ID,
    driverSchemaVersion: BROWSER_DRIVER_SCHEMA_VERSION,
    profileCrypto: browserProfileCryptoPolicy(process.platform),
    platform,
    architecture,
    tabs: snapshot.tabs,
  };
}

async function restoreTabs(
  driver: BrowserSupervisorDriver,
  capturedTabs: BrowserRuntimeSnapshot["tabs"],
): Promise<void> {
  const tabs = capturedTabs.length > 0 ? capturedTabs : [{ url: "about:blank", selected: true }];
  const primaryIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.selected),
  );
  const ordered = [tabs[primaryIndex]!, ...tabs.filter((_, index) => index !== primaryIndex)];
  const first = await driver.start(ordered[0]!.url);
  const available = (await driver.listTargets()).filter(
    (target) => target.kind === "page" || target.kind === "popup",
  );
  const used = new Set<string>();
  let selectedTargetId: string | null = null;
  for (const [index, tab] of ordered.entries()) {
    let target = available.find(
      (candidate) => !used.has(candidate.id) && candidate.url === tab.url,
    );
    if (!target) {
      const opened = index === 0 ? first : await driver.openTarget(tab.url);
      target = opened.target;
    }
    used.add(target.id);
    if (index === 0) selectedTargetId = target.id;
  }
  for (const target of available) {
    if (!used.has(target.id)) await driver.closeTarget(target.id);
  }
  if (selectedTargetId) await driver.selectTarget(selectedTargetId);
}
