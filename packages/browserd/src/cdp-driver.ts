import {
  navigateBrowserMetadataDocument,
  navigateToInterceptedMetadataDocument,
} from "./browser-metadata";
import { createHash, randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  BrowserActionCommand,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDiagnosticEntry,
  BrowserDialog,
  InteractionSecretValueError,
  materializeBrowserActionSecrets,
  redactInteractionSecretValues,
  BrowserDomReadResponse,
  BrowserTargetState,
  BrowserExternalAuthCommand,
  BrowserExternalAuthResult,
  BrowserObservation,
  BrowserTarget,
  INTERACTION_MAX_DIAGNOSTIC_ENTRIES,
  INTERACTION_MAX_CLIPBOARD_BYTES,
  INTERACTION_PROTOCOL_VERSION,
  type BrowserAction,
  type BrowserActionCommand as BrowserActionCommandValue,
  type BrowserClipboard as BrowserClipboardValue,
  type BrowserDiagnosticBatch as BrowserDiagnosticBatchValue,
  type BrowserDiagnosticKind,
  type BrowserExternalAuthCommand as BrowserExternalAuthCommandValue,
  type BrowserExternalAuthResult as BrowserExternalAuthResultValue,
  type BrowserLocator,
  type BrowserDomReadRequest as BrowserDomReadRequestValue,
  type BrowserDomReadResponse as BrowserDomReadResponseValue,
  type BrowserTargetState as BrowserTargetStateValue,
  type BrowserObservation as BrowserObservationValue,
  type BrowserTarget as BrowserTargetValue,
  type BrowserActionResolvedTarget as BrowserActionResolvedTargetValue,
  type InteractionSemanticNodeValue,
  INTERACTION_MAX_RESOLVED_TARGET_TEXT,
} from "@opengeni/contracts";
import {
  InteractionControllerError,
  InteractionDefiniteDriverError,
  InteractionOutcomeUnknownDriverError,
  type BrowserInteractionDriver,
  type InteractionDispatchTrace,
} from "@opengeni/interaction";
import {
  accessibilityContainer,
  namespaceCdpAccessibilityFrame,
  normalizeCdpAccessibilityTree,
  type CdpAccessibilityEntry,
  type CdpAccessibilitySnapshot,
  type CdpAxNode,
} from "./cdp-accessibility";
import {
  CdpCommandTimeoutError,
  CdpConnection,
  CdpProtocolError,
  CdpSessionDetachedError,
  CdpTransportError,
  type CdpEvent,
} from "./cdp";
import {
  LatestBrowserFrameSubscription,
  assertImageDimensions,
  decodeBoundedBase64Image,
  imageDimensions,
  normalizeFrameStreamOptions,
  normalizeScreenshotOptions,
  type BrowserFrameStreamOptions,
  type BrowserFrameSubscription,
  type BrowserImageFrame,
  type BrowserScreenshotOptions,
  type NormalizedBrowserFrameStreamOptions,
} from "./media";
import type {
  BrowserDownloadBeginEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadProgressResult,
} from "./downloads";
import type { AgentBrowserJsonCommand, OwnedManagedBrowserProcess } from "./runner";
import type { BrowserPasskeyManager } from "./passkeys";
import {
  captureHeadlessSessionCookies,
  restoreHeadlessSessionCookies,
  validateHeadlessSessionCookies,
  type HeadlessSessionCookies,
} from "./headless-session-cookies";

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const BROWSER_START_TIMEOUT_MS = 30_000;
const TARGET_CREATION_SETTLE_TIMEOUT_MS = 5_000;
const TARGET_CLOSE_SETTLE_TIMEOUT_MS = 2_000;
// A screenshot stream is the compatibility floor for every Chromium build.
// Keep it interactive even when Page.startScreencast is unavailable or a
// background target never produces screencast events.
const FRAME_FALLBACK_INTERVAL_MS = 100;
const FRAME_CAPTURE_TIMEOUT_MS = 2_000;
// Still captures share the target/input queue. Bound the whole read phase so
// a renderer that stops producing pixels cannot hold it for successive CDP deadlines.
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 10_000;
const FRAME_CAPTURE_FAILURE_LIMIT = 3;
const MAX_FRAME_PROFILES_PER_TARGET = 4;
const MAX_FRAME_SUBSCRIPTIONS_PER_TARGET = 32;
const GRACEFUL_BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_MS = 500;
const MAX_FRAME_TREES = 512;
const ACCESSIBILITY_FRAME_CONCURRENCY = 16;
const ACCESSIBILITY_SNAPSHOT_ATTEMPTS = 3;
type BrowserPermissionAction = Extract<BrowserAction, { type: "permission" }>;
const CDP_PERMISSION_NAMES: Record<BrowserPermissionAction["permission"], string> = {
  geolocation: "geolocation",
  notifications: "notifications",
  camera: "videoCapture",
  microphone: "audioCapture",
  midi: "midi",
  midi_sysex: "midiSysex",
  sensors: "sensors",
  idle_detection: "idleDetection",
  local_fonts: "localFonts",
  window_management: "windowManagement",
};
const USER_AGENT_METADATA_EXPRESSION = `(async () => {
  const data = navigator.userAgentData;
  if (!data || typeof data.getHighEntropyValues !== "function") return null;
  const high = await data.getHighEntropyValues([
    "architecture", "bitness", "formFactors", "fullVersionList", "model",
    "platformVersion", "wow64"
  ]);
  return {
    brands: data.brands,
    mobile: data.mobile,
    platform: data.platform,
    ...high,
  };
})()`;

class DialogOpenedSignal extends Error {}

export type BrowserCommandRunner = {
  run: AgentBrowserJsonCommand;
  daemonPid?: () => Promise<number | null>;
  terminate?: (expectedPid?: number | null) => Promise<void>;
  ownedProcessIdentity?: (
    cdpEndpoint: string,
    cdpBrowserPid?: number,
  ) => Promise<OwnedManagedBrowserProcess | null>;
  readonly reattachedOwnedProcess?: OwnedManagedBrowserProcess | null;
  externalAuth?: (
    command: BrowserExternalAuthCommand,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<BrowserExternalAuthDispatchResult>;
};

export type BrowserExternalAuthDispatchResult = {
  result: BrowserExternalAuthResultValue;
  /** The provider changed the physical browser behind its stable session. */
  browserReconfigured: boolean;
};

export type BrowserCdpConnection = {
  onDisconnect?: (listener: () => void) => () => void;
  /** Throws a definite error for a page this transport can never control. */
  assertNavigable?: (url: string) => void;
  send<T = Record<string, unknown>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  on(method: string, listener: (event: CdpEvent) => void, sessionId?: string): () => void;
  waitForEvent(
    method: string,
    options?: {
      sessionId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      predicate?: (params: Record<string, unknown>) => boolean;
    },
  ): Promise<CdpEvent>;
  close(): void;
};

type TargetInfo = {
  browserContextId: string | null;
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId: string | null;
};

type MainFrame = {
  id: string;
  loaderId: string;
  url: string;
};

type PageFrameTree = {
  frame: MainFrame;
  childFrames: PageFrameTree[];
};

type Diagnostics = {
  consoleErrorCount: number;
  failedRequestCount: number;
  downloadCount: number;
  pageErrorCount: number;
};

type TargetScreencast = {
  key: string;
  options: NormalizedBrowserFrameStreamOptions;
  sequence: number;
  lastFrameAt: number;
  captureScale: { width: number; height: number; scale: number } | null;
  fallbackAbort: AbortController;
  capturePromise: Promise<void> | null;
  subscriptions: Map<string, LatestBrowserFrameSubscription>;
  unsubscribe: () => void;
};

type TargetState = {
  targetId: string;
  sessionId: string;
  authorityGeneration: string;
  actionEffectCount: number;
  createdAt: string;
  frame: MainFrame;
  documentGeneration: string;
  frameGeneration: string;
  accessibility: CdpAccessibilitySnapshot | null;
  dialog: BrowserDialog | null;
  diagnostics: Diagnostics;
  diagnosticEntries: BrowserDiagnosticEntry[];
  diagnosticSequence: number;
  inflightRequests: Set<string>;
  networkTrackingOverflow: boolean;
  failedRequests: Set<string>;
  requests: Map<string, { method: string; url: string }>;
  lastNetworkActivityAt: number;
  networkActivitySequence: number;
  screencasts: Map<string, TargetScreencast>;
  tail: Promise<void>;
  unsubscribe: Array<() => void>;
  /** Set only while dispatching one action of a traced command. */
  actionTrace?: { actionIndex: number; trace: InteractionDispatchTrace } | undefined;
  /** Cross-origin iframes (out-of-process frames) by frame id. Each has its own
   * flattened CDP session, auto-attached from this page session. */
  oopifs: Map<string, OopifSession>;
  /** Node-level CDP calls go to this OOPIF session while one operation acts on
   * a node inside it. Input always goes to the page session. */
  nodeRoute: OopifSession | null;
};

type OopifSession = {
  frameId: string;
  sessionId: string;
  /** Session that owns the frame's `<iframe>` element: the page, or an outer OOPIF. */
  parentSessionId: string;
  /** Frame ids rendered by this session (the OOPIF and its same-process children). */
  frameIds: Set<string>;
};

export type AgentBrowserDriverOptions = {
  browserSessionId: string;
  controllerGeneration: string;
  runner: BrowserCommandRunner;
  now?: () => Date;
  createId?: () => string;
  resolveWorkspaceFiles?: (
    operationId: string,
    workspaceFileIds: readonly string[],
  ) => Promise<readonly string[]>;
  downloadDirectory?: string;
  downloadEvents?: {
    begin(event: BrowserDownloadBeginEvent): Promise<unknown>;
    progress(event: BrowserDownloadProgressEvent): Promise<BrowserDownloadProgressResult>;
    reject(guid: string, failureCode: string): Promise<void>;
  };
  connect?: (endpoint: string) => Promise<BrowserCdpConnection>;
  engine?: "chromium" | "chrome" | "lightpanda";
  /** Whether the lifecycle runner or this controller-owned CDP connection
   * creates page targets. Remote and non-Chromium CDP engines commonly scope
   * targets to the connection that created them, so they require `cdp`. */
  targetLifecycle?: "runner" | "cdp";
  /** The browser belongs to the person (attached Chrome): an explicit end
   * closes the tabs this session opened that are still blank. */
  closeUnusedOwnedTabsOnEnd?: boolean;
  tabControl?: boolean;
  /** Keep owned Chromium pages active without changing the foreground tab. */
  focusEmulation?: boolean;
  frameStreaming?: boolean;
  emulation?: BrowserSessionEmulation;
  permissionControl?: boolean;
  /** Experimental ephemeral context lease. Never a durable browser profile. */
  browserContextId?: string;
  /** Headless shell has no chrome://version page. Read its real Client Hints
   * from a controller-intercepted secure-origin document instead. */
  userAgentMetadataSource?: "chrome_internal" | "intercepted_local";
  /** Set only by the verified, dedicated managed headless-shell launcher. */
  preserveHeadlessSessionCookies?: boolean;
  headlessSessionCookies?: HeadlessSessionCookies;
  /** Attach every page target (popups included) at the browser level as it is
   * created, paused until set up. Defaults to on for managed Chromium. */
  targetAutoAttach?: boolean;
  /** Install a virtual WebAuthn authenticator into every page target. Acting
   * on a tab then brings it to the front first: WebAuthn needs page focus. */
  passkeys?: BrowserPasskeyManager;
};

export type BrowserSessionEmulation = {
  locale: string | null;
  timezone: string | null;
  geolocation: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
  } | null;
};

type BrowserUserAgentMetadata = {
  brands?: Array<{ brand: string; version: string }>;
  fullVersionList?: Array<{ brand: string; version: string }>;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
  wow64?: boolean;
  formFactors?: string[];
};

/** How a tab's navigation treats a page that fails to load. */
export type BrowserTabNavigationOptions = {
  /** Reopening a saved tab: when its page can't load (the host is unreachable
   * or no longer resolves), keep the tab open on the browser's error page with
   * its URL, as the browser's own session restore does, instead of failing.
   * Navigation policy refusals and invalid URLs still fail. */
  keepTabOnLoadError?: boolean;
};

export type BrowserRuntimeSnapshot = {
  engine: "chromium" | "chrome" | "lightpanda";
  engineVersion: string | null;
  tabs: Array<{ url: string; selected: boolean }>;
};

function hasBrowserEmulation(
  value: BrowserSessionEmulation | undefined,
): value is BrowserSessionEmulation {
  return Boolean(
    value && (value.locale !== null || value.timezone !== null || value.geolocation !== null),
  );
}

/**
 * Target-scoped browser authority. agent-browser owns the pinned Chrome/profile
 * lifecycle; Opengeni talks to that private browser through one local CDP
 * connection and keeps an independent causal queue for every target.
 */
export class AgentBrowserDriver implements BrowserInteractionDriver {
  readonly fencedInputBatches = true;
  get focusedInputObservations(): boolean {
    return this.engine !== "lightpanda";
  }
  private readonly browserSessionId: string;
  private readonly controllerGeneration: string;
  private readonly runner: BrowserCommandRunner;
  private connectionEndpoint: string | null = null;
  private readonly now: () => Date;
  private readonly createId: () => string;
  /** Private physical-process fence. Provider target/loader ids are not
   * required to be globally unique and may repeat after crash recovery. */
  private physicalGeneration: string;
  private readonly engine: "chromium" | "chrome" | "lightpanda";
  private readonly targetLifecycle: "runner" | "cdp";
  private readonly closeUnusedOwnedTabsOnEnd: boolean;
  /** Tabs this session created, in a browser it does not own. */
  private readonly createdTargetIds = new Set<string>();
  private readonly tabControl: boolean;
  /** Cleared once the browser refuses focus emulation, so later targets keep
   * working without it instead of each paying the refusal. */
  private focusEmulation: boolean;
  private readonly frameStreaming: boolean;
  private readonly emulation: BrowserSessionEmulation | null;
  private readonly permissionControl: boolean;
  private readonly browserContextId: string | undefined;
  private readonly ownedDownloads = new Set<string>();
  private readonly userAgentMetadataSource: "chrome_internal" | "intercepted_local";
  private userAgentMetadataPromise: Promise<BrowserUserAgentMetadata> | null = null;
  private readonly resolveWorkspaceFiles:
    | ((operationId: string, workspaceFileIds: readonly string[]) => Promise<readonly string[]>)
    | undefined;
  private readonly downloadDirectory: string | null;
  private readonly downloadEvents: AgentBrowserDriverOptions["downloadEvents"];
  private readonly connect: (endpoint: string) => Promise<BrowserCdpConnection>;
  private readonly states = new Map<string, TargetState>();
  private readonly firstSeenAt = new Map<string, string>();
  private readonly attaching = new Map<string, Promise<TargetState>>();
  private readonly attachingSessions = new Map<string, string>();
  /** Tabs whose renderer process died. Cleared when the tab attaches healthily again. */
  private readonly crashedTargets = new Set<string>();
  private readonly targetPhysicalGenerations = new Map<string, string>();
  private connection: BrowserCdpConnection | null = null;
  private connectionPromise: Promise<BrowserCdpConnection> | null = null;
  private selectedTargetId: string | null = null;
  private userAgent = "";
  private browserProduct = "";
  private browserUnsubscribe: Array<() => void> = [];
  private clipboardRevision = 0;
  private clipboardText = "";
  private clipboardSource: BrowserClipboardValue["source"] = "empty";
  private clipboardSourceTargetId: string | null = null;
  private clipboardUpdatedAt: string | null = null;
  private readonly externalAuthResults = new Map<
    string,
    { digest: string; result: BrowserExternalAuthResultValue }
  >();
  private started = false;
  private readonly preserveHeadlessSessionCookies: boolean;
  private headlessSessionCookies: HeadlessSessionCookies | null;
  private readonly targetAutoAttach: boolean;
  private readonly passkeys: BrowserPasskeyManager | null;
  /** Browser-level auto-attached session per page target (never the state session). */
  private readonly autoSessions = new Map<string, string>();
  /** Page target last brought to the front by this controller, when known. */
  private frontTargetId: string | null = null;

  constructor(options: AgentBrowserDriverOptions) {
    if (
      options.browserContextId !== undefined &&
      (!options.browserContextId ||
        options.targetLifecycle !== "cdp" ||
        options.runner.externalAuth ||
        (options.engine !== undefined && options.engine !== "chromium"))
    ) {
      throw new Error("ephemeral contexts require Chromium CDP lifecycle without external auth");
    }
    this.browserContextId = options.browserContextId;
    this.browserSessionId = options.browserSessionId;
    this.controllerGeneration = options.controllerGeneration;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.physicalGeneration = randomUUID();
    this.engine = options.engine ?? "chromium";
    this.preserveHeadlessSessionCookies = options.preserveHeadlessSessionCookies ?? false;
    if (
      (this.preserveHeadlessSessionCookies || options.headlessSessionCookies) &&
      (this.engine !== "chromium" || (options.targetLifecycle ?? "runner") !== "runner")
    ) {
      throw new Error("Headless cookie state requires its dedicated managed launcher");
    }
    if (options.headlessSessionCookies && !this.preserveHeadlessSessionCookies)
      throw new Error("Headless cookie state requires its verified shell launcher");
    this.headlessSessionCookies = options.headlessSessionCookies
      ? validateHeadlessSessionCookies(options.headlessSessionCookies)
      : null;
    this.targetLifecycle = options.targetLifecycle ?? "runner";
    this.closeUnusedOwnedTabsOnEnd = options.closeUnusedOwnedTabsOnEnd ?? false;
    this.tabControl = options.tabControl ?? true;
    this.focusEmulation = options.focusEmulation ?? false;
    this.frameStreaming = options.frameStreaming ?? true;
    this.emulation = hasBrowserEmulation(options.emulation) ? options.emulation : null;
    this.permissionControl = options.permissionControl ?? true;
    this.targetAutoAttach = options.targetAutoAttach ?? this.engine === "chromium";
    this.passkeys = options.passkeys ?? null;
    this.userAgentMetadataSource = options.userAgentMetadataSource ?? "chrome_internal";
    this.resolveWorkspaceFiles = options.resolveWorkspaceFiles;
    this.downloadDirectory = options.downloadDirectory
      ? resolvePath(options.downloadDirectory)
      : null;
    this.downloadEvents = options.downloadEvents;
    this.connect = options.connect ?? (async (endpoint) => await CdpConnection.connect(endpoint));
  }

  async start(
    url?: string,
    options: BrowserTabNavigationOptions = {},
  ): Promise<BrowserObservationValue> {
    const deferNavigation = url !== undefined && url !== "about:blank";
    // Resolving the daemon's private CDP endpoint is itself the cold-start
    // primitive. Calling `agent-browser open` first makes the CLI perform one
    // complete launch/lifecycle reconciliation and `get cdp-url` immediately
    // perform another. Apart from adding seconds on headed macOS, the first
    // command can also manufacture a redundant tab. Connect once, reuse the
    // launch-created page, and perform the one intended navigation through our
    // target-scoped CDP authority.
    this.started = true;
    let connection: BrowserCdpConnection;
    let target: TargetInfo;
    if (this.targetLifecycle === "cdp") {
      connection = await this.ensureConnection();
      if (deferNavigation) connection.assertNavigable?.(url);
      const created = await connection.send<{ targetId?: unknown }>(
        "Target.createTarget",
        { url: "about:blank", background: true, ...this.contextScope() },
        { timeoutMs: BROWSER_START_TIMEOUT_MS },
      );
      if (typeof created.targetId !== "string" || !created.targetId) {
        throw new Error("browser did not return its initial page target");
      }
      if (this.closeUnusedOwnedTabsOnEnd) this.createdTargetIds.add(created.targetId);
      // Attached Chrome's tab inventory may lag the creation receipt. Never
      // substitute another tab (even another blank tab) for the exact target
      // we created: the initial navigation would overwrite the user's page.
      try {
        target = await this.waitForCreatedTargetInfo(connection, created.targetId);
        this.selectedTargetId = target.targetId;
        if (deferNavigation)
          await this.navigate(await this.ensureTargetState(target), url, options);
        return await this.observe(target.targetId);
      } catch (error) {
        // The session never started, so nothing can use or close this tab.
        await this.discardCreatedTarget(connection, created.targetId);
        throw error;
      }
    } else {
      connection = await this.ensureConnection();
      if (this.headlessSessionCookies) {
        await restoreHeadlessSessionCookies(connection, this.headlessSessionCookies);
        this.headlessSessionCookies = null;
      }
      // A restored profile can reopen a tab whose renderer is already dead.
      // That tab stays in the inventory for the user to close; startup selects
      // the first live tab instead, and only creates one when none is live.
      let page: TargetInfo | undefined;
      for (const candidate of visiblePageTargets(await this.targetInfos(connection))) {
        try {
          await this.ensureTargetState(candidate);
        } catch (error) {
          if (this.crashedTargets.has(candidate.targetId)) continue;
          throw error;
        }
        page = candidate;
        break;
      }
      if (!page) {
        const created = await connection.send<{ targetId?: unknown }>(
          "Target.createTarget",
          { url: "about:blank", background: true, ...this.contextScope() },
          { timeoutMs: BROWSER_START_TIMEOUT_MS },
        );
        if (typeof created.targetId !== "string") {
          throw new Error("managed browser did not return its initial page target");
        }
        page = await this.waitForCreatedTargetInfo(connection, created.targetId);
      }
      target = page;
    }
    this.selectedTargetId = target.targetId;
    if (deferNavigation) {
      await this.navigate(await this.ensureTargetState(target), url, options);
    }
    return await this.observe(target.targetId);
  }

  /** Bounded browser liveness probe for the supervisor's recovery path.
   * Renderer stalls and command deadlines do not prove browser loss: replacing
   * a live browser would discard document state that URL restoration cannot recover. */
  async isAvailable(): Promise<boolean> {
    if (!this.started || !this.connection) return false;
    try {
      await this.connection.send("Browser.getVersion", {}, { timeoutMs: 2_000 });
      return true;
    } catch (error) {
      return error instanceof CdpCommandTimeoutError || !(error instanceof CdpTransportError);
    }
  }

  /** Private launch attestation; never returned in observations or snapshots. */
  async ownedProcessIdentity(): Promise<OwnedManagedBrowserProcess | null> {
    if (!this.connection || !this.connectionEndpoint || !this.runner.ownedProcessIdentity)
      return null;
    const pid = await ownedCdpProcessId(this.connection);
    const process = await this.runner.ownedProcessIdentity(this.connectionEndpoint, pid);
    if (!process) return null;
    await assertOwnedCdpProcess(this.connection, process);
    return process;
  }

  async listTargets(): Promise<BrowserTargetValue[]> {
    const connection = await this.ensureConnection();
    const infos = visibleTargets(await this.targetInfos(connection));
    return infos.map((info) => {
      const state = this.states.get(info.targetId);
      return this.targetFromInfo(info, state ?? null);
    });
  }

  async openTarget(
    url = "about:blank",
    options: BrowserTabNavigationOptions = {},
  ): Promise<BrowserObservationValue> {
    const state = await this.createTarget(url, options);
    return await this.observe(state.targetId);
  }

  /** Open a tab when the caller needs inventory rather than page content. */
  async openTargetWithInventory(url = "about:blank"): Promise<BrowserTargetValue[]> {
    const state = await this.createTarget(url);
    if (!state.dialog) await this.refreshFrame(state);
    const targets = await this.listTargets();
    this.assertCurrentTargetState(state);
    return targets;
  }

  private async createTarget(
    url: string,
    options: BrowserTabNavigationOptions = {},
  ): Promise<TargetState> {
    if (!this.tabControl) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine does not support multiple tabs",
      );
    }
    const connection = await this.ensureConnection();
    // Establish the blank document and target policies before remote navigation.
    // A slow response must use the navigation budget, not the target-creation deadline.
    const deferNavigation = url !== "about:blank";
    if (deferNavigation) connection.assertNavigable?.(url);
    const result = await connection.send<{ targetId?: unknown }>("Target.createTarget", {
      ...this.contextScope(),
      url: deferNavigation ? "about:blank" : url,
      background: true,
    });
    if (typeof result.targetId !== "string") throw new Error("CDP did not return a target id");
    if (this.closeUnusedOwnedTabsOnEnd) this.createdTargetIds.add(result.targetId);
    const previousSelection = this.selectedTargetId;
    const createdTarget = await this.waitForCreatedTargetInfo(connection, result.targetId);
    const createdState = await this.ensureTargetState(createdTarget);
    await this.waitForCreatedTargetFrame(createdState);
    this.selectedTargetId = result.targetId;
    if (deferNavigation) {
      try {
        await this.navigate(createdState, url, options);
      } catch (error) {
        // A slow page may still finish loading in a tab the caller can list
        // and select. Any other failure leaves a tab nobody asked for: the
        // blank bootstrap document, or a page the browser will not let us
        // control. The caller was told the open failed, so close it.
        if (!isNavigationTimeout(error)) {
          await this.discardCreatedTarget(connection, result.targetId);
          if (this.selectedTargetId === result.targetId) this.selectedTargetId = previousSelection;
        }
        throw error;
      }
    }
    return createdState;
  }

  private async discardCreatedTarget(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<void> {
    this.removeState(targetId);
    this.createdTargetIds.delete(targetId);
    if (this.selectedTargetId === targetId) this.selectedTargetId = null;
    try {
      await this.closeTargetAndSettle(connection, targetId);
    } catch {
      // Best effort: the tab may already be gone, and the original failure
      // is what the caller needs to see.
    }
  }

  /** Target.closeTarget is acknowledged before the browser drops the tab from
   * Target.getTargets, and a cold or loaded browser can keep listing it for a
   * moment. Wait until it is gone, so a tab list returned after a close never
   * shows the closed tab. */
  private async closeTargetAndSettle(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<void> {
    await connection.send("Target.closeTarget", { targetId });
    const deadline = Date.now() + TARGET_CLOSE_SETTLE_TIMEOUT_MS;
    while ((await this.targetInfos(connection)).some((info) => info.targetId === targetId)) {
      if (Date.now() >= deadline) return;
      await delay(25);
    }
  }

  async selectTarget(targetId: string): Promise<BrowserObservationValue> {
    const connection = await this.ensureConnection();
    await this.requireTargetInfo(connection, targetId);
    this.selectedTargetId = targetId;
    return await this.observe(targetId);
  }

  async closeTarget(targetId: string): Promise<BrowserTargetValue[]> {
    if (!this.tabControl) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine does not support closing individual tabs",
      );
    }
    const connection = await this.ensureConnection();
    await this.requireTargetInfo(connection, targetId);
    await this.closeTargetAndSettle(connection, targetId);
    this.removeState(targetId);
    this.createdTargetIds.delete(targetId);
    if (this.selectedTargetId === targetId) this.selectedTargetId = null;
    return await this.listTargets();
  }

  /** Close the tabs this session opened in the person's browser that are
   * still blank, so ending the session does not leave empty tabs behind.
   * Tabs that show a page stay: the person may still want what the agent
   * left there. */
  async closeUnusedOwnedTabs(): Promise<void> {
    if (!this.closeUnusedOwnedTabsOnEnd || this.createdTargetIds.size === 0 || !this.connection)
      return;
    const connection = this.connection;
    const infos = await this.targetInfos(connection);
    for (const info of infos) {
      if (!this.createdTargetIds.has(info.targetId) || !isBlankTabUrl(info.url)) continue;
      try {
        await this.closeTargetAndSettle(connection, info.targetId);
      } catch {
        // Best effort per tab; the session end itself still proceeds.
      }
      this.createdTargetIds.delete(info.targetId);
    }
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.browserUnsubscribe.splice(0)) unsubscribe();
    for (const targetId of [...this.states.keys()]) this.removeState(targetId);
    this.firstSeenAt.clear();
    this.attachingSessions.clear();
    this.targetPhysicalGenerations.clear();
    this.forgetAutoAttachments();
    this.ownedDownloads.clear();
    const connection = this.connection;
    this.connection = null;
    this.connectionPromise = null;
    let closeError: unknown = null;
    let terminationError: unknown = null;
    let daemonPid: number | null = null;
    if (this.started && this.targetLifecycle === "runner" && this.runner.daemonPid) {
      try {
        daemonPid = await this.runner.daemonPid();
      } catch (error) {
        terminationError = error;
      }
    }
    if (this.started && this.targetLifecycle === "runner") {
      try {
        await this.runner.run(["close"], {
          timeoutMs: GRACEFUL_BROWSER_CLOSE_TIMEOUT_MS,
        });
      } catch (error) {
        closeError = error;
      }
    }
    this.started = false;
    try {
      await this.runner.terminate?.(daemonPid);
    } catch (error) {
      terminationError ??= error;
    } finally {
      connection?.close();
    }
    if (terminationError) {
      if (closeError) {
        throw new AggregateError(
          [closeError, terminationError],
          "managed browser and daemon cleanup failed",
        );
      }
      throw terminationError;
    }
    if (closeError && !this.runner.terminate) throw closeError;
  }

  async detach(): Promise<void> {
    for (const unsubscribe of this.browserUnsubscribe.splice(0)) unsubscribe();
    for (const targetId of [...this.states.keys()]) this.removeState(targetId);
    this.firstSeenAt.clear();
    this.attachingSessions.clear();
    this.targetPhysicalGenerations.clear();
    this.forgetAutoAttachments();
    this.ownedDownloads.clear();
    this.connection?.close();
    this.connection = null;
    this.connectionPromise = null;
    this.connectionEndpoint = null;
    this.started = false;
  }

  async runtimeSnapshot(): Promise<BrowserRuntimeSnapshot> {
    if (this.browserContextId) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "ephemeral browser contexts cannot capture or restore durable profiles",
      );
    }
    const targets = await this.listTargets();
    const tabs: BrowserRuntimeSnapshot["tabs"] = [];
    for (const target of targets) {
      if (target.kind !== "page" && target.kind !== "popup") continue;
      // A tab showing the browser's error page still belongs to the page it
      // failed to load; save that page so a later restore can retry it.
      const url = target.url.toLowerCase().startsWith("chrome-error:")
        ? ((await this.errorPageDestination(target.id)) ?? target.url)
        : target.url;
      tabs.push({ url, selected: target.selected });
    }
    const separator = this.browserProduct.indexOf("/");
    const rawVersion = separator >= 0 ? this.browserProduct.slice(separator + 1) : "";
    const engineVersion =
      rawVersion.length > 0 && Buffer.byteLength(rawVersion) <= 256 ? rawVersion : null;
    return { engine: this.engine, engineVersion, tabs };
  }

  /** The http(s) URL an error page failed to load, read from its current
   * history entry. Null when it can't be read; the caller keeps the error URL. */
  private async errorPageDestination(targetId: string): Promise<string | null> {
    try {
      const connection = await this.ensureConnection();
      const info = (await this.targetInfos(connection)).find(
        (candidate) => candidate.targetId === targetId,
      );
      if (!info) return null;
      const history = await this.sendActionTarget<{ currentIndex?: unknown; entries?: unknown }>(
        await this.ensureTargetState(info),
        "Page.getNavigationHistory",
        {},
      );
      const entries = Array.isArray(history.entries) ? history.entries : [];
      const entry =
        typeof history.currentIndex === "number" ? entries[history.currentIndex] : undefined;
      if (!isRecord(entry) || typeof entry.url !== "string") return null;
      return /^https?:\/\//iu.test(entry.url) ? entry.url : null;
    } catch {
      return null;
    }
  }

  /** Supervisor-only read after both action controllers have quiesced. Never
   * exposed through the public browser observation/tool surface. */
  async captureSessionCookies(): Promise<HeadlessSessionCookies | null> {
    if (!this.preserveHeadlessSessionCookies) return null;
    if (!this.started || !this.connection)
      throw new Error("Headless cookie capture requires its active physical browser");
    return await captureHeadlessSessionCookies(this.connection, {
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
    });
  }

  get requiresExplicitProfileRestore(): boolean {
    return this.preserveHeadlessSessionCookies;
  }

  async target(targetId: string): Promise<BrowserTargetValue | null> {
    const connection = await this.ensureConnection();
    const info = (await this.targetInfos(connection)).find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!info || !isVisibleTarget(info)) return null;
    const state = await this.ensureTargetState(info);
    // A JavaScript dialog blocks ordinary page-domain inspection. Keep the
    // event-derived target/document/frame generations authoritative until the
    // dialog is handled; otherwise the controller's generic pre-dispatch
    // target validation can fail before `handle_dialog` reaches Chromium.
    if (!state.dialog) await this.refreshFrame(state);
    return this.targetFromInfo(info, state);
  }

  async observe(targetId: string): Promise<BrowserObservationValue> {
    return await this.withTarget(
      targetId,
      async (state, info) => await this.observeUnlocked(state, info),
    );
  }

  /** Refresh only the main-frame generation. No accessibility tree is read. */
  async targetState(targetId: string): Promise<BrowserTargetStateValue> {
    return await this.withTarget(targetId, async (state) => {
      if (!state.dialog) await this.refreshFrame(state);
      return this.targetStateFrom(state);
    });
  }

  async readDom(
    targetId: string,
    request: BrowserDomReadRequestValue,
  ): Promise<BrowserDomReadResponseValue> {
    return await this.withTarget(targetId, async (state) => {
      if (request.kind === "count") {
        assertSafeDomReadSelector(request.selector);
      } else if (request.locator.kind === "css") {
        assertSafeDomReadSelector(request.locator.selector);
      }
      if (state.dialog) {
        throw new InteractionDefiniteDriverError(
          "resource_unavailable",
          "browser DOM reads are unavailable while a dialog is open",
        );
      }
      await this.refreshFrame(state);
      this.assertReadGenerations(request, state);
      let result: Record<string, unknown>;
      if (request.kind === "count") {
        const count = await this.domSelectorCount(state, request.selector);
        result = { kind: "count", count, truncated: false };
      } else {
        const entry = await this.resolveLocator(state, request.locator);
        const value = await this.callOnNode(
          state,
          entry.backendDOMNodeId,
          DOM_READ_FUNCTION,
          [{ value: request.maxChars ?? 4_096 }, { value: request.attributes ?? [] }],
          { isolatedFrameId: entry.frameId ?? state.frame.id },
        );
        if (!isRecord(value) || value.ok !== true) {
          throw new InteractionDefiniteDriverError(
            "locator_not_found",
            "browser DOM element is no longer available",
          );
        }
        result = {
          kind: "element",
          count: 1,
          text: value.text,
          value: value.value,
          attributes: value.attributes,
          redacted: value.redacted,
          truncated: value.truncated,
        };
      }
      await this.refreshFrame(state);
      this.assertReadGenerations(request, state);
      return BrowserDomReadResponse.parse({ ...this.targetStateFrom(state), ...result });
    });
  }

  private targetStateFrom(state: TargetState): BrowserTargetStateValue {
    return BrowserTargetState.parse({
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      targetId: state.targetId,
      targetGeneration: this.targetGeneration(state.targetId),
      documentGeneration: state.documentGeneration,
      frameId: state.frameGeneration,
    });
  }

  private assertReadGenerations(request: BrowserDomReadRequestValue, state: TargetState): void {
    if (request.expectedTargetGeneration !== this.targetGeneration(state.targetId)) {
      throw new InteractionDefiniteDriverError(
        "target_stale",
        "browser target changed before DOM read",
      );
    }
    if (request.expectedDocumentGeneration !== state.documentGeneration) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "browser document changed before DOM read",
      );
    }
    if (request.expectedFrameId !== state.frameGeneration) {
      throw new InteractionDefiniteDriverError(
        "frame_stale",
        "browser frame changed before DOM read",
      );
    }
  }

  private async domSelectorCount(state: TargetState, selector: string): Promise<number> {
    const document = await this.sendTarget<{ root?: unknown }>(state, "DOM.getDocument", {
      depth: 0,
      pierce: true,
    });
    if (!isRecord(document.root) || typeof document.root.nodeId !== "number") {
      throw new Error("CDP returned an invalid DOM root");
    }
    let result: { nodeIds?: unknown };
    try {
      result = await this.sendTarget(state, "DOM.querySelectorAll", {
        nodeId: document.root.nodeId,
        selector,
      });
    } catch (error) {
      if (error instanceof CdpProtocolError) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser CSS selector is invalid",
        );
      }
      throw error;
    }
    if (!Array.isArray(result.nodeIds)) throw new Error("CDP returned an invalid DOM query result");
    return result.nodeIds.length;
  }

  async debug(
    targetId: string,
    options: {
      kinds?: readonly BrowserDiagnosticKind[];
      afterSequence?: number;
      limit?: number;
    } = {},
  ): Promise<BrowserDiagnosticBatchValue> {
    const kinds = options.kinds ? new Set(options.kinds) : null;
    const afterSequence = boundedNonnegativeInteger(
      options.afterSequence ?? 0,
      "diagnostic cursor",
    );
    const limit = boundedPositiveInteger(
      options.limit ?? 100,
      INTERACTION_MAX_DIAGNOSTIC_ENTRIES,
      "diagnostic limit",
    );
    return await this.withTarget(targetId, async (state) => {
      const available = state.diagnosticEntries.filter(
        (entry) => entry.sequence > afterSequence && (!kinds || kinds.has(entry.kind)),
      );
      const entries = available.slice(0, limit);
      const droppedBeforeCursor =
        state.diagnosticEntries.length > 0 &&
        state.diagnosticEntries[0]!.sequence > afterSequence + 1;
      const limited = available.length > entries.length;
      return BrowserDiagnosticBatch.parse({
        browserSessionId: this.browserSessionId,
        controllerGeneration: this.controllerGeneration,
        targetId,
        targetGeneration: this.targetGeneration(targetId),
        entries,
        cursor: limited
          ? entries.at(-1)!.sequence
          : Math.max(afterSequence, state.diagnosticSequence),
        truncated: droppedBeforeCursor || limited,
      });
    });
  }

  async captureScreenshot(
    targetId: string,
    options: BrowserScreenshotOptions = {},
  ): Promise<BrowserImageFrame> {
    // Lightpanda 0.3.5 implements this CDP method with an embedded static PNG,
    // not pixels from the current page. Never publish it as visual evidence.
    if (this.engine === "lightpanda") {
      throw new InteractionControllerError(
        "unsupported",
        "Lightpanda does not render page screenshots; use semantic observation",
      );
    }
    const normalized = normalizeScreenshotOptions(options);
    return await this.withTarget(targetId, async (state) => {
      const deadline = Date.now() + SCREENSHOT_CAPTURE_TIMEOUT_MS;
      await this.screenshotRead(
        "Page.getFrameTree",
        deadline,
        async (timeoutMs) => await this.refreshFrame(state, timeoutMs),
      );
      const metrics = await this.screenshotRead(
        "Page.getLayoutMetrics",
        deadline,
        async (timeoutMs) => await this.layoutMetrics(state, timeoutMs),
      );
      const capture: Record<string, unknown> = {
        format: normalized.format,
        fromSurface: true,
        captureBeyondViewport: normalized.fullPage,
        ...(normalized.format === "jpeg" ? { quality: normalized.quality } : {}),
      };
      let cssWidth = metrics.viewport.width;
      let cssHeight = metrics.viewport.height;
      let scrollX = metrics.viewport.x;
      let scrollY = metrics.viewport.y;
      if (normalized.fullPage) {
        cssWidth = metrics.content.width;
        cssHeight = metrics.content.height;
        scrollX = 0;
        scrollY = 0;
        assertImageDimensions(Math.ceil(cssWidth), Math.ceil(cssHeight));
        capture.clip = {
          x: 0,
          y: 0,
          width: cssWidth,
          height: cssHeight,
          scale: 1,
        };
      }
      const response = await this.screenshotRead(
        "Page.captureScreenshot",
        deadline,
        async (timeoutMs) =>
          await this.sendTarget<{ data?: unknown }>(state, "Page.captureScreenshot", capture, {
            timeoutMs,
          }),
      );
      const data = decodeBoundedBase64Image(response.data);
      const dimensions = imageDimensions(data, normalized.format);
      return this.imageFrame({
        state,
        sequence: 0,
        format: normalized.format,
        data,
        width: dimensions.width,
        height: dimensions.height,
        deviceScaleFactor: finiteScale(dimensions.width / cssWidth),
        scrollX,
        scrollY,
      });
    });
  }

  async subscribeFrames(
    targetId: string,
    options: BrowserFrameStreamOptions = {},
  ): Promise<BrowserFrameSubscription> {
    frameStreamDiagnostic("browser.frame.subscribe.begin", {
      browserSessionId: this.browserSessionId,
      targetId,
    });
    if (this.engine === "lightpanda" || !this.frameStreaming) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine does not support live frame streaming",
      );
    }
    const normalized = normalizeFrameStreamOptions(options);
    const configured = await this.withTarget(targetId, async (state) => {
      const key = frameStreamProfileKey(normalized);
      let screencast = state.screencasts.get(key);
      let created = false;
      if (!screencast) {
        if (state.screencasts.size >= MAX_FRAME_PROFILES_PER_TARGET) {
          throw new Error("browser target frame-profile bound was reached");
        }
        screencast = {
          key,
          options: normalized,
          sequence: 0,
          lastFrameAt: 0,
          captureScale: null,
          fallbackAbort: new AbortController(),
          capturePromise: null,
          subscriptions: new Map(),
          unsubscribe: () => undefined,
        };
        state.screencasts.set(key, screencast);
        created = true;
      }
      const subscriptionCount = [...state.screencasts.values()].reduce(
        (sum, candidate) => sum + candidate.subscriptions.size,
        0,
      );
      if (subscriptionCount >= MAX_FRAME_SUBSCRIPTIONS_PER_TARGET) {
        throw new Error("browser target frame-subscriber bound was reached");
      }
      const subscriptionId = this.createId();
      const subscription = new LatestBrowserFrameSubscription(
        async () => await this.releaseFrameSubscription(targetId, key, subscriptionId),
      );
      screencast.subscriptions.set(subscriptionId, subscription);
      return { state, screencast, subscription, created };
    });
    frameStreamDiagnostic("browser.frame.subscribe.configured", {
      browserSessionId: this.browserSessionId,
      targetId,
      created: configured.created,
    });
    try {
      // Chromium does not emit Page.screencastFrame for a background tab in a
      // headed browser. Seed every subscriber from the same target-scoped CDP
      // surface so attachment readiness never depends on focusing Chrome.
      let seedFailure: unknown;
      for (let attempt = 0; attempt < FRAME_CAPTURE_FAILURE_LIMIT; attempt += 1) {
        try {
          await this.captureFallbackFrame(targetId, configured.screencast);
          seedFailure = undefined;
          break;
        } catch (error) {
          seedFailure = error;
          if (attempt + 1 < FRAME_CAPTURE_FAILURE_LIMIT) await delay(25 * (attempt + 1));
        }
      }
      if (seedFailure !== undefined) throw seedFailure;
      frameStreamDiagnostic("browser.frame.subscribe.seeded", {
        browserSessionId: this.browserSessionId,
        targetId,
        sequence: configured.screencast.sequence,
      });
    } catch (error) {
      await configured.subscription.close().catch(() => undefined);
      throw error;
    }
    if (configured.created) {
      // Page.startScreencast can wedge every later target command when a headed
      // Chromium tab is not foregrounded. A continuously sampled, target-scoped
      // Page.captureScreenshot stream works for background tabs and keeps Browser
      // independent from the shared desktop's focus.
      this.pollFallbackFrames(targetId, configured.screencast);
    }
    return configured.subscription;
  }

  async dispatch(
    commandInput: BrowserActionCommandValue & { observationMode: "none" },
    trace?: InteractionDispatchTrace,
  ): Promise<null>;
  async dispatch(
    commandInput: BrowserActionCommandValue & { observationMode: "input" },
    trace?: InteractionDispatchTrace,
  ): Promise<BrowserObservationValue | null>;
  async dispatch(
    commandInput: BrowserActionCommandValue & { observationMode?: "full" },
    trace?: InteractionDispatchTrace,
  ): Promise<BrowserObservationValue>;
  async dispatch(
    commandInput: BrowserActionCommandValue,
    trace?: InteractionDispatchTrace,
  ): Promise<BrowserObservationValue>;
  async dispatch(
    commandInput: BrowserActionCommandValue,
    trace?: InteractionDispatchTrace,
  ): Promise<BrowserObservationValue | null> {
    const parsed = BrowserActionCommand.parse(commandInput);
    const secretValues = parsed.secretValues;
    const command = materializeCommandSecrets(parsed);
    // Input counts as sent once an effectful command left browserd, so a later
    // unresponsive-tab deadline must keep the action's outcome uncertain.
    let effects: { state: TargetState; before: number } | undefined;
    const observation = await this.withTarget(command.targetId, async (state, info) => {
      effects = { state, before: state.actionEffectCount };
      if (!state.dialog) await this.refreshFrame(state);
      this.assertExpectedGenerations(command, state);
      const actions = command.action.type === "batch" ? command.action.actions : [command.action];
      if (state.dialog && actions[0]?.type !== "handle_dialog") {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser JavaScript dialog must be handled before another action",
        );
      }
      await this.bringToFrontForAction(state);
      let completedActions = 0;
      const initialEffectCount = state.actionEffectCount;
      const requestsBeforeActions = {
        open: new Set(state.inflightRequests),
        activity: state.networkActivitySequence,
      };
      for (const [actionIndex, action] of actions.entries()) {
        state.actionTrace = trace ? { actionIndex, trace } : undefined;
        try {
          if (
            completedActions > 0 &&
            command.action.type === "batch" &&
            command.action.fenceEachAction
          ) {
            await this.refreshFrame(state);
            this.assertExpectedGenerations(command, state);
          }
          await this.dispatchAction(state, action, command.operationId);
          state.nodeRoute = null;
          state.actionTrace = undefined;
          completedActions += 1;
          if (state.dialog) {
            if (completedActions < actions.length) {
              throw new Error("browser action batch paused on a JavaScript dialog");
            }
            break;
          }
        } catch (error) {
          state.nodeRoute = null;
          state.actionTrace = undefined;
          if (error instanceof DialogOpenedSignal) {
            completedActions += 1;
            if (completedActions < actions.length) {
              throw new Error("browser action batch paused on a JavaScript dialog", {
                cause: error,
              });
            }
            break;
          }
          if (
            error instanceof InteractionDefiniteDriverError &&
            completedActions === 0 &&
            state.actionEffectCount === initialEffectCount
          )
            throw error;
          throw error instanceof InteractionDefiniteDriverError
            ? new InteractionOutcomeUnknownDriverError(
                "outcome_unknown",
                `browser action sent input or completed ${completedActions} action(s) before a later failure (${error.code}: ${error.message}); inspect the outcome before continuing and do not replay automatically`,
              )
            : error;
        }
      }
      if (command.observationMode === "none") return null;
      if (command.observationMode === "input") {
        // A live viewer already has pixels. Only native dropdowns need the
        // semantic options that Chromium's page stream cannot paint. Keep
        // ordinary clicks off the full accessibility/snapshot path.
        if (
          command.action.type !== "pointer" ||
          command.action.action !== "click" ||
          (command.action.button !== undefined && command.action.button !== "left") ||
          state.dialog ||
          !this.focusedInputObservations
        )
          return null;
        try {
          if (!(await this.mayHaveFocusedNativeSelect(state))) return null;
          const currentInfo = await this.requireTargetInfo(
            await this.ensureConnection(),
            info.targetId,
          );
          const observed = await this.observeUnlocked(state, currentInfo);
          // A focused iframe is a hint only. The authoritative AX focus and
          // redacted DOM metadata must actually identify a native select.
          const pending = [
            ...(observed.semantic?.kind === "snapshot" ? observed.semantic.roots : []),
          ];
          while (pending.length) {
            const node = pending.pop()!;
            if (node.children) pending.push(...node.children);
            if (
              node.ref === observed.focusedRef &&
              node.native?.platform === "dom" &&
              isRecord(node.native.data) &&
              node.native.data.kind === "native-select"
            )
              return observed;
          }
        } catch {
          // The click already completed. An optional focus read must never
          // turn it into a failed mutation or invite a duplicate click.
        }
        return null;
      }
      try {
        // Navigation already waits for the new document to load, and an
        // explicit wait has its own condition; only page input settles here.
        const last = actions.at(-1)?.type;
        if (last !== "navigate" && last !== "history" && last !== "wait")
          await this.settleActionRequests(state, requestsBeforeActions);
        await this.settleFiniteAnimations(state);
        const currentInfo = await this.requireTargetInfo(
          await this.ensureConnection(),
          info.targetId,
        );
        return await this.observeUnlocked(state, currentInfo);
      } catch (error) {
        // Input has already been dispatched. A closing popup or failed
        // follow-up read cannot prove that the mutation itself failed.
        const retiredSession =
          (error instanceof CdpProtocolError &&
            error.code === -32_001 &&
            this.states.get(state.targetId) !== state) ||
          (error instanceof InteractionControllerError &&
            error.cause instanceof CdpSessionDetachedError);
        // A native invalid-session reply after this exact attachment retired
        // is target loss, not loss of the browser transport or healthy peers.
        if (!(error instanceof InteractionDefiniteDriverError) && !retiredSession) throw error;
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "Browser input was sent, but the resulting page could not be observed. Check the current tabs before continuing; do not repeat the action automatically.",
        );
      }
    }).catch((error: unknown) => {
      if (error instanceof InteractionControllerError && error.code === "tab_not_responding") {
        throw effects && effects.state.actionEffectCount !== effects.before
          ? new InteractionOutcomeUnknownDriverError(
              "tab_not_responding",
              `${TAB_NOT_RESPONDING_MESSAGE} Input was already sent: check its effects after recovery and do not repeat the action automatically.`,
            )
          : new InteractionDefiniteDriverError("tab_not_responding", TAB_NOT_RESPONDING_MESSAGE);
      }
      if (error instanceof CdpSessionDetachedError) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "The tab disconnected while browser input was being sent. Check the current tabs before continuing; do not repeat the action automatically.",
        );
      }
      throw error;
    });
    this.refreshSubscribedFrame(command.targetId);
    return redactInteractionSecretValues(observation, secretValues);
  }

  readClipboard(): BrowserClipboardValue {
    return BrowserClipboard.parse({
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      revision: this.clipboardRevision,
      text: this.clipboardText,
      source: this.clipboardSource,
      sourceTargetId: this.clipboardSourceTargetId,
      updatedAt: this.clipboardUpdatedAt,
    });
  }

  /** Controller-private provider authentication. Provider credentials and
   * hosted-login URLs never enter an ordinary browser action. */
  async externalAuth(
    commandInput: BrowserExternalAuthCommandValue,
  ): Promise<BrowserExternalAuthResultValue> {
    const command = BrowserExternalAuthCommand.parse(commandInput);
    if (
      command.browserSessionId !== this.browserSessionId ||
      command.controllerGeneration !== this.controllerGeneration
    ) {
      throw new InteractionDefiniteDriverError(
        "controller_stale",
        "external authentication targets another browser controller",
      );
    }
    if (!this.runner.externalAuth) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser placement does not support provider-managed authentication",
      );
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          browserSessionId: command.browserSessionId,
          controllerGeneration: command.controllerGeneration,
          authRunId: command.authRunId,
          adapterId: command.adapterId,
          connectionId: command.connectionId,
          action: command.action,
        }),
      )
      .digest("hex");
    const replay = this.externalAuthResults.get(command.operationId);
    if (replay) {
      if (replay.digest !== digest) {
        throw new InteractionDefiniteDriverError(
          "operation_conflict",
          "external-auth operation id was reused with another request",
        );
      }
      return replay.result;
    }
    const dispatched = await this.runner.externalAuth(command);
    const result = BrowserExternalAuthResult.parse(dispatched.result);
    if (dispatched.browserReconfigured) {
      await this.reconnectAfterProviderReconfiguration();
    }
    this.externalAuthResults.set(command.operationId, { digest, result });
    while (this.externalAuthResults.size > 512) {
      this.externalAuthResults.delete(this.externalAuthResults.keys().next().value as string);
    }
    return result;
  }

  private async ensureConnection(): Promise<BrowserCdpConnection> {
    if (this.connection) return this.connection;
    if (this.connectionPromise) return await this.connectionPromise;
    this.connectionPromise = (async () => {
      const result = await this.runner.run<{ cdpUrl?: unknown }>(["get", "cdp-url"]);
      if (typeof result.cdpUrl !== "string") {
        throw new Error("managed browser did not expose its private CDP endpoint");
      }
      const connection = await this.connect(result.cdpUrl);
      this.connectionEndpoint = result.cdpUrl;
      if (this.runner.reattachedOwnedProcess) {
        try {
          await assertOwnedCdpProcess(connection, this.runner.reattachedOwnedProcess);
        } catch (error) {
          connection.close();
          throw error;
        }
      }
      const version = await connection.send<{
        product?: unknown;
        userAgent?: unknown;
      }>("Browser.getVersion");
      this.browserProduct = typeof version.product === "string" ? version.product : "";
      this.userAgent = typeof version.userAgent === "string" ? version.userAgent : "";
      if (this.downloadDirectory) {
        await connection.send("Browser.setDownloadBehavior", {
          ...this.contextScope(),
          behavior: "allowAndName",
          downloadPath: this.downloadDirectory,
          eventsEnabled: true,
        });
      }
      if (this.emulation?.geolocation) {
        await connection.send("Browser.grantPermissions", {
          ...this.contextScope(),
          permissions: ["geolocation"],
        });
      }
      await connection.send("Target.setDiscoverTargets", { discover: true });
      this.browserUnsubscribe.push(
        connection.on("Target.targetDestroyed", (event) => {
          if (typeof event.params.targetId === "string") this.removeState(event.params.targetId);
        }),
        connection.on("Target.detachedFromTarget", (event) => {
          const sessionId = event.params.sessionId;
          if (typeof sessionId !== "string") return;
          const targetId =
            typeof event.params.targetId === "string"
              ? event.params.targetId
              : ([...this.states.values()].find((state) => state.sessionId === sessionId)
                  ?.targetId ??
                [...this.attachingSessions].find(([, attached]) => attached === sessionId)?.[0]);
          if (
            !targetId ||
            (this.states.get(targetId)?.sessionId !== sessionId &&
              this.attachingSessions.get(targetId) !== sessionId)
          )
            return;
          // A new attachment must invalidate old controls even when the tab,
          // loader and frame ids are unchanged. Other tabs keep their authority.
          this.targetPhysicalGenerations.set(targetId, randomUUID());
          this.attachingSessions.delete(targetId);
          this.removeState(targetId, true);
        }),
        connection.on("Browser.downloadWillBegin", (event) => {
          const frameId = typeof event.params.frameId === "string" ? event.params.frameId : null;
          const state = [...this.states.values()].find(
            (candidate) => candidate.frame.id === frameId,
          );
          // Browser download events are process-wide. Unknown frames must not
          // become downloads belonging to another context.
          if (this.browserContextId && !state) return;
          if (this.downloadEvents) {
            const guid = typeof event.params.guid === "string" ? event.params.guid : "";
            if (this.browserContextId) this.ownedDownloads.add(guid);
            const suggestedFilename =
              typeof event.params.suggestedFilename === "string"
                ? event.params.suggestedFilename
                : "download";
            void this.downloadEvents
              .begin({
                guid,
                targetId: state?.targetId ?? null,
                suggestedFilename,
              })
              .catch(() => undefined);
          }
          if (state) {
            state.diagnostics.downloadCount += 1;
            this.appendDiagnostic(state, {
              kind: "download",
              level: "info",
              message: "Browser download started",
              url: boundedUrlField(event.params.url),
              method: null,
              status: null,
              filename: boundedTextField(event.params.suggestedFilename, 4_096),
            });
          }
        }),
        connection.on("Browser.downloadProgress", (event) => {
          if (!this.downloadEvents) return;
          const guid = typeof event.params.guid === "string" ? event.params.guid : "";
          if (this.browserContextId && !this.ownedDownloads.has(guid)) return;
          const state = event.params.state;
          if (state !== "inProgress" && state !== "completed" && state !== "canceled") return;
          const receivedBytes = event.params.receivedBytes;
          const totalBytes = event.params.totalBytes;
          if (typeof receivedBytes !== "number" || !Number.isSafeInteger(receivedBytes)) return;
          if (
            totalBytes !== undefined &&
            (typeof totalBytes !== "number" || !Number.isSafeInteger(totalBytes))
          ) {
            return;
          }
          void this.downloadEvents
            .progress({
              guid,
              state,
              receivedBytes,
              totalBytes: typeof totalBytes === "number" ? totalBytes : null,
            })
            .then(async ({ cancelReason }) => {
              if (state !== "inProgress") this.ownedDownloads.delete(guid);
              if (!cancelReason) return;
              await connection
                .send("Browser.cancelDownload", { guid, ...this.contextScope() })
                .catch(() => undefined);
              await this.downloadEvents?.reject(guid, cancelReason);
            })
            .catch(() => undefined);
        }),
      );
      if (this.targetAutoAttach) await this.enableTargetAutoAttach(connection);
      this.connection = connection;
      return connection;
    })();
    try {
      return await this.connectionPromise;
    } catch (error) {
      this.connectionPromise = null;
      throw error;
    }
  }

  /**
   * Attach every page target in this controller's context as Chromium creates
   * it, including window.open popups, while it is paused before its first
   * script. Each gets its passkey authenticator, then resumes. These sessions
   * only host per-target setup; actions keep their own lazily attached session.
   */
  private async enableTargetAutoAttach(connection: BrowserCdpConnection): Promise<void> {
    const unsubscribe = [
      connection.on("Target.attachedToTarget", (event) => {
        // Child sessions (cross-origin iframes) belong to their page session.
        if (event.sessionId !== null) return;
        void this.onTargetAutoAttached(connection, event.params);
      }),
      connection.on("Target.detachedFromTarget", (event) => {
        const sessionId = event.params.sessionId;
        if (event.sessionId !== null || typeof sessionId !== "string") return;
        for (const [targetId, autoSession] of this.autoSessions) {
          if (autoSession === sessionId) this.autoSessions.delete(targetId);
        }
        this.passkeys?.detachSession(sessionId);
      }),
      connection.on("Target.targetDestroyed", (event) => {
        if (event.params.targetId === this.frontTargetId) this.frontTargetId = null;
      }),
    ];
    this.browserUnsubscribe.push(...unsubscribe);
    try {
      await connection.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "page" }],
      });
    } catch (error) {
      if (error instanceof CdpTransportError) throw error;
      // Engines without browser-level auto-attach keep lazy per-target attachment.
      for (const stop of unsubscribe) stop();
    }
  }

  private async onTargetAutoAttached(
    connection: BrowserCdpConnection,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return;
    let info: TargetInfo;
    try {
      info = normalizeTargetInfo(params.targetInfo);
    } catch {
      return;
    }
    const waiting = params.waitingForDebugger === true;
    const resume = async () => {
      if (!waiting) return;
      await connection
        .send("Runtime.runIfWaitingForDebugger", {}, { sessionId, timeoutMs: 5_000 })
        .catch(() => undefined);
    };
    // The page filter means every non-page attachment is our own explicit
    // Target.attachToTarget (for example the hidden metadata target, which
    // Chromium reports as "other"). That session belongs to its caller.
    if (info.type !== "page") return;
    if (this.browserContextId !== undefined && info.browserContextId !== this.browserContextId) {
      // Another controller's context: never hold it.
      await resume();
      await connection
        .send("Target.detachFromTarget", { sessionId }, { timeoutMs: 5_000 })
        .catch(() => undefined);
      return;
    }
    // Our own explicit Target.attachToTarget also reports an attachment. The
    // auto-attached session always arrives first; keep exactly one per target
    // (Chromium allows one internal virtual authenticator per target).
    if (this.autoSessions.has(info.targetId)) {
      await resume();
      return;
    }
    this.autoSessions.set(info.targetId, sessionId);
    // A new tab or popup may have taken the front.
    if (waiting) this.frontTargetId = null;
    try {
      await this.passkeys?.attachTarget(connection, { targetId: info.targetId, sessionId });
    } finally {
      await resume();
    }
  }

  private forgetAutoAttachments(): void {
    this.autoSessions.clear();
    this.frontTargetId = null;
    if (this.connection) this.passkeys?.detachConnection(this.connection);
  }

  private async reconnectAfterProviderReconfiguration(): Promise<void> {
    for (const unsubscribe of this.browserUnsubscribe.splice(0)) unsubscribe();
    for (const targetId of [...this.states.keys()]) this.removeState(targetId);
    this.firstSeenAt.clear();
    this.attaching.clear();
    this.attachingSessions.clear();
    this.targetPhysicalGenerations.clear();
    this.forgetAutoAttachments();
    this.selectedTargetId = null;
    this.userAgentMetadataPromise = null;
    this.userAgent = "";
    this.browserProduct = "";
    this.physicalGeneration = randomUUID();
    const previous = this.connection;
    this.connection = null;
    this.connectionPromise = null;
    previous?.close();

    const connection = await this.ensureConnection();
    let targets = visiblePageTargets(await this.targetInfos(connection));
    if (targets.length === 0) {
      const created = await connection.send<{ targetId?: unknown }>("Target.createTarget", {
        ...this.contextScope(),
        url: "about:blank",
        background: true,
      });
      if (typeof created.targetId !== "string") {
        throw new Error("reconfigured browser did not return a target id");
      }
      targets = visiblePageTargets(await this.targetInfos(connection));
    }
    const selected = targets[0];
    if (!selected) throw new Error("reconfigured browser has no page target");
    this.selectedTargetId = selected.targetId;
  }

  private async withTarget<T>(
    targetId: string,
    operation: (state: TargetState, info: TargetInfo) => Promise<T>,
  ): Promise<T> {
    const connection = await this.ensureConnection();
    const info = await this.requireTargetInfo(connection, targetId);
    const state = await this.ensureTargetState(info);
    const result = state.tail.then(async () => {
      this.assertCurrentTargetState(state);
      state.nodeRoute = null;
      try {
        return await operation(state, info);
      } finally {
        state.nodeRoute = null;
      }
    });
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } catch (error) {
      // A renderer that died mid-command ends that command through the detach
      // below; report the crash itself rather than the transport symptom.
      if (this.crashedTargets.has(targetId)) throw tabCrashedError();
      if (error instanceof CdpCommandTimeoutError && error.sessionId)
        throw tabNotRespondingError(error);
      throw error;
    }
  }

  private async ensureTargetState(info: TargetInfo): Promise<TargetState> {
    const existing = this.states.get(info.targetId);
    if (existing) return existing;
    const inFlight = this.attaching.get(info.targetId);
    if (inFlight) return await inFlight;
    const promise = this.attachTarget(info);
    this.attaching.set(info.targetId, promise);
    try {
      return await promise;
    } finally {
      this.attaching.delete(info.targetId);
    }
  }

  private async attachTarget(info: TargetInfo): Promise<TargetState> {
    const connection = await this.ensureConnection();
    const authorityGeneration = this.targetPhysicalGeneration(info.targetId);
    const attached = await connection.send<{ sessionId?: unknown }>("Target.attachToTarget", {
      targetId: info.targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== "string") throw new Error("CDP did not attach the target");
    const sessionId = attached.sessionId;
    this.attachingSessions.set(info.targetId, sessionId);
    // A tab whose renderer already died answers no page command; Chrome says so
    // on Inspector.enable. Watch for it so attachment fails fast instead of
    // hanging every later command until its timeout.
    let signalCrash: () => void = () => undefined;
    const crashed = new Promise<null>((resolve) => {
      signalCrash = () => resolve(null);
    });
    const stopCrashWatch = connection.on("Inspector.targetCrashed", () => signalCrash(), sessionId);
    // Only the crash signal matters here; a slow or unsupported enable must not
    // replace the real initialization outcome.
    void connection.send("Inspector.enable", {}, { sessionId }).catch(() => undefined);
    let frame: MainFrame;
    try {
      const initialized = (async () => {
        await Promise.all([
          connection.send("Page.enable", {}, { sessionId }),
          connection.send("Runtime.enable", {}, { sessionId }),
          connection.send("DOM.enable", {}, { sessionId }),
          connection.send("Accessibility.enable", {}, { sessionId }),
          connection.send("Network.enable", {}, { sessionId }),
          connection.send("Log.enable", {}, { sessionId }),
        ]);
        await this.applyEmulation(connection, sessionId);
        return await this.mainFrame(sessionId);
      })();
      const outcome = await Promise.race([initialized, crashed]);
      if (!outcome) {
        // Detaching below ends the enables still waiting on the dead renderer.
        void initialized.catch(() => undefined);
        this.crashedTargets.add(info.targetId);
        throw tabCrashedError();
      }
      frame = outcome;
      if (
        this.attachingSessions.get(info.targetId) !== sessionId ||
        this.targetPhysicalGeneration(info.targetId) !== authorityGeneration
      ) {
        throw new InteractionControllerError(
          "resource_unavailable",
          "Browser tab detached during attachment",
          true,
        );
      }
    } catch (error) {
      // Failed initialization never enters states, so normal target cleanup cannot
      // find it. Release only this CDP attachment; preserve the page and profile.
      await connection
        .send("Target.detachFromTarget", { sessionId }, { timeoutMs: 500 })
        .catch(() => undefined);
      if (error instanceof CdpCommandTimeoutError && error.sessionId)
        throw tabNotRespondingError(error);
      throw error;
    } finally {
      stopCrashWatch();
      if (this.attachingSessions.get(info.targetId) === sessionId)
        this.attachingSessions.delete(info.targetId);
    }
    this.crashedTargets.delete(info.targetId);
    const state: TargetState = {
      targetId: info.targetId,
      sessionId,
      authorityGeneration,
      actionEffectCount: 0,
      createdAt: this.firstSeen(info.targetId),
      frame,
      documentGeneration: documentGeneration(
        this.controllerGeneration,
        authorityGeneration,
        info.targetId,
        frame.loaderId,
      ),
      frameGeneration: frameGeneration(
        this.controllerGeneration,
        authorityGeneration,
        info.targetId,
        frame.id,
      ),
      accessibility: null,
      dialog: null,
      diagnostics: {
        consoleErrorCount: 0,
        failedRequestCount: 0,
        downloadCount: 0,
        pageErrorCount: 0,
      },
      diagnosticEntries: [],
      diagnosticSequence: 0,
      inflightRequests: new Set(),
      networkTrackingOverflow: false,
      failedRequests: new Set(),
      requests: new Map(),
      lastNetworkActivityAt: Date.now(),
      networkActivitySequence: 0,
      screencasts: new Map(),
      tail: Promise.resolve(),
      unsubscribe: [],
      oopifs: new Map(),
      nodeRoute: null,
    };
    state.unsubscribe.push(
      connection.on("Inspector.targetCrashed", () => this.onTargetCrashed(state), sessionId),
      connection.on(
        "Page.frameNavigated",
        (event) => this.onFrameNavigated(state, event),
        sessionId,
      ),
      connection.on(
        "Runtime.consoleAPICalled",
        (event) => {
          const level = consoleLevel(event.params.type);
          if (level === "error") state.diagnostics.consoleErrorCount += 1;
          this.appendDiagnostic(state, {
            kind: "console",
            level,
            message: consoleMessage(event.params.args),
            url: null,
            method: null,
            status: null,
            filename: null,
          });
        },
        sessionId,
      ),
      connection.on(
        "Runtime.exceptionThrown",
        (event) => {
          state.diagnostics.pageErrorCount += 1;
          const details = isRecord(event.params.exceptionDetails)
            ? event.params.exceptionDetails
            : {};
          this.appendDiagnostic(state, {
            kind: "page_error",
            level: "error",
            message: exceptionMessage(details),
            url: boundedUrlField(details.url),
            method: null,
            status: null,
            filename: null,
          });
        },
        sessionId,
      ),
      connection.on(
        "Network.requestWillBeSent",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          if (requestId) {
            if (state.inflightRequests.size >= 10_000 && !state.inflightRequests.has(requestId)) {
              state.networkTrackingOverflow = true;
            } else {
              state.inflightRequests.add(requestId);
            }
            const request = isRecord(event.params.request) ? event.params.request : {};
            state.requests.set(requestId, {
              method: boundedMethod(request.method),
              url: boundedUrlField(request.url) ?? "about:blank",
            });
            boundMap(state.requests, 10_000);
          }
          state.networkActivitySequence += 1;
          state.lastNetworkActivityAt = Date.now();
        },
        sessionId,
      ),
      connection.on(
        "Network.loadingFinished",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          if (requestId) {
            state.inflightRequests.delete(requestId);
            state.failedRequests.delete(requestId);
            state.requests.delete(requestId);
          }
          state.networkActivitySequence += 1;
          state.lastNetworkActivityAt = Date.now();
        },
        sessionId,
      ),
      connection.on(
        "Network.loadingFailed",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          if (requestId) {
            state.inflightRequests.delete(requestId);
            if (event.params.canceled !== true && event.params.errorText !== "net::ERR_ABORTED") {
              this.recordFailedRequest(state, requestId, {
                message:
                  boundedTextField(event.params.errorText, 8_192) ?? "Network request failed",
              });
            }
            state.failedRequests.delete(requestId);
            state.requests.delete(requestId);
          }
          state.networkActivitySequence += 1;
          state.lastNetworkActivityAt = Date.now();
        },
        sessionId,
      ),
      connection.on(
        "Network.responseReceived",
        (event) => {
          const requestId = stringField(event.params, "requestId");
          const response = isRecord(event.params.response) ? event.params.response : null;
          if (requestId && typeof response?.status === "number" && response.status >= 400) {
            this.recordFailedRequest(state, requestId, {
              message: `HTTP ${Math.trunc(response.status)}`,
              status: Math.trunc(response.status),
              url: boundedUrlField(response.url),
            });
          }
        },
        sessionId,
      ),
      connection.on(
        "Page.javascriptDialogOpening",
        (event) => {
          state.dialog = browserDialog(event.params, this.timestamp());
        },
        sessionId,
      ),
      connection.on(
        "Page.javascriptDialogClosed",
        () => {
          state.dialog = null;
        },
        sessionId,
      ),
    );
    this.states.set(info.targetId, state);
    if (this.engine === "chromium") {
      try {
        await this.attachFrameSessions(connection, state, sessionId);
      } catch (error) {
        // Without OOPIF sessions cross-origin frames stay opaque, as before.
        if (error instanceof CdpTransportError) throw error;
      }
    }
    return state;
  }

  /** Page-level auto-attach: one flattened child session per cross-origin
   * (out-of-process) iframe, nested ones included. */
  private async attachFrameSessions(
    connection: BrowserCdpConnection,
    state: TargetState,
    parentSessionId: string,
  ): Promise<void> {
    state.unsubscribe.push(
      connection.on(
        "Target.attachedToTarget",
        (event) => void this.onFrameAttached(connection, state, parentSessionId, event.params),
        parentSessionId,
      ),
      connection.on(
        "Target.detachedFromTarget",
        (event) => {
          if (typeof event.params.sessionId === "string")
            this.forgetFrameSession(state, event.params.sessionId);
        },
        parentSessionId,
      ),
    );
    await connection.send(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe" }],
      },
      { sessionId: parentSessionId },
    );
  }

  private async onFrameAttached(
    connection: BrowserCdpConnection,
    state: TargetState,
    parentSessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string") return;
    let info: TargetInfo;
    try {
      info = normalizeTargetInfo(params.targetInfo);
    } catch {
      return;
    }
    const waiting = params.waitingForDebugger === true;
    try {
      if (info.type !== "iframe" || this.states.get(state.targetId) !== state) {
        if (waiting) await connection.send("Runtime.runIfWaitingForDebugger", {}, { sessionId });
        await connection.send(
          "Target.detachFromTarget",
          { sessionId },
          { sessionId: parentSessionId },
        );
        return;
      }
      // A cross-origin iframe's target id is its frame id.
      state.oopifs.set(info.targetId, {
        frameId: info.targetId,
        sessionId,
        parentSessionId,
        frameIds: new Set([info.targetId]),
      });
      state.accessibility = null;
      await Promise.all([
        connection.send("DOM.enable", {}, { sessionId }),
        connection.send("Page.enable", {}, { sessionId }),
        connection.send("Accessibility.enable", {}, { sessionId }),
      ]);
      await this.attachFrameSessions(connection, state, sessionId);
    } catch {
      // A frame that navigated away or closed during setup is simply absent.
    } finally {
      if (waiting)
        await connection
          .send("Runtime.runIfWaitingForDebugger", {}, { sessionId })
          .catch(() => undefined);
    }
  }

  private forgetFrameSession(state: TargetState, sessionId: string): void {
    for (const oopif of [...state.oopifs.values()]) {
      if (oopif.sessionId !== sessionId) continue;
      state.oopifs.delete(oopif.frameId);
      if (state.nodeRoute === oopif) state.nodeRoute = null;
      state.accessibility = null;
      // Nested frames went with their parent session.
      for (const nested of [...state.oopifs.values()]) {
        if (nested.parentSessionId === sessionId) this.forgetFrameSession(state, nested.sessionId);
      }
    }
  }

  private oopifForFrame(state: TargetState, frameId: string | null): OopifSession | null {
    if (!frameId) return null;
    for (const oopif of state.oopifs.values()) {
      if (oopif.frameIds.has(frameId)) return oopif;
    }
    return null;
  }

  /**
   * Accessibility nodes of every cross-origin iframe, each document root
   * placed under its `<iframe>` owner and described with the frame's origin.
   * A frame that detaches or navigates mid-read is omitted from this snapshot.
   */
  private async oopifAccessibility(
    state: TargetState,
    pageFrames: readonly MainFrame[],
    pageNodes: readonly CdpAxNode[],
  ): Promise<CdpAxNode[]> {
    const connection = await this.ensureConnection();
    const known = [...pageNodes];
    const merged: CdpAxNode[] = [];
    const framesBySession = new Map<string, Set<string>>([
      [state.sessionId, new Set(pageFrames.map((frame) => frame.id))],
    ]);
    // Outer frames first, so a nested frame's owner is already merged.
    const pending = [...state.oopifs.values()];
    for (let round = 0; pending.length > 0 && round < 8; round += 1) {
      for (const oopif of pending.splice(0)) {
        const parentFrames = framesBySession.get(oopif.parentSessionId);
        if (!parentFrames) {
          pending.push(oopif);
          continue;
        }
        try {
          const frames = flattenFrameTree(await this.frameTree(oopif.sessionId));
          oopif.frameIds = new Set(frames.map((frame) => frame.id));
          framesBySession.set(oopif.sessionId, oopif.frameIds);
          const owner = await connection.send<{ backendNodeId?: unknown }>(
            "DOM.getFrameOwner",
            { frameId: oopif.frameId },
            { sessionId: oopif.parentSessionId },
          );
          const ownerNode = known.find(
            (node) =>
              typeof node.frameId === "string" &&
              parentFrames.has(node.frameId) &&
              node.backendDOMNodeId === owner.backendNodeId,
          );
          if (!ownerNode || typeof ownerNode.nodeId !== "string") continue;
          const nodes = await this.collectAccessibilityFrames(oopif.sessionId, frames);
          const ids = new Set(nodes.map((node) => node.nodeId));
          const origin = frameOrigin(frames[0]?.url);
          for (const node of nodes) {
            if (node.frameId !== oopif.frameId || typeof node.nodeId !== "string") continue;
            if (typeof node.parentId === "string" && ids.has(node.parentId)) continue;
            node.parentId = ownerNode.nodeId;
            ownerNode.childIds = [
              ...(Array.isArray(ownerNode.childIds) ? ownerNode.childIds : []),
              node.nodeId,
            ];
            if (origin) node.description = { value: `Cross-origin frame ${origin}` };
          }
          known.push(...nodes);
          merged.push(...nodes);
        } catch (error) {
          if (error instanceof CdpTransportError) throw error;
        }
      }
    }
    return merged;
  }

  /** Top-left of a cross-origin frame's viewport in page coordinates. */
  private async frameOffset(
    state: TargetState,
    oopif: OopifSession,
  ): Promise<{ x: number; y: number }> {
    const connection = await this.ensureConnection();
    let x = 0;
    let y = 0;
    for (const current of this.frameChain(state, oopif)) {
      const owner = await connection.send<{ backendNodeId?: unknown }>(
        "DOM.getFrameOwner",
        { frameId: current.frameId },
        { sessionId: current.parentSessionId },
      );
      const box = await connection.send<{ model?: unknown }>(
        "DOM.getBoxModel",
        { backendNodeId: owner.backendNodeId },
        { sessionId: current.parentSessionId },
      );
      const content =
        isRecord(box.model) && Array.isArray(box.model.content)
          ? box.model.content.filter(
              (value): value is number => typeof value === "number" && Number.isFinite(value),
            )
          : [];
      if (content.length < 8) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser frame has no visible action point",
          true,
        );
      }
      x += Math.min(content[0]!, content[2]!, content[4]!, content[6]!);
      y += Math.min(content[1]!, content[3]!, content[5]!, content[7]!);
    }
    return { x, y };
  }

  /** The cross-origin frames from the page down to this one, outermost first. */
  private frameChain(state: TargetState, oopif: OopifSession): OopifSession[] {
    const chain: OopifSession[] = [];
    let current: OopifSession | undefined = oopif;
    while (current && chain.length < 8) {
      chain.unshift(current);
      const parentSessionId: string = current.parentSessionId;
      current = [...state.oopifs.values()].find(
        (candidate) => candidate.sessionId === parentSessionId,
      );
    }
    return chain;
  }

  /** Scroll each `<iframe>` holding the routed node into its parent's view. */
  private async scrollFrameOwnersIntoView(state: TargetState, oopif: OopifSession): Promise<void> {
    const connection = await this.ensureConnection();
    for (const frame of this.frameChain(state, oopif)) {
      const owner = await connection.send<{ backendNodeId?: unknown }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        { sessionId: frame.parentSessionId },
      );
      await connection.send(
        "DOM.scrollIntoViewIfNeeded",
        { backendNodeId: owner.backendNodeId },
        { sessionId: frame.parentSessionId },
      );
    }
  }

  /** Focus each `<iframe>` element on the way to a node in a cross-origin frame,
   * so page-level key input reaches that frame. */
  private async focusFrameOwners(state: TargetState, oopif: OopifSession): Promise<void> {
    const connection = await this.ensureConnection();
    for (const frame of this.frameChain(state, oopif)) {
      const owner = await connection.send<{ backendNodeId?: unknown }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        { sessionId: frame.parentSessionId },
      );
      await connection.send(
        "DOM.focus",
        { backendNodeId: owner.backendNodeId },
        { sessionId: frame.parentSessionId },
      );
    }
  }

  private async applyEmulation(connection: BrowserCdpConnection, sessionId: string): Promise<void> {
    if (this.focusEmulation) {
      // Hidden pages otherwise pause animation callbacks when no viewer is
      // capturing them. This target-local DevTools override keeps them active
      // without activating a tab or taking the desktop's foreground seat.
      // Chrome also holds each mouse event sent to a hidden page for about
      // five seconds before acknowledging it.
      // Chromium clears the override when this attachment disconnects.
      try {
        await connection.send(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          { sessionId },
        );
      } catch (error) {
        // A connected Chrome extension released before it admitted this
        // method rejects it; the page still works, only slower.
        if (!(error instanceof CdpProtocolError)) throw error;
        this.focusEmulation = false;
      }
    }
    if (!this.emulation) return;
    if (this.emulation.locale) {
      if (!this.userAgent) {
        throw new Error("browser did not expose a user agent for locale emulation");
      }
      const userAgentMetadata = await this.normalUserAgentMetadata(connection, sessionId);
      await this.applyInheritedStringOverride({
        connection,
        sessionId,
        method: "Emulation.setLocaleOverride",
        params: { locale: this.emulation.locale },
        expression: "Intl.DateTimeFormat().resolvedOptions().locale",
        expected: this.emulation.locale,
        normalize: normalizeLocale,
      });
      await connection.send(
        "Emulation.setUserAgentOverride",
        {
          userAgent: this.userAgent,
          acceptLanguage: this.emulation.locale,
          userAgentMetadata,
        },
        { sessionId },
      );
    }
    if (this.emulation.timezone) {
      await this.applyInheritedStringOverride({
        connection,
        sessionId,
        method: "Emulation.setTimezoneOverride",
        params: { timezoneId: this.emulation.timezone },
        expression: "Intl.DateTimeFormat().resolvedOptions().timeZone",
        expected: this.emulation.timezone,
        normalize: (value) => value,
      });
    }
    if (this.emulation.geolocation) {
      await connection.send(
        "Emulation.setGeolocationOverride",
        {
          latitude: this.emulation.geolocation.latitude,
          longitude: this.emulation.geolocation.longitude,
          accuracy: this.emulation.geolocation.accuracyMeters,
        },
        { sessionId },
      );
    }
  }

  private async applyInheritedStringOverride(options: {
    connection: BrowserCdpConnection;
    sessionId: string;
    method: "Emulation.setLocaleOverride" | "Emulation.setTimezoneOverride";
    params: Readonly<Record<string, unknown>>;
    expression: string;
    expected: string;
    normalize: (value: string) => string;
  }): Promise<void> {
    try {
      await options.connection.send(options.method, options.params, {
        sessionId: options.sessionId,
      });
      return;
    } catch (error) {
      if (!(error instanceof CdpProtocolError) || error.method !== options.method) throw error;
      const current = await options.connection.send<{
        result?: unknown;
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        { expression: options.expression, returnByValue: true },
        { sessionId: options.sessionId },
      );
      const value = isRecord(current.result) ? current.result.value : null;
      if (
        current.exceptionDetails ||
        typeof value !== "string" ||
        options.normalize(value) !== options.normalize(options.expected)
      ) {
        throw error;
      }
    }
  }

  private async normalUserAgentMetadata(
    connection: BrowserCdpConnection,
    sessionId: string,
  ): Promise<BrowserUserAgentMetadata> {
    if (!this.userAgentMetadataPromise) {
      this.userAgentMetadataPromise = this.loadNormalUserAgentMetadata(connection, sessionId);
    }
    try {
      return await this.userAgentMetadataPromise;
    } catch (error) {
      this.userAgentMetadataPromise = null;
      throw error;
    }
  }

  private async loadNormalUserAgentMetadata(
    connection: BrowserCdpConnection,
    sessionId: string,
  ): Promise<BrowserUserAgentMetadata> {
    const evaluated = await connection.send<{
      result?: unknown;
      exceptionDetails?: unknown;
    }>(
      "Runtime.evaluate",
      {
        expression: USER_AGENT_METADATA_EXPRESSION,
        awaitPromise: true,
        returnByValue: true,
      },
      { sessionId },
    );
    if (
      !evaluated.exceptionDetails &&
      isRecord(evaluated.result) &&
      evaluated.result.value !== null &&
      evaluated.result.value !== undefined
    ) {
      return parseUserAgentMetadata(evaluated.result.value);
    }
    return await this.loadUserAgentMetadataFromHiddenTarget(connection);
  }

  private async loadUserAgentMetadataFromHiddenTarget(
    connection: BrowserCdpConnection,
  ): Promise<BrowserUserAgentMetadata> {
    const created = await connection.send<{ targetId?: unknown }>("Target.createTarget", {
      ...this.contextScope(),
      url: "about:blank",
      hidden: true,
    });
    if (typeof created.targetId !== "string") {
      throw new Error("browser could not create a hidden metadata target");
    }
    let metadata: BrowserUserAgentMetadata | null = null;
    let metadataError: unknown = null;
    try {
      const attached = await connection.send<{ sessionId?: unknown }>("Target.attachToTarget", {
        targetId: created.targetId,
        flatten: true,
      });
      if (typeof attached.sessionId !== "string") {
        throw new Error("browser could not attach its hidden metadata target");
      }
      await Promise.all([
        connection.send("Page.enable", {}, { sessionId: attached.sessionId }),
        connection.send("Runtime.enable", {}, { sessionId: attached.sessionId }),
      ]);
      if (this.userAgentMetadataSource === "intercepted_local") {
        await navigateToInterceptedMetadataDocument(connection, attached.sessionId);
      } else {
        await navigateBrowserMetadataDocument(connection, attached.sessionId, "chrome://version/");
      }
      const evaluated = await connection.send<{
        result?: unknown;
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        {
          expression: USER_AGENT_METADATA_EXPRESSION,
          awaitPromise: true,
          returnByValue: true,
        },
        { sessionId: attached.sessionId },
      );
      if (evaluated.exceptionDetails || !isRecord(evaluated.result)) {
        throw new Error("browser could not preserve User-Agent metadata for locale emulation");
      }
      metadata = parseUserAgentMetadata(evaluated.result.value);
    } catch (error) {
      metadataError = error;
    }
    let closeError: unknown = null;
    try {
      const closed = await connection.send<{ success?: unknown }>("Target.closeTarget", {
        targetId: created.targetId,
      });
      if (closed.success !== true) {
        throw new Error("browser could not close its hidden metadata target");
      }
    } catch (error) {
      closeError = error;
    }
    if (metadataError && closeError) {
      throw new AggregateError(
        [metadataError, closeError],
        "browser metadata discovery and cleanup both failed",
      );
    }
    if (metadataError) throw metadataError;
    if (closeError) throw closeError;
    if (!metadata) throw new Error("browser returned no User-Agent metadata");
    return metadata;
  }

  private async observeUnlocked(
    state: TargetState,
    info: TargetInfo,
  ): Promise<BrowserObservationValue> {
    if (!state.dialog) await this.refreshFrame(state);
    const viewport = state.dialog ? null : await this.viewport(state);
    const accessibility =
      state.dialog && state.accessibility
        ? state.accessibility
        : state.dialog
          ? emptyAccessibilitySnapshot()
          : await this.refreshAccessibility(state);
    const focused = accessibility.focusedRef
      ? accessibility.entriesByRef.get(accessibility.focusedRef)
      : null;
    if (!state.dialog && focused?.actions.includes("select") && focused.frameId) {
      // Native popup windows are absent from page screenshots. Expose only the
      // focused control, through the same isolated-world redaction and budget
      // as focused DOM reads; never alter the page to draw a fake popup.
      let read: unknown = null;
      try {
        state.nodeRoute = this.oopifForFrame(state, focused.frameId);
        read = await this.callOnNode(
          state,
          focused.backendDOMNodeId,
          DOM_READ_FUNCTION,
          [{ value: 16_384 }, { value: [] }, { value: true }],
          { isolatedFrameId: focused.frameId },
        );
      } catch (error) {
        // This optional projection may lose its node after the AX snapshot.
        // Omit choices in that case; transport/context failures still propagate.
        const disappeared =
          (error instanceof CdpProtocolError &&
            error.method === "DOM.resolveNode" &&
            error.code === -32000 &&
            error.message === "No node with given id found") ||
          (error instanceof InteractionDefiniteDriverError && error.code === "locator_not_found");
        if (!disappeared) throw error;
      } finally {
        state.nodeRoute = null;
      }
      if (
        isRecord(read) &&
        read.redacted === null &&
        read.truncated === false &&
        isRecord(read.select)
      ) {
        const visit = (nodes: typeof accessibility.roots): void => {
          for (const node of nodes) {
            if (node.ref === focused.ref)
              node.native = {
                platform: "dom",
                data: read.select as NonNullable<InteractionSemanticNodeValue["native"]>["data"],
              };
            if (node.children) visit(node.children);
          }
        };
        visit(accessibility.roots);
      }
    }
    this.assertCurrentTargetState(state);
    return BrowserObservation.parse({
      protocolVersion: INTERACTION_PROTOCOL_VERSION,
      observationId: `observation-${this.createId()}`,
      browserSessionId: this.browserSessionId,
      target: this.targetFromInfo(info, state),
      frameId: state.frameGeneration,
      semantic: {
        kind: "snapshot",
        roots: accessibility.roots,
        nodeCount: accessibility.nodeCount,
      },
      screenshot: null,
      viewport,
      focusedRef: accessibility.focusedRef,
      changedRegions: [],
      diagnostics: state.diagnostics,
      dialog: state.dialog,
      observedAt: this.timestamp(),
    });
  }

  private async mayHaveFocusedNativeSelect(state: TargetState): Promise<boolean> {
    const world = await this.sendTarget<{ executionContextId?: number }>(
      state,
      "Page.createIsolatedWorld",
      { frameId: state.frame.id, worldName: "opengeni-dom-read" },
      { timeoutMs: 500 },
    );
    if (!Number.isSafeInteger(world.executionContextId)) return false;
    const result = await this.sendTarget<{ result?: { value?: unknown } }>(
      state,
      "Runtime.evaluate",
      {
        contextId: world.executionContextId,
        expression: `(() => {
          let element = document.activeElement;
          for (let depth = 0; depth < 32 && element?.shadowRoot?.activeElement; depth++)
            element = element.shadowRoot.activeElement;
          return ["SELECT", "IFRAME", "FRAME"].includes(element?.tagName);
        })()`,
        returnByValue: true,
      },
      { timeoutMs: 500 },
    );
    return result.result?.value === true;
  }

  private async refreshAccessibility(state: TargetState): Promise<CdpAccessibilitySnapshot> {
    for (let attempt = 0; attempt < ACCESSIBILITY_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const before = flattenFrameTree(await this.frameTree(state.sessionId));
      const nodes = await this.collectAccessibilityFrames(state.sessionId, before);
      if (state.oopifs.size > 0)
        nodes.push(...(await this.oopifAccessibility(state, before, nodes)));
      const after = flattenFrameTree(await this.frameTree(state.sessionId));
      if (frameTreeFingerprint(before) !== frameTreeFingerprint(after)) {
        continue;
      }
      const accessibility = normalizeCdpAccessibilityTree({
        nodes,
        controllerGeneration: this.controllerGeneration,
        targetId: state.targetId,
        documentGeneration: state.documentGeneration,
      });
      this.assertCurrentTargetState(state);
      state.accessibility = accessibility;
      return accessibility;
    }
    throw new Error("browser frame tree did not settle for a bounded accessibility observation");
  }

  private async collectAccessibilityFrames(
    sessionId: string,
    frames: readonly MainFrame[],
  ): Promise<CdpAxNode[]> {
    const nodes: CdpAxNode[] = [];
    for (let offset = 0; offset < frames.length; offset += ACCESSIBILITY_FRAME_CONCURRENCY) {
      const batch = frames.slice(offset, offset + ACCESSIBILITY_FRAME_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (frame) => ({
          frame,
          nodes: await this.accessibilityFrame(sessionId, frame),
        })),
      );
      const hasFailure = results.some((result) => result.status === "rejected");
      const current = hasFailure
        ? new Map(
            flattenFrameTree(await this.frameTree(sessionId)).map((frame) => [frame.id, frame]),
          )
        : null;
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          nodes.push(...result.value.nodes);
          continue;
        }
        const currentFrame = current?.get(batch[index]!.id);
        if (currentFrame) nodes.push(...(await this.accessibilityFrame(sessionId, currentFrame)));
      }
    }
    return nodes;
  }

  private async accessibilityFrame(sessionId: string, frame: MainFrame): Promise<CdpAxNode[]> {
    const connection = await this.ensureConnection();
    const response = await connection.send<{ nodes?: unknown }>(
      "Accessibility.getFullAXTree",
      { frameId: frame.id },
      { sessionId },
    );
    if (!Array.isArray(response.nodes)) {
      throw new Error("CDP returned an invalid accessibility tree");
    }
    return namespaceCdpAccessibilityFrame(
      frame.id,
      response.nodes as CdpAxNode[],
      `${frame.id}\0${frame.loaderId}`,
    );
  }

  private async refreshFrame(state: TargetState, timeoutMs?: number): Promise<void> {
    const frame = await this.mainFrame(state.sessionId, timeoutMs);
    this.assertCurrentTargetState(state);
    if (frame.loaderId !== state.frame.loaderId || frame.id !== state.frame.id) {
      state.frame = frame;
      state.documentGeneration = documentGeneration(
        this.controllerGeneration,
        state.authorityGeneration,
        state.targetId,
        frame.loaderId,
      );
      state.frameGeneration = frameGeneration(
        this.controllerGeneration,
        state.authorityGeneration,
        state.targetId,
        frame.id,
      );
      state.accessibility = null;
    } else {
      state.frame = frame;
    }
  }

  private async mainFrame(sessionId: string, timeoutMs?: number): Promise<MainFrame> {
    return (await this.frameTree(sessionId, timeoutMs)).frame;
  }

  private async frameTree(sessionId: string, timeoutMs?: number): Promise<PageFrameTree> {
    const connection = await this.ensureConnection();
    let response: { frameTree?: unknown };
    try {
      response = await connection.send<{ frameTree?: unknown }>(
        "Page.getFrameTree",
        {},
        { sessionId, ...(timeoutMs ? { timeoutMs } : {}) },
      );
    } catch (error) {
      // Target validation runs before dispatch. Preserve its bounded diagnosis
      // in the receipt without exposing arbitrary provider error text or
      // weakening document/frame fences on an unresponsive renderer.
      if (
        !(error instanceof CdpTransportError) &&
        !(error instanceof CdpSessionDetachedError) &&
        !(error instanceof CdpProtocolError && error.code === -32_000)
      )
        throw error;
      if (error instanceof CdpCommandTimeoutError) throw tabNotRespondingError(error);
      const failure = new InteractionControllerError(
        "resource_unavailable",
        "browser frame inspection unavailable during Page.getFrameTree",
        true,
      );
      failure.cause = error;
      throw failure;
    }
    if (!isRecord(response.frameTree) || !isRecord(response.frameTree.frame)) {
      throw new Error("CDP returned an invalid frame tree");
    }
    return parseFrameTree(response.frameTree);
  }

  private async screenshotRead<T>(
    stage: string,
    deadline: number,
    read: (timeoutMs: number) => Promise<T>,
  ): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new InteractionControllerError(
        "timeout",
        `browser screenshot timed out during ${stage}`,
        true,
      );
    }
    try {
      return await read(remaining);
    } catch (error) {
      const transport = error instanceof InteractionControllerError ? error.cause : error;
      if (!(transport instanceof CdpTransportError)) throw error;
      const timeout = transport instanceof CdpCommandTimeoutError;
      const failure = new InteractionControllerError(
        timeout ? "timeout" : "resource_unavailable",
        `browser screenshot ${timeout ? "timed out" : "unavailable"} during ${stage}`,
        true,
      );
      failure.cause = error;
      throw failure;
    }
  }

  private async layoutMetrics(
    state: TargetState,
    timeoutMs?: number,
  ): Promise<{
    viewport: { x: number; y: number; width: number; height: number };
    content: { width: number; height: number };
  }> {
    const response = await this.sendTarget<{
      cssVisualViewport?: unknown;
      cssContentSize?: unknown;
    }>(state, "Page.getLayoutMetrics", {}, timeoutMs ? { timeoutMs } : undefined);
    const viewport = dimensionsRecord(response.cssVisualViewport, true);
    const content = dimensionsRecord(response.cssContentSize, false);
    return { viewport, content };
  }

  private async viewport(state: TargetState): Promise<BrowserObservationValue["viewport"]> {
    if (this.engine === "lightpanda") return null;
    const result = await this.sendTarget<{
      result?: unknown;
      exceptionDetails?: unknown;
    }>(state, "Runtime.evaluate", {
      expression:
        "({width:innerWidth,height:innerHeight,visualWidth:visualViewport?.width??innerWidth,visualHeight:visualViewport?.height??innerHeight,deviceScaleFactor:devicePixelRatio,maxTouchPoints:navigator.maxTouchPoints??0})",
      returnByValue: true,
    });
    const value = isRecord(result.result) ? result.result.value : null;
    if (result.exceptionDetails || !isRecord(value)) {
      return null;
    }
    // A newly mapped headed window may report zero dimensions before layout.
    // Keep the semantic observation usable without inventing viewport geometry.
    const viewport = BrowserObservation.shape.viewport.safeParse(value);
    return viewport.success ? (viewport.data ?? null) : null;
  }

  private imageFrame(options: {
    state: TargetState;
    sequence: number;
    format: "jpeg" | "png";
    data: Uint8Array;
    width: number;
    height: number;
    deviceScaleFactor: number;
    scrollX: number;
    scrollY: number;
  }): BrowserImageFrame {
    return {
      // This is the causal main-frame generation used by action fences, not a
      // capture id. `sequence` identifies individual images within the stream.
      frameId: options.state.frameGeneration,
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      targetId: options.state.targetId,
      targetGeneration: this.targetGeneration(options.state.targetId),
      documentGeneration: options.state.documentGeneration,
      sequence: options.sequence,
      mediaType: options.format === "jpeg" ? "image/jpeg" : "image/png",
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.deviceScaleFactor,
      scrollX: options.scrollX,
      scrollY: options.scrollY,
      data: options.data,
      capturedAt: this.timestamp(),
    };
  }

  private async captureFallbackFrame(targetId: string, expected: TargetScreencast): Promise<void> {
    if (expected.capturePromise) return await expected.capturePromise;
    const capture = (async () => {
      // Frame sampling is deliberately outside TargetState.tail. Media is
      // latest-only and must never queue ahead of clicks, typing, navigation,
      // observations, or tab control.
      const state = this.states.get(targetId);
      if (!state) throw new Error("browser target does not exist");
      if (state.screencasts.get(expected.key) !== expected) return;
      const metrics = await this.layoutMetrics(state, FRAME_CAPTURE_TIMEOUT_MS);
      const viewport = metrics.viewport;
      // Reuse the accepted clip scale for this viewport. Inferring a new device
      // scale from rounded image pixels feeds quantization back into every frame
      // and makes an unchanged mobile viewport oscillate in size.
      const previous = expected.captureScale;
      let scale =
        previous?.width === viewport.width && previous.height === viewport.height
          ? previous.scale
          : Math.min(
              1,
              expected.options.maxWidth / viewport.width,
              expected.options.maxHeight / viewport.height,
            );
      let data: Uint8Array<ArrayBufferLike> = new Uint8Array();
      let dimensions = { width: 0, height: 0 };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await this.sendTarget<{ data?: unknown }>(
          state,
          "Page.captureScreenshot",
          {
            format: expected.options.format,
            ...(expected.options.format === "jpeg" ? { quality: expected.options.quality } : {}),
            fromSurface: true,
            captureBeyondViewport: false,
            clip: {
              x: viewport.x,
              y: viewport.y,
              width: viewport.width,
              height: viewport.height,
              scale,
            },
          },
          { timeoutMs: FRAME_CAPTURE_TIMEOUT_MS },
        );
        data = decodeBoundedBase64Image(response.data);
        dimensions = imageDimensions(data, expected.options.format);
        if (
          dimensions.width <= expected.options.maxWidth &&
          dimensions.height <= expected.options.maxHeight
        ) {
          break;
        }
        scale *= Math.min(
          expected.options.maxWidth / dimensions.width,
          expected.options.maxHeight / dimensions.height,
        );
      }
      if (
        dimensions.width > expected.options.maxWidth ||
        dimensions.height > expected.options.maxHeight
      ) {
        throw new Error("browser screenshot could not honor the frame dimension bound");
      }
      if (state.screencasts.get(expected.key) !== expected) return;
      expected.captureScale = { width: viewport.width, height: viewport.height, scale };
      const frame = this.imageFrame({
        state,
        sequence: ++expected.sequence,
        format: expected.options.format,
        data,
        width: dimensions.width,
        height: dimensions.height,
        deviceScaleFactor: finiteScale(dimensions.width / viewport.width),
        scrollX: viewport.x,
        scrollY: viewport.y,
      });
      expected.lastFrameAt = Date.now();
      for (const subscription of expected.subscriptions.values()) subscription.push(frame);
    })();
    expected.capturePromise = capture;
    try {
      await capture;
    } finally {
      if (expected.capturePromise === capture) expected.capturePromise = null;
    }
  }

  private pollFallbackFrames(targetId: string, expected: TargetScreencast): void {
    void (async () => {
      let consecutiveFailures = 0;
      while (!expected.fallbackAbort.signal.aborted) {
        await delay(FRAME_FALLBACK_INTERVAL_MS * expected.options.everyNthFrame);
        if (expected.fallbackAbort.signal.aborted) return;
        const state = this.states.get(targetId);
        if (!state || state.screencasts.get(expected.key) !== expected) return;
        if (Date.now() - expected.lastFrameAt < FRAME_FALLBACK_INTERVAL_MS) continue;
        try {
          await this.captureFallbackFrame(targetId, expected);
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          if (consecutiveFailures < FRAME_CAPTURE_FAILURE_LIMIT) continue;
          const current = this.states.get(targetId);
          if (current?.screencasts.get(expected.key) === expected) {
            this.failScreencast(current, expected, transportError(error));
          }
          return;
        }
      }
    })();
  }

  private refreshSubscribedFrame(targetId: string): void {
    const state = this.states.get(targetId);
    if (!state) return;
    for (const screencast of state.screencasts.values()) {
      void this.captureFallbackFrame(targetId, screencast).catch(() => {
        // The regular fallback loop owns recovery. This eager capture exists only
        // to make an accepted input visible without waiting for its idle cadence.
      });
    }
  }

  private async releaseFrameSubscription(
    targetId: string,
    profileKey: string,
    subscriptionId: string,
  ): Promise<void> {
    const state = this.states.get(targetId);
    if (!state) return;
    const release = state.tail.then(async () => {
      const screencast = state.screencasts.get(profileKey);
      if (!screencast) return;
      screencast.subscriptions.delete(subscriptionId);
      if (screencast.subscriptions.size > 0) return;
      screencast.unsubscribe();
      screencast.fallbackAbort.abort();
      state.screencasts.delete(profileKey);
    });
    state.tail = release.then(
      () => undefined,
      () => undefined,
    );
    await release;
  }

  private failScreencast(state: TargetState, screencast: TargetScreencast, error: Error): void {
    if (state.screencasts.get(screencast.key) !== screencast) return;
    state.screencasts.delete(screencast.key);
    screencast.unsubscribe();
    screencast.fallbackAbort.abort();
    for (const subscription of screencast.subscriptions.values()) subscription.fail(error);
    screencast.subscriptions.clear();
  }

  private failAllScreencasts(state: TargetState, error: Error): void {
    for (const screencast of [...state.screencasts.values()]) {
      this.failScreencast(state, screencast, error);
    }
  }

  /**
   * WebAuthn refuses `navigator.credentials.create()` in a page without focus,
   * and focus emulation does not satisfy it. With passkeys enabled, the tab an
   * action targets comes to the front first (once, until another tab does).
   */
  private async bringToFrontForAction(state: TargetState): Promise<void> {
    if (!this.passkeys || state.dialog || this.frontTargetId === state.targetId) return;
    try {
      await this.sendTarget(state, "Page.bringToFront");
      this.frontTargetId = state.targetId;
    } catch (error) {
      if (!(error instanceof CdpProtocolError)) throw error;
    }
  }

  private async dispatchAction(
    state: TargetState,
    action: BrowserAction,
    operationId: string,
  ): Promise<void> {
    state.nodeRoute = null;
    switch (action.type) {
      case "navigate":
        await this.navigate(state, action.url);
        return;
      case "history":
        await this.navigateHistory(state, action.direction);
        return;
      case "activate":
        await (
          await this.ensureConnection()
        ).send("Target.activateTarget", {
          targetId: state.targetId,
        });
        this.frontTargetId = state.targetId;
        return;
      case "viewport":
        for (const stream of state.screencasts.values()) stream.captureScale = null;
        if (this.engine === "lightpanda") {
          throw new InteractionDefiniteDriverError(
            "unsupported",
            "this browser engine does not support viewport emulation",
          );
        }
        await this.sendActionTarget(state, "Emulation.setDeviceMetricsOverride", {
          width: action.width,
          height: action.height,
          deviceScaleFactor: action.deviceScaleFactor ?? 1,
          mobile: action.mobile,
          screenWidth: action.width,
          screenHeight: action.height,
        });
        await this.sendActionTarget(state, "Emulation.setTouchEmulationEnabled", {
          enabled: action.mobile,
          ...(action.mobile ? { maxTouchPoints: 1 } : {}),
        });
        return;
      case "click": {
        const node = await this.resolveActionLocator(state, action.locator);
        await this.clickNode(
          state,
          node.backendDOMNodeId,
          action.button ?? "left",
          1,
          node.frameId ?? state.frame.id,
        );
        return;
      }
      case "double_click": {
        const node = await this.resolveActionLocator(state, action.locator);
        await this.clickNode(
          state,
          node.backendDOMNodeId,
          "left",
          2,
          node.frameId ?? state.frame.id,
        );
        return;
      }
      case "hover": {
        const node = await this.resolveActionLocator(state, action.locator);
        const point = await this.actionPoint(
          state,
          node.backendDOMNodeId,
          true,
          node.frameId ?? state.frame.id,
        );
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
        });
        return;
      }
      case "fill": {
        const node = await this.resolveActionLocator(state, action.locator);
        if (await this.fillNativeDateTimeInput(state, node.backendDOMNodeId, action.value)) return;
        await this.focusNode(state, node.backendDOMNodeId);
        await this.selectAllAndDelete(state, node.backendDOMNodeId);
        if (action.value || this.engine === "lightpanda")
          await this.sendActionTarget(state, "Input.insertText", {
            text: action.value,
          });
        const confirmed = await this.callOnNode(
          state,
          node.backendDOMNodeId,
          CONFIRM_EDITABLE_VALUE_FUNCTION,
          [{ value: action.value }],
        );
        if (confirmed !== true) {
          throw new InteractionOutcomeUnknownDriverError(
            "outcome_unknown",
            "browser fill was dispatched but the target did not retain the requested value; re-observe before continuing",
          );
        }
        return;
      }
      case "type":
        if (action.locator) {
          const node = await this.resolveActionLocator(state, action.locator);
          await this.focusNode(state, node.backendDOMNodeId);
        }
        if (
          action.text &&
          this.engine === "lightpanda" &&
          (await this.evaluate(state, LIGHTPANDA_TYPING_TARGET_EXPRESSION)) !== true
        ) {
          // Lightpanda 0.3.5 acknowledges insertText on contenteditable without
          // inserting anything. Refuse before dispatch rather than certify it.
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "Lightpanda typing requires an editable text input or textarea; use Chromium for rich-text editors",
          );
        }
        if (action.text && action.mode === "keys") {
          // One key press per character for split one-time-code boxes and
          // pages that listen for keydown and move focus themselves.
          for (const character of action.text) {
            await this.pressKey(state, characterKey(character));
          }
          return;
        }
        if (action.text)
          await this.sendActionTarget(state, "Input.insertText", {
            text: action.text,
          });
        return;
      case "press": {
        // Validate the key before focusing: focus is an input effect, so a
        // key rejected after it would surface as outcome_unknown instead of
        // a definite, side-effect-free invalid_action.
        const key = this.parseActionKey(action.key);
        if (action.locator) {
          const node = await this.resolveActionLocator(state, action.locator);
          await this.focusNode(state, node.backendDOMNodeId);
        }
        await this.pressKey(state, key);
        return;
      }
      case "select": {
        const node = await this.resolveActionLocator(state, action.locator);
        const result = await this.callOnNode(
          state,
          node.backendDOMNodeId,
          SELECT_OPTIONS_FUNCTION,
          [{ value: action.values }],
        );
        if (result !== true) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser locator is not a selectable control",
          );
        }
        // This function returns false before any change for an invalid control.
        // A true reply confirms a selection effect before later fencing checks.
        state.actionEffectCount += 1;
        return;
      }
      case "check": {
        const node = await this.resolveActionLocator(state, action.locator);
        const current = await this.callOnNode(state, node.backendDOMNodeId, CHECKED_FUNCTION, []);
        if (typeof current !== "boolean") {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser locator is not a checkable control",
          );
        }
        if (current !== action.checked)
          await this.clickNode(state, node.backendDOMNodeId, "left", 1);
        return;
      }
      case "scroll": {
        // A located scroll moves the nearest box that can scroll that way, as a
        // wheel over the element would; a page scroll moves the viewport. When
        // nothing moves, no scroll event fired, so the refusal is definite.
        const effectsBeforeScroll = state.actionEffectCount;
        let moved: unknown;
        if (action.locator) {
          const node = await this.resolveActionLocator(state, action.locator);
          moved = await this.callOnNode(
            state,
            node.backendDOMNodeId,
            SCROLL_FUNCTION,
            [{ value: action.deltaX }, { value: action.deltaY }],
            { isolatedFrameId: node.frameId ?? state.frame.id, potentialEffect: true },
          );
        } else {
          moved = await this.evaluateAction(
            state,
            `(${PAGE_SCROLL_FUNCTION})(${json(action.deltaX)}, ${json(action.deltaY)})`,
          );
        }
        if (moved !== true && (action.deltaX !== 0 || action.deltaY !== 0)) {
          state.actionEffectCount = effectsBeforeScroll;
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            action.locator
              ? "nothing at this element can scroll further in that direction"
              : "the page cannot scroll further in that direction; to scroll an inner panel, pass its locator",
          );
        }
        return;
      }
      case "drag": {
        const from = await this.resolveActionLocator(state, action.from);
        const fromRoute = state.nodeRoute;
        const to = await this.resolveActionLocator(state, action.to);
        if (fromRoute !== state.nodeRoute) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser drag between different cross-origin frames is unsupported; use pointer drag coordinates",
          );
        }
        await this.dragNodes(state, from.backendDOMNodeId, to.backendDOMNodeId);
        return;
      }
      case "pointer":
        await this.dispatchPointerAction(state, action);
        return;
      case "handle_dialog":
        if (!state.dialog) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser target has no open JavaScript dialog",
          );
        }
        if (action.promptText !== undefined && state.dialog.type !== "prompt") {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "prompt text is valid only for a browser prompt dialog",
          );
        }
        await this.sendActionTarget(state, "Page.handleJavaScriptDialog", {
          accept: action.response === "accept",
          ...(action.promptText !== undefined ? { promptText: action.promptText } : {}),
        });
        state.dialog = null;
        return;
      case "upload": {
        if (!this.resolveWorkspaceFiles) {
          throw new InteractionDefiniteDriverError(
            "unsupported",
            "this browser placement cannot resolve workspace files for upload",
          );
        }
        const paths = await this.resolveWorkspaceFiles(operationId, action.workspaceFileIds);
        if (paths.length !== action.workspaceFileIds.length) {
          throw new InteractionDefiniteDriverError(
            "resource_not_found",
            "one or more workspace files are unavailable on the browser placement",
          );
        }
        await this.uploadFiles(state, action.locator, paths);
        return;
      }
      case "clipboard":
        await this.dispatchClipboardAction(state, action);
        return;
      case "permission":
        await this.dispatchPermissionAction(state, action);
        return;
      case "wait":
        await this.waitForCondition(state, action);
        return;
    }
  }

  private async uploadFiles(
    state: TargetState,
    locator: BrowserLocator,
    paths: readonly string[],
  ): Promise<void> {
    const node = await this.resolveActionLocator(state, locator);
    const frameId = node.frameId ?? state.frame.id;
    if (this.engine === "lightpanda") {
      // Lightpanda supports direct file inputs, not Chromium's native chooser.
      await this.setUploadFiles(state, node.backendDOMNodeId, frameId, paths);
      return;
    }
    const isFileInput = await this.callOnNode(
      state,
      node.backendDOMNodeId,
      "function () { return this instanceof HTMLInputElement && this.type === 'file'; }",
      [],
      { isolatedFrameId: frameId },
    );
    if (isFileInput === true) {
      await this.setUploadFiles(state, node.backendDOMNodeId, frameId, paths);
      return;
    }

    const sourceFrame = flattenFrameTree(await this.frameTree(state.sessionId)).find(
      (frame) => frame.id === frameId,
    );
    if (!sourceFrame) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "upload control frame is unavailable",
      );
    }
    const connection = await this.ensureConnection();
    // Intercept only for this upload. The normal browser/native picker remains
    // untouched outside the target's serialized action.
    try {
      await connection.send(
        "Page.setInterceptFileChooserDialog",
        { enabled: true },
        {
          sessionId: state.sessionId,
        },
      );
    } catch (error) {
      if (error instanceof CdpProtocolError) {
        throw new InteractionDefiniteDriverError(
          "unsupported",
          "this browser cannot intercept file choosers; target a file input directly",
        );
      }
      throw error;
    }
    const abort = new AbortController();
    const chooser = connection
      .waitForEvent("Page.fileChooserOpened", {
        sessionId: state.sessionId,
        timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
        signal: abort.signal,
        predicate: (params) => params.frameId === frameId,
      })
      .then(
        (event) => event,
        () => null,
      );
    let clicked = false;
    try {
      await this.clickNode(state, node.backendDOMNodeId, "left", 1);
      clicked = true;
      const event = await chooser;
      if (!event) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "upload control was clicked but no file chooser was confirmed; inspect the page before continuing",
        );
      }
      const currentFrame = flattenFrameTree(await this.frameTree(state.sessionId)).find(
        (frame) => frame.id === frameId,
      );
      if (currentFrame?.loaderId !== sourceFrame.loaderId) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "upload control changed documents; no files were selected",
        );
      }
      const backendNodeId = event.params.backendNodeId;
      if (typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId)) {
        throw new InteractionDefiniteDriverError(
          "unsupported",
          "this file chooser is not backed by a file input",
        );
      }
      await this.setUploadFiles(state, backendNodeId, frameId, paths);
    } catch (error) {
      if (error instanceof DialogOpenedSignal) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          "upload control opened a JavaScript dialog; no file selection was confirmed",
        );
      }
      if (clicked && error instanceof InteractionDefiniteDriverError) {
        throw new InteractionOutcomeUnknownDriverError(
          "outcome_unknown",
          `upload control was clicked, but file selection failed (${error.code}): ${error.message}`,
        );
      }
      throw error;
    } finally {
      abort.abort();
      await connection.send(
        "Page.setInterceptFileChooserDialog",
        { enabled: false },
        {
          sessionId: state.sessionId,
        },
      );
    }
  }

  private async setUploadFiles(
    state: TargetState,
    backendNodeId: number | null,
    frameId: string,
    paths: readonly string[],
  ): Promise<void> {
    if (this.engine === "chromium") {
      const input = await this.callOnNode(
        state,
        backendNodeId,
        `function () {
        return {
          file: this instanceof HTMLInputElement && this.type === 'file',
          disabled: this.matches(':disabled'), multiple: this.multiple,
          directory: this.webkitdirectory
        };
      }`,
        [],
        { isolatedFrameId: frameId },
      );
      if (!isRecord(input) || input.file !== true || input.disabled === true) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "upload requires an enabled file input",
        );
      }
      if (input.directory === true || (paths.length > 1 && input.multiple !== true)) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          input.directory === true
            ? "directory selection is not supported; choose a file upload control"
            : "this file input accepts only one file",
        );
      }
    }
    try {
      await this.sendActionTarget(state, "DOM.setFileInputFiles", {
        files: [...paths],
        backendNodeId,
      });
    } catch (error) {
      if (
        error instanceof CdpProtocolError &&
        error.message === "Node is not a file input element"
      ) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "upload target is no longer a file input",
        );
      }
      throw error;
    }
  }

  private async dispatchClipboardAction(
    state: TargetState,
    action: Extract<BrowserAction, { type: "clipboard" }>,
  ): Promise<void> {
    if (action.operation === "clear") {
      this.setClipboard("", "clear", state.targetId);
      return;
    }
    if (action.operation === "write") {
      if (action.text === undefined) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser clipboard write requires text",
        );
      }
      this.setClipboard(action.text, "write", state.targetId);
      return;
    }
    if (action.operation === "copy") {
      const text = await this.copyBrowserText(state, action.locator, action.content ?? "selection");
      this.setClipboard(text, "copy", state.targetId);
      return;
    }
    const text = action.text ?? this.clipboardText;
    if (action.text !== undefined) this.setClipboard(text, "paste", state.targetId);
    if (action.locator) {
      const node = await this.resolveActionLocator(state, action.locator);
      await this.focusNode(state, node.backendDOMNodeId);
    }
    if (text) {
      await this.sendActionTarget(state, "Input.insertText", { text });
    }
  }

  private async dispatchPermissionAction(
    state: TargetState,
    action: BrowserPermissionAction,
  ): Promise<void> {
    if (!this.permissionControl) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser placement cannot set web permissions programmatically",
      );
    }
    const origin = webOrigin(state.frame.url);
    try {
      await (
        await this.ensureConnection()
      ).send("Browser.setPermission", {
        ...this.contextScope(),
        permission: { name: CDP_PERMISSION_NAMES[action.permission] },
        setting: action.setting,
        origin,
      });
    } catch (error) {
      if (error instanceof CdpProtocolError) {
        throw new InteractionDefiniteDriverError(
          error.code === -32_601 ? "unsupported" : "invalid_action",
          error.code === -32_601
            ? "this browser engine does not support programmatic permission control"
            : "the browser rejected this permission setting",
        );
      }
      throw error;
    }
  }

  private async copyBrowserText(
    state: TargetState,
    locator: BrowserLocator | undefined,
    content: "selection" | "value" | "text",
  ): Promise<string> {
    let value: unknown;
    if (locator) {
      const node = await this.resolveActionLocator(state, locator);
      value = await this.callOnNode(state, node.backendDOMNodeId, COPY_BROWSER_TEXT_FUNCTION, [
        { value: content },
      ]);
    } else {
      value = await this.evaluateAction(
        state,
        `(${COPY_ACTIVE_BROWSER_TEXT_FUNCTION})(${json(content)})`,
      );
      if (!isRecord(value) || (value.ok !== true && value.error !== "protected")) {
        const accessibility = await this.refreshAccessibility(state);
        const focused = accessibility.focusedRef
          ? accessibility.entriesByRef.get(accessibility.focusedRef)
          : null;
        if (focused?.backendDOMNodeId) {
          state.nodeRoute = this.oopifForFrame(state, focused.frameId);
          value = await this.callOnNode(
            state,
            focused.backendDOMNodeId,
            COPY_BROWSER_TEXT_FUNCTION,
            [{ value: content }],
          );
        }
      }
    }
    if (!isRecord(value) || value.ok !== true || typeof value.text !== "string") {
      const reason =
        isRecord(value) && typeof value.error === "string" ? value.error : "unavailable";
      throw new InteractionDefiniteDriverError(
        reason === "protected" ? "permission_denied" : "invalid_action",
        reason === "protected"
          ? "browser clipboard cannot copy a protected field"
          : "browser clipboard source is unavailable",
      );
    }
    this.assertClipboardText(value.text);
    return value.text;
  }

  private setClipboard(
    text: string,
    source: Exclude<BrowserClipboardValue["source"], "empty">,
    targetId: string,
  ): void {
    this.assertClipboardText(text);
    if (this.clipboardRevision >= Number.MAX_SAFE_INTEGER) {
      throw new InteractionDefiniteDriverError(
        "resource_unavailable",
        "browser clipboard revision capacity is exhausted",
      );
    }
    this.clipboardRevision += 1;
    this.clipboardText = text;
    this.clipboardSource = source;
    this.clipboardSourceTargetId = targetId;
    this.clipboardUpdatedAt = this.timestamp();
  }

  private assertClipboardText(text: string): void {
    if (Buffer.byteLength(text, "utf8") > INTERACTION_MAX_CLIPBOARD_BYTES) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser clipboard text exceeds its UTF-8 byte envelope",
      );
    }
  }

  /** Resolve a locator an action is about to act on and, when the command is
   * traced, record which element it resolved to before any input is sent. */
  private async resolveActionLocator(
    state: TargetState,
    locator: BrowserLocator,
  ): Promise<CdpAccessibilityEntry> {
    const entry = await this.resolveLocator(state, locator);
    const current = state.actionTrace;
    if (current) {
      current.trace.record(await this.describeResolvedTarget(state, entry, current.actionIndex));
    }
    return entry;
  }

  private async describeResolvedTarget(
    state: TargetState,
    entry: CdpAccessibilityEntry,
    actionIndex: number,
  ): Promise<BrowserActionResolvedTargetValue> {
    if (entry.nodeId !== "") {
      // Accessibility-resolved locators already carry role, name and ancestry.
      const snapshot = state.accessibility;
      const container =
        snapshot && snapshot.entriesByNodeId.has(entry.nodeId)
          ? accessibilityContainer(snapshot, entry.nodeId)
          : null;
      return {
        actionIndex,
        ref: entry.ref || null,
        role: boundedTargetRole(entry.role),
        name: boundedTargetText(entry.name),
        container: container
          ? { role: boundedTargetRole(container.role), name: boundedTargetText(container.name) }
          : null,
      };
    }
    // CSS, test id and placeholder locators resolve through the DOM. Read that
    // node and its ancestors from Chromium's accessibility tree. The read is
    // optional: an engine or frame without it reports no role or container.
    const unknown: BrowserActionResolvedTargetValue = {
      actionIndex,
      ref: null,
      role: "generic",
      name: null,
      container: null,
    };
    if (entry.backendDOMNodeId === null) return unknown;
    let response: { nodes?: unknown };
    try {
      response = await this.sendTarget(state, "Accessibility.getPartialAXTree", {
        backendNodeId: entry.backendDOMNodeId,
        fetchRelatives: true,
      });
    } catch {
      return unknown;
    }
    if (!Array.isArray(response.nodes)) return unknown;
    let snapshot: CdpAccessibilitySnapshot;
    try {
      snapshot = normalizeCdpAccessibilityTree({
        nodes: response.nodes as CdpAxNode[],
        controllerGeneration: this.controllerGeneration,
        targetId: state.targetId,
        documentGeneration: state.documentGeneration,
      });
    } catch {
      return unknown;
    }
    const resolved = snapshot.entries.find(
      (candidate) => candidate.backendDOMNodeId === entry.backendDOMNodeId,
    );
    if (!resolved) return unknown;
    const container = accessibilityContainer(snapshot, resolved.nodeId);
    return {
      ...unknown,
      role: boundedTargetRole(resolved.role),
      name: boundedTargetText(resolved.name),
      container: container
        ? { role: boundedTargetRole(container.role), name: boundedTargetText(container.name) }
        : null,
    };
  }

  private async resolveLocator(
    state: TargetState,
    locator: BrowserLocator,
  ): Promise<CdpAccessibilityEntry> {
    // Each resolution decides where this node's DOM and runtime calls go:
    // the page session, or the session of the cross-origin frame holding it.
    state.nodeRoute = null;
    const entry = await this.resolveLocatorInPage(state, locator);
    state.nodeRoute = this.oopifForFrame(state, entry.frameId);
    return entry;
  }

  private async resolveLocatorInPage(
    state: TargetState,
    locator: BrowserLocator,
  ): Promise<CdpAccessibilityEntry> {
    await this.refreshFrame(state);
    if (locator.kind === "css" || locator.kind === "test_id" || locator.kind === "placeholder") {
      const selector =
        locator.kind === "css"
          ? locator.selector
          : locator.kind === "test_id"
            ? `[data-testid="${cssString(locator.value)}"]`
            : `[placeholder="${cssString(locator.text)}"]`;
      const backendDOMNodeId = await this.uniqueDomMatch(state, selector);
      return syntheticEntry(backendDOMNodeId);
    }
    // A reference already identifies one concrete node. Revalidate that node
    // against Chromium instead of reading every unrelated node before input.
    // Frame/engine cases without this exact proof retain full-tree resolution.
    if (locator.kind === "ref" && this.engine === "chromium") {
      const cached = state.accessibility?.entriesByRef.get(locator.ref);
      if (cached?.backendDOMNodeId != null && cached.frameId === state.frame.id) {
        const partial = await this.resolveMainFrameReference(state, cached);
        if (partial) return partial;
      }
    }
    const accessibility = await this.refreshAccessibility(state);
    if (locator.kind === "ref") {
      const entry = accessibility.entriesByRef.get(locator.ref);
      if (!entry || entry.backendDOMNodeId === null) {
        throw new InteractionDefiniteDriverError(
          "locator_not_found",
          "browser element reference is stale or unavailable",
        );
      }
      return entry;
    }
    let matches: CdpAccessibilityEntry[];
    if (locator.kind === "role") {
      matches = accessibility.entries.filter(
        (entry) =>
          entry.backendDOMNodeId !== null &&
          entry.role.toLowerCase() === locator.role.toLowerCase() &&
          (locator.name === undefined ||
            (locator.exact
              ? entry.name === locator.name
              : (entry.name ?? "").toLocaleLowerCase().includes(locator.name.toLocaleLowerCase()))),
      );
    } else if (locator.kind === "label") {
      matches = accessibility.entries.filter(
        (entry) =>
          entry.backendDOMNodeId !== null &&
          entry.name === locator.text &&
          isFormControlRole(entry.role),
      );
    } else {
      matches = accessibility.entries.filter(
        (entry) =>
          entry.backendDOMNodeId !== null &&
          entry.role === "text" &&
          (entry.name ?? "").toLocaleLowerCase().includes(locator.text.toLocaleLowerCase()),
      );
    }
    const unique = uniqueEntries(matches);
    if (!unique) {
      throw new InteractionDefiniteDriverError(
        matches.length === 0 ? "locator_not_found" : "locator_ambiguous",
        matches.length === 0
          ? "browser locator found no element"
          : "browser locator matched multiple elements",
      );
    }
    return unique;
  }

  private async resolveMainFrameReference(
    state: TargetState,
    previous: CdpAccessibilityEntry,
  ): Promise<CdpAccessibilityEntry | null> {
    const frame = state.frame;
    let response: { nodes?: unknown };
    try {
      response = await this.sendTarget(state, "Accessibility.getPartialAXTree", {
        backendNodeId: previous.backendDOMNodeId,
        fetchRelatives: false,
      });
    } catch (error) {
      // Older CDP implementations and disappeared nodes can reject this read.
      // Full-tree resolution remains authoritative; no input has been sent.
      if (error instanceof CdpProtocolError) return null;
      throw error;
    }
    if (!Array.isArray(response.nodes)) return null;
    await this.refreshFrame(state);
    if (frame.id !== state.frame.id || frame.loaderId !== state.frame.loaderId) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "browser document changed while resolving the element reference",
      );
    }
    const current = normalizeCdpAccessibilityTree({
      nodes: namespaceCdpAccessibilityFrame(
        frame.id,
        response.nodes as CdpAxNode[],
        `${frame.id}\0${frame.loaderId}`,
      ),
      controllerGeneration: this.controllerGeneration,
      targetId: state.targetId,
      documentGeneration: state.documentGeneration,
    }).entriesByRef.get(previous.ref);
    if (!current || current.backendDOMNodeId !== previous.backendDOMNodeId) {
      throw new InteractionDefiniteDriverError(
        "locator_not_found",
        "browser element reference is stale or unavailable",
      );
    }
    return current;
  }

  private async uniqueDomMatch(state: TargetState, selector: string): Promise<number> {
    const document = await this.sendTarget<{ root?: unknown }>(state, "DOM.getDocument", {
      depth: 0,
      pierce: true,
    });
    if (!isRecord(document.root) || typeof document.root.nodeId !== "number") {
      throw new Error("CDP returned an invalid DOM root");
    }
    let result: { nodeIds?: unknown };
    try {
      result = await this.sendTarget(state, "DOM.querySelectorAll", {
        nodeId: document.root.nodeId,
        selector,
      });
    } catch (error) {
      if (error instanceof CdpProtocolError) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser CSS selector is invalid",
        );
      }
      throw error;
    }
    const nodeIds = Array.isArray(result.nodeIds)
      ? result.nodeIds.filter((value): value is number => typeof value === "number")
      : [];
    if (nodeIds.length === 0) {
      throw new InteractionDefiniteDriverError(
        "locator_not_found",
        "browser locator found no element",
      );
    }
    if (nodeIds.length !== 1) {
      throw new InteractionDefiniteDriverError(
        "locator_ambiguous",
        "browser locator matched multiple elements",
      );
    }
    const described = await this.sendTarget<{ node?: unknown }>(state, "DOM.describeNode", {
      nodeId: nodeIds[0],
    });
    if (!isRecord(described.node) || typeof described.node.backendNodeId !== "number") {
      throw new Error("CDP did not resolve the DOM locator");
    }
    return described.node.backendNodeId;
  }

  private async clickNode(
    state: TargetState,
    backendDOMNodeId: number | null,
    button: "left" | "right" | "middle",
    count: 1 | 2,
    frameId?: string,
  ): Promise<void> {
    const point = await this.actionPoint(state, backendDOMNodeId, true, frameId);
    const { x, y, sessionId } = await this.clickInput(state, point);
    const input = sessionId === undefined ? {} : { sessionId };
    await this.sendActionTarget(
      state,
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x, y },
      input,
    );
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.sendActionTarget(
        state,
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x, y, button, clickCount },
        input,
      );
      await this.sendActionTarget(
        state,
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x, y, button, clickCount },
        input,
      );
    }
  }

  /**
   * Where a click on a node goes. A node in a cross-origin frame is clicked
   * through that frame's own session, in its local coordinates. Sent to the
   * page at page coordinates, Chrome routes the event into the frame by the
   * compositor's hit-test data, which can lag a freshly loaded frame: the
   * click then lands on nothing although Blink's hit test passed (seen headed
   * with a CAPTCHA widget, about one click in five).
   */
  private async clickInput(
    state: TargetState,
    point: { x: number; y: number },
  ): Promise<{ x: number; y: number; sessionId?: string }> {
    const route = state.nodeRoute;
    if (!route) return point;
    const offset = await this.frameOffset(state, route);
    return { x: point.x - offset.x, y: point.y - offset.y, sessionId: route.sessionId };
  }

  /** Scroll offsets of the window, visual viewport and every composed
   * ancestor of a top-level-frame node, read in an isolated world so page
   * scripts cannot fake them. Null means unknown: treat any scroll as an effect. */
  private async scrollPositions(
    state: TargetState,
    backendDOMNodeId: number,
    frameId: string | undefined,
  ): Promise<string | null> {
    if (frameId === undefined) return null;
    try {
      const positions = await this.callOnNode(
        state,
        backendDOMNodeId,
        SCROLL_POSITIONS_FUNCTION,
        [],
        { isolatedFrameId: frameId },
      );
      return typeof positions === "string" ? positions : null;
    } catch {
      return null;
    }
  }

  private async actionPoint(
    state: TargetState,
    backendDOMNodeId: number | null,
    requireHit: boolean,
    frameId?: string,
  ): Promise<{ x: number; y: number }> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser node cannot receive pointer input",
      );
    }
    // Scrolling runs page scroll listeners, so it counts as a possible effect
    // and a later refusal stays an unknown outcome. When the target is already
    // in view nothing scrolls, and a refusal (covered, no box) is definite.
    const scrollBefore = await this.scrollPositions(state, backendDOMNodeId, frameId);
    const effectsBeforeScroll = state.actionEffectCount;
    if (state.nodeRoute) await this.scrollFrameOwnersIntoView(state, state.nodeRoute);
    await this.sendActionTarget(state, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: backendDOMNodeId,
    });
    if (
      scrollBefore !== null &&
      (await this.scrollPositions(state, backendDOMNodeId, frameId)) === scrollBefore
    )
      state.actionEffectCount = effectsBeforeScroll;
    let point = await this.centerPoint(state, backendDOMNodeId);
    if (requireHit && !(await this.hitsAtCenter(state, backendDOMNodeId))) {
      const revealed =
        (await this.revealFromStickyCover(state, backendDOMNodeId, frameId)) ??
        (await this.revealByHover(state, backendDOMNodeId, frameId, point));
      if (!revealed) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser element is covered or not pointer-actionable",
          true,
        );
      }
      point = revealed;
    }
    return point;
  }

  private async centerPoint(
    state: TargetState,
    backendDOMNodeId: number,
  ): Promise<{ x: number; y: number }> {
    const result = await this.sendTarget<{ model?: unknown }>(state, "DOM.getBoxModel", {
      backendNodeId: backendDOMNodeId,
    });
    if (!isRecord(result.model) || !Array.isArray(result.model.content)) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser element has no visible action point",
        true,
      );
    }
    const numbers = result.model.content.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    if (numbers.length < 8) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser element has no visible action point",
        true,
      );
    }
    const xs = [numbers[0]!, numbers[2]!, numbers[4]!, numbers[6]!];
    const ys = [numbers[1]!, numbers[3]!, numbers[5]!, numbers[7]!];
    // A box inside a cross-origin frame is in that frame's viewport space.
    const offset = state.nodeRoute
      ? await this.frameOffset(state, state.nodeRoute)
      : { x: 0, y: 0 };
    return {
      x: offset.x + xs.reduce((sum, value) => sum + value, 0) / xs.length,
      y: offset.y + ys.reduce((sum, value) => sum + value, 0) / ys.length,
    };
  }

  private async hitsAtCenter(state: TargetState, backendDOMNodeId: number): Promise<boolean> {
    return (await this.callOnNode(state, backendDOMNodeId, HIT_TEST_FUNCTION, [])) === true;
  }

  /**
   * Row actions and toolbar buttons are often hidden and pointer-transparent
   * until the pointer is over their row or card (CSS :hover). The hit test
   * then lands on the target's own ancestor. A person moves the pointer onto
   * the spot first, so do the same and test again. The move is real input, so
   * a refusal after it is an unknown outcome. Returns the action point, or
   * null when the target is not hover-revealed or stays unreachable.
   */
  private async revealByHover(
    state: TargetState,
    backendDOMNodeId: number,
    frameId: string | undefined,
    point: { x: number; y: number },
  ): Promise<{ x: number; y: number } | null> {
    if (frameId === undefined) return null;
    const transparent = await this.callOnNode(
      state,
      backendDOMNodeId,
      POINTER_TRANSPARENT_FUNCTION,
      [],
      { isolatedFrameId: frameId },
    ).catch(() => false);
    if (transparent !== true) return null;
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    if (!(await this.hitsAtCenter(state, backendDOMNodeId))) return null;
    return await this.centerPoint(state, backendDOMNodeId);
  }

  /**
   * Sticky table columns and headers, and fixed toolbars, can cover a target
   * that Chromium already considers in view, so scrolling "if needed" does
   * nothing. A person scrolls the container until the target clears the bar;
   * try the same with other scroll alignments. A layer over the whole viewport
   * (a modal or its backdrop) is not scrolled past, so that refusal stays
   * definite. Returns the new action point, or null when still covered.
   */
  private async revealFromStickyCover(
    state: TargetState,
    backendDOMNodeId: number,
    frameId: string | undefined,
  ): Promise<{ x: number; y: number } | null> {
    if (frameId === undefined) return null;
    const sticky = await this.callOnNode(state, backendDOMNodeId, STICKY_COVER_FUNCTION, [], {
      isolatedFrameId: frameId,
    }).catch(() => false);
    if (sticky !== true) return null;
    const scrollBefore = await this.scrollPositions(state, backendDOMNodeId, frameId);
    const effectsBeforeScroll = state.actionEffectCount;
    for (const alignment of ["end", "center", "start"] as const) {
      // Scrolling runs page scroll listeners, so it is a possible effect: a
      // refusal after it is reported as an unknown outcome.
      await this.callOnNode(
        state,
        backendDOMNodeId,
        SCROLL_INTO_VIEW_FUNCTION,
        [{ value: alignment }],
        {
          potentialEffect: true,
        },
      );
      if (await this.hitsAtCenter(state, backendDOMNodeId)) {
        return await this.centerPoint(state, backendDOMNodeId);
      }
    }
    // Nothing could move (for example a sticky bar taller than its scroller):
    // no scroll listener ran, so the refusal is still definite.
    if (
      scrollBefore !== null &&
      (await this.scrollPositions(state, backendDOMNodeId, frameId)) === scrollBefore
    )
      state.actionEffectCount = effectsBeforeScroll;
    return null;
  }

  private async focusNode(state: TargetState, backendDOMNodeId: number | null): Promise<void> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError("invalid_action", "browser node cannot be focused");
    }
    if (this.engine === "lightpanda") {
      const focused = await this.callOnNode(
        state,
        backendDOMNodeId,
        "function () { this.focus(); return document.activeElement === this; }",
        [],
      );
      if (focused !== true) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser node cannot be focused",
        );
      }
      return;
    }
    const effectsBeforeFocus = state.actionEffectCount;
    try {
      if (state.nodeRoute) {
        state.actionEffectCount += 1;
        await this.focusFrameOwners(state, state.nodeRoute);
      }
      await this.sendActionTarget(state, "DOM.focus", {
        backendNodeId: backendDOMNodeId,
      });
    } catch (error) {
      // Chromium validates the node (an Element that can take focus) before
      // moving focus, so a protocol refusal changed nothing. Report it as a
      // definite refusal instead of letting it surface as an unknown outcome.
      if (error instanceof CdpProtocolError && error.method === "DOM.focus") {
        state.actionEffectCount = effectsBeforeFocus;
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser node cannot be focused",
        );
      }
      throw error;
    }
  }

  /**
   * Native date, time, month, week and datetime-local inputs render their
   * editable parts as spin buttons inside a user-agent shadow root, and they
   * ignore text insertion. Select-all plus Backspace would only clear the
   * focused part. Fill such a control, or any of its parts, by setting the
   * host input's value in the input's own format, the way a date picker
   * commits a choice. Returns false for every other element so the ordinary
   * text path still applies.
   */
  private async fillNativeDateTimeInput(
    state: TargetState,
    backendDOMNodeId: number | null,
    value: string,
  ): Promise<boolean> {
    const inspected = await this.callOnNode(
      state,
      backendDOMNodeId,
      INSPECT_NATIVE_DATE_TIME_FILL_FUNCTION,
      [{ value }],
    );
    if (!isRecord(inspected) || inspected.kind === "other") return false;
    const type = typeof inspected.type === "string" ? inspected.type : "date";
    if (inspected.kind === "not_editable") {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `browser ${type} input is disabled or read-only`,
      );
    }
    if (inspected.kind === "invalid_value") {
      const part = inspected.part === true ? "this field is one part of a native " : "a native ";
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `${part}${type} input; fill the whole input with a value in its format (${NATIVE_DATE_TIME_FORMATS[type] ?? "its value format"}), or an empty string to clear it`,
      );
    }
    const retained = await this.callOnNode(
      state,
      backendDOMNodeId,
      SET_NATIVE_DATE_TIME_VALUE_FUNCTION,
      [{ value }],
      { potentialEffect: true },
    );
    if (retained !== true) {
      throw new InteractionOutcomeUnknownDriverError(
        "outcome_unknown",
        `browser set the ${type} input's value but the page did not keep it; re-observe before continuing`,
      );
    }
    return true;
  }

  private async selectAllAndDelete(
    state: TargetState,
    backendDOMNodeId: number | null,
  ): Promise<void> {
    if (this.engine === "lightpanda") {
      // Pinned Lightpanda ignores rawKeyDown and has no select-all/backspace
      // editing defaults. Clear through the native setter, then let insertText
      // emit the native input event (also for an empty replacement). Bypassing
      // framework-owned setters preserves controlled-input change tracking.
      const cleared = await this.callOnNode(
        state,
        backendDOMNodeId,
        LIGHTPANDA_CLEAR_EDITABLE_FUNCTION,
        [],
      );
      if (cleared !== true) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "Lightpanda fill requires an editable text input or textarea",
        );
      }
      return;
    }
    const meta = /Macintosh|Mac OS/u.test(this.userAgent);
    const modifiers = meta ? 4 : 2;
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers,
      windowsVirtualKeyCode: 65,
      // macOS Chromium does not derive native editing commands from CDP's
      // synthetic Command+A event. Without this, Backspace deletes one character.
      ...(meta ? { commands: ["selectAll"] } : {}),
    });
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers,
      windowsVirtualKeyCode: 65,
    });
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
  }

  private parseActionKey(input: string): ParsedKey {
    return parseKey(input, /Macintosh|Mac OS/u.test(this.userAgent));
  }

  private async pressKey(state: TargetState, key: ParsedKey): Promise<void> {
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: key.key,
      code: key.code,
      modifiers: key.modifiers,
      windowsVirtualKeyCode: key.keyCode,
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
      ...(/Macintosh|Mac OS/u.test(this.userAgent) && key.modifiers === 4 && key.code === "KeyA"
        ? { commands: ["selectAll"] }
        : {}),
    });
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: key.key,
      code: key.code,
      modifiers: key.modifiers,
      windowsVirtualKeyCode: key.keyCode,
    });
  }

  private async dragNodes(
    state: TargetState,
    fromBackendNodeId: number | null,
    toBackendNodeId: number | null,
  ): Promise<void> {
    const from = await this.actionPoint(state, fromBackendNodeId, true);
    await this.dragPoints(
      state,
      from,
      () => this.actionPoint(state, toBackendNodeId, false),
      "left",
    );
  }

  private async dispatchPointerAction(
    state: TargetState,
    action: Extract<BrowserAction, { type: "pointer" }>,
  ): Promise<void> {
    const start = await this.viewportPoint(state, action.x, action.y);
    const button = action.button ?? "left";
    switch (action.action) {
      case "move":
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: start.x,
          y: start.y,
        });
        return;
      case "click":
      case "double_click": {
        if (action.action === "click" && action.clickCount === 2) {
          await this.clickPoint(state, start, button, 2, 2);
        } else {
          await this.clickPoint(state, start, button, action.action === "click" ? 1 : 2);
        }
        return;
      }
      case "scroll":
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: start.x,
          y: start.y,
          deltaX: action.deltaX ?? 0,
          deltaY: action.deltaY ?? 0,
        });
        return;
      case "drag": {
        if (action.endX === undefined || action.endY === undefined) {
          throw new InteractionDefiniteDriverError(
            "invalid_action",
            "browser pointer drag requires an end coordinate",
          );
        }
        const end = await this.viewportPoint(state, action.endX, action.endY);
        await this.dragPoints(state, start, end, button);
        return;
      }
    }
  }

  private async viewportPoint(
    state: TargetState,
    x: number,
    y: number,
  ): Promise<{ x: number; y: number }> {
    const viewport = await this.evaluate(
      state,
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    if (!isRecord(viewport)) throw new Error("browser returned invalid viewport dimensions");
    const width = numberField(viewport, "width");
    const height = numberField(viewport, "height");
    if (width === null || height === null || width <= 0 || height <= 0) {
      throw new Error("browser returned invalid viewport dimensions");
    }
    if (x < 0 || y < 0 || x > width || y > height) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser pointer coordinate is outside the current viewport",
        true,
      );
    }
    return { x, y };
  }

  private async clickPoint(
    state: TargetState,
    point: { x: number; y: number },
    button: "left" | "right" | "middle",
    count: 1 | 2,
    firstCount: 1 | 2 = 1,
  ): Promise<void> {
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    for (let clickCount = firstCount; clickCount <= count; clickCount += 1) {
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
    }
  }

  private async dragPoints(
    state: TargetState,
    from: { x: number; y: number },
    destination: { x: number; y: number } | (() => Promise<{ x: number; y: number }>),
    button: "left" | "right" | "middle",
  ): Promise<void> {
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x,
      y: from.y,
    });
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button,
      buttons: mouseButtonMask(button),
      clickCount: 1,
    });
    let point = from;
    try {
      if (typeof destination === "function") {
        // Start the drag before revealing the destination: scrolling it into
        // view can move the source away from its measured coordinates.
        point = { x: from.x + (from.x >= 8 ? -8 : 8), y: from.y };
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          button,
          buttons: mouseButtonMask(button),
        });
      }
      const to = typeof destination === "function" ? await destination() : destination;
      const start = point;
      for (let step = 1; step <= 10; step += 1) {
        point = {
          x: start.x + ((to.x - start.x) * step) / 10,
          y: start.y + ((to.y - start.y) * step) / 10,
        };
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          button,
          buttons: mouseButtonMask(button),
        });
      }
      // The final step may only enter a small target. A second move delivers
      // dragover, allowing the page to accept the drop before mouse release.
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
        button,
        buttons: mouseButtonMask(button),
      });
    } finally {
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button,
        buttons: 0,
        clickCount: 1,
      });
    }
  }

  private async navigate(
    state: TargetState,
    url: string,
    options: BrowserTabNavigationOptions = {},
  ): Promise<void> {
    this.connection?.assertNavigable?.(url);
    const result = await this.sendActionTarget<{ errorText?: unknown }>(state, "Page.navigate", {
      url,
    });
    if (
      typeof result.errorText === "string" &&
      result.errorText &&
      !(options.keepTabOnLoadError === true && isPageLoadError(result.errorText))
    ) {
      throw new InteractionDefiniteDriverError(
        "resource_unavailable",
        "browser could not navigate to the requested URL",
        true,
      );
    }
    await this.waitForDocumentReady(state, DEFAULT_ACTION_TIMEOUT_MS);
    await this.refreshFrame(state);
  }

  private async navigateHistory(state: TargetState, direction: "back" | "forward"): Promise<void> {
    if (this.engine === "lightpanda") {
      // Pinned Lightpanda mixes subframe loads into its session-wide history
      // and traverses every entry in the main frame. The CDP entries omit
      // frame identity, so filtering URLs cannot recover safe target history.
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "Lightpanda does not support safe Back/Forward history; navigate to an explicit URL",
      );
    }
    const history = await this.sendActionTarget<{
      currentIndex?: unknown;
      entries?: unknown;
    }>(state, "Page.getNavigationHistory", {});
    const nextIndex =
      typeof history.currentIndex === "number"
        ? history.currentIndex + (direction === "back" ? -1 : 1)
        : -1;
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const entry = entries[nextIndex];
    if (!isRecord(entry) || typeof entry.id !== "number") {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        `browser target has no ${direction} history entry`,
      );
    }
    await this.sendActionTarget(state, "Page.navigateToHistoryEntry", { entryId: entry.id });
    await this.waitForDocumentReady(state, DEFAULT_ACTION_TIMEOUT_MS);
    await this.refreshFrame(state);
  }

  private async waitForCondition(
    state: TargetState,
    action: Extract<BrowserAction, { type: "wait" }>,
  ): Promise<void> {
    const timeoutMs = action.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (action.condition === "load") {
        if (await this.documentReady(state)) return;
      } else if (action.condition === "network_idle") {
        if (state.networkTrackingOverflow) {
          throw new InteractionDefiniteDriverError(
            "resource_unavailable",
            "browser network tracking exceeded its bounded envelope",
            true,
          );
        }
        if (
          (await this.documentReady(state)) &&
          state.inflightRequests.size === 0 &&
          Date.now() - state.lastNetworkActivityAt >= NETWORK_IDLE_MS
        ) {
          return;
        }
      } else if (action.locator) {
        const visible = await this.locatorVisible(state, action.locator);
        if (action.condition === "visible" ? visible : !visible) return;
      } else {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          `${action.condition} wait requires a locator`,
        );
      }
      await delay(50);
    }
    throw new InteractionDefiniteDriverError("timeout", "browser wait condition timed out", true);
  }

  private async waitForDocumentReady(state: TargetState, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.documentReady(state)) return;
      await delay(25);
    }
    throw new InteractionDefiniteDriverError("timeout", "browser navigation timed out", true);
  }

  private async documentReady(state: TargetState): Promise<boolean> {
    const value = await this.evaluate(state, "document.readyState");
    return value === "interactive" || value === "complete";
  }

  private async locatorVisible(state: TargetState, locator: BrowserLocator): Promise<boolean> {
    let entry: CdpAccessibilityEntry;
    try {
      entry = await this.resolveLocator(state, locator);
    } catch (error) {
      if (error instanceof InteractionDefiniteDriverError && error.code === "locator_not_found") {
        return false;
      }
      throw error;
    }
    return (await this.callOnNode(state, entry.backendDOMNodeId, VISIBLE_FUNCTION, [])) === true;
  }

  /**
   * A click often starts a request whose response then updates the page, as
   * when a form posts and shows "Submitted". Observing immediately shows the
   * page before that update, so the agent waits for, or guesses at, a result
   * that is already on its way. Briefly wait for the requests the action
   * itself started (not ones already open, such as long polls) to finish,
   * then give the page a moment to apply the response. Actions that caused
   * no network activity pay nothing, and the wait is bounded.
   */
  private async settleActionRequests(
    state: TargetState,
    before: { open: ReadonlySet<string>; activity: number },
  ): Promise<void> {
    if (state.dialog) return;
    try {
      // The renderer reports a request it starts before it answers a later
      // command on the same session, so one cheap round trip makes sure the
      // requests this action started have been seen.
      await this.sendTarget(state, "Runtime.getIsolateId", {});
    } catch {
      // Settling only improves the snapshot; it never decides the outcome.
    }
    if (state.dialog || state.networkActivitySequence === before.activity) return;
    const deadline = Date.now() + ACTION_REQUEST_SETTLE_LIMIT_MS;
    const pending = () =>
      state.networkTrackingOverflow ||
      [...state.inflightRequests].some((requestId) => !before.open.has(requestId));
    while (pending() && Date.now() < deadline && !state.dialog) {
      await delay(ACTION_REQUEST_POLL_MS);
    }
    if (!state.dialog) await delay(ACTION_RESPONSE_APPLY_MS);
  }

  /**
   * Menus, listboxes and dialogs usually animate out before they leave the
   * DOM. A snapshot taken mid-animation reports UI the action already
   * dismissed, so briefly wait for finite running animations to finish.
   * Infinite ones (spinners) are ignored and the wait is bounded. This is a
   * read in an isolated world: page scripts cannot stall or observe it, and
   * any failure simply observes the page as it is.
   */
  private async settleFiniteAnimations(state: TargetState): Promise<void> {
    if (this.engine !== "chromium" || state.dialog) return;
    try {
      const world = await this.sendTarget<{ executionContextId?: unknown }>(
        state,
        "Page.createIsolatedWorld",
        { frameId: state.frame.id, worldName: "opengeni-dom-read" },
      );
      if (!Number.isSafeInteger(world.executionContextId)) return;
      await this.sendTarget(
        state,
        "Runtime.evaluate",
        {
          expression: SETTLE_FINITE_ANIMATIONS_EXPRESSION,
          contextId: world.executionContextId,
          returnByValue: true,
          awaitPromise: true,
        },
        { timeoutMs: ANIMATION_SETTLE_LIMIT_MS + 1_000 },
      );
    } catch {
      // Settling only improves the snapshot; it never decides the outcome.
    }
  }

  private async evaluate(state: TargetState, expression: string): Promise<unknown> {
    const result = await this.sendTarget<{
      result?: unknown;
      exceptionDetails?: unknown;
    }>(state, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error("browser evaluation failed");
    return isRecord(result.result) ? result.result.value : undefined;
  }

  private async evaluateAction(state: TargetState, expression: string): Promise<unknown> {
    const result = await this.sendActionTarget<{
      result?: unknown;
      exceptionDetails?: unknown;
    }>(state, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error("browser evaluation failed");
    return isRecord(result.result) ? result.result.value : undefined;
  }

  private async callOnNode(
    state: TargetState,
    backendDOMNodeId: number | null,
    functionDeclaration: string,
    args: Array<{ objectId?: string; value?: unknown }>,
    options: { isolatedFrameId?: string; potentialEffect?: boolean } = {},
  ): Promise<unknown> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser node has no DOM action target",
      );
    }
    // DOM reads enforce redaction in JavaScript. Resolve the node into a
    // separate world so page scripts cannot replace getAttribute, matches,
    // querySelectorAll, or value accessors used by that policy.
    let executionContextId: number | undefined;
    if (options.isolatedFrameId) {
      const world = await this.sendTarget<{ executionContextId?: unknown }>(
        state,
        "Page.createIsolatedWorld",
        { frameId: options.isolatedFrameId, worldName: "opengeni-dom-read" },
      );
      if (!Number.isSafeInteger(world.executionContextId)) {
        throw new Error("CDP did not create an isolated DOM read world");
      }
      executionContextId = world.executionContextId as number;
    }
    const resolved = await this.sendTarget<{ object?: unknown }>(state, "DOM.resolveNode", {
      backendNodeId: backendDOMNodeId,
      ...(executionContextId === undefined ? {} : { executionContextId }),
    });
    if (!isRecord(resolved.object) || typeof resolved.object.objectId !== "string") {
      throw new InteractionDefiniteDriverError(
        "locator_not_found",
        "browser element is no longer present",
      );
    }
    const objectId = resolved.object.objectId;
    try {
      const result = await this.sendActionTarget<{
        result?: unknown;
        exceptionDetails?: unknown;
      }>(
        state,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration,
          arguments: args.map((argument) =>
            argument.objectId ? { objectId: argument.objectId } : { value: argument.value },
          ),
          returnByValue: true,
          awaitPromise: true,
        },
        { potentialEffect: options.potentialEffect ?? false },
      );
      if (result.exceptionDetails) throw new Error("browser element function failed");
      return isRecord(result.result) ? result.result.value : undefined;
    } finally {
      await this.sendTarget(state, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  private async sendTarget<T = Record<string, unknown>>(
    state: TargetState,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const connection = await this.ensureConnection();
    this.assertCurrentTargetState(state);
    return await connection.send<T>(method, params, {
      sessionId: this.commandSession(state, method),
      ...options,
    });
  }

  /** Node-level calls for a node inside a cross-origin frame go to that frame's
   * session. Input and page-level calls use the page session, with pointer
   * coordinates translated into page space; node clicks pass their frame's
   * session explicitly (see clickInput). */
  private commandSession(state: TargetState, method: string): string {
    const route = state.nodeRoute;
    if (!route) return state.sessionId;
    return method.startsWith("DOM.") ||
      method.startsWith("Runtime.") ||
      method.startsWith("Accessibility.") ||
      method === "Page.createIsolatedWorld"
      ? route.sessionId
      : state.sessionId;
  }

  private async sendActionTarget<T = Record<string, unknown>>(
    state: TargetState,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: { potentialEffect?: boolean; sessionId?: string } = {},
  ): Promise<T> {
    const connection = await this.ensureConnection();
    this.assertCurrentTargetState(state);
    let unsubscribe: () => void = () => undefined;
    const dialog = new Promise<{ kind: "dialog" }>((resolve) => {
      unsubscribe = connection.on(
        "Page.javascriptDialogOpening",
        () => resolve({ kind: "dialog" }),
        state.sessionId,
      );
    });
    if (options.potentialEffect !== false && method !== "Page.getNavigationHistory")
      state.actionEffectCount += 1;
    const command = connection.send<T>(method, params, {
      sessionId: options.sessionId ?? this.commandSession(state, method),
    });
    try {
      const result = await Promise.race([
        command.then((value) => ({ kind: "result" as const, value })),
        dialog,
      ]);
      if (result.kind === "dialog") {
        void command.catch(() => undefined);
        throw new DialogOpenedSignal("browser action opened a JavaScript dialog");
      }
      return result.value;
    } finally {
      unsubscribe();
    }
  }

  private assertExpectedGenerations(command: BrowserActionCommandValue, state: TargetState): void {
    if (command.browserSessionId !== this.browserSessionId) {
      throw new InteractionDefiniteDriverError(
        "resource_not_found",
        "browser command targets another browser session",
      );
    }
    if (command.controllerGeneration !== this.controllerGeneration) {
      throw new InteractionDefiniteDriverError(
        "controller_stale",
        "browser command targets an earlier controller",
      );
    }
    if (command.expectedTargetGeneration !== this.targetGeneration(state.targetId)) {
      throw new InteractionDefiniteDriverError(
        "target_stale",
        "browser command targets an earlier target generation",
      );
    }
    if (command.expectedDocumentGeneration !== state.documentGeneration) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "browser command targets an earlier document",
      );
    }
    if (command.expectedFrameId !== state.frameGeneration) {
      throw new InteractionDefiniteDriverError(
        "frame_stale",
        "browser command targets an earlier frame generation",
      );
    }
  }

  private targetFromInfo(info: TargetInfo, state: TargetState | null): BrowserTargetValue {
    return BrowserTarget.parse({
      id: info.targetId,
      browserSessionId: this.browserSessionId,
      controllerGeneration: this.controllerGeneration,
      targetGeneration: this.targetGeneration(info.targetId),
      documentGeneration: state?.documentGeneration ?? null,
      kind: targetKind(info),
      title: info.title,
      // Chromium can briefly report ":" or an empty main-frame URL during
      // target creation. Use the first absolute URL so an accepted tab create
      // cannot turn into a schema-validation 500.
      url: absoluteTargetUrl(state?.frame.url) ?? absoluteTargetUrl(info.url) ?? "about:blank",
      selected: this.selectedTargetId === info.targetId,
      attached: state !== null,
      createdAt: state?.createdAt ?? this.firstSeen(info.targetId),
    });
  }

  private targetGeneration(targetId: string): string {
    return generation(
      "target",
      this.browserSessionId,
      this.controllerGeneration,
      this.targetPhysicalGeneration(targetId),
      targetId,
    );
  }

  private targetPhysicalGeneration(targetId: string): string {
    return this.targetPhysicalGenerations.get(targetId) ?? this.physicalGeneration;
  }

  private assertCurrentTargetState(state: TargetState): void {
    if (
      this.states.get(state.targetId) !== state ||
      this.targetPhysicalGeneration(state.targetId) !== state.authorityGeneration
    ) {
      throw new InteractionDefiniteDriverError("target_stale", "Browser tab attachment changed");
    }
  }

  private contextScope(): { browserContextId?: string } {
    return this.browserContextId ? { browserContextId: this.browserContextId } : {};
  }

  private async targetInfos(connection: BrowserCdpConnection): Promise<TargetInfo[]> {
    const response = await connection.send<{ targetInfos?: unknown }>("Target.getTargets");
    if (!Array.isArray(response.targetInfos))
      throw new Error("CDP returned an invalid target list");
    return response.targetInfos
      .map(normalizeTargetInfo)
      .filter(
        (target) =>
          this.browserContextId === undefined || target.browserContextId === this.browserContextId,
      );
  }

  private async requireTargetInfo(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<TargetInfo> {
    const info = (await this.targetInfos(connection)).find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!info || !isVisibleTarget(info)) {
      throw new InteractionDefiniteDriverError("target_not_found", "browser target does not exist");
    }
    return info;
  }

  /** Headed Chromium can acknowledge a background target before its first URL
   * reaches Target.getTargets/Page.getFrameTree. Do not expose that transient
   * empty document (or fail after the tab was already created); wait for the
   * exact returned target to become observable while keeping it unfocused. */
  private async waitForCreatedTargetInfo(
    connection: BrowserCdpConnection,
    targetId: string,
  ): Promise<TargetInfo> {
    const deadline = Date.now() + TARGET_CREATION_SETTLE_TIMEOUT_MS;
    let last: TargetInfo | null = null;
    do {
      last =
        (await this.targetInfos(connection)).find((candidate) => candidate.targetId === targetId) ??
        null;
      if (last && isVisibleTarget(last) && absoluteTargetUrl(last.url)) return last;
      await delay(25);
    } while (Date.now() < deadline);
    if (!last || !isVisibleTarget(last)) {
      throw new InteractionDefiniteDriverError("target_not_found", "browser target does not exist");
    }
    throw new InteractionDefiniteDriverError(
      "timeout",
      "browser target did not become observable",
      true,
    );
  }

  private async waitForCreatedTargetFrame(state: TargetState): Promise<void> {
    const deadline = Date.now() + TARGET_CREATION_SETTLE_TIMEOUT_MS;
    do {
      await this.refreshFrame(state);
      if (absoluteTargetUrl(state.frame.url)) return;
      await delay(25);
    } while (Date.now() < deadline);
    throw new InteractionDefiniteDriverError(
      "timeout",
      "browser target document did not become observable",
      true,
    );
  }

  private onFrameNavigated(state: TargetState, event: CdpEvent): void {
    if (!isRecord(event.params.frame) || typeof event.params.frame.parentId === "string") return;
    const frame = event.params.frame;
    if (
      typeof frame.id !== "string" ||
      typeof frame.loaderId !== "string" ||
      typeof frame.url !== "string"
    ) {
      return;
    }
    // Some CDP-compatible engines omit `parentId` on child-frame navigation
    // events. A page target has one established main-frame id, so never let a
    // malformed child event invalidate the top-level document generation.
    // `refreshFrame` still detects the exceptional case where the real main
    // frame id itself changes.
    if (frame.id !== state.frame.id) return;
    state.frame = { id: frame.id, loaderId: frame.loaderId, url: frame.url };
    state.documentGeneration = documentGeneration(
      this.controllerGeneration,
      state.authorityGeneration,
      state.targetId,
      frame.loaderId,
    );
    state.frameGeneration = frameGeneration(
      this.controllerGeneration,
      state.authorityGeneration,
      state.targetId,
      frame.id,
    );
    state.accessibility = null;
  }

  private recordFailedRequest(
    state: TargetState,
    requestId: string,
    details: { message: string; status?: number; url?: string | null },
  ): void {
    if (state.failedRequests.has(requestId)) return;
    state.failedRequests.add(requestId);
    state.diagnostics.failedRequestCount += 1;
    const request = state.requests.get(requestId);
    this.appendDiagnostic(state, {
      kind: "failed_request",
      level: "error",
      message: details.message,
      url: details.url ?? request?.url ?? null,
      method: request?.method ?? null,
      status: details.status ?? null,
      filename: null,
    });
  }

  private appendDiagnostic(
    state: TargetState,
    entry: Omit<BrowserDiagnosticEntry, "sequence" | "occurredAt">,
  ): void {
    const parsed = BrowserDiagnosticEntry.parse({
      ...entry,
      sequence: ++state.diagnosticSequence,
      occurredAt: this.timestamp(),
    });
    state.diagnosticEntries.push(parsed);
    if (state.diagnosticEntries.length > INTERACTION_MAX_DIAGNOSTIC_ENTRIES) {
      state.diagnosticEntries.splice(
        0,
        state.diagnosticEntries.length - INTERACTION_MAX_DIAGNOSTIC_ENTRIES,
      );
    }
  }

  private removeState(targetId: string, preserveFirstSeen = false): void {
    // A closed or destroyed tab is gone; a crashed one that we only detached from stays marked.
    if (!preserveFirstSeen) this.crashedTargets.delete(targetId);
    const state = this.states.get(targetId);
    if (!state) return;
    this.failAllScreencasts(state, new CdpTransportError("browser target closed"));
    for (const unsubscribe of state.unsubscribe) unsubscribe();
    this.states.delete(targetId);
    if (!preserveFirstSeen) this.firstSeenAt.delete(targetId);
  }

  /**
   * The tab's renderer died. Nothing will answer its pending or later page
   * commands, so detach: that ends every command waiting on it at once, and
   * the next use re-attaches and reports the crash immediately.
   */
  private onTargetCrashed(state: TargetState): void {
    if (this.states.get(state.targetId) !== state) return;
    this.crashedTargets.add(state.targetId);
    const forget = () => {
      if (this.states.get(state.targetId) !== state) return;
      this.targetPhysicalGenerations.set(state.targetId, randomUUID());
      this.removeState(state.targetId, true);
    };
    void this.ensureConnection()
      .then((connection) =>
        connection.send(
          "Target.detachFromTarget",
          { sessionId: state.sessionId },
          { timeoutMs: 1_000 },
        ),
      )
      .catch(() => undefined)
      .finally(forget);
  }

  private firstSeen(targetId: string): string {
    const existing = this.firstSeenAt.get(targetId);
    if (existing) return existing;
    const createdAt = this.timestamp();
    this.firstSeenAt.set(targetId, createdAt);
    return createdAt;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** Retrying can't help a tab whose page process died; say what will. */
function tabCrashedError(): InteractionDefiniteDriverError {
  return new InteractionDefiniteDriverError(
    "tab_crashed",
    "This browser tab crashed and no longer responds. Open a new tab (and close this one), then continue there.",
    false,
  );
}

const TAB_NOT_RESPONDING_MESSAGE =
  "This browser tab is not responding: its page did not answer in time. Close it and open the page in a new tab, or reload it from the browser window. The browser and other tabs remain usable.";

/** A page-scoped command deadline means this tab stopped answering, not that
 * the browser or its transport was lost. Waiting again cannot help until the
 * tab is reloaded or replaced, so the diagnosis is definite and not retryable. */
function tabNotRespondingError(cause: CdpCommandTimeoutError): InteractionControllerError {
  const failure = new InteractionControllerError("tab_not_responding", TAB_NOT_RESPONDING_MESSAGE);
  failure.cause = cause;
  return failure;
}

function frameStreamDiagnostic(event: string, fields: Readonly<Record<string, unknown>>): void {
  console.info(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

function normalizeTargetInfo(value: unknown): TargetInfo {
  if (!isRecord(value) || typeof value.targetId !== "string" || typeof value.type !== "string") {
    throw new Error("CDP returned an invalid target");
  }
  return {
    browserContextId: typeof value.browserContextId === "string" ? value.browserContextId : null,
    targetId: value.targetId,
    type: value.type,
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : "about:blank",
    attached: value.attached === true,
    openerId: typeof value.openerId === "string" ? value.openerId : null,
  };
}

/** A tab with no page: the blank document a new tab starts on (attached
 * Chrome creates it as an empty data URL) or the browser's new-tab page. */
function isBlankTabUrl(url: string): boolean {
  return (
    url === "" ||
    url === "about:blank" ||
    url === "data:text/html," ||
    url === "chrome://newtab/" ||
    url === "chrome://new-tab-page/"
  );
}

function absoluteTargetUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return null;
  try {
    return new URL(value).href.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function visibleTargets(infos: readonly TargetInfo[]): TargetInfo[] {
  const targets = infos.filter(isVisibleTarget);
  const hasOrdinaryPage = targets.some(
    (target) => target.type === "page" && target.url !== "chrome://newtab/",
  );
  return hasOrdinaryPage ? targets.filter((target) => target.url !== "chrome://newtab/") : targets;
}

function visiblePageTargets(infos: readonly TargetInfo[]): TargetInfo[] {
  return visibleTargets(infos).filter((target) => target.type === "page");
}

function isVisibleTarget(info: TargetInfo): boolean {
  return info.type === "page";
}

function targetKind(info: TargetInfo): BrowserTargetValue["kind"] {
  if (info.openerId) return "popup";
  if (info.type === "background_page") return "background_page";
  if (info.type.includes("worker")) return "worker";
  return "page";
}

function documentGeneration(
  controllerGeneration: string,
  physicalGeneration: string,
  targetId: string,
  loaderId: string,
): string {
  return generation("document", controllerGeneration, physicalGeneration, targetId, loaderId);
}

function frameGeneration(
  controllerGeneration: string,
  physicalGeneration: string,
  targetId: string,
  frameId: string,
): string {
  return generation("frame", controllerGeneration, physicalGeneration, targetId, frameId);
}

function generation(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function uniqueEntries(entries: CdpAccessibilityEntry[]): CdpAccessibilityEntry | null {
  const byBackend = new Map<number, CdpAccessibilityEntry>();
  for (const entry of entries) {
    if (entry.backendDOMNodeId !== null) byBackend.set(entry.backendDOMNodeId, entry);
  }
  return byBackend.size === 1 ? [...byBackend.values()][0]! : null;
}

function boundedTargetText(value: string | null): string | null {
  const text = value?.replace(/\s+/gu, " ").trim() ?? "";
  if (!text) return null;
  const codePoints = Array.from(text);
  return codePoints.length <= INTERACTION_MAX_RESOLVED_TARGET_TEXT
    ? text
    : `${codePoints.slice(0, INTERACTION_MAX_RESOLVED_TARGET_TEXT - 1).join("")}\u2026`;
}

function boundedTargetRole(value: string): string {
  const role = value.trim().slice(0, 64);
  return role || "generic";
}

function syntheticEntry(backendDOMNodeId: number): CdpAccessibilityEntry {
  return {
    ref: "",
    nodeId: "",
    parentNodeId: null,
    backendDOMNodeId,
    frameId: null,
    role: "generic",
    name: null,
    states: [],
    actions: [],
    nameSources: [],
  };
}

function emptyAccessibilitySnapshot(): CdpAccessibilitySnapshot {
  return {
    roots: [],
    nodeCount: 0,
    focusedRef: null,
    entries: [],
    entriesByRef: new Map(),
    entriesByNodeId: new Map(),
  };
}

function isFormControlRole(role: string): boolean {
  return [
    "button",
    "checkbox",
    "combobox",
    "listbox",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "textbox",
  ].includes(role);
}

type ParsedKey = {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
  text: string;
};

/** A literal character as one key press (typed with `type.mode: "keys"`). */
function characterKey(character: string): ParsedKey {
  if (character === "\n" || character === "\r") {
    return { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0, text: "\r" };
  }
  if (character === " ") return { key: " ", code: "Space", keyCode: 32, modifiers: 0, text: " " };
  if (/^[0-9]$/u.test(character)) {
    return {
      key: character,
      code: `Digit${character}`,
      keyCode: character.charCodeAt(0),
      modifiers: 0,
      text: character,
    };
  }
  if (/^[a-z]$/iu.test(character)) {
    const upper = character.toUpperCase();
    return {
      key: character,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      modifiers: 0,
      text: character,
    };
  }
  return { key: character, code: "", keyCode: 0, modifiers: 0, text: character };
}

/** Replace `{{secret:…}}` references with the controller-private values right
 * before dispatch. The returned command no longer carries the side map, so
 * nothing downstream can echo it. */
function materializeCommandSecrets(command: BrowserActionCommandValue): BrowserActionCommandValue {
  if (command.secretValues === undefined) return command;
  try {
    const action = materializeBrowserActionSecrets(command);
    const { secretValues: _consumed, ...rest } = command;
    return { ...rest, action };
  } catch (error) {
    if (error instanceof InteractionSecretValueError) {
      throw new InteractionDefiniteDriverError("invalid_action", error.message);
    }
    throw error;
  }
}

function parseKey(input: string, mac: boolean): ParsedKey {
  const parts = input.split("+");
  const rawKey = parts.pop()?.trim();
  if (!rawKey) throw new InteractionDefiniteDriverError("invalid_action", "browser key is invalid");
  let modifiers = 0;
  for (const part of parts) {
    const modifier = part.trim().toLowerCase();
    if (modifier === "alt" || modifier === "option") modifiers |= 1;
    else if (modifier === "control" || modifier === "ctrl") modifiers |= 2;
    else if (modifier === "mod") modifiers |= mac ? 4 : 2;
    else if (modifier === "meta" || modifier === "command" || modifier === "cmd") modifiers |= 4;
    else if (modifier === "shift") modifiers |= 8;
    else
      throw new InteractionDefiniteDriverError("invalid_action", "browser key modifier is invalid");
  }
  if (rawKey.toLowerCase() === "mod") {
    throw new InteractionDefiniteDriverError(
      "invalid_action",
      "browser key requires a non-modifier key",
    );
  }
  const special = KEY_DEFINITIONS[rawKey.toLowerCase()];
  if (special) return { ...special, modifiers, text: special.text ?? "" };
  if ([...rawKey].length !== 1) {
    throw new InteractionDefiniteDriverError("invalid_action", "browser key is unsupported");
  }
  const upper = rawKey.toUpperCase();
  return {
    key: rawKey,
    code: /[a-z]/iu.test(rawKey) ? `Key${upper}` : rawKey,
    keyCode: upper.codePointAt(0) ?? 0,
    modifiers,
    text: modifiers === 0 ? rawKey : "",
  };
}

type KeyDefinition = { key: string; code: string; keyCode: number; text?: string };

const NAMED_KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  contextmenu: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

// Standard key names (KeyboardEvent.key, case-insensitive), the function keys
// F1-F24, and the common short spellings of the same keys.
const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  ...NAMED_KEY_DEFINITIONS,
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => {
      const name = `F${index + 1}`;
      return [name.toLowerCase(), { key: name, code: name, keyCode: 112 + index }];
    }),
  ),
  esc: NAMED_KEY_DEFINITIONS.escape!,
  return: NAMED_KEY_DEFINITIONS.enter!,
  del: NAMED_KEY_DEFINITIONS.delete!,
  ins: NAMED_KEY_DEFINITIONS.insert!,
  pgup: NAMED_KEY_DEFINITIONS.pageup!,
  pgdn: NAMED_KEY_DEFINITIONS.pagedown!,
  up: NAMED_KEY_DEFINITIONS.arrowup!,
  down: NAMED_KEY_DEFINITIONS.arrowdown!,
  left: NAMED_KEY_DEFINITIONS.arrowleft!,
  right: NAMED_KEY_DEFINITIONS.arrowright!,
};

// Typical exit animations take 100-300 ms. Longer finite animations are
// waited for only this long, so a slow transition cannot stall every action.
const ANIMATION_SETTLE_LIMIT_MS = 750;
// Requests an action starts usually answer in well under a second; a request
// that stays open (a stream, a stalled server) must not hold the result back.
const ACTION_REQUEST_SETTLE_LIMIT_MS = 1_500;
const ACTION_REQUEST_POLL_MS = 20;
// The response handler runs after the network layer reports the load finished.
const ACTION_RESPONSE_APPLY_MS = 50;

// Waits until no finite animation is running, then lets animationend
// handlers commit their DOM removal (which can chain another animation).
const SETTLE_FINITE_ANIMATIONS_EXPRESSION = `(async () => {
  const deadline = performance.now() + ${ANIMATION_SETTLE_LIMIT_MS};
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const remaining = () => deadline - performance.now();
  const running = () =>
    document.getAnimations().filter((animation) => {
      if (animation.playState !== "running") return false;
      const end = animation.effect?.getComputedTiming().endTime;
      return typeof end === "number" && Number.isFinite(end);
    });
  // Hidden documents do not advance animations, so there is nothing to wait for.
  if (document.visibilityState === "hidden") return true;
  let pending = running();
  if (pending.length === 0) return true;
  while (pending.length > 0) {
    if (remaining() <= 0) return false;
    await Promise.race([
      Promise.allSettled(pending.map((animation) => animation.finished)),
      pause(remaining()),
    ]);
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
      pause(Math.min(50, remaining())),
    ]);
    pending = running();
  }
  return true;
})()`;

// A child frame's scroll can also move its parent documents, which this frame
// cannot read, so only top-level frames report positions.
const SCROLL_POSITIONS_FUNCTION = `function() {
  if (window !== window.top) return null;
  const start = this instanceof Element ? this : this.parentElement;
  if (!(start instanceof Element)) return null;
  const viewport = window.visualViewport;
  const positions = [window.scrollX, window.scrollY, viewport ? viewport.offsetLeft : 0, viewport ? viewport.offsetTop : 0];
  for (let node = start; node; ) {
    if (node instanceof Element) positions.push(node.scrollLeft, node.scrollTop);
    const parent = node.assignedSlot || node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent instanceof Element ? parent : null;
  }
  const root = document.scrollingElement;
  if (root) positions.push(root.scrollLeft, root.scrollTop);
  return positions.join(",");
}`;

const HIT_TEST_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const root = element.getRootNode();
  const hitTest = root && typeof root.elementFromPoint === "function" ? root : document;
  const hit = hitTest.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return Boolean(hit && (element === hit || element.contains?.(hit)));
}`;

// Whether pointer input at the target's centre falls through it to one of its
// own ancestors: the target (or a wrapper) is pointer-transparent there, as a
// hover-revealed control is before the pointer arrives, rather than covered.
const POINTER_TRANSPARENT_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const root = element.getRootNode();
  const hitTest = root && typeof root.elementFromPoint === "function" ? root : document;
  const hit = hitTest.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return Boolean(hit && hit !== element && !element.contains(hit) && hit.contains(element));
}`;

// Whether the element at the target's centre belongs to a sticky element, or
// to a fixed one smaller than the viewport, i.e. a bar that scrolling can
// move the target out from under.
const STICKY_COVER_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const root = element.getRootNode();
  const hitTest = root && typeof root.elementFromPoint === "function" ? root : document;
  let node = hitTest.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!node || element === node || element.contains(node)) return false;
  while (node instanceof Element) {
    const position = getComputedStyle(node).position;
    if (position === "sticky") return true;
    if (position === "fixed") {
      const box = node.getBoundingClientRect();
      return !(box.left <= 0 && box.top <= 0 && box.right >= innerWidth && box.bottom >= innerHeight);
    }
    const parentRoot = node.getRootNode();
    node = node.parentElement ?? (parentRoot instanceof ShadowRoot ? parentRoot.host : null);
  }
  return false;
}`;

const SCROLL_INTO_VIEW_FUNCTION = `function(alignment) {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element)) return false;
  element.scrollIntoView({ block: alignment, inline: alignment, behavior: "instant" });
  return true;
}`;

const VISIBLE_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}`;

const CHECKED_FUNCTION = `function() {
  return typeof this.checked === "boolean" ? this.checked : null;
}`;

const SELECT_OPTIONS_FUNCTION = `function(values) {
  if (!(this instanceof HTMLSelectElement) || this.matches(":disabled")) return false;
  const selected = new Set(values.map(String));
  const choices = Array.from(this.options).filter(option => selected.has(option.value) || selected.has(option.label));
  if (values.some(value => !choices.some(option => option.value === String(value) || option.label === String(value)))) return false;
  if ((!this.multiple && choices.length > 1) || choices.some(option => !option.selected && (option.disabled || option.closest("optgroup[disabled]")))) return false;
  for (const option of this.options) option.selected = selected.has(option.value) || selected.has(option.label);
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

/** Scroll the nearest box around the element that can move in each requested
 * direction, crossing shadow roots and slots like a wheel event would. Only
 * boxes a user can scroll count: overflow auto, scroll or overlay, or the
 * viewport unless it hides overflow. Returns whether anything moved. */
const SCROLL_FUNCTION = `function(deltaX, deltaY) {
  const start = this && this.nodeType === 1 ? this : this?.parentElement;
  if (!start || !start.isConnected) return false;
  const doc = start.ownerDocument;
  const view = doc.defaultView;
  const root = doc.scrollingElement || doc.documentElement;
  const parentOf = (element) =>
    element.assignedSlot ||
    element.parentElement ||
    (element.parentNode && element.parentNode.nodeType === 11 ? element.parentNode.host : null);
  const overflow = (element, axis) =>
    view.getComputedStyle(element)[axis === "x" ? "overflowX" : "overflowY"];
  const scrollable = (element, axis) => {
    if (element !== root) return ["auto", "scroll", "overlay"].includes(overflow(element, axis));
    const html = overflow(doc.documentElement, axis);
    const viewport = html === "visible" && doc.body ? overflow(doc.body, axis) : html;
    return viewport !== "hidden" && viewport !== "clip";
  };
  const scrollAxis = (axis, delta) => {
    if (!delta) return false;
    const read = (element) => (axis === "x" ? element.scrollLeft : element.scrollTop);
    const candidates = [];
    for (let element = start; element; element = element === root ? null : parentOf(element))
      candidates.push(element);
    if (!candidates.includes(root)) candidates.push(root);
    for (const element of candidates) {
      if (!scrollable(element, axis)) continue;
      const before = read(element);
      element.scrollBy(
        axis === "x" ? { left: delta, behavior: "instant" } : { top: delta, behavior: "instant" },
      );
      if (read(element) !== before) return true;
    }
    return false;
  };
  const movedX = scrollAxis("x", deltaX);
  const movedY = scrollAxis("y", deltaY);
  return movedX || movedY;
}`;

const PAGE_SCROLL_FUNCTION = `function(deltaX, deltaY) {
  const root = document.scrollingElement || document.documentElement;
  const before = [root.scrollLeft, root.scrollTop];
  window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
  return root.scrollLeft !== before[0] || root.scrollTop !== before[1];
}`;

/** Fixed browser-side projection. Every field shares one character budget, so
 * a huge page cannot turn a focused query into an unbounded CDP payload. */
const DOM_READ_FUNCTION = `function(maxChars, requestedAttributes, includeSelect) {
  const element = this && this.nodeType === 1 ? this : this?.parentElement;
  if (!element || element.nodeType !== 1 || !element.isConnected) return { ok: false };
  const privateSelector = "[data-private], [data-sensitive], [data-opengeni-private]";
  const sensitiveReason = (node) => {
    const nodeTag = String(node.tagName || "").toLowerCase();
    const type = nodeTag === "input" ? String(node.getAttribute("type") || "text").toLowerCase() : "";
    const autocomplete = String(node.getAttribute("autocomplete") || "").toLowerCase();
    const fieldName = String(node.getAttribute("name") || "") + " " + String(node.getAttribute("id") || "");
    if (type === "password" || /(?:current|new)-password|one-time-code/.test(autocomplete)) return "password";
    if (/(?:^|\\s)cc-/.test(autocomplete) || /(?:card.?number|credit.?card|cvv|cvc|security.?code|expiry|expiration)/i.test(fieldName)) return "payment";
    if (type === "hidden" || node.matches(privateSelector)) return "private";
    return null;
  };
  const tag = String(element.tagName || "").toLowerCase();
  let redacted = sensitiveReason(element);
  for (let ancestor = element.parentElement; !redacted && ancestor; ancestor = ancestor.parentElement) {
    redacted = sensitiveReason(ancestor);
  }
  if (redacted) return { ok: true, text: null, value: null, attributes: {}, redacted, truncated: false };
  // A container's innerText includes sensitive descendants. Refuse the whole
  // container rather than returning their protected text through an ancestor.
  for (const node of element.querySelectorAll("[id], [name], [autocomplete], input, " + privateSelector)) {
    const reason = sensitiveReason(node);
    if (reason) return { ok: true, text: null, value: null, attributes: {}, redacted: reason, truncated: false };
  }
  const allowed = new Set(["href", "src", "alt", "title", "role", "aria-label", "aria-expanded",
    "aria-checked", "aria-selected", "placeholder", "type", "name", "data-testid"]);
  let remaining = maxChars;
  let truncated = false;
  const bounded = (raw) => {
    if (raw === null || raw === undefined) return null;
    const value = String(raw);
    const kept = value.slice(0, remaining);
    remaining -= kept.length;
    if (kept.length < value.length) truncated = true;
    return kept;
  };
  const text = bounded(element.innerText ?? element.textContent ?? "");
  const value = tag === "input" || tag === "textarea" || tag === "select"
    ? bounded(element.value ?? "") : null;
  const attributes = {};
  for (const attribute of requestedAttributes) {
    if (allowed.has(attribute)) attributes[attribute] = bounded(element.getAttribute(attribute));
  }
  let select = null;
  if (includeSelect && element instanceof HTMLSelectElement && element.options.length <= 200) {
    select = { kind: "native-select", multiple: element.multiple, disabled: element.matches(":disabled"),
      options: Array.from(element.options, (option) => ({
        value: bounded(option.value), label: bounded(option.label), selected: option.selected,
        disabled: option.disabled || Boolean(option.closest("optgroup[disabled]"))
      })) };
  }
  return { ok: true, text, value, attributes, redacted: null, truncated, select };
}`;

/** Attribute and pseudo selectors would turn count/not-found into a secret-value oracle. */
function assertSafeDomReadSelector(selector: string): void {
  if (!/^[A-Za-z0-9_#.,\s>*-]+$/u.test(selector)) {
    throw new InteractionDefiniteDriverError(
      "invalid_action",
      "browser DOM read supports only tag, class, id, descendant, and child selectors",
    );
  }
}

const COPY_BROWSER_TEXT_FUNCTION = `function(content) {
  const element = this && this.nodeType === 1 ? this : this?.parentElement;
  if (!element || element.nodeType !== 1 || !element.isConnected) return { ok: false, error: "unavailable" };
  const tag = String(element.tagName || "").toLowerCase();
  if (tag === "input" && String(element.type).toLowerCase() === "password") {
    return { ok: false, error: "protected" };
  }
  if (content === "value") {
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return { ok: true, text: String(element.value ?? "") };
    }
    return { ok: false, error: "unavailable" };
  }
  if (content === "text") {
    return { ok: true, text: String(element.innerText ?? element.textContent ?? "") };
  }
  if (tag === "input" || tag === "textarea") {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number") return { ok: false, error: "unavailable" };
    return { ok: true, text: String(element.value).slice(start, end) };
  }
  const selection = element.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return { ok: true, text: "" };
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== element) {
    return { ok: false, error: "unavailable" };
  }
  return { ok: true, text: selection.toString() };
}`;

const COPY_ACTIVE_BROWSER_TEXT_FUNCTION = `function(content) {
  let element = document.activeElement || document.body;
  for (let depth = 0; depth < 16 && ["iframe", "frame"].includes(String(element?.tagName || "").toLowerCase()); depth += 1) {
    try {
      const nested = element.contentDocument?.activeElement;
      if (!nested) return { ok: false, error: "unavailable" };
      element = nested;
    } catch {
      return { ok: false, error: "unavailable" };
    }
  }
  return (${COPY_BROWSER_TEXT_FUNCTION}).call(element, content);
}`;

const LIGHTPANDA_TYPING_TARGET_EXPRESSION = `(() => {
  const element = document.activeElement;
  if (!(element instanceof Element) || !element.isConnected || element.disabled || element.readOnly) return false;
  const tag = String(element.tagName || "").toLowerCase();
  return tag === "textarea" || (tag === "input" && ["text", "search", "url", "tel", "password", "email", "number"].includes(element.type));
})()`;

const LIGHTPANDA_CLEAR_EDITABLE_FUNCTION = `function() {
  if (!(this instanceof Element) || !this.isConnected || document.activeElement !== this) return false;
  const tag = String(this.tagName || "").toLowerCase();
  if (tag !== "input" && tag !== "textarea") return false;
  if (this.disabled || this.readOnly) return false;
  if (tag === "input" && !["text", "search", "url", "tel", "password", "email", "number"].includes(this.type)) return false;
  const prototype = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (typeof setter !== "function") return false;
  setter.call(this, "");
  return true;
}`;

const CONFIRM_EDITABLE_VALUE_FUNCTION = `async function(expected) {
  await Promise.resolve();
  if (!(this instanceof Element) || !this.isConnected) return false;
  const tag = String(this.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return String(this.value) === String(expected);
  if (this.isContentEditable === true) return String(this.textContent || "") === String(expected);
  return false;
}`;

const NATIVE_DATE_TIME_FORMATS: Readonly<Record<string, string>> = {
  date: "YYYY-MM-DD",
  time: "HH:MM in 24-hour time, optionally HH:MM:SS",
  "datetime-local": "YYYY-MM-DDTHH:MM",
  month: "YYYY-MM",
  week: "YYYY-Www",
};

// Resolves a native date/time input from the input itself or from one of the
// parts in its user-agent shadow root. Inputs cannot host author shadow roots,
// so a shadow root whose host is an input is always the browser's own.
const NATIVE_DATE_TIME_HOST_SOURCE = `
  const nativeDateTimeHost = (node) => {
    let element = node;
    for (let depth = 0; depth < 4 && element; depth++) {
      if (String(element.tagName || "").toLowerCase() === "input") break;
      const root = typeof element.getRootNode === "function" ? element.getRootNode() : null;
      element = root && root.host ? root.host : null;
    }
    if (!element || String(element.tagName || "").toLowerCase() !== "input") return null;
    const type = String(element.type || "").toLowerCase();
    return ${JSON.stringify(Object.keys(NATIVE_DATE_TIME_FORMATS))}.includes(type) ? element : null;
  };`;

const INSPECT_NATIVE_DATE_TIME_FILL_FUNCTION = `function(expected) {${NATIVE_DATE_TIME_HOST_SOURCE}
  const input = nativeDateTimeHost(this);
  if (!input) return { kind: "other" };
  const type = String(input.type).toLowerCase();
  const part = input !== this;
  if (input.disabled || input.readOnly) return { kind: "not_editable", type, part };
  const probe = input.ownerDocument.createElement("input");
  probe.type = type;
  probe.value = String(expected);
  if (probe.value !== String(expected)) return { kind: "invalid_value", type, part };
  return { kind: "native", type, part };
}`;

// The prototype setter bypasses per-instance value trackers that frameworks
// install, so their input listeners see the change as user input.
const SET_NATIVE_DATE_TIME_VALUE_FUNCTION = `async function(expected) {${NATIVE_DATE_TIME_HOST_SOURCE}
  const input = nativeDateTimeHost(this);
  if (!input || !input.isConnected) return false;
  const view = input.ownerDocument.defaultView;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value").set;
  input.focus();
  setter.call(input, String(expected));
  input.dispatchEvent(new view.Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
  await Promise.resolve();
  return input.isConnected && input.value === String(expected);
}`;

function cssString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\r?\n/gu, "\\a ");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function browserDialog(params: Record<string, unknown>, openedAt: string): BrowserDialog {
  const type = ["alert", "confirm", "prompt", "beforeunload"].includes(String(params.type))
    ? String(params.type)
    : "alert";
  return BrowserDialog.parse({
    type,
    message: boundedTextField(params.message, 8_192) ?? "",
    defaultPrompt: boundedTextField(params.defaultPrompt, 32_768) ?? "",
    openedAt,
  });
}

function consoleLevel(value: unknown): BrowserDiagnosticEntry["level"] {
  if (value === "debug") return "debug";
  if (value === "error" || value === "assert") return "error";
  if (value === "warning") return "warning";
  return "info";
}

function consoleMessage(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "Console event";
  const text = value.slice(0, 100).map(remoteObjectText).filter(Boolean).join(" ").slice(0, 8_192);
  return text || "Console event";
}

function remoteObjectText(value: unknown): string {
  if (!isRecord(value)) return "";
  if (value.value !== undefined) {
    if (typeof value.value === "string") return value.value.slice(0, 4_096);
    try {
      return JSON.stringify(value.value).slice(0, 4_096);
    } catch {
      return "[unserializable value]";
    }
  }
  if (typeof value.description === "string") return value.description.slice(0, 4_096);
  return typeof value.type === "string" ? `[${value.type.slice(0, 128)}]` : "";
}

function exceptionMessage(details: Record<string, unknown>): string {
  const exception = isRecord(details.exception) ? details.exception : {};
  return (
    boundedTextField(exception.description, 8_192) ??
    boundedTextField(details.text, 8_192) ??
    "Unhandled page exception"
  );
}

function boundedTextField(value: unknown, maxLength: number): string | null {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function boundedUrlField(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, 16_384);
}

function boundedMethod(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "GET";
  return value.slice(0, 32);
}

function boundMap<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function boundedNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`browser ${label} must be a nonnegative integer`);
  }
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`browser ${label} must be a positive bounded integer`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dimensionsRecord(
  value: unknown,
  includeOffset: boolean,
): { x: number; y: number; width: number; height: number } {
  if (!isRecord(value)) throw new Error("CDP returned invalid page dimensions");
  const width = numberField(value, includeOffset ? "clientWidth" : "width");
  const height = numberField(value, includeOffset ? "clientHeight" : "height");
  const x = includeOffset ? (numberField(value, "pageX") ?? 0) : 0;
  const y = includeOffset ? (numberField(value, "pageY") ?? 0) : 0;
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new Error("CDP returned invalid page dimensions");
  }
  return { x, y, width, height };
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function finiteScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error("browser frame has an invalid scale");
  }
  return value;
}

function mouseButtonMask(button: "left" | "right" | "middle"): number {
  switch (button) {
    case "left":
      return 1;
    case "right":
      return 2;
    case "middle":
      return 4;
  }
}

function frameStreamProfileKey(options: NormalizedBrowserFrameStreamOptions): string {
  return [
    options.format,
    options.quality,
    options.maxWidth,
    options.maxHeight,
    options.everyNthFrame,
  ].join(":");
}

function transportError(value: unknown): Error {
  return value instanceof Error ? value : new CdpTransportError("browser media stream failed");
}

function parseUserAgentMetadata(value: unknown): BrowserUserAgentMetadata {
  if (!isRecord(value) || typeof value.mobile !== "boolean") {
    throw new Error("browser returned invalid User-Agent metadata");
  }
  const metadata: BrowserUserAgentMetadata = {
    platform: userAgentMetadataString(value.platform),
    platformVersion: userAgentMetadataString(value.platformVersion),
    architecture: userAgentMetadataString(value.architecture),
    model: userAgentMetadataString(value.model),
    mobile: value.mobile,
  };
  const brands = userAgentBrandList(value.brands);
  const fullVersionList = userAgentBrandList(value.fullVersionList);
  const bitness = optionalUserAgentMetadataString(value.bitness);
  const formFactors = userAgentStringList(value.formFactors);
  if (brands) metadata.brands = brands;
  if (fullVersionList) metadata.fullVersionList = fullVersionList;
  if (bitness !== undefined) metadata.bitness = bitness;
  if (typeof value.wow64 === "boolean") metadata.wow64 = value.wow64;
  if (formFactors) metadata.formFactors = formFactors;
  return metadata;
}

function userAgentBrandList(value: unknown): Array<{ brand: string; version: string }> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("browser returned invalid User-Agent brands");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("browser returned invalid User-Agent brand");
    return {
      brand: userAgentMetadataString(entry.brand),
      version: userAgentMetadataString(entry.version),
    };
  });
}

function userAgentStringList(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("browser returned invalid User-Agent form factors");
  }
  return value.map(userAgentMetadataString);
}

function optionalUserAgentMetadataString(value: unknown): string | undefined {
  return value === undefined ? undefined : userAgentMetadataString(value);
}

function userAgentMetadataString(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 512 || /[\r\n\0]/u.test(value)) {
    throw new Error("browser returned invalid User-Agent metadata");
  }
  return value;
}

function normalizeLocale(value: string): string {
  return value.replaceAll("_", "-").toLocaleLowerCase();
}

function webOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InteractionDefiniteDriverError(
      "invalid_action",
      "browser permission control requires an HTTP(S) top-level document",
    );
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") {
    throw new InteractionDefiniteDriverError(
      "invalid_action",
      "browser permission control requires an HTTP(S) top-level document",
    );
  }
  return url.origin;
}

/** A frame document's origin for its accessibility description, if it has one. */
function frameOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin.slice(0, 2_048);
  } catch {
    return null;
  }
}

function parseFrameTree(
  value: Record<string, unknown>,
  state: { count: number } = { count: 0 },
): PageFrameTree {
  state.count += 1;
  if (state.count > MAX_FRAME_TREES) {
    throw new Error("CDP frame tree exceeds its bounded envelope");
  }
  if (!isRecord(value.frame)) throw new Error("CDP returned an invalid frame tree");
  const frame = value.frame;
  if (
    typeof frame.id !== "string" ||
    typeof frame.loaderId !== "string" ||
    typeof frame.url !== "string"
  ) {
    throw new Error("CDP returned an invalid frame");
  }
  const rawChildren = value.childFrames;
  if (rawChildren !== undefined && !Array.isArray(rawChildren)) {
    throw new Error("CDP returned invalid child frames");
  }
  return {
    frame: { id: frame.id, loaderId: frame.loaderId, url: frame.url },
    childFrames: (rawChildren ?? []).map((child) => {
      if (!isRecord(child)) throw new Error("CDP returned an invalid child frame");
      return parseFrameTree(child, state);
    }),
  };
}

function flattenFrameTree(root: PageFrameTree): MainFrame[] {
  const frames: MainFrame[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    frames.push(current.frame);
    pending.unshift(...current.childFrames);
  }
  return frames;
}

function frameTreeFingerprint(frames: readonly MainFrame[]): string {
  return frames.map((frame) => `${frame.id}\0${frame.loaderId}`).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertOwnedCdpProcess(
  connection: BrowserCdpConnection,
  process: OwnedManagedBrowserProcess,
) {
  if ((await ownedCdpProcessId(connection)) !== process.pid)
    throw new Error("CDP endpoint does not identify the exact owned browser process");
}

async function ownedCdpProcessId(connection: BrowserCdpConnection): Promise<number> {
  const result = await connection.send<{ processInfo?: unknown }>(
    "SystemInfo.getProcessInfo",
    {},
    { timeoutMs: 2_000 },
  );
  if (!Array.isArray(result.processInfo))
    throw new Error("owned browser CDP process identity is unavailable");
  const browsers = result.processInfo.filter(
    (value: unknown): value is { type: string; id: number } =>
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "browser",
  );
  const pid = browsers[0]?.id;
  if (
    browsers.length !== 1 ||
    !Number.isSafeInteger(pid) ||
    pid === undefined ||
    pid < 2 ||
    pid > 2_147_483_647
  ) {
    throw new Error("CDP endpoint does not identify the exact owned browser process");
  }
  return pid;
}

function isNavigationTimeout(error: unknown): boolean {
  return (
    error instanceof CdpCommandTimeoutError ||
    (error instanceof InteractionDefiniteDriverError && error.code === "timeout")
  );
}

/** Chromium reports a page that could not load (DNS, connection, TLS, ...)
 * as a `net::ERR_*` navigation error after committing its error page. Other
 * navigation errors, such as an invalid URL, leave no page for the URL. */
function isPageLoadError(errorText: string): boolean {
  return /^net::ERR_[A-Z0-9_]+$/u.test(errorText);
}
