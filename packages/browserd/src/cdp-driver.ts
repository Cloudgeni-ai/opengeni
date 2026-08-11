import { createHash, randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  BrowserActionCommand,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDiagnosticEntry,
  BrowserDialog,
  BrowserExternalAuthCommand,
  BrowserExternalAuthResult,
  BrowserObservation,
  BrowserProtectedAuthFillCommand,
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
  type BrowserObservation as BrowserObservationValue,
  type BrowserProtectedAuthFillCommand as BrowserProtectedAuthFillCommandValue,
  type BrowserProtectedAuthObservation as BrowserProtectedAuthObservationValue,
  type BrowserTarget as BrowserTargetValue,
} from "@opengeni/contracts";
import {
  InteractionDefiniteDriverError,
  type BrowserInteractionDriver,
} from "@opengeni/interaction";
import {
  namespaceCdpAccessibilityFrame,
  normalizeCdpAccessibilityTree,
  type CdpAccessibilityEntry,
  type CdpAccessibilitySnapshot,
  type CdpAxNode,
} from "./cdp-accessibility";
import { CdpConnection, CdpProtocolError, CdpTransportError, type CdpEvent } from "./cdp";
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
import type { AgentBrowserJsonCommand } from "./runner";

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const BROWSER_START_TIMEOUT_MS = 30_000;
const GRACEFUL_BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_MS = 500;
const PROTECTED_AUTH_AUTO_ADVANCE_TIMEOUT_MS = 3_000;
const PROTECTED_AUTH_DIAGNOSTIC_QUIET_MS = 5_000;
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
  terminate?: () => Promise<void>;
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
  options: NormalizedBrowserFrameStreamOptions;
  sequence: number;
  subscriptions: Map<string, LatestBrowserFrameSubscription>;
  unsubscribe: () => void;
};

type TargetState = {
  targetId: string;
  sessionId: string;
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
  screencast: TargetScreencast | null;
  protectedAuthActive: boolean;
  protectedAuthQuietUntil: number;
  tail: Promise<void>;
  unsubscribe: Array<() => void>;
};

type ProtectedElementMetadata = {
  connected: boolean;
  visible: boolean;
  editable: boolean;
  disabled: boolean;
  readOnly: boolean;
  tag: string;
  inputType: string;
  origin: string;
  hasForm: boolean;
  formAction: string | null;
  formMethod: string | null;
  submitType: string | null;
};

type ResolvedProtectedField = {
  backendDOMNodeId: number;
  purpose: BrowserProtectedAuthFillCommandValue["fields"][number]["purpose"];
  value: string;
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
  tabControl?: boolean;
  frameStreaming?: boolean;
  emulation?: BrowserSessionEmulation;
  permissionControl?: boolean;
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
 * lifecycle; OpenGeni talks to that private browser through one local CDP
 * connection and keeps an independent causal queue for every target.
 */
export class AgentBrowserDriver implements BrowserInteractionDriver {
  private readonly browserSessionId: string;
  private readonly controllerGeneration: string;
  private readonly runner: BrowserCommandRunner;
  private readonly now: () => Date;
  private readonly createId: () => string;
  /** Private physical-process fence. Provider target/loader ids are not
   * required to be globally unique and may repeat after crash recovery. */
  private physicalGeneration: string;
  private readonly engine: "chromium" | "chrome" | "lightpanda";
  private readonly targetLifecycle: "runner" | "cdp";
  private readonly tabControl: boolean;
  private readonly frameStreaming: boolean;
  private readonly emulation: BrowserSessionEmulation | null;
  private readonly permissionControl: boolean;
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

  constructor(options: AgentBrowserDriverOptions) {
    this.browserSessionId = options.browserSessionId;
    this.controllerGeneration = options.controllerGeneration;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.physicalGeneration = randomUUID();
    this.engine = options.engine ?? "chromium";
    this.targetLifecycle = options.targetLifecycle ?? "runner";
    this.tabControl = options.tabControl ?? true;
    this.frameStreaming = options.frameStreaming ?? true;
    this.emulation = hasBrowserEmulation(options.emulation) ? options.emulation : null;
    this.permissionControl = options.permissionControl ?? true;
    this.resolveWorkspaceFiles = options.resolveWorkspaceFiles;
    this.downloadDirectory = options.downloadDirectory
      ? resolvePath(options.downloadDirectory)
      : null;
    this.downloadEvents = options.downloadEvents;
    this.connect = options.connect ?? (async (endpoint) => await CdpConnection.connect(endpoint));
  }

  async start(url?: string): Promise<BrowserObservationValue> {
    const deferNavigation = this.emulation !== null && url !== undefined && url !== "about:blank";
    const launchUrl = this.emulation !== null ? "about:blank" : url;
    this.started = true;
    let connection: BrowserCdpConnection;
    let launched: { url?: unknown; targetId?: unknown };
    if (this.targetLifecycle === "cdp") {
      connection = await this.ensureConnection();
      const created = await connection.send<{ targetId?: unknown }>(
        "Target.createTarget",
        { url: launchUrl ?? "about:blank" },
        { timeoutMs: BROWSER_START_TIMEOUT_MS },
      );
      launched = { targetId: created.targetId, url: launchUrl ?? "about:blank" };
    } else {
      launched = await this.runner.run<{
        url?: unknown;
        targetId?: unknown;
      }>(launchUrl === undefined ? ["open"] : ["open", launchUrl], {
        timeoutMs: BROWSER_START_TIMEOUT_MS,
      });
      connection = await this.ensureConnection();
    }
    const targets = await this.targetInfos(connection);
    const launchedUrl = typeof launched.url === "string" ? launched.url : url;
    const launchedTargetId = typeof launched.targetId === "string" ? launched.targetId : undefined;
    const target =
      targets.find(
        (candidate) => candidate.type === "page" && candidate.targetId === launchedTargetId,
      ) ??
      targets.find((candidate) => candidate.type === "page" && candidate.url === launchedUrl) ??
      visiblePageTargets(targets)[0];
    if (!target) throw new Error("managed browser launched without a page target");
    await connection.send("Target.activateTarget", {
      targetId: target.targetId,
    });
    this.selectedTargetId = target.targetId;
    if (deferNavigation) {
      await this.navigate(await this.ensureTargetState(target), url);
    }
    return await this.observe(target.targetId);
  }

  /** Bounded liveness probe for the supervisor's recovery path. It never
   * starts or repairs the browser, preserving one recovery authority. */
  async isAvailable(): Promise<boolean> {
    if (!this.started || !this.connection) return false;
    try {
      await this.connection.send("Browser.getVersion", {}, { timeoutMs: 2_000 });
      return true;
    } catch {
      return false;
    }
  }

  async listTargets(): Promise<BrowserTargetValue[]> {
    const connection = await this.ensureConnection();
    const infos = visibleTargets(await this.targetInfos(connection));
    return infos.map((info) => {
      const state = this.states.get(info.targetId);
      return this.targetFromInfo(info, state ?? null);
    });
  }

  async openTarget(url = "about:blank"): Promise<BrowserObservationValue> {
    if (!this.tabControl) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine does not support multiple tabs",
      );
    }
    const connection = await this.ensureConnection();
    const deferNavigation = this.emulation !== null && url !== "about:blank";
    const result = await connection.send<{ targetId?: unknown }>("Target.createTarget", {
      url: deferNavigation ? "about:blank" : url,
    });
    if (typeof result.targetId !== "string") throw new Error("CDP did not return a target id");
    await connection.send("Target.activateTarget", {
      targetId: result.targetId,
    });
    this.selectedTargetId = result.targetId;
    if (deferNavigation) {
      const info = await this.requireTargetInfo(connection, result.targetId);
      await this.navigate(await this.ensureTargetState(info), url);
    }
    return await this.observe(result.targetId);
  }

  async selectTarget(targetId: string): Promise<BrowserObservationValue> {
    const connection = await this.ensureConnection();
    await this.requireTargetInfo(connection, targetId);
    await connection.send("Target.activateTarget", { targetId });
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
    await connection.send("Target.closeTarget", { targetId });
    this.removeState(targetId);
    if (this.selectedTargetId === targetId) this.selectedTargetId = null;
    return await this.listTargets();
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.browserUnsubscribe.splice(0)) unsubscribe();
    for (const targetId of [...this.states.keys()]) this.removeState(targetId);
    this.firstSeenAt.clear();
    const connection = this.connection;
    this.connection = null;
    this.connectionPromise = null;
    let closeError: unknown = null;
    let terminationError: unknown = null;
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
      await this.runner.terminate?.();
    } catch (error) {
      terminationError = error;
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

  async runtimeSnapshot(): Promise<BrowserRuntimeSnapshot> {
    const targets = await this.listTargets();
    const tabs = targets
      .filter((target) => target.kind === "page" || target.kind === "popup")
      .map((target) => ({ url: target.url, selected: target.selected }));
    const separator = this.browserProduct.indexOf("/");
    const rawVersion = separator >= 0 ? this.browserProduct.slice(separator + 1) : "";
    const engineVersion =
      rawVersion.length > 0 && Buffer.byteLength(rawVersion) <= 256 ? rawVersion : null;
    return { engine: this.engine, engineVersion, tabs };
  }

  async target(targetId: string): Promise<BrowserTargetValue | null> {
    const connection = await this.ensureConnection();
    const info = (await this.targetInfos(connection)).find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!info || !isVisibleTarget(info)) return null;
    const state = await this.ensureTargetState(info);
    await this.refreshFrame(state);
    return this.targetFromInfo(info, state);
  }

  async observe(targetId: string): Promise<BrowserObservationValue> {
    return await this.withTarget(
      targetId,
      async (state, info) => await this.observeUnlocked(state, info),
    );
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
    const normalized = normalizeScreenshotOptions(options);
    return await this.withTarget(targetId, async (state) => {
      await this.refreshFrame(state);
      const metrics = await this.layoutMetrics(state);
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
      const response = await this.sendTarget<{ data?: unknown }>(
        state,
        "Page.captureScreenshot",
        capture,
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
    if (!this.frameStreaming) {
      throw new InteractionDefiniteDriverError(
        "unsupported",
        "this browser engine does not support live frame streaming",
      );
    }
    const normalized = normalizeFrameStreamOptions(options);
    return await this.withTarget(targetId, async (state) => {
      let screencast = state.screencast;
      if (screencast && !sameFrameOptions(screencast.options, normalized)) {
        throw new Error("browser target already has a differently configured frame stream");
      }
      if (!screencast) {
        const connection = await this.ensureConnection();
        const unsubscribe = connection.on(
          "Page.screencastFrame",
          (event) => this.acceptScreencastFrame(state, event),
          state.sessionId,
        );
        screencast = {
          options: normalized,
          sequence: 0,
          subscriptions: new Map(),
          unsubscribe,
        };
        state.screencast = screencast;
        try {
          await this.sendTarget(state, "Page.startScreencast", {
            format: normalized.format,
            ...(normalized.format === "jpeg" ? { quality: normalized.quality } : {}),
            maxWidth: normalized.maxWidth,
            maxHeight: normalized.maxHeight,
            everyNthFrame: normalized.everyNthFrame,
          });
        } catch (error) {
          unsubscribe();
          state.screencast = null;
          throw error;
        }
      }
      if (screencast.subscriptions.size >= 32) {
        throw new Error("browser target frame-subscriber bound was reached");
      }
      const subscriptionId = this.createId();
      const subscription = new LatestBrowserFrameSubscription(
        async () => await this.releaseFrameSubscription(targetId, subscriptionId),
      );
      screencast.subscriptions.set(subscriptionId, subscription);
      return subscription;
    });
  }

  async dispatch(commandInput: BrowserActionCommandValue): Promise<BrowserObservationValue> {
    const command = BrowserActionCommand.parse(commandInput);
    return await this.withTarget(command.targetId, async (state, info) => {
      if (!state.dialog) await this.refreshFrame(state);
      this.assertExpectedGenerations(command, state);
      const actions = command.action.type === "batch" ? command.action.actions : [command.action];
      if (state.dialog && actions[0]?.type !== "handle_dialog") {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser JavaScript dialog must be handled before another action",
        );
      }
      let completedActions = 0;
      for (const action of actions) {
        try {
          await this.dispatchAction(state, action, command.operationId);
          completedActions += 1;
          if (state.dialog) {
            if (completedActions < actions.length) {
              throw new Error("browser action batch paused on a JavaScript dialog");
            }
            break;
          }
        } catch (error) {
          if (error instanceof DialogOpenedSignal) {
            completedActions += 1;
            if (completedActions < actions.length) {
              throw new Error("browser action batch paused on a JavaScript dialog", {
                cause: error,
              });
            }
            break;
          }
          if (error instanceof InteractionDefiniteDriverError && completedActions === 0)
            throw error;
          throw error instanceof InteractionDefiniteDriverError
            ? new Error("browser action batch had a partial outcome", {
                cause: error,
              })
            : error;
        }
      }
      const currentInfo = await this.requireTargetInfo(
        await this.ensureConnection(),
        info.targetId,
      );
      return await this.observeUnlocked(state, currentInfo);
    });
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

  /** Controller-private credential injection. This path returns no semantic
   * tree and suppresses screenshots/diagnostics while values exist in-page. */
  async protectedFill(
    commandInput: BrowserProtectedAuthFillCommandValue,
  ): Promise<BrowserProtectedAuthObservationValue> {
    const command = BrowserProtectedAuthFillCommand.parse(commandInput);
    return await this.withTarget(command.targetId, async (state, info) => {
      if (state.dialog) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser JavaScript dialog must be handled before protected fill",
        );
      }
      await this.refreshFrame(state);
      this.assertProtectedAuthGenerations(command, state);
      state.protectedAuthActive = true;
      const startingDocumentGeneration = state.documentGeneration;
      const startingNetworkActivitySequence = state.networkActivitySequence;
      const allowedOrigins = new Set(command.allowedOrigins);
      const resolvedFields: ResolvedProtectedField[] = [];
      let submitNodeId: number | null = null;
      let submitted = false;
      try {
        for (const field of command.fields) {
          const node = await this.resolveLocator(state, field.locator);
          if (node.backendDOMNodeId === null) {
            throw new InteractionDefiniteDriverError(
              "invalid_action",
              "protected-fill field has no DOM action target",
            );
          }
          const metadata = await this.protectedElementMetadata(state, node.backendDOMNodeId);
          this.assertProtectedField(metadata, field.purpose, allowedOrigins);
          resolvedFields.push({
            backendDOMNodeId: node.backendDOMNodeId,
            purpose: field.purpose,
            value: field.value,
          });
        }
        if (command.submit.type === "click") {
          const node = await this.resolveLocator(state, command.submit.locator);
          if (node.backendDOMNodeId === null) {
            throw new InteractionDefiniteDriverError(
              "invalid_action",
              "protected-fill submit control has no DOM action target",
            );
          }
          const metadata = await this.protectedElementMetadata(state, node.backendDOMNodeId);
          this.assertProtectedSubmit(metadata, allowedOrigins);
          submitNodeId = node.backendDOMNodeId;
        } else if (command.submit.type === "press" && command.submit.locator) {
          const node = await this.resolveLocator(state, command.submit.locator);
          if (node.backendDOMNodeId === null) {
            throw new InteractionDefiniteDriverError(
              "invalid_action",
              "protected-fill key target has no DOM action target",
            );
          }
          const metadata = await this.protectedElementMetadata(state, node.backendDOMNodeId);
          this.assertProtectedSubmit(metadata, allowedOrigins);
          submitNodeId = node.backendDOMNodeId;
        }

        // Locator resolution refreshes browser state. Recheck every causal
        // fence once more immediately before the first value crosses CDP.
        await this.refreshFrame(state);
        this.assertProtectedAuthGenerations(command, state);
        for (const field of resolvedFields) {
          await this.focusNode(state, field.backendDOMNodeId);
          await this.selectAllAndDelete(state);
          await this.sendActionTarget(state, "Input.insertText", {
            text: field.value,
          });
        }

        if (command.submit.type === "click") {
          await this.clickNode(state, submitNodeId, "left", 1);
          submitted = true;
        } else if (command.submit.type === "press") {
          await this.focusNode(
            state,
            submitNodeId ?? resolvedFields.at(-1)?.backendDOMNodeId ?? null,
          );
          await this.pressKey(state, command.submit.key);
          submitted = true;
        }

        const transitioned = await this.waitForProtectedAuthTransition(
          state,
          startingDocumentGeneration,
          startingNetworkActivitySequence,
        );
        if (!submitted && !transitioned) {
          await this.clearProtectedFields(state, resolvedFields);
          throw new Error("protected fill without submit did not produce an observable transition");
        }
        if (!transitioned && state.documentGeneration === startingDocumentGeneration) {
          await this.clearProtectedFields(state, resolvedFields);
        }
        const currentInfo = await this.requireTargetInfo(
          await this.ensureConnection(),
          info.targetId,
        );
        await this.refreshFrame(state);
        return {
          target: this.targetFromInfo(currentInfo, state),
          status: submitted || transitioned ? "submitted" : "working",
        };
      } catch (error) {
        await this.clearProtectedFields(state, resolvedFields).catch(() => undefined);
        throw error;
      } finally {
        state.protectedAuthActive = false;
        state.protectedAuthQuietUntil = Date.now() + PROTECTED_AUTH_DIAGNOSTIC_QUIET_MS;
      }
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
      const version = await connection.send<{
        product?: unknown;
        userAgent?: unknown;
      }>("Browser.getVersion");
      this.browserProduct = typeof version.product === "string" ? version.product : "";
      this.userAgent = typeof version.userAgent === "string" ? version.userAgent : "";
      if (this.downloadDirectory) {
        await connection.send("Browser.setDownloadBehavior", {
          behavior: "allowAndName",
          downloadPath: this.downloadDirectory,
          eventsEnabled: true,
        });
      }
      if (this.emulation?.geolocation) {
        await connection.send("Browser.grantPermissions", {
          permissions: ["geolocation"],
        });
      }
      await connection.send("Target.setDiscoverTargets", { discover: true });
      this.browserUnsubscribe.push(
        connection.on("Target.targetDestroyed", (event) => {
          if (typeof event.params.targetId === "string") this.removeState(event.params.targetId);
        }),
        connection.on("Browser.downloadWillBegin", (event) => {
          const frameId = typeof event.params.frameId === "string" ? event.params.frameId : null;
          const state = [...this.states.values()].find(
            (candidate) => candidate.frame.id === frameId,
          );
          if (this.downloadEvents) {
            const guid = typeof event.params.guid === "string" ? event.params.guid : "";
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
          if (state && !this.protectedAuthQuiet(state)) {
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
              if (!cancelReason) return;
              await connection.send("Browser.cancelDownload", { guid }).catch(() => undefined);
              await this.downloadEvents?.reject(guid, cancelReason);
            })
            .catch(() => undefined);
        }),
      );
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

  private async reconnectAfterProviderReconfiguration(): Promise<void> {
    for (const unsubscribe of this.browserUnsubscribe.splice(0)) unsubscribe();
    for (const targetId of [...this.states.keys()]) this.removeState(targetId);
    this.firstSeenAt.clear();
    this.attaching.clear();
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
        url: "about:blank",
      });
      if (typeof created.targetId !== "string") {
        throw new Error("reconfigured browser did not return a target id");
      }
      targets = visiblePageTargets(await this.targetInfos(connection));
    }
    const selected = targets[0];
    if (!selected) throw new Error("reconfigured browser has no page target");
    await connection.send("Target.activateTarget", { targetId: selected.targetId });
    this.selectedTargetId = selected.targetId;
  }

  private async withTarget<T>(
    targetId: string,
    operation: (state: TargetState, info: TargetInfo) => Promise<T>,
  ): Promise<T> {
    const connection = await this.ensureConnection();
    const info = await this.requireTargetInfo(connection, targetId);
    const state = await this.ensureTargetState(info);
    const result = state.tail.then(async () => await operation(state, info));
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
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
    const attached = await connection.send<{ sessionId?: unknown }>("Target.attachToTarget", {
      targetId: info.targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== "string") throw new Error("CDP did not attach the target");
    const sessionId = attached.sessionId;
    await Promise.all([
      connection.send("Page.enable", {}, { sessionId }),
      connection.send("Runtime.enable", {}, { sessionId }),
      connection.send("DOM.enable", {}, { sessionId }),
      connection.send("Accessibility.enable", {}, { sessionId }),
      connection.send("Network.enable", {}, { sessionId }),
      connection.send("Log.enable", {}, { sessionId }),
    ]);
    await this.applyEmulation(connection, sessionId);
    const frame = await this.mainFrame(sessionId);
    const state: TargetState = {
      targetId: info.targetId,
      sessionId,
      createdAt: this.firstSeen(info.targetId),
      frame,
      documentGeneration: documentGeneration(
        this.controllerGeneration,
        this.physicalGeneration,
        info.targetId,
        frame.loaderId,
      ),
      frameGeneration: frameGeneration(
        this.controllerGeneration,
        this.physicalGeneration,
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
      screencast: null,
      protectedAuthActive: false,
      protectedAuthQuietUntil: 0,
      tail: Promise.resolve(),
      unsubscribe: [],
    };
    state.unsubscribe.push(
      connection.on(
        "Page.frameNavigated",
        (event) => this.onFrameNavigated(state, event),
        sessionId,
      ),
      connection.on(
        "Runtime.consoleAPICalled",
        (event) => {
          if (this.protectedAuthQuiet(state)) return;
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
          if (this.protectedAuthQuiet(state)) return;
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
            if (!this.protectedAuthQuiet(state)) {
              state.requests.set(requestId, {
                method: boundedMethod(request.method),
                url: boundedUrlField(request.url) ?? "about:blank",
              });
              boundMap(state.requests, 10_000);
            }
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
          if (
            !this.protectedAuthQuiet(state) &&
            requestId &&
            typeof response?.status === "number" &&
            response.status >= 400
          ) {
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
    return state;
  }

  private async applyEmulation(connection: BrowserCdpConnection, sessionId: string): Promise<void> {
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
      await this.navigateForUserAgentMetadata(connection, attached.sessionId, "chrome://version/");
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

  private async navigateForUserAgentMetadata(
    connection: BrowserCdpConnection,
    sessionId: string,
    url: string,
  ): Promise<void> {
    const loaded = connection.waitForEvent("Page.loadEventFired", {
      sessionId,
      timeoutMs: 5_000,
    });
    let navigation: { errorText?: unknown };
    try {
      navigation = await connection.send("Page.navigate", { url }, { sessionId });
    } catch (error) {
      await loaded.catch(() => undefined);
      throw error;
    }
    if (typeof navigation.errorText === "string" && navigation.errorText) {
      await loaded.catch(() => undefined);
      throw new Error(`browser metadata navigation failed: ${navigation.errorText}`);
    }
    await loaded;
  }

  private async observeUnlocked(
    state: TargetState,
    info: TargetInfo,
  ): Promise<BrowserObservationValue> {
    if (!state.dialog) await this.refreshFrame(state);
    const accessibility =
      state.dialog && state.accessibility
        ? state.accessibility
        : state.dialog
          ? emptyAccessibilitySnapshot()
          : await this.refreshAccessibility(state);
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
      focusedRef: accessibility.focusedRef,
      changedRegions: [],
      diagnostics: state.diagnostics,
      dialog: state.dialog,
      observedAt: this.timestamp(),
    });
  }

  private async refreshAccessibility(state: TargetState): Promise<CdpAccessibilitySnapshot> {
    for (let attempt = 0; attempt < ACCESSIBILITY_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const before = flattenFrameTree(await this.frameTree(state.sessionId));
      const nodes = await this.collectAccessibilityFrames(state.sessionId, before);
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

  private async refreshFrame(state: TargetState): Promise<void> {
    const frame = await this.mainFrame(state.sessionId);
    if (frame.loaderId !== state.frame.loaderId || frame.id !== state.frame.id) {
      state.frame = frame;
      state.documentGeneration = documentGeneration(
        this.controllerGeneration,
        this.physicalGeneration,
        state.targetId,
        frame.loaderId,
      );
      state.frameGeneration = frameGeneration(
        this.controllerGeneration,
        this.physicalGeneration,
        state.targetId,
        frame.id,
      );
      state.accessibility = null;
    } else {
      state.frame = frame;
    }
  }

  private async mainFrame(sessionId: string): Promise<MainFrame> {
    return (await this.frameTree(sessionId)).frame;
  }

  private async frameTree(sessionId: string): Promise<PageFrameTree> {
    const connection = await this.ensureConnection();
    const response = await connection.send<{ frameTree?: unknown }>(
      "Page.getFrameTree",
      {},
      { sessionId },
    );
    if (!isRecord(response.frameTree) || !isRecord(response.frameTree.frame)) {
      throw new Error("CDP returned an invalid frame tree");
    }
    return parseFrameTree(response.frameTree);
  }

  private async layoutMetrics(state: TargetState): Promise<{
    viewport: { x: number; y: number; width: number; height: number };
    content: { width: number; height: number };
  }> {
    const response = await this.sendTarget<{
      cssVisualViewport?: unknown;
      cssContentSize?: unknown;
    }>(state, "Page.getLayoutMetrics");
    const viewport = dimensionsRecord(response.cssVisualViewport, true);
    const content = dimensionsRecord(response.cssContentSize, false);
    return { viewport, content };
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

  private acceptScreencastFrame(state: TargetState, event: CdpEvent): void {
    const screencast = state.screencast;
    if (!screencast) return;
    const acknowledgementId = finitePositiveNumber(event.params.sessionId);
    if (acknowledgementId !== null) {
      void this.sendTarget(state, "Page.screencastFrameAck", {
        sessionId: acknowledgementId,
      }).catch((error: unknown) => {
        this.failScreencast(state, transportError(error));
      });
    }
    if (state.protectedAuthActive) return;
    try {
      const metadata = isRecord(event.params.metadata) ? event.params.metadata : {};
      const data = decodeBoundedBase64Image(event.params.data);
      const sourceWidth = boundedImageDimension(metadata.deviceWidth);
      boundedImageDimension(metadata.deviceHeight);
      const dimensions = imageDimensions(data, screencast.options.format);
      const frame = this.imageFrame({
        state,
        sequence: ++screencast.sequence,
        format: screencast.options.format,
        data,
        width: dimensions.width,
        height: dimensions.height,
        // CDP reports the source screen in DIP and pageScaleFactor maps CSS to
        // DIP; maxWidth/maxHeight may then downscale the encoded pixels.
        deviceScaleFactor: finiteScale(
          (dimensions.width / sourceWidth) * (numberField(metadata, "pageScaleFactor") ?? 1),
        ),
        scrollX: numberField(metadata, "scrollOffsetX") ?? 0,
        scrollY: numberField(metadata, "scrollOffsetY") ?? 0,
      });
      for (const subscription of screencast.subscriptions.values()) subscription.push(frame);
    } catch (error) {
      this.failScreencast(state, transportError(error));
    }
  }

  private async releaseFrameSubscription(targetId: string, subscriptionId: string): Promise<void> {
    const state = this.states.get(targetId);
    if (!state) return;
    const release = state.tail.then(async () => {
      const screencast = state.screencast;
      if (!screencast) return;
      screencast.subscriptions.delete(subscriptionId);
      if (screencast.subscriptions.size > 0) return;
      screencast.unsubscribe();
      state.screencast = null;
      await this.sendTarget(state, "Page.stopScreencast");
    });
    state.tail = release.then(
      () => undefined,
      () => undefined,
    );
    await release;
  }

  private failScreencast(state: TargetState, error: Error): void {
    const screencast = state.screencast;
    if (!screencast) return;
    state.screencast = null;
    screencast.unsubscribe();
    for (const subscription of screencast.subscriptions.values()) subscription.fail(error);
    screencast.subscriptions.clear();
  }

  private assertProtectedAuthGenerations(
    command: BrowserProtectedAuthFillCommandValue,
    state: TargetState,
  ): void {
    if (command.browserSessionId !== this.browserSessionId) {
      throw new InteractionDefiniteDriverError(
        "resource_not_found",
        "protected fill targets another browser session",
      );
    }
    if (command.controllerGeneration !== this.controllerGeneration) {
      throw new InteractionDefiniteDriverError(
        "controller_stale",
        "protected fill targets an earlier browser controller",
      );
    }
    if (command.expectedTargetGeneration !== this.targetGeneration(state.targetId)) {
      throw new InteractionDefiniteDriverError(
        "target_stale",
        "protected fill targets an earlier browser target",
      );
    }
    if (command.expectedDocumentGeneration !== state.documentGeneration) {
      throw new InteractionDefiniteDriverError(
        "document_stale",
        "protected fill targets an earlier browser document",
      );
    }
    if (command.expectedFrameId !== state.frameGeneration) {
      throw new InteractionDefiniteDriverError(
        "frame_stale",
        "protected fill targets an earlier browser frame",
      );
    }
  }

  private async protectedElementMetadata(
    state: TargetState,
    backendDOMNodeId: number,
  ): Promise<ProtectedElementMetadata> {
    const value = await this.callOnNode(
      state,
      backendDOMNodeId,
      PROTECTED_ELEMENT_METADATA_FUNCTION,
      [],
    );
    if (!isRecord(value)) throw new Error("browser returned invalid protected-field metadata");
    const metadata: ProtectedElementMetadata = {
      connected: value.connected === true,
      visible: value.visible === true,
      editable: value.editable === true,
      disabled: value.disabled === true,
      readOnly: value.readOnly === true,
      tag: typeof value.tag === "string" ? value.tag : "",
      inputType: typeof value.inputType === "string" ? value.inputType : "",
      origin: typeof value.origin === "string" ? value.origin : "",
      hasForm: value.hasForm === true,
      formAction: typeof value.formAction === "string" ? value.formAction : null,
      formMethod: typeof value.formMethod === "string" ? value.formMethod : null,
      submitType: typeof value.submitType === "string" ? value.submitType : null,
    };
    if (
      metadata.tag.length === 0 ||
      metadata.origin.length === 0 ||
      Buffer.byteLength(metadata.origin) > 16_384 ||
      (metadata.formAction !== null && Buffer.byteLength(metadata.formAction) > 16_384)
    ) {
      throw new Error("browser returned invalid protected-field metadata");
    }
    return metadata;
  }

  private assertProtectedField(
    metadata: ProtectedElementMetadata,
    purpose: ResolvedProtectedField["purpose"],
    allowedOrigins: ReadonlySet<string>,
  ): void {
    this.assertProtectedElement(metadata, allowedOrigins);
    if (!metadata.editable || metadata.disabled || metadata.readOnly) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "protected-fill field is not editable",
      );
    }
    const ordinaryInputTypes = new Set(["email", "number", "search", "tel", "text", "url"]);
    const acceptsOrdinaryText =
      metadata.tag === "textarea" ||
      metadata.inputType === "contenteditable" ||
      ordinaryInputTypes.has(metadata.inputType);
    if (purpose === "password" && metadata.inputType !== "password") {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "password authority requires a password field",
      );
    }
    if (purpose === "identifier" && !acceptsOrdinaryText) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "identifier authority requires a visible text field",
      );
    }
    if (
      (purpose === "secret" || purpose === "totp") &&
      metadata.inputType !== "password" &&
      !acceptsOrdinaryText
    ) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "secret authority requires a visible text or password field",
      );
    }
    if (purpose !== "identifier" && metadata.hasForm && metadata.formMethod === "get") {
      throw new InteractionDefiniteDriverError(
        "permission_denied",
        "protected secrets cannot be submitted through a GET form",
      );
    }
  }

  private assertProtectedSubmit(
    metadata: ProtectedElementMetadata,
    allowedOrigins: ReadonlySet<string>,
  ): void {
    this.assertProtectedElement(metadata, allowedOrigins);
    if (metadata.disabled) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "protected-fill submit target is disabled",
      );
    }
    if (metadata.hasForm && metadata.formMethod === "get" && metadata.submitType !== "button") {
      throw new InteractionDefiniteDriverError(
        "permission_denied",
        "protected secrets cannot be submitted through a GET form",
      );
    }
  }

  private assertProtectedElement(
    metadata: ProtectedElementMetadata,
    allowedOrigins: ReadonlySet<string>,
  ): void {
    if (!metadata.connected || !metadata.visible) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "protected-fill target is not visible and connected",
      );
    }
    if (!allowedOrigins.has(metadata.origin)) {
      throw new InteractionDefiniteDriverError(
        "permission_denied",
        "protected-fill target frame origin is not authorized",
      );
    }
    if (metadata.formAction !== null) {
      let actionOrigin: string;
      try {
        actionOrigin = new URL(metadata.formAction).origin;
      } catch {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "protected-fill form action is invalid",
        );
      }
      if (!allowedOrigins.has(actionOrigin)) {
        throw new InteractionDefiniteDriverError(
          "permission_denied",
          "protected-fill form action origin is not authorized",
        );
      }
    }
  }

  private async waitForProtectedAuthTransition(
    state: TargetState,
    startingDocumentGeneration: string,
    startingNetworkActivitySequence: number,
  ): Promise<boolean> {
    const deadline = Date.now() + PROTECTED_AUTH_AUTO_ADVANCE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.refreshFrame(state);
      if (state.documentGeneration !== startingDocumentGeneration) return true;
      if (
        state.networkActivitySequence > startingNetworkActivitySequence &&
        state.inflightRequests.size === 0 &&
        Date.now() - state.lastNetworkActivityAt >= NETWORK_IDLE_MS
      ) {
        return true;
      }
      await delay(50);
    }
    return false;
  }

  private async clearProtectedFields(
    state: TargetState,
    fields: readonly ResolvedProtectedField[],
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const field of fields) {
      try {
        await this.callOnNode(state, field.backendDOMNodeId, CLEAR_PROTECTED_VALUE_FUNCTION, []);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "protected fields could not be cleared safely");
    }
  }

  private async dispatchAction(
    state: TargetState,
    action: BrowserAction,
    operationId: string,
  ): Promise<void> {
    switch (action.type) {
      case "navigate":
        await this.navigate(state, action.url);
        return;
      case "click": {
        const node = await this.resolveLocator(state, action.locator);
        await this.clickNode(state, node.backendDOMNodeId, action.button ?? "left", 1);
        return;
      }
      case "double_click": {
        const node = await this.resolveLocator(state, action.locator);
        await this.clickNode(state, node.backendDOMNodeId, "left", 2);
        return;
      }
      case "hover": {
        const node = await this.resolveLocator(state, action.locator);
        const point = await this.actionPoint(state, node.backendDOMNodeId, true);
        await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
        });
        return;
      }
      case "fill": {
        const node = await this.resolveLocator(state, action.locator);
        await this.focusNode(state, node.backendDOMNodeId);
        await this.selectAllAndDelete(state);
        if (action.value)
          await this.sendActionTarget(state, "Input.insertText", {
            text: action.value,
          });
        return;
      }
      case "type":
        if (action.locator) {
          const node = await this.resolveLocator(state, action.locator);
          await this.focusNode(state, node.backendDOMNodeId);
        }
        if (action.text)
          await this.sendActionTarget(state, "Input.insertText", {
            text: action.text,
          });
        return;
      case "press":
        if (action.locator) {
          const node = await this.resolveLocator(state, action.locator);
          await this.focusNode(state, node.backendDOMNodeId);
        }
        await this.pressKey(state, action.key);
        return;
      case "select": {
        const node = await this.resolveLocator(state, action.locator);
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
        return;
      }
      case "check": {
        const node = await this.resolveLocator(state, action.locator);
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
      case "scroll":
        if (action.locator) {
          const node = await this.resolveLocator(state, action.locator);
          await this.callOnNode(state, node.backendDOMNodeId, SCROLL_FUNCTION, [
            { value: action.deltaX },
            { value: action.deltaY },
          ]);
        } else {
          await this.evaluateAction(
            state,
            `window.scrollBy(${json(action.deltaX)}, ${json(action.deltaY)})`,
          );
        }
        return;
      case "drag": {
        const from = await this.resolveLocator(state, action.from);
        const to = await this.resolveLocator(state, action.to);
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
        await this.sendTarget(state, "Page.handleJavaScriptDialog", {
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
        const node = await this.resolveLocator(state, action.locator);
        await this.sendActionTarget(state, "DOM.setFileInputFiles", {
          files: [...paths],
          backendNodeId: node.backendDOMNodeId,
        });
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
      const node = await this.resolveLocator(state, action.locator);
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
      const node = await this.resolveLocator(state, locator);
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

  private async resolveLocator(
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
  ): Promise<void> {
    const point = await this.actionPoint(state, backendDOMNodeId, true);
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
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

  private async actionPoint(
    state: TargetState,
    backendDOMNodeId: number | null,
    requireHit: boolean,
  ): Promise<{ x: number; y: number }> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser node cannot receive pointer input",
      );
    }
    await this.sendActionTarget(state, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: backendDOMNodeId,
    });
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
    const point = {
      x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
      y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
    };
    if (requireHit) {
      const hit = await this.callOnNode(state, backendDOMNodeId, HIT_TEST_FUNCTION, []);
      if (hit !== true) {
        throw new InteractionDefiniteDriverError(
          "invalid_action",
          "browser element is covered or not pointer-actionable",
          true,
        );
      }
    }
    return point;
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
    await this.sendActionTarget(state, "DOM.focus", {
      backendNodeId: backendDOMNodeId,
    });
  }

  private async selectAllAndDelete(state: TargetState): Promise<void> {
    const meta = /Macintosh|Mac OS/u.test(this.userAgent);
    const modifiers = meta ? 4 : 2;
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers,
      windowsVirtualKeyCode: 65,
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

  private async pressKey(state: TargetState, input: string): Promise<void> {
    const key = parseKey(input, /Macintosh|Mac OS/u.test(this.userAgent));
    await this.sendActionTarget(state, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: key.key,
      code: key.code,
      modifiers: key.modifiers,
      windowsVirtualKeyCode: key.keyCode,
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
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
    const to = await this.actionPoint(state, toBackendNodeId, false);
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x,
      y: from.y,
    });
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= 10; step += 1) {
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + ((to.x - from.x) * step) / 10,
        y: from.y + ((to.y - from.y) * step) / 10,
        button: "left",
        buttons: 1,
      });
    }
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
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
        await this.clickPoint(state, start, button, action.action === "click" ? 1 : 2);
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
  ): Promise<void> {
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
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
    to: { x: number; y: number },
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
    for (let step = 1; step <= 10; step += 1) {
      await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + ((to.x - from.x) * step) / 10,
        y: from.y + ((to.y - from.y) * step) / 10,
        button,
        buttons: mouseButtonMask(button),
      });
    }
    await this.sendActionTarget(state, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button,
      buttons: 0,
      clickCount: 1,
    });
  }

  private async navigate(state: TargetState, url: string): Promise<void> {
    const result = await this.sendActionTarget<{ errorText?: unknown }>(state, "Page.navigate", {
      url,
    });
    if (typeof result.errorText === "string" && result.errorText) {
      throw new InteractionDefiniteDriverError(
        "resource_unavailable",
        "browser could not navigate to the requested URL",
        true,
      );
    }
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
  ): Promise<unknown> {
    if (backendDOMNodeId === null) {
      throw new InteractionDefiniteDriverError(
        "invalid_action",
        "browser node has no DOM action target",
      );
    }
    const resolved = await this.sendTarget<{ object?: unknown }>(state, "DOM.resolveNode", {
      backendNodeId: backendDOMNodeId,
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
      }>(state, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration,
        arguments: args.map((argument) =>
          argument.objectId ? { objectId: argument.objectId } : { value: argument.value },
        ),
        returnByValue: true,
        awaitPromise: true,
      });
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
  ): Promise<T> {
    const connection = await this.ensureConnection();
    return await connection.send<T>(method, params, {
      sessionId: state.sessionId,
    });
  }

  private async sendActionTarget<T = Record<string, unknown>>(
    state: TargetState,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    const connection = await this.ensureConnection();
    let unsubscribe: () => void = () => undefined;
    const dialog = new Promise<{ kind: "dialog" }>((resolve) => {
      unsubscribe = connection.on(
        "Page.javascriptDialogOpening",
        () => resolve({ kind: "dialog" }),
        state.sessionId,
      );
    });
    const command = connection.send<T>(method, params, {
      sessionId: state.sessionId,
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
      url: state?.frame.url ?? info.url,
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
      this.physicalGeneration,
      targetId,
    );
  }

  private async targetInfos(connection: BrowserCdpConnection): Promise<TargetInfo[]> {
    const response = await connection.send<{ targetInfos?: unknown }>("Target.getTargets");
    if (!Array.isArray(response.targetInfos))
      throw new Error("CDP returned an invalid target list");
    return response.targetInfos.map(normalizeTargetInfo);
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
      this.physicalGeneration,
      state.targetId,
      frame.loaderId,
    );
    state.frameGeneration = frameGeneration(
      this.controllerGeneration,
      this.physicalGeneration,
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
    if (this.protectedAuthQuiet(state)) return;
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
    if (this.protectedAuthQuiet(state)) return;
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

  private removeState(targetId: string): void {
    const state = this.states.get(targetId);
    if (!state) return;
    this.failScreencast(state, new CdpTransportError("browser target closed"));
    for (const unsubscribe of state.unsubscribe) unsubscribe();
    this.states.delete(targetId);
    this.firstSeenAt.delete(targetId);
  }

  private protectedAuthQuiet(state: TargetState): boolean {
    return state.protectedAuthActive || Date.now() < state.protectedAuthQuietUntil;
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

function normalizeTargetInfo(value: unknown): TargetInfo {
  if (!isRecord(value) || typeof value.targetId !== "string" || typeof value.type !== "string") {
    throw new Error("CDP returned an invalid target");
  }
  return {
    targetId: value.targetId,
    type: value.type,
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : "about:blank",
    attached: value.attached === true,
    openerId: typeof value.openerId === "string" ? value.openerId : null,
  };
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

function parseKey(
  input: string,
  mac: boolean,
): {
  key: string;
  code: string;
  keyCode: number;
  modifiers: number;
  text: string;
} {
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

const KEY_DEFINITIONS: Record<
  string,
  { key: string; code: string; keyCode: number; text?: string }
> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

const HIT_TEST_FUNCTION = `function() {
  const element = this instanceof Element ? this : this.parentElement;
  if (!(element instanceof Element) || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const root = element.getRootNode();
  const hitTest = root && typeof root.elementFromPoint === "function" ? root : document;
  const hit = hitTest.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return Boolean(hit && (element === hit || element.contains?.(hit)));
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
  if (!(this instanceof HTMLSelectElement)) return false;
  const selected = new Set(values.map(String));
  for (const option of this.options) option.selected = selected.has(option.value) || selected.has(option.label);
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

const SCROLL_FUNCTION = `function(deltaX, deltaY) {
  this.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
  return true;
}`;

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

const PROTECTED_ELEMENT_METADATA_FUNCTION = `function() {
  if (!(this instanceof Element)) return null;
  const document = this.ownerDocument;
  const view = document?.defaultView;
  if (!document || !view) return null;
  const tag = String(this.tagName || "").toLowerCase();
  const style = view.getComputedStyle(this);
  const rect = this.getBoundingClientRect();
  const connected = this.isConnected === true;
  const visible = connected && style.visibility !== "hidden" && style.display !== "none" &&
    style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  const disabled = this.disabled === true;
  const readOnly = this.readOnly === true;
  const contentEditable = this.isContentEditable === true;
  const inputType = tag === "input"
    ? String(this.getAttribute("type") || "text").toLowerCase()
    : contentEditable ? "contenteditable" : tag === "textarea" ? "text" : "";
  const editableInputTypes = new Set(["email", "number", "password", "search", "tel", "text", "url"]);
  const editable = !disabled && !readOnly &&
    (tag === "textarea" || contentEditable || (tag === "input" && editableInputTypes.has(inputType)));
  const form = this.form instanceof view.HTMLFormElement ? this.form : this.closest?.("form");
  const ownFormAction = typeof this.formAction === "string" && this.formAction.length > 0
    ? this.formAction
    : null;
  const formAction = ownFormAction || (form ? form.action : null);
  const ownFormMethod = typeof this.formMethod === "string" && this.formMethod.length > 0
    ? this.formMethod
    : null;
  const formMethod = form ? String(ownFormMethod || form.method || "get").toLowerCase() : null;
  const submitType = tag === "button"
    ? String(this.getAttribute("type") || "submit").toLowerCase()
    : tag === "input" ? inputType : null;
  return {
    connected,
    visible,
    editable,
    disabled,
    readOnly,
    tag,
    inputType,
    origin: document.location.origin,
    hasForm: Boolean(form),
    formAction,
    formMethod,
    submitType,
  };
}`;

const CLEAR_PROTECTED_VALUE_FUNCTION = `function() {
  if (!(this instanceof Element) || !this.isConnected) return false;
  const tag = String(this.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") this.value = "";
  else if (this.isContentEditable === true) this.textContent = "";
  else return false;
  return true;
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

function boundedImageDimension(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("browser frame has invalid dimensions");
  }
  return Math.round(value);
}

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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

function sameFrameOptions(
  left: NormalizedBrowserFrameStreamOptions,
  right: NormalizedBrowserFrameStreamOptions,
): boolean {
  return (
    left.format === right.format &&
    left.quality === right.quality &&
    left.maxWidth === right.maxWidth &&
    left.maxHeight === right.maxHeight &&
    left.everyNthFrame === right.everyNthFrame
  );
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
