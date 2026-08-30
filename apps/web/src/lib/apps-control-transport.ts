import type {
  OpenGeniAppsControlOperation,
  OpenGeniAppsControlOperationMap,
  OpenGeniAppsControlRequestOptions,
  OpenGeniAppsControlTransport,
} from "@opengeni/sdk/apps";

import { request as apiRequest } from "@/api";

const APP_CSRF_HEADER = "x-opengeni-app-csrf";

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

type AppCsrfResponse = Readonly<{
  token: string;
  expiresInSeconds: number;
}>;

function segment(value: string): string {
  return encodeURIComponent(value);
}

function appsBase(workspaceId: string): string {
  return `/v1/workspaces/${segment(workspaceId)}/apps`;
}

function jsonRequest(signal: AbortSignal | undefined, body: unknown, headers?: HeadersInit) {
  return {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers,
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

/**
 * Same-origin Apps control transport for the standalone OpenGeni console.
 *
 * It reuses the console's managed-actor request boundary, so account rotation,
 * cookies, deployment keys, API-contract negotiation, and stale-response
 * rejection remain identical to the rest of the product. Browser mutations
 * additionally use the Apps double-submit CSRF contract.
 */
export function createOpenGeniAppsHttpTransport(
  request: ApiRequest = apiRequest,
): OpenGeniAppsControlTransport {
  const csrfByWorkspace = new Map<string, string>();

  const csrf = async (workspaceId: string, signal?: AbortSignal): Promise<string> => {
    const cached = csrfByWorkspace.get(workspaceId);
    if (cached) return cached;
    const response = await request<AppCsrfResponse>(`${appsBase(workspaceId)}/csrf`, {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    if (
      typeof response.token !== "string" ||
      response.token.length < 32 ||
      response.token.length > 256
    ) {
      throw new Error("OpenGeni returned an invalid Apps CSRF token.");
    }
    csrfByWorkspace.set(workspaceId, response.token);
    return response.token;
  };

  const mutation = async <T>(
    workspaceId: string,
    path: string,
    body: unknown,
    options: OpenGeniAppsControlRequestOptions,
    headers?: HeadersInit,
  ): Promise<T> => {
    const token = await csrf(workspaceId, options.signal);
    return await request<T>(
      path,
      jsonRequest(options.signal, body, {
        ...Object.fromEntries(new Headers(headers).entries()),
        [APP_CSRF_HEADER]: token,
      }),
    );
  };

  return Object.freeze({
    async request<K extends OpenGeniAppsControlOperation>(
      operation: K,
      input: OpenGeniAppsControlOperationMap[K]["input"],
      options: OpenGeniAppsControlRequestOptions = {},
    ): Promise<OpenGeniAppsControlOperationMap[K]["output"]> {
      if (operation === "apps.list") {
        const value = input as OpenGeniAppsControlOperationMap["apps.list"]["input"];
        const query = new URLSearchParams();
        if (value.query.limit !== undefined) query.set("limit", String(value.query.limit));
        if (value.query.cursor !== undefined) query.set("cursor", value.query.cursor);
        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        return (await request(`${appsBase(value.workspaceId)}${suffix}`, {
          method: "GET",
          ...(options.signal ? { signal: options.signal } : {}),
        })) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.get") {
        const value = input as OpenGeniAppsControlOperationMap["apps.get"]["input"];
        return (await request(`${appsBase(value.workspaceId)}/${segment(value.appId)}`, {
          method: "GET",
          ...(options.signal ? { signal: options.signal } : {}),
        })) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.runtime.catalog") {
        const value = input as OpenGeniAppsControlOperationMap["apps.runtime.catalog"]["input"];
        const query = new URLSearchParams({ releaseId: value.releaseId });
        return (await request(
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/runtime/catalog?${query.toString()}`,
          {
            method: "GET",
            ...(options.signal ? { signal: options.signal } : {}),
          },
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.launch.create") {
        const value = input as OpenGeniAppsControlOperationMap["apps.launch.create"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/launches`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      const value = input as OpenGeniAppsControlOperationMap["apps.runtime.tool.call"]["input"];
      return (await mutation(
        value.workspaceId,
        `${appsBase(value.workspaceId)}/${segment(value.appId)}/runtime/tool-calls`,
        value.request,
        options,
        {
          "x-opengeni-app-release-id": value.releaseId,
          "x-opengeni-app-launch-id": value.launchId,
          "x-opengeni-app-authority-generation": value.authorityGeneration,
          "x-opengeni-app-launch-nonce": value.launchNonce,
        },
      )) as OpenGeniAppsControlOperationMap[K]["output"];
    },
  });
}
