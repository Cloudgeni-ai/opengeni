import { STAGING_ORIGIN } from "./config";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export class ProbeError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
  }
}
// One isolated cookie jar per human; never bearer/admin/asUser provisioning.
export class HumanHttp {
  private readonly cookies = new Map<string, string>();
  actorEpoch: string | undefined;
  contract: string | undefined;
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly requestTimeoutMs: number,
    readonly correlationId: string,
    private readonly expiresAtMs: number,
    cookie = "",
    private readonly now: () => number = Date.now,
  ) {
    for (const part of cookie.split(";")) {
      const separator = part.indexOf("=");
      if (separator > 0)
        this.cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
  }
  async request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    allowRedirect = false,
  ): Promise<Response> {
    const url = new URL(path, STAGING_ORIGIN);
    if (
      url.origin !== STAGING_ORIGIN ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith("/v1/")
    )
      throw new ProbeError("non_staging_request");
    if (this.now() >= this.expiresAtMs) throw new ProbeError("authorization_expired");
    signal.throwIfAborted();
    const requestAbort = new AbortController();
    const timer = setTimeout(
      () => requestAbort.abort(new ProbeError("request_timeout")),
      this.requestTimeoutMs,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.any([signal, requestAbort.signal]),
        headers: {
          "content-type": "application/json",
          origin: STAGING_ORIGIN,
          "sec-fetch-site": "same-origin",
          "x-opengeni-correlation-id": this.correlationId,
          ...(this.contract ? { "x-opengeni-api-contract": this.contract } : {}),
          ...(this.actorEpoch ? { "x-opengeni-actor-epoch": this.actorEpoch } : {}),
          cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally {
      clearTimeout(timer);
    }
    for (const header of response.headers.getSetCookie()) {
      const part = header.split(";", 1)[0]!;
      const separator = part.indexOf("=");
      if (separator > 0) this.cookies.set(part.slice(0, separator), part.slice(separator + 1));
    }
    if (!response.ok && !(allowRedirect && response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      // Error body, Location, request URL and cookie values never enter output.
      throw new ProbeError(`http_${response.status}`, response.status);
    }
    return response;
  }
  async json(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await this.request(path, method, signal, body, headers);
    return response.json();
  }
}
