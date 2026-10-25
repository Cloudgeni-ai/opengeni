// Microsoft Entra ID access tokens for Azure AI services (Azure OpenAI, Azure
// Speech and other Cognitive Services accounts), from a service principal's
// client secret or a workload identity's federated token file. Plain fetch to
// the tenant's OAuth 2.0 token endpoint; no Azure SDK.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** The audience every Azure AI services data-plane call accepts. */
export const AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";
export const AZURE_PUBLIC_AUTHORITY_HOST = "https://login.microsoftonline.com";

export type AzureEntraCredentialConfig = {
  /** The directory (tenant) ID or a verified domain of the tenant. */
  tenantId: string;
  /** The application (client) ID of the app registration or managed identity. */
  clientId: string;
  /** A workload identity's federated token file. Kubernetes mounts and rotates it. */
  federatedTokenFile?: string | undefined;
  /** A service principal's client secret, where there is no workload identity. */
  clientSecret?: string | undefined;
  /** Defaults to the public cloud; sovereign clouds use their own host. */
  authorityHost?: string | undefined;
};

export type AzureEntraTokenErrorReason = "not_configured" | "network" | "rejected" | "unavailable";

/**
 * A token request that failed. The message names only Entra's error code and
 * AADSTS numbers, never its description (which echoes request details) or
 * any credential.
 */
export class AzureEntraTokenError extends Error {
  readonly reason: AzureEntraTokenErrorReason;
  readonly retryable: boolean;
  /** Entra's `error` code, such as `invalid_client`, when it sent one. */
  readonly code: string | null;
  /** Entra's AADSTS error numbers, such as 7000215 for an invalid secret. */
  readonly errorCodes: readonly number[];

  constructor(
    message: string,
    options: {
      reason: AzureEntraTokenErrorReason;
      retryable: boolean;
      code?: string | null;
      errorCodes?: readonly number[];
    },
  ) {
    super(message);
    this.name = "AzureEntraTokenError";
    this.reason = options.reason;
    this.retryable = options.retryable;
    this.code = options.code ?? null;
    this.errorCodes = options.errorCodes ?? [];
  }
}

/**
 * A cached access token. Calling it returns a token that stays valid for at
 * least the refresh margin; `discard` drops a token the service refused, so
 * the next call acquires a new one (a token other than the cached one is
 * ignored, so concurrent refusals of an old token cannot evict a new one).
 */
export type AzureEntraAccessTokenSource = {
  (): Promise<string>;
  discard(token: string): void;
};

export type AzureEntraAccessTokenSourceOptions = {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readTokenFile?: (path: string) => Promise<string>;
  now?: () => number;
  scope?: string;
  requestTimeoutMilliseconds?: number;
};

/** Refresh this long before expiry, or at half the lifetime of a shorter-lived token. */
const REFRESH_MARGIN_MILLISECONDS = 5 * 60_000;
/** A cached token is still sent this close to expiry while a refresh is failing. */
const EXPIRY_SKEW_MILLISECONDS = 60_000;
/** While a still-valid token is cached, a failed refresh is retried after this long. */
const FAILED_REFRESH_BACKOFF_MILLISECONDS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

function authorityBase(host: string | undefined): string {
  return (host ?? AZURE_PUBLIC_AUTHORITY_HOST).replace(/\/*$/u, "/");
}

/** Whether a configuration names a usable credential: a token file or a secret. */
export function azureEntraCredentialConfigured(
  config: Partial<AzureEntraCredentialConfig> | null | undefined,
): config is AzureEntraCredentialConfig {
  return Boolean(
    config?.tenantId?.trim() &&
    config.clientId?.trim() &&
    (config.federatedTokenFile?.trim() || config.clientSecret),
  );
}

function numericErrorCodes(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((code): code is number => Number.isInteger(code)).slice(0, 8)
    : [];
}

/**
 * Access tokens from one credential, cached until shortly before they expire.
 * Concurrent callers share one token request. A federated token file is read
 * on every request, because the kubelet rotates it.
 */
export function createAzureEntraAccessTokenSource(
  config: AzureEntraCredentialConfig,
  options: AzureEntraAccessTokenSourceOptions = {},
): AzureEntraAccessTokenSource {
  const request =
    options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
  const readTokenFile = options.readTokenFile ?? ((path: string) => readFile(path, "utf8"));
  const now = options.now ?? (() => Date.now());
  const scope = options.scope ?? AZURE_COGNITIVE_SERVICES_SCOPE;
  const timeout = options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;
  const tokenUrl = `${authorityBase(config.authorityHost)}${encodeURIComponent(config.tenantId.trim())}/oauth2/v2.0/token`;
  let cached: { token: string; refreshAt: number; expiresAt: number } | null = null;
  let retryAfter = 0;
  let pending: Promise<string> | null = null;

  async function requestToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId.trim(),
      scope,
    });
    if (config.federatedTokenFile?.trim()) {
      let assertion: string;
      try {
        assertion = (await readTokenFile(config.federatedTokenFile.trim())).trim();
      } catch {
        throw new AzureEntraTokenError("The federated token file could not be read", {
          reason: "not_configured",
          retryable: true,
        });
      }
      if (!assertion) {
        throw new AzureEntraTokenError("The federated token file is empty", {
          reason: "not_configured",
          retryable: true,
        });
      }
      body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      body.set("client_assertion", assertion);
    } else if (config.clientSecret) {
      body.set("client_secret", config.clientSecret);
    } else {
      throw new AzureEntraTokenError("No Microsoft Entra ID credential is configured", {
        reason: "not_configured",
        retryable: false,
      });
    }
    const requestedAt = now();
    let response: Response;
    try {
      response = await request(tokenUrl, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new AzureEntraTokenError("Could not reach Microsoft Entra ID", {
        reason: "network",
        retryable: true,
      });
    }
    const json = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      refresh_in?: unknown;
      error?: unknown;
      error_codes?: unknown;
    } | null;
    if (!response.ok || typeof json?.access_token !== "string" || !json.access_token) {
      const code =
        typeof json?.error === "string" && /^[a-z_]{1,64}$/u.test(json.error) ? json.error : null;
      const errorCodes = numericErrorCodes(json?.error_codes);
      const unavailable = response.status >= 500 || response.status === 429;
      throw new AzureEntraTokenError(
        `Microsoft Entra ID refused a token (${[
          code ?? `HTTP ${response.status}`,
          ...errorCodes.map((value) => `AADSTS${value}`),
        ].join(", ")})`,
        {
          reason: unavailable ? "unavailable" : "rejected",
          retryable: unavailable,
          code,
          errorCodes,
        },
      );
    }
    const seconds = (value: unknown) => {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed * 1_000 : null;
    };
    const lifetime = seconds(json.expires_in) ?? 0;
    const refreshIn = seconds(json.refresh_in);
    const margin = Math.min(REFRESH_MARGIN_MILLISECONDS, lifetime / 2);
    cached = {
      token: json.access_token,
      expiresAt: requestedAt + lifetime,
      refreshAt: Math.min(
        requestedAt + lifetime - margin,
        refreshIn === null ? Number.POSITIVE_INFINITY : requestedAt + refreshIn,
      ),
    };
    retryAfter = 0;
    return json.access_token;
  }

  function shared(): Promise<string> {
    pending ??= requestToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  const source = (async () => {
    const current = cached;
    const at = now();
    if (current && at < current.refreshAt) return current.token;
    const usable = current && at < current.expiresAt - EXPIRY_SKEW_MILLISECONDS;
    // A refresh that just failed is not retried on every call while the
    // cached token still works.
    if (usable && at < retryAfter) return current.token;
    try {
      return await shared();
    } catch (error) {
      if (!usable) throw error;
      retryAfter = now() + FAILED_REFRESH_BACKOFF_MILLISECONDS;
      return current.token;
    }
  }) as AzureEntraAccessTokenSource;
  source.discard = (token: string) => {
    if (cached?.token !== token) return;
    cached = null;
    retryAfter = 0;
  };
  return source;
}

const SHARED_SOURCE_LIMIT = 256;
const sharedSources = new Map<string, AzureEntraAccessTokenSource>();

/**
 * One process-wide token source per exact credential, so concurrent turns
 * and model calls with the same identity share its token. The cache key is
 * a digest of the whole credential (the secret included), so a caller gets a
 * cached token only by presenting the same credential, and a replaced
 * secret starts a new source.
 */
export function sharedAzureEntraAccessTokenSource(
  config: AzureEntraCredentialConfig,
  options: { scope?: string } = {},
): AzureEntraAccessTokenSource {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        authorityBase(config.authorityHost),
        config.tenantId.trim(),
        config.clientId.trim(),
        options.scope ?? AZURE_COGNITIVE_SERVICES_SCOPE,
        config.federatedTokenFile?.trim() ?? null,
        config.clientSecret ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
  const existing = sharedSources.get(key);
  if (existing) {
    sharedSources.delete(key);
    sharedSources.set(key, existing);
    return existing;
  }
  const source = createAzureEntraAccessTokenSource(config, options);
  sharedSources.set(key, source);
  while (sharedSources.size > SHARED_SOURCE_LIMIT) {
    const oldest = sharedSources.keys().next().value;
    if (oldest === undefined) break;
    sharedSources.delete(oldest);
  }
  return source;
}

/** Test seam: forget every shared token source. */
export function resetSharedAzureEntraAccessTokenSources(): void {
  sharedSources.clear();
}
