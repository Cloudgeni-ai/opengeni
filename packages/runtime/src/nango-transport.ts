import { credentialRequestTarget, type NangoProxyTransport } from "@opengeni/contracts/nango";

/**
 * Nango proxy transport for the reviewed provider bridges (docs/nango.md).
 *
 * A bridge validates its provider destination exactly as it always has, then
 * calls `sendWithCredential`. A native credential goes straight to the
 * provider; a Nango credential (resolved with a `proxy` transport) is sent to
 * the Nango proxy with the provider origin pinned in `Base-Url-Override`, so
 * the bridge never sees a provider token. Usage is reported best effort after
 * the response body has been read and never changes the request outcome.
 */

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The transport a Nango-aware bridge declares when it resolves a credential. */
export const NANGO_PROXY_TRANSPORTS = Object.freeze(["nango_proxy"] as const);

export type NangoUsageReport = {
  connectionId: string;
  integrationKey: string;
  providerConfigKey: string;
  nangoConnectionId: string;
  kind: "proxy_request" | "tool_call";
  toolName?: string;
  httpMethod: string;
  httpStatus: number | null;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
};

export type NangoUsageRecorder = (report: NangoUsageReport) => void;

export type CredentialForRequest = {
  headers: Record<string, string>;
  connectionId: string;
  proxy?: NangoProxyTransport;
};

function bodyBytes(body: BodyInit | null | undefined): number {
  if (body == null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
  return 0;
}

function safeReport(recorder: NangoUsageRecorder | undefined, report: NangoUsageReport) {
  if (!recorder) return;
  try {
    recorder(report);
  } catch {
    // Usage accounting never affects a provider request.
  }
}

/** Counts the bytes a caller reads from a proxied response, then reports once. */
function meteredResponse(response: Response, onDone: (bytes: number) => void): Response {
  if (!response.body) {
    onDone(0);
    return response;
  }
  let bytes = 0;
  let reported = false;
  const finish = () => {
    if (reported) return;
    reported = true;
    onDone(bytes);
  };
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush: finish,
    }),
  );
  const metered = new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const cancel = metered.body!.cancel.bind(metered.body!);
  Object.defineProperty(metered.body!, "cancel", {
    value: async (reason?: unknown) => {
      finish();
      return await cancel(reason);
    },
  });
  return metered;
}

/**
 * Sends one already-validated provider request with a resolved credential.
 * `init.headers` must not carry credentials; the credential's headers are
 * applied here (Nango API auth plus Connection-Id/Provider-Config-Key for a
 * Nango connection).
 */
export async function sendWithCredential(
  fetchImpl: FetchLike,
  destination: string | URL,
  init: RequestInit & { headers?: Record<string, string> },
  credential: CredentialForRequest,
  usage?: { recorder?: NangoUsageRecorder; toolName?: string },
): Promise<Response> {
  const target = credentialRequestTarget(destination, credential);
  const request: RequestInit = { ...init, headers: { ...target.headers, ...init.headers } };
  if (!credential.proxy) return await fetchImpl(target.url, request);
  const proxy = credential.proxy;
  const startedAt = Date.now();
  const base = {
    connectionId: credential.connectionId,
    integrationKey: proxy.integrationKey,
    providerConfigKey: proxy.providerConfigKey,
    nangoConnectionId: proxy.nangoConnectionId,
    kind: "proxy_request" as const,
    ...(usage?.toolName ? { toolName: usage.toolName } : {}),
    httpMethod: (init.method ?? "GET").toUpperCase(),
    requestBytes: bodyBytes(init.body),
  };
  let response: Response;
  try {
    response = await fetchImpl(target.url, request);
  } catch (error) {
    safeReport(usage?.recorder, {
      ...base,
      httpStatus: null,
      responseBytes: 0,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
  return meteredResponse(response, (responseBytes) =>
    safeReport(usage?.recorder, {
      ...base,
      httpStatus: response.status,
      responseBytes,
      durationMs: Date.now() - startedAt,
    }),
  );
}
