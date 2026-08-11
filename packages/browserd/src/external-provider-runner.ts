import type { BrowserCommandRunner } from "./cdp-driver";
import { AgentBrowserCommandError, type AgentBrowserRunOptions } from "./runner";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const KERNEL_ENDPOINT = "https://api.onkernel.com";
const BROWSERBASE_ENDPOINT = "https://api.browserbase.com/v1";

type ExternalProviderRoute = {
  providerId: "browserbase" | "kernel";
  routeId: string;
  egressClass: "datacenter" | "residential" | "isp";
  region: string | null;
};

export type ExternalProviderCdpRunnerOptions = {
  providerId: "browserbase" | "kernel";
  apiKey: string;
  endpoint?: string;
  headed: boolean;
  timeoutSeconds?: number;
  stealth?: boolean;
  route: ExternalProviderRoute;
  fetch?: typeof fetch;
};

type ProviderSession = {
  id: string;
  cdpUrl: string;
};

/**
 * Private lifecycle adapter used only when a provider-managed NetworkRoute
 * must be selected during remote browser creation. Page semantics and actions
 * still flow through the ordinary OpenGeni CDP driver; this runner exposes no
 * provider command surface and never returns provider credentials or ids.
 */
export class ExternalProviderCdpRunner implements BrowserCommandRunner {
  private readonly options: ExternalProviderCdpRunnerOptions;
  private readonly request: typeof fetch;
  private session: ProviderSession | null = null;
  private provisionPromise: Promise<ProviderSession> | null = null;
  private releasePromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: ExternalProviderCdpRunnerOptions) {
    this.options = validateOptions(options);
    this.request = options.fetch ?? fetch;
  }

  async run<T = unknown>(
    args: readonly string[],
    options: AgentBrowserRunOptions = {},
  ): Promise<T> {
    if (args.length !== 2 || args[0] !== "get" || args[1] !== "cdp-url") {
      throw new AgentBrowserCommandError(
        "driver_rejected",
        "external provider runner exposes only its private CDP endpoint",
      );
    }
    if (this.closed) {
      throw new AgentBrowserCommandError("driver_rejected", "external browser is closed");
    }
    if (options.signal?.aborted) {
      throw new AgentBrowserCommandError("aborted", "external browser creation was aborted");
    }
    if (!this.provisionPromise) {
      this.provisionPromise = this.provision(options);
    }
    const session = await this.provisionPromise;
    return { cdpUrl: session.cdpUrl } as T;
  }

  async terminate(): Promise<void> {
    this.closed = true;
    if (this.releasePromise) return await this.releasePromise;
    this.releasePromise = (async () => {
      let session = this.session;
      if (!session && this.provisionPromise) {
        try {
          session = await this.provisionPromise;
        } catch {
          return;
        }
      }
      if (!session) return;
      this.session = null;
      await this.release(session);
    })();
    return await this.releasePromise;
  }

  private async provision(options: AgentBrowserRunOptions): Promise<ProviderSession> {
    const timeoutMs = requestTimeout(options.timeoutMs);
    const session =
      this.options.providerId === "kernel"
        ? await this.provisionKernel(timeoutMs, options.signal)
        : await this.provisionBrowserbase(timeoutMs, options.signal);
    this.session = session;
    return session;
  }

  private async provisionKernel(
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ProviderSession> {
    const response = await providerJsonRequest(
      this.request,
      providerUrl(this.options.endpoint ?? KERNEL_ENDPOINT, "browsers"),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          headless: !this.options.headed,
          ...(this.options.stealth === undefined ? {} : { stealth: this.options.stealth }),
          ...(this.options.timeoutSeconds === undefined
            ? {}
            : { timeout_seconds: this.options.timeoutSeconds }),
          proxy_id: this.options.route.routeId,
        }),
      },
      timeoutMs,
      signal,
      "Kernel browser creation",
    );
    return providerSession(response, "session_id", "cdp_ws_url", "Kernel");
  }

  private async provisionBrowserbase(
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ProviderSession> {
    const region = this.options.route.region;
    const proxies = region
      ? [{ type: "browserbase", geolocation: { country: region.toUpperCase() } }]
      : true;
    const response = await providerJsonRequest(
      this.request,
      providerUrl(this.options.endpoint ?? BROWSERBASE_ENDPOINT, "sessions"),
      {
        method: "POST",
        headers: {
          "x-bb-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          keepAlive: false,
          proxies,
          ...(this.options.timeoutSeconds === undefined
            ? {}
            : { timeout: this.options.timeoutSeconds }),
        }),
      },
      timeoutMs,
      signal,
      "Browserbase session creation",
    );
    return providerSession(response, "id", "connectUrl", "Browserbase");
  }

  private async release(session: ProviderSession): Promise<void> {
    if (this.options.providerId === "kernel") {
      await providerReleaseRequest(
        this.request,
        providerUrl(
          this.options.endpoint ?? KERNEL_ENDPOINT,
          `browsers/${encodeURIComponent(session.id)}`,
        ),
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${this.options.apiKey}` },
        },
        "Kernel browser release",
      );
      return;
    }
    await providerReleaseRequest(
      this.request,
      providerUrl(
        this.options.endpoint ?? BROWSERBASE_ENDPOINT,
        `sessions/${encodeURIComponent(session.id)}`,
      ),
      {
        method: "POST",
        headers: {
          "x-bb-api-key": this.options.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "REQUEST_RELEASE" }),
      },
      "Browserbase session release",
    );
  }
}

function validateOptions(
  input: ExternalProviderCdpRunnerOptions,
): ExternalProviderCdpRunnerOptions {
  if (input.providerId !== "browserbase" && input.providerId !== "kernel") {
    throw new Error("external browser provider is unsupported");
  }
  if (
    Buffer.byteLength(input.apiKey) < 1 ||
    Buffer.byteLength(input.apiKey) > 8_192 ||
    /[\u0000-\u001f\u007f]/u.test(input.apiKey)
  ) {
    throw new Error("external browser provider credential is invalid");
  }
  if (typeof input.headed !== "boolean") {
    throw new Error("external browser headed mode is invalid");
  }
  if (input.stealth !== undefined && typeof input.stealth !== "boolean") {
    throw new Error("external browser stealth mode is invalid");
  }
  if (
    input.timeoutSeconds !== undefined &&
    (!Number.isSafeInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > 86_400)
  ) {
    throw new Error("external browser timeout is invalid");
  }
  if (input.endpoint !== undefined) validateEndpoint(input.endpoint);
  if (input.route.providerId !== input.providerId) {
    throw new Error("managed network route belongs to another browser provider");
  }
  if (
    Buffer.byteLength(input.route.routeId) < 1 ||
    Buffer.byteLength(input.route.routeId) > 512 ||
    /[\u0000-\u001f\u007f]/u.test(input.route.routeId)
  ) {
    throw new Error("managed network route provider id is invalid");
  }
  if (
    input.route.egressClass !== "datacenter" &&
    input.route.egressClass !== "residential" &&
    input.route.egressClass !== "isp"
  ) {
    throw new Error("managed network route egress class is invalid");
  }
  if (
    input.route.region !== null &&
    (Buffer.byteLength(input.route.region) < 1 ||
      Buffer.byteLength(input.route.region) > 128 ||
      input.route.region.trim() !== input.route.region ||
      /[\u0000-\u001f\u007f]/u.test(input.route.region))
  ) {
    throw new Error("managed network route region is invalid");
  }
  if (input.providerId === "browserbase") {
    if (input.route.routeId !== "default" || input.route.egressClass !== "residential") {
      throw new Error("Browserbase supports only its default managed residential route");
    }
    if (input.route.region !== null && !/^[A-Za-z]{2}$/u.test(input.route.region)) {
      throw new Error("Browserbase managed route region must be a two-letter country code");
    }
    if (
      input.timeoutSeconds !== undefined &&
      (!Number.isSafeInteger(input.timeoutSeconds) ||
        input.timeoutSeconds < 60 ||
        input.timeoutSeconds > 21_600)
    ) {
      throw new Error("Browserbase session timeout must be between 60 and 21600 seconds");
    }
  }
  return input;
}

function validateEndpoint(value: string): void {
  if (Buffer.byteLength(value) > 16_384) {
    throw new Error("external browser provider endpoint is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("external browser provider endpoint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("external browser provider endpoint is invalid");
  }
}

function providerSession(
  response: Record<string, unknown>,
  idKey: string,
  cdpKey: string,
  provider: string,
): ProviderSession {
  const id = response[idKey];
  const cdpUrl = response[cdpKey];
  if (
    typeof id !== "string" ||
    Buffer.byteLength(id) < 1 ||
    Buffer.byteLength(id) > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(id)
  ) {
    throw new AgentBrowserCommandError(
      "invalid_response",
      `${provider} browser response omitted its session id`,
    );
  }
  if (typeof cdpUrl !== "string" || Buffer.byteLength(cdpUrl) > 16_384) {
    throw new AgentBrowserCommandError(
      "invalid_response",
      `${provider} browser response omitted its CDP endpoint`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new AgentBrowserCommandError(
      "invalid_response",
      `${provider} browser response returned an invalid CDP endpoint`,
    );
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new AgentBrowserCommandError(
      "invalid_response",
      `${provider} browser response returned an invalid CDP endpoint`,
    );
  }
  return { id, cdpUrl: parsed.toString() };
}

async function providerJsonRequest(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Record<string, unknown>> {
  const response = await boundedFetch(request, url, init, timeoutMs, signal, label);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AgentBrowserCommandError(
      "process_failed",
      `${label} failed with HTTP ${response.status}`,
    );
  }
  const bytes = await boundedResponse(response, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AgentBrowserCommandError("invalid_response", `${label} returned invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AgentBrowserCommandError("invalid_response", `${label} returned an invalid object`);
  }
  return parsed as Record<string, unknown>;
}

async function providerReleaseRequest(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<void> {
  const response = await boundedFetch(
    request,
    url,
    init,
    DEFAULT_REQUEST_TIMEOUT_MS,
    undefined,
    label,
  );
  if (!response.ok && response.status !== 404) {
    await response.body?.cancel().catch(() => undefined);
    throw new AgentBrowserCommandError(
      "process_failed",
      `${label} failed with HTTP ${response.status}`,
    );
  }
  await response.body?.cancel().catch(() => undefined);
}

async function boundedFetch(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  try {
    return await request(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) {
      throw new AgentBrowserCommandError("aborted", `${label} was aborted`);
    }
    if (controller.signal.aborted) {
      throw new AgentBrowserCommandError("timeout", `${label} timed out`);
    }
    void error;
    throw new AgentBrowserCommandError("process_failed", `${label} could not reach the provider`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function boundedResponse(response: Response, label: string): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AgentBrowserCommandError(
          "invalid_response",
          `${label} exceeded its bounded response envelope`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function providerUrl(endpoint: string, path: string): string {
  return new URL(path, `${endpoint.replace(/\/+$/u, "")}/`).toString();
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error("external provider request timeout is invalid");
  }
  return timeout;
}
