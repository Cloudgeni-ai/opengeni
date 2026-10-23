// Deterministic host data only. The preview renders the production connection components.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { MachineView } from "@opengeni/sdk";
import type { ThisComputerHost, ThisComputerStatus } from "@opengeni/sdk/this-computer";
import type { UseThisComputerResult } from "@opengeni/react/this-computer";
import { defaultThisComputerLabels } from "@opengeni/react/this-computer";

export const apiBaseUrl = "https://app.example.test";
export const params = new URLSearchParams(window.location.search);
const listeners = new Set<() => void>();
let status: ThisComputerStatus = {
  state: "not_installed",
  busy: false,
  error: null,
  machineName: "My laptop",
};
let machines: MachineView[] = [];
const changed = () => listeners.forEach((listener) => listener());
export const host: ThisComputerHost = {
  productName: "Example App",
  platform: params.get("platform") === "macos" ? "macos" : "linux",
  status: async () => status,
  connect: async () => {
    status = { ...status, busy: true };
    changed();
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (params.has("failure")) {
      status = { ...status, busy: false };
      changed();
      throw new Error("The app couldn't reach the server. Try again.");
    }
    status = {
      ...status,
      state: "connected",
      busy: false,
      ...(params.has("permissions")
        ? { permissions: [{ id: "screenRecording" as const, granted: false }] }
        : {}),
    };
    machines = [
      {
        sandboxId: "computer",
        enrollmentId: "enrollment",
        name: "My laptop",
        state: "online",
        scope: "user",
        active: false,
        kind: "selfhosted",
        hasDisplay: false,
        isSessionGroup: false,
      } as MachineView,
    ];
    changed();
    return status;
  },
  pause: async () => {},
  resume: async () => {},
  requestPermission: async () => {
    status = { ...status, permissions: [{ id: "screenRecording", granted: true }] };
    changed();
  },
  onChange: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
export const DesktopContext = createContext<{
  computer: UseThisComputerResult;
  allowPermissions(): void;
} | null>(null);
export function useDesktopThisComputer() {
  const value = useContext(DesktopContext);
  return params.get("environment") === "desktop" && value
    ? {
        ...value,
        platform: host.platform,
        productName: "Opengeni",
        workspaceId: "workspace",
        labels: defaultThisComputerLabels(),
      }
    : null;
}
export function useWorkspaceMachines() {
  const snapshot = useSyncExternalStore(host.onChange, () => machines);
  return {
    machines: snapshot,
    loading: false,
    error: null,
    mutationError: null,
    attaching: false,
    canRead: true,
    canManage: true,
    canAttach: true,
    attach: async () => true,
    refresh: async () => {},
  };
}
export function useAppContext() {
  return {
    client: {
      listAttachedBrowsers: async () => ({ devices: [] }),
      mintEnrollToken: async (_workspace: string, choice: object) => ({
        token: "preview-only",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        expiresInSeconds: 3600,
        ...choice,
      }),
      sendMessage: async () => ({}),
    },
    accessContext: {
      subjectId: "person",
      workspaceGrants: [
        {
          workspaceId: "workspace",
          permissions: ["enrollments:read", "enrollments:manage", "sessions:control"],
        },
      ],
    },
    workspaces: [{ id: "workspace", kind: "shared" }],
  };
}
