// Build-only adapter: production components are unchanged; only their data context is replaced.
import type { AppContextValue } from "../../src/context";
import type { OpenGeniClient } from "@opengeni/sdk";

export const fixtureClient = {
  listVariableSets: async () => [
    {
      id: "preview-setup",
      name: "My personal setup",
      scope: "user",
      status: "active",
      generation: 1,
      variables: [],
      description: "Example resource — no credentials",
      createdAt: "2026-09-08T00:00:00Z",
      updatedAt: "2026-09-08T00:00:00Z",
    },
  ],
  uploadFile: async () => {
    throw new Error("File upload is disabled in this review preview.");
  },
  updateSessionVariableSets: async () => {
    throw new Error("Resource changes are disabled in this review preview.");
  },
} as unknown as OpenGeniClient;

export function useAppContext(): AppContextValue {
  return {
    client: fixtureClient,
    workspaces: [{ id: "preview", settings: {} }],
    clientConfig: { voiceInput: { available: false }, fileUploads: { enabled: true } },
  } as unknown as AppContextValue;
}
