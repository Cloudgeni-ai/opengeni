import { createHash } from "node:crypto";

/** Log transport shape and correlation only, never request text or authorization values. */
export function observedGatewayFetch(
  sink: (row: Record<string, unknown>) => void,
  transport: typeof fetch = fetch,
) {
  const observed = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers),
      body = typeof init?.body === "string" ? init.body : undefined;
    const at = new Date().toISOString(),
      start = performance.now();
    const response = await transport(input, init);
    if (url.pathname.endsWith("/evaluation-model") || url.pathname.endsWith("/language-model"))
      sink({
        at,
        path: url.pathname,
        status: response.status,
        elapsedMs: performance.now() - start,
        bodyBytes: body ? Buffer.byteLength(body) : null,
        bodyHash: body ? createHash("sha256").update(body).digest("hex") : null,
        model: headers.get("ai-model-id"),
        evaluationSpec: headers.get("ai-evaluation-model-specification-version"),
        userAgent: headers.get("user-agent"),
        headerNames: [...headers.keys()].sort(),
        vercelId: response.headers.get("x-vercel-id"),
      });
    return response;
  };
  return Object.assign(observed, { preconnect: transport.preconnect });
}

export function diagnosticSignal(parent?: AbortSignal, combined = false) {
  return AbortSignal.any([
    ...(parent ? [parent] : []),
    ...(combined ? [AbortSignal.timeout(90000)] : []),
    AbortSignal.timeout(30000),
  ]);
}

/** Never serialize error/config objects: their causes can contain authorization headers. */
export function safeGatewayError(error: unknown, secret?: string) {
  const clean = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    let text = secret ? value.split(secret).join("[REDACTED]") : value;
    text = text.replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
    return text.slice(0, 1600);
  };
  const e = error as any,
    c = e?.cause;
  let body: any;
  try {
    body = JSON.parse(c?.responseBody ?? "null");
  } catch {}
  const headers = c?.responseHeaders ?? {};
  return {
    name: clean(e?.name),
    statusCode: e?.statusCode ?? c?.statusCode ?? null,
    generationId: clean(e?.generationId ?? body?.generationId),
    upstreamType: clean(body?.error?.type),
    causeName: clean(c?.name),
    headers: Object.fromEntries(
      ["x-vercel-id", "x-request-id", "retry-after", "content-type"]
        .filter((k) => typeof headers[k] === "string")
        .map((k) => [k, clean(headers[k])]),
    ),
  };
}
