import {
  AttachedBrowserBridgeClient,
  AttachedBrowserBridgeError,
  type AttachedBrowserBridgeOptions,
} from "./attached-bridge";
import { type BrowserCdpConnection, type BrowserCommandRunner } from "./cdp-driver";
import { CdpProtocolError, CdpTransportError, type CdpEvent } from "./cdp";

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

class AttachedChromeRunner implements BrowserCommandRunner {
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
  private readonly attachedTabs = new Set<string>();
  private readonly browserName: string;
  private readonly browserVersion: string;
  private cursor = 0;
  private pollTask: Promise<void> | null = null;
  private stopped = false;
  private failure: CdpTransportError | null = null;

  constructor(
    private readonly bridge: AttachedBrowserBridgeTransport,
    browser: { browserName: string; browserVersion: string },
  ) {
    this.browserName = boundedString(browser.browserName, 1, 100, "browser name");
    this.browserVersion = boundedString(browser.browserVersion, 1, 256, "browser version");
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
        if (!tabId) throw new CdpProtocolError(method, -32_601, "CDP session is unavailable");
        const response = await this.bridge.request<{ result: unknown }>({
          type: "debugger.command",
          tabId,
          sessionId: nestedSessionId(options.sessionId),
          method,
          params,
        });
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
          userAgent: `Mozilla/5.0 Chrome/${this.browserVersion}`,
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
        const result = await this.bridge.request<{ tab: AttachedTab }>({
          type: "tabs.create",
          url: boundedUrl(params.url ?? "about:blank"),
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
        await this.bridge.request({ type: "debugger.attach", tabId: targetId });
        this.attachedTabs.add(targetId);
        const sessionId = attachedSessionId(targetId);
        this.sessionTabs.set(sessionId, targetId);
        this.ensurePolling();
        return { sessionId };
      }
      default:
        throw new CdpProtocolError(method, -32_601, "CDP method is unavailable on attached Chrome");
    }
  }

  private ensurePolling(): void {
    if (this.pollTask || this.stopped || this.failure) return;
    this.pollTask = this.poll().catch((error) => {
      if (!this.stopped) this.fail(mapBridgeError("debugger.poll", error));
    });
  }

  private async poll(): Promise<void> {
    const initial = await this.pollEvents(Number.MAX_SAFE_INTEGER);
    this.cursor = initial.cursor;
    while (!this.stopped) {
      const batch = await this.pollEvents(this.cursor);
      if (batch.truncated) {
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
    if (events.some((event, index) => event.sequence <= (events[index - 1]?.sequence ?? 0))) {
      throw new CdpTransportError("attached Chrome debugger events are not monotonic");
    }
    return { events, cursor, truncated: value.truncated };
  }

  private emit(input: BridgeDebuggerEvent): void {
    if (input.method === "OpenGeni.debuggerDetached") {
      this.removeTab(input.tabId);
      return;
    }
    const sessionId = input.sessionId ?? attachedSessionId(input.tabId);
    const event: CdpEvent = { method: input.method, params: input.params, sessionId };
    const keys = new Set([
      eventKey(event.method, sessionId),
      eventKey(event.method, null),
      eventKey("*", sessionId),
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
  if (error instanceof CdpProtocolError || error instanceof CdpTransportError) return error;
  if (error instanceof AttachedBrowserBridgeError) {
    return error.code === "driver_rejected"
      ? new CdpProtocolError(method, -32_000, error.message)
      : new CdpTransportError(error.message);
  }
  return new CdpTransportError(error instanceof Error ? error.message : "attached Chrome failed");
}

function attachedSessionId(tabId: string): string {
  return `attached:${tabId}`;
}

function nestedSessionId(sessionId: string): string | undefined {
  return sessionId.startsWith("attached:") ? undefined : sessionId;
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
