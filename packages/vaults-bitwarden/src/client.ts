/**
 * The Bitwarden client API over HTTPS, as the official clients use it against
 * bitwarden.com, bitwarden.eu, self-hosted Bitwarden and Vaultwarden:
 *
 * - `GET {server}/api/config` names the API and identity hosts.
 * - `POST {identity}/connect/token` with the account's personal API key
 *   (`client_credentials`, scope `api`) returns a bearer token. API-key
 *   logins skip two-step login and new-device prompts by design.
 * - `GET {api}/sync`, `{api}/accounts/profile`, `{api}/ciphers/...` carry the
 *   encrypted vault. Values are decrypted by the caller, never here.
 *
 * Tokens are cached per process for their lifetime (servers rate-limit logins
 * hard: Vaultwarden allows a burst of 10 and then one a minute), keyed by a
 * digest of the credential so two connections never share one.
 */
import { createHash } from "node:crypto";
import { VaultProviderError } from "./contract";

export type BitwardenFetch = (input: string, init: RequestInit) => Promise<Response>;

export const BITWARDEN_REQUEST_TIMEOUT_MS = 20_000;
/** A full sync of a large vault; items are a few KB each when encrypted. */
export const BITWARDEN_MAX_RESPONSE_BYTES = 48 * 1_024 * 1_024;
const SMALL_RESPONSE_BYTES = 1_024 * 1_024;
/** Bitwarden's device type for SDK clients. */
const DEVICE_TYPE_SDK = "21";
const CLIENT_NAME = "opengeni";

export interface BitwardenEndpoints {
  /** The server address the person entered, normalized (no trailing slash). */
  serverUrl: string;
  apiUrl: string;
  identityUrl: string;
}

export interface BitwardenApiKey {
  /** `user.<uuid>` from the account's Settings, Security, Keys, View API key. */
  clientId: string;
  clientSecret: string;
}

export interface BitwardenHttpOptions {
  fetch: BitwardenFetch;
  requestTimeoutMs?: number;
  now?: () => number;
}

export interface BitwardenTokenResponse {
  accessToken: string;
  expiresAt: number;
  /** The master-key-protected user key, when the server includes it. */
  key: string | null;
  kdf: Record<string, unknown>;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** A mutation: a failure after sending is an unknown outcome, never retried. */
  write?: boolean;
  maxBytes?: number;
  what: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The registrable-looking parent of a host: `api.bitwarden.com` -> `bitwarden.com`. */
function parentDomain(host: string): string {
  const labels = host.split(".");
  return labels.length > 2 ? labels.slice(1).join(".") : host;
}

/**
 * Accepts an address the person typed ("vault.example.com", "https://x/")
 * and returns its HTTPS origin plus path, without a trailing slash.
 */
export function normalizeServerUrl(input: string, allowHttp = false): string {
  const raw = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new VaultProviderError("provider_auth_invalid", "Enter the Bitwarden server address");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new VaultProviderError("provider_auth_invalid", "The Bitwarden server must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new VaultProviderError(
      "provider_auth_invalid",
      "Enter only the Bitwarden server address, without credentials or query",
    );
  }
  return trimSlash(`${url.origin}${url.pathname}`);
}

/**
 * Hosts a server's config may name: the server's own host, or a sibling under
 * the same parent domain (bitwarden.com serves api. and identity. siblings).
 */
function sameSite(server: URL, candidate: URL, allowHttp: boolean): boolean {
  if (candidate.protocol !== "https:" && !(allowHttp && candidate.protocol === "http:")) {
    return false;
  }
  if (candidate.username || candidate.password) return false;
  if (candidate.host === server.host) return true;
  const parent = parentDomain(server.hostname);
  return (
    parent !== server.hostname &&
    candidate.hostname.endsWith(`.${parent}`) &&
    candidate.port === server.port
  );
}

export class BitwardenHttp {
  private readonly fetchImpl: BitwardenFetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: BitwardenHttpOptions) {
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? BITWARDEN_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  clock(): number {
    return this.now();
  }

  /**
   * One HTTP exchange with a deadline covering the complete body, no
   * redirects and a size bound. Returns the status and the raw body.
   */
  async exchange(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    options: RequestOptions,
  ): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let sent = false;
    try {
      const response = await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal: controller.signal,
      });
      sent = true;
      const body = await readBounded(response, options.maxBytes ?? SMALL_RESPONSE_BYTES);
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      if (error instanceof VaultProviderError) throw error;
      if (options.signal?.aborted && !timedOut) options.signal.throwIfAborted();
      if (options.write) {
        throw new VaultProviderError(
          "provider_outcome_unknown",
          `Bitwarden did not confirm ${options.what}${sent ? "" : " (the request may not have been sent)"}; check the item before trying again`,
        );
      }
      throw new VaultProviderError(
        "provider_unavailable",
        timedOut
          ? `Bitwarden did not answer in time (${options.what})`
          : `Bitwarden could not be reached (${options.what})`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Finds the API and identity hosts from `{server}/api/config`. */
  async discover(
    serverUrl: string,
    options: { signal?: AbortSignal; allowHttp?: boolean } = {},
  ): Promise<BitwardenEndpoints> {
    const normalized = normalizeServerUrl(serverUrl, options.allowHttp);
    const fallback = {
      serverUrl: normalized,
      apiUrl: `${normalized}/api`,
      identityUrl: `${normalized}/identity`,
    };
    const response = await this.exchange(
      `${normalized}/api/config`,
      { method: "GET", headers: { accept: "application/json" } },
      { signal: options.signal, what: "reading the server configuration" },
    );
    if (response.status === 404) return fallback;
    if (response.status < 200 || response.status >= 300) {
      throw new VaultProviderError(
        "provider_unavailable",
        `${normalized} did not answer like a Bitwarden server (HTTP ${response.status})`,
      );
    }
    const config = record(parseJson(response.body, "the server configuration"));
    const environment = record(config?.environment);
    if (!config || (!environment && !config.version)) {
      throw new VaultProviderError(
        "provider_unavailable",
        `${normalized} did not answer like a Bitwarden server`,
      );
    }
    if (!environment) return fallback;
    const server = new URL(normalized);
    const pick = (value: unknown, otherwise: string) => {
      if (typeof value !== "string" || !value.trim()) return otherwise;
      let candidate: URL;
      try {
        candidate = new URL(value.trim());
      } catch {
        return otherwise;
      }
      if (!sameSite(server, candidate, options.allowHttp === true)) {
        throw new VaultProviderError(
          "provider_unavailable",
          `${normalized} points its API at another site (${candidate.host}); Opengeni only sends the API key to the server you entered`,
        );
      }
      return trimSlash(`${candidate.origin}${candidate.pathname}`);
    };
    return {
      serverUrl: normalized,
      apiUrl: pick(environment.api, fallback.apiUrl),
      identityUrl: pick(environment.identity, fallback.identityUrl),
    };
  }

  /** Logs in with the personal API key. Never cached here; see `BitwardenSession`. */
  async login(
    endpoints: BitwardenEndpoints,
    apiKey: BitwardenApiKey,
    signal?: AbortSignal,
  ): Promise<BitwardenTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "api",
      client_id: apiKey.clientId,
      client_secret: apiKey.clientSecret,
      deviceType: DEVICE_TYPE_SDK,
      deviceIdentifier: deviceIdentifier(apiKey.clientId),
      deviceName: "Opengeni",
    });
    const started = this.now();
    const response = await this.exchange(
      `${endpoints.identityUrl}/connect/token`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          "device-type": DEVICE_TYPE_SDK,
          "bitwarden-client-name": CLIENT_NAME,
        },
        body: body.toString(),
      },
      { signal, what: "signing in" },
    );
    if (response.status === 429) throw rateLimited(response.headers, "signing in");
    const parsed = record(safeJson(response.body));
    if (response.status === 400 || response.status === 401) {
      const error = typeof parsed?.error === "string" ? parsed.error : "";
      if (error === "invalid_client" || error === "invalid_grant" || response.status === 401) {
        throw new VaultProviderError(
          "provider_auth_invalid",
          "Bitwarden rejected the API key. Check the client ID and secret under Settings, Security, Keys, View API key.",
        );
      }
    }
    if (response.status < 200 || response.status >= 300 || !parsed) {
      throw statusError(response.status, "signing in", false);
    }
    const accessToken = parsed.access_token;
    const expiresIn = Number(parsed.expires_in);
    if (typeof accessToken !== "string" || !accessToken) {
      throw new VaultProviderError("provider_unavailable", "Bitwarden returned no access token");
    }
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1_000 : 3_600_000;
    const key =
      typeof parsed.Key === "string"
        ? parsed.Key
        : typeof parsed.key === "string"
          ? parsed.key
          : null;
    return {
      accessToken,
      expiresAt: started + lifetimeMs,
      key,
      kdf: parsed,
    };
  }

  /** An authenticated JSON request to the API host. */
  async api(
    endpoints: BitwardenEndpoints,
    accessToken: string,
    method: "GET" | "POST" | "PUT",
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    const response = await this.exchange(
      `${endpoints.apiUrl}${path}`,
      {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "device-type": DEVICE_TYPE_SDK,
          "bitwarden-client-name": CLIENT_NAME,
          ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      options,
    );
    return {
      status: response.status,
      headers: response.headers,
      json: response.body.length ? safeJson(response.body) : null,
    };
  }

  /** Downloads an attachment body from wherever the server stores it, without credentials. */
  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new VaultProviderError(
        "provider_unavailable",
        "Bitwarden returned no download address",
      );
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new VaultProviderError(
        "provider_unavailable",
        "Bitwarden returned no download address",
      );
    }
    const response = await this.exchange(
      target.toString(),
      { method: "GET", headers: {} },
      { signal, maxBytes, what: "downloading the attachment" },
    );
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response.status, "downloading the attachment", false);
    }
    return response.body;
  }
}

/** One stable device per API key, so the account lists one "Opengeni" device. */
export function deviceIdentifier(clientId: string): string {
  const hex = createHash("sha256").update(`opengeni-device\n${clientId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function tooLarge(): VaultProviderError {
  return new VaultProviderError(
    "provider_inventory_incomplete",
    "Bitwarden returned more data than Opengeni reads at once",
  );
}

function safeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function parseJson(body: Uint8Array, what: string): unknown {
  const value = safeJson(body);
  if (value === null) {
    throw new VaultProviderError("provider_unavailable", `Bitwarden returned unreadable ${what}`);
  }
  return value;
}

export function rateLimited(headers: Headers, what: string): VaultProviderError {
  const seconds = Number(headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 60_000;
  return new VaultProviderError(
    "provider_rate_limited",
    `Bitwarden is limiting requests (${what}); try again shortly`,
    retryAfterMs,
  );
}

/** The server's own message for a refused request, when it gives one. */
export function serverMessage(json: unknown): string | null {
  const body = record(json);
  if (!body) return null;
  const direct = body.message ?? body.Message;
  if (typeof direct === "string" && direct.trim()) return direct.trim().slice(0, 300);
  const model = record(body.validationErrors ?? body.ValidationErrors);
  if (model) {
    for (const value of Object.values(model)) {
      if (Array.isArray(value) && typeof value[0] === "string") return value[0].slice(0, 300);
    }
  }
  const errorModel = record(body.errorModel ?? body.ErrorModel);
  const nested = errorModel?.message ?? errorModel?.Message;
  return typeof nested === "string" && nested.trim() ? nested.trim().slice(0, 300) : null;
}

export function statusError(
  status: number,
  what: string,
  write: boolean,
  json?: unknown,
): VaultProviderError {
  const message = serverMessage(json);
  const detail = message ? `: ${message}` : "";
  if (status === 401) {
    return new VaultProviderError(
      "provider_auth_expired",
      `Bitwarden signed this connection out (${what})`,
    );
  }
  if (status === 403) {
    return new VaultProviderError(
      "provider_permission_denied",
      `Bitwarden does not allow this account to do that (${what})${detail}`,
    );
  }
  if (status === 404) {
    return new VaultProviderError("provider_not_found", `Bitwarden has no such item (${what})`);
  }
  if (status === 400 && message && /out of date/i.test(message)) {
    return new VaultProviderError(
      "provider_conflict",
      "The Bitwarden item changed since it was read; read it again before writing",
    );
  }
  if (status === 400 || status === 422) {
    // Bitwarden answers permission problems on items with 400 and a message.
    return new VaultProviderError(
      /permission|not allowed|cannot|can't|access/i.test(message ?? "")
        ? "provider_permission_denied"
        : "provider_conflict",
      `Bitwarden refused ${what}${detail}`,
    );
  }
  if (write && status >= 500) {
    return new VaultProviderError(
      "provider_outcome_unknown",
      `Bitwarden failed while ${what} (HTTP ${status}); check the item before trying again`,
    );
  }
  return new VaultProviderError(
    "provider_unavailable",
    `Bitwarden is unavailable (${what}, HTTP ${status})`,
  );
}
