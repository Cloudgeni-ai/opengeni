import type { OpenGeniEmbeddingClient } from "./embedding-client";
import type { OpenGeniRequestOptions, FetchResponse } from "./client";
import type { AccessGrant } from "./types";

/** Maximum actual UTF-8 bytes forwarded for one embedded Site HTML response. */
export const SESSION_PROXY_SITE_HTML_MAX_BYTES = 25 * 1024 * 1024;

/** A streaming Site download exceeded the host proxy's actual-byte ceiling. */
export class SessionProxySiteHtmlTooLargeError extends Error {
  readonly code = "site_html_too_large";
  readonly limitBytes = SESSION_PROXY_SITE_HTML_MAX_BYTES;

  constructor() {
    super(`Site HTML exceeds the ${SESSION_PROXY_SITE_HTML_MAX_BYTES}-byte proxy limit.`);
    this.name = "SessionProxySiteHtmlTooLargeError";
  }
}

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

/** Exact association read. The API reauthorizes the source session on every call. */
export function getSessionProxyArtifactAssociation(
  client: Pick<OpenGeniEmbeddingClient, "requestJson">,
  workspaceId: string,
  sessionId: string,
  kind: "editable" | "site",
  artifactId: string,
  options: OpenGeniRequestOptions = {},
): Promise<{ sessionId: string; artifactId: string; kind: "editable" | "site" }> {
  return client.requestJson(
    "GET",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/artifact-associations/${encodeURIComponent(artifactId)}`,
    undefined,
    { kind },
    options,
  );
}

/** Authenticated response stream for the server proxy; does not buffer Site HTML. */
export function downloadSessionProxySiteHtml(
  client: Pick<OpenGeniEmbeddingClient, "requestJsonResponse">,
  workspaceId: string,
  artifactId: string,
  options: { versionId: string; signal?: AbortSignal },
): Promise<FetchResponse> {
  return client.requestJsonResponse(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/published-artifacts/${encodeURIComponent(artifactId)}/html`,
    { versionId: options.versionId },
    options,
  );
}
