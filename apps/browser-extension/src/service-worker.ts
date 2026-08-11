import {
  BRIDGE_PROTOCOL_VERSION,
  NATIVE_HOST_NAME,
  attachedTab,
  browserProduct,
  extensionArchitecture,
  extensionPlatform,
  parseExtensionCommand,
  parseExtensionReady,
  type AttachedTab,
  type BridgeCommand,
  type BridgeDebuggerEvent,
  type ExtensionDevice,
  type ExtensionCommandResult,
  type ExtensionHello,
  type ExtensionInventory,
} from "./protocol";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const RECONNECT_MAX_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const INVENTORY_DEBOUNCE_MS = 100;
const MAX_DEBUGGER_EVENTS = 10_000;
const MAX_DEBUGGER_EVENT_BYTES = 512 * 1024;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const ALLOWED_DEBUGGER_DOMAINS = new Set([
  "Accessibility",
  "DOM",
  "Input",
  "Log",
  "Network",
  "Page",
  "Runtime",
]);

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
let currentDeviceId: string | null = null;
let currentProfileLabel: string | null = null;
let lastError: string | null = null;
let debuggerSequence = 0;
const debuggerEvents: BridgeDebuggerEvent[] = [];
const attachedDebuggerTabs = new Set<number>();

async function storedState(): Promise<Required<StoredState>> {
  const stored = (await chrome.storage.local.get([
    "deviceId",
    "profileLabel",
    "inventoryRevision",
  ])) as StoredState;
  const deviceId = stored.deviceId ?? crypto.randomUUID();
  const profileLabel = normalizeProfileLabel(stored.profileLabel ?? null);
  const inventoryRevision = safeRevision(stored.inventoryRevision ?? 0);
  await chrome.storage.local.set({ deviceId, profileLabel, inventoryRevision });
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
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    connectionGeneration = generation;
    readyGeneration = null;
    await setBadge(false);
    port.onMessage.addListener(handleNativeMessage);
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      clearHandshakeTimer();
      lastError = chrome.runtime.lastError?.message ?? "OpenGeni agent disconnected";
      nativePort = null;
      connectionGeneration = null;
      readyGeneration = null;
      void setBadge(false);
      scheduleReconnect();
    });
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
        lastError = "OpenGeni agent did not accept this browser profile";
        port.disconnect();
      }
    }, HANDSHAKE_TIMEOUT_MS);
  } catch (error) {
    clearHandshakeTimer();
    nativePort?.disconnect();
    nativePort = null;
    connectionGeneration = null;
    readyGeneration = null;
    lastError = error instanceof Error ? error.message : String(error);
    await setBadge(false);
    scheduleReconnect();
  }
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
      reconnectDelayMs = 500;
      lastError = null;
      void setBadge(true);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      port.disconnect();
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
        active: true,
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
      await requireControllableTab(tabId);
      if (!attachedDebuggerTabs.has(tabId)) {
        await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
        attachedDebuggerTabs.add(tabId);
      }
      return { attached: true };
    }
    case "debugger.detach": {
      const tabId = numericTabId(command.tabId);
      await detachDebugger(tabId);
      return { detached: true };
    }
    case "debugger.command": {
      const tabId = numericTabId(command.tabId);
      if (!attachedDebuggerTabs.has(tabId)) {
        throw new BridgeCommandError(
          "debugger_unavailable",
          "OpenGeni is not attached to this tab",
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
    case "debugger.poll": {
      const firstSequence = debuggerEvents[0]?.sequence ?? debuggerSequence + 1;
      const available = debuggerEvents.filter((event) => event.sequence > command.afterSequence);
      const events = available.slice(0, command.limit);
      return {
        events,
        cursor: events.at(-1)?.sequence ?? debuggerSequence,
        truncated:
          (debuggerEvents.length > 0 && command.afterSequence < firstSequence - 1) ||
          available.length > events.length,
      };
    }
  }
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

function numericTabId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new BridgeCommandError("invalid_request", "browser tab id is invalid");
  }
  return id;
}

function assertAllowedDebuggerMethod(method: string): void {
  const domain = method.slice(0, method.indexOf("."));
  if (!ALLOWED_DEBUGGER_DOMAINS.has(domain)) {
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

async function sendInventory(): Promise<void> {
  const port = nativePort;
  const generation = connectionGeneration;
  const state = await storedState();
  if (!port || !generation) return;
  const message: ExtensionInventory = {
    type: "inventory",
    deviceId: state.deviceId,
    connectionGeneration: generation,
    inventoryRevision: await nextInventoryRevision(),
    tabs: await tabs(),
  };
  if (nativePort === port && connectionGeneration === generation) port.postMessage(message);
}

async function setBadge(connected: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: connected ? "" : "!" });
  if (!connected) await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  await chrome.action.setTitle({
    title: connected ? "OpenGeni Browser · Connected" : "OpenGeni Browser · Agent unavailable",
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
  if (source.tabId === undefined || !attachedDebuggerTabs.delete(source.tabId)) return;
  appendDebuggerEvent({
    tabId: String(source.tabId),
    sessionId: null,
    method: "OpenGeni.debuggerDetached",
    params: { reason },
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
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
    respond({
      connected: nativePort !== null && readyGeneration === connectionGeneration,
      deviceId: currentDeviceId,
      connectionGeneration,
      profileLabel: currentProfileLabel,
      error: lastError,
    });
    return false;
  }
  if (typed.type === "set_profile_label") {
    const profileLabel = normalizeProfileLabel(
      typeof typed.profileLabel === "string" ? typed.profileLabel : null,
    );
    void chrome.storage.local.set({ profileLabel }).then(() => {
      currentProfileLabel = profileLabel;
      nativePort?.disconnect();
      nativePort = null;
      connectionGeneration = null;
      readyGeneration = null;
      void connect();
      respond({ saved: true, profileLabel });
    });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
void connect();
