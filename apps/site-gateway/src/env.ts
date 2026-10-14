import { normalizeSitesDomain } from "@opengeni/contracts";

/** The slice of the Workers KV API the gateway uses (host map). */
export type KVNamespaceLike = {
  get(key: string, options: { type: "text"; cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

/** The Workers rate-limit binding (`[[ratelimits]]`). */
export type RateLimiterLike = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

/**
 * Bindings, vars and secrets. Every domain and origin is configuration; the
 * code never names a concrete one. See README.md for the full list.
 */
export interface GatewayEnv {
  SITES_DOMAIN?: string;
  API_ORIGIN?: string;
  APP_ORIGIN?: string;
  GATEWAY_SECRET?: string;
  ENVIRONMENT?: string;
  FORCE_NOINDEX?: string;
  LOGIN_ONLY?: string;
  ABUSE_EMAIL?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  HOST_MAP?: KVNamespaceLike;
  RATE_LIMITER?: RateLimiterLike;
  /**
   * PR B extension point: the per-Site SQLite Durable Object namespace
   * (`idFromName(siteId)`). Unbound until optional Cloudflare storage ships;
   * see `src/site-db.ts`.
   */
  SITE_DB?: unknown;
}

export type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

export type GatewayConfig = {
  sitesDomain: string;
  apiOrigin: string;
  appOrigin: string;
  secret: string;
  environment: string;
  /** Local development: Site origins may be plain HTTP on loopback names. */
  development: boolean;
  forceNoindex: boolean;
  loginOnly: boolean;
  abuseEmail: string;
  turnstile: { siteKey: string; secret: string } | null;
  hostMap: KVNamespaceLike | null;
  rateLimiter: RateLimiterLike | null;
};

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

const configs = new WeakMap<GatewayEnv, GatewayConfig>();

/** Parse and cache the configuration for one env object (one per isolate in production). */
export function gatewayConfig(env: GatewayEnv): GatewayConfig {
  const cached = configs.get(env);
  if (cached) return cached;
  const environment = (env.ENVIRONMENT ?? "production").trim() || "production";
  const development = environment === "development" || environment === "test";
  let sitesDomain: string;
  try {
    sitesDomain = normalizeSitesDomain(env.SITES_DOMAIN ?? "");
  } catch {
    throw new GatewayConfigError("SITES_DOMAIN must be a hostname");
  }
  const secret = env.GATEWAY_SECRET ?? "";
  if (secret.length < 32)
    throw new GatewayConfigError("GATEWAY_SECRET must be at least 32 characters");
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY?.trim() ?? "";
  const turnstileSecret = env.TURNSTILE_SECRET?.trim() ?? "";
  const config: GatewayConfig = {
    sitesDomain,
    apiOrigin: origin(env.API_ORIGIN, "API_ORIGIN"),
    appOrigin: origin(env.APP_ORIGIN, "APP_ORIGIN"),
    secret,
    environment,
    development,
    forceNoindex: flag(env.FORCE_NOINDEX),
    loginOnly: flag(env.LOGIN_ONLY),
    abuseEmail: env.ABUSE_EMAIL?.trim() || `abuse@${sitesDomain}`,
    turnstile:
      turnstileSiteKey && turnstileSecret
        ? { siteKey: turnstileSiteKey, secret: turnstileSecret }
        : null,
    hostMap: env.HOST_MAP ?? null,
    rateLimiter: env.RATE_LIMITER ?? null,
  };
  configs.set(env, config);
  return config;
}

function flag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An origin (scheme, host, port; no path). HTTPS only, except plain HTTP on loopback. */
function origin(value: string | undefined, name: string): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new GatewayConfigError(`${name} must be an absolute URL`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new GatewayConfigError(`${name} must use https`);
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new GatewayConfigError(`${name} must be an origin without a path`);
  return url.origin;
}
