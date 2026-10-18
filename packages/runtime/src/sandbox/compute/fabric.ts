// The HTTP client for Opengeni compute, the sandbox fabric (compute/ in this
// repository). The fabric owns placement, sleep and persistence; Opengeni only
// creates a box, asks it to wake, reads it, lists it by metadata, and deletes
// it. Every request carries the team API key. Errors are `{code, message}`
// bodies; the status is the contract:
//
//   404 not found  503 no capacity / unavailable  409 busy
//   504 unknown outcome (retry the same request_id)  502 host failure
//
// `create` is idempotent by `request_id`: the same team and id returns the same
// sandbox, so an uncertain create is retried with the SAME id, never a new one.

export type ComputeFabricErrorKind =
  | "not_found"
  | "invalid"
  | "busy"
  | "unavailable"
  | "unknown_outcome"
  | "host"
  | "unauthorized"
  | "internal"
  | "transport";

export class ComputeFabricError extends Error {
  readonly name = "ComputeFabricError";
  readonly kind: ComputeFabricErrorKind;
  readonly status: number | null;
  /** Safe to repeat the same request (the same request_id for a create). */
  readonly retryable: boolean;

  constructor(input: {
    kind: ComputeFabricErrorKind;
    status: number | null;
    message: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.kind = input.kind;
    this.status = input.status;
    this.retryable =
      input.kind === "busy" ||
      input.kind === "unavailable" ||
      input.kind === "unknown_outcome" ||
      input.kind === "host" ||
      input.kind === "transport";
  }
}

export function isComputeFabricNotFound(error: unknown): boolean {
  return error instanceof ComputeFabricError && error.kind === "not_found";
}

export type ComputeSandboxView = {
  id: string;
  image: string;
  config: Record<string, unknown>;
  metadata: Record<string, string>;
  host: string | null;
  owner_epoch: number;
  created_ms: number;
};

export type ComputeWokenView = {
  waited_us: number;
  generation: number;
  host: string | null;
};

export type ComputeAgentInit = {
  /** The Opengeni API origin the agent exchanges its token with. */
  api_url: string;
  /** Single-use sandbox enrollment token; a secret. */
  enroll_token: string;
  workspace_root: string;
};

export type ComputeCreateRequest = {
  request_id: string;
  image?: string;
  vcpus: number;
  memory_mib: number;
  memory_request_mib?: number;
  cpu_request_millis?: number;
  metadata: Record<string, string>;
  init: {
    env_vars: Record<string, string>;
    default_user?: string;
    default_workdir?: string;
    agent: ComputeAgentInit;
  };
};

export type ComputeFabricClientOptions = {
  baseUrl: string;
  apiKey: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-attempt request deadline. Create and wake can take a while: the
   * fabric answers create once the guest took its init, and wake once the box
   * runs (a restore from a remote archive is seconds). */
  requestTimeoutMs?: number;
  /** Bounded attempts for retryable failures (same body, same request_id). */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 4;

function kindForStatus(status: number): ComputeFabricErrorKind {
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "invalid";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 409) return "busy";
  if (status === 503) return "unavailable";
  if (status === 504) return "unknown_outcome";
  if (status === 502) return "host";
  return "internal";
}

/** A bounded, secret-free excerpt of an error body. */
async function errorMessage(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === "string" && body.message) return body.message.slice(0, 500);
  } catch {
    // Not a JSON error body.
  }
  return (text || `HTTP ${response.status}`).slice(0, 500);
}

export class ComputeFabricClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ComputeFabricClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Create (or, for a repeated request_id, return) one sandbox. Answers once
   * the guest took its init; its agent may not have enrolled yet. */
  async create(body: ComputeCreateRequest): Promise<ComputeSandboxView> {
    return await this.request<ComputeSandboxView>("POST", "/v1/sandboxes", body);
  }

  /** Make the sandbox run (a no-op when it already runs). */
  async wake(sandboxId: string): Promise<ComputeWokenView> {
    return await this.request<ComputeWokenView>(
      "POST",
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/wake`,
      {},
    );
  }

  async get(sandboxId: string): Promise<ComputeSandboxView> {
    return await this.request<ComputeSandboxView>(
      "GET",
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
    );
  }

  /** The team's sandboxes whose metadata contains every given pair. */
  async list(metadata: Record<string, string>): Promise<ComputeSandboxView[]> {
    const query = new URLSearchParams(metadata).toString();
    return await this.request<ComputeSandboxView[]>(
      "GET",
      `/v1/sandboxes${query ? `?${query}` : ""}`,
    );
  }

  /** Delete one sandbox. An already-gone sandbox is success. */
  async delete(sandboxId: string): Promise<void> {
    try {
      await this.request<unknown>("DELETE", `/v1/sandboxes/${encodeURIComponent(sandboxId)}`);
    } catch (error) {
      if (isComputeFabricNotFound(error)) return;
      throw error;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: ComputeFabricError | undefined;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) await this.sleep(Math.min(8_000, 250 * 2 ** attempt));
      try {
        return await this.attempt<T>(method, path, body);
      } catch (error) {
        if (!(error instanceof ComputeFabricError) || !error.retryable) throw error;
        lastError = error;
      }
    }
    throw lastError!;
  }

  private async attempt<T>(method: string, path: string, body?: unknown): Promise<T> {
    const route = path.split("?")[0];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // No answer: the request may or may not have taken effect. Callers only
      // repeat idempotent requests (a create carries its request_id).
      throw new ComputeFabricError({
        kind: "transport",
        status: null,
        message: `compute fabric ${method} ${route} did not answer`,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new ComputeFabricError({
        kind: kindForStatus(response.status),
        status: response.status,
        message: `compute fabric ${method} ${route}: ${await errorMessage(response)}`,
      });
    }
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ComputeFabricError({
        kind: "internal",
        status: response.status,
        message: `compute fabric ${method} ${route} returned a non-JSON body`,
        cause: error,
      });
    }
  }
}
