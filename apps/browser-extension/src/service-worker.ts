import { BRAND } from "./brand";
import { HANDSHAKE_TIMEOUT_ERROR, agentStatus } from "./agent-status";
import {
  BRIDGE_PROTOCOL_VERSION,
  NATIVE_HOST_NAME,
  attachedTab,
  browserProduct,
  extensionArchitecture,
  extensionPlatform,
  isAgentUnavailable,
  isAllowedDebuggerMethod,
  parseAgentUnavailable,
  parseExtensionCommand,
  parseExtensionReady,
  type AgentUnavailable,
  type AttachedTab,
  type BridgeCommand,
  type FoundDownload,
  type BridgeDebuggerEvent,
  type ExtensionDevice,
  type ExtensionCommandResult,
  type ExtensionHello,
  type ExtensionInventory,
} from "./protocol";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const RECONNECT_MAX_MS = 30_000;
// Chrome's shortest alarm period; it wakes a stopped worker to reconnect.
const RECONNECT_ALARM = "reconnect";
const RECONNECT_ALARM_PERIOD_MINUTES = 0.5;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const INVENTORY_DEBOUNCE_MS = 100;
const MAX_DEBUGGER_EVENTS = 10_000;
const MAX_DEBUGGER_EVENT_BYTES = 512 * 1024;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
// Once no agent command has arrived for this long, attached tabs are treated as
// idle and a downloaded update is applied even though they are still attached.
const UPDATE_IDLE_RELOAD_MS = 15 * 60_000;
// Chrome throttles update checks; asking again sooner than this gains nothing.
const UPDATE_CHECK_INTERVAL_MS = 10 * 60_000;
// Chrome ends an extension's debugging of a whole tab the moment another
// extension adds one of its own pages to it as a frame, and refuses to attach
// again while that frame is there; Chromium treats this as intended. Password
// managers do it whenever a login field gets focus, to show their inline menu.
// So when Chrome ends debugging of a tab, or refuses to attach to one, the
// extension removes other extensions' frames from it. A page that keeps adding
// them is left alone after this many removals in this window.
const FRAME_REMOVAL_LIMIT = 5;
const FRAME_REMOVAL_WINDOW_MS = 30_000;
// Extensions known to add such frames, named in the error when one keeps doing it.
const FRAME_EXTENSION_NAMES: Readonly<Record<string, string>> = {
  aeblfdkhhhdcdjpifhhbdiojplfjncoa: "1Password",
  nngceckbapebfimnlniiiahkandclblb: "Bitwarden",
  hdokiejnpimakedhajhdlcegeplioahd: "LastPass",
  fdjamakpfbbddfjaooikfcpapjohcfmg: "Dashlane",
};

type StoredState = {
  deviceId?: string;
  profileLabel?: string | null;
  inventoryRevision?: number;
};

let nativePort: chrome.runtime.Port | null = null;
let connectionGeneration: string | null = null;
let readyGeneration: string | null = null;
let reconnectDelayMs = 500;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
let inventoryTimer: ReturnType<typeof setTimeout> | null = null;
let inventoryPublication: Promise<void> = Promise.resolve();
let currentDeviceId: string | null = null;
let currentProfileLabel: string | null = null;
let lastError: string | null = null;
// The agent side's own explanation for the last refused connection.
let lastRefusal: AgentUnavailable | null = null;
let lastUpdateCheckAtMs = 0;
// The agent accepted this profile at least once in this worker's lifetime.
let everConnected = false;
let debuggerSequence = 0;
const debuggerEvents: BridgeDebuggerEvent[] = [];
// Attached tabs, each with the number of its current attachment. Commands that
// name an attachment are refused once it has ended, so a late one can never
// run under a newer attachment of the same tab.
const attachedDebuggerTabs = new Map<number, number>();
// Starts at a random number, so a number from before this worker restarted
// does not name one of its attachments.
let lastAttachment = Math.floor(Math.random() * 2 ** 40);
// Removals of other extensions' frames still running, and when each tab's
// recent removals started.
const frameRemovals = new Map<number, Promise<readonly string[] | null>>();
const frameRemovalTimes = new Map<number, number[]>();
// Other extensions whose frames were last removed from each tab.
const removedFrameExtensions = new Map<number, readonly string[]>();
let updatePending = false;
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let commandsInFlight = 0;
let lastAgentCommandAtMs = Date.now();
// Tab ids, debugger attachments and the event buffer above live exactly as long
// as this worker. Every native reconnect in that lifetime reports the same
// state generation, so the agent can keep sessions bound across agent or
// native-host restarts while the per-port connection generation still fences
// each transport.
const STATE_GENERATION = crypto.randomUUID();

async function storedState(): Promise<Required<StoredState>> {
  const stored = (await chrome.storage.local.get([
    "deviceId",
    "profileLabel",
    "inventoryRevision",
  ])) as StoredState;
  const deviceId = stored.deviceId ?? crypto.randomUUID();
  const profileLabel = normalizeProfileLabel(stored.profileLabel ?? null);
  const inventoryRevision = safeRevision(stored.inventoryRevision ?? 0);
  // Reading inventory must not write a stale label back over a concurrent
  // rename. Only the first device identity needs initializing here.
  if (!stored.deviceId) await chrome.storage.local.set({ deviceId });
  return { deviceId, profileLabel, inventoryRevision };
}

function normalizeProfileLabel(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized.slice(0, 200) : null;
}

function safeRevision(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function nextInventoryRevision(): Promise<number> {
  const state = await storedState();
  const revision =
    state.inventoryRevision >= Number.MAX_SAFE_INTEGER ? 1 : state.inventoryRevision + 1;
  await chrome.storage.local.set({ inventoryRevision: revision });
  return revision;
}

async function tabs(): Promise<AttachedTab[]> {
  return (await chrome.tabs.query({}))
    .map(attachedTab)
    .filter((tab): tab is AttachedTab => tab !== null)
    .sort((left, right) => left.windowId - right.windowId || left.index - right.index);
}

async function device(revision: number, generation: string): Promise<ExtensionDevice> {
  const [state, platform] = await Promise.all([storedState(), chrome.runtime.getPlatformInfo()]);
  const product = browserProduct(navigator.userAgent);
  currentDeviceId = state.deviceId;
  currentProfileLabel = state.profileLabel;
  return {
    id: state.deviceId,
    name: state.profileLabel ?? "Chrome profile",
    profileLabel: state.profileLabel,
    browserName: product.name,
    browserVersion: product.version,
    extensionVersion: EXTENSION_VERSION,
    platform: extensionPlatform(platform),
    architecture: extensionArchitecture(platform),
    connectionGeneration: generation,
    stateGeneration: STATE_GENERATION,
    inventoryRevision: revision,
    capabilities: {
      tabInventory: true,
      debuggerAttachment: true,
      semanticObservation: true,
      screenshots: true,
      liveFrames: true,
      humanInput: true,
      diagnostics: true,
      rawCdp: false,
      linkedComputer: true,
    },
  };
}

async function connect(): Promise<void> {
  if (nativePort) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const generation = crypto.randomUUID();
  let port: chrome.runtime.Port | null = null;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    const connectingPort = port;
    nativePort = port;
    connectionGeneration = generation;
    readyGeneration = null;
    port.onMessage.addListener((message: unknown) => {
      if (nativePort === connectingPort) handleNativeMessage(message);
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message ?? `${BRAND.product} agent disconnected`;
      disconnectPort(connectingPort, error);
    });
    await setBadge(false);
    const revision = await nextInventoryRevision();
    const hello: ExtensionHello = {
      type: "hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      device: await device(revision, generation),
      tabs: await tabs(),
    };
    if (nativePort !== port || connectionGeneration !== generation) return;
    port.postMessage(hello);
    handshakeTimer = setTimeout(() => {
      if (
        nativePort === port &&
        connectionGeneration === generation &&
        readyGeneration !== generation
      ) {
        disconnectPort(connectingPort, HANDSHAKE_TIMEOUT_ERROR);
      }
    }, HANDSHAKE_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (port) {
      disconnectPort(port, message);
    } else if (!nativePort) {
      lastError = message;
      lastRefusal = null;
      void setBadge(false);
      scheduleReconnect();
    }
  }
}

// Locally calling Port.disconnect() does not fire our onDisconnect listener.
// Clear the exact port before closing it; stale events must not reset a successor.
function disconnectPort(
  port: chrome.runtime.Port,
  error: string,
  refusal: AgentUnavailable | null = null,
): void {
  if (nativePort !== port) return;
  clearHandshakeTimer();
  nativePort = null;
  connectionGeneration = null;
  readyGeneration = null;
  lastError = error;
  lastRefusal = refusal;
  port.disconnect();
  void setBadge(false);
  scheduleReconnect();
}

function clearHandshakeTimer(): void {
  if (!handshakeTimer) return;
  clearTimeout(handshakeTimer);
  handshakeTimer = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function handleNativeMessage(message: unknown): void {
  const port = nativePort;
  const generation = connectionGeneration;
  if (!port || !generation) return;
  if (isAgentUnavailable(message)) {
    // The agent side cannot take this connection and says why before closing.
    const refusal = parseAgentUnavailable(message);
    if (refusal.reason === "extension_outdated") requestExtensionUpdate();
    disconnectPort(
      port,
      `${BRAND.product} agent unavailable: ${refusal.reason}${refusal.detail ? ` (${refusal.detail})` : ""}`,
      refusal,
    );
    return;
  }
  if (
    message !== null &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "ready"
  ) {
    try {
      const ready = parseExtensionReady(message);
      if (ready.deviceId !== currentDeviceId || ready.connectionGeneration !== generation) {
        throw new Error("bridge ready fence does not match this browser profile");
      }
      clearHandshakeTimer();
      readyGeneration = generation;
      everConnected = true;
      reconnectDelayMs = 500;
      lastError = null;
      lastRefusal = null;
      void setBadge(true);
      // Catch changes made during the handshake on the accepted generation.
      void sendInventory();
    } catch (error) {
      disconnectPort(port, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  void settleCommand(port, generation, message);
}

async function settleCommand(
  port: chrome.runtime.Port,
  generation: string,
  message: unknown,
): Promise<void> {
  commandsInFlight += 1;
  try {
    await settleCommandNow(port, generation, message);
  } finally {
    commandsInFlight -= 1;
    maybeApplyUpdate();
  }
}

async function settleCommandNow(
  port: chrome.runtime.Port,
  generation: string,
  message: unknown,
): Promise<void> {
  let requestId: string = crypto.randomUUID();
  let deviceId: string = currentDeviceId ?? crypto.randomUUID();
  let result: ExtensionCommandResult;
  try {
    const command = parseExtensionCommand(message);
    requestId = command.requestId;
    deviceId = command.deviceId;
    if (command.deviceId !== currentDeviceId || command.connectionGeneration !== generation) {
      throw new BridgeCommandError("fenced", "attached browser connection changed", true);
    }
    // Event polling and pings continue while nothing is happening; only real
    // tab and debugger work counts as an agent using this browser.
    if (command.payload.type !== "debugger.poll" && command.payload.type !== "ping") {
      lastAgentCommandAtMs = Date.now();
    }
    result = {
      type: "command_result",
      requestId,
      deviceId,
      connectionGeneration: generation,
      ok: true,
      payload: await executeBridgeCommand(command.payload),
      error: null,
    };
  } catch (error) {
    const failure = bridgeCommandFailure(error);
    result = {
      type: "command_result",
      requestId,
      deviceId,
      connectionGeneration: generation,
      ok: false,
      payload: null,
      error: failure,
    };
  }
  if (nativePort === port && connectionGeneration === generation) port.postMessage(result);
}

async function executeBridgeCommand(command: BridgeCommand): Promise<unknown> {
  switch (command.type) {
    case "ping":
      return { pong: true };
    case "tabs.list":
      return { tabs: await tabs() };
    case "tabs.create": {
      const created = await chrome.tabs.create({
        // Opengeni renders and controls attached tabs in its own Browser panel.
        // Creating a target must not steal focus or raise Chrome on the user's
        // desktop; an explicit user action can still activate a tab separately.
        active: false,
        ...(command.url ? { url: command.url } : {}),
      });
      const tab = attachedTab(created);
      if (!tab) throw new BridgeCommandError("tab_unavailable", "Chrome did not create a tab");
      scheduleInventory();
      return { tab };
    }
    case "tabs.activate": {
      const tabId = numericTabId(command.tabId);
      const updated = await chrome.tabs.update(tabId, { active: true });
      const tab = updated ? attachedTab(updated) : null;
      if (!tab) throw new BridgeCommandError("tab_unavailable", "Chrome tab is unavailable");
      return { tab };
    }
    case "tabs.close": {
      const tabId = numericTabId(command.tabId);
      if (attachedDebuggerTabs.has(tabId)) await detachDebugger(tabId);
      await chrome.tabs.remove(tabId);
      scheduleInventory();
      return { tabs: await tabs() };
    }
    case "debugger.attach": {
      const tabId = numericTabId(command.tabId);
      // Right after Chrome ended debugging of this tab, wait for the frames
      // that ended it to be removed.
      await frameRemovals.get(tabId);
      await requireControllableTab(tabId);
      if (!attachedDebuggerTabs.has(tabId)) await attachDebugger(tabId);
      return { attached: true, attachment: attachedDebuggerTabs.get(tabId) };
    }
    case "debugger.detach": {
      const tabId = numericTabId(command.tabId);
      await detachDebugger(tabId);
      return { detached: true };
    }
    case "debugger.command": {
      const tabId = numericTabId(command.tabId);
      const attachment = attachedDebuggerTabs.get(tabId);
      if (attachment === undefined) {
        throw new BridgeCommandError(
          "debugger_unavailable",
          `${BRAND.product} is not attached to this tab`,
        );
      }
      if (command.attachment !== undefined && command.attachment !== attachment) {
        throw new BridgeCommandError(
          "debugger_unavailable",
          `The ${BRAND.product} attachment this command was sent for has ended`,
        );
      }
      assertAllowedDebuggerMethod(command.method);
      const source: chrome.debugger.Debuggee = {
        tabId,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      };
      const response = await chrome.debugger.sendCommand(source, command.method, command.params);
      return { result: response ?? {} };
    }
    case "downloads.find":
      return { downloads: await findDownloads(command.url, command.startedAfter) };
    case "debugger.poll": {
      const firstSequence = debuggerEvents[0]?.sequence ?? debuggerSequence + 1;
      const available = debuggerEvents.filter((event) => event.sequence > command.afterSequence);
      const events = available.slice(0, command.limit);
      return {
        events,
        cursor: events.at(-1)?.sequence ?? debuggerSequence,
        // Pagination is not history loss: the next poll continues from cursor.
        truncated: debuggerEvents.length > 0 && command.afterSequence < firstSequence - 1,
      };
    }
  }
}

const MAX_FOUND_DOWNLOADS = 16;

/** Completed downloads of one address since a time, as Chrome saved them. */
async function findDownloads(url: string, startedAfter: string): Promise<FoundDownload[]> {
  const found = new Map<number, chrome.downloads.DownloadItem>();
  for (const query of [{ url }, { finalUrl: url }]) {
    for (const item of await chrome.downloads.search({ ...query, startedAfter, state: "complete" }))
      found.set(item.id, item);
  }
  return [...found.values()]
    .filter((item) => item.exists && item.filename.length > 0)
    .sort((left, right) => left.startTime.localeCompare(right.startTime))
    .slice(0, MAX_FOUND_DOWNLOADS)
    .map((item) => ({
      id: item.id,
      filePath: item.filename,
      sizeBytes: item.fileSize >= 0 ? item.fileSize : item.bytesReceived,
    }));
}

async function requireControllableTab(tabId: number): Promise<void> {
  const tab = attachedTab(await chrome.tabs.get(tabId));
  if (!tab) throw new BridgeCommandError("tab_unavailable", "Chrome tab is unavailable");
  if (!tab.controllable) {
    throw new BridgeCommandError(
      "tab_unavailable",
      tab.unavailableReason ?? "Chrome does not permit control of this tab",
    );
  }
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!attachedDebuggerTabs.delete(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached is the desired idempotent state.
  }
}

/** Attaches Chrome's debugger to a tab, first removing other extensions'
 * frames when Chrome refuses because of one. */
async function attachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  } catch (error) {
    if (!otherExtensionFrameRefusal(error)) throw error;
    const removed = await removeOtherExtensionFrames(tabId);
    if (removed === null) throw otherExtensionFramesError(tabId);
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    } catch (retry) {
      if (!otherExtensionFrameRefusal(retry)) throw retry;
      throw removed.length > 0 ? otherExtensionFramesError(tabId) : unremovableFrameError();
    }
  }
  // Another attach of this tab may have finished first; keep its number.
  if (!attachedDebuggerTabs.has(tabId)) attachedDebuggerTabs.set(tabId, ++lastAttachment);
}

/** Chrome refuses to attach to a tab holding another extension's page with
 * "Cannot access a chrome-extension:// URL of different extension". */
function otherExtensionFrameRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes("chrome-extension://");
}

function otherExtensionFramesError(tabId: number): BridgeCommandError {
  const names = [
    ...new Set((removedFrameExtensions.get(tabId) ?? []).map((id) => FRAME_EXTENSION_NAMES[id])),
  ].filter((name): name is string => name !== undefined);
  const culprit = names.length > 0 ? names.join(" and ") : "Another browser extension";
  return new BridgeCommandError(
    "tab_unavailable",
    `${culprit} keeps adding its own frame to this page (password managers do this for ` +
      `their inline menu), and Chrome does not let ${BRAND.product} control a tab while it ` +
      "has one. Turn off that extension's inline menu for this site, or use a managed browser",
  );
}

function unremovableFrameError(): BridgeCommandError {
  return new BridgeCommandError(
    "tab_unavailable",
    "This page holds another browser extension's page, which Chrome does not let " +
      `${BRAND.product} control a tab with, and it could not be removed. Turn off that ` +
      "extension for this site, or use a managed browser",
  );
}

/** Starts removing other extensions' frames from a tab Chrome stopped
 * debugging; an attach of that tab waits for it. */
function startFrameRemoval(tabId: number): void {
  if (frameRemovals.has(tabId)) return;
  frameRemovals.set(
    tabId,
    removeOtherExtensionFrames(tabId).finally(() => frameRemovals.delete(tabId)),
  );
}

/** Removes frames showing other extensions' pages from every frame of a tab.
 * Returns those extensions' ids, or null once the tab has used up its recent
 * removals. */
async function removeOtherExtensionFrames(tabId: number): Promise<readonly string[] | null> {
  const now = Date.now();
  const recent = (frameRemovalTimes.get(tabId) ?? []).filter(
    (time) => now - time < FRAME_REMOVAL_WINDOW_MS,
  );
  frameRemovalTimes.set(tabId, recent);
  if (recent.length >= FRAME_REMOVAL_LIMIT) return null;
  recent.push(now);
  const run = (target: chrome.scripting.InjectionTarget) =>
    chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: removeFramesOfOtherExtensions,
      args: [chrome.runtime.id],
    });
  let results: Awaited<ReturnType<typeof run>>;
  try {
    results = await run({ tabId, allFrames: true });
  } catch {
    try {
      results = await run({ tabId });
    } catch {
      // A closed tab, or a page Chrome does not let extensions script.
      return [];
    }
  }
  const removed = [
    ...new Set(
      results.flatMap((result) =>
        Array.isArray(result.result)
          ? result.result.filter((id): id is string => typeof id === "string")
          : [],
      ),
    ),
  ];
  if (removed.length > 0) {
    removedFrameExtensions.set(tabId, removed);
    console.warn(`removed other extensions' frames from tab ${tabId}: ${removed.join(", ")}`);
  }
  return removed;
}

/** Runs in a page frame, in this extension's isolated world: removes elements
 * showing another extension's page, also inside closed shadow roots (where
 * password managers put their inline menus), and returns those extensions'
 * ids. Self-contained, since Chrome runs it from its source. */
function removeFramesOfOtherExtensions(ownId: string): string[] {
  const removed = new Set<string>();
  const shadowRootOf = (element: Element): ShadowRoot | null => {
    try {
      return chrome.dom.openOrClosedShadowRoot(element as HTMLElement) ?? null;
    } catch {
      return element.shadowRoot;
    }
  };
  const visit = (root: Document | ShadowRoot): void => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      const source =
        element instanceof HTMLIFrameElement ||
        element instanceof HTMLFrameElement ||
        element instanceof HTMLEmbedElement
          ? element.src
          : element instanceof HTMLObjectElement
            ? element.data
            : "";
      const id = /^chrome-extension:\/\/([a-p]{32})\//i.exec(source)?.[1]?.toLowerCase();
      if (id && id !== ownId) {
        removed.add(id);
        element.remove();
        continue;
      }
      const shadow = shadowRootOf(element);
      if (shadow) visit(shadow);
    }
  };
  visit(document);
  return [...removed];
}

/**
 * Chrome downloads a new extension version but installs it only when this
 * worker stops, and the native port keeps the worker running for as long as
 * Chrome does. Without this, a fix reaches the person's browser only after
 * they restart Chrome. Reloading ends this worker's debugger attachments, so
 * it waits until no agent is driving a tab: nothing attached, or no agent
 * command for UPDATE_IDLE_RELOAD_MS, and never during a command.
 */
// When the agent reports this extension as the outdated side, fetch the
// update now instead of waiting for Chrome's periodic check. An available
// update raises onUpdateAvailable, and with no agent connected nothing is
// attached, so it applies at once.
function requestExtensionUpdate(): void {
  const now = Date.now();
  if (now - lastUpdateCheckAtMs < UPDATE_CHECK_INTERVAL_MS) return;
  lastUpdateCheckAtMs = now;
  void chrome.runtime.requestUpdateCheck?.().catch(() => undefined);
}

function maybeApplyUpdate(): void {
  if (!updatePending || commandsInFlight > 0) return;
  const idleMs = Date.now() - lastAgentCommandAtMs;
  if (attachedDebuggerTabs.size === 0 || idleMs >= UPDATE_IDLE_RELOAD_MS) {
    chrome.runtime.reload();
    return;
  }
  if (updateTimer !== null) return;
  updateTimer = setTimeout(
    () => {
      updateTimer = null;
      maybeApplyUpdate();
    },
    Math.max(1_000, UPDATE_IDLE_RELOAD_MS - idleMs),
  );
}

function numericTabId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new BridgeCommandError("invalid_request", "browser tab id is invalid");
  }
  return id;
}

function assertAllowedDebuggerMethod(method: string): void {
  if (!isAllowedDebuggerMethod(method)) {
    throw new BridgeCommandError(
      "invalid_request",
      "debugger method is outside the browser driver surface",
    );
  }
}

class BridgeCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function bridgeCommandFailure(error: unknown): NonNullable<ExtensionCommandResult["error"]> {
  if (error instanceof BridgeCommandError) {
    return {
      code: error.code,
      message: boundedErrorMessage(error.message),
      retryable: error.retryable,
    };
  }
  return {
    code: "driver_failed",
    message: boundedErrorMessage(error instanceof Error ? error.message : "Chrome command failed"),
    retryable: false,
  };
}

function boundedErrorMessage(value: string): string {
  const normalized = value.trim();
  return (normalized || "Chrome command failed").slice(0, 8_192);
}

function scheduleInventory(): void {
  if (inventoryTimer) clearTimeout(inventoryTimer);
  inventoryTimer = setTimeout(() => {
    inventoryTimer = null;
    void sendInventory();
  }, INVENTORY_DEBOUNCE_MS);
}

function sendInventory(): Promise<void> {
  // One ordered publication stream keeps storage-backed revisions unique and
  // prevents an older tab/label snapshot from overtaking a newer one.
  const publication = inventoryPublication.then(publishInventory);
  inventoryPublication = publication.catch(() => undefined);
  return publication;
}

async function publishInventory(): Promise<void> {
  const port = nativePort;
  const generation = connectionGeneration;
  const state = await storedState();
  if (!port || !generation || readyGeneration !== generation) return;
  const message: ExtensionInventory = {
    type: "inventory",
    deviceId: state.deviceId,
    connectionGeneration: generation,
    inventoryRevision: await nextInventoryRevision(),
    profile: { profileLabel: state.profileLabel },
    tabs: await tabs(),
  };
  if (nativePort === port && connectionGeneration === generation) port.postMessage(message);
}

async function setBadge(connected: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: connected ? "" : "!" });
  if (!connected) await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  await chrome.action.setTitle({
    title: `${BRAND.name} · ${connected ? "Connected" : "Runner unavailable"}`,
  });
}

chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  if (source.tabId === undefined || !attachedDebuggerTabs.has(source.tabId)) return;
  appendDebuggerEvent({
    tabId: String(source.tabId),
    sessionId: debuggerSessionId(source),
    method,
    params: boundedDebuggerParams(params),
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  const attachment = attachedDebuggerTabs.get(source.tabId);
  if (attachment === undefined) return;
  attachedDebuggerTabs.delete(source.tabId);
  appendDebuggerEvent({
    tabId: String(source.tabId),
    sessionId: null,
    method: "OpenGeni.debuggerDetached",
    params: { reason, attachment },
  });
  // Chrome reports a tab it stopped debugging because another extension
  // added a frame as closed, though it stays open. Remove such frames, so
  // the agent's next attach works.
  if (reason === "target_closed") startFrameRemoval(source.tabId);
  maybeApplyUpdate();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  frameRemovalTimes.delete(tabId);
  removedFrameExtensions.delete(tabId);
  appendDebuggerEvent({
    tabId: String(tabId),
    sessionId: null,
    method: "Target.targetDestroyed",
    params: { targetId: String(tabId) },
  });
});

function appendDebuggerEvent(event: Omit<BridgeDebuggerEvent, "sequence">): void {
  debuggerSequence = debuggerSequence >= Number.MAX_SAFE_INTEGER ? 1 : debuggerSequence + 1;
  if (debuggerSequence === 1) debuggerEvents.length = 0;
  debuggerEvents.push({ sequence: debuggerSequence, ...event });
  if (debuggerEvents.length > MAX_DEBUGGER_EVENTS) {
    debuggerEvents.splice(0, debuggerEvents.length - MAX_DEBUGGER_EVENTS);
  }
}

function boundedDebuggerParams(params: object): Record<string, unknown> {
  const value = params as Record<string, unknown>;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_DEBUGGER_EVENT_BYTES) {
      return value;
    }
  } catch {
    // Fall through to an explicit truncation marker.
  }
  return { opengeniTruncated: true };
}

function debuggerSessionId(source: chrome.debugger.Debuggee): string | null {
  const value = (source as chrome.debugger.Debuggee & { sessionId?: unknown }).sessionId;
  return typeof value === "string" && value.length <= 512 ? value : null;
}

for (const event of [
  chrome.tabs.onCreated,
  chrome.tabs.onUpdated,
  chrome.tabs.onRemoved,
  chrome.tabs.onMoved,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabs.onActivated,
  chrome.tabs.onReplaced,
]) {
  event.addListener(scheduleInventory as never);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
  if (!message || typeof message !== "object" || !("type" in message)) return false;
  const typed = message as { type: string; profileLabel?: unknown };
  if (typed.type === "status") {
    const connected = nativePort !== null && readyGeneration === connectionGeneration;
    const status = connected
      ? null
      : agentStatus(lastError ? { error: lastError, everConnected, refusal: lastRefusal } : null);
    respond({
      connected,
      deviceId: currentDeviceId,
      connectionGeneration,
      profileLabel: currentProfileLabel,
      error: lastError,
      title: status?.title ?? null,
      detail: status?.detail ?? null,
    });
    return false;
  }
  if (typed.type === "set_profile_label") {
    const profileLabel = normalizeProfileLabel(
      typeof typed.profileLabel === "string" ? typed.profileLabel : null,
    );
    void chrome.storage.local.set({ profileLabel }).then(() => {
      currentProfileLabel = profileLabel;
      // A label is inventory metadata, not a new connection authority. Keep
      // active debuggers and pending command replies on the same native port.
      void sendInventory();
      respond({ saved: true, profileLabel });
    });
    return true;
  }
  return false;
});

chrome.runtime.onUpdateAvailable?.addListener(() => {
  updatePending = true;
  maybeApplyUpdate();
});
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
// Chrome stops an idle service worker, and a stopped worker's reconnect timer
// dies with it. Without a wake-up, a dropped agent connection stays down until
// the person happens to touch a tab. An alarm restarts a stopped worker, and
// its handler reconnects when nothing is connected.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativePort) void connect();
});
void chrome.alarms
  .create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES })
  .catch(() => undefined);
void connect();
