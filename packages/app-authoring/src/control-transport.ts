import type {
  OpenGeniAppsControlOperation,
  OpenGeniAppsControlOperationMap,
  OpenGeniAppsControlRequestOptions,
  OpenGeniAppsControlTransport,
} from "@opengeni/sdk/apps";

export type OgAppAuthoringHttpAuth =
  | Readonly<{ kind: "api_key"; apiKey: string }>
  | Readonly<{ kind: "human_session"; cookie: string }>;

export type OgAppAuthoringFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OgAppAuthoringHttpTransportOptions = Readonly<{
  baseUrl: string;
  auth: OgAppAuthoringHttpAuth;
  fetch?: OgAppAuthoringFetch;
}>;

const APP_CSRF_COOKIE = "opengeni.app_csrf";
const APP_CSRF_HEADER = "x-opengeni-app-csrf";
const ERROR_BODY_MAX_BYTES = 4_096;

type Route = Readonly<{
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  mutation?: true;
}>;

function exactOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be one HTTP(S) origin.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(`${label} must be one HTTP(S) origin.`);
  }
  return url.origin;
}

function secret(value: string, label: string, maximum: number): string {
  if (!value || value.length > maximum || value.trim() !== value || /[\r\n\u0000]/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function appsBase(workspaceId: string): string {
  return `/v1/workspaces/${segment(workspaceId)}/apps`;
}

function query(values: Readonly<Record<string, string | number | undefined>>): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) parameters.set(name, String(value));
  }
  return parameters.size === 0 ? "" : `?${parameters.toString()}`;
}

function route(
  operation: OpenGeniAppsControlOperation,
  input: OpenGeniAppsControlOperationMap[OpenGeniAppsControlOperation]["input"],
): Route {
  if (operation === "apps.list") {
    const value = input as OpenGeniAppsControlOperationMap["apps.list"]["input"];
    return {
      method: "GET",
      path: `${appsBase(value.workspaceId)}${query(value.query)}`,
    };
  }
  if (operation === "apps.get") {
    const value = input as OpenGeniAppsControlOperationMap["apps.get"]["input"];
    return {
      method: "GET",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}`,
    };
  }
  if (operation === "apps.create") {
    const value = input as OpenGeniAppsControlOperationMap["apps.create"]["input"];
    return {
      method: "POST",
      path: appsBase(value.workspaceId),
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.update") {
    const value = input as OpenGeniAppsControlOperationMap["apps.update"]["input"];
    return {
      method: "PATCH",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.toolPolicy.create") {
    const value = input as OpenGeniAppsControlOperationMap["apps.toolPolicy.create"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/tool-policies`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.runtime.availableCatalog") {
    const value =
      input as OpenGeniAppsControlOperationMap["apps.runtime.availableCatalog"]["input"];
    return {
      method: "GET",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/runtime/available-catalog`,
    };
  }
  if (operation === "apps.source.begin") {
    const value = input as OpenGeniAppsControlOperationMap["apps.source.begin"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/source-revisions`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.source.complete") {
    const value = input as OpenGeniAppsControlOperationMap["apps.source.complete"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/source-revisions/${segment(value.sourceRevisionId)}/complete`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.source.download") {
    const value = input as OpenGeniAppsControlOperationMap["apps.source.download"]["input"];
    return {
      method: "GET",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/source-revisions/${segment(value.sourceRevisionId)}/download`,
    };
  }
  if (operation === "apps.build.prepare") {
    const value = input as OpenGeniAppsControlOperationMap["apps.build.prepare"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/builds`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.build.uploads.list") {
    const value = input as OpenGeniAppsControlOperationMap["apps.build.uploads.list"]["input"];
    return {
      method: "GET",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/builds/${segment(value.buildId)}/uploads${query(value.query)}`,
    };
  }
  if (operation === "apps.build.complete") {
    const value = input as OpenGeniAppsControlOperationMap["apps.build.complete"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/builds/${segment(value.buildId)}/complete`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.release.promote") {
    const value = input as OpenGeniAppsControlOperationMap["apps.release.promote"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/releases`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.preview.create") {
    const value = input as OpenGeniAppsControlOperationMap["apps.preview.create"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/previews`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.publish") {
    const value = input as OpenGeniAppsControlOperationMap["apps.publish"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/publish`,
      body: value.request,
      mutation: true,
    };
  }
  if (
    operation === "apps.rollback" ||
    operation === "apps.unpublish" ||
    operation === "apps.archive"
  ) {
    const value = input as { workspaceId: string; appId: string; request: unknown };
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/${operation.slice("apps.".length)}`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.runtime.catalog") {
    const value = input as OpenGeniAppsControlOperationMap["apps.runtime.catalog"]["input"];
    return {
      method: "GET",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/runtime/catalog${query({ releaseId: value.releaseId })}`,
    };
  }
  if (operation === "apps.launch.create") {
    const value = input as OpenGeniAppsControlOperationMap["apps.launch.create"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/launches`,
      body: value.request,
      mutation: true,
    };
  }
  if (operation === "apps.runtime.tool.call") {
    const value = input as OpenGeniAppsControlOperationMap["apps.runtime.tool.call"]["input"];
    return {
      method: "POST",
      path: `${appsBase(value.workspaceId)}/${segment(value.appId)}/runtime/tool-calls`,
      body: value.request,
      headers: {
        "x-opengeni-app-release-id": value.releaseId,
        "x-opengeni-app-launch-id": value.launchId,
        "x-opengeni-app-authority-generation": value.authorityGeneration,
        "x-opengeni-app-launch-nonce": value.launchNonce,
      },
      mutation: true,
    };
  }
  throw new Error(`The authoring HTTP transport does not support ${operation}.`);
}

function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const candidate = typeof parsed.message === "string" ? parsed.message : parsed.error;
    if (typeof candidate === "string" && candidate.length > 0) {
      return `OpenGeni Apps request failed (${status}): ${candidate.slice(0, ERROR_BODY_MAX_BYTES)}`;
    }
  } catch {
    // Fall through to a status-only error; raw response bodies may contain HTML.
  }
  return `OpenGeni Apps request failed with HTTP ${status}.`;
}

async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let received = 0;
  let truncated = false;
  try {
    while (received < ERROR_BODY_MAX_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = ERROR_BODY_MAX_BYTES - received;
      const bytes =
        chunk.value.byteLength > remaining ? chunk.value.subarray(0, remaining) : chunk.value;
      received += bytes.byteLength;
      result += decoder.decode(bytes, { stream: true });
      if (bytes.byteLength !== chunk.value.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    result += decoder.decode();
    if (truncated || received >= ERROR_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
    }
  }
  return result;
}

export function createOgAppAuthoringHttpTransport(
  options: OgAppAuthoringHttpTransportOptions,
): OpenGeniAppsControlTransport {
  const baseUrl = exactOrigin(options.baseUrl, "baseUrl");
  const fetchImpl = options.fetch ?? fetch;
  const auth =
    options.auth.kind === "api_key"
      ? {
          kind: "api_key" as const,
          apiKey: secret(options.auth.apiKey, "apiKey", 8_192),
        }
      : {
          kind: "human_session" as const,
          cookie: secret(options.auth.cookie, "session cookie", 16_384),
        };
  if (
    auth.kind === "human_session" &&
    new RegExp(`(?:^|;\\s*)${APP_CSRF_COOKIE}=`, "iu").test(auth.cookie)
  ) {
    throw new TypeError(`session cookie must not include ${APP_CSRF_COOKIE}.`);
  }
  const csrfByWorkspace = new Map<string, string>();

  const send = async (
    workspaceId: string,
    target: Route,
    requestOptions: OpenGeniAppsControlRequestOptions,
  ): Promise<unknown> => {
    let csrfToken: string | undefined;
    if (target.mutation && auth.kind === "human_session") {
      csrfToken = csrfByWorkspace.get(workspaceId);
      if (!csrfToken) {
        const response = await fetchImpl(new URL(`${appsBase(workspaceId)}/csrf`, baseUrl), {
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json", cookie: auth.cookie },
          ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        });
        if (!response.ok) {
          throw new Error(errorMessage(response.status, await readErrorBody(response)));
        }
        const text = await response.text();
        const parsed = JSON.parse(text) as { token?: unknown };
        if (
          typeof parsed.token !== "string" ||
          parsed.token.length < 32 ||
          parsed.token.length > 256
        ) {
          throw new Error("OpenGeni returned an invalid Apps CSRF token.");
        }
        csrfToken = parsed.token;
        csrfByWorkspace.set(workspaceId, csrfToken);
      }
    }

    const headers = new Headers(target.headers);
    headers.set("accept", "application/json");
    if (target.body !== undefined) headers.set("content-type", "application/json");
    if (auth.kind === "api_key") {
      headers.set("authorization", `Bearer ${auth.apiKey}`);
    } else {
      headers.set(
        "cookie",
        csrfToken ? `${auth.cookie}; ${APP_CSRF_COOKIE}=${csrfToken}` : auth.cookie,
      );
      if (target.mutation) {
        headers.set("origin", baseUrl);
        headers.set("sec-fetch-site", "same-origin");
        headers.set(APP_CSRF_HEADER, csrfToken!);
      }
    }
    const response = await fetchImpl(new URL(target.path, baseUrl), {
      method: target.method,
      redirect: "error",
      headers,
      ...(target.body === undefined ? {} : { body: JSON.stringify(target.body) }),
      ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(errorMessage(response.status, await readErrorBody(response)));
    }
    const text = await response.text();
    if (response.status === 204 || text.length === 0) return null;
    return JSON.parse(text);
  };

  return Object.freeze({
    async request<K extends OpenGeniAppsControlOperation>(
      operation: K,
      input: OpenGeniAppsControlOperationMap[K]["input"],
      requestOptions: OpenGeniAppsControlRequestOptions = {},
    ): Promise<OpenGeniAppsControlOperationMap[K]["output"]> {
      const target = route(
        operation,
        input as OpenGeniAppsControlOperationMap[OpenGeniAppsControlOperation]["input"],
      );
      const workspaceId = (input as { workspaceId: string }).workspaceId;
      return (await send(
        workspaceId,
        target,
        requestOptions,
      )) as OpenGeniAppsControlOperationMap[K]["output"];
    },
  });
}
