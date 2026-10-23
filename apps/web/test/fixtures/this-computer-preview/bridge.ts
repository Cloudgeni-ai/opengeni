// A stand-in desktop bridge for the This computer preview, installed before
// the page's modules read `window.opengeniDesktop`. Only deterministic data:
// the page under it is the production route and components.
import type {
  DesktopAppShotStatus,
  DesktopComputerCapabilities,
  ThisComputerStatus,
} from "@opengeni/sdk/desktop-bridge";

export const params = new URLSearchParams(window.location.search);
/** off | mixed | needed | allowed */
export const scenario = params.get("state") ?? "needed";

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const allGranted = scenario === "allowed" || scenario === "mixed";
let capabilities: DesktopComputerCapabilities = {
  settings: {
    screenControl: scenario !== "off",
    browserExtension: scenario === "allowed" || scenario === "needed",
    microphone: scenario !== "off" && scenario !== "mixed",
  },
  microphone:
    scenario === "needed" ? "denied" : scenario === "allowed" ? "granted" : "notDetermined",
  unavailable: [],
  screenControlConnected: true,
  problems: {},
};

let status: ThisComputerStatus = {
  // All off: Computer use itself is off (paused), so nothing under it applies.
  state: scenario === "off" ? "paused" : "connected",
  busy: false,
  error: null,
  machineName: "Bendik's MacBook Pro",
  enrollmentId: "enrollment-preview",
  management: "app",
  ...(scenario === "off"
    ? {}
    : {
        permissions: [
          { id: "screenRecording" as const, granted: true },
          { id: "accessibility" as const, granted: allGranted },
          { id: "inputMonitoring" as const, granted: allGranted },
          { id: "files" as const, granted: scenario !== "needed" },
        ],
      }),
};

let appShots: DesktopAppShotStatus = {
  settings: {
    enabled: scenario === "allowed" || scenario === "mixed",
    shortcut: { kind: "modifierPair", modifier: "command" },
  },
  supported: true,
  modifierPairs: ["command", "option", "control", "shift"],
  permissions: [
    { id: "screenRecording", granted: true },
    { id: "accessibility", granted: scenario === "allowed" },
  ],
  shortcutError: null,
};

(window as unknown as Record<string, unknown>).opengeniDesktop = {
  version: 1,
  platform: "macos",
  productName: "Opengeni",
  capabilities: [
    "thisComputer",
    "thisComputerPermissions",
    "openExternal",
    "appShots",
    "computerCapabilities",
  ],
  openExternal: async () => {},
  thisComputer: {
    status: async () => status,
    connect: async () => status,
    pause: async () => {},
    resume: async () => {},
    requestPermission: async () => {},
    onChange: subscribe,
  },
  appShots: {
    status: async () => appShots,
    update: async (change: Partial<DesktopAppShotStatus["settings"]>) => {
      appShots = { ...appShots, settings: { ...appShots.settings, ...change } };
      changed();
      return appShots;
    },
    requestPermission: async () => {},
    onCapture: () => () => {},
    onChange: subscribe,
  },
  computerCapabilities: {
    status: async () => capabilities,
    update: async (change: Partial<DesktopComputerCapabilities["settings"]>) => {
      capabilities = { ...capabilities, settings: { ...capabilities.settings, ...change } };
      if (change.screenControl === false) {
        const { permissions: _hidden, ...rest } = status;
        status = rest;
      }
      changed();
      return capabilities;
    },
    requestMicrophone: async () => capabilities,
    onChange: subscribe,
  },
};
