import { OpenGeniClient } from "@opengeni/sdk/artifacts";

import { apiBaseUrl, authHeadersForAccessKey, getStoredAccessKey, managedActorFetch } from "@/api";

/** One authenticated, artifact-only SDK client shared by route and session dock. */
export const editableArtifactClient = new OpenGeniClient({
  baseUrl: apiBaseUrl,
  headers: () => authHeadersForAccessKey(getStoredAccessKey()),
  fetch: (input, init) =>
    managedActorFetch(input, { ...init, credentials: init?.credentials ?? "include" }),
});
