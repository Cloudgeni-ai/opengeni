import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  NANGO_DEFAULT_API_BASE_URL,
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
  if (typeof raw.connectionId !== "string" || typeof raw.providerConfigKey !== "string") return null;
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

async function readBoundedText(response: Response, maxBytes = MAX_NANGO_RESPONSE_BYTES): Promise<string> {
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
      integrationId?: string;
    } = {},
  ): Promise<NangoConnectionSummary[]> {
    const query = new URLSearchParams();
    if (input.connectionId) query.set("connectionId", input.connectionId);
    if (input.integrationId) query.set("integrationId", input.integrationId);
    for (const [key, value] of Object.entries(input.tags ?? {})) query.set(`tags[${key}]`, value);
    query.set("limit", "100");
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
