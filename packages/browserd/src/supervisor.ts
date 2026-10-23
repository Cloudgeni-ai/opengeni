import { EphemeralChromiumContextPool } from "./chromium-context-pool";
import { UnsettledCleanupError } from "./cleanup-error";
import { restoredTabUrl } from "./restored-tab-url";
import { selectManagedChromiumExecutable, type VerifiedHeadlessShell } from "./headless-shell";
import type { HeadlessSessionCookies } from "./headless-session-cookies";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  BrowserActionCommand,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDiagnosticKind,
  BrowserDomReadRequest,
  BrowserDomReadResponse,
  BrowserDownload,
  BrowserExternalAuthCommand,
  BrowserObservation,
  BrowserPasskeySyncRequest,
  BrowserPasskeySyncResponse,
  BrowserRevisionMaterialization,
  BrowserTarget,
  BrowserTargetState,
  BrowserWorkspaceFileStageRequest,
  BrowserWorkspaceFileStageResponse,
  BrowserDownloadExportRequest as BrowserDownloadExportRequestValue,
  BrowserDownloadExportReceipt as BrowserDownloadExportReceiptValue,
  BrowserExternalAuthResult as BrowserExternalAuthResultValue,
} from "@opengeni/contracts";
import { RECENT_USE_UPDATE_HOLD_MS, type UpdateBlocker } from "./update-admission";
import {
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  BrowserDownloadExportRequest,
  BrowserRevisionMaterialization as BrowserRevisionMaterializationSchema,
  NetworkRouteConsistency,
  type NetworkRouteConsistency as NetworkRouteConsistencyValue,
} from "@opengeni/contracts";
import {
  BrowserInteractionController,
  InteractionControllerError,
  InteractionDefiniteDriverError,
  type BrowserInteractionAuthority,
  type BrowserInteractionDriver,
} from "@opengeni/interaction";
import {
  connectAttachedBrowserBridge,
  createAttachedChromeDriver,
  createAttachedChromeTransport,
  settleAttachedTabLedger,
  type AttachedBrowserBridgeConnector,
} from "./attached-cdp";
import {
  AttachedTabLedgerRecorder,
  processRunning,
  readAttachedTabLedger,
  readAttachedTabLedgers,
  removeAttachedTabLedger,
  writeAttachedTabLedger,
} from "./attached-tab-ledger";
import { CdpConnection } from "./cdp";
import {
  AgentBrowserDriver,
  type BrowserRuntimeSnapshot,
  type BrowserTabNavigationOptions,
} from "./cdp-driver";
import { BrowserDownloadStore, type CompletedBrowserDownloadFile } from "./downloads";
import {
  readDetachedBrowserRecords,
  removeDetachedBrowserRecord,
  writeDetachedBrowserRecord,
} from "./detached-browsers";
import { uploadBrowserDownload } from "./download-upload";
import { BrowserRecording, type RecordingFrameSource, type RecordingSummary } from "./recording";
import type { ResolvedLightpandaBinary } from "./lightpanda-binary";
import { LightpandaRunner } from "./lightpanda-runner";
import { ExternalProviderCdpRunner } from "./external-provider-runner";
import { BrowserPasskeyManager } from "./passkeys";
import {
  type BrowserFrameStreamOptions,
  type BrowserFrameSubscription,
  type BrowserImageFrame,
  type BrowserScreenshotOptions,
} from "./media";
import {
  AgentBrowserCommandError,
  ManagedBrowserRunner,
  browserProfileCryptoPolicy,
  reapManagedBrowserProcesses,
  reapOrphanedAgentBrowserDaemons,
  inspectOwnedManagedBrowserProcess,
  stopEndedManagedBrowserProcess,
  assertManagedBrowserProfileUnused,
  type OwnedManagedBrowserProcess,
} from "./runner";
import {
  SqliteBrowserWorkingRuntimeJournal,
  adoptableSourceReceipt,
  adoptedCopyNeedsResettle,
  assertDirectory,
  assertWorkingRuntimeReceipt,
  boundedFailureCode,
  isAbandonedLaunchReceipt,
  isInterruptedLaunchReceipt,
  unavailable as workingRuntimeUnavailable,
  BrowserWorkingRuntimeUnavailableError,
  type BrowserWorkingRuntimeAuthority,
  type BrowserWorkingRuntimeReceipt,
  type InterruptedRecovery,
  recordedProcessReceipt,
} from "./working-runtime-journal";
import {
  ADOPTION_IN_FLIGHT,
  WorkingCopyAdoptionError,
  activeAdoptionLocked,
  adoptionAuthority,
  adoptionLocked,
  adoptWorkingCopy,
  adoptionPaths,
  assertWorkingCopyJournalsIntact,
  emptyWorkingCopyEvidence,
  observeActiveAdoption,
  readActiveAdoption,
  readAdoptionRecord,
  revertWorkingCopyAdoption,
  withWorkingDirectoryLock,
  workingCopyAdoptionStatus,
  workingCopyManifest,
  workingCopyRefusalError,
  type AdoptionBoundary,
  type BrowserWorkingCopyAdoptionStatus,
  type BrowserWorkingCopyAuthorityInput,
  type BrowserWorkingCopyInspection,
  type BrowserWorkingCopyRefusal,
} from "./working-copy-adoption";
import { SqliteBrowserOperationJournal } from "./journal";
import { BrowserWorkspaceFileStager } from "./workspace-files";
import { markProfileExitedCleanly } from "./profile-exit-state";
import { reportUnexpectedDispatchError } from "./controller-diagnostics";
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
import { BROWSER_WINDOW_PARK_IDLE_MS } from "./window-parking";

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

/** The same frame subscription, calling `release` once it is closed or its
 * frames end. */
function releaseOnClose(
  subscription: BrowserFrameSubscription,
  release: () => void,
): BrowserFrameSubscription {
  return {
    async close() {
      try {
        await subscription.close();
      } finally {
        release();
      }
    },
    [Symbol.asyncIterator]() {
      const frames = subscription[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await frames.next();
          if (result.done) release();
          return result;
        },
        async return(value?: unknown) {
          try {
            return (await frames.return?.(value)) ?? { done: true as const, value: undefined };
          } finally {
            release();
          }
        },
      };
    },
  };
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
  networkRoute?: BrowserSupervisorNetworkRoute;
  recoverExistingWorkingDirectory?: true;
  workingRuntimeAuthority?: BrowserWorkingRuntimeAuthority;
};

export type BrowserSupervisorNetworkRoute = {
  routeId: string;
  routeVersion: number;
  authorityDigest: string;
  kind: "direct" | "proxy" | "managed" | "tunnel";
  consistency: NetworkRouteConsistencyValue;
  proxyUrl?: string;
  providerRoute?: {
    providerId: "browserbase" | "kernel";
    routeId: string;
    egressClass: "datacenter" | "residential" | "isp";
    region: string | null;
  };
};

export type BrowserSupervisorTransport =
  | { kind: "managed"; engine?: "chromium" | "lightpanda"; ephemeralPartition?: string }
  | {
      kind: "external_provider";
      providerId: "browserbase" | "kernel";
      placementId: string;
      authority: {
        apiKey: string;
        endpoint?: string;
      };
      timeoutSeconds?: number;
      stealth?: boolean;
    }
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
  /** Returned only by the create that launched the browser. */
  notice?: string;
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
  readonly fencedInputBatches?: boolean;
  readonly focusedInputObservations?: boolean;
  readonly networkNotice?: string | null;
  start(url?: string, options?: BrowserTabNavigationOptions): Promise<BrowserObservation>;
  listTargets(): Promise<BrowserTarget[]>;
  openTarget(url?: string, options?: BrowserTabNavigationOptions): Promise<BrowserObservation>;
  openTargetWithInventory?(url?: string): Promise<BrowserTarget[]>;
  selectTarget(targetId: string): Promise<BrowserObservation>;
  closeTarget(targetId: string): Promise<BrowserTarget[]>;
  targetState(targetId: string): Promise<BrowserTargetState>;
  readDom(targetId: string, request: BrowserDomReadRequest): Promise<BrowserDomReadResponse>;
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
  readClipboard(): BrowserClipboard;
  runtimeSnapshot(): Promise<BrowserRuntimeSnapshot>;
  /** Keeps the browser's windows presented until the returned release is
   * called (drivers that park idle windows). */
  acquirePresence?(): Promise<() => void>;
  /** Change-driven JPEG frames of one tab, for recordings. */
  recordFrames?(
    targetId: string,
    onFrame: (jpeg: Uint8Array, capturedAtMs: number) => void,
    onEnd: (error: Error | null) => void,
  ): Promise<() => Promise<void>>;
  /** Private state capture adjunct, never part of runtimeSnapshot/public JSON. */
  captureSessionCookies?(): Promise<HeadlessSessionCookies | null>;
  readonly requiresExplicitProfileRestore?: boolean;
  externalAuth?(command: BrowserExternalAuthCommand): Promise<BrowserExternalAuthResultValue>;
  /** Provider liveness probe used only after another operation reports a
   * failure. Managed Chromium implements it; unsupported providers fail
   * honestly without implicit recovery. */
  isAvailable?(): Promise<boolean>;
  isTerminal?(): boolean;
  /** Whether a JavaScript dialog is waiting for an answer in one of its tabs.
   * Releasing the browser then would lose it: a relaunched browser no longer
   * has it, and in the person's own Chrome a debugger attached later can
   * neither see nor answer it. */
  hasOpenDialog?(): boolean;
  ownedProcessIdentity?(): Promise<OwnedManagedBrowserProcess | null>;
  /** Release a failed reattach transport without closing its owned browser. */
  detach?(): Promise<void>;
  /** Ends this runtime's hold on the browser. In the person's own browser
   * (attached Chrome) it also closes the tabs the session opened and left
   * blank, and releases Chrome's debugger, however the runtime goes away. */
  close(): Promise<void>;
};

export type BrowserSupervisorDriverContext = BrowserSessionReference & {
  sessionDirectory: string;
  profileDirectory: string;
  restoredProfile: boolean;
  recoverOwnedProcess?: OwnedManagedBrowserProcess;
  allowOwnedProcessLaunch?: boolean;
  headlessSessionCookies?: HeadlessSessionCookies;
  downloadDirectory: string;
  headed: boolean;
  transport: BrowserSupervisorTransport;
  browserExecutablePath?: string;
  linkedComputer?: { computerSessionId: string; controllerGeneration: string };
  launchEnvironment?: NodeJS.ProcessEnv;
  networkRoute?: BrowserSupervisorNetworkRoute;
  /** One per browser session; outlives driver restarts so loaded credentials
   * and undelivered passkey events survive browser recovery. */
  passkeys?: BrowserPasskeyManager;
  resolveWorkspaceFiles: (
    operationId: string,
    workspaceFileIds: readonly string[],
  ) => Promise<readonly string[]>;
  downloadEvents?: {
    begin: BrowserDownloadStore["begin"];
    progress: BrowserDownloadStore["progress"];
    reject: BrowserDownloadStore["reject"];
  };
};

export type BrowserSupervisorOptions = {
  ephemeralContextPoolEnabled?: boolean;
  /** Run managed Linux browsers in their own network namespace where the
   * machine supports it (default true). A deployment whose browsers already
   * own their network, such as a managed sandbox VM, turns it off. */
  networkIsolation?: boolean;
  /** Host a virtual WebAuthn authenticator in every page target (default true
   * where the transport supports it). Passkey placements bring the acted-on
   * tab to the front before each action, because Chromium refuses WebAuthn
   * ceremonies in a background tab; disabling passkeys keeps managed input in
   * the background. */
  passkeys?: boolean;
  rootDirectory: string;
  maxSessions?: number;
  /** Resolves the verified Lightpanda binary when a Lightpanda session first needs it. */
  lightpandaBinary?: () => Promise<ResolvedLightpandaBinary>;
  headlessShell?: VerifiedHeadlessShell;
  createDriver?: (context: BrowserSupervisorDriverContext) => Promise<BrowserSupervisorDriver>;
  uploadArtifact?: (artifactPath: string, authority: BrowserStateUploadAuthority) => Promise<void>;
  uploadDownload?: typeof uploadBrowserDownload;
  /** Read-only identity seam; tests supply generated process receipts only. */
  inspectOwnedProcess?: typeof inspectOwnedManagedBrowserProcess;
  /** Stops a browser an explicitly ended, non-resident session left running;
   * tests observe the exact recorded process instead of signalling it. */
  stopEndedProcess?: typeof stopEndedManagedBrowserProcess;
  /** Proves no process runs a browser on an exact private profile before an
   * interrupted launch is set aside; tests supply the outcome. */
  assertProfileUnused?: typeof assertManagedBrowserProfileUnused;
  /** Called after each durable boundary of a working copy adoption or
   * revert; tests use it to stop one at an exact boundary, as a crash would. */
  afterAdoptionPhase?: (boundary: AdoptionBoundary) => Promise<void>;
  /** Called once an end or launch holds a browser's working directory lock
   * and has found no adoption owning the directory; tests use it to hold
   * the lock while another controller tries to act. */
  afterWorkingDirectoryClaim?: (
    operation: "end" | "launch",
    browserSessionId: string,
  ) => Promise<void>;
  /** Close a managed browser nobody used for this long, keeping its profile
   * on disk; its next request relaunches it with the same tabs. A session in
   * the person's own Chrome lets go of that browser after the same time and
   * continues in its tab on its next request (default 10 minutes, 0
   * disables). */
  idleReleaseMs?: number;
  /** Clock for idle release; tests advance it. */
  now?: () => number;
  /** Opens a bridge to an attached Chrome profile; tests substitute a
   * fixture browser. */
  connectAttachedBridge?: AttachedBrowserBridgeConnector;
};

/** Managed browsers stop after this long unused. The profile, tabs and
 * downloads stay on disk, and the next request relaunches the browser on them,
 * so an idle browser costs no memory or CPU while waiting. */
export const BROWSER_IDLE_RELEASE_MS = 10 * 60_000;
const IDLE_RELEASE_SWEEP_MS = 60_000;
/** How long a handed-off browser gets to save its session and exit after a
 * close request before it is stopped by signal. */
const HANDED_OFF_CLOSE_TIMEOUT_MS = 10_000;
/** How long cleanup in the person's own browser after a crashed controller is
 * retried (the browser may be closed or disconnected meanwhile). After that
 * its tab ids are no longer trusted to name the same tabs. */
const ATTACHED_LEFTOVER_RETRY_MS = 24 * 60 * 60_000;

type Runtime = {
  options: BrowserRuntimeOptions;
  sessionDirectory: string;
  driverContext: BrowserSupervisorDriverContext;
  journal: SqliteBrowserOperationJournal;
  stateJournal: SqliteBrowserStateTransferJournal;
  workingJournal: SqliteBrowserWorkingRuntimeJournal | null;
  workingReceipt: BrowserWorkingRuntimeReceipt | null;
  driver: BrowserSupervisorDriver;
  controller: BrowserInteractionController;
  workspaceFileStager: BrowserWorkspaceFileStager;
  downloadStore: BrowserDownloadStore | null;
  lastSnapshot: BrowserRuntimeSnapshot;
  lastTargets: BrowserTarget[];
  /** Exact observation already produced while launching a new browser. It is
   * returned once from createSession instead of immediately rebuilding the
   * same accessibility tree through a second controller round trip. */
  creationObservation: BrowserObservation | null;
  recovery: Promise<void> | null;
  externalAuthTail: Promise<void> | null;
  /** Outstanding uses that keep the browser's windows presented. Each is
   * bound to the current driver and moves to its replacement on recovery. */
  presence: Set<PresenceHold>;
  /** The session's current or last recording; one at a time. */
  recording: BrowserRecording | null;
  /** When a request last reached this browser (supervisor clock). */
  lastUsedAt: number;
  lifecycle: "active" | "recovering" | "reconfiguring" | "capturing" | "captured" | "ending";
};

type PresenceHold = { driver: BrowserSupervisorDriver | null; release: () => void };

type BrowserRuntimeOptions = Omit<
  BrowserSupervisorSessionOptions,
  "restore" | "transport" | "launchEnvironment" | "networkRoute"
> & {
  transport: BrowserSupervisorTransport;
  restoreAuthorityDigest: string | null;
  networkRouteAuthorityDigest: string | null;
  networkRouteMaterialDigest: string | null;
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
  private readonly maxSessions: number;
  private readonly ephemeralContextPoolEnabled: boolean;
  private readonly passkeysEnabled: boolean;
  private readonly contextPools = new Map<string, EphemeralChromiumContextPool>();
  private readonly createDriver: (
    context: BrowserSupervisorDriverContext,
  ) => Promise<BrowserSupervisorDriver>;
  private readonly uploadArtifact: (
    artifactPath: string,
    authority: BrowserStateUploadAuthority,
  ) => Promise<void>;
  private readonly uploadDownload: typeof uploadBrowserDownload;
  private readonly inspectOwnedProcess: typeof inspectOwnedManagedBrowserProcess;
  private readonly stopEndedProcess: typeof stopEndedManagedBrowserProcess;
  private readonly assertProfileUnused: typeof assertManagedBrowserProfileUnused;
  private readonly afterAdoptionPhase: ((boundary: AdoptionBoundary) => Promise<void>) | undefined;
  private readonly afterWorkingDirectoryClaim:
    | ((operation: "end" | "launch", browserSessionId: string) => Promise<void>)
    | undefined;
  private readonly sessions = new Map<string, Runtime>();
  private readonly creating = new Map<string, Promise<Runtime>>();
  /** Browsers whose working copy is being adopted by this process. */
  private readonly adopting = new Set<string>();
  /** Browsers whose preserved working copy is being ended, retired or set
   * aside by this process; an adoption may not start meanwhile. */
  private readonly endingWorkingCopies = new Set<string>();
  private readonly creationRequests = new Set<Promise<BrowserSupervisorSession>>();
  private readonly ending = new Map<string, Promise<void>>();
  private readonly stateTransferTails = new Map<string, Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private cleanupUncertain = false;
  /** Browsers whose failed reattach could not prove its transport detached. */
  private readonly recoveryTransportsUncertain = new Set<string>();
  private readonly idleReleaseMs: number;
  private readonly now: () => number;
  private idleReleaseTimer: ReturnType<typeof setInterval> | null = null;
  /** Browsers an earlier controller handed off that this one is stopping. */
  private readonly releasingDetached = new Map<string, Promise<unknown>>();
  /** Handed-off browsers the last sweep found still waiting for their idle
   * time; the controller is not empty while any remain. */
  private detachedWaiting = 0;
  private detachedSweep: Promise<string[]> | null = null;
  private attachedSweep: Promise<string[]> | null = null;
  private readonly connectAttachedBridge: AttachedBrowserBridgeConnector;
  /** Sessions whose failed attached cleanup was already reported. */
  private readonly attachedLeftoverWarnings = new Set<string>();

  private constructor(options: BrowserSupervisorOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.connectAttachedBridge = options.connectAttachedBridge ?? connectAttachedBrowserBridge;
    this.ephemeralContextPoolEnabled = options.ephemeralContextPoolEnabled === true;
    this.passkeysEnabled = options.passkeys !== false;
    this.maxSessions = boundedPositiveInteger(
      options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      "maxSessions",
    );
    this.createDriver =
      options.createDriver ??
      (async (context) =>
        await (context.transport.kind === "managed" && context.transport.ephemeralPartition
          ? this.createEphemeralDriver(context, options)
          : createBrowserDriver(
              context,
              options.lightpandaBinary,
              options.headlessShell,
              options.networkIsolation !== false,
              this.connectAttachedBridge,
            )));
    this.uploadArtifact = options.uploadArtifact ?? uploadBrowserStateArtifact;
    this.uploadDownload = options.uploadDownload ?? uploadBrowserDownload;
    this.inspectOwnedProcess = options.inspectOwnedProcess ?? inspectOwnedManagedBrowserProcess;
    this.stopEndedProcess = options.stopEndedProcess ?? stopEndedManagedBrowserProcess;
    this.assertProfileUnused = options.assertProfileUnused ?? assertManagedBrowserProfileUnused;
    this.afterAdoptionPhase = options.afterAdoptionPhase;
    this.afterWorkingDirectoryClaim = options.afterWorkingDirectoryClaim;
    this.now = options.now ?? Date.now;
    this.idleReleaseMs = options.idleReleaseMs ?? BROWSER_IDLE_RELEASE_MS;
    if (this.idleReleaseMs > 0) {
      this.idleReleaseTimer = setInterval(
        () => {
          void this.releaseIdleBrowsers();
          void this.releaseDetachedBrowsers();
          void this.releaseAttachedLeftovers();
        },
        Math.min(IDLE_RELEASE_SWEEP_MS, this.idleReleaseMs),
      );
      this.idleReleaseTimer.unref?.();
    }
  }

  /**
   * Closes every managed browser nobody used for the idle release time.
   * Each keeps its working directory and a recoverable working-runtime
   * receipt, exactly as a controller shutdown leaves it, except that its
   * browser process stops instead of running on. The session leaves this
   * controller; its next request finds it missing, and the control plane
   * recovers it from that directory: the same profile, relaunched with its
   * last tabs.
   *
   * A session in the person's own Chrome is released the same way: the empty
   * tabs it opened close and Chrome's debugger lets go of the browser, so
   * Chrome stops showing that it is being debugged. Its recovery continues
   * in the tab it was using. Returns the released browser session ids.
   */
  async releaseIdleBrowsers(): Promise<string[]> {
    if (this.closed) return [];
    return await this.releaseIdleRuntimes();
  }

  private async releaseIdleRuntimes(): Promise<string[]> {
    if (this.idleReleaseMs <= 0) return [];
    const idleBefore = this.now() - this.idleReleaseMs;
    const released: string[] = [];
    for (const runtime of [...this.sessions.values()]) {
      if (!idleReleasable(runtime, idleBefore)) continue;
      // A download still transferring is the browser at work with nobody
      // calling it; stopping the browser would fail the download.
      if (await downloadInProgress(runtime)) continue;
      if (!idleReleasable(runtime, idleBefore)) continue;
      const browserSessionId = runtime.options.browserSessionId;
      if (this.sessions.get(browserSessionId) !== runtime || this.ending.has(browserSessionId))
        continue;
      runtime.lifecycle = "ending";
      const ending = (async () => {
        await runtime.controller.waitForIdle();
        await this.disposeRuntime(runtime, false, false, true, true);
      })();
      this.ending.set(browserSessionId, ending);
      try {
        await ending;
        if (this.sessions.get(browserSessionId) === runtime) this.sessions.delete(browserSessionId);
        released.push(browserSessionId);
      } catch (error) {
        console.warn("browserd.idle_release_failed", {
          browserSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (this.ending.get(browserSessionId) === ending) this.ending.delete(browserSessionId);
      }
    }
    return released;
  }

  /**
   * Stops browsers an earlier controller left running at its shutdown (an
   * agent update or restart) once they have gone unused for the idle release
   * time. A handed-off browser is adopted again only when its session's next
   * request arrives; without this, a browser whose session never returns
   * would run forever. The browser's receipt already records a recoverable
   * suspension, so its next request relaunches it on the same profile, as
   * after any idle release. The recorded process is stopped only while its
   * PID birth and exact profile still identify it. Returns the released ids.
   */
  async releaseDetachedBrowsers(): Promise<string[]> {
    if (this.closed || this.idleReleaseMs <= 0) return [];
    this.detachedSweep ??= this.sweepDetachedBrowsers().finally(() => {
      this.detachedSweep = null;
    });
    return await this.detachedSweep;
  }

  /**
   * Cleans up the person's own Chrome after attached browser sessions whose
   * controller went away without doing it (it crashed, or the cleanup could
   * not reach the browser): closes the tabs each opened that are still blank
   * and releases Chrome's debugger attachments it held. Tabs that show a page,
   * tabs the session did not open and attachments a live session holds are
   * left alone. A session whose next request arrives meanwhile waits for its
   * cleanup and then continues in the tab it was using. Returns the settled
   * browser session ids.
   */
  async releaseAttachedLeftovers(): Promise<string[]> {
    if (this.closed) return [];
    this.attachedSweep ??= this.sweepAttachedLeftovers().finally(() => {
      this.attachedSweep = null;
    });
    return await this.attachedSweep;
  }

  private async sweepAttachedLeftovers(): Promise<string[]> {
    let ledgers;
    try {
      ledgers = await readAttachedTabLedgers(this.rootDirectory);
    } catch (error) {
      console.warn("browserd.attached_leftover_release_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    const settled: string[] = [];
    for (const ledger of ledgers) {
      if (this.closed) break;
      if (ledger.settled || this.attachedSessionBusy(ledger.browserSessionId)) continue;
      // Another live controller on this machine may still hold the session.
      if (ledger.ownerPid !== process.pid && processRunning(ledger.ownerPid)) continue;
      if (await this.settleAttachedLeftovers(ledger.browserSessionId)) {
        settled.push(ledger.browserSessionId);
      }
    }
    return settled;
  }

  private attachedSessionBusy(browserSessionId: string): boolean {
    return (
      this.sessions.has(browserSessionId) ||
      this.creating.has(browserSessionId) ||
      this.ending.has(browserSessionId) ||
      this.adopting.has(browserSessionId) ||
      this.releasingDetached.has(browserSessionId)
    );
  }

  /** Settle one session's leftovers, claimed like a handed-off browser's
   * release so that its recovery or end waits instead of racing it. The
   * check and claim happen without yielding. Returns whether it settled; a
   * session another live controller on this machine took over meanwhile is
   * left to that controller. */
  private async settleAttachedLeftovers(browserSessionId: string): Promise<boolean> {
    if (this.attachedSessionBusy(browserSessionId)) return false;
    const sessionDirectory = join(this.rootDirectory, "sessions", browserSessionId);
    const release = (async (): Promise<boolean> => {
      const ledger = readAttachedTabLedger(sessionDirectory);
      if (!ledger || ledger.settled) return true;
      if (ledger.ownerPid !== process.pid && processRunning(ledger.ownerPid)) return false;
      let next;
      try {
        next = await settleAttachedTabLedger(ledger, this.connectAttachedBridge, Date.now());
      } catch (error) {
        if (Date.now() - ledger.updatedAt < ATTACHED_LEFTOVER_RETRY_MS) throw error;
        next = {
          ...ledger,
          settled: true,
          createdTabs: [],
          attachedTabs: [],
          updatedAt: Date.now(),
        };
      }
      writeAttachedTabLedger(sessionDirectory, next);
      if (!next.settled) throw new Error("some tabs could not be cleaned up yet");
      return true;
    })();
    this.releasingDetached.set(browserSessionId, release);
    try {
      if (!(await release)) return false;
      this.attachedLeftoverWarnings.delete(browserSessionId);
      return true;
    } catch (error) {
      if (!this.attachedLeftoverWarnings.has(browserSessionId)) {
        this.attachedLeftoverWarnings.add(browserSessionId);
        console.warn("browserd.attached_leftover_release_failed", {
          browserSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    } finally {
      if (this.releasingDetached.get(browserSessionId) === release)
        this.releasingDetached.delete(browserSessionId);
    }
  }

  private async sweepDetachedBrowsers(): Promise<string[]> {
    let records;
    try {
      records = await readDetachedBrowserRecords(this.rootDirectory);
    } catch (error) {
      console.warn("browserd.detached_release_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    const idleBefore = this.now() - this.idleReleaseMs;
    const released: string[] = [];
    let waiting = 0;
    for (const record of records) {
      const browserSessionId = record.browserSessionId;
      const sessionDirectory = join(this.rootDirectory, "sessions", browserSessionId);
      const profileDirectory = join(sessionDirectory, "profile");
      if (
        this.sessions.has(browserSessionId) ||
        this.creating.has(browserSessionId) ||
        this.ending.has(browserSessionId) ||
        this.adopting.has(browserSessionId) ||
        this.endingWorkingCopies.has(browserSessionId)
      )
        continue;
      if (this.closed) break;
      if (record.lastUsedAt > idleBefore) {
        waiting += 1;
        continue;
      }
      // Checked and claimed without yielding, so a request that recovers the
      // same session waits for this stop instead of adopting a dying browser.
      const release = (async () => {
        if (record.process.profileDirectory === profileDirectory) {
          await this.closeHandedOffBrowser(record.process);
          await this.stopEndedProcess(profileDirectory, record.process);
        }
        await removeDetachedBrowserRecord(sessionDirectory);
      })();
      this.releasingDetached.set(browserSessionId, release);
      try {
        await release;
        released.push(browserSessionId);
      } catch (error) {
        waiting += 1;
        console.warn("browserd.detached_release_failed", {
          browserSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (this.releasingDetached.get(browserSessionId) === release)
          this.releasingDetached.delete(browserSessionId);
      }
    }
    this.detachedWaiting = waiting;
    return released;
  }

  /** Ask a handed-off browser to shut down over its own DevTools endpoint,
   * as an idle release does, so Chromium saves its session and the next
   * launch restores its tabs. Best effort: the identity-checked stop that
   * follows ends it either way. */
  private async closeHandedOffBrowser(owned: OwnedManagedBrowserProcess): Promise<void> {
    if ((await this.inspectOwnedProcess(owned).catch(() => "exited")) !== "live") return;
    let connection: CdpConnection;
    try {
      connection = await CdpConnection.connect(owned.cdpEndpoint, { timeoutMs: 2_000 });
    } catch {
      return;
    }
    try {
      await connection.send("Browser.close", {}, { timeoutMs: 5_000 });
    } catch {
      // The browser may drop the connection while it closes.
    } finally {
      connection.close();
    }
    const deadline = Date.now() + HANDED_OFF_CLOSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await this.inspectOwnedProcess(owned).catch(() => "exited")) === "exited") return;
      await Bun.sleep(100);
    }
  }

  private async createEphemeralDriver(
    context: BrowserSupervisorDriverContext,
    options: BrowserSupervisorOptions,
  ): Promise<BrowserSupervisorDriver> {
    if (
      !options.ephemeralContextPoolEnabled ||
      context.transport.kind !== "managed" ||
      !context.transport.ephemeralPartition
    ) {
      throw new InteractionControllerError(
        "unsupported",
        "ephemeral browser contexts are disabled by the operator",
      );
    }
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          context.transport.ephemeralPartition,
          context.browserExecutablePath ?? "default",
          "headless-default-egress-v1",
        ]),
      )
      .digest("hex");
    let pool = this.contextPools.get(key);
    if (!pool || pool.isTerminal()) {
      // A failed terminal pool still owns the only cleanup proof. Do not
      // replace it until its retained shutdown has positively completed.
      if (pool) await pool.close();
      const poolDirectory = join(this.rootDirectory, "sessions", randomUUID());
      pool = new EphemeralChromiumContextPool({
        authorityKey: key,
        onTerminal: () => {
          if (this.closed) return;
          // Do not await retirement from pool shutdown: driver.close joins that
          // same shutdown promise. Each end is fenced/deduplicated by `ending`.
          void this.retireTerminalSessions().catch((error) => {
            console.error("browser terminal-session retirement failed", error);
          });
        },
        launch: async () => {
          const runner = await ManagedBrowserRunner.create({
            profileDirectory: join(poolDirectory, "profile"),
            headed: false,
            ...(options.networkIsolation === false ? { networkIsolation: false } : {}),
            ...(context.browserExecutablePath
              ? { browserExecutablePath: context.browserExecutablePath }
              : {}),
          });
          return {
            run: runner.run.bind(runner),
            terminate: async () => {
              await runner.terminate();
              await rm(poolDirectory, { recursive: true, force: true });
            },
          };
        },
      });
      this.contextPools.set(key, pool);
    }
    return await pool.createDriver(key, {
      browserSessionId: context.browserSessionId,
      controllerGeneration: context.controllerGeneration,
      resolveWorkspaceFiles: context.resolveWorkspaceFiles,
      downloadDirectory: context.downloadDirectory,
      ...(context.downloadEvents ? { downloadEvents: context.downloadEvents } : {}),
      ...(context.passkeys ? { passkeys: context.passkeys } : {}),
    });
  }

  static async open(options: BrowserSupervisorOptions): Promise<BrowserSupervisor> {
    const supervisor = new BrowserSupervisor(options);
    await mkdir(join(supervisor.rootDirectory, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(supervisor.rootDirectory, 0o700);
    if (!options.createDriver) {
      await reapManagedBrowserProcesses(supervisor.rootDirectory, async (directory) => {
        // A durable launch/retirement history can include an accepted unknown
        // outcome. Startup has no current human admission to settle it. Keep
        // that exact directory; explicit bound cleanup remains authoritative.
        try {
          await lstat(join(directory, "working-runtime.sqlite"));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      });
      // Launcher daemons an earlier release left behind after their browser
      // ended serve nothing and never exit on their own. Startup must not
      // fail because one of them could not be stopped.
      await reapOrphanedAgentBrowserDaemons(supervisor.rootDirectory).catch(() => 0);
    }
    // Browsers an earlier controller handed off and nobody used since are
    // stopped now rather than at the first sweep; recent ones are counted so
    // this controller is not stopped as empty before their idle time ends.
    void supervisor.releaseDetachedBrowsers();
    // Cleanup a crashed controller left undone in a person's own Chrome.
    void supervisor.releaseAttachedLeftovers();
    return supervisor;
  }

  async createSession(
    optionsInput: BrowserSupervisorSessionOptions,
  ): Promise<BrowserSupervisorSession> {
    this.assertOpen();
    const options = validateSessionOptions(optionsInput);
    if (
      options.transport.kind === "managed" &&
      options.transport.ephemeralPartition &&
      !this.ephemeralContextPoolEnabled
    ) {
      throw new InteractionControllerError(
        "unsupported",
        "ephemeral browser contexts are disabled by the operator",
      );
    }
    const request = this.createValidatedSession(options);
    this.creationRequests.add(request);
    try {
      return await request;
    } finally {
      this.creationRequests.delete(request);
      options.restore?.dataKey.fill(0);
      options.restore?.aad.fill(0);
    }
  }

  /** Read-only evidence about a preserved working copy that this controller
   * holds no runtime for: its manifest digest, latest receipt and whether it
   * can be adopted. Inspection never settles or changes an adoption, and
   * writes nothing except SQLite's own shared-memory index of the
   * controller journal, which is not part of the working copy. */
  async inspectWorkingCopy(
    input: BrowserWorkingCopyAuthorityInput,
  ): Promise<BrowserWorkingCopyInspection> {
    this.assertOpen();
    const paths = adoptionPaths(this.rootDirectory, input.browserSessionId);
    const blocking = this.adopting.has(input.browserSessionId)
      ? ("in_flight" as const)
      : await observeActiveAdoption(paths);
    const evidence = await this.workingCopyEvidence(input);
    return {
      ...evidence,
      platformSupported: process.platform === "linux",
      activeAdoption:
        blocking && typeof blocking !== "string"
          ? await workingCopyAdoptionStatus(paths, blocking)
          : null,
      refusal:
        process.platform !== "linux"
          ? "unsupported_platform"
          : blocking
            ? "adoption_unresolved"
            : evidence.refusal,
    };
  }

  /** Adopt the exact approved bytes of a preserved working copy. See
   * working-copy-adoption.ts for the durable protocol. A new adoption checks
   * that the browser is stopped and its copy adoptable while it holds the
   * working directory lock, so no launch or end can start in between. */
  async adoptWorkingCopy(
    input: BrowserWorkingCopyAuthorityInput & { operationId: string; manifestDigest: string },
  ): Promise<BrowserWorkingCopyAdoptionStatus> {
    this.assertOpen();
    if (process.platform !== "linux") {
      throw new WorkingCopyAdoptionError(
        "unsupported_platform",
        "working copy adoption is supported only on Linux controllers",
      );
    }
    const paths = adoptionPaths(this.rootDirectory, input.browserSessionId);
    if (this.adopting.has(input.browserSessionId))
      throw workingCopyRefusalError("adoption_unresolved");
    this.assertNotRunning(input.browserSessionId);
    this.adopting.add(input.browserSessionId);
    try {
      return await workingCopyAdoptionStatus(paths, await this.performAdoption(paths, input));
    } finally {
      this.adopting.delete(input.browserSessionId);
    }
  }

  /** Revert an unfinished adoption under the browser's current authority:
   * the browser's own directory goes back to its live path and the staged
   * copy is kept. See revertWorkingCopyAdoption. */
  async revertWorkingCopyAdoption(
    input: BrowserWorkingCopyAuthorityInput & { operationId: string },
  ): Promise<{ inFlight: false; adoption: BrowserWorkingCopyAdoptionStatus }> {
    this.assertOpen();
    const paths = adoptionPaths(this.rootDirectory, input.browserSessionId);
    if (this.adopting.has(input.browserSessionId))
      throw workingCopyRefusalError("adoption_unresolved");
    this.assertNotRunning(input.browserSessionId);
    this.adopting.add(input.browserSessionId);
    try {
      // The same shape as workingCopyAdoptionStatus: this call held the
      // browser's adoption claim until now, so nothing is in flight.
      const adoption = await workingCopyAdoptionStatus(
        paths,
        await revertWorkingCopyAdoption(paths, {
          operationId: input.operationId,
          authority: adoptionAuthority(input),
          ...(this.afterAdoptionPhase ? { afterPhase: this.afterAdoptionPhase } : {}),
        }),
      );
      return { inFlight: false, adoption };
    } finally {
      this.adopting.delete(input.browserSessionId);
    }
  }

  private assertNotRunning(browserSessionId: string) {
    if (
      this.endingWorkingCopies.has(browserSessionId) ||
      this.sessions.has(browserSessionId) ||
      this.creating.has(browserSessionId)
    )
      throw workingCopyRefusalError("browser_running");
  }

  private async performAdoption(
    paths: ReturnType<typeof adoptionPaths>,
    input: BrowserWorkingCopyAuthorityInput & { operationId: string; manifestDigest: string },
  ) {
    return await adoptWorkingCopy(paths, {
      operationId: input.operationId,
      browserSessionId: input.browserSessionId,
      authority: adoptionAuthority(input),
      manifestDigest: input.manifestDigest,
      ...(this.afterAdoptionPhase ? { afterPhase: this.afterAdoptionPhase } : {}),
      beforeIntent: async () => {
        this.assertNotRunning(input.browserSessionId);
        const evidence = await this.workingCopyEvidence(input);
        if (evidence.refusal) throw workingCopyRefusalError(evidence.refusal);
      },
      appendReceipt: async (stagingDirectory) => {
        await assertWorkingCopyJournalsIntact(stagingDirectory);
        const writer = await SqliteBrowserWorkingRuntimeJournal.open({
          browserSessionId: input.browserSessionId,
          controllerGeneration: input.controllerGeneration,
          sessionDirectory: stagingDirectory,
        });
        try {
          const latest = writer.latest();
          if (!latest) throw workingCopyRefusalError("receipt_not_adoptable");
          const source =
            latest.intent === "adopt" && latest.adoption?.operationId === input.operationId
              ? null
              : latest;
          if (source && !adoptableSourceReceipt(source))
            throw workingCopyRefusalError("receipt_not_adoptable");
          if (source && JSON.stringify(source.authority) !== JSON.stringify(input.authority))
            throw workingCopyRefusalError("authority_changed");
          writer.adopt({
            source: source ?? latest,
            operationId: input.operationId,
            manifestDigest: input.manifestDigest,
            sourceProfile: await assertDirectory(
              join(this.rootDirectory, "sessions", input.browserSessionId, "profile"),
            ),
            profile: await assertDirectory(join(stagingDirectory, "profile")),
          });
        } finally {
          writer.close();
        }
      },
    });
  }

  /** Status of one adoption by its operation id, read without changing
   * anything. A missing record proves the operation changed nothing here,
   * because the record precedes every side effect. A recorded adoption that
   * stopped part way is reported in its recorded phase; retrying the same
   * adoption under the authority that approved it, or a launch under that
   * authority, settles it, and a revert puts the browser's own directory
   * back. It is in flight while it holds the browser's active claim and an
   * operation in any process holds the working directory lock. */
  async workingCopyAdoptionStatus(input: {
    browserSessionId: string;
    operationId: string;
  }): Promise<{ inFlight: boolean; adoption: BrowserWorkingCopyAdoptionStatus | null }> {
    this.assertOpen();
    const paths = adoptionPaths(this.rootDirectory, input.browserSessionId);
    const inFlight =
      (this.adopting.has(input.browserSessionId) ||
        (await readActiveAdoption(paths)) === input.operationId) &&
      (await adoptionLocked(paths));
    const record = await readAdoptionRecord(paths, input.operationId);
    return {
      inFlight,
      adoption: record ? await workingCopyAdoptionStatus(paths, record) : null,
    };
  }

  /** Run `body` as the single owner of a browser's working directory: it
   * holds the directory lock (see withWorkingDirectoryLock) for its whole
   * duration, after proving no adoption owns the directory. An adoption,
   * revert, launch or end in any process that holds the lock makes this
   * refuse as busy; a recorded adoption that is not finished makes it refuse
   * as unresolved. With the launch's authority, a recorded adoption that
   * authority approved is carried forward first. */
  private async withOwnedWorkingDirectory<T>(
    operation: "end" | "launch",
    options: {
      browserSessionId: string;
      controllerGeneration?: string;
      workingRuntimeAuthority?: BrowserWorkingRuntimeAuthority | undefined;
    },
    body: () => Promise<T>,
  ): Promise<T> {
    if (this.adopting.has(options.browserSessionId))
      throw workingRuntimeUnavailable("working_directory_busy");
    const paths = adoptionPaths(this.rootDirectory, options.browserSessionId);
    const authority =
      options.workingRuntimeAuthority && options.controllerGeneration !== undefined
        ? adoptionAuthority({
            controllerGeneration: options.controllerGeneration,
            authority: options.workingRuntimeAuthority,
          })
        : null;
    const result = await withWorkingDirectoryLock(paths, async () => {
      if (await activeAdoptionLocked(paths, authority))
        throw workingRuntimeUnavailable("adoption_unresolved");
      await this.afterWorkingDirectoryClaim?.(operation, options.browserSessionId);
      return { value: await body() };
    });
    if (result === ADOPTION_IN_FLIGHT) throw workingRuntimeUnavailable("working_directory_busy");
    return result.value;
  }

  /** Run an end, retire or set-aside of a preserved working copy as the
   * single owner of its directory (see withOwnedWorkingDirectory). The
   * browser is also marked in this process, so an adoption here refuses as
   * running before it even tries the lock. */
  private async whileNoAdoption(browserSessionId: string, body: () => Promise<void>) {
    const marked = !this.endingWorkingCopies.has(browserSessionId);
    this.endingWorkingCopies.add(browserSessionId);
    try {
      await this.withOwnedWorkingDirectory("end", { browserSessionId }, body);
    } finally {
      if (marked) this.endingWorkingCopies.delete(browserSessionId);
    }
  }

  private async workingCopyEvidence(
    input: BrowserWorkingCopyAuthorityInput,
  ): Promise<Omit<BrowserWorkingCopyInspection, "platformSupported" | "activeAdoption">> {
    if (this.sessions.has(input.browserSessionId) || this.creating.has(input.browserSessionId)) {
      return emptyWorkingCopyEvidence(input, "browser_running");
    }
    const sessionDirectory = join(this.rootDirectory, "sessions", input.browserSessionId);
    const profileDirectory = join(sessionDirectory, "profile");
    let profile: { device: number; inode: number };
    try {
      await assertDirectory(sessionDirectory);
      profile = await assertDirectory(profileDirectory);
    } catch {
      return emptyWorkingCopyEvidence(input, "working_copy_invalid");
    }
    let receipt: BrowserWorkingRuntimeReceipt | null;
    try {
      const reader = await SqliteBrowserWorkingRuntimeJournal.open(
        { ...input, sessionDirectory },
        true,
      );
      try {
        receipt = reader.latest();
      } finally {
        reader.close();
      }
    } catch {
      return {
        ...emptyWorkingCopyEvidence(input, "working_copy_invalid"),
        currentProfile: profile,
      };
    }
    let profileInUse: boolean | null;
    try {
      await this.assertProfileUnused(profileDirectory);
      profileInUse = false;
    } catch {
      profileInUse = process.platform === "linux" ? true : null;
    }
    const authorityMatches =
      receipt !== null && JSON.stringify(receipt.authority) === JSON.stringify(input.authority);
    const identityMatches =
      receipt !== null &&
      receipt.profile.device === profile.device &&
      receipt.profile.inode === profile.inode;
    const refusal: BrowserWorkingCopyRefusal | null = !receipt
      ? "receipt_not_adoptable"
      : !adoptableSourceReceipt(receipt) ||
          receipt.process?.profileDirectory !== resolve(profileDirectory)
        ? "receipt_not_adoptable"
        : !authorityMatches
          ? "authority_changed"
          : profileInUse !== false
            ? "process_state_unknown"
            : identityMatches
              ? "adoption_not_needed"
              : null;
    const manifest = refusal === null ? await workingCopyManifest(sessionDirectory) : null;
    return {
      browserSessionId: input.browserSessionId,
      controllerGeneration: input.controllerGeneration,
      manifest,
      currentProfile: profile,
      receipt: receipt
        ? {
            operationId: receipt.operationId,
            intent: receipt.intent,
            state: receipt.state,
            recordedProfile: receipt.profile,
            restoreAuthorityDigest: receipt.restoreAuthorityDigest,
            directoryLaunchAllowed: receipt.directoryLaunchAllowed,
            authorityMatches,
            adoption: receipt.adoption ?? null,
          }
        : null,
      profileIdentityMatches: identityMatches,
      profileInUse,
      refusal,
    };
  }

  private async createValidatedSession(
    options: ValidatedBrowserSupervisorSessionOptions,
  ): Promise<BrowserSupervisorSession> {
    await this.retireTerminalSessions();
    // A handed-off browser being stopped for idleness is never adopted while
    // it dies; its recovery relaunches it once the stop settles. The check
    // must not yield when nothing is being stopped, so the claim below stays
    // atomic with it.
    for (
      let releasing = this.releasingDetached.get(options.browserSessionId);
      releasing;
      releasing = this.releasingDetached.get(options.browserSessionId)
    ) {
      await releasing.catch(() => undefined);
    }
    const active = this.sessions.get(options.browserSessionId);
    if (active) {
      this.assertSameBinding(active, options);
      await this.recordWorkingAuthority(active, options);
      return {
        ...binding(active),
        observation: await this.currentObservation(active),
      };
    }
    const pending = this.creating.get(options.browserSessionId);
    if (pending) {
      const runtime = await pending;
      this.assertSameBinding(runtime, options);
      await this.recordWorkingAuthority(runtime, options);
      return {
        ...binding(runtime),
        observation: await this.currentObservation(runtime),
      };
    }
    if (this.sessions.size + this.creating.size >= this.maxSessions) {
      throw new InteractionControllerError(
        "capacity_exhausted",
        `This machine is already running its limit of ${this.maxSessions} managed browsers. End browser sessions that are no longer needed, then open a new one; retrying will not help until one ends.`,
      );
    }
    const creation = this.buildRuntime(options);
    this.creating.set(options.browserSessionId, creation);
    try {
      const runtime = await creation;
      if (this.closed) {
        try {
          await this.disposeRuntime(runtime, false);
        } catch (error) {
          this.cleanupUncertain = true;
          throw error;
        }
        throw new InteractionControllerError(
          "resource_unavailable",
          "browser supervisor is closed",
        );
      }
      // This controller holds the browser now; an earlier handoff record
      // must not outlive that.
      await removeDetachedBrowserRecord(runtime.sessionDirectory).catch(() => undefined);
      this.sessions.set(options.browserSessionId, runtime);
      const observation = runtime.creationObservation ?? (await this.currentObservation(runtime));
      runtime.creationObservation = null;
      const notice = runtime.driver.networkNotice;
      return {
        ...binding(runtime),
        observation,
        ...(notice ? { notice } : {}),
      };
    } finally {
      if (this.creating.get(options.browserSessionId) === creation) {
        this.creating.delete(options.browserSessionId);
      }
    }
  }

  /** Update safety includes work hidden from the public active-session list.
   * An open session does not by itself make a restart unsafe: a quiescent
   * managed session with a completed working-runtime launch is preserved by
   * graceful shutdown and reattached on its next causal request, and a session
   * whose driver already ended has nothing left to lose. A quiescent attached
   * Chrome session is likewise left intact in the user's browser. Any other
   * session (external providers, launches without a durable working runtime),
   * a JavaScript dialog an agent has yet to answer, or any admitted command
   * still blocks. */
  isIdle(): boolean {
    return this.updateBlockers().length === 0;
  }

  updateBlockers(): UpdateBlocker[] {
    const blockers: UpdateBlocker[] = [];
    if (this.cleanupUncertain) blockers.push({ kind: "browser_cleanup", count: 1 });
    // Each admitted creation is also a creation request. These are overlapping
    // ownership views, not two distinct openings.
    const openings = Math.max(this.creationRequests.size, this.creating.size);
    if (openings) blockers.push({ kind: "browser_creation", count: openings });
    for (const resourceId of this.ending.keys())
      blockers.push({ kind: "browser_closing", resourceId, count: 1 });
    if (this.stateTransferTails.size)
      blockers.push({ kind: "browser_state_transfer", count: this.stateTransferTails.size });
    for (const runtime of this.sessions.values()) {
      // A restart in the middle of a task fails the agent's next calls while
      // it lasts, even for a session that survives it. A session used within
      // the hold is mid-task, so the update waits for a pause.
      if (
        runtime.lifecycle === "active" &&
        runtime.controller.isIdle() &&
        this.now() - runtime.lastUsedAt < RECENT_USE_UPDATE_HOLD_MS
      ) {
        blockers.push({
          kind: "browser_recent_use",
          resourceId: runtime.options.browserSessionId,
          count: 1,
        });
        continue;
      }
      if (restartPreservesRuntime(runtime)) continue;
      const kind =
        runtime.recovery !== null
          ? "browser_recovery"
          : runtime.externalAuthTail !== null
            ? "browser_authentication"
            : !runtime.controller.isIdle()
              ? "browser_action"
              : "browser_session";
      blockers.push({ kind, resourceId: runtime.options.browserSessionId, count: 1 });
    }
    return blockers;
  }

  /** No session of any lifecycle remains and no work is in flight. */
  isEmpty(): boolean {
    return (
      this.sessions.size === 0 &&
      this.detachedWaiting === 0 &&
      this.detachedSweep === null &&
      this.attachedSweep === null &&
      this.isIdle()
    );
  }

  listSessions(): BrowserSessionReference[] {
    return [...this.sessions.values()]
      .filter(
        (runtime) =>
          (runtime.lifecycle === "active" || runtime.lifecycle === "recovering") &&
          !runtime.driver.isTerminal?.(),
      )
      .map(binding);
  }

  async listTargets(reference: BrowserSessionReference): Promise<BrowserTarget[]> {
    const runtime = this.requireActive(reference);
    const targets = await this.readWithRecovery(runtime, async () => {
      return await runtime.driver.listTargets();
    });
    this.rememberTargets(runtime, targets);
    return targets;
  }

  async openTarget(reference: BrowserSessionReference, url?: string): Promise<BrowserObservation> {
    const runtime = this.requireActive(reference);
    const observation = await this.mutateWithRecovery(runtime, async () => {
      return await runtime.driver.openTarget(url);
    });
    this.rememberObservation(runtime, observation);
    this.noteRecordingTarget(runtime, "open_tab", observation.target.id, {
      url: observation.target.url,
    });
    return observation;
  }

  async openTargetWithInventory(
    reference: BrowserSessionReference,
    url?: string,
  ): Promise<BrowserTarget[]> {
    const runtime = this.requireActive(reference);
    const open = runtime.driver.openTargetWithInventory;
    if (!open) {
      throw new InteractionControllerError(
        "unsupported",
        "browser driver does not support metadata-only tab opening",
      );
    }
    const targets = await this.mutateWithRecovery(runtime, async () => {
      return await open.call(runtime.driver, url);
    });
    this.rememberTargets(runtime, targets);
    return targets;
  }

  async selectTarget(
    reference: BrowserSessionReference,
    targetId: string,
  ): Promise<BrowserObservation> {
    const runtime = this.requireActive(reference);
    const observation = await this.mutateWithRecovery(runtime, async () => {
      return await runtime.driver.selectTarget(targetId);
    });
    this.rememberObservation(runtime, observation);
    this.noteRecordingTarget(runtime, "select_tab", observation.target.id, {
      url: observation.target.url,
    });
    return observation;
  }

  async closeTarget(
    reference: BrowserSessionReference,
    targetId: string,
  ): Promise<BrowserTarget[]> {
    const runtime = this.requireActive(reference);
    const targets = await this.mutateWithRecovery(runtime, async () => {
      return await runtime.driver.closeTarget(targetId);
    });
    this.rememberTargets(runtime, targets);
    return targets;
  }

  async observe(reference: BrowserSessionReference, targetId: string): Promise<BrowserObservation> {
    const runtime = this.requireActive(reference);
    const observation = await this.readWithRecovery(runtime, async () => {
      return await runtime.controller.observe(targetId);
    });
    this.rememberObservation(runtime, observation);
    return observation;
  }

  async targetState(
    reference: BrowserSessionReference,
    targetId: string,
  ): Promise<BrowserTargetState> {
    const runtime = this.requireActive(reference);
    return await this.readWithRecovery(
      runtime,
      async () => await runtime.driver.targetState(targetId),
    );
  }

  async readDom(
    reference: BrowserSessionReference,
    targetId: string,
    request: BrowserDomReadRequest,
  ): Promise<BrowserDomReadResponse> {
    const runtime = this.requireActive(reference);
    return await this.readWithRecovery(
      runtime,
      async () => await runtime.driver.readDom(targetId, request),
    );
  }

  readClipboard(reference: BrowserSessionReference): BrowserClipboard {
    return this.requireActive(reference).driver.readClipboard();
  }

  async action(command: BrowserActionCommand): Promise<BrowserActionReceipt> {
    const runtime = this.requireActive({
      browserSessionId: command.browserSessionId,
      controllerGeneration: command.controllerGeneration,
    });
    // Logged as the agent sent it: secret references are not resolved here.
    this.noteRecordingTarget(runtime, "action", command.targetId, { action: command.action });
    const receipt = await this.presented(
      runtime,
      async () => await runtime.controller.run(command),
    );
    if (receipt.observation) this.rememberObservation(runtime, receipt.observation);
    if (receipt.error?.code === "controller_lost" || receipt.error?.code === "driver_failed") {
      await this.recoverIfUnavailable(runtime).catch(() => false);
    }
    if (
      browserActionUsesWorkspaceFiles(command.action) &&
      receipt.state === "failed" &&
      receipt.dispatchedAt === null
    ) {
      await runtime.workspaceFileStager.discard(command.operationId).catch(() => undefined);
    }
    return receipt;
  }

  async stageWorkspaceFiles(
    reference: BrowserSessionReference,
    request: BrowserWorkspaceFileStageRequest,
  ): Promise<BrowserWorkspaceFileStageResponse> {
    return await this.requireActive(reference).workspaceFileStager.stage(request);
  }

  /** Controller-private: load the session's passkeys and drain its events. */
  async passkeySync(request: BrowserPasskeySyncRequest): Promise<BrowserPasskeySyncResponse> {
    const runtime = this.requireActive({
      browserSessionId: request.browserSessionId,
      controllerGeneration: request.controllerGeneration,
    });
    const passkeys = runtime.driverContext.passkeys;
    if (!passkeys) {
      throw new InteractionControllerError(
        "unsupported",
        "this browser placement does not support passkeys",
      );
    }
    return await passkeys.sync(request);
  }

  externalAuth(command: BrowserExternalAuthCommand): Promise<BrowserExternalAuthResultValue> {
    this.assertOpen();
    const runtime = this.requireBound({
      browserSessionId: command.browserSessionId,
      controllerGeneration: command.controllerGeneration,
    });
    const previous = runtime.externalAuthTail ?? Promise.resolve();
    const operation = previous.then(
      async () =>
        await this.presented(runtime, async () => await this.performExternalAuth(runtime, command)),
    );
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    runtime.externalAuthTail = tail;
    void tail.finally(() => {
      if (runtime.externalAuthTail === tail) runtime.externalAuthTail = null;
    });
    return operation;
  }

  receipt(reference: BrowserSessionReference, operationId: string): BrowserActionReceipt | null {
    return this.requireBound(reference).controller.receipt(operationId);
  }

  async screenshot(
    reference: BrowserSessionReference,
    targetId: string,
    options?: BrowserScreenshotOptions,
  ): Promise<BrowserImageFrame> {
    const runtime = this.requireActive(reference);
    return await this.readWithRecovery(runtime, async () => {
      return await runtime.driver.captureScreenshot(targetId, options);
    });
  }

  async subscribeFrames(
    reference: BrowserSessionReference,
    targetId: string,
    options?: BrowserFrameStreamOptions,
  ): Promise<BrowserFrameSubscription> {
    const runtime = this.requireActive(reference);
    // A live view keeps the windows presented for as long as it is open.
    const release = await this.acquirePresence(runtime);
    try {
      const subscription = await this.readWithRecovery(runtime, async () => {
        return await runtime.driver.subscribeFrames(targetId, options);
      });
      return releaseOnClose(subscription, release);
    } catch (error) {
      release();
      throw error;
    }
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
    const runtime = this.requireActive(reference);
    return await this.readWithRecovery(runtime, async () => {
      return await runtime.driver.debug(targetId, options);
    });
  }

  async listDownloads(reference: BrowserSessionReference): Promise<BrowserDownload[]> {
    const store = this.requireActive(reference).downloadStore;
    if (!store) {
      throw new InteractionControllerError(
        "unsupported",
        "Lightpanda browsers do not expose downloads",
      );
    }
    return await store.list();
  }

  async getDownload(
    reference: BrowserSessionReference,
    downloadId: string,
  ): Promise<BrowserDownload | null> {
    const store = this.requireActive(reference).downloadStore;
    if (!store) {
      throw new InteractionControllerError(
        "unsupported",
        "Lightpanda browsers do not expose downloads",
      );
    }
    return await store.get(downloadId);
  }

  async completedDownloadFile(
    reference: BrowserSessionReference,
    downloadId: string,
  ): Promise<CompletedBrowserDownloadFile> {
    const store = this.requireActive(reference).downloadStore;
    if (!store) {
      throw new InteractionControllerError(
        "unsupported",
        "browser placement cannot publish device-local downloads",
      );
    }
    return await store.completedFile(downloadId);
  }

  async exportDownload(
    reference: BrowserSessionReference,
    requestInput: BrowserDownloadExportRequestValue,
  ): Promise<BrowserDownloadExportReceiptValue> {
    const request = BrowserDownloadExportRequest.parse(requestInput);
    const store = this.requireActive(reference).downloadStore;
    if (!store) {
      throw new InteractionControllerError(
        "unsupported",
        "browser placement cannot publish device-local downloads",
      );
    }
    return await store.export(request, this.uploadDownload);
  }

  /** Starts recording the session's tab; the recording follows the agent to
   * other tabs it acts on, opens or selects. One recording at a time. */
  async startRecording(
    reference: BrowserSessionReference,
    targetId: string,
  ): Promise<RecordingSummary> {
    const runtime = this.requireActive(reference);
    if (runtime.recording?.isRecording) {
      throw new InteractionControllerError(
        "operation_conflict",
        "this browser is already recording; stop that recording first",
      );
    }
    const source = this.recordingSourceFor(runtime);
    const previous = runtime.recording;
    runtime.recording = null;
    await previous?.discard();
    const release = await this.acquirePresence(runtime);
    runtime.recording = await BrowserRecording.start({
      directory: join(runtime.sessionDirectory, "recordings"),
      targetId,
      source,
      releasePresence: release,
    });
    return runtime.recording.summary();
  }

  async stopRecording(
    reference: BrowserSessionReference,
    recordingId: string,
  ): Promise<RecordingSummary> {
    return await this.requireRecording(reference, recordingId).stop("requested");
  }

  recordingStatus(reference: BrowserSessionReference, recordingId: string): RecordingSummary {
    return this.requireRecording(reference, recordingId).summary();
  }

  /** Uploads a stopped recording's bundle through a narrow object grant. */
  async exportRecording(
    reference: BrowserSessionReference,
    recordingId: string,
    upload: BrowserDownloadExportRequestValue["upload"],
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const bundle = this.requireRecording(reference, recordingId).exportable();
    await this.uploadDownload(bundle.path, upload, {
      sizeBytes: bundle.sizeBytes,
      sha256: bundle.sha256,
    });
    return { sizeBytes: bundle.sizeBytes, sha256: bundle.sha256 };
  }

  private requireRecording(
    reference: BrowserSessionReference,
    recordingId: string,
  ): BrowserRecording {
    const recording = this.requireBound(reference).recording;
    if (!recording || recording.recordingId !== recordingId) {
      throw new InteractionControllerError("resource_not_found", "recording not found");
    }
    return recording;
  }

  private recordingSource(runtime: Runtime): RecordingFrameSource {
    const driver = runtime.driver;
    const record = driver.recordFrames;
    if (!record) {
      throw new InteractionControllerError("unsupported", "this browser cannot record video");
    }
    return async (targetId, onFrame, onEnd) => await record.call(driver, targetId, onFrame, onEnd);
  }

  /** Logs a tab the agent used and keeps the recording on the current
   * browser after recovery replaced it. */
  private noteRecordingTarget(
    runtime: Runtime,
    kind: "action" | "open_tab" | "select_tab",
    targetId: string,
    detail: { url?: string; action?: unknown } = {},
  ): void {
    const recording = runtime.recording;
    if (!recording?.isRecording) return;
    try {
      recording.rebind(this.recordingSourceFor(runtime));
    } catch {
      /* The replacement browser cannot record; keep what was captured. */
    }
    recording.noteTarget(kind, targetId, detail);
  }

  private readonly recordingSources = new WeakMap<BrowserSupervisorDriver, RecordingFrameSource>();

  private recordingSourceFor(runtime: Runtime): RecordingFrameSource {
    const existing = this.recordingSources.get(runtime.driver);
    if (existing) return existing;
    const source = this.recordingSource(runtime);
    this.recordingSources.set(runtime.driver, source);
    return source;
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
    options: {
      removeState?: boolean;
      /** The person explicitly ends this browser after its controller lost
       * it: discard a preserved working runtime instead of refusing. Cleanup
       * paths (a failed or expired resume) never set this, so a possibly
       * accepted launch stays preserved for recovery there. */
      discardWorkingRuntime?: boolean;
      /** The control plane is returning an expired resume to its checkpoint:
       * when this generation's launch never recorded completion and no
       * process runs its profile, move its whole session directory aside
       * intact instead of refusing. Nothing is deleted. */
      setAsideInterruptedLaunch?: boolean;
    } = {},
  ): Promise<void> {
    return await this.finishSession(reference, options, false);
  }

  private async finishSession(
    reference: BrowserSessionReference,
    options: {
      removeState?: boolean;
      discardWorkingRuntime?: boolean;
      setAsideInterruptedLaunch?: boolean;
    },
    suspendForShutdown: boolean,
  ): Promise<void> {
    if (!isUuid(reference.browserSessionId)) throw new Error("browserSessionId must be a UUID");
    const pending = this.creating.get(reference.browserSessionId);
    if (pending) await pending;
    const stateTransfer = this.stateTransferTails.get(reference.browserSessionId);
    if (stateTransfer) await stateTransfer.catch(() => undefined);
    if (!this.sessions.has(reference.browserSessionId)) {
      for (
        let releasing = this.releasingDetached.get(reference.browserSessionId);
        releasing;
        releasing = this.releasingDetached.get(reference.browserSessionId)
      ) {
        await releasing.catch(() => undefined);
      }
      const sessionDirectory = join(this.rootDirectory, "sessions", reference.browserSessionId);
      // An attached session released earlier: its end still cleans up what
      // the release could not, then forgets the session's tabs.
      if (!suspendForShutdown) await this.endReleasedAttachedSession(sessionDirectory);
      let workingRuntimePresent = true;
      try {
        await lstat(join(sessionDirectory, "working-runtime.sqlite"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        workingRuntimePresent = false;
      }
      // Missing memory cannot acknowledge cleanup of a possibly accepted
      // launch. Its exact binding/holder must stay addressable for cleanup,
      // unless this generation's latest launch provably never completed, or
      // the control plane explicitly discards this exact generation: a
      // person's end (removing its state) or the retirement of a browser
      // whose task moved to another machine (keeping its state on disk).
      if (workingRuntimePresent) {
        await this.whileNoAdoption(reference.browserSessionId, async () => {
          if (options.discardWorkingRuntime === true && !suspendForShutdown) {
            await this.retireNonResidentWorkingRuntime(
              reference,
              sessionDirectory,
              options.removeState === true,
            );
          } else if (
            options.removeState === true &&
            options.setAsideInterruptedLaunch === true &&
            !suspendForShutdown
          ) {
            await this.setAsideInterruptedLaunch(reference, sessionDirectory);
          } else {
            await this.cleanupAbandonedLaunch(
              reference,
              sessionDirectory,
              options.removeState === true,
            );
          }
        });
        return;
      }
    }
    const usedAt = this.sessions.get(reference.browserSessionId)?.lastUsedAt;
    const runtime = this.requireBound(reference);
    // A controller shutdown is not a use: the handoff record keeps the time
    // of the browser's last real request.
    if (suspendForShutdown && usedAt !== undefined) runtime.lastUsedAt = usedAt;
    if (runtime.externalAuthTail) await runtime.externalAuthTail;
    const existing = this.ending.get(reference.browserSessionId);
    if (existing) {
      await existing;
      // An explicit end must never acknowledge a recoverable shutdown as retirement.
      if (!suspendForShutdown && runtime.workingReceipt?.intent === "suspend")
        throw workingRuntimeUnavailable();
      return;
    }
    if (runtime.recovery) await runtime.recovery.catch(() => undefined);
    const raced = this.ending.get(reference.browserSessionId);
    if (raced) {
      await raced;
      if (!suspendForShutdown && runtime.workingReceipt?.intent === "suspend")
        throw workingRuntimeUnavailable();
      return;
    }
    const driverAlreadyClosed = runtime.lifecycle === "captured";
    const preserveWorkingRuntime = suspendForShutdown && hasPreservableWorkingRuntime(runtime);
    runtime.lifecycle = "ending";
    const ending = (async () => {
      if (runtime.driver.isTerminal?.() || preserveWorkingRuntime) {
        // Settle already-dispatched commands before their durable journals close.
        // lifecycle=ending fences queued/new dispatches without replaying input.
        await runtime.controller.waitForIdle();
      }
      // Closing the driver also closes the empty tabs a session opened in the
      // person's own Chrome, on every path: an end, a shutdown or a restart.
      await this.disposeRuntime(
        runtime,
        options.removeState ?? false,
        driverAlreadyClosed,
        preserveWorkingRuntime,
      );
    })();
    this.ending.set(reference.browserSessionId, ending);
    try {
      await ending;
      this.sessions.delete(reference.browserSessionId);
      // An ended attached session will not continue in its tabs.
      if (!suspendForShutdown && runtime.options.transport.kind === "attached_chrome") {
        const ledger = readAttachedTabLedger(runtime.sessionDirectory);
        if (ledger?.settled) removeAttachedTabLedger(runtime.sessionDirectory);
      }
    } finally {
      if (this.ending.get(reference.browserSessionId) === ending) {
        this.ending.delete(reference.browserSessionId);
      }
    }
  }

  /** The end of an attached session no runtime holds (it was released): settle
   * whatever cleanup its release left, and forget its tabs once settled. */
  private async endReleasedAttachedSession(sessionDirectory: string): Promise<void> {
    const ledger = readAttachedTabLedger(sessionDirectory);
    if (!ledger) return;
    if (!ledger.settled && !(await this.settleAttachedLeftovers(ledger.browserSessionId))) return;
    removeAttachedTabLedger(sessionDirectory);
  }

  private async retireTerminalSessions(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((runtime) => runtime.driver.isTerminal?.())
        .map((runtime) => this.endSession(binding(runtime))),
    );
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closed = true;
    if (this.idleReleaseTimer) clearInterval(this.idleReleaseTimer);
    this.idleReleaseTimer = null;
    this.closePromise = this.performClose();
    return await this.closePromise;
  }

  private async performClose(): Promise<void> {
    await this.attachedSweep?.catch(() => undefined);
    await Promise.allSettled([...this.creationRequests]);
    await Promise.allSettled([...this.creating.values()]);
    // A browser already unused for the idle release time is stopped, not
    // handed off: its successor would only stop it later, and if its session
    // never returns nothing would. Its next request relaunches it as usual.
    await this.releaseIdleRuntimes().catch(() => undefined);
    const active = [...this.sessions.values()];
    const results = await Promise.allSettled(
      active.map(async (runtime) => await this.finishSession(binding(runtime), {}, true)),
    );
    const poolResults = await Promise.allSettled(
      [...this.contextPools.values()].map((pool) => pool.close()),
    );
    this.contextPools.clear();
    const failures = [...results, ...poolResults].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (this.cleanupUncertain)
      failures.push(new Error("previous browser cleanup remains unsettled"));
    if (failures.length > 0) {
      this.cleanupUncertain = true;
      throw new AggregateError(failures, "browser supervisor shutdown failed");
    }
  }

  /** A launch is the single owner of its browser's working directory from
   * the moment it decides which directory to use until its browser process
   * runs (or the launch fails): no adoption or end in any controller can
   * move the directory meanwhile. An adoption that owns the directory, and
   * is not one this launch's authority carries forward, refuses the launch;
   * the launch never falls back to anything else. */
  private async buildRuntime(options: ValidatedBrowserSupervisorSessionOptions): Promise<Runtime> {
    try {
      return await this.withOwnedWorkingDirectory(
        "launch",
        options,
        async () => await this.buildOwnedRuntime(options),
      );
    } catch (error) {
      throw browserLaunchFailure(error);
    }
  }

  private async buildOwnedRuntime(
    options: ValidatedBrowserSupervisorSessionOptions,
  ): Promise<Runtime> {
    const sessionDirectory = join(this.rootDirectory, "sessions", options.browserSessionId);
    const profileDirectory = join(sessionDirectory, "profile");
    const downloadDirectory = join(sessionDirectory, "downloads");
    const uploadDirectory = join(sessionDirectory, "uploads");
    if (
      !options.recoverExistingWorkingDirectory &&
      !options.restore &&
      eligibleWorkingRuntime(options) &&
      options.workingRuntimeAuthority
    ) {
      try {
        await lstat(join(sessionDirectory, "working-runtime.sqlite"));
        // A retry with no private recovery intent cannot execute a durable
        // completed or potentially accepted launch again after memory loss.
        throw workingRuntimeUnavailable();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let recoveredReceipt: BrowserWorkingRuntimeReceipt | null = null;
    // Whether this launch starts a new browser on a profile a previous browser
    // already ran, rather than reattaching to a live one.
    let relaunchesProfile = false;
    if (options.recoverExistingWorkingDirectory) {
      try {
        await assertDirectory(this.rootDirectory);
        await assertDirectory(join(this.rootDirectory, "sessions"));
        await assertDirectory(sessionDirectory);
        const profile = await assertDirectory(profileDirectory).catch(() => {
          throw workingRuntimeUnavailable("working_copy_invalid");
        });
        const reader = await SqliteBrowserWorkingRuntimeJournal.open(
          { ...options, sessionDirectory },
          true,
        );
        let receipt: BrowserWorkingRuntimeReceipt | null;
        let interruptedRecovery: InterruptedRecovery | null;
        try {
          receipt = reader.latest();
          interruptedRecovery = reader.interruptedRecovery(receipt);
        } finally {
          reader.close();
        }
        if (
          interruptedRecovery &&
          receipt &&
          JSON.stringify(receipt.authority) === JSON.stringify(options.workingRuntimeAuthority) &&
          receipt.launchDigest === workingLaunchDigest(options) &&
          receipt.profile.device === profile.device &&
          receipt.profile.inode === profile.inode
        ) {
          // An earlier recovery of this browser was cut short, by a controller
          // restart or a failure whose cleanup could not reinstate it. The
          // receipt it started from is reinstated once its browser is provably
          // the same live process, or provably gone with no process using the
          // profile; an adopted copy whose browser is gone is resettled to its
          // copy below instead. A transport this controller could not detach
          // keeps the browser refused: another reattach would share it.
          if (this.recoveryTransportsUncertain.has(options.browserSessionId))
            throw workingRuntimeUnavailable("process_state_unknown");
          const recorded =
            interruptedRecovery.kind === "interrupted"
              ? interruptedRecovery.base.process
              : interruptedRecovery.receipt.process!;
          const state = await this.inspectOwnedProcess(recorded).catch(() => {
            throw workingRuntimeUnavailable("process_state_unknown");
          });
          if (state === "exited")
            await this.assertProfileUnused(profileDirectory).catch(() => {
              throw workingRuntimeUnavailable("process_state_unknown");
            });
          if (state === "live" || !receipt.adoption) {
            const writer = await SqliteBrowserWorkingRuntimeJournal.open({
              ...options,
              sessionDirectory,
            });
            try {
              receipt = writer.reinstate(interruptedRecovery);
            } finally {
              writer.close();
            }
          }
        }
        if (
          adoptedCopyNeedsResettle(receipt) &&
          JSON.stringify(receipt.authority) === JSON.stringify(options.workingRuntimeAuthority) &&
          receipt.launchDigest === workingLaunchDigest(options) &&
          receipt.profile.device === profile.device &&
          receipt.profile.inode === profile.inode
        ) {
          // A launch from an adopted copy was cut short by a controller
          // restart. Once no process provably uses the profile, the same
          // adopted copy becomes launchable again; it is never set aside for
          // an older checkpoint.
          await this.assertProfileUnused(profileDirectory).catch(() => {
            throw workingRuntimeUnavailable("process_state_unknown");
          });
          const writer = await SqliteBrowserWorkingRuntimeJournal.open({
            ...options,
            sessionDirectory,
          });
          try {
            receipt = writer.resettleAdoptedCopy(receipt);
          } finally {
            writer.close();
          }
        }
        assertWorkingRuntimeReceipt(
          receipt,
          options.workingRuntimeAuthority!,
          workingLaunchDigest(options),
          profile,
        );
        if (receipt.process.profileDirectory !== resolve(profileDirectory))
          throw workingRuntimeUnavailable("profile_identity_changed");
        if (receipt.intent === "adopt") {
          // An adopted copy is launched fresh in its own directory. The
          // process it was copied from is history, never reattached; the
          // exact profile must be unused by any process.
          await this.assertProfileUnused(profileDirectory).catch(() => {
            throw workingRuntimeUnavailable("process_state_unknown");
          });
          relaunchesProfile = true;
        } else {
          const state = await this.inspectOwnedProcess(receipt.process).catch(() => {
            throw workingRuntimeUnavailable("process_state_unknown");
          });
          if (state === "exited" && !receipt.directoryLaunchAllowed)
            throw workingRuntimeUnavailable("receipt_not_adoptable");
          relaunchesProfile = state === "exited";
        }
        recoveredReceipt = receipt;
        // Validate every path consumed by the existing writers before opening
        // any journal RW or creating a driver. Missing adjunct directories may
        // be recreated only after the exact profile/receipt proof above.
        for (const path of [downloadDirectory, uploadDirectory, join(downloadDirectory, "files")])
          await assertOptionalDirectory(path);
        for (const path of ["operations.sqlite", "state-transfers.sqlite"])
          await assertOptionalRegularFile(join(sessionDirectory, path));
        await assertOptionalRegularFile(join(downloadDirectory, "downloads.sqlite"));
      } catch (error) {
        throw error instanceof BrowserWorkingRuntimeUnavailableError && error.reason
          ? error
          : workingRuntimeUnavailable(
              error instanceof BrowserWorkingRuntimeUnavailableError
                ? undefined
                : "working_copy_invalid",
            );
      }
    }
    if (
      options.networkRoute?.kind === "proxy" &&
      !options.networkRoute.proxyUrl &&
      (!recoveredReceipt ||
        recoveredReceipt.intent === "adopt" ||
        (await this.inspectOwnedProcess(recoveredReceipt.process!)) === "exited")
    ) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "proxy authority is unavailable for a new browser launch",
        true,
      );
    }
    if (relaunchesProfile) {
      // When the previous browser on this profile never shut down (it was
      // lost, killed, or this is an adopted copy of a running one), Chromium
      // would skip restoring its tabs. A failure here costs only the tabs,
      // never the launch.
      await markProfileExitedCleanly(profileDirectory).catch(() => false);
    }
    for (const directory of [sessionDirectory, downloadDirectory, uploadDirectory]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    if (options.transport.kind === "managed" && options.transport.ephemeralPartition) {
      try {
        await writeFile(
          join(sessionDirectory, "ephemeral-generation.json"),
          JSON.stringify({
            controllerGeneration: options.controllerGeneration,
            partition: options.transport.ephemeralPartition,
          }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new InteractionControllerError(
          "controller_lost",
          "ephemeral context generation already issued; create a new session",
          false,
        );
      }
    }
    let restoredManifest: BrowserProfileManifest | null = null;
    let restoredCookies: HeadlessSessionCookies | undefined;
    let restoredProfileMaterialized = false;
    if (options.restore) {
      const restored = await materializeRestoredProfile({
        sessionDirectory,
        profileDirectory,
        restore: options.restore,
      });
      restoredManifest = restored.manifest;
      restoredCookies = restored.headlessSessionCookies;
      restoredProfileMaterialized = true;
    } else if (!recoveredReceipt) {
      await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
      await chmod(profileDirectory, 0o700);
    }
    const workspaceFileStager = await BrowserWorkspaceFileStager.open({
      rootDirectory: uploadDirectory,
    });
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
    let downloadStore: BrowserDownloadStore | null = null;
    if (
      options.transport.kind === "attached_chrome" ||
      (options.transport.kind === "managed" && options.transport.engine !== "lightpanda")
    ) {
      try {
        downloadStore = await BrowserDownloadStore.open({
          rootDirectory: downloadDirectory,
          browserSessionId: options.browserSessionId,
          controllerGeneration: options.controllerGeneration,
        });
      } catch (error) {
        journal.close();
        stateJournal.close();
        throw error;
      }
    }
    const driverContext: BrowserSupervisorDriverContext = {
      browserSessionId: options.browserSessionId,
      controllerGeneration: options.controllerGeneration,
      sessionDirectory,
      profileDirectory,
      restoredProfile: restoredProfileMaterialized,
      ...(recoveredReceipt && recoveredReceipt.intent !== "adopt"
        ? {
            recoverOwnedProcess: recoveredReceipt.process!,
            allowOwnedProcessLaunch: recoveredReceipt.directoryLaunchAllowed,
          }
        : {}),
      ...(restoredCookies ? { headlessSessionCookies: restoredCookies } : {}),
      downloadDirectory: downloadStore?.filesDirectory ?? downloadDirectory,
      headed: options.headed,
      transport: options.transport,
      resolveWorkspaceFiles: async (operationId, workspaceFileIds) =>
        await workspaceFileStager.resolve(operationId, workspaceFileIds),
      ...(downloadStore
        ? {
            downloadEvents: {
              begin: downloadStore.begin.bind(downloadStore),
              progress: downloadStore.progress.bind(downloadStore),
              reject: downloadStore.reject.bind(downloadStore),
            },
          }
        : {}),
      ...(options.browserExecutablePath
        ? { browserExecutablePath: options.browserExecutablePath }
        : {}),
      ...(options.linkedComputer ? { linkedComputer: options.linkedComputer } : {}),
      ...(options.launchEnvironment ? { launchEnvironment: options.launchEnvironment } : {}),
      ...(options.networkRoute ? { networkRoute: options.networkRoute } : {}),
      ...(this.passkeysEnabled && supportsPasskeys(options.transport)
        ? {
            passkeys: new BrowserPasskeyManager({
              browserSessionId: options.browserSessionId,
              controllerGeneration: options.controllerGeneration,
            }),
          }
        : {}),
    };
    let driver: BrowserSupervisorDriver | null = null;
    let workingJournal: SqliteBrowserWorkingRuntimeJournal | null = null;
    let workingReceipt: BrowserWorkingRuntimeReceipt | null = null;
    let workingReceiptCompleted = false;
    try {
      if (eligibleWorkingRuntime(options) && options.workingRuntimeAuthority) {
        workingJournal = await SqliteBrowserWorkingRuntimeJournal.open({
          ...options,
          sessionDirectory,
        });
        workingReceipt = workingJournal.begin(
          {
            browserSessionId: options.browserSessionId,
            controllerGeneration: options.controllerGeneration,
            intent: "launch",
            authority: options.workingRuntimeAuthority,
            launchDigest: workingLaunchDigest(options),
            restoreAuthorityDigest:
              recoveredReceipt?.restoreAuthorityDigest ?? restoreAuthorityDigest(options.restore),
            profile: await assertDirectory(profileDirectory),
            process: null,
            directoryLaunchAllowed: recoveredReceipt?.directoryLaunchAllowed ?? false,
            ...(recoveredReceipt?.adoption ? { adoption: recoveredReceipt.adoption } : {}),
          },
          recoveredReceipt?.operationId,
        );
      }
      driver = await this.createDriver(driverContext);
      const runtime: Runtime = {
        options: runtimeOptions(options),
        sessionDirectory,
        driverContext,
        journal,
        stateJournal,
        workingJournal,
        workingReceipt,
        driver,
        lifecycle: "active" as const,
        externalAuthTail: null,
        controller: null as unknown as BrowserInteractionController,
        workspaceFileStager,
        downloadStore,
        lastSnapshot: {
          engine:
            options.transport.kind === "attached_chrome"
              ? "chrome"
              : options.transport.kind === "managed"
                ? (options.transport.engine ?? "chromium")
                : "chromium",
          engineVersion: null,
          tabs: [],
        },
        lastTargets: [],
        creationObservation: null,
        recovery: null,
        presence: new Set(),
        recording: null,
        lastUsedAt: this.now(),
      };
      runtime.controller = this.createController(runtime, driver);
      // Startup and tab restoration are a use of the browser: nothing may park
      // its windows before they finish.
      const startupPresence = await this.acquirePresence(runtime);
      try {
        if (restoredManifest) {
          await restoreTabs(
            driver,
            options.initialUrl
              ? [{ url: options.initialUrl, selected: true }]
              : restoredManifest.tabs,
          );
          runtime.lastSnapshot = await driver.runtimeSnapshot();
          assertRestoredRuntimeCompatible(restoredManifest, runtime.lastSnapshot);
          runtime.lastTargets = await driver.listTargets();
          runtime.lastSnapshot = snapshotWithTargets(runtime.lastSnapshot, runtime.lastTargets);
        } else {
          const observation = await driver.start(options.initialUrl);
          runtime.creationObservation = observation;
          runtime.lastTargets = [observation.target];
          runtime.lastSnapshot = snapshotWithTargets(runtime.lastSnapshot, runtime.lastTargets);
        }
      } finally {
        startupPresence();
      }
      delete driverContext.headlessSessionCookies;
      if (workingJournal && workingReceipt) {
        let ownedProcess: OwnedManagedBrowserProcess | null = null;
        try {
          ownedProcess = (await driver.ownedProcessIdentity?.()) ?? null;
        } catch (error) {
          if (recoveredReceipt) throw error;
        }
        if (recoveredReceipt && !ownedProcess) throw workingRuntimeUnavailable();
        workingReceipt = {
          ...workingReceipt,
          directoryLaunchAllowed: driver.requiresExplicitProfileRestore !== true,
        };
        runtime.workingReceipt = workingJournal.complete(workingReceipt, ownedProcess);
        workingReceiptCompleted = true;
        if (recoveredReceipt)
          runtime.options.restoreAuthorityDigest = recoveredReceipt.restoreAuthorityDigest;
      }
      return runtime;
    } catch (error) {
      if (error instanceof UnsettledCleanupError) this.cleanupUncertain = true;
      const failures: unknown[] = [error];
      let driverClosed = driver === null;
      let restoredProfileRemoved = false;
      // A launch from an adopted copy started a new process; it is closed,
      // never detached, so the copy is provably unused again.
      const adoptedLaunch = recoveredReceipt?.intent === "adopt";
      try {
        if (recoveredReceipt && !adoptedLaunch) await driver?.detach?.();
        else await driver?.close();
        driverClosed = true;
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (restoredProfileMaterialized && driverClosed) {
        try {
          await rm(profileDirectory, { recursive: true, force: true });
          restoredProfileRemoved = true;
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      // A fresh launch (not a reattach) whose driver closed and whose restored
      // profile is gone can never be adopted. Settle its receipt failed so the
      // exact binding can be cleaned up and restored again from durable state.
      let launchReceiptSettled = false;
      if (
        workingJournal &&
        workingReceipt &&
        !workingReceiptCompleted &&
        !recoveredReceipt &&
        driverClosed &&
        (!restoredProfileMaterialized || restoredProfileRemoved)
      ) {
        try {
          workingReceipt = workingJournal.fail(workingReceipt, launchFailureCode(error));
          launchReceiptSettled = true;
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      // A failed launch from an adopted copy keeps the copy: once its driver
      // closed, the launch is settled failed and the adopt receipt becomes the
      // latest again, so the next attempt uses the same copy and never an
      // older checkpoint. An unsettled close leaves the launch receipt as the
      // honest unknown state.
      if (
        adoptedLaunch &&
        workingJournal &&
        workingReceipt &&
        !workingReceiptCompleted &&
        driverClosed
      ) {
        try {
          workingReceipt = workingJournal.fail(workingReceipt, launchFailureCode(error));
          launchReceiptSettled = true;
          workingJournal.readopt(recoveredReceipt!, workingReceipt);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      // A failed reattach left the browser running untouched once its
      // transport detached. While it is provably the same live process, the
      // receipt it was reattached from becomes the latest again, so the
      // browser can be continued or ended instead of staying refused.
      let recoveryReinstated = false;
      if (
        recoveredReceipt &&
        !adoptedLaunch &&
        !relaunchesProfile &&
        recordedProcessReceipt(recoveredReceipt) &&
        workingJournal &&
        workingReceipt &&
        !workingReceiptCompleted &&
        driverClosed
      ) {
        try {
          if ((await this.inspectOwnedProcess(recoveredReceipt.process)) === "live") {
            workingJournal.reinstate({
              kind: "interrupted",
              base: recoveredReceipt,
              interrupted: workingReceipt,
            });
            recoveryReinstated = true;
          }
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (recoveredReceipt && !adoptedLaunch && !driverClosed)
        this.recoveryTransportsUncertain.add(options.browserSessionId);
      if (workingReceipt) {
        console.error("browser launch failed before its working-runtime receipt completed", {
          browserSessionId: options.browserSessionId,
          controllerGeneration: options.controllerGeneration,
          operationId: workingReceipt.operationId,
          restoredProfile: restoredProfileMaterialized,
          receiptState: workingReceiptCompleted
            ? "completed"
            : launchReceiptSettled
              ? "failed"
              : recoveryReinstated
                ? "reinstated"
                : "dispatched",
          failureCode: launchFailureCode(error),
          error,
        });
      }
      try {
        workingJournal?.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
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
      try {
        await downloadStore?.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (failures.length > 1) {
        this.cleanupUncertain = true;
        throw aggregateFailure(failures, "browser session creation did not clean up safely", error);
      }
      throw error;
    }
  }

  private async performCapture(input: ValidatedBrowserStateCaptureInput) {
    const runtime = this.requireBound(input);
    if (
      runtime.options.transport.kind === "attached_chrome" ||
      runtime.options.transport.kind === "external_provider" ||
      runtime.options.transport.engine === "lightpanda" ||
      Boolean(runtime.options.transport.ephemeralPartition)
    ) {
      throw new InteractionControllerError(
        "unsupported",
        "this browser engine does not support portable profile capture",
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
      // Capture needs a live snapshot. Recover a definitively lost managed
      // process before entering the capture fence; explicit-restore engines
      // still refuse this path, and no input or upload is replayed.
      await this.recoverIfUnavailable(runtime);
      if (runtime.lifecycle !== "active") {
        throw new InteractionControllerError(
          "resource_unavailable",
          "browser session is not available for state capture",
        );
      }
      runtime.lifecycle = "capturing";
      await runtime.controller.waitForIdle();
      await runtime.downloadStore?.interruptInProgress("browser_restarted");
      snapshot = await runtime.driver.runtimeSnapshot();
      const cookies = await runtime.driver.captureSessionCookies?.();
      if (cookies) runtime.driverContext.headlessSessionCookies = cookies;
      this.retireWorkingRuntime(runtime);
      await runtime.driver.close();
      driverClosed = true;
      if (runtime.workingJournal && runtime.workingReceipt?.intent === "retire") {
        runtime.workingReceipt = runtime.workingJournal.complete(runtime.workingReceipt, null);
      }
      const manifest = profileManifest(runtime, snapshot);
      const artifact = await captureEncryptedBrowserProfile({
        profileDirectory: runtime.driverContext.profileDirectory,
        artifactPath,
        dataKey: input.dataKey,
        aad: input.aad,
        manifest,
        ...(cookies ? { headlessSessionCookies: cookies } : {}),
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
      if (input.afterCapture === "stop") {
        runtime.lifecycle = "captured";
        delete runtime.driverContext.headlessSessionCookies;
      }
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
    delete runtime.driverContext.recoverOwnedProcess;
    delete runtime.driverContext.allowOwnedProcessLaunch;
    const launch =
      runtime.workingJournal && runtime.workingReceipt
        ? runtime.workingJournal.begin({
            ...runtime.workingReceipt,
            intent: "launch",
            process: null,
          })
        : null;
    const driver = await this.createDriver(runtime.driverContext);
    // The replacement stays presented while it restores tabs and until every
    // outstanding use has moved to it.
    const restorePresence = (await driver.acquirePresence?.()) ?? (() => undefined);
    try {
      await restoreTabs(driver, snapshot.tabs);
      const currentSnapshot = await driver.runtimeSnapshot();
      const currentTargets = await driver.listTargets();
      runtime.driver = driver;
      for (const hold of runtime.presence) await this.bindPresence(runtime, hold);
      runtime.controller = this.createController(runtime, driver);
      runtime.lastTargets = currentTargets;
      runtime.lastSnapshot = snapshotWithTargets(currentSnapshot, currentTargets);
      delete runtime.driverContext.headlessSessionCookies;
      if (launch && runtime.workingJournal) {
        let process: OwnedManagedBrowserProcess | null = null;
        try {
          process = (await driver.ownedProcessIdentity?.()) ?? null;
        } catch {
          /* No recovery proof. */
        }
        runtime.workingReceipt = runtime.workingJournal.complete(
          { ...launch, directoryLaunchAllowed: driver.requiresExplicitProfileRestore !== true },
          process,
        );
      }
    } catch (error) {
      try {
        await driver.close();
      } catch (cleanupError) {
        this.cleanupUncertain = true;
        throw new UnsettledCleanupError(
          [error, cleanupError],
          "replacement browser cleanup failed",
        );
      }
      throw error;
    } finally {
      restorePresence();
    }
  }

  private async performExternalAuth(
    runtime: Runtime,
    command: BrowserExternalAuthCommand,
  ): Promise<BrowserExternalAuthResultValue> {
    if (runtime.driver.isTerminal?.()) {
      throw new InteractionControllerError(
        "controller_lost",
        "ephemeral browser process generation ended; create a new session",
        false,
      );
    }
    if (runtime.lifecycle !== "active") {
      throw new InteractionControllerError(
        "resource_unavailable",
        "browser session is changing state",
        true,
      );
    }
    if (!runtime.driver.externalAuth) {
      throw new InteractionControllerError(
        "unsupported",
        "browser placement does not support provider-managed authentication",
      );
    }
    runtime.lifecycle = "reconfiguring";
    try {
      await runtime.controller.waitForIdle();
      const result = await runtime.driver.externalAuth(command);
      if (result.profileLoaded) {
        const [snapshot, targets] = await Promise.all([
          runtime.driver.runtimeSnapshot(),
          runtime.driver.listTargets(),
        ]);
        this.rememberTargets(runtime, targets);
        runtime.lastSnapshot = snapshotWithTargets(snapshot, targets);
      }
      return result;
    } finally {
      if (runtime.lifecycle === "reconfiguring") runtime.lifecycle = "active";
    }
  }

  private async readWithRecovery<T>(runtime: Runtime, operation: () => Promise<T>): Promise<T> {
    return await this.presented(runtime, async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof InteractionDefiniteDriverError) throw error;
        if (!(await this.recoverIfUnavailable(runtime))) throw error;
        return await operation();
      }
    });
  }

  private async mutateWithRecovery<T>(runtime: Runtime, operation: () => Promise<T>): Promise<T> {
    return await this.presented(runtime, async () => {
      try {
        return await operation();
      } catch (error) {
        try {
          await this.recoverIfUnavailable(runtime);
        } catch (recoveryError) {
          throw aggregateFailure(
            [error, recoveryError],
            "browser mutation failed and its runtime could not recover",
            error,
          );
        }
        // Never replay a mutation whose dispatch boundary is not represented by
        // the durable action journal. Recovery only makes later calls usable.
        throw error;
      }
    });
  }

  /** Runs one use of the browser with its windows presented. Idle windowed
   * browsers park their windows so pages nobody uses stop rendering. */
  private async presented<T>(runtime: Runtime, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquirePresence(runtime);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acquirePresence(runtime: Runtime): Promise<() => void> {
    const hold: PresenceHold = { driver: null, release: () => undefined };
    runtime.presence.add(hold);
    await this.bindPresence(runtime, hold);
    return () => {
      if (!runtime.presence.delete(hold)) return;
      runtime.lastUsedAt = this.now();
      hold.driver = null;
      hold.release();
    };
  }

  /** Moves a presence hold onto the runtime's current driver. Presenting is
   * best effort, so this never fails an operation. */
  private async bindPresence(runtime: Runtime, hold: PresenceHold): Promise<void> {
    while (runtime.presence.has(hold) && hold.driver !== runtime.driver) {
      const driver = runtime.driver;
      let release: () => void = () => undefined;
      try {
        release = (await driver.acquirePresence?.()) ?? release;
      } catch {
        /* Best effort. */
      }
      // Released, or recovery replaced the driver, while acquiring.
      if (!runtime.presence.has(hold) || runtime.driver !== driver) {
        release();
        continue;
      }
      const previous = hold.release;
      hold.driver = driver;
      hold.release = release;
      previous();
    }
  }

  private async recoverIfUnavailable(runtime: Runtime): Promise<boolean> {
    if (
      runtime.options.transport.kind === "attached_chrome" ||
      (runtime.options.transport.kind === "managed" &&
        runtime.options.transport.ephemeralPartition) ||
      !runtime.driver.isAvailable
    )
      return false;
    if (await runtime.driver.isAvailable()) return false;
    if (runtime.driver.requiresExplicitProfileRestore) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "Headless shell lost its live identity; restore saved browser state or create a new browser session",
      );
    }
    await this.recoverRuntimeAfterLoss(runtime);
    return true;
  }

  private async recoverRuntimeAfterLoss(runtime: Runtime): Promise<void> {
    if (runtime.recovery) return await runtime.recovery;
    const recovery = this.performRuntimeRecovery(runtime);
    runtime.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (runtime.recovery === recovery) runtime.recovery = null;
    }
  }

  private async performRuntimeRecovery(runtime: Runtime): Promise<void> {
    if (runtime.lifecycle !== "active") {
      throw new InteractionControllerError(
        "resource_unavailable",
        "browser session cannot recover while changing state",
        true,
      );
    }
    runtime.lifecycle = "recovering";
    const previousDriver = runtime.driver;
    const snapshot = runtime.lastSnapshot;
    try {
      await runtime.controller.waitForIdle();
      await runtime.downloadStore?.interruptInProgress("browser_restarted");
      this.retireWorkingRuntime(runtime);
      await previousDriver.close();
      await this.restartRuntime(runtime, snapshot);
      runtime.lifecycle = "active";
    } catch (error) {
      // Keep the binding addressable so a later request can retry recovery;
      // the old driver remains unavailable and no operation is replayed.
      runtime.lifecycle = "active";
      throw error;
    }
  }

  private rememberObservation(runtime: Runtime, observation: BrowserObservation): void {
    this.rememberTarget(runtime, observation.target);
  }

  private rememberTarget(runtime: Runtime, target: BrowserTarget): void {
    const index = runtime.lastTargets.findIndex((entry) => entry.id === target.id);
    if (target.selected) {
      runtime.lastTargets = runtime.lastTargets.map((entry) => ({
        ...entry,
        selected: false,
      }));
    }
    if (index >= 0) runtime.lastTargets[index] = target;
    else runtime.lastTargets.push(target);
    runtime.lastSnapshot = snapshotWithTargets(runtime.lastSnapshot, runtime.lastTargets);
  }

  private rememberTargets(runtime: Runtime, targets: readonly BrowserTarget[]): void {
    runtime.lastTargets = targets.map((target) => ({ ...target }));
    runtime.lastSnapshot = snapshotWithTargets(runtime.lastSnapshot, runtime.lastTargets);
  }

  private createController(
    runtime: Runtime,
    driver: BrowserSupervisorDriver,
  ): BrowserInteractionController {
    return runtime.journal.withRecoveredRecords(
      (initialJournal) =>
        new BrowserInteractionController({
          browserSessionId: runtime.options.browserSessionId,
          controllerGeneration: runtime.options.controllerGeneration,
          driver,
          initialJournal,
          onJournalRecord: (record) => runtime.journal.write(record),
          loadJournalRecord: (operationId) => runtime.journal.read(operationId),
          onUnexpectedDispatchError: (error, command) =>
            reportUnexpectedDispatchError("browser", error, command),
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
        }),
    );
  }

  private async currentObservation(runtime: Runtime): Promise<BrowserObservation> {
    const targets = await this.readWithRecovery(runtime, async () => {
      return await runtime.driver.listTargets();
    });
    this.rememberTargets(runtime, targets);
    const selected = targets.find((target) => target.selected) ?? targets[0];
    if (selected) {
      const observation = await this.readWithRecovery(runtime, async () => {
        return await runtime.controller.observe(selected.id);
      });
      this.rememberObservation(runtime, observation);
      return observation;
    }
    const observation = await this.mutateWithRecovery(runtime, async () => {
      return await runtime.driver.openTarget();
    });
    this.rememberObservation(runtime, observation);
    return observation;
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
      (!requested.recoverExistingWorkingDirectory &&
        runtime.options.initialUrl !== requested.initialUrl) ||
      canonicalJson(runtime.options.transport) !== canonicalJson(requested.transport) ||
      canonicalJson(runtime.options.linkedComputer ?? null) !==
        canonicalJson(requested.linkedComputer ?? null) ||
      (!requested.recoverExistingWorkingDirectory &&
        runtime.options.restoreAuthorityDigest !== restoreAuthorityDigest(requested.restore)) ||
      runtime.options.networkRouteAuthorityDigest !==
        (requested.networkRoute?.authorityDigest ?? null) ||
      ((requested.networkRoute?.proxyUrl !== undefined ||
        requested.networkRoute?.providerRoute !== undefined) &&
        runtime.options.networkRouteMaterialDigest !==
          networkRouteMaterialDigest(requested.networkRoute))
    ) {
      throw new InteractionControllerError(
        "operation_conflict",
        "browser session is already active with different launch options",
      );
    }
  }

  private async recordWorkingAuthority(
    runtime: Runtime,
    options: ValidatedBrowserSupervisorSessionOptions,
  ) {
    if (!runtime.workingJournal || !runtime.workingReceipt || !options.workingRuntimeAuthority) {
      if (options.recoverExistingWorkingDirectory) throw workingRuntimeUnavailable();
      return;
    }
    const previous = runtime.workingReceipt.authority;
    const current = options.workingRuntimeAuthority;
    if (
      current.placementDigest !== previous.placementDigest ||
      current.tokenGeneration < previous.tokenGeneration ||
      (current.tokenGeneration === previous.tokenGeneration &&
        JSON.stringify(current) !== JSON.stringify(previous))
    ) {
      throw workingRuntimeUnavailable();
    }
    if (current.tokenGeneration === previous.tokenGeneration) return;
    const receipt = runtime.workingJournal.begin({
      ...runtime.workingReceipt,
      authority: current,
      process: null,
    });
    let ownedProcess: OwnedManagedBrowserProcess | null = null;
    try {
      ownedProcess = (await runtime.driver.ownedProcessIdentity?.()) ?? null;
    } catch {
      /* An unattested receipt cannot be used for directory recovery. */
    }
    runtime.workingReceipt = runtime.workingJournal.complete(receipt, ownedProcess);
  }

  /** Cleanup for a non-resident session whose latest working-runtime receipt,
   * in this exact controller generation, is a launch that provably never
   * completed. Any other history stays preserved for exact recovery. With
   * removeState the session directory is removed so the next resume restores
   * from durable state; nothing outside this session is touched. */
  private async cleanupAbandonedLaunch(
    reference: BrowserSessionReference,
    sessionDirectory: string,
    removeState: boolean,
  ): Promise<void> {
    let abandoned = false;
    try {
      const reader = await SqliteBrowserWorkingRuntimeJournal.open(
        {
          sessionDirectory,
          browserSessionId: reference.browserSessionId,
          controllerGeneration: reference.controllerGeneration,
        },
        true,
      );
      try {
        abandoned = await isAbandonedLaunchReceipt(
          reader.latest(),
          join(sessionDirectory, "profile"),
        );
      } finally {
        reader.close();
      }
    } catch {
      abandoned = false;
    }
    if (!abandoned) throw workingRuntimeUnavailable();
    if (!removeState) return;
    await rm(sessionDirectory, { recursive: true, force: true });
  }

  /** An explicit end of a session this controller no longer holds in memory
   * (it restarted, or the browser's runtime was lost), for the exact
   * controller generation the control plane still binds. Ending discards the
   * runtime, so nothing here needs preserving for recovery: any browser still
   * running the session's private profile is stopped by verified identity
   * and the working runtime is retired. With removeState the session's state
   * is removed; without it (a browser whose task moved to another machine)
   * the profile and downloads stay on disk. After an agent restart such a
   * browser keeps running detached until something ends it here. History
   * that belongs to another generation stays preserved. */
  private async retireNonResidentWorkingRuntime(
    reference: BrowserSessionReference,
    sessionDirectory: string,
    removeState: boolean,
  ): Promise<void> {
    let journal: SqliteBrowserWorkingRuntimeJournal;
    let latest: BrowserWorkingRuntimeReceipt | null;
    try {
      journal = await SqliteBrowserWorkingRuntimeJournal.open({
        sessionDirectory,
        browserSessionId: reference.browserSessionId,
        controllerGeneration: reference.controllerGeneration,
      });
    } catch {
      throw workingRuntimeUnavailable();
    }
    try {
      try {
        latest = journal.latest();
      } catch {
        throw workingRuntimeUnavailable();
      }
      await this.stopEndedProcess(join(sessionDirectory, "profile"), latest?.process ?? null);
      if (latest && latest.intent !== "retire") {
        const retiring = journal.retire(latest);
        // A kept directory must record that its runtime ended, so no later
        // recovery adopts it as a live browser.
        if (!removeState) journal.complete(retiring, null);
      } else if (latest?.intent === "retire" && latest.state !== "completed" && !removeState) {
        journal.complete(latest, null);
      }
    } finally {
      journal.close();
    }
    if (removeState) await rm(sessionDirectory, { recursive: true, force: true });
  }

  /** Move an interrupted launch of this exact generation out of the session's
   * path so the same browser can be restored from its checkpoint under a new
   * generation. Only a launch that never recorded completion (no owned
   * process) qualifies; a completed launch must be adopted instead. The move
   * is a same-filesystem rename of the whole session directory, so its
   * profile, journals and receipts are kept byte for byte under
   * `set-aside/<browserSessionId>/<controllerGeneration>`. It happens only
   * after a complete process inventory proves no browser runs that profile. */
  private async setAsideInterruptedLaunch(
    reference: BrowserSessionReference,
    sessionDirectory: string,
  ): Promise<void> {
    // The generation names the set-aside directory: one plain path segment.
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(reference.controllerGeneration) ||
      reference.controllerGeneration.includes("..")
    )
      throw workingRuntimeUnavailable();
    let latest: BrowserWorkingRuntimeReceipt | null;
    try {
      const reader = await SqliteBrowserWorkingRuntimeJournal.open(
        {
          sessionDirectory,
          browserSessionId: reference.browserSessionId,
          controllerGeneration: reference.controllerGeneration,
        },
        true,
      );
      try {
        latest = reader.latest();
      } finally {
        reader.close();
      }
    } catch {
      throw workingRuntimeUnavailable();
    }
    // A launch from an adopted copy is never set aside: the adopted copy is
    // the browser's chosen state, and setting it aside would let an older
    // checkpoint replace it. Its next recovery re-settles it instead.
    if (!isInterruptedLaunchReceipt(latest) || latest.adoption) throw workingRuntimeUnavailable();
    try {
      await this.assertProfileUnused(join(sessionDirectory, "profile"));
    } catch {
      throw workingRuntimeUnavailable();
    }
    const setAsideParent = join(this.rootDirectory, "set-aside", reference.browserSessionId);
    await mkdir(setAsideParent, { recursive: true, mode: 0o700 });
    await chmod(setAsideParent, 0o700);
    const target = join(setAsideParent, reference.controllerGeneration);
    try {
      await lstat(target);
      // A generation is set aside at most once; never overwrite evidence.
      throw workingRuntimeUnavailable();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(sessionDirectory, target);
  }

  private retireWorkingRuntime(runtime: Runtime) {
    if (
      runtime.workingJournal &&
      runtime.workingReceipt?.intent !== "retire" &&
      runtime.workingReceipt
    ) {
      runtime.workingReceipt = runtime.workingJournal.retire(runtime.workingReceipt);
    }
  }

  supportsFencedInputBatches(reference: BrowserSessionReference): boolean {
    return this.requireBound(reference).driver.fencedInputBatches === true;
  }

  supportsFocusedInputObservations(reference: BrowserSessionReference): boolean {
    return this.requireBound(reference).driver.focusedInputObservations === true;
  }

  private requireActive(reference: BrowserSessionReference): Runtime {
    const runtime = this.requireBound(reference);
    if (runtime.driver.isTerminal?.()) {
      throw new InteractionControllerError(
        "controller_lost",
        "ephemeral browser process generation ended; create a new session",
        false,
      );
    }
    if (runtime.lifecycle !== "active") {
      throw new InteractionControllerError(
        "resource_unavailable",
        "browser session is changing state",
        true,
      );
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
    runtime.lastUsedAt = this.now();
    return runtime;
  }

  private async disposeRuntime(
    runtime: Runtime,
    removeState: boolean,
    driverAlreadyClosed = false,
    suspendForShutdown = false,
    /** Suspend recoverably but stop the browser too (idle release). */
    stopSuspendedBrowser = false,
  ): Promise<void> {
    const failures: unknown[] = [];
    let driverClosed = driverAlreadyClosed;
    let workingReceiptSettled =
      runtime.workingJournal === null ||
      (runtime.workingReceipt?.intent === "retire" && runtime.workingReceipt.state === "completed");
    let workingJournalClosed = runtime.workingJournal === null;
    let actionJournalClosed = false;
    let stateJournalClosed = false;
    let downloadStoreClosed = runtime.downloadStore === null;
    // Shutdown intent becomes durable before process cleanup; only confirmed
    // suspension permits recovery. Explicit end/capture still retires the runtime.
    // Failed acceptance preserves the live driver and all journals.
    let keepBrowserRunning = false;
    if (
      suspendForShutdown &&
      runtime.workingJournal &&
      runtime.workingReceipt?.intent === "launch" &&
      runtime.workingReceipt.state === "completed" &&
      runtime.workingReceipt.process &&
      runtime.workingReceipt.directoryLaunchAllowed
    ) {
      runtime.workingReceipt = runtime.workingJournal.suspend(runtime.workingReceipt);
      // A controller restart (upgrade, crash recovery) must not cost the page
      // state an agent is working in. Release only this controller's transport;
      // the successor adopts the same live browser from the suspended receipt.
      keepBrowserRunning = !stopSuspendedBrowser && runtime.driver.detach !== undefined;
    } else {
      this.retireWorkingRuntime(runtime);
    }
    if (keepBrowserRunning && runtime.workingReceipt?.process) {
      // Tell the successor about the browser it inherits, so it stops it once
      // unused for the idle release time even if its session never returns.
      // Best effort: a missing record only means the browser waits for its
      // session, as before.
      try {
        await writeDetachedBrowserRecord(runtime.sessionDirectory, {
          version: 1,
          browserSessionId: runtime.options.browserSessionId,
          // A live view, recording or request still open at shutdown is a use
          // that has not ended yet, so the successor's idle time starts now.
          lastUsedAt: runtime.presence.size > 0 ? this.now() : runtime.lastUsedAt,
          process: runtime.workingReceipt.process,
        });
      } catch (error) {
        console.warn("browserd.detached_record_failed", {
          browserSessionId: runtime.options.browserSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!driverAlreadyClosed) {
      try {
        await runtime.downloadStore?.interruptInProgress("browser_ended");
      } catch (error) {
        failures.push(error);
      }
      try {
        if (keepBrowserRunning) await runtime.driver.detach!();
        else await runtime.driver.close();
        driverClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (
      driverClosed &&
      runtime.workingJournal &&
      (runtime.workingReceipt?.intent === "retire" ||
        runtime.workingReceipt?.intent === "suspend") &&
      runtime.workingReceipt.state !== "completed"
    ) {
      try {
        runtime.workingReceipt = runtime.workingJournal.complete(
          runtime.workingReceipt,
          runtime.workingReceipt.intent === "suspend" ? runtime.workingReceipt.process : null,
        );
        workingReceiptSettled = true;
      } catch (error) {
        failures.push(error);
      }
    }
    // An unsettled retirement keeps this journal open for the exact cleanup retry.
    if (driverClosed && workingReceiptSettled) {
      try {
        runtime.workingJournal?.close();
        workingJournalClosed = true;
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
    try {
      await runtime.downloadStore?.close();
      downloadStoreClosed = true;
      // A later process-cleanup retry must not interrupt an already closed store.
      runtime.downloadStore = null;
    } catch (error) {
      failures.push(error);
    }
    const recording = runtime.recording;
    runtime.recording = null;
    await recording?.discard();
    if (
      removeState &&
      driverClosed &&
      workingReceiptSettled &&
      workingJournalClosed &&
      actionJournalClosed &&
      stateJournalClosed &&
      downloadStoreClosed
    ) {
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

function snapshotWithTargets(
  snapshot: BrowserRuntimeSnapshot,
  targets: readonly BrowserTarget[],
): BrowserRuntimeSnapshot {
  return {
    ...snapshot,
    tabs: targets
      .filter((target) => target.kind === "page" || target.kind === "popup")
      .map((target) => ({ url: target.url, selected: target.selected })),
  };
}

function browserActionUsesWorkspaceFiles(action: BrowserActionCommand["action"]): boolean {
  return (
    action.type === "upload" ||
    (action.type === "batch" && action.actions.some((entry) => entry.type === "upload"))
  );
}

/** The program a managed Chromium launch executes for this driver context.
 *
 * A recovered working runtime records its browser's process image (the
 * resolved `/proc/<pid>/exe`) only as ownership evidence. That image is not a
 * launcher: distribution wrappers (NixOS, Debian and Google Chrome's own
 * script) prepare the sandbox helper, flags and environment and then exec it,
 * and a Chromium started from its bare image can abort before DevTools starts.
 * A relaunch after the recorded browser exited therefore uses the same
 * launcher as every other launch of this profile, and reattaching a live
 * browser launches nothing. The record decides only whether this exact
 * directory may be reattached or relaunched. Undefined selects the platform
 * default launcher. */
export async function managedChromiumLaunchExecutable(
  context: Pick<
    BrowserSupervisorDriverContext,
    | "headed"
    | "profileDirectory"
    | "restoredProfile"
    | "browserExecutablePath"
    | "recoverOwnedProcess"
    | "allowOwnedProcessLaunch"
  >,
  headlessShell?: VerifiedHeadlessShell,
): Promise<{ browserExecutablePath: string | undefined; useHeadlessShell: boolean }> {
  const browserExecutablePath = await selectManagedChromiumExecutable({
    headed: context.headed,
    profileDirectory: context.profileDirectory,
    restoredProfile: context.restoredProfile,
    ...(context.browserExecutablePath
      ? { browserExecutablePath: context.browserExecutablePath }
      : {}),
    ...(headlessShell ? { headlessShell } : {}),
  });
  // Without directory launch permission only a verified headless shell, whose
  // daemon lineage is proven before reattaching, may recover.
  if (
    context.recoverOwnedProcess &&
    context.allowOwnedProcessLaunch !== true &&
    (!headlessShell ||
      (await realpath(headlessShell.path)) !== context.recoverOwnedProcess.executablePath)
  ) {
    throw workingRuntimeUnavailable();
  }
  return {
    browserExecutablePath,
    useHeadlessShell: headlessShell !== undefined && browserExecutablePath === headlessShell.path,
  };
}

async function createBrowserDriver(
  context: BrowserSupervisorDriverContext,
  lightpandaBinary?: () => Promise<ResolvedLightpandaBinary>,
  headlessShell?: VerifiedHeadlessShell,
  networkIsolation = true,
  connectAttachedBridge: AttachedBrowserBridgeConnector = connectAttachedBrowserBridge,
): Promise<BrowserSupervisorDriver> {
  if (context.transport.kind === "attached_chrome") {
    const transport = context.transport;
    // The session's tabs and attachments in the person's browser outlive
    // this runtime; a later runtime of the session, or a later controller
    // after a crash, continues from this record.
    const ledger = AttachedTabLedgerRecorder.open(context.sessionDirectory, {
      browserSessionId: context.browserSessionId,
      deviceId: transport.deviceId,
      connectionGeneration: transport.connectionGeneration,
      ...(transport.authorityFile ? { authorityFile: transport.authorityFile } : {}),
    });
    let attached: Awaited<ReturnType<typeof createAttachedChromeTransport>>;
    try {
      attached = await createAttachedChromeTransport({
        deviceId: transport.deviceId,
        connectionGeneration: transport.connectionGeneration,
        browserName: transport.browserName,
        browserVersion: transport.browserVersion,
        ...(transport.authorityFile ? { authorityFile: transport.authorityFile } : {}),
        connectBridge: connectAttachedBridge,
        inheritedAttachments: ledger.inheritedAttachments,
        onAttachmentsChange: (tabs) => ledger.attachmentsChanged(tabs),
      });
    } catch (error) {
      ledger.abandon();
      throw error;
    }
    const connection = attached.connection;
    return createAttachedChromeDriver(
      context,
      attached,
      context.resolveWorkspaceFiles,
      context.downloadEvents,
      {
        previous: ledger.previous,
        onChange: (tabs) => ledger.tabsChanged(tabs),
        onClosed: (tabsSettled) => ledger.closed(tabsSettled, connection.leftoverAttachments()),
      },
    );
  }
  if (context.transport.kind === "managed" && context.transport.engine === "lightpanda") {
    if (!lightpandaBinary) {
      throw new InteractionControllerError(
        "resource_unavailable",
        "Lightpanda is not installed on this browser placement",
      );
    }
    const runner = await LightpandaRunner.create({
      binary: await lightpandaBinary(),
      sessionDirectory: join(context.sessionDirectory, "lightpanda"),
    });
    return new AgentBrowserDriver({
      browserSessionId: context.browserSessionId,
      controllerGeneration: context.controllerGeneration,
      runner,
      engine: "lightpanda",
      targetLifecycle: "cdp",
      tabControl: false,
      frameStreaming: false,
      permissionControl: false,
      resolveWorkspaceFiles: context.resolveWorkspaceFiles,
    });
  }
  if (context.transport.kind === "external_provider") {
    const managedRoute = context.networkRoute?.providerRoute;
    const runner = new ExternalProviderCdpRunner({
      providerId: context.transport.providerId,
      apiKey: context.transport.authority.apiKey,
      ...(context.transport.authority.endpoint
        ? { endpoint: context.transport.authority.endpoint }
        : {}),
      headed: context.headed,
      ...(context.transport.timeoutSeconds
        ? { timeoutSeconds: context.transport.timeoutSeconds }
        : {}),
      ...(context.transport.stealth === undefined ? {} : { stealth: context.transport.stealth }),
      ...(managedRoute ? { route: managedRoute } : {}),
    });
    return new AgentBrowserDriver({
      browserSessionId: context.browserSessionId,
      controllerGeneration: context.controllerGeneration,
      runner,
      connect: async (endpoint) => await CdpConnection.connect(endpoint, { allowRemote: true }),
      targetLifecycle: "cdp",
      focusEmulation: true,
      ...(context.passkeys ? { passkeys: context.passkeys } : {}),
    });
  }
  const route = context.networkRoute;
  const launchArguments: string[] = [];
  if (route?.consistency.locale) {
    launchArguments.push(`--lang=${route.consistency.locale}`);
  }
  if (route?.consistency.webRtc !== "default") {
    launchArguments.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  }
  // A linked headed browser is also a native ComputerSession application.
  // Chromium otherwise exposes only its outer window to Linux AT-SPI, making
  // background semantic interaction with the page impossible.
  if (context.linkedComputer) {
    launchArguments.push("--force-renderer-accessibility=complete");
  }
  const { browserExecutablePath, useHeadlessShell } = await managedChromiumLaunchExecutable(
    context,
    headlessShell,
  );
  if (context.headlessSessionCookies && !useHeadlessShell) {
    throw new Error("Headless cookie state requires its matching verified profile launcher");
  }
  // A managed browser on macOS runs on the person's own desktop. A window
  // would appear in front of them, take focus and intercept their typing;
  // the agent and the person's live view work through CDP, so it stays
  // offscreen. A linked ComputerSession drives the native window itself.
  // A Linux host without a graphical display (a server, or an agent running
  // outside the desktop session) cannot open a window at all: windowed Chrome
  // would exit before DevTools starts. There a headed browser is offscreen too.
  const offscreen =
    context.headed &&
    !context.linkedComputer &&
    (process.platform === "darwin" || (process.platform === "linux" && !linuxGraphicalDisplay()));
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: context.profileDirectory,
    headed: context.headed,
    ...(networkIsolation ? {} : { networkIsolation: false }),
    ...(offscreen ? { offscreen: true } : {}),
    ...(route?.kind === "proxy" && route.proxyUrl ? { proxyUrl: route.proxyUrl } : {}),
    ...(launchArguments.length > 0 ? { launchArguments } : {}),
    ...(route?.consistency.timezone ? { timezone: route.consistency.timezone } : {}),
    ...(browserExecutablePath ? { browserExecutablePath } : {}),
    ...(context.recoverOwnedProcess
      ? {
          recoverOwnedProcess: context.recoverOwnedProcess,
          allowOwnedProcessLaunch: context.allowOwnedProcessLaunch,
        }
      : {}),
    ...(context.launchEnvironment ? { environment: context.launchEnvironment } : {}),
  }).catch((error: unknown) => {
    // Recovery proves the previous browser's state before reattaching or
    // relaunching. A proof that cannot be completed is a definite refusal
    // with the browser's state preserved, not an internal failure.
    if (
      context.recoverOwnedProcess &&
      error instanceof AgentBrowserCommandError &&
      error.code === "process_failed"
    )
      throw workingRuntimeUnavailable("process_state_unknown");
    throw error;
  });
  return new AgentBrowserDriver({
    browserSessionId: context.browserSessionId,
    controllerGeneration: context.controllerGeneration,
    runner,
    ...(useHeadlessShell
      ? {
          preserveHeadlessSessionCookies: true,
          ...(context.headlessSessionCookies
            ? { headlessSessionCookies: context.headlessSessionCookies }
            : {}),
        }
      : {}),
    focusEmulation: true,
    // Linux has no window occlusion tracking: every window of a windowed
    // browser counts as visible and its animated pages render continuously.
    // Park idle windows so browsers nobody is using stop drawing frames. A
    // linked ComputerSession works on the native window itself, so it stays.
    ...(process.platform === "linux" && context.headed && !offscreen && !context.linkedComputer
      ? { parkIdleWindowsAfterMs: BROWSER_WINDOW_PARK_IDLE_MS }
      : {}),
    // Headless and offscreen Chrome on this machine launch with an ordinary
    // User-Agent switch, which empties their high-entropy Client Hints.
    ...((process.platform === "darwin" || process.platform === "linux") &&
    (!context.headed || offscreen)
      ? { completeClientHints: true }
      : {}),
    ...(useHeadlessShell ? { userAgentMetadataSource: "intercepted_local" as const } : {}),
    downloadDirectory: context.downloadDirectory,
    ...(context.downloadEvents ? { downloadEvents: context.downloadEvents } : {}),
    resolveWorkspaceFiles: context.resolveWorkspaceFiles,
    ...(context.passkeys ? { passkeys: context.passkeys } : {}),
    ...(route
      ? {
          emulation: {
            locale: route.consistency.locale,
            timezone: route.consistency.timezone,
            geolocation: route.consistency.geolocation,
          },
        }
      : {}),
  });
}

/** Whether this host offers a graphical display a browser window could open
 * on. A browser launch environment exists only for a linked ComputerSession,
 * which always brings its own display. */
export function linuxGraphicalDisplay(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

/** Graceful shutdown keeps this owned browser running and its next causal
 * request reattaches it from the completed working-runtime launch receipt. */
function hasPreservableWorkingRuntime(runtime: Runtime): boolean {
  return (
    runtime.lifecycle === "active" &&
    !runtime.driver.isTerminal?.() &&
    runtime.workingJournal !== null &&
    runtime.workingReceipt?.intent === "launch" &&
    runtime.workingReceipt.state === "completed" &&
    runtime.workingReceipt.process !== null &&
    runtime.workingReceipt.directoryLaunchAllowed
  );
}

/** A browser nobody is using that its next request can bring back: no
 * request, live view, recording, recovery or unanswered JavaScript dialog in
 * progress (an agent waiting on a dialog is still using the browser, and
 * releasing it would lose the dialog). A managed browser
 * needs a stopped profile its next request can relaunch. A session in the
 * person's own Chrome needs nothing kept here: its tabs live on in Chrome, and
 * its next request continues in the tab it was using. */
function idleReleasable(runtime: Runtime, idleBefore: number): boolean {
  const transport = runtime.options.transport.kind;
  return (
    (transport === "managed" || transport === "attached_chrome") &&
    runtime.lastUsedAt <= idleBefore &&
    runtime.presence.size === 0 &&
    runtime.recording?.summary().state !== "recording" &&
    runtime.recovery === null &&
    runtime.externalAuthTail === null &&
    runtime.controller.isIdle() &&
    runtime.driver.hasOpenDialog?.() !== true &&
    (transport === "attached_chrome"
      ? runtime.lifecycle === "active" && runtime.driver.isTerminal?.() !== true
      : hasPreservableWorkingRuntime(runtime))
  );
}

/** Whether the browser is still receiving a download. A store that cannot be
 * read counts as busy, so an idle sweep never fails a download it cannot see. */
async function downloadInProgress(runtime: Runtime): Promise<boolean> {
  if (!runtime.downloadStore) return false;
  try {
    const downloads = await runtime.downloadStore.list();
    return downloads.some((download) => download.status === "in_progress");
  } catch {
    return true;
  }
}

/** A restart now loses neither admitted work nor unrecoverable session state. */
function restartPreservesRuntime(runtime: Runtime): boolean {
  if (runtime.recovery !== null || runtime.externalAuthTail !== null) return false;
  if (!runtime.controller.isIdle()) return false;
  // A session whose driver already ended has no live state left to lose.
  if (runtime.driver.isTerminal?.()) return true;
  // A restart would lose a dialog the agent has yet to answer.
  if (runtime.driver.hasOpenDialog?.()) return false;
  // Attached Chrome lives outside this controller: its tabs and pages survive
  // our restart (only the empty tabs the session opened close, and Chrome's
  // debugger is released), and the session's next request continues in the
  // tab it was using. The agent keeps the profile's placement stable across
  // the restart only for extensions that report a live-state generation. The
  // agent's own update gate refuses older ones.
  if (runtime.options.transport.kind === "attached_chrome") return runtime.lifecycle === "active";
  return hasPreservableWorkingRuntime(runtime);
}

function binding(runtime: Runtime): BrowserSessionReference {
  return {
    browserSessionId: runtime.options.browserSessionId,
    controllerGeneration: runtime.options.controllerGeneration,
  };
}

/** Virtual WebAuthn needs the CDP WebAuthn domain and browser-level target
 * auto-attach: managed Chromium and remote Chromium providers have both. The
 * attached user Chrome (extension debugger) and Lightpanda do not. */
function supportsPasskeys(transport: BrowserSupervisorTransport): boolean {
  if (transport.kind === "attached_chrome") return false;
  return !(transport.kind === "managed" && transport.engine === "lightpanda");
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
  if (
    options.recoverExistingWorkingDirectory !== undefined &&
    (options.recoverExistingWorkingDirectory !== true ||
      options.initialUrl !== undefined ||
      options.restore ||
      !eligibleWorkingRuntime({ transport }) ||
      !options.workingRuntimeAuthority)
  ) {
    throw workingRuntimeUnavailable();
  }
  if (options.workingRuntimeAuthority) {
    const authority = options.workingRuntimeAuthority;
    if (
      !Number.isSafeInteger(authority.tokenGeneration) ||
      authority.tokenGeneration < 1 ||
      ![authority.placementDigest, authority.controlDigest, authority.viewDigest].every((value) =>
        SHA256_PATTERN.test(value),
      )
    ) {
      throw workingRuntimeUnavailable();
    }
  }
  if (
    transport.kind === "managed" &&
    transport.ephemeralPartition &&
    (options.headed ||
      options.restore ||
      options.linkedComputer ||
      options.networkRoute ||
      options.launchEnvironment)
  ) {
    throw new InteractionControllerError(
      "unsupported",
      "ephemeral contexts cannot use a profile, desktop, restore or network route",
    );
  }
  const networkRoute = options.networkRoute
    ? validateBrowserNetworkRoute(options.networkRoute, transport)
    : undefined;
  if (options.linkedComputer) {
    const managedHeaded =
      transport.kind === "managed" && transport.engine !== "lightpanda" && options.headed;
    const attachedChrome = transport.kind === "attached_chrome" && options.headed;
    if (!managedHeaded && !attachedChrome) {
      throw new InteractionControllerError(
        "unsupported",
        "linked ComputerSessions require a headed managed or attached browser",
      );
    }
    if (!isUuid(options.linkedComputer.computerSessionId)) {
      throw new Error("linked ComputerSession id must be a UUID");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(options.linkedComputer.controllerGeneration)) {
      throw new Error("linked ComputerSession controller generation is invalid");
    }
    if (managedHeaded && !options.launchEnvironment) {
      throw new Error("linked ComputerSession launch environment is absent");
    }
    if (attachedChrome && options.launchEnvironment) {
      throw new Error("attached Chrome does not consume a browser launch environment");
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
  if (transport.kind === "external_provider") {
    if (options.restore) {
      throw new InteractionControllerError(
        "unsupported",
        "external browser providers cannot restore a portable BrowserIdentity revision",
      );
    }
    if (options.browserExecutablePath) {
      throw new Error("external browser providers cannot select a local browser executable");
    }
    if (options.networkRoute && options.networkRoute.kind !== "managed") {
      throw new InteractionControllerError(
        "unsupported",
        "external browser providers require a provider-managed network route",
      );
    }
  }
  if (transport.kind === "managed" && transport.engine === "lightpanda") {
    if (options.headed) {
      throw new InteractionControllerError("unsupported", "Lightpanda is headless-only");
    }
    if (options.restore) {
      throw new InteractionControllerError(
        "unsupported",
        "Lightpanda cannot restore a Chromium browser identity",
      );
    }
    if (options.networkRoute) {
      throw new InteractionControllerError(
        "unsupported",
        "Lightpanda network routes are not supported yet",
      );
    }
  }
  const { restore, transport: _transport, networkRoute: _networkRoute, ...session } = options;
  return {
    ...session,
    transport,
    ...(networkRoute ? { networkRoute } : {}),
    ...(restore ? { restore: validateRestoreInput(restore) } : {}),
  };
}

function validateBrowserTransport(input: BrowserSupervisorTransport): BrowserSupervisorTransport {
  if (input.kind === "managed") {
    if (
      input.engine !== undefined &&
      input.engine !== "chromium" &&
      input.engine !== "lightpanda"
    ) {
      throw new Error("managed browser engine is unsupported");
    }
    if (
      input.ephemeralPartition !== undefined &&
      (!/^[0-9a-f]{64}$/u.test(input.ephemeralPartition) ||
        (input.engine !== undefined && input.engine !== "chromium"))
    ) {
      throw new Error("ephemeral browser partition is invalid");
    }
    return {
      kind: "managed",
      engine: input.engine ?? "chromium",
      ...(input.ephemeralPartition ? { ephemeralPartition: input.ephemeralPartition } : {}),
    };
  }
  if (input.kind === "external_provider") {
    if (input.providerId !== "browserbase" && input.providerId !== "kernel") {
      throw new Error("external browser provider is unsupported");
    }
    const timeoutSeconds = input.timeoutSeconds;
    if (
      timeoutSeconds !== undefined &&
      (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400)
    ) {
      throw new Error("external browser timeout is invalid");
    }
    return {
      kind: "external_provider",
      providerId: input.providerId,
      placementId: boundedText(input.placementId, 1, 512, "external browser placement id"),
      authority: {
        apiKey: providerCredential(input.authority.apiKey),
        ...(input.authority.endpoint
          ? { endpoint: providerEndpoint(input.authority.endpoint) }
          : {}),
      },
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...(input.stealth === undefined ? {} : { stealth: input.stealth }),
    };
  }
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

function providerCredential(value: string): string {
  if (
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > 8_192 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("external browser provider credential is invalid");
  }
  return value;
}

function providerEndpoint(value: string): string {
  if (Buffer.byteLength(value) > 16_384) {
    throw new Error("external browser provider endpoint is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("external browser provider endpoint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("external browser provider endpoint is invalid");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function validateBrowserNetworkRoute(
  input: BrowserSupervisorNetworkRoute,
  transport: BrowserSupervisorTransport,
): BrowserSupervisorNetworkRoute {
  if (!isUuid(input.routeId)) throw new Error("network route id must be a UUID");
  if (!Number.isSafeInteger(input.routeVersion) || input.routeVersion < 1) {
    throw new Error("network route version is invalid");
  }
  if (!/^[A-Za-z0-9._~-]{16,256}$/u.test(input.authorityDigest)) {
    throw new Error("network route authority digest is invalid");
  }
  if (
    input.kind !== "direct" &&
    input.kind !== "proxy" &&
    input.kind !== "managed" &&
    input.kind !== "tunnel"
  ) {
    throw new Error("network route kind is unsupported");
  }
  const consistency = NetworkRouteConsistency.parse(input.consistency);
  if (consistency.locale) validateLocale(consistency.locale);
  if (consistency.timezone) validateTimezone(consistency.timezone);
  const expectedDns =
    input.kind === "proxy" ? "proxy" : input.kind === "managed" ? "provider" : "placement";
  if (consistency.dns !== expectedDns) {
    throw new InteractionControllerError(
      "unsupported",
      `network route ${input.kind} cannot provide ${consistency.dns} DNS`,
    );
  }
  if (consistency.webRtc === "proxy_only" && input.kind !== "proxy" && input.kind !== "managed") {
    throw new InteractionControllerError(
      "unsupported",
      "WebRTC proxy-only routing requires a proxy network route",
    );
  }
  if (transport.kind === "attached_chrome" && input.kind === "proxy") {
    throw new InteractionControllerError(
      "unsupported",
      "attached Chrome cannot change its process-scoped proxy route",
    );
  }
  if (
    transport.kind === "attached_chrome" &&
    (consistency.locale !== null ||
      consistency.timezone !== null ||
      consistency.geolocation !== null ||
      consistency.webRtc !== "default")
  ) {
    throw new InteractionControllerError(
      "unsupported",
      "attached Chrome cannot change process-scoped route emulation",
    );
  }
  if (input.kind !== "proxy" && input.proxyUrl !== undefined) {
    throw new Error("non-proxy network route contains proxy authority");
  }
  const providerRoute =
    input.providerRoute === undefined ? undefined : validateProviderRoute(input.providerRoute);
  if (input.kind !== "managed" && providerRoute !== undefined) {
    throw new Error("non-managed network route contains provider material");
  }
  if (input.kind === "managed" && providerRoute === undefined) {
    throw new Error("managed network route omits provider material");
  }
  if (input.kind === "managed") {
    if (transport.kind !== "external_provider") {
      throw new InteractionControllerError(
        "unsupported",
        "managed network routes require an external browser provider",
      );
    }
    if (providerRoute?.providerId !== transport.providerId) {
      throw new InteractionControllerError(
        "unsupported",
        "managed network route belongs to another browser provider",
      );
    }
  }
  const proxyUrl = input.proxyUrl === undefined ? undefined : validateProxyUrl(input.proxyUrl);
  return {
    routeId: input.routeId,
    routeVersion: input.routeVersion,
    authorityDigest: input.authorityDigest,
    kind: input.kind,
    consistency,
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    ...(providerRoute === undefined ? {} : { providerRoute }),
  };
}

function validateProviderRoute(
  input: NonNullable<BrowserSupervisorNetworkRoute["providerRoute"]>,
): NonNullable<BrowserSupervisorNetworkRoute["providerRoute"]> {
  if (input.providerId !== "browserbase" && input.providerId !== "kernel") {
    throw new Error("managed network route provider is unsupported");
  }
  if (
    input.egressClass !== "datacenter" &&
    input.egressClass !== "residential" &&
    input.egressClass !== "isp"
  ) {
    throw new Error("managed network route egress class is invalid");
  }
  return {
    providerId: input.providerId,
    routeId: boundedOpaqueText(input.routeId, 1, 512, "managed network route provider id"),
    egressClass: input.egressClass,
    region:
      input.region === null
        ? null
        : boundedOpaqueText(input.region, 1, 128, "managed network route region"),
  };
}

function validateLocale(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error("network route locale is invalid");
  }
  try {
    if (Intl.getCanonicalLocales(value).length !== 1) throw new Error();
  } catch {
    throw new Error("network route locale is unsupported");
  }
}

function validateTimezone(value: string): void {
  if (/[,\r\n\0]/u.test(value)) throw new Error("network route timezone is invalid");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error("network route timezone is unsupported");
  }
}

function validateProxyUrl(value: string): string {
  if (Buffer.byteLength(value) > 16_384) throw new Error("proxy authority exceeds its envelope");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("proxy authority URL is invalid");
  }
  if (
    !["http:", "https:", "socks5:"].includes(url.protocol) ||
    !url.hostname ||
    (!url.port && url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("proxy authority URL is invalid");
  }
  return url.toString();
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
  const { restore, launchEnvironment: _launchEnvironment, networkRoute, ...runtime } = options;
  return {
    ...runtime,
    restoreAuthorityDigest: restoreAuthorityDigest(restore),
    networkRouteAuthorityDigest: networkRoute?.authorityDigest ?? null,
    networkRouteMaterialDigest: networkRoute ? networkRouteMaterialDigest(networkRoute) : null,
  };
}

function eligibleWorkingRuntime(options: { transport: BrowserSupervisorTransport }) {
  return (
    options.transport.kind === "managed" &&
    options.transport.engine !== "lightpanda" &&
    !options.transport.ephemeralPartition
  );
}

function workingLaunchDigest(options: ValidatedBrowserSupervisorSessionOptions): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        driverId: BROWSER_DRIVER_ID,
        driverSchemaVersion: BROWSER_DRIVER_SCHEMA_VERSION,
        headed: options.headed,
        executable: options.browserExecutablePath ?? null,
        transport: options.transport,
        linkedComputer: options.linkedComputer ?? null,
        networkRoute: options.networkRoute
          ? networkRouteMaterialDigest(options.networkRoute)
          : null,
      }),
    )
    .digest("hex");
}

async function assertOptionalDirectory(path: string) {
  try {
    await assertDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function assertOptionalRegularFile(path: string) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw workingRuntimeUnavailable();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function networkRouteMaterialDigest(route: BrowserSupervisorNetworkRoute): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        routeId: route.routeId,
        routeVersion: route.routeVersion,
        authorityDigest: route.authorityDigest,
        kind: route.kind,
        consistency: route.consistency,
        proxyUrl: route.proxyUrl ?? null,
        providerRoute: route.providerRoute ?? null,
      }),
      "utf8",
    )
    .digest("hex");
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
}): Promise<{ manifest: BrowserProfileManifest; headlessSessionCookies?: HeadlessSessionCookies }> {
  const transferDirectory = join(input.sessionDirectory, "state-restores");
  const artifactPath = join(transferDirectory, `${input.restore.artifactDigest}.ogbs`);
  const stagingDirectory = join(
    input.sessionDirectory,
    `profile.restore.${input.restore.artifactDigest.slice(0, 16)}`,
  );
  await rm(artifactPath, { force: true });
  await rm(stagingDirectory, { recursive: true, force: true });
  let headlessSessionCookies: HeadlessSessionCookies | undefined;
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
      acceptHeadlessSessionCookies: (state) => {
        headlessSessionCookies = state;
      },
    });
    assertRestoredManifestAuthority(receipt.manifest, input.restore);
    await rm(input.profileDirectory, { recursive: true, force: true });
    await rename(stagingDirectory, input.profileDirectory);
    await chmod(input.profileDirectory, 0o700);
    return {
      manifest: receipt.manifest,
      ...(headlessSessionCookies ? { headlessSessionCookies } : {}),
    };
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

/** Bounded, content-free cause for a launch receipt; never page data or secrets. */
function launchFailureCode(error: unknown): string {
  if (error instanceof InteractionControllerError) return boundedFailureCode(error.code);
  if (error instanceof AggregateError) return "cleanup_failed";
  const code = (error as { code?: unknown } | null)?.code;
  return boundedFailureCode(typeof code === "string" ? code : "internal");
}

const BROWSER_LAUNCH_REASON_MAX_CHARS = 1_000;

/** A browser that cannot start says why, so the caller can act on it instead
 * of retrying an opaque failure. The driver's own launch message (a missing
 * Chrome, a crash on startup with its stderr) is already bounded to one line;
 * every other failure keeps its original type and contract. */
export function browserLaunchFailure(error: unknown): unknown {
  if (!(error instanceof AgentBrowserCommandError) || !error.driverMessage) return error;
  if (/^Chrome not found\b/u.test(error.driverMessage)) {
    return new InteractionDefiniteDriverError(
      "unsupported",
      "No Google Chrome or Chromium is installed on this machine, so a browser cannot start here. Install Google Chrome on it, or open the browser on another placement.",
    );
  }
  const reason = error.driverMessage.slice(0, BROWSER_LAUNCH_REASON_MAX_CHARS);
  return new InteractionDefiniteDriverError(
    "driver_failed",
    `The browser could not start on this machine: ${reason}`,
  );
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

function boundedOpaqueText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  const text = boundedText(value, minimum, maximum, label);
  if (text.trim() !== text || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
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
  if (snapshot.engine === "lightpanda") {
    throw new InteractionControllerError(
      "unsupported",
      "Lightpanda sessions do not support portable browser profile capture",
    );
  }
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

/** Rebuild a checkpoint's tab set on a freshly launched restored profile. A
 * saved tab whose page can't load right now (its host is down or no longer
 * resolves) is still reopened on the browser's error page, so one unreachable
 * site never makes the whole browser unrecoverable. */
export async function restoreTabs(
  driver: BrowserSupervisorDriver,
  capturedTabs: BrowserRuntimeSnapshot["tabs"],
): Promise<void> {
  const tabs =
    capturedTabs.length > 0
      ? capturedTabs.map((tab) => ({ ...tab, url: restoredTabUrl(tab.url) }))
      : [{ url: "about:blank", selected: true }];
  const primaryIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.selected),
  );
  const ordered = [tabs[primaryIndex]!, ...tabs.filter((_, index) => index !== primaryIndex)];
  const reopen = { keepTabOnLoadError: true } satisfies BrowserTabNavigationOptions;
  const first = await driver.start(ordered[0]!.url, reopen);
  const available = (await driver.listTargets()).filter(
    (target) => target.kind === "page" || target.kind === "popup",
  );
  const used = new Set<string>();
  let selectedTargetId: string | null = null;
  for (const [index, tab] of ordered.entries()) {
    // Startup chose a live tab for the primary and navigated it there. A
    // reopened tab with the same URL may have a dead renderer, so the primary
    // is always the tab startup returned, never a URL look-alike.
    const target =
      index === 0
        ? first.target
        : (available.find((candidate) => !used.has(candidate.id) && candidate.url === tab.url) ??
          (await driver.openTarget(tab.url, reopen)).target);
    used.add(target.id);
    if (index === 0) selectedTargetId = target.id;
  }
  for (const target of available) {
    if (!used.has(target.id)) await driver.closeTarget(target.id);
  }
  if (selectedTargetId) await driver.selectTarget(selectedTargetId);
}
