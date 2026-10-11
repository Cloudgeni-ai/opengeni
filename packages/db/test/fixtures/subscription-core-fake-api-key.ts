/**
 * A test-only API-key connector for the shared subscription core (design
 * docs/design/subscription-core-2026-10-07.md, 5.3 step F): the shape a real
 * connector such as an OpenRouter or Vercel AI Gateway key takes. It is
 * registered only inside the conformance harness (never in
 * `subscription-core-providers.ts`, never by a migration).
 *
 * - A static credential (`{ apiKey }`), no refresh, no expiry, no quota
 *   windows; usage limits are a spend budget and rate limits.
 * - Many models from several vendors behind one key.
 * - Identity: a key carries no upstream account or person, so sign-in derives
 *   a stable synthetic identity from the key itself (an HMAC-SHA256 under a
 *   deployment secret, so the stored value confirms no guessed key and does
 *   not correlate tenants across deployments), never from caller input, and
 *   refuses a key the upstream does not accept.
 * - A scripted local upstream (the only network the harness allows).
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type {
  ProviderErrorOutcome,
  SubscriptionCoreAdapter,
  SubscriptionQuota,
} from "@opengeni/subscriptions";
import { subscriptionCoreDefaultErrors } from "../../src/subscription-core/errors";
import type { SubscriptionCoreProvider } from "../../src/subscription-core/provider";
import type {
  ScriptedReply,
  SubscriptionCoreConformanceUpstream,
} from "../helpers/subscription-core-conformance";

/** The fake provider id (registry format); never registered outside tests. */
export const FAKE_API_KEY_PROVIDER = "conformance_api_key";

/** Models of three vendors behind one key, as an API gateway serves them. */
export const FAKE_API_KEY_MODELS = [
  { productModelId: "conformance/acme-large", upstreamModelId: "acme/large" },
  { productModelId: "conformance/globex-fast", upstreamModelId: "globex/fast" },
  { productModelId: "conformance/initech-mini", upstreamModelId: "initech/mini" },
] as const;

export type FakeApiKeyCredential = { apiKey: string };

export const FAKE_API_KEY_FORBIDDEN_QUARANTINE_MS = 10 * 60 * 1000;
export const FAKE_API_KEY_ENTITLEMENT_COOLDOWN_MS = 60 * 60 * 1000;
export const FAKE_API_KEY_RATE_LIMIT_FALLBACK_MS = 60 * 1000;
/** A spend budget refused without a reset is retried after an hour. */
export const FAKE_API_KEY_EXHAUSTED_FALLBACK_MS = 60 * 60 * 1000;
/** How long the connector's transport waits for a reply. */
export const FAKE_API_KEY_REQUEST_TIMEOUT_MS = 2_000;
/** The one stored credential format of the connector (a key never renews). */
export const FAKE_API_KEY_CREDENTIAL_FORMAT = "conformance_api_key_v1";

const fakeApiKeyCapabilities = Object.freeze({
  autoRenews: false,
  resetCredits: false,
  extraCredits: false,
  modelEntitlements: true,
  realtime: false,
  fundsMedia: false,
  apps: false,
  remoteCompaction: false,
  quotaWindows: false,
});

export const fakeApiKeyAdapter: SubscriptionCoreAdapter<FakeApiKeyCredential> = Object.freeze({
  provider: FAKE_API_KEY_PROVIDER,
  displayName: "Conformance API key",
  capabilities: fakeApiKeyCapabilities,
  // One format; an unknown stored format fails closed.
  capabilitiesFor: (format: string) => {
    if (format !== FAKE_API_KEY_CREDENTIAL_FORMAT) {
      throw new Error("Unknown conformance API key credential format");
    }
    return fakeApiKeyCapabilities;
  },
  credentialKind: "api_key",
  quotaKind: "spend_budget",
  modelPolicyProviderId: FAKE_API_KEY_PROVIDER,
  cacheFacts: Object.freeze({ kind: "measured_idle_cutoff", cutoffMs: null }),
  health: Object.freeze({
    forbiddenQuarantineMs: FAKE_API_KEY_FORBIDDEN_QUARANTINE_MS,
    entitlementCooldownMs: FAKE_API_KEY_ENTITLEMENT_COOLDOWN_MS,
    rateLimitFallbackMs: FAKE_API_KEY_RATE_LIMIT_FALLBACK_MS,
    exhaustedFallbackMs: FAKE_API_KEY_EXHAUSTED_FALLBACK_MS,
  }),
  credential: Object.freeze({
    decode(plaintext: string): FakeApiKeyCredential {
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext);
      } catch {
        throw new Error("A conformance API key could not be decoded");
      }
      const record = parsed as Record<string, unknown> | null;
      if (!record || typeof record.apiKey !== "string" || record.apiKey.length === 0) {
        throw new Error("A conformance API key does not hold the expected key object");
      }
      return { apiKey: record.apiKey };
    },
    encode: (credential: FakeApiKeyCredential) => JSON.stringify({ apiKey: credential.apiKey }),
    expiry: () => null,
    format: () => FAKE_API_KEY_CREDENTIAL_FORMAT,
  }),
  refresh: null,
  reloginText: (message: string) =>
    message || "The API key was refused by the provider. Add a new key to continue.",
});

/** The database binding, as a real connector's module would export it. */
export const fakeApiKeyProvider: SubscriptionCoreProvider<FakeApiKeyCredential> = Object.freeze({
  adapter: fakeApiKeyAdapter,
  sessionCompactionLock: null,
  errors: subscriptionCoreDefaultErrors(fakeApiKeyAdapter.displayName),
  // API-key connectors have no primary setting (design 5.1.2).
  settings: Object.freeze({ primaryColumn: null }),
  organizationAllocatorChanged: null,
});

/** Stands in for the deployment secret a real connector keys identities with. */
export const FAKE_API_KEY_IDENTITY_SECRET = "conformance-deployment-identity-secret";

/**
 * The stable synthetic identity of a key: a keyed fingerprint (HMAC-SHA256
 * under the deployment secret), never the key and never an unkeyed hash.
 */
export function fakeApiKeyFingerprint(
  apiKey: string,
  secret: string = FAKE_API_KEY_IDENTITY_SECRET,
): string {
  return `key-hmac:${createHmac("sha256", secret).update(apiKey).digest("hex").slice(0, 32)}`;
}

export type ScriptedUsage = { spentCents: number; limitCents: number; resetsAt: number | null };

/**
 * A local HTTP upstream with a scripted response per bearer: completions, key
 * validation (sign-in) and the spend-budget usage endpoint, in an
 * OpenAI-compatible gateway's wire shape. It serves the fake API-key
 * connector by default; another subject passes how its credential presents
 * as a bearer (the suite then drives that provider's binding through the same
 * scripted transport).
 */
export class ScriptedApiKeyUpstream<Credential = FakeApiKeyCredential>
  implements SubscriptionCoreConformanceUpstream<Credential>
{
  constructor(
    private readonly bearer: (credential: Credential) => string = (credential) =>
      (credential as FakeApiKeyCredential).apiKey,
  ) {}

  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly replies = new Map<string, ScriptedReply[]>();
  private readonly spend = new Map<string, ScriptedUsage>();
  private readonly keys = new Set<string>();
  readonly requests: Array<{ path: string; apiKey: string | null; model: string | null }> = [];

  get origin(): string {
    if (!this.server) throw new Error("Scripted upstream is not running");
    return `http://127.0.0.1:${this.server.port}`;
  }

  start(): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => this.handle(request),
    });
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /** Accept a key (sign-in validates against this). */
  issue(apiKey: string, usage: ScriptedUsage = { spentCents: 0, limitCents: 10_000, resetsAt: null }) {
    this.keys.add(apiKey);
    this.spend.set(apiKey, usage);
  }

  revoke(apiKey: string): void {
    this.keys.delete(apiKey);
  }

  accept(credential: Credential): void {
    this.issue(this.bearer(credential));
  }

  /** Queue replies for a bearer's next completions (default: ok). */
  script(credential: Credential, replies: readonly ScriptedReply[]): void {
    const apiKey = this.bearer(credential);
    this.replies.set(apiKey, [...(this.replies.get(apiKey) ?? []), ...replies]);
  }

  setUsage(apiKey: string, usage: ScriptedUsage): void {
    this.spend.set(apiKey, usage);
  }

  complete(credential: Credential, upstreamModelId: string): Promise<void> {
    return fakeApiKeyComplete(this.origin, { apiKey: this.bearer(credential) }, upstreamModelId);
  }

  classify(error: unknown, now: number, productModelId: string): ProviderErrorOutcome | null {
    return classifyFakeApiKeyError(error, now, productModelId);
  }

  /** The spend-budget usage endpoint, read through the connector. */
  readonly usage = {
    restore: (credential: Credential) =>
      this.setUsage(this.bearer(credential), { spentCents: 100, limitCents: 10_000, resetsAt: null }),
    read: (credential: Credential, observedAt: number, refreshGeneration: number) =>
      fakeApiKeyUsage(this.origin, { apiKey: this.bearer(credential) }, observedAt, refreshGeneration),
  };

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const header = request.headers.get("authorization");
    const apiKey = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    let model: string | null = null;
    if (request.method === "POST") {
      const body = (await request.json()) as { model?: unknown };
      model = typeof body.model === "string" ? body.model : null;
    }
    this.requests.push({ path: url.pathname, apiKey, model });
    if (!apiKey || !this.keys.has(apiKey)) {
      return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
    }
    if (url.pathname === "/v1/key") {
      return Response.json({ data: { label: "conformance" } });
    }
    if (url.pathname === "/v1/usage") {
      return Response.json({ data: this.spend.get(apiKey) });
    }
    if (url.pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
    const reply = this.replies.get(apiKey)?.shift() ?? { kind: "ok" };
    switch (reply.kind) {
      case "ok":
        return Response.json({ model, choices: [{ message: { content: "ok" } }] });
      case "rate_limited":
        return Response.json(
          { error: { code: "rate_limited" } },
          {
            status: 429,
            headers:
              reply.retryAfterSeconds === null
                ? {}
                : { "retry-after": String(reply.retryAfterSeconds) },
          },
        );
      case "model_rate_limited":
        return Response.json(
          { error: { code: "model_rate_limited", model } },
          {
            status: 429,
            headers:
              reply.retryAfterSeconds === null
                ? {}
                : { "retry-after": String(reply.retryAfterSeconds) },
          },
        );
      case "budget_exhausted":
        // As OpenRouter reports a spent key limit or budget (its "Budget
        // errors"): a 403 whose body names the limit and the ISO instant it
        // resets (null for a lifetime one).
        return Response.json(
          {
            error: {
              code: 403,
              message: "Budget limit exceeded (key limit).",
              metadata: {
                limit_source: "openrouter_key_limit",
                resets_at: reply.resetsAt === null ? null : new Date(reply.resetsAt).toISOString(),
              },
            },
          },
          { status: 403 },
        );
      case "unauthorized":
        return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
      case "forbidden":
        return Response.json({ error: { code: "forbidden" } }, { status: 403 });
      case "model_unavailable":
        return Response.json({ error: { code: "model_not_available", model } }, { status: 404 });
      case "overloaded":
        return Response.json({ error: { code: "overloaded" } }, { status: 529 });
      case "server_error":
        return Response.json({ error: { code: "internal" } }, { status: 500 });
      case "connection_lost":
        // The request arrived and no reply ever comes: the transport gives
        // up, and whether the upstream did the work is unknowable.
        return await new Promise<Response>(() => {});
    }
  }
}

/** What the connector's transport throws for a refused request. */
export class FakeApiKeyUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | null,
    readonly body: {
      error?: {
        code?: string | number;
        message?: string;
        model?: string;
        metadata?: {
          limit_source?: string;
          reason?: string;
          resets_at?: string | null;
          /** A guardrail block's matched patterns. */
          patterns?: string[];
          /** A moderation flag's reasons. */
          reasons?: string[];
          /** OpenRouter's typed provider error code. */
          error_type?: string;
        };
      };
    },
  ) {
    super(`conformance upstream refused the request (${status})`);
  }
}

/**
 * The connector's transport: request-local authorization with the key and
 * the upstream model id. Throws `FakeApiKeyUpstreamError` on a refusal.
 */
export async function fakeApiKeyComplete(
  origin: string,
  credential: FakeApiKeyCredential,
  upstreamModelId: string,
): Promise<void> {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: upstreamModelId, messages: [{ role: "user", content: "hi" }] }),
    // A reply that never comes is given up on (an unknown outcome).
    signal: AbortSignal.timeout(FAKE_API_KEY_REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    await response.arrayBuffer();
    return;
  }
  const retryAfter = response.headers.get("retry-after");
  throw new FakeApiKeyUpstreamError(
    response.status,
    retryAfter === null ? null : Number(retryAfter),
    (await response.json()) as FakeApiKeyUpstreamError["body"],
  );
}

/** An ISO reset instant from an error body, or null when absent or unreadable. */
function resetInstant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

/**
 * The connector's error classification into the shared outcomes (design 2.1
 * and 5.3). A 402 or 403 is read from its body (OpenRouter's shapes), never
 * from its status alone.
 */
export function classifyFakeApiKeyError(
  error: unknown,
  _now: number,
  productModelId: string,
): ProviderErrorOutcome | null {
  if (!(error instanceof FakeApiKeyUpstreamError)) return null;
  const metadata = error.body.error?.metadata;
  const retryAfterMs = error.retryAfterSeconds === null ? null : error.retryAfterSeconds * 1000;
  switch (error.status) {
    case 429:
      return {
        kind: "rate_limited",
        retryAfterMs,
        // A gateway's per-model limit names the model it limits.
        ...(error.body.error?.code === "model_rate_limited" ? { modelId: productModelId } : {}),
      };
    case 402:
      // A full in-flight budget is transient and says when to retry; one
      // request too expensive for the whole budget fails alone (retrying it
      // cannot help, and smaller requests still fit); anything else is spent
      // credit or a spent key limit, exhausted until a top-up or reset.
      if (metadata?.limit_source === "openrouter_in_flight_budget")
        return { kind: "rate_limited", retryAfterMs };
      if (metadata?.reason === "weight_exceeds_budget") return { kind: "fatal" };
      return { kind: "exhausted", resetAt: resetInstant(metadata?.resets_at) };
    case 401:
      return { kind: "unauthorized" };
    case 403: {
      // A 403 is read from its body, not its status alone: a spent limit
      // waits for its reset, a block of this one request (a guardrail's
      // patterns, a moderation flag's reasons, or a provider's content policy
      // or refusal) changes no health, and only a refusal of the key itself
      // quarantines the connection.
      if (metadata?.limit_source !== undefined)
        return { kind: "exhausted", resetAt: resetInstant(metadata.resets_at) };
      if (
        metadata?.patterns !== undefined ||
        metadata?.reasons !== undefined ||
        metadata?.error_type === "content_policy_violation" ||
        metadata?.error_type === "refusal"
      )
        return { kind: "fatal" };
      return { kind: "forbidden" };
    }
    case 404:
      return error.body.error?.code === "model_not_available"
        ? { kind: "entitlement_missing", modelId: productModelId }
        : { kind: "fatal" };
    case 529:
      return { kind: "overloaded" };
    default:
      return error.status >= 500 ? { kind: "transient" } : { kind: "fatal" };
  }
}

/**
 * Sign-in for a pasted key: validate it upstream and derive the connection
 * identity. A key the upstream refuses never becomes a connection.
 */
export async function fakeApiKeySignIn(
  origin: string,
  apiKey: string,
): Promise<
  | { kind: "connected"; providerAccountId: string; providerSubjectId: string }
  | { kind: "refused" }
> {
  const response = await fetch(`${origin}/v1/key`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  await response.arrayBuffer();
  if (!response.ok) return { kind: "refused" };
  const fingerprint = fakeApiKeyFingerprint(apiKey);
  return { kind: "connected", providerAccountId: fingerprint, providerSubjectId: fingerprint };
}

/** The spend-budget usage endpoint decoded into the shared quota model (design 2.2). */
export async function fakeApiKeyUsage(
  origin: string,
  credential: FakeApiKeyCredential,
  observedAt: number,
  refreshGeneration: number,
): Promise<SubscriptionQuota> {
  const response = await fetch(`${origin}/v1/usage`, {
    headers: { authorization: `Bearer ${credential.apiKey}` },
  });
  if (!response.ok) throw new Error(`usage read failed (${response.status})`);
  const { data } = (await response.json()) as { data: ScriptedUsage };
  const usedPercent = Math.min(100, (data.spentCents / data.limitCents) * 100);
  return {
    windows: [
      {
        id: "spend_budget",
        usedPercent,
        resetsAt: data.resetsAt,
        status: usedPercent >= 100 ? "exhausted" : usedPercent >= 80 ? "warning" : "ok",
      },
    ],
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    revision: 0,
    observedAt,
    observedRefreshGeneration: refreshGeneration,
    source: "usage_endpoint",
  };
}

/**
 * Network-denial guard: every `fetch` and every `node:http`/`node:https`
 * request (`request`, `get`) must go to an allowed local origin. Any other
 * request is refused and recorded, and `assertNoEscapes` fails the suite.
 * Raw sockets (`node:net`, `node:tls`) are not wrapped: PostgreSQL uses them,
 * and a connector's transport is an HTTP client.
 */
export function installNetworkDenialGuard(allowedOrigins: () => readonly string[]): {
  escapes: string[];
  assertNoEscapes(): void;
  restore(): void;
} {
  const original = globalThis.fetch;
  const escapes: string[] = [];
  const deny = (origin: string): Error => {
    escapes.push(origin);
    return new Error(`network access outside the scripted upstream is denied: ${origin}`);
  };
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!allowedOrigins().includes(url.origin)) throw deny(url.origin);
    return await original(input, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(guarded, { preconnect: original.preconnect });
  // node:http and node:https: the origin of `request(url | options, ...)`.
  const originOf = (scheme: "http:" | "https:", target: unknown): string => {
    if (typeof target === "string" || target instanceof URL) return new URL(target).origin;
    const options = (target ?? {}) as { protocol?: string; hostname?: string; host?: string; port?: unknown };
    const protocol = options.protocol ?? scheme;
    const host = options.hostname ?? options.host ?? "localhost";
    const port = options.port ?? (protocol === "https:" ? 443 : 80);
    return new URL(`${protocol}//${host}:${String(port)}`).origin;
  };
  const modules = [
    ["http:", http],
    ["https:", https],
  ] as const;
  const originals = modules.map(([, module]) => ({ request: module.request, get: module.get }));
  modules.forEach(([scheme, module], index) => {
    for (const name of ["request", "get"] as const) {
      const call = originals[index]![name] as (...args: unknown[]) => unknown;
      (module as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const origin = originOf(scheme, args[0]);
        if (!allowedOrigins().includes(origin)) throw deny(origin);
        return call.apply(module, args);
      };
    }
  });
  return {
    escapes,
    assertNoEscapes() {
      if (escapes.length > 0) {
        throw new Error(`unexpected network access: ${[...new Set(escapes)].join(", ")}`);
      }
    },
    restore() {
      globalThis.fetch = original;
      modules.forEach(([, module], index) => {
        Object.assign(module, originals[index]);
      });
    },
  };
}
