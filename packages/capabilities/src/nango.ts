import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  NANGO_DEFAULT_API_BASE_URL,
  NANGO_TAG,
  nangoApiUrl,
  nangoAuthHeaders,
  type NangoToolDescriptor,
} from "@opengeni/contracts/nango";

/**
 * Server-side Nango helpers (docs/nango.md): webhook signature verification and
 * the HTTP API client. The shared, browser-safe definitions live in
 * `@opengeni/contracts/nango` and are re-exported here.
 */
export * from "@opengeni/contracts/nango";

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** `X-Nango-Hmac-Sha256`: hex HMAC-SHA256 of the raw body with the signing key. */
export function verifyNangoWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  signingKeys: readonly string[],
): boolean {
  if (!signature || !/^[0-9a-f]{64}$/iu.test(signature.trim())) return false;
  const received = Buffer.from(signature.trim().toLowerCase(), "hex");
  return signingKeys.some((key) => {
    if (!key) return false;
    const expected = createHmac("sha256", key).update(rawBody, "utf8").digest();
    return expected.length === received.length && timingSafeEqual(expected, received);
  });
}

export type NangoAuthWebhook = {
  type: "auth";
  operation: "creation" | "override" | "refresh" | "deletion" | string;
  connectionId: string;
  providerConfigKey: string;
  success: boolean;
  tags: Record<string, string>;
};

export function parseNangoAuthWebhook(payload: unknown): NangoAuthWebhook | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  if (raw.type !== "auth" || typeof raw.operation !== "string") return null;
  if (typeof raw.connectionId !== "string" || typeof raw.providerConfigKey !== "string")
    return null;
  const tags: Record<string, string> = {};
  if (raw.tags && typeof raw.tags === "object" && !Array.isArray(raw.tags))
    for (const [key, value] of Object.entries(raw.tags as Record<string, unknown>))
      if (typeof value === "string") tags[key.toLowerCase()] = value;
  return {
    type: "auth",
    operation: raw.operation,
    connectionId: raw.connectionId,
    providerConfigKey: raw.providerConfigKey,
    success: raw.success === true,
    tags,
  };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class NangoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NangoApiError";
  }
}

export type NangoConnectionSummary = {
  connectionId: string;
  providerConfigKey: string;
  provider: string | null;
  createdAt: string | null;
  tags: Record<string, string>;
  authErrors: number;
};

const MAX_NANGO_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readBoundedText(
  response: Response,
  maxBytes = MAX_NANGO_RESPONSE_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new NangoApiError("Nango response is too large", response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorCode(body: unknown): string | undefined {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === "string" ? error.code.slice(0, 100) : undefined;
}

export type NangoClientOptions = {
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

/** Minimal Nango HTTP API client. Never logs or returns the secret key. */
export class NangoClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: NangoClientOptions) {
    if (!options.secretKey) throw new Error("Nango is not configured");
    this.baseUrl = (options.baseUrl ?? NANGO_DEFAULT_API_BASE_URL).replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async json(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<{ status: number; body: unknown; bytes: number }> {
    const response = await this.fetchImpl(nangoApiUrl(this.baseUrl, path), {
      method,
      headers: {
        ...nangoAuthHeaders({ secretKey: this.options.secretKey }),
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(this.timeoutMs),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
    const text = await readBoundedText(response);
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, bytes: Buffer.byteLength(text) };
  }

  private async ok(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ) {
    const result = await this.json(method, path, init);
    if (result.status < 200 || result.status >= 300)
      throw new NangoApiError(
        `Nango ${method} ${path.split("?")[0]} failed with ${result.status}`,
        result.status,
        errorCode(result.body),
      );
    return result;
  }

  async createConnectSession(input: {
    tags: Record<string, string>;
    allowedIntegrations: string[];
  }): Promise<{ token: string; connectLink: string | null; expiresAt: string | null }> {
    const { body } = await this.ok("POST", "/connect/sessions", {
      body: { tags: input.tags, allowed_integrations: input.allowedIntegrations },
    });
    const data = (body as { data?: Record<string, unknown> } | null)?.data;
    if (typeof data?.token !== "string" || !data.token)
      throw new NangoApiError("Nango did not return a connect session", 502);
    return {
      token: data.token,
      connectLink:
        typeof data.connect_link === "string" && /^https:\/\//u.test(data.connect_link)
          ? data.connect_link
          : null,
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : null,
    };
  }

  /** Lists connections without credentials, filtered by exact tags. */
  async listConnections(
    input: {
      connectionId?: string;
      tags?: Record<string, string>;
      page?: number;
    } = {},
  ): Promise<NangoConnectionSummary[]> {
    const query = new URLSearchParams();
    if (input.connectionId) query.set("connectionId", input.connectionId);
    for (const [key, value] of Object.entries(input.tags ?? {})) query.set(`tags[${key}]`, value);
    query.set("limit", "100");
    if (input.page !== undefined) query.set("page", String(input.page));
    const { body } = await this.ok("GET", `/connections?${query.toString()}`);
    const connections = (body as { connections?: unknown[] } | null)?.connections;
    if (!Array.isArray(connections)) return [];
    return connections.flatMap((entry) => {
      const raw = entry as Record<string, unknown>;
      if (typeof raw.connection_id !== "string" || typeof raw.provider_config_key !== "string")
        return [];
      const tags: Record<string, string> = {};
      if (raw.tags && typeof raw.tags === "object")
        for (const [key, value] of Object.entries(raw.tags as Record<string, unknown>))
          if (typeof value === "string") tags[key.toLowerCase()] = value;
      return [
        {
          connectionId: raw.connection_id,
          providerConfigKey: raw.provider_config_key,
          provider: typeof raw.provider === "string" ? raw.provider : null,
          createdAt: typeof raw.created === "string" ? raw.created : null,
          tags,
          authErrors: Array.isArray(raw.errors)
            ? raw.errors.filter((error) => (error as { type?: unknown })?.type === "auth").length
            : 0,
        },
      ];
    });
  }

  /**
   * One connection read with the documented `GET /connections/{id}`, or null
   * when Nango does not know it. Only its summary and granted scopes leave this
   * method; credentials in the response are never returned. `tags` is null
   * when the response carries no tags object.
   *
   * This read makes Nango refresh an expired token, and Nango answers 424
   * when that refresh fails: that is returned as `refreshFailed: true` (with
   * one auth error), not thrown. Use `listConnections` to read errors
   * without a refresh.
   */
  async getConnection(
    connectionId: string,
    providerConfigKey: string,
  ): Promise<
    | (Omit<NangoConnectionSummary, "tags"> & {
        tags: Record<string, string> | null;
        scopes: string[] | null;
        refreshFailed: boolean;
      })
    | null
  > {
    const query = new URLSearchParams({
      provider_config_key: providerConfigKey,
      refresh_token: "false",
    });
    const path = `/connections/${encodeURIComponent(connectionId)}?${query.toString()}`;
    const result = await this.json("GET", path);
    if (result.status === 404) return null;
    if (result.status === 424)
      return {
        connectionId,
        providerConfigKey,
        provider: null,
        createdAt: null,
        tags: null,
        authErrors: 1,
        scopes: null,
        refreshFailed: true,
      };
    if (result.status < 200 || result.status >= 300)
      throw new NangoApiError(
        `Nango GET /connections/{id} failed with ${result.status}`,
        result.status,
        errorCode(result.body),
      );
    const raw = (result.body ?? {}) as Record<string, unknown>;
    const reportedId = typeof raw.connection_id === "string" ? raw.connection_id : connectionId;
    const reportedKey =
      typeof raw.provider_config_key === "string" ? raw.provider_config_key : providerConfigKey;
    if (reportedId !== connectionId || reportedKey !== providerConfigKey) return null;
    let tags: Record<string, string> | null = null;
    if (raw.tags && typeof raw.tags === "object" && !Array.isArray(raw.tags)) {
      tags = {};
      for (const [key, value] of Object.entries(raw.tags as Record<string, unknown>))
        if (typeof value === "string") tags[key.toLowerCase()] = value;
    }
    const created = raw.created_at ?? raw.created;
    return {
      connectionId,
      providerConfigKey,
      provider: typeof raw.provider === "string" ? raw.provider : null,
      createdAt: typeof created === "string" ? created : null,
      tags,
      authErrors: Array.isArray(raw.errors)
        ? raw.errors.filter((error) => (error as { type?: unknown })?.type === "auth").length
        : 0,
      scopes: nangoReportedScopes(raw),
      refreshFailed: false,
    };
  }

  /**
   * The OAuth scopes the provider actually granted to one connection, as Nango
   * reports them, or null when Nango does not report any.
   */
  async connectionGrantedScopes(
    connectionId: string,
    providerConfigKey: string,
  ): Promise<string[] | null> {
    return (await this.getConnection(connectionId, providerConfigKey))?.scopes ?? null;
  }

  /**
   * Every connection of the environment (optionally of one integration), page
   * by page until a page adds nothing new. For operator reconciliation.
   */
  async listAllConnections(
    input: { providerConfigKey?: string } = {},
  ): Promise<NangoConnectionSummary[]> {
    const seen = new Map<string, NangoConnectionSummary>();
    for (let page = 0; page < 1000; page += 1) {
      const batch = await this.listConnections({ page });
      let added = 0;
      for (const connection of batch) {
        const key = `${connection.providerConfigKey}\u0000${connection.connectionId}`;
        if (seen.has(key)) continue;
        seen.set(key, connection);
        added += 1;
      }
      if (batch.length < 100 || added === 0) break;
    }
    const all = [...seen.values()];
    return input.providerConfigKey === undefined
      ? all
      : all.filter((connection) => connection.providerConfigKey === input.providerConfigKey);
  }

  /** Deleting a connection stops Nango's connection billing for it. 404 is success. */
  async deleteConnection(connectionId: string, providerConfigKey: string): Promise<void> {
    const query = new URLSearchParams({ provider_config_key: providerConfigKey });
    const result = await this.json(
      "DELETE",
      `/connections/${encodeURIComponent(connectionId)}?${query.toString()}`,
    );
    if (result.status === 404) return;
    if (result.status < 200 || result.status >= 300)
      throw new NangoApiError(
        `Nango connection deletion failed with ${result.status}`,
        result.status,
        errorCode(result.body),
      );
  }

  /**
   * One read-only provider request through the Nango proxy (for example the
   * account identity call). The provider origin travels as Base-Url-Override.
   */
  async proxyGet(input: {
    url: string;
    nangoConnectionId: string;
    providerConfigKey: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown; bytes: number }> {
    const target = new URL(input.url);
    if (target.protocol !== "https:") throw new Error("Nango proxy destinations must use https");
    return await this.json("GET", `/proxy${target.pathname}${target.search}`, {
      headers: {
        "base-url-override": target.origin,
        "connection-id": input.nangoConnectionId,
        "provider-config-key": input.providerConfigKey,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /** Tools (and deprecated actions) available to an integration, with input schemas. */
  async listTools(providerConfigKey: string): Promise<NangoToolDescriptor[]> {
    const tools: NangoToolDescriptor[] = [];
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ page: String(page), limit: "100" });
      const { body } = await this.ok(
        "GET",
        `/integrations/${encodeURIComponent(providerConfigKey)}/functions?${query.toString()}`,
      );
      const data = (body as { data?: unknown[] } | null)?.data;
      if (!Array.isArray(data)) break;
      for (const entry of data) {
        const raw = entry as Record<string, unknown>;
        if ((raw.type !== "tool" && raw.type !== "action") || raw.enabled === false) continue;
        if (typeof raw.name !== "string") continue;
        const schema =
          (raw.input_json_schema as Record<string, unknown> | null | undefined) ??
          (raw.json_schema as Record<string, unknown> | null | undefined);
        const endpoint = raw.endpoint as { method?: unknown } | undefined;
        const method =
          typeof raw.method === "string"
            ? raw.method
            : typeof endpoint?.method === "string"
              ? endpoint.method
              : undefined;
        tools.push({
          name: raw.name,
          description:
            typeof raw.description === "string" ? raw.description.slice(0, 4000) : raw.name,
          inputSchema:
            schema && typeof schema === "object" && !Array.isArray(schema)
              ? schema
              : { type: "object", properties: {} },
          ...(method ? { method } : {}),
        });
      }
      const pagination = (body as { pagination?: { total?: unknown } } | null)?.pagination;
      const total = typeof pagination?.total === "number" ? pagination.total : 0;
      if ((page + 1) * 100 >= total) break;
    }
    return tools;
  }

  /** Calls a tool synchronously; its output is returned as Nango sends it. */
  async callTool(input: {
    nangoConnectionId: string;
    providerConfigKey: string;
    name: string;
    input: unknown;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown; requestBytes: number; responseBytes: number }> {
    const payload = { input: input.input ?? {} };
    const result = await this.json(
      "POST",
      `/connections/${encodeURIComponent(input.nangoConnectionId)}/tools/${encodeURIComponent(input.name)}/calls`,
      {
        body: payload,
        headers: { "provider-config-key": input.providerConfigKey },
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return {
      status: result.status,
      body: result.body,
      requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      responseBytes: result.bytes,
    };
  }
}

/** Reads granted scopes from a Nango connection body (`credentials.raw.scope`). */
export function nangoReportedScopes(body: unknown): string[] | null {
  const raw = (body as { credentials?: { raw?: Record<string, unknown> } } | null)?.credentials
    ?.raw;
  const value = raw?.scope ?? raw?.scopes;
  const list =
    typeof value === "string"
      ? value.split(/[\s,]+/u)
      : Array.isArray(value)
        ? value.filter((scope): scope is string => typeof scope === "string")
        : [];
  const scopes = [...new Set(list.map((scope) => scope.trim()).filter(Boolean))].filter(
    (scope) => scope.length <= 512,
  );
  return scopes.length > 0 ? scopes.slice(0, 200) : null;
}

// ---------------------------------------------------------------------------
// Orphan reconciliation (operator)
// ---------------------------------------------------------------------------

/**
 * Minimum age before an orphan may be deleted. A connect attempt's signed
 * state lives one hour; two hours keeps every in-progress connect (whose row
 * is stored only when it completes) out of reach.
 */
export const NANGO_ORPHAN_MIN_AGE_MS = 2 * 60 * 60 * 1000;

export type NangoOrphanAction = "delete" | "keep_recent" | "keep_unknown_age" | "keep_untagged";

export type NangoOrphan = NangoConnectionSummary & { action: NangoOrphanAction };

/**
 * Nango connections that no live Opengeni connection stands for, and what a
 * `--delete` run does with each. Only connections Opengeni made (they carry
 * its attempt tag) and older than `minAgeMs` are deleted; untagged ones (made
 * outside Opengeni) only when `includeUntagged` is set, and never one whose
 * age Nango does not report.
 */
export function planNangoOrphans(input: {
  remote: readonly NangoConnectionSummary[];
  liveNangoConnectionIds: ReadonlySet<string>;
  /** Restrict to one integration: its tag, or (untagged) its provider config keys. */
  integration?: { key: string; providerConfigKeys: ReadonlySet<string> } | undefined;
  now: number;
  minAgeMs?: number;
  includeUntagged?: boolean;
}): NangoOrphan[] {
  const minAgeMs = Math.max(input.minAgeMs ?? NANGO_ORPHAN_MIN_AGE_MS, NANGO_ORPHAN_MIN_AGE_MS);
  return input.remote.flatMap((connection) => {
    if (input.liveNangoConnectionIds.has(connection.connectionId)) return [];
    const tagged = Boolean(connection.tags[NANGO_TAG.attemptId]);
    if (input.integration) {
      const taggedKey = connection.tags[NANGO_TAG.integrationKey];
      const matches = taggedKey
        ? taggedKey === input.integration.key
        : input.integration.providerConfigKeys.has(connection.providerConfigKey);
      if (!matches) return [];
    }
    const created = connection.createdAt ? Date.parse(connection.createdAt) : Number.NaN;
    const action: NangoOrphanAction =
      !tagged && !input.includeUntagged
        ? "keep_untagged"
        : !Number.isFinite(created)
          ? "keep_unknown_age"
          : input.now - created < minAgeMs
            ? "keep_recent"
            : "delete";
    return [{ ...connection, action }];
  });
}
