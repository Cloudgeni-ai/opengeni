// Build-only adapter: production components are unchanged; only their data context is replaced.
import type { AppContextValue } from "../../src/context";
import type { OpenGeniClient } from "@opengeni/sdk";

export const fixtureClient = {
  uploadFile: async () => {
    throw new Error("File upload is disabled in this review preview.");
  },
} as unknown as OpenGeniClient;

export function useAppContext(): AppContextValue {
  return {
    client: fixtureClient,
    workspaces: [{ id: "preview", settings: {} }],
    clientConfig: { voiceInput: { available: false }, fileUploads: { enabled: true } },
  } as unknown as AppContextValue;
}
