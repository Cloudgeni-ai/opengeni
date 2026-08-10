export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const NATIVE_HOST_NAME = "ai.opengeni.browser" as const;

export type AttachedTab = {
  id: string;
  windowId: number;
  index: number;
  title: string;
  url: string | null;
  active: boolean;
  pinned: boolean;
  incognito: boolean;
  audible: boolean;
  discarded: boolean;
  controllable: boolean;
  unavailableReason: string | null;
};

export type ExtensionPlatform = "linux" | "macos" | "windows";
export type ExtensionArchitecture = "x64" | "arm64";

export type ExtensionDevice = {
  id: string;
  name: string;
  profileLabel: string | null;
  browserName: string;
  browserVersion: string;
  extensionVersion: string;
  platform: ExtensionPlatform;
  architecture: ExtensionArchitecture;
  connectionGeneration: string;
  inventoryRevision: number;
  capabilities: {
    tabInventory: true;
    debuggerAttachment: true;
    semanticObservation: true;
    screenshots: true;
    liveFrames: true;
    humanInput: true;
    diagnostics: true;
    rawCdp: false;
    linkedComputer: true;
  };
};

export type ExtensionHello = {
  type: "hello";
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  device: ExtensionDevice;
  tabs: AttachedTab[];
};

export type ExtensionInventory = {
  type: "inventory";
  deviceId: string;
  connectionGeneration: string;
  inventoryRevision: number;
  tabs: AttachedTab[];
};

export type ExtensionCommandEnvelope = {
  type: "command";
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  deviceId: string;
  connectionGeneration: string;
  payload: BridgeCommand;
};

export type ExtensionReady = {
  type: "ready";
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  deviceId: string;
  connectionGeneration: string;
};

export type BridgeCommand =
  | { type: "ping" }
  | { type: "tabs.list" }
  | { type: "tabs.create"; url?: string }
  | { type: "tabs.activate"; tabId: string }
  | { type: "tabs.close"; tabId: string }
  | { type: "debugger.attach"; tabId: string }
  | { type: "debugger.detach"; tabId: string }
  | {
      type: "debugger.command";
      tabId: string;
      sessionId?: string;
      method: string;
      params: Record<string, unknown>;
    }
  | { type: "debugger.poll"; afterSequence: number; limit: number };

export type BridgeDebuggerEvent = {
  sequence: number;
  tabId: string;
  sessionId: string | null;
  method: string;
  params: Record<string, unknown>;
};

export type ExtensionCommandResult = {
  type: "command_result";
  requestId: string;
  deviceId: string;
  connectionGeneration: string;
  ok: boolean;
  payload: unknown | null;
  error: null | {
    code: string;
    message: string;
    retryable: boolean;
  };
};

export function parseExtensionCommand(value: unknown): ExtensionCommandEnvelope {
  const envelope = requireRecord(value, "bridge command envelope");
  exactKeys(envelope, [
    "type",
    "protocolVersion",
    "requestId",
    "deviceId",
    "connectionGeneration",
    "payload",
  ]);
  if (envelope.type !== "command" || envelope.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error("bridge command protocol is unsupported");
  }
  return {
    type: "command",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: requireUuid(envelope.requestId, "bridge request id"),
    deviceId: requireUuid(envelope.deviceId, "attached browser id"),
    connectionGeneration: boundedString(
      envelope.connectionGeneration,
      1,
      512,
      "browser connection generation",
    ),
    payload: parseBridgeCommand(envelope.payload),
  };
}

export function parseExtensionReady(value: unknown): ExtensionReady {
  const envelope = requireRecord(value, "bridge ready envelope");
  exactKeys(envelope, ["type", "protocolVersion", "deviceId", "connectionGeneration"]);
  if (envelope.type !== "ready" || envelope.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new Error("bridge ready protocol is unsupported");
  }
  return {
    type: "ready",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    deviceId: requireUuid(envelope.deviceId, "attached browser id"),
    connectionGeneration: boundedString(
      envelope.connectionGeneration,
      1,
      512,
      "browser connection generation",
    ),
  };
}

function parseBridgeCommand(value: unknown): BridgeCommand {
  const command = requireRecord(value, "bridge command");
  switch (command.type) {
    case "ping":
    case "tabs.list":
      exactKeys(command, ["type"]);
      return { type: command.type };
    case "tabs.create":
      exactKeys(command, ["type", "url"]);
      return command.url === undefined
        ? { type: command.type }
        : { type: command.type, url: boundedUrl(command.url) };
    case "tabs.activate":
    case "tabs.close":
    case "debugger.attach":
    case "debugger.detach":
      exactKeys(command, ["type", "tabId"]);
      return { type: command.type, tabId: requireTabId(command.tabId) };
    case "debugger.command": {
      exactKeys(command, ["type", "tabId", "sessionId", "method", "params"]);
      const params = requireRecord(command.params, "debugger command parameters");
      const sessionId =
        command.sessionId === undefined
          ? undefined
          : boundedString(command.sessionId, 1, 512, "debugger session id");
      return {
        type: command.type,
        tabId: requireTabId(command.tabId),
        ...(sessionId ? { sessionId } : {}),
        method: debuggerMethod(command.method),
        params,
      };
    }
    case "debugger.poll":
      exactKeys(command, ["type", "afterSequence", "limit"]);
      return {
        type: command.type,
        afterSequence: boundedInteger(command.afterSequence, 0, Number.MAX_SAFE_INTEGER),
        limit: boundedInteger(command.limit, 1, 1_000),
      };
    default:
      throw new Error("bridge command type is unsupported");
  }
}

function requireTabId(value: unknown): string {
  const id = boundedString(value, 1, 32, "browser tab id");
  if (!/^[1-9][0-9]*$/u.test(id) || Number(id) > 2_147_483_647) {
    throw new Error("browser tab id is invalid");
  }
  return id;
}

function debuggerMethod(value: unknown): string {
  const method = boundedString(value, 3, 256, "debugger method");
  if (!/^[A-Z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u.test(method)) {
    throw new Error("debugger method is invalid");
  }
  return method;
}

function boundedUrl(value: unknown): string {
  const url = boundedString(value, 1, 16_384, "browser URL");
  try {
    return new URL(url).href;
  } catch {
    throw new Error("browser URL must be absolute");
  }
}

function requireUuid(value: unknown, label: string): string {
  const id = boundedString(value, 36, 36, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new Error(`${label} is invalid`);
  }
  return id;
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error("bridge command integer is invalid");
  }
  return value as number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error("bridge command contains unknown fields");
  }
}

const RESTRICTED_SCHEMES = [
  "about:",
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "view-source:",
] as const;

export function attachedTab(tab: chrome.tabs.Tab): AttachedTab | null {
  if (tab.id === undefined || tab.windowId === undefined || tab.index === undefined) return null;
  const url = nonempty(tab.url) ?? nonempty(tab.pendingUrl) ?? null;
  const unavailableReason = tabUnavailableReason(url);
  return {
    id: String(tab.id),
    windowId: tab.windowId,
    index: tab.index,
    title: tab.title ?? "",
    url,
    active: tab.active,
    pinned: tab.pinned,
    incognito: tab.incognito,
    audible: tab.audible ?? false,
    discarded: tab.discarded ?? false,
    controllable: unavailableReason === null,
    unavailableReason,
  };
}

function nonempty(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export function tabUnavailableReason(url: string | null): string | null {
  if (!url) return "Chrome has not exposed this tab’s URL yet";
  const lower = url.toLowerCase();
  if (RESTRICTED_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
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

export function extensionPlatform(info: chrome.runtime.PlatformInfo): ExtensionPlatform {
  switch (info.os) {
    case "mac":
      return "macos";
    case "win":
      return "windows";
    case "linux":
    case "cros":
      return "linux";
    default:
      throw new Error(`Unsupported browser platform: ${info.os}`);
  }
}

export function extensionArchitecture(info: chrome.runtime.PlatformInfo): ExtensionArchitecture {
  switch (info.arch) {
    case "arm":
    case "arm64":
      return "arm64";
    case "x86-64":
      return "x64";
    default:
      throw new Error(`Unsupported browser architecture: ${info.arch}`);
  }
}

export function browserProduct(userAgent: string): { name: string; version: string } {
  const chrome = /(?:Chrome|CriOS)\/([^\s]+)/u.exec(userAgent);
  if (chrome) return { name: "Chrome", version: chrome[1]! };
  const chromium = /Chromium\/([^\s]+)/u.exec(userAgent);
  if (chromium) return { name: "Chromium", version: chromium[1]! };
  return { name: "Chrome", version: "unknown" };
}
