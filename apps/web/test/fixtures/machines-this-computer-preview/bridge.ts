// A stand-in for the desktop app's preload bridge, installed before any app
// module reads it. Only computer use on this computer is offered; its status
// follows `?scene=`, and the switch walks through what the real host reports.
import { DESKTOP_BRIDGE_GLOBAL, DESKTOP_BRIDGE_VERSION } from "@opengeni/sdk/desktop-bridge";
import type { ThisComputerStatus } from "@opengeni/sdk/this-computer";

export const params = new URLSearchParams(window.location.search);
export const scene = params.get("scene") ?? "off";
const machineName = "Bendik sin MacBook Pro";
const granted = [
  { id: "screenRecording" as const, granted: true },
  { id: "accessibility" as const, granted: true },
  { id: "inputMonitoring" as const, granted: true },
];
// The app runs the agent as its own helper, so permissions are the app's.
const base = {
  busy: false,
  error: null,
  machineName,
  management: "app" as const,
};
/** `?ask`: turning on finds Accessibility missing and asks macOS for it. */
const asks = params.has("ask");
const on: ThisComputerStatus = {
  ...base,
  state: "connected",
  permissions: granted,
  enrollmentId: "a2",
};
const SCENES: Record<string, ThisComputerStatus> = {
  // Never set up, turned off (paused), or removed on the server.
  off: { ...base, state: "not_connected" },
  paused: { ...base, state: "paused", enrollmentId: "a1" },
  removed: {
    ...base,
    state: "not_connected",
    errorCode: "removed",
    error: "This computer is no longer in this workspace.",
  },
  turning: { ...base, state: "connected", reconnecting: true, enrollmentId: "a2" },
  on,
  // An agent set up earlier from the web app's install command, now run by the app.
  adopted: { ...on, enrollmentId: "web-installed" },
  asking: {
    ...on,
    permissions: [
      { id: "screenRecording", granted: true },
      { id: "accessibility", granted: false },
      { id: "inputMonitoring", granted: false },
    ],
  },
  permissions: {
    ...on,
    permissions: [
      { id: "screenRecording", granted: true },
      { id: "accessibility", granted: false },
      { id: "inputMonitoring", granted: false },
    ],
  },
  signed_out: {
    ...base,
    state: "connected",
    reconnecting: true,
    errorCode: "signed_out",
    error: "Sign in again to check this computer's connection.",
  },
  offline: {
    ...base,
    state: "connected",
    reconnecting: true,
    errorCode: "offline",
    error:
      "Couldn't reach the server to check this computer's connection. Check your connection and try again.",
  },
  server_error: {
    ...base,
    state: "connected",
    reconnecting: true,
    errorCode: "unknown",
    error: "Couldn't check this computer's connection: API 503: Service Unavailable",
  },
};
let status: ThisComputerStatus = SCENES[scene] ?? SCENES.off!;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
/** Moves the computer on, e.g. the agent coming online. */
function setStatus(next: ThisComputerStatus) {
  status = next;
  changed();
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
(window as unknown as { previewSetScene(name: string): void }).previewSetScene = (name) =>
  setStatus(SCENES[name]!);

if (params.get("environment") !== "web") {
  Object.defineProperty(window, DESKTOP_BRIDGE_GLOBAL, {
    configurable: true,
    value: {
      version: DESKTOP_BRIDGE_VERSION,
      platform: "macos",
      productName: "Opengeni",
      capabilities: ["thisComputer"],
      accounts: {
        list: async () => ({ accounts: [], activeId: null }),
        switchTo: async () => undefined,
        add: async () => undefined,
        signOut: async () => undefined,
        setWorkspace: () => undefined,
        restoreWebSession: async () => false,
        onChange: () => () => undefined,
      },
      thisComputer: {
        status: async () => status,
        // A fresh registration, then the agent comes online.
        connect: async () => {
          setStatus({ ...base, state: "not_connected", busy: true });
          await wait(1_500);
          setStatus(SCENES.turning!);
          await wait(1_200);
          setStatus(asks ? SCENES.asking! : on);
          return status;
        },
        pause: async () => setStatus(SCENES.paused!),
        resume: async () => {
          await wait(800);
          setStatus(on);
        },
        disconnect: async () => setStatus(SCENES.off!),
        // macOS shows its prompt; the person allows it a moment later.
        requestPermission: async () => {
          if (asks) setTimeout(() => setStatus(on), 2_500);
        },
        onChange: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      openExternal: async () => undefined,
      setAppearance: () => undefined,
    },
  });
}
