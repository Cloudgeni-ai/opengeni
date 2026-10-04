import { randomUUID } from "node:crypto";
import { InteractionControllerError } from "@opengeni/interaction";
import {
  AttachedBrowserBridgeClient,
  AttachedBrowserBridgeError,
  type AttachedBrowserBridgeOptions,
} from "./attached-bridge";
import { type BrowserCdpConnection, type BrowserCommandRunner } from "./cdp-driver";
import { CdpProtocolError, CdpSessionDetachedError, CdpTransportError, type CdpEvent } from "./cdp";

const POLL_INTERVAL_MS = 50;
const POLL_LIMIT = 1_000;
const MAX_EVENT_LISTENERS = 16_384;

type AttachedTab = {
  id: string;
  title: string;
  url: string | null;
  active: boolean;
  controllable: boolean;
};

type BridgeDebuggerEvent = {
  sequence: number;
  tabId: string;
  sessionId: string | null;
  method: string;
  params: Record<string, unknown>;
};

type EventListener = (event: CdpEvent) => void;

export type AttachedBrowserBridgeTransport = Pick<AttachedBrowserBridgeClient, "request" | "close">;

export type AttachedChromeDriverOptions = AttachedBrowserBridgeOptions & {
  browserName: string;
  browserVersion: string;
};

/** Build the runner + CDP transport consumed by the existing semantic browser
 * driver. Browserd therefore keeps one action/observation implementation for
 * managed Chromium and attached Chrome; only lifecycle and transport differ. */
export async function createAttachedChromeTransport(options: AttachedChromeDriverOptions): Promise<{
  runner: BrowserCommandRunner;
  connection: AttachedChromeCdpConnection;
}> {
  const bridge = await AttachedBrowserBridgeClient.connect(options);
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: options.browserName,
    browserVersion: options.browserVersion,
  });
  return {
    connection,
    runner: new AttachedChromeRunner(bridge, connection),
  };
}

export class AttachedChromeRunner implements BrowserCommandRunner {
  async terminate(): Promise<void> {
    await this.connection.shutdown();
  }

  readonly run = async <T = unknown>(args: readonly string[]): Promise<T> => {
    if (args[0] === "get" && args[1] === "cdp-url" && args.length === 2) {
      return { cdpUrl: "opengeni-attached://local" } as T;
    }
    if (args[0] === "open" && args.length <= 2) {
      if (args[1]) {
        const result = await this.bridge.request<{ tab: AttachedTab }>({
          type: "tabs.create",
          url: args[1],
        });
        const tab = requireTab(result.tab);
        return { url: tab.url ?? args[1], targetId: tab.id } as T;
      }
      const listed = await this.bridge.request<{ tabs: AttachedTab[] }>({ type: "tabs.list" });
      const current =
        requireTabs(listed.tabs).find((tab) => tab.active && tab.controllable) ??
        requireTabs(listed.tabs).find((tab) => tab.controllable);
      if (current) return { url: current.url ?? "about:blank" } as T;
      const created = await this.bridge.request<{ tab: AttachedTab }>({
        type: "tabs.create",
        url: "about:blank",
      });
      const tab = requireTab(created.tab);
      return { url: tab.url ?? "about:blank", targetId: tab.id } as T;
    }
    if (args[0] === "close" && args.length === 1) {
      await this.connection.shutdown();
      return {} as T;
    }
    throw new Error("attached Chrome runner received an unsupported lifecycle command");
  };

  constructor(
    private readonly bridge: AttachedBrowserBridgeTransport,
    private readonly connection: AttachedChromeCdpConnection,
  ) {}
}

export class AttachedChromeCdpConnection implements BrowserCdpConnection {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly sessionTabs = new Map<string, string>();
  private readonly tabSessions = new Map<string, string>();
  private readonly attachedTabs = new Set<string>();
  private readonly canceledTabs = new Set<string>();
  private readonly tabDetachEpochs = new Map<string, number>();
  private readonly pendingInput = new Map<string, number>();
  private readonly uncertainTabs = new Set<string>();
  private readonly browserName: string;
  private readonly browserVersion: string;
  private readonly browserPlatform: NodeJS.Platform;
  private cursor = 0;
  private pollTask: Promise<void> | null = null;
  private pollReady: Promise<void> | null = null;
  private stopped = false;
  private failure: CdpTransportError | null = null;

  constructor(
    private readonly bridge: AttachedBrowserBridgeTransport,
    browser: { browserName: string; browserVersion: string; platform?: NodeJS.Platform },
  ) {
    this.browserName = boundedString(browser.browserName, 1, 100, "browser name");
    this.browserVersion = boundedString(browser.browserVersion, 1, 256, "browser version");
    // The attached bridge and browserd run on the browser's Connected Machine.
    // Preserve its OS when synthesizing the browser-scoped version response;
    // the shared driver uses this to choose native keyboard shortcuts.
    this.browserPlatform = browser.platform ?? process.platform;
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new CdpTransportError("attached Chrome transport is closed");
    if (options.signal?.aborted) throw new CdpTransportError(`CDP ${method} was aborted`);
    try {
      if (options.sessionId) {
        const tabId = this.sessionTabs.get(options.sessionId);
        if (!tabId)
          throw new InteractionControllerError(
            "resource_unavailable",
            "Browser tab debugging disconnected; observe the tab again",
            true,
          );
        const mayChangePage = mayChangePageContent(method);
        if (mayChangePage) this.pendingInput.set(tabId, (this.pendingInput.get(tabId) ?? 0) + 1);
        let response: { result: unknown };
        try {
          response = await this.bridge.request<{ result: unknown }>({
            type: "debugger.command",
            tabId,
            sessionId: nestedSessionId(options.sessionId),
            method,
            params,
          });
        } catch (error) {
          // A failed bridge reply does not prove that a queued command cannot
          // arrive later. Do not attach a replacement debugger underneath it.
          if (mayChangePage) this.uncertainTabs.add(tabId);
          if (this.sessionTabs.get(options.sessionId) !== tabId)
            throw new CdpSessionDetachedError(method);
          throw error;
        } finally {
          if (mayChangePage) {
            const remaining = (this.pendingInput.get(tabId) ?? 1) - 1;
            if (remaining > 0) this.pendingInput.set(tabId, remaining);
            else this.pendingInput.delete(tabId);
          }
        }
        // A command may already have been sent when Chrome disconnects. Do
        // not turn a late response into proof that the current tab was used.
        if (this.sessionTabs.get(options.sessionId) !== tabId)
          throw new CdpSessionDetachedError(method);
        return requireRecord(response.result, "debugger command result") as T;
      }
      return (await this.browserCommand(method, params)) as T;
    } catch (error) {
      throw mapBridgeError(method, error);
    }
  }

  on(method: string, listener: EventListener, sessionId?: string): () => void {
    if (this.failure || this.stopped) return () => undefined;
    if (listenerCount(this.listeners) >= MAX_EVENT_LISTENERS) {
      throw new CdpTransportError("attached Chrome listener bound was reached");
    }
    const key = eventKey(method, sessionId ?? null);
    const listeners = this.listeners.get(key) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    this.ensurePolling();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  async waitForEvent(
    method: string,
    options: {
      sessionId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      predicate?: (params: Record<string, unknown>) => boolean;
    } = {},
  ): Promise<CdpEvent> {
    if (options.signal?.aborted) throw new CdpTransportError(`CDP ${method} wait was aborted`);
    const timeoutMs = boundedTimeout(options.timeoutMs ?? 30_000);
    return await new Promise<CdpEvent>((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        cleanup();
        rejectEvent(new CdpTransportError(`CDP ${method} event timed out`));
      }, timeoutMs);
      timer.unref?.();
      const unsubscribe = this.on(
        method,
        (event) => {
          if (options.predicate && !options.predicate(event.params)) return;
          cleanup();
          resolveEvent(event);
        },
        options.sessionId,
      );
      const aborted = () => {
        cleanup();
        rejectEvent(new CdpTransportError(`CDP ${method} wait was aborted`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        options.signal?.removeEventListener("abort", aborted);
      };
      options.signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sessionTabs.clear();
    this.tabSessions.clear();
    this.canceledTabs.clear();
    this.tabDetachEpochs.clear();
    this.pendingInput.clear();
    this.uncertainTabs.clear();
    this.listeners.clear();
    this.bridge.close();
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.allSettled(
      [...this.attachedTabs].map(async (tabId) => {
        await this.bridge.request({ type: "debugger.detach", tabId });
      }),
    );
    this.attachedTabs.clear();
    this.sessionTabs.clear();
    this.tabSessions.clear();
    this.canceledTabs.clear();
    this.tabDetachEpochs.clear();
    this.pendingInput.clear();
    this.uncertainTabs.clear();
    this.listeners.clear();
    this.bridge.close();
    await this.pollTask?.catch(() => undefined);
  }

  private async browserCommand(
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case "Browser.getVersion":
        return {
          product: `${this.browserName}/${this.browserVersion}`,
          userAgent: `Mozilla/5.0 (${this.browserPlatform === "darwin" ? "Macintosh; Intel Mac OS X" : this.browserPlatform === "win32" ? "Windows NT 10.0" : "X11; Linux"}) Chrome/${this.browserVersion}`,
        };
      case "Target.setDiscoverTargets":
        return {};
      case "Target.getTargets": {
        const result = await this.bridge.request<{ tabs: AttachedTab[] }>({ type: "tabs.list" });
        return {
          targetInfos: requireTabs(result.tabs)
            .filter((tab) => tab.controllable)
            .map((tab) => ({
              targetId: tab.id,
              type: "page",
              title: tab.title,
              url: tab.url ?? "about:blank",
              attached: this.attachedTabs.has(tab.id),
              openerId: null,
            })),
        };
      }
      case "Target.createTarget": {
        const url = boundedUrl(params.url ?? "about:blank");
        const result = await this.bridge.request<{ tab: AttachedTab }>({
          type: "tabs.create",
          // Installed extensions exclude about: pages from target discovery
          // and debugger attachment. Bootstrap an inert, network-free document
          // instead; keep the exact new tab and all restricted-page guards.
          url: url === "about:blank" ? "data:text/html," : url,
        });
        return { targetId: requireTab(result.tab).id };
      }
      case "Target.activateTarget": {
        const targetId = requireTargetId(params.targetId);
        await this.bridge.request({ type: "tabs.activate", tabId: targetId });
        return {};
      }
      case "Target.closeTarget": {
        const targetId = requireTargetId(params.targetId);
        await this.bridge.request({ type: "tabs.close", tabId: targetId });
        this.removeTab(targetId);
        return { success: true };
      }
      case "Target.attachToTarget": {
        const targetId = requireTargetId(params.targetId);
        this.assertAttachAllowed(targetId);
        // Establish the event cursor before attaching, so a disconnect during
        // initialization cannot be discarded as pre-existing history.
        this.ensurePolling();
        await this.pollReady;
        this.assertAttachAllowed(targetId);
        const detachEpoch = this.tabDetachEpochs.get(targetId) ?? 0;
        await this.bridge.request({ type: "debugger.attach", tabId: targetId });
        if ((this.tabDetachEpochs.get(targetId) ?? 0) !== detachEpoch)
          throw new InteractionControllerError(
            "resource_unavailable",
            "Browser tab disconnected while attaching",
            !this.canceledTabs.has(targetId),
          );
        this.attachedTabs.add(targetId);
        const sessionId = this.tabSessions.get(targetId) ?? `attached:${targetId}:${randomUUID()}`;
        this.sessionTabs.set(sessionId, targetId);
        this.tabSessions.set(targetId, sessionId);
        return { sessionId };
      }
      default:
        throw new CdpProtocolError(method, -32_601, "CDP method is unavailable on attached Chrome");
    }
  }

  private ensurePolling(): void {
    if (this.pollTask || this.stopped || this.failure) return;
    this.pollReady = this.pollEvents(Number.MAX_SAFE_INTEGER).then((initial) => {
      this.cursor = initial.cursor;
    });
    this.pollTask = this.pollReady
      .then(() => this.poll())
      .catch((error) => {
        if (!this.stopped) this.fail(mapBridgeError("debugger.poll", error));
      });
  }

  private assertAttachAllowed(targetId: string): void {
    if (this.canceledTabs.has(targetId))
      throw new InteractionControllerError(
        "resource_unavailable",
        "Browser tab debugging was canceled; reconnect the browser profile to restore control",
        false,
      );
    if (this.uncertainTabs.has(targetId))
      throw new InteractionControllerError(
        "resource_unavailable",
        "Browser tab disconnected during input; check the tab and reconnect the browser profile before continuing",
        false,
      );
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      const batch = await this.pollEvents(this.cursor);
      // Older extensions also mark a full continuation page as truncated.
      // The sequence boundary is the authoritative proof of actual loss.
      const firstSequence = batch.events[0]?.sequence;
      if (
        (firstSequence !== undefined && firstSequence !== this.cursor + 1) ||
        (batch.truncated && firstSequence === undefined)
      ) {
        throw new CdpTransportError("attached Chrome debugger event history was truncated");
      }
      for (const event of batch.events) this.emit(event);
      this.cursor = batch.cursor;
      if (batch.events.length === 0) await delay(POLL_INTERVAL_MS);
    }
  }

  private async pollEvents(afterSequence: number): Promise<{
    events: BridgeDebuggerEvent[];
    cursor: number;
    truncated: boolean;
  }> {
    const value = await this.bridge.request<{
      events: unknown;
      cursor: unknown;
      truncated: unknown;
    }>({ type: "debugger.poll", afterSequence, limit: POLL_LIMIT });
    if (!Array.isArray(value.events) || typeof value.truncated !== "boolean") {
      throw new CdpTransportError("attached Chrome returned an invalid event batch");
    }
    const cursor = boundedInteger(value.cursor, 0, Number.MAX_SAFE_INTEGER, "debugger cursor");
    const events = value.events.map(parseDebuggerEvent);
    if (
      events.some((event, index) => index > 0 && event.sequence !== events[index - 1]!.sequence + 1)
    ) {
      throw new CdpTransportError("attached Chrome debugger event history has a sequence gap");
    }
    if (events.length > 0 && cursor !== events.at(-1)!.sequence) {
      throw new CdpTransportError("attached Chrome debugger cursor does not match its event batch");
    }
    return { events, cursor, truncated: value.truncated };
  }

  private emit(input: BridgeDebuggerEvent): void {
    if (input.method === "OpenGeni.debuggerDetached") {
      if ((this.pendingInput.get(input.tabId) ?? 0) > 0) this.uncertainTabs.add(input.tabId);
      this.tabDetachEpochs.set(input.tabId, (this.tabDetachEpochs.get(input.tabId) ?? 0) + 1);
      const sessionId = this.tabSessions.get(input.tabId);
      if (input.params.reason === "canceled_by_user") this.canceledTabs.add(input.tabId);
      this.removeTab(input.tabId);
      if (sessionId)
        this.emitEvent({
          method: "Target.detachedFromTarget",
          sessionId: null,
          params: { sessionId, targetId: input.tabId, reason: input.params.reason },
        });
      return;
    }
    const sessionId = input.sessionId ?? this.tabSessions.get(input.tabId) ?? null;
    const event: CdpEvent = { method: input.method, params: input.params, sessionId };
    this.emitEvent(event);
  }

  private emitEvent(event: CdpEvent): void {
    const keys = new Set([
      eventKey(event.method, event.sessionId),
      eventKey(event.method, null),
      eventKey("*", event.sessionId),
      eventKey("*", null),
    ]);
    for (const key of keys) {
      for (const listener of this.listeners.get(key) ?? []) {
        try {
          listener(event);
        } catch {
          // Observers cannot corrupt transport dispatch.
        }
      }
    }
  }

  private removeTab(tabId: string): void {
    this.attachedTabs.delete(tabId);
    this.tabSessions.delete(tabId);
    for (const [sessionId, mappedTabId] of this.sessionTabs) {
      if (mappedTabId === tabId) this.sessionTabs.delete(sessionId);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure =
      error instanceof CdpTransportError ? error : new CdpTransportError(error.message);
    this.listeners.clear();
  }
}

function parseDebuggerEvent(value: unknown): BridgeDebuggerEvent {
  const record = requireRecord(value, "debugger event");
  return {
    sequence: boundedInteger(record.sequence, 1, Number.MAX_SAFE_INTEGER, "event sequence"),
    tabId: requireTargetId(record.tabId),
    sessionId:
      record.sessionId === null
        ? null
        : boundedString(record.sessionId, 1, 512, "debugger session id"),
    method: boundedString(record.method, 3, 256, "debugger event method"),
    params: requireRecord(record.params, "debugger event parameters"),
  };
}

function requireTabs(value: unknown): AttachedTab[] {
  if (!Array.isArray(value) || value.length > 100_000) {
    throw new CdpTransportError("attached Chrome returned an invalid tab list");
  }
  return value.map(requireTab);
}

function requireTab(value: unknown): AttachedTab {
  const tab = requireRecord(value, "attached Chrome tab");
  return {
    id: requireTargetId(tab.id),
    title: boundedString(tab.title, 0, 8_192, "tab title"),
    url: tab.url === null ? null : boundedString(tab.url, 1, 65_536, "tab URL"),
    active: requireBoolean(tab.active, "tab active state"),
    controllable: requireBoolean(tab.controllable, "tab controllability"),
  };
}

function mapBridgeError(method: string, error: unknown): Error {
  if (error instanceof InteractionControllerError) return error;
  if (
    error instanceof CdpProtocolError ||
    error instanceof CdpTransportError ||
    error instanceof CdpSessionDetachedError
  )
    return error;
  if (error instanceof AttachedBrowserBridgeError) {
    if (error.code === "debugger_unavailable")
      return new InteractionControllerError(
        "resource_unavailable",
        "Browser tab debugging unavailable; observe the tab again",
        true,
      );
    return error.code === "driver_rejected"
      ? new CdpProtocolError(method, -32_000, error.message)
      : new CdpTransportError(error.message);
  }
  return new CdpTransportError(error instanceof Error ? error.message : "attached Chrome failed");
}

function nestedSessionId(sessionId: string): string | undefined {
  return sessionId.startsWith("attached:") ? undefined : sessionId;
}

// Only audited read/setup commands may survive without an uncertain-effect
// fence. Unknown methods are conservative: a late queued command must never
// run underneath a replacement attachment to the same tab.
const READ_ONLY_TAB_METHODS = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.enable",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getDocument",
  "DOM.querySelectorAll",
  "DOM.resolveNode",
  "Log.enable",
  "Network.enable",
  "Page.captureScreenshot",
  "Page.createIsolatedWorld",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Runtime.enable",
  "Runtime.releaseObject",
]);

function mayChangePageContent(method: string): boolean {
  return !READ_ONLY_TAB_METHODS.has(method);
}

function eventKey(method: string, sessionId: string | null): string {
  return `${sessionId ?? ""}\0${method}`;
}

function listenerCount(listeners: Map<string, Set<EventListener>>): number {
  let count = 0;
  for (const values of listeners.values()) count += values.size;
  return count;
}

function requireTargetId(value: unknown): string {
  const id = boundedString(value, 1, 32, "browser target id");
  if (!/^[1-9][0-9]*$/u.test(id)) throw new CdpTransportError("browser target id is invalid");
  return id;
}

function boundedUrl(value: unknown): string {
  const url = boundedString(value, 1, 16_384, "browser URL");
  try {
    return new URL(url).href;
  } catch {
    throw new CdpTransportError("browser URL must be absolute");
  }
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new CdpTransportError(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CdpTransportError(`${label} is invalid`);
  }
  return value as number;
}

function boundedTimeout(value: number): number {
  return boundedInteger(value, 1, 10 * 60_000, "CDP timeout");
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new CdpTransportError(`${label} is invalid`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CdpTransportError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref?.();
  });
}
