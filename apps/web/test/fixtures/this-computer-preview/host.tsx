// The app context and the desktop's This computer context for the preview:
// deterministic data only, stood in for by alias (see the Vite config).
import { createContext, useContext } from "react";
import type { UseThisComputerResult } from "@opengeni/react/this-computer";
import { defaultThisComputerLabels } from "@opengeni/react/this-computer";

import { scenario } from "./bridge";

export const apiBaseUrl = "https://app.example.test";

// The app host's API helpers; the page makes no API calls of its own.
export async function requestResponse(): Promise<Response> {
  return new Response("{}", { status: 404 });
}
export async function request<T>(): Promise<T> {
  throw new Error("The preview makes no API calls.");
}
export const voiceRealtimeClient = undefined;

export const DesktopContext = createContext<UseThisComputerResult | null>(null);

export function useDesktopThisComputer() {
  const computer = useContext(DesktopContext);
  return computer
    ? {
        computer,
        platform: "macos" as const,
        productName: "Opengeni",
        workspaceId: "workspace",
        labels: defaultThisComputerLabels(),
        allowPermissions: computer.allowPermissions,
        signIn: null,
      }
    : null;
}

export function useAppContext() {
  return {
    client: {
      listAttachedBrowsers: async () => ({
        revision: 1,
        bridges: [],
        devices:
          scenario === "allowed"
            ? [
                {
                  enrollmentId: "enrollment-preview",
                  state: "connected",
                  profileLabel: "Work",
                  browserName: "Google Chrome",
                },
              ]
            : [],
      }),
    },
    accessContext: { subjectId: "person", workspaceGrants: [] },
    clientConfig: { connectedMachines: true },
    workspaces: [{ id: "workspace", kind: "shared" }],
  };
}
