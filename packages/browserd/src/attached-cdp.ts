import { randomUUID } from "node:crypto";
import {
  InteractionControllerError,
  InteractionDefiniteDriverError,
  InteractionOutcomeUnknownDriverError,
} from "@opengeni/interaction";
import {
  AttachedBrowserBridgeClient,
  AttachedBrowserBridgeError,
  type AttachedBrowserBridgeOptions,
} from "./attached-bridge";
import {
  AgentBrowserDriver,
  isBlankTabUrl,
  type AgentBrowserDriverOptions,
  type BrowserCdpConnection,
  type BrowserCommandRunner,
} from "./cdp-driver";
import { MAX_CLOSED_BLANK_TABS, type AttachedTabLedger } from "./attached-tab-ledger";
import {
  CdpCommandTimeoutError,
  CdpProtocolError,
  CdpSessionDetachedError,
  CdpTransportError,
  type CdpEvent,
} from "./cdp";

const POLL_INTERVAL_MS = 50;
// A connection nobody has used for a while (an open session waiting for its
// next instruction) polls slowly: each poll is a native-messaging round trip
// into the person's browser. Polling stays fast while a command or event wait
// is running, any new one wakes an idle wait at once, and flushes still wait
// for the next batch, so actions never see the slower interval.
const POLL_IDLE_INTERVAL_MS = 1_000;
const POLL_ACTIVE_WINDOW_MS = 2_000;
const POLL_LIMIT = 1_000;
// Bound on waiting for events the extension already holds to reach listeners.
// Polling normally delivers them within one interval; this only stops a
// stalled bridge from holding an action open.
const EVENT_FLUSH_LIMIT_MS = 1_000;
const MAX_EVENT_LISTENERS = 16_384;
// Chrome reports the debugger detach that ends a refused navigation on its own
// event stream, usually just before or after the failed command's reply.
const REFUSED_NAVIGATION_DETACH_WAIT_MS = 1_000;
// Retry bounds while the event stream is re-established after it broke.
const RESYNC_RETRY_MIN_MS = 100;
const RESYNC_RETRY_MAX_MS = 5_000;
// A tab's download events name the download but not the file Chrome saved;
// the extension finds that in Chrome's download list. A download is looked up
// among those of its address started shortly before its event arrived, and
// Chrome may list it as complete a moment after reporting it complete.
const DOWNLOAD_START_SLACK_MS = 5_000;
const DOWNLOAD_FIND_ATTEMPTS = 10;
const DOWNLOAD_FIND_RETRY_MS = 200;
const MAX_TRACKED_DOWNLOADS = 1_000;

const EXTENSION_RESTRICTED_SCHEMES = [
  "about:",
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "view-source:",
] as const;

/** Chrome's limit on which pages an extension may control, mirrored from the
 * extension's tab policy (a parity test keeps the two identical). Checking it
 * before a tab is created or navigated means a refused page never strands a
 * tab or takes the user's tab out of control. */
export function attachedChromePageRestriction(url: string): string | null {
  const lower = url.toLowerCase();
  if (EXTENSION_RESTRICTED_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    return "Chrome does not permit extensions to control this browser page";
  }
  if (
    lower.startsWith("https://chromewebstore.google.com/") ||
    lower.startsWith("https://chrome.google.com/webstore/")
  ) {
    return "Chrome does not permit extensions to control the Chrome Web Store";
  }
  return null;
}

function restrictedPageError(reason: string): InteractionDefiniteDriverError {
  return new InteractionDefiniteDriverError(
    "unsupported",
    `${reason}; the connected browser cannot open it`,
  );
}

const MAX_TAB_URL_LENGTH = 65_536;

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

/** Opens one bridge connection to an attached browser profile. Tests
 * substitute a bridge to a fixture browser. */
export type AttachedBrowserBridgeConnector = (
  options: AttachedBrowserBridgeOptions,
) => Promise<AttachedBrowserBridgeTransport & { readonly closed?: boolean }>;

export const connectAttachedBrowserBridge: AttachedBrowserBridgeConnector = async (options) =>
  await AttachedBrowserBridgeClient.connect(options);

/**
 * Chrome keeps one debugger attachment per tab for the extension, whichever
 * session asked for it, and detaching it ends it for every session. Each
 * connection in this process records the tabs it holds here, so releasing a
 * tab detaches Chrome's debugger only once no other session still holds it.
 * Keyed by browser profile connection (device and connection generation).
 */
const debuggerHolders = new Map<string, Set<AttachedChromeCdpConnection>>();

function holderKey(scope: string, tabId: string): string {
  return `${scope}\u0000${tabId}`;
}

function attachmentScope(deviceId: string, connectionGeneration: string): string {
  return `${deviceId}\u0000${connectionGeneration}`;
}

/** Whether a live session in this process holds Chrome's debugger on a tab. */
export function attachedDebuggerHeld(
  deviceId: string,
  connectionGeneration: string,
  tabId: string,
): boolean {
  const holders = debuggerHolders.get(
    holderKey(attachmentScope(deviceId, connectionGeneration), tabId),
  );
  return holders !== undefined && holders.size > 0;
}

/** One owner-local bridge connection that outlives a lost socket. A request
 * in flight when the socket closed still fails, since its effect is unknown;
 * the next request reconnects under the same profile fence. A profile that
 * reconnected under a new generation is refused by that fence. */
export class ReconnectingAttachedBridge implements AttachedBrowserBridgeTransport {
  private client: Promise<AttachedBrowserBridgeTransport & { readonly closed?: boolean }> | null;
  private stopped = false;

  private constructor(
    private readonly options: AttachedBrowserBridgeOptions,
    first: AttachedBrowserBridgeTransport & { readonly closed?: boolean },
    private readonly connector: AttachedBrowserBridgeConnector,
  ) {
    this.client = Promise.resolve(first);
  }

  static async connect(
    options: AttachedBrowserBridgeOptions,
    connector: AttachedBrowserBridgeConnector = connectAttachedBrowserBridge,
  ): Promise<ReconnectingAttachedBridge> {
    return new ReconnectingAttachedBridge(options, await connector(options), connector);
  }

  async request<T = unknown>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    if (this.stopped)
      throw new AttachedBrowserBridgeError(
        "transport_failed",
        "attached browser bridge closed by browserd",
        true,
      );
    const pending = (this.client ??= this.connector(this.options));
    let client: AttachedBrowserBridgeTransport & { readonly closed?: boolean };
    try {
      client = await pending;
    } catch (error) {
      if (this.client === pending) this.client = null;
      throw error;
    }
    // Closed while reconnecting: nothing may be dispatched after close.
    if (this.stopped) {
      client.close();
      throw new AttachedBrowserBridgeError(
        "transport_failed",
        "attached browser bridge closed by browserd",
        true,
      );
    }
    try {
      return await client.request<T>(payload);
    } catch (error) {
      if (client.closed && this.client === pending) this.client = null;
      throw error;
    }
  }

  close(): void {
    this.stopped = true;
    const pending = this.client;
    this.client = null;
    void pending?.then(
      (client) => client.close(),
      () => undefined,
    );
  }
}

export type AttachedChromeDriverOptions = AttachedBrowserBridgeOptions & {
  browserName: string;
  browserVersion: string;
  connectBridge?: AttachedBrowserBridgeConnector;
  /** Debugger attachments an earlier runtime of the session left in Chrome;
   * this connection releases them as its own. */
  inheritedAttachments?: readonly string[];
  /** Called whenever the tabs this connection holds Chrome's debugger on change. */
  onAttachmentsChange?: (tabs: readonly string[]) => void;
};

/** Build the runner + CDP transport consumed by the existing semantic browser
 * driver. Browserd therefore keeps one action/observation implementation for
 * managed Chromium and attached Chrome; only lifecycle and transport differ. */
export async function createAttachedChromeTransport(options: AttachedChromeDriverOptions): Promise<{
  runner: BrowserCommandRunner;
  connection: AttachedChromeCdpConnection;
}> {
  const bridge = await ReconnectingAttachedBridge.connect(
    {
      deviceId: options.deviceId,
      connectionGeneration: options.connectionGeneration,
      ...(options.authorityFile ? { authorityFile: options.authorityFile } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
    options.connectBridge,
  );
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: options.browserName,
    browserVersion: options.browserVersion,
    attachments: {
      deviceId: options.deviceId,
      connectionGeneration: options.connectionGeneration,
      ...(options.inheritedAttachments ? { inherited: options.inheritedAttachments } : {}),
      ...(options.onAttachmentsChange ? { onChange: options.onAttachmentsChange } : {}),
    },
  });
  return {
    connection,
    runner: new AttachedChromeRunner(bridge, connection),
  };
}

/** The semantic driver for one session on an attached Chrome transport. */
export function createAttachedChromeDriver(
  session: { browserSessionId: string; controllerGeneration: string },
  transport: { runner: BrowserCommandRunner; connection: AttachedChromeCdpConnection },
  resolveWorkspaceFiles?: (
    operationId: string,
    workspaceFileIds: readonly string[],
  ) => Promise<readonly string[]>,
  downloadEvents?: AgentBrowserDriverOptions["downloadEvents"],
  ownedTabs: NonNullable<AgentBrowserDriverOptions["ownedTabs"]> = {},
): AgentBrowserDriver {
  return new AgentBrowserDriver({
    browserSessionId: session.browserSessionId,
    controllerGeneration: session.controllerGeneration,
    runner: transport.runner,
    targetLifecycle: "cdp",
    // The browser is the person's own: whatever ends this runtime closes the
    // tabs the session opened and left blank, unless another session is
    // using one of them now.
    ownedTabs: {
      inUseElsewhere: (tabId) => transport.connection.debuggerHeldElsewhere(tabId),
      ...ownedTabs,
    },
    connect: async () => transport.connection,
    engine: "chrome",
    permissionControl: false,
    // Agent tabs open in the background so the user's foreground stays
    // theirs; focus emulation keeps them rendering and taking input.
    focusEmulation: true,
    ...(resolveWorkspaceFiles ? { resolveWorkspaceFiles } : {}),
    // Chrome saves downloads in the person's own downloads folder; the
    // session keeps a copy of each one its tabs start.
    ...(downloadEvents ? { downloadEvents, downloadsSavedByPerson: true } : {}),
  });
}

/**
 * Clean up after a session runtime that went away without doing so itself (a
 * crashed controller, or a cleanup that could not reach the browser): close
 * the tabs it opened that are still blank and release the debugger
 * attachments it held. A tab that shows a page, or that a live session in
 * this process holds, stays. A tab Chrome reports without an address yet
 * (just created, or still loading) is neither: it stays recorded for a later
 * sweep. Returns the record to keep; it is settled when nothing is left to
 * do. A profile that reconnected under another generation
 * can no longer be addressed with these tab ids, so its record settles as is.
 * Any other failure throws, for a later retry.
 */
export async function settleAttachedTabLedger(
  ledger: AttachedTabLedger,
  connectBridge: AttachedBrowserBridgeConnector,
  now: number,
): Promise<AttachedTabLedger> {
  const unaddressable: AttachedTabLedger = {
    ...ledger,
    settled: true,
    createdTabs: [],
    attachedTabs: [],
    updatedAt: now,
  };
  const fenced = (error: unknown) =>
    error instanceof AttachedBrowserBridgeError && error.code === "fenced";
  let bridge: AttachedBrowserBridgeTransport;
  try {
    bridge = await connectBridge({
      deviceId: ledger.deviceId,
      connectionGeneration: ledger.connectionGeneration,
      ...(ledger.authorityFile ? { authorityFile: ledger.authorityFile } : {}),
    });
  } catch (error) {
    if (fenced(error)) return unaddressable;
    throw error;
  }
  const held = (tabId: string) =>
    attachedDebuggerHeld(ledger.deviceId, ledger.connectionGeneration, tabId);
  try {
    const listed = await bridge.request<{ tabs: unknown }>({ type: "tabs.list" });
    const tabs = new Map(requireTabs(listed.tabs).map((tab) => [tab.id, tab]));
    let settled = true;
    const createdTabs: string[] = [];
    const closedBlankTabs = [...ledger.closedBlankTabs];
    const closed = new Set<string>();
    for (const tabId of ledger.createdTabs) {
      const tab = tabs.get(tabId);
      if (!tab) continue;
      if (tab.url === null) {
        // Whether it ends up blank or showing a page is not known yet.
        createdTabs.push(tabId);
        settled = false;
        continue;
      }
      if (!isBlankTabUrl(tab.url) || held(tabId)) {
        createdTabs.push(tabId);
        continue;
      }
      try {
        // Closing a tab also ends Chrome's debugger attachment to it.
        await bridge.request({ type: "tabs.close", tabId });
        closed.add(tabId);
        closedBlankTabs.push(tabId);
      } catch (error) {
        if (fenced(error)) throw error;
        createdTabs.push(tabId);
        settled = false;
      }
    }
    const attachedTabs: string[] = [];
    for (const tabId of ledger.attachedTabs) {
      if (!tabs.has(tabId) || closed.has(tabId) || held(tabId)) continue;
      try {
        await bridge.request({ type: "debugger.detach", tabId });
      } catch (error) {
        if (fenced(error)) throw error;
        attachedTabs.push(tabId);
        settled = false;
      }
    }
    return {
      ...ledger,
      settled,
      createdTabs,
      attachedTabs,
      closedBlankTabs: [...new Set(closedBlankTabs)].slice(-MAX_CLOSED_BLANK_TABS),
      updatedAt: now,
    };
  } catch (error) {
    if (fenced(error)) return unaddressable;
    throw error;
  } finally {
    bridge.close();
  }
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
  // The extension's number for each tab's current debugger attachment, sent
  // with every command so the extension refuses one whose attachment ended.
  // Extensions that predate it report none.
  private readonly tabAttachments = new Map<string, number>();
  private readonly browserName: string;
  private readonly browserVersion: string;
  private readonly browserPlatform: NodeJS.Platform;
  private cursor = 0;
  private pollTask: Promise<void> | null = null;
  private pollReady: Promise<void> | null = null;
  private wakePoll: (() => void) | null = null;
  // When a command was last sent or finished, or an event last arrived.
  private lastActivityAt = Date.now();
  // Commands and event waits still running; polling stays fast while any are.
  private inFlight = 0;
  // Whether the poll loop is waiting the slow idle interval.
  private pollingIdle = false;
  private readonly flushWaiters = new Set<{ sequence: number; release: () => void }>();
  private stopped = false;
  // Set only by a failure no retry can repair: the profile reconnected.
  private failure: Error | null = null;
  // The event stream broke and its cursor is being re-established.
  private resyncing = false;
  // Counts stream breaks, so an attach that spans one is not trusted.
  private streamBreaks = 0;
  // Downloads a controlled tab started and has not finished: what finding
  // their saved file needs.
  private readonly downloads = new Map<string, { url: string; startedAfter: string }>();
  // Downloads that finished, so a repeated event cannot settle one twice.
  private readonly finishedDownloads = new Set<string>();
  // Chrome's ids of saved files already matched to a download here.
  private readonly claimedDownloadFiles = new Set<number>();
  // Which browser profile connection this connection's debugger holds count
  // against (see debuggerHolders).
  private readonly attachmentScope: string;
  private readonly onAttachmentsChange: ((tabs: readonly string[]) => void) | null;
  // Attachments shutdown could not release.
  private leftovers: string[] = [];

  constructor(
    private readonly bridge: AttachedBrowserBridgeTransport,
    browser: {
      browserName: string;
      browserVersion: string;
      platform?: NodeJS.Platform;
      attachments?: {
        deviceId: string;
        connectionGeneration: string;
        inherited?: readonly string[];
        onChange?: (tabs: readonly string[]) => void;
      };
    },
  ) {
    this.browserName = boundedString(browser.browserName, 1, 100, "browser name");
    this.browserVersion = boundedString(browser.browserVersion, 1, 256, "browser version");
    // The attached bridge and browserd run on the browser's Connected Machine.
    // Preserve its OS when synthesizing the browser-scoped version response;
    // the shared driver uses this to choose native keyboard shortcuts.
    this.browserPlatform = browser.platform ?? process.platform;
    this.attachmentScope = browser.attachments
      ? attachmentScope(browser.attachments.deviceId, browser.attachments.connectionGeneration)
      : `connection:${randomUUID()}`;
    this.onAttachmentsChange = browser.attachments?.onChange ?? null;
    for (const tabId of browser.attachments?.inherited ?? []) this.holdDebugger(tabId);
  }

  /** Whether another live session in this process holds Chrome's debugger
   * on this tab, so it is in use there. */
  debuggerHeldElsewhere(tabId: string): boolean {
    const holders = debuggerHolders.get(holderKey(this.attachmentScope, tabId));
    if (!holders) return false;
    return holders.size > (holders.has(this) ? 1 : 0);
  }

  /** Debugger attachments the last shutdown could not release. */
  leftoverAttachments(): readonly string[] {
    return [...this.leftovers];
  }

  private holdDebugger(tabId: string): void {
    if (this.attachedTabs.has(tabId)) return;
    this.attachedTabs.add(tabId);
    const key = holderKey(this.attachmentScope, tabId);
    const holders = debuggerHolders.get(key) ?? new Set<AttachedChromeCdpConnection>();
    holders.add(this);
    debuggerHolders.set(key, holders);
    this.attachmentsChanged();
  }

  /** Stops holding a tab's debugger here. Returns whether another session in
   * this process still holds it, so Chrome's attachment must stay. */
  private releaseDebugger(tabId: string): boolean {
    const key = holderKey(this.attachmentScope, tabId);
    const holders = debuggerHolders.get(key);
    holders?.delete(this);
    if (holders?.size === 0) debuggerHolders.delete(key);
    if (this.attachedTabs.delete(tabId)) this.attachmentsChanged();
    return (holders?.size ?? 0) > 0;
  }

  private attachmentsChanged(): void {
    // Shutdown reports what it could not release once it is done.
    if (this.stopped) return;
    try {
      this.onAttachmentsChange?.([...this.attachedTabs]);
    } catch {
      // Recording is the owner's concern; it never fails browser work.
    }
  }

  /** Refuse, before anything is created or navigated, a page Chrome will not
   * let the extension control. */
  assertNavigable(url: string): void {
    const reason = attachedChromePageRestriction(url);
    if (reason) throw restrictedPageError(reason);
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new CdpTransportError("attached Chrome transport is closed");
    if (options.signal?.aborted) throw new CdpTransportError(`CDP ${method} was aborted`);
    this.markActive();
    this.inFlight += 1;
    try {
      return await this.sendNow<T>(method, params, options);
    } finally {
      this.inFlight -= 1;
      this.lastActivityAt = Date.now();
    }
  }

  private async sendNow<T>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { sessionId?: string },
  ): Promise<T> {
    try {
      if (options.sessionId) {
        const tabId = this.sessionTabs.get(options.sessionId);
        if (!tabId)
          throw new InteractionControllerError(
            "resource_unavailable",
            "Browser tab debugging disconnected; observe the tab again",
            true,
          );
        const navigation = method === "Page.navigate";
        if (navigation && typeof params.url === "string") this.assertNavigable(params.url);
        const mayChangePage = mayChangePageContent(method);
        if (mayChangePage) this.pendingInput.set(tabId, (this.pendingInput.get(tabId) ?? 0) + 1);
        const detachEpoch = this.tabDetachEpochs.get(tabId) ?? 0;
        const attachment = this.tabAttachments.get(tabId);
        let response: { result: unknown };
        try {
          response = await this.bridge.request<{ result: unknown }>({
            type: "debugger.command",
            tabId,
            sessionId: nestedSessionId(options.sessionId),
            ...(attachment === undefined ? {} : { attachment }),
            method,
            params,
          });
        } catch (error) {
          if (
            error instanceof AttachedBrowserBridgeError &&
            error.code === "debugger_unavailable"
          ) {
            // The extension refuses before sending anything to the page:
            // another controller released Chrome's debugger on this tab. The
            // tab is as it was; the next use attaches again. A refusal for an
            // attachment that has since been replaced leaves the new one be.
            if (attachment === undefined || this.tabAttachments.get(tabId) === attachment)
              this.forgetReleasedAttachment(tabId);
            throw error;
          }
          // Chrome ended the attachment while it handled this command, so
          // nothing of it is left to arrive later; whether it took effect is
          // unknown.
          if (chromeDetachedDuringCommand(error)) throw new CdpSessionDetachedError(method);
          // The extension refuses a command it does not allow before sending
          // anything to the page (such as a method outside its surface).
          if (error instanceof AttachedBrowserBridgeError && error.code === "invalid_request")
            throw new CdpProtocolError(method, -32_601, error.message);
          // A failed bridge reply does not prove that a queued command cannot
          // arrive later. Do not attach a replacement debugger underneath it.
          // Chrome's own protocol refusal is the reply to that exact command,
          // so it leaves nothing in flight.
          if (mayChangePage && !chromeProtocolRefusal(error)) this.uncertainTabs.add(tabId);
          if (navigation && (await this.navigationEndedControl(tabId, detachEpoch)))
            throw new InteractionDefiniteDriverError(
              "unsupported",
              "Chrome ended control of this tab when it navigated; Chrome does not permit " +
                "extensions to control some pages, such as the Chrome Web Store or browser pages",
            );
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
      throw mapBridgeError(method, error, options.sessionId);
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

  /**
   * Resolves once every debugger event the extension recorded before this
   * call has reached listeners. Events arrive by polling here, so a command
   * reply alone does not prove that the events Chrome sent before it (a
   * navigation a click started, a request it sent) have been seen yet.
   * Best effort and bounded: a stalled bridge only loses the guarantee.
   */
  async flushEvents(): Promise<void> {
    if (this.failure || this.stopped || !this.pollTask) return;
    try {
      await this.pollReady;
      // Asking for events after the largest sequence returns none, only the
      // extension's current sequence.
      const { cursor: sequence } = await this.pollEvents(Number.MAX_SAFE_INTEGER);
      if (this.cursor >= sequence || this.failure || this.stopped) return;
      await new Promise<void>((resolve) => {
        const waiter = {
          sequence,
          release: () => {
            clearTimeout(timer);
            this.flushWaiters.delete(waiter);
            resolve();
          },
        };
        const timer = setTimeout(waiter.release, EVENT_FLUSH_LIMIT_MS);
        this.flushWaiters.add(waiter);
        this.wakePoll?.();
      });
    } catch {
      // Flushing only sharpens what the caller observes next; it never fails it.
    }
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
    this.markActive();
    this.inFlight += 1;
    let waiting = true;
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
        if (waiting) {
          waiting = false;
          this.inFlight -= 1;
          this.lastActivityAt = Date.now();
        }
      };
      options.signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Chrome's attachments stay; shutdown is what releases them.
    for (const tabId of [...this.attachedTabs]) {
      const key = holderKey(this.attachmentScope, tabId);
      debuggerHolders.get(key)?.delete(this);
      if (debuggerHolders.get(key)?.size === 0) debuggerHolders.delete(key);
    }
    this.sessionTabs.clear();
    this.tabSessions.clear();
    this.canceledTabs.clear();
    this.tabDetachEpochs.clear();
    this.pendingInput.clear();
    this.uncertainTabs.clear();
    this.downloads.clear();
    this.listeners.clear();
    this.releaseFlushWaiters();
    this.bridge.close();
  }

  /** Release Chrome's debugger on every tab this connection holds, except
   * those another live session in this process still holds, then close. A
   * detach that fails is reported by leftoverAttachments. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const leftovers: string[] = [];
    await Promise.allSettled(
      [...this.attachedTabs].map(async (tabId) => {
        if (this.releaseDebugger(tabId)) return;
        try {
          await this.bridge.request({ type: "debugger.detach", tabId });
        } catch (error) {
          // A fenced request can never be retried: the profile reconnected
          // under another generation, which accepts none of this one's.
          if (!(error instanceof AttachedBrowserBridgeError && error.code === "fenced"))
            leftovers.push(tabId);
        }
      }),
    );
    this.leftovers = leftovers;
    this.sessionTabs.clear();
    this.tabSessions.clear();
    this.canceledTabs.clear();
    this.tabDetachEpochs.clear();
    this.pendingInput.clear();
    this.uncertainTabs.clear();
    this.listeners.clear();
    this.releaseFlushWaiters();
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
        if (url !== "about:blank") this.assertNavigable(url);
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
        try {
          await this.bridge.request({ type: "tabs.close", tabId: targetId });
        } catch (error) {
          throw closeTabFailure(error);
        }
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
        if (this.resyncing)
          throw new InteractionControllerError(
            "resource_unavailable",
            "Browser connection is recovering; observe the tab again",
            true,
          );
        this.assertAttachAllowed(targetId);
        // Apply detaches Chrome already reported (one may have ended this tab's
        // attachment just now), so they cannot land on the new attachment.
        await this.flushEvents();
        this.assertAttachAllowed(targetId);
        const detachEpoch = this.tabDetachEpochs.get(targetId) ?? 0;
        const streamBreaks = this.streamBreaks;
        const attached = await this.bridge.request<{ attachment?: unknown }>({
          type: "debugger.attach",
          tabId: targetId,
        });
        if (Number.isSafeInteger(attached?.attachment) && (attached.attachment as number) > 0)
          this.tabAttachments.set(targetId, attached.attachment as number);
        else this.tabAttachments.delete(targetId);
        // Chrome's attachment exists now, whatever this session makes of it:
        // shutdown must detach it even if the session is refused below.
        this.holdDebugger(targetId);
        // Events of this attachment may be among those a break discarded.
        if (this.streamBreaks !== streamBreaks || this.resyncing)
          throw new InteractionControllerError(
            "resource_unavailable",
            "Browser connection is recovering; observe the tab again",
            true,
          );
        if ((this.tabDetachEpochs.get(targetId) ?? 0) !== detachEpoch) {
          // Chrome itself ended the attachment.
          this.releaseDebugger(targetId);
          throw new InteractionControllerError(
            "resource_unavailable",
            "Browser tab disconnected while attaching",
            !this.canceledTabs.has(targetId),
          );
        }
        const sessionId = this.tabSessions.get(targetId) ?? `attached:${targetId}:${randomUUID()}`;
        this.sessionTabs.set(sessionId, targetId);
        this.tabSessions.set(targetId, sessionId);
        return { sessionId };
      }
      default:
        throw new CdpProtocolError(method, -32_601, "CDP method is unavailable on attached Chrome");
    }
  }

  /** Chrome answers a navigation to a page the extension may not control by
   * detaching the debugger while the tab lives on. Distinguish that from a
   * closed tab or a user who canceled debugging. */
  private async navigationEndedControl(tabId: string, detachEpoch: number): Promise<boolean> {
    const deadline = Date.now() + REFUSED_NAVIGATION_DETACH_WAIT_MS;
    while ((this.tabDetachEpochs.get(tabId) ?? 0) === detachEpoch) {
      if (this.stopped || this.failure || Date.now() >= deadline) return false;
      await delay(POLL_INTERVAL_MS);
    }
    if (this.canceledTabs.has(tabId)) return false;
    try {
      const listed = await this.bridge.request<{ tabs: unknown }>({ type: "tabs.list" });
      return requireTabs(listed.tabs).some((tab) => tab.id === tabId);
    } catch {
      return false;
    }
  }

  private ensurePolling(): void {
    if (this.pollTask || this.stopped || this.failure) return;
    this.pollReady = this.pollEvents(Number.MAX_SAFE_INTEGER).then((initial) => {
      this.cursor = initial.cursor;
    });
    this.pollTask = this.poll(this.pollReady);
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

  /**
   * Delivers debugger events until the connection stops. A broken stream (lost
   * history, a timed-out or failed poll, a lost bridge socket) never ends the
   * session: the stream is re-established and every tab is treated as
   * detached, since any event since the cursor may be lost. The driver then
   * re-attaches and reads fresh page state on its next use. Only a profile
   * that reconnected under a new generation fails the connection.
   */
  private async poll(ready: Promise<void>): Promise<void> {
    let synced = true;
    try {
      await ready;
    } catch (error) {
      if (this.stopped || !this.streamBroke(error, true)) return;
      synced = false;
    }
    let retryMs = RESYNC_RETRY_MIN_MS;
    while (!this.stopped && !this.failure) {
      try {
        if (!synced) {
          await this.resynchronize();
          synced = true;
          retryMs = RESYNC_RETRY_MIN_MS;
        }
        await this.pollOnce();
      } catch (error) {
        if (this.stopped || !this.streamBroke(error, synced)) return;
        if (!synced) {
          await delay(retryMs);
          retryMs = Math.min(retryMs * 2, RESYNC_RETRY_MAX_MS);
        }
        synced = false;
      }
    }
  }

  private async pollOnce(): Promise<void> {
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
    if (batch.events.length > 0) this.lastActivityAt = Date.now();
    this.cursor = batch.cursor;
    for (const waiter of this.flushWaiters) {
      if (this.cursor >= waiter.sequence) waiter.release();
    }
    if (batch.events.length === 0 && this.flushWaiters.size === 0) await this.pollPause();
  }

  /** Whether the stream can be re-established; fails the connection if not. */
  private streamBroke(error: unknown, wasSynced: boolean): boolean {
    if (error instanceof AttachedBrowserBridgeError && error.code === "fenced") {
      this.fail(profileReconnectedError());
      return false;
    }
    if (wasSynced) {
      console.error(
        "attached Chrome debugger event stream broke; resynchronizing",
        error instanceof Error ? error.message : "unknown failure",
      );
    }
    this.resyncing = true;
    this.streamBreaks += 1;
    return true;
  }

  /** Re-establish the event cursor after a broken stream. Attachments that
   * start meanwhile wait for it, so they never miss their own events. */
  private async resynchronize(): Promise<void> {
    this.resyncing = true;
    const ready = (async () => {
      for (const tabId of [...this.tabSessions.keys()])
        this.detachLocally(tabId, "event_stream_resynchronized", { synthetic: true });
      const { cursor } = await this.pollEvents(Number.MAX_SAFE_INTEGER);
      this.cursor = cursor;
      this.resyncing = false;
    })();
    this.pollReady = ready;
    try {
      await ready;
    } finally {
      // Waiters for events from before the break cannot be satisfied.
      this.releaseFlushWaiters();
    }
  }

  /** Back to fast polling now; an idle wait ends early instead of delaying the
   * events this command causes. */
  private markActive(): void {
    this.lastActivityAt = Date.now();
    if (this.pollingIdle) this.wakePoll?.();
  }

  /** Waits one poll interval (the slow one after a quiet spell), or less when
   * a flush or a new command needs the next batch now. */
  private async pollPause(): Promise<void> {
    if (this.stopped) return;
    const idle = this.inFlight === 0 && Date.now() - this.lastActivityAt >= POLL_ACTIVE_WINDOW_MS;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        if (this.wakePoll === wake) this.wakePoll = null;
        this.pollingIdle = false;
        resolve();
      };
      const timer = setTimeout(wake, idle ? POLL_IDLE_INTERVAL_MS : POLL_INTERVAL_MS);
      this.pollingIdle = idle;
      this.wakePoll = wake;
    });
  }

  private releaseFlushWaiters(): void {
    for (const waiter of this.flushWaiters) waiter.release();
    this.wakePoll?.();
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
      // A detach of an attachment this connection has already replaced
      // (reported after the replacement attached) leaves the new one be.
      const ended = input.params.attachment;
      const current = this.tabAttachments.get(input.tabId);
      if (typeof ended === "number" && current !== undefined && ended !== current) return;
      this.detachLocally(input.tabId, input.params.reason, { synthetic: false });
      return;
    }
    if (input.method === "Page.downloadWillBegin" || input.method === "Page.downloadProgress") {
      this.forwardDownloadEvent(input.method, input.params);
    }
    const sessionId = input.sessionId ?? this.tabSessions.get(input.tabId) ?? null;
    const event: CdpEvent = { method: input.method, params: input.params, sessionId };
    this.emitEvent(event);
  }

  /** Report a controlled tab's download as Chrome's browser-wide download
   * events do, with the completed file's path. Chrome saves it in the
   * person's own downloads folder; the extension finds it there. */
  private forwardDownloadEvent(method: string, params: Record<string, unknown>): void {
    const guid = typeof params.guid === "string" ? params.guid : null;
    if (!guid || this.finishedDownloads.has(guid)) return;
    if (method === "Page.downloadWillBegin") {
      if (
        typeof params.url === "string" &&
        !this.downloads.has(guid) &&
        this.downloads.size < MAX_TRACKED_DOWNLOADS
      ) {
        this.downloads.set(guid, {
          url: params.url,
          startedAfter: new Date(Date.now() - DOWNLOAD_START_SLACK_MS).toISOString(),
        });
      }
      this.emitEvent({ method: "Browser.downloadWillBegin", params, sessionId: null });
      return;
    }
    if (params.state !== "completed") {
      if (params.state === "canceled") {
        this.downloads.delete(guid);
        this.finishedDownloads.add(guid);
      }
      this.emitEvent({ method: "Browser.downloadProgress", params, sessionId: null });
      return;
    }
    const download = this.downloads.get(guid);
    this.downloads.delete(guid);
    this.finishedDownloads.add(guid);
    void this.savedDownloadPath(download, params.receivedBytes).then((filePath) => {
      if (this.stopped) return;
      this.emitEvent({
        method: "Browser.downloadProgress",
        params: { ...params, ...(filePath ? { filePath } : {}) },
        sessionId: null,
      });
    });
  }

  /** Where Chrome saved a completed download: the oldest file of its address
   * since it began, of the size it reported, not already matched to another
   * download. Null when the extension cannot tell (one without download
   * lookup) or Chrome lists no such file. */
  private async savedDownloadPath(
    download: { url: string; startedAfter: string } | undefined,
    receivedBytes: unknown,
  ): Promise<string | null> {
    if (!download) return null;
    for (let attempt = 0; attempt < DOWNLOAD_FIND_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_FIND_RETRY_MS));
      if (this.stopped || this.failure) return null;
      let found: FoundDownload[];
      try {
        const result = await this.bridge.request<{ downloads: unknown }>({
          type: "downloads.find",
          url: download.url,
          startedAfter: download.startedAfter,
        });
        found = parseFoundDownloads(result.downloads);
      } catch {
        return null;
      }
      const match = found.find(
        (candidate) =>
          !this.claimedDownloadFiles.has(candidate.id) &&
          (typeof receivedBytes !== "number" || candidate.sizeBytes === receivedBytes),
      );
      if (match) {
        this.claimedDownloadFiles.add(match.id);
        return match.filePath;
      }
    }
    return null;
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

  /** End this connection's session for a tab. Input still in flight leaves
   * the tab uncertain, so nothing attaches underneath it, unless the
   * extension fences each attachment: then Chrome's own detach means a late
   * command can only be refused, and the tab may be attached again. A synthetic detach
   * (after a broken event stream) is not evidence that Chrome detached: it
   * keeps Chrome's debugger attachment, which a later attach reuses and
   * shutdown still detaches, and it leaves the detach epochs that only
   * Chrome's own detach events advance (a refused navigation reads them). */
  private detachLocally(
    tabId: string,
    reason: unknown,
    { synthetic }: { synthetic: boolean },
  ): void {
    const fenced = !synthetic && this.tabAttachments.has(tabId);
    if ((this.pendingInput.get(tabId) ?? 0) > 0 && !fenced) this.uncertainTabs.add(tabId);
    if (!synthetic) this.tabDetachEpochs.set(tabId, (this.tabDetachEpochs.get(tabId) ?? 0) + 1);
    const sessionId = this.tabSessions.get(tabId);
    if (reason === "canceled_by_user") this.canceledTabs.add(tabId);
    const attached = this.attachedTabs.has(tabId);
    this.removeTab(tabId);
    if (synthetic && attached) this.holdDebugger(tabId);
    if (sessionId)
      this.emitEvent({
        method: "Target.detachedFromTarget",
        sessionId: null,
        params: { sessionId, targetId: tabId, ...(reason ? { reason } : {}) },
      });
  }

  /** Chrome's debugger on this tab was released by another controller. Ends
   * this connection's session for it without making it uncertain: the
   * refused command never reached the page. */
  private forgetReleasedAttachment(tabId: string): void {
    const sessionId = this.tabSessions.get(tabId);
    this.removeTab(tabId);
    if (sessionId)
      this.emitEvent({
        method: "Target.detachedFromTarget",
        sessionId: null,
        params: { sessionId, targetId: tabId, reason: "debugger_released" },
      });
  }

  private removeTab(tabId: string): void {
    if (this.attachedTabs.has(tabId)) this.releaseDebugger(tabId);
    this.tabSessions.delete(tabId);
    this.tabAttachments.delete(tabId);
    for (const [sessionId, mappedTabId] of this.sessionTabs) {
      if (mappedTabId === tabId) this.sessionTabs.delete(sessionId);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.listeners.clear();
    this.releaseFlushWaiters();
  }
}

/** The profile's extension reconnected under a new connection generation, so
 * this session's tab attachments and event stream belong to a connection that
 * no longer exists. Retrying cannot help; a new session binds the new one. */
function profileReconnectedError(): InteractionControllerError {
  return new InteractionControllerError(
    "resource_unavailable",
    "The browser profile reconnected to Opengeni, so this browser session can no longer control it; open a new browser session",
    false,
  );
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
    url: tabUrl(tab.url),
    active: requireBoolean(tab.active, "tab active state"),
    controllable: requireBoolean(tab.controllable, "tab controllability"),
  };
}

/** A tab's address as Chrome reports it, or null when it reports none yet.
 * One tab's unusual address never fails a listing or a session's start:
 * Chrome reports a tab it has just created, or one still loading, with an
 * empty address, and a page's own address (a large data: URL) can be far
 * longer than anything we need to read of it. */
function tabUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > MAX_TAB_URL_LENGTH ? value.slice(0, MAX_TAB_URL_LENGTH) : value;
}

function mapBridgeError(method: string, error: unknown, sessionId?: string): Error {
  if (error instanceof InteractionControllerError) return error;
  if (error instanceof InteractionDefiniteDriverError) return error;
  if (error instanceof InteractionOutcomeUnknownDriverError) return error;
  if (
    error instanceof CdpProtocolError ||
    error instanceof CdpTransportError ||
    error instanceof CdpSessionDetachedError
  )
    return error;
  if (error instanceof AttachedBrowserBridgeError) {
    if (error.code === "timeout" && sessionId) return new CdpCommandTimeoutError(method, sessionId);
    if (error.code === "fenced") return profileReconnectedError();
    if (error.code === "debugger_unavailable")
      return new InteractionControllerError(
        "resource_unavailable",
        "Browser tab debugging unavailable; observe the tab again",
        true,
      );
    if (error.code === "invalid_request")
      return new CdpProtocolError(method, -32_601, error.message);
    if (error.code !== "driver_rejected") return new CdpTransportError(error.message);
    const refusal = chromeProtocolRefusal(error);
    return refusal
      ? new CdpProtocolError(method, refusal.code, refusal.message)
      : new CdpProtocolError(method, -32_000, error.message);
  }
  return new CdpTransportError(error instanceof Error ? error.message : "attached Chrome failed");
}

/** Why closing a tab failed. Chrome names a tab that is already gone; a
 * connection that ended before the extension answered leaves the close
 * unknown, since the extension may have closed the tab first. */
function closeTabFailure(error: unknown): unknown {
  if (!(error instanceof AttachedBrowserBridgeError)) return error;
  if (error.code === "driver_rejected" && /^No tab with id\b/u.test(error.message.trim()))
    return new InteractionDefiniteDriverError("target_not_found", "browser target does not exist");
  if (
    error.code === "resource_unavailable" ||
    error.code === "transport_failed" ||
    error.code === "bridge_failed" ||
    error.code === "timeout"
  )
    return new InteractionOutcomeUnknownDriverError(
      "outcome_unknown",
      "The browser profile's connection ended while closing this tab, so whether it closed is unknown; list the tabs again once the profile is connected",
      false,
    );
  return error;
}

/** chrome.debugger rejects the commands it was still handling when Chrome
 * ended the tab's attachment with exactly this message. */
function chromeDetachedDuringCommand(error: unknown): boolean {
  return (
    error instanceof AttachedBrowserBridgeError &&
    error.code === "driver_rejected" &&
    error.message.trim() === "Detached while handling command."
  );
}

/** chrome.debugger rejects a command the browser refused with the protocol's
 * own error object serialized as the message, for example
 * {"code":-32000,"message":"Not allowed"}. Unwrap it so attached Chrome
 * reports the same protocol errors as a direct CDP connection. */
export function chromeProtocolRefusal(error: unknown): { code: number; message: string } | null {
  if (!(error instanceof AttachedBrowserBridgeError) || error.code !== "driver_rejected")
    return null;
  const text = error.message.trim();
  if (!text.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.code) || typeof record.message !== "string") return null;
  return { code: record.code as number, message: record.message };
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
  "Emulation.setFocusEmulationEnabled",
  "Inspector.enable",
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

type FoundDownload = { id: number; filePath: string; sizeBytes: number };

function parseFoundDownloads(value: unknown): FoundDownload[] {
  if (!Array.isArray(value))
    throw new CdpTransportError("attached Chrome listed downloads invalidly");
  return value.map((entry) => {
    const record = requireRecord(entry, "found download");
    const { id, filePath, sizeBytes } = record;
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      typeof filePath !== "string" ||
      filePath.length === 0 ||
      filePath.length > 32_768 ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      throw new CdpTransportError("attached Chrome listed a download invalidly");
    }
    return { id, filePath, sizeBytes };
  });
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
