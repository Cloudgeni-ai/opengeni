import type { OpenGeniEmbeddingClient } from "./embedding-client";
import type { OpenGeniRequestOptions } from "./client";
import type { AccessGrant } from "./types";

/** Server-only effective grant read; never derive external authority from access/me snapshots. */
export function getSessionProxyWorkspaceGrant(
  client: Pick<OpenGeniEmbeddingClient, "requestJson">,
  workspaceId: string,
  options: OpenGeniRequestOptions = {},
): Promise<AccessGrant> {
  return client.requestJson(
    "GET",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/access/grant`,
    undefined,
    {},
    options,
  );
}

/**
 * Exact association read: whether an artifact originated in a session. The
 * API reauthorizes the source session on every call. `retained` proves a
 * generated image or video, or a published sandbox file, came from that
 * session. A product that keeps artifact reads to the chat that produced them
 * calls it from `refuse` with the chat named in `x-opengeni-session-id`.
 */
export function getSessionProxyArtifactAssociation(
  client: Pick<OpenGeniEmbeddingClient, "requestJson">,
  workspaceId: string,
  sessionId: string,
  kind: "editable" | "site" | "retained",
  artifactId: string,
  options: OpenGeniRequestOptions = {},
): Promise<{ sessionId: string; artifactId: string; kind: "editable" | "site" | "retained" }> {
  return client.requestJson(
    "GET",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/artifact-associations/${encodeURIComponent(artifactId)}`,
    undefined,
    { kind },
    options,
  );
}
