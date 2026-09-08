import type { ConnectTransport } from "@opengeni/connect";
import type { SiteClient } from "@opengeni/react/sites";

export async function hostRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-embedded-product": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok)
    throw new Error(`Host request failed (${response.status}); refresh live state.`);
  return response.json();
}
const id = encodeURIComponent;
/** Workspace/actor are admitted by the host, never taken from these arguments. */
export const connect: ConnectTransport = {
  catalog: (_workspace, options) => hostRequest("connect/catalog", "GET", undefined, options),
  accounts: (_workspace, options) => hostRequest("connect/accounts", "GET", undefined, options),
  pending: (_workspace, options) => hostRequest("connect/attempts", "GET", undefined, options),
  begin: (_workspace, body, options) => hostRequest("connect/attempts", "POST", body, options),
  get: (_workspace, attempt, options) =>
    hostRequest(`connect/attempts/${id(attempt)}`, "GET", undefined, options),
  advance: (_workspace, attempt, body, options) =>
    hostRequest(`connect/attempts/${id(attempt)}/advance`, "POST", body, options),
  cancel: (_workspace, attempt, body, options) =>
    hostRequest(`connect/attempts/${id(attempt)}/cancel`, "POST", body, options),
  disconnect: (_workspace, account, options) =>
    hostRequest(
      `connect/accounts/${id(account)}?expectedVersion=${id(String(options?.expectedVersion ?? ""))}`,
      "DELETE",
      undefined,
      options,
    ),
};
export const sites: SiteClient = {
  listWorkspaceArtifacts: (_workspace, options) =>
    hostRequest(
      `sites?${new URLSearchParams({ status: options?.status ?? "active", ...(options?.cursor ? { cursor: options.cursor } : {}) })}`,
      "GET",
      undefined,
      options,
    ),
  getWorkspaceArtifact: (_workspace, site, options) =>
    hostRequest(`sites/${id(site)}`, "GET", undefined, options),
  getWorkspaceArtifactHtml: (_workspace, site, options) => {
    return hostRequest(
      `sites/${id(site)}/html?versionId=${id(options.versionId)}`,
      "GET",
      undefined,
      options,
    );
  },
  rollbackWorkspaceArtifact: (_workspace, site, body, options) =>
    hostRequest(`sites/${id(site)}/rollback`, "POST", body, options),
  setWorkspaceArtifactStatus: (_workspace, site, body, options) =>
    hostRequest(`sites/${id(site)}/status`, "PATCH", body, options),
};
