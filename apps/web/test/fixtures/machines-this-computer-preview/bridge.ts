// A stand-in for the desktop app's preload bridge, installed before any app
// module reads it. Only "Use this computer" is offered; its status follows
// `?scene=`, and turning it on walks through what the real host reports.
import { DESKTOP_BRIDGE_GLOBAL, DESKTOP_BRIDGE_VERSION } from "@opengeni/sdk/desktop-bridge";
import type { ThisComputerStatus } from "@opengeni/sdk/this-computer";

export const params = new URLSearchParams(window.location.search);
export const scene = params.get("scene") ?? "removed";
const machineName = "Bendik sin MacBook Pro";
const granted = [
  { id: "screenRecording" as const, granted: true },
  { id: "accessibility" as const, granted: true },
  { id: "inputMonitoring" as const, granted: true },
];
const base = {
  busy: false,
  error: null,
  machineName,
  management: "service" as const,
  permissionAppName: "Opengeni Agent",
};
const SCENES: Record<string, ThisComputerStatus> = {
  removed: {
    ...base,
    state: "not_connected",
    errorCode: "removed",
    error:
      "This computer was removed from this workspace. Reconnect it to let agents use it again.",
  },
  reconnecting: { ...base, state: "connected", reconnecting: true, enrollmentId: "a2" },
  offline: {
    ...base,
    state: "connected",
    reconnecting: true,
    errorCode: "offline",
    error:
      "Couldn't reach the server to check this computer's connection. Check your connection and try again.",
  },
  connected: { ...base, state: "connected", permissions: granted, enrollmentId: "a2" },
  off: { ...base, state: "not_connected" },
};
let status: ThisComputerStatus = SCENES[scene] ?? SCENES.removed!;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
/** Moves the computer on, e.g. the agent coming online. */
function setStatus(next: ThisComputerStatus) {
  status = next;
  changed();
}
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
      thisComputer: {
        status: async () => status,
        connect: async () => {
          setStatus({ ...base, state: status.state, busy: true });
          await new Promise((resolve) => setTimeout(resolve, 400));
          // A fresh enrollment: connected, waiting for the agent to come online.
          setStatus(SCENES.reconnecting!);
          return status;
        },
        pause: async () => setStatus({ ...base, state: "paused" }),
        resume: async () => setStatus(SCENES.connected!),
        disconnect: async () => setStatus(SCENES.off!),
        requestPermission: async () => undefined,
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
