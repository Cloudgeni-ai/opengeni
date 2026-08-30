import type {
  OpenGeniAppsControlOperation,
  OpenGeniAppsControlOperationMap,
  OpenGeniAppsControlRequestOptions,
  OpenGeniAppsControlTransport,
} from "@opengeni/sdk/apps";

import { ApiError, request as apiRequest } from "@/api";

const APP_CSRF_HEADER = "x-opengeni-app-csrf";
const APP_CSRF_REFRESH_SKEW_MS = 5_000;

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

type AppCsrfResponse = Readonly<{
  token: string;
  expiresInSeconds: number;
}>;

type AppCsrfState = Readonly<{
  token: string;
  expiresAtMs: number;
}>;

function segment(value: string): string {
  return encodeURIComponent(value);
}

function appsBase(workspaceId: string): string {
  return `/v1/workspaces/${segment(workspaceId)}/apps`;
}

function jsonRequest(
  signal: AbortSignal | undefined,
  body: unknown,
  headers?: HeadersInit,
  method: "POST" | "PATCH" = "POST",
) {
  return {
    method,
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
  now: () => number = Date.now,
): OpenGeniAppsControlTransport {
  let csrfState: AppCsrfState | null = null;
  let csrfMint: Promise<AppCsrfState> | null = null;

  const csrf = async (
    workspaceId: string,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<string> => {
    if (!forceRefresh && csrfState && csrfState.expiresAtMs - APP_CSRF_REFRESH_SKEW_MS > now()) {
      return csrfState.token;
    }
    if (csrfMint) return (await csrfMint).token;
    const mint = (async (): Promise<AppCsrfState> => {
      const response = await request<AppCsrfResponse>(`${appsBase(workspaceId)}/csrf`, {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      if (
        typeof response.token !== "string" ||
        response.token.length < 32 ||
        response.token.length > 256 ||
        !Number.isSafeInteger(response.expiresInSeconds) ||
        response.expiresInSeconds < 30 ||
        response.expiresInSeconds > 86_400
      ) {
        throw new Error("OpenGeni returned an invalid Apps CSRF token.");
      }
      return {
        token: response.token,
        expiresAtMs: now() + response.expiresInSeconds * 1_000,
      };
    })();
    csrfMint = mint;
    try {
      csrfState = await mint;
      return csrfState.token;
    } finally {
      if (csrfMint === mint) csrfMint = null;
    }
  };

  const mutation = async <T>(
    workspaceId: string,
    path: string,
    body: unknown,
    options: OpenGeniAppsControlRequestOptions,
    headers?: HeadersInit,
    method: "POST" | "PATCH" = "POST",
  ): Promise<T> => {
    const send = async (token: string): Promise<T> =>
      await request<T>(
        path,
        jsonRequest(
          options.signal,
          body,
          {
            ...Object.fromEntries(new Headers(headers).entries()),
            [APP_CSRF_HEADER]: token,
          },
          method,
        ),
      );
    const token = await csrf(workspaceId, options.signal);
    try {
      return await send(token);
    } catch (error) {
      if (!isAppCsrfAdmissionFailure(error)) throw error;
      if (csrfState?.token === token) csrfState = null;
      return await send(await csrf(workspaceId, options.signal, true));
    }
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
      if (operation === "apps.create") {
        const value = input as OpenGeniAppsControlOperationMap["apps.create"]["input"];
        return (await mutation(
          value.workspaceId,
          appsBase(value.workspaceId),
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.update") {
        const value = input as OpenGeniAppsControlOperationMap["apps.update"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}`,
          value.request,
          options,
          undefined,
          "PATCH",
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.toolPolicy.create") {
        const value = input as OpenGeniAppsControlOperationMap["apps.toolPolicy.create"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/tool-policies`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.source.begin") {
        const value = input as OpenGeniAppsControlOperationMap["apps.source.begin"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/source-revisions`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.source.complete") {
        const value = input as OpenGeniAppsControlOperationMap["apps.source.complete"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/source-revisions/${segment(value.sourceRevisionId)}/complete`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.source.download") {
        const value = input as OpenGeniAppsControlOperationMap["apps.source.download"]["input"];
        return (await request(
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/source-revisions/${segment(value.sourceRevisionId)}/download`,
          {
            method: "GET",
            ...(options.signal ? { signal: options.signal } : {}),
          },
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.build.prepare") {
        const value = input as OpenGeniAppsControlOperationMap["apps.build.prepare"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/builds`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.build.uploads.list") {
        const value = input as OpenGeniAppsControlOperationMap["apps.build.uploads.list"]["input"];
        const query = new URLSearchParams();
        if (value.query.limit !== undefined) query.set("limit", String(value.query.limit));
        if (value.query.cursor !== undefined) query.set("cursor", value.query.cursor);
        const suffix = query.size > 0 ? `?${query.toString()}` : "";
        return (await request(
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/builds/${segment(value.buildId)}/uploads${suffix}`,
          {
            method: "GET",
            ...(options.signal ? { signal: options.signal } : {}),
          },
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.build.complete") {
        const value = input as OpenGeniAppsControlOperationMap["apps.build.complete"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/builds/${segment(value.buildId)}/complete`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.release.promote") {
        const value = input as OpenGeniAppsControlOperationMap["apps.release.promote"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/releases`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (operation === "apps.preview.create") {
        const value = input as OpenGeniAppsControlOperationMap["apps.preview.create"]["input"];
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/previews`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
      }
      if (
        operation === "apps.publish" ||
        operation === "apps.rollback" ||
        operation === "apps.unpublish" ||
        operation === "apps.archive"
      ) {
        const value = input as { workspaceId: string; appId: string; request: unknown };
        const action = operation.slice("apps.".length);
        return (await mutation(
          value.workspaceId,
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/${action}`,
          value.request,
          options,
        )) as OpenGeniAppsControlOperationMap[K]["output"];
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
      if (operation === "apps.runtime.availableCatalog") {
        const value =
          input as OpenGeniAppsControlOperationMap["apps.runtime.availableCatalog"]["input"];
        return (await request(
          `${appsBase(value.workspaceId)}/${segment(value.appId)}/runtime/available-catalog`,
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
      if (operation === "apps.runtime.tool.call") {
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
      }
      throw new Error(`Unsupported Apps control operation: ${String(operation)}`);
    },
  });
}

function isAppCsrfAdmissionFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.body.includes("Apps browser mutation admission failed")
  );
}
