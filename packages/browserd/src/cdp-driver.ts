import { createHash, randomUUID } from "node:crypto";
import {
  BrowserActionCommand,
  BrowserDiagnosticBatch,
  BrowserDiagnosticEntry,
  BrowserDialog,
  BrowserObservation,
  BrowserTarget,
  INTERACTION_MAX_DIAGNOSTIC_ENTRIES,
  INTERACTION_PROTOCOL_VERSION,
  type BrowserAction,
  type BrowserActionCommand as BrowserActionCommandValue,
  type BrowserDiagnosticBatch as BrowserDiagnosticBatchValue,
  type BrowserDiagnosticKind,
  type BrowserLocator,
  type BrowserObservation as BrowserObservationValue,
  type BrowserTarget as BrowserTargetValue,
} from "@opengeni/contracts";
import {
  InteractionDefiniteDriverError,
  type BrowserInteractionDriver,
} from "@opengeni/interaction";
import {
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
import type { AgentBrowserJsonCommand } from "./runner";

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const BROWSER_START_TIMEOUT_MS = 30_000;
const GRACEFUL_BROWSER_CLOSE_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_MS = 500;

class DialogOpenedSignal extends Error {}

export type BrowserCommandRunner = {
  run: AgentBrowserJsonCommand;
  terminate?: () => Promise<void>;
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
  screencast: TargetScreencast | null;
  tail: Promise<void>;
  unsubscribe: Array<() => void>;
};

export type AgentBrowserDriverOptions = {
  browserSessionId: string;
  controllerGeneration: string;
  runner: BrowserCommandRunner;
  now?: () => Date;
  createId?: () => string;
  resolveWorkspaceFiles?: (workspaceFileIds: readonly string[]) => Promise<readonly string[]>;
  connect?: (endpoint: string) => Promise<BrowserCdpConnection>;
  engine?: "chromium" | "chrome";
};

export type BrowserRuntimeSnapshot = {
  engine: "chromium" | "chrome";
  engineVersion: string | null;
  tabs: Array<{ url: string; selected: boolean }>;
};

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
  private readonly engine: "chromium" | "chrome";
  private readonly resolveWorkspaceFiles:
    | ((workspaceFileIds: readonly string[]) => Promise<readonly string[]>)
    | undefined;
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
  private started = false;

  constructor(options: AgentBrowserDriverOptions) {
    this.browserSessionId = options.browserSessionId;
    this.controllerGeneration = options.controllerGeneration;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.engine = options.engine ?? "chromium";
    this.resolveWorkspaceFiles = options.resolveWorkspaceFiles;
    this.connect = options.connect ?? (async (endpoint) => await CdpConnection.connect(endpoint));
  }

  async start(url?: string): Promise<BrowserObservationValue> {
    const launched = await this.runner.run<{ url?: unknown; targetId?: unknown }>(
      url === undefined ? ["open"] : ["open", url],
      { timeoutMs: BROWSER_START_TIMEOUT_MS },
    );
    this.started = true;
    const connection = await this.ensureConnection();
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
    return await this.observe(target.targetId);
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
    const connection = await this.ensureConnection();
    const result = await connection.send<{ targetId?: unknown }>("Target.createTarget", { url });
    if (typeof result.targetId !== "string") throw new Error("CDP did not return a target id");
    await connection.send("Target.activateTarget", {
      targetId: result.targetId,
    });
    this.selectedTargetId = result.targetId;
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
    if (this.started) {
      try {
        await this.runner.run(["close"], { timeoutMs: GRACEFUL_BROWSER_CLOSE_TIMEOUT_MS });
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
          await this.dispatchAction(state, action);
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
    const frame = await this.mainFrame(sessionId);
    const state: TargetState = {
      targetId: info.targetId,
      sessionId,
      createdAt: this.firstSeen(info.targetId),
      frame,
      documentGeneration: documentGeneration(
        this.controllerGeneration,
        info.targetId,
        frame.loaderId,
      ),
      frameGeneration: frameGeneration(this.controllerGeneration, info.targetId, frame.id),
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
      screencast: null,
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
    return state;
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
    const connection = await this.ensureConnection();
    const response = await connection.send<{ nodes?: unknown }>(
      "Accessibility.getFullAXTree",
      {},
      { sessionId: state.sessionId },
    );
    if (!Array.isArray(response.nodes))
      throw new Error("CDP returned an invalid accessibility tree");
    const accessibility = normalizeCdpAccessibilityTree({
      nodes: response.nodes as CdpAxNode[],
      controllerGeneration: this.controllerGeneration,
      targetId: state.targetId,
      documentGeneration: state.documentGeneration,
    });
    state.accessibility = accessibility;
    return accessibility;
  }

  private async refreshFrame(state: TargetState): Promise<void> {
    const frame = await this.mainFrame(state.sessionId);
    if (frame.loaderId !== state.frame.loaderId || frame.id !== state.frame.id) {
      state.frame = frame;
      state.documentGeneration = documentGeneration(
        this.controllerGeneration,
        state.targetId,
        frame.loaderId,
      );
      state.frameGeneration = frameGeneration(this.controllerGeneration, state.targetId, frame.id);
      state.accessibility = null;
    } else {
      state.frame = frame;
    }
  }

  private async mainFrame(sessionId: string): Promise<MainFrame> {
    const connection = await this.ensureConnection();
    const response = await connection.send<{ frameTree?: unknown }>(
      "Page.getFrameTree",
      {},
      { sessionId },
    );
    if (!isRecord(response.frameTree) || !isRecord(response.frameTree.frame)) {
      throw new Error("CDP returned an invalid frame tree");
    }
    const frame = response.frameTree.frame;
    if (
      typeof frame.id !== "string" ||
      typeof frame.loaderId !== "string" ||
      typeof frame.url !== "string"
    ) {
      throw new Error("CDP returned an invalid main frame");
    }
    return { id: frame.id, loaderId: frame.loaderId, url: frame.url };
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

  private async dispatchAction(state: TargetState, action: BrowserAction): Promise<void> {
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
        const paths = await this.resolveWorkspaceFiles(action.workspaceFileIds);
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
      case "wait":
        await this.waitForCondition(state, action);
        return;
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
      const hit = await this.callOnNode(state, backendDOMNodeId, HIT_TEST_FUNCTION, [
        { value: point.x },
        { value: point.y },
      ]);
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
    return generation("target", this.browserSessionId, this.controllerGeneration, targetId);
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
    state.frame = { id: frame.id, loaderId: frame.loaderId, url: frame.url };
    state.documentGeneration = documentGeneration(
      this.controllerGeneration,
      state.targetId,
      frame.loaderId,
    );
    state.frameGeneration = frameGeneration(this.controllerGeneration, state.targetId, frame.id);
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

  private removeState(targetId: string): void {
    const state = this.states.get(targetId);
    if (!state) return;
    this.failScreencast(state, new CdpTransportError("browser target closed"));
    for (const unsubscribe of state.unsubscribe) unsubscribe();
    this.states.delete(targetId);
    this.firstSeenAt.delete(targetId);
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
  targetId: string,
  loaderId: string,
): string {
  return generation("document", controllerGeneration, targetId, loaderId);
}

function frameGeneration(controllerGeneration: string, targetId: string, frameId: string): string {
  return generation("frame", controllerGeneration, targetId, frameId);
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

const HIT_TEST_FUNCTION = `function(x, y) {
  const hit = document.elementFromPoint(x, y);
  return Boolean(hit && (this === hit || this.contains?.(hit)));
}`;

const VISIBLE_FUNCTION = `function() {
  if (!(this instanceof Element) || !this.isConnected) return false;
  const style = getComputedStyle(this);
  const rect = this.getBoundingClientRect();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
