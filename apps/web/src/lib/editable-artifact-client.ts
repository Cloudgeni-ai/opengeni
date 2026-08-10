import { OpenGeniClient } from "@opengeni/sdk/artifacts";

import { apiBaseUrl, authHeadersForAccessKey, getStoredAccessKey } from "@/api";

/** One authenticated, artifact-only SDK client shared by route and session dock. */
export const editableArtifactClient = new OpenGeniClient({
  baseUrl: apiBaseUrl,
  headers: () => authHeadersForAccessKey(getStoredAccessKey()),
  fetch: (input, init) => fetch(input, { ...init, credentials: init?.credentials ?? "include" }),
});
