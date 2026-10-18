// The HTTP client for Opengeni compute, the sandbox fabric (compute/ in this
// repository; its contract is compute/docs/agent-link.md section 1). The fabric
// owns placement, sleep and persistence; Opengeni creates a sandbox, wakes one
// no host serves, reads it, finds the sandbox a create request made, deletes
// it, and reads the keys the fleet signs agent-link tokens with. Every request
// carries the team API key. Errors are `{code, message}` bodies.
//
// `create` is idempotent by `request_id`: the same id with the same body
// answers the same sandbox, so an uncertain create is retried with the SAME id
// and body, never a new one.

export type ComputeFabricErrorKind =
  | "not_found"
  | "invalid"
  | "unauthorized"
  | "busy"
  | "request_mismatch"
  | "request_gone"
  | "host"
  | "init_failed"
  | "no_capacity"
  | "unavailable"
  | "unknown_outcome"
  | "internal"
  | "transport";

const RETRYABLE_KINDS: ReadonlySet<ComputeFabricErrorKind> = new Set([
  "busy",
  "host",
  "init_failed",
  "no_capacity",
  "unavailable",
  "unknown_outcome",
  "internal",
  "transport",
]);

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
    this.retryable = RETRYABLE_KINDS.has(input.kind);
  }
}

export function isComputeFabricNotFound(error: unknown): boolean {
  return error instanceof ComputeFabricError && error.kind === "not_found";
}

/** The sandbox is gone for good: never existed, deleted, or its request's
 * sandbox was deleted. */
export function isComputeFabricGone(error: unknown): boolean {
  return (
    error instanceof ComputeFabricError &&
    (error.kind === "not_found" || error.kind === "request_gone")
  );
}

export type ComputeSandboxView = {
  id: string;
  image: string;
  config: Record<string, unknown>;
  metadata: Record<string, string>;
  /** The Opengeni agent the sandbox runs, as its create named it. */
  agent?: { workspace: string; agent: string };
  host: string | null;
  owner_epoch: number;
  created_ms: number;
};

export type ComputeWokenView = {
  waited_us: number;
  generation: number;
  host: string | null;
};

/** The agent a create names: its enrollment's ids. It holds no secret; the
 * agent is reached through its host's link to Opengeni's agent gateway. */
export type ComputeAgentInit = {
  workspace_id: string;
  agent_id: string;
  workspace_root: string;
  /** Start the agent with its own virtual desktop. */
  desktop: boolean;
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

/** One public key the fleet signs agent-link tokens with (a JWK). */
export type ComputeLinkKey = { kty: string; crv: string; kid: string; x: string };

/** `GET /v1/link/keys`: Opengeni's own team and the fleet's link keys. */
export type ComputeLinkKeys = { team: string; keys: ComputeLinkKey[] };

/** What `GET /v1/requests/{request_id}` found for a create request. */
export type ComputeRequestLookup =
  | { state: "live"; sandbox: ComputeSandboxView }
  | { state: "none" }
  | { state: "gone" };

export type ComputeFabricClientOptions = {
  baseUrl: string;
  apiKey: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-attempt request deadline. Create and wake can take a while: the
   * fabric answers a create once the guest kept its init, and a wake once the
   * sandbox runs (a restore from a remote archive takes seconds). */
  requestTimeoutMs?: number;
  /** Bounded attempts for retryable failures (same body, same request_id). */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Ends every request of this client: an aborted signal fails the request
   * in flight at once and stops further attempts. */
  signal?: AbortSignal;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 4;

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "not_found",
  "invalid",
  "busy",
  "request_mismatch",
  "request_gone",
  "host",
  "init_failed",
  "no_capacity",
  "unavailable",
  "unknown_outcome",
  "internal",
]);

/** The body's `code` names the failure; the status is the fallback. */
function kindFor(status: number, code: string | undefined): ComputeFabricErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (code && KNOWN_CODES.has(code)) return code as ComputeFabricErrorKind;
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "invalid";
  if (status === 409) return "busy";
  if (status === 410) return "request_gone";
  if (status === 502) return "host";
  if (status === 503) return "unavailable";
  if (status === 504) return "unknown_outcome";
  return "internal";
}

/** The `code` and a bounded, secret-free message of an error body. */
async function errorBody(response: Response): Promise<{ code?: string; message: string }> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { message: `HTTP ${response.status}` };
  }
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof body.code === "string" ? body.code : undefined;
    if (typeof body.message === "string" && body.message) {
      return { ...(code ? { code } : {}), message: body.message.slice(0, 500) };
    }
    return { ...(code ? { code } : {}), message: `HTTP ${response.status}` };
  } catch {
    return { message: (text || `HTTP ${response.status}`).slice(0, 500) };
  }
}

export class ComputeFabricClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signal: AbortSignal | undefined;

  constructor(options: ComputeFabricClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.signal = options.signal;
  }

  /** Create (or, for a repeated request_id and body, return and wake) one
   * sandbox. Answers once the guest kept its init; its agent may not have
   * connected yet. */
  async create(body: ComputeCreateRequest): Promise<ComputeSandboxView> {
    return await this.request<ComputeSandboxView>("POST", "/v1/sandboxes", body);
  }

  /** Make the sandbox run, placing and adopting it when no host owns it (a
   * no-op when it already runs). */
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

  /** The team's sandboxes whose metadata holds every given pair. */
  async list(metadata: Record<string, string> = {}): Promise<ComputeSandboxView[]> {
    const query = new URLSearchParams(metadata).toString();
    return await this.request<ComputeSandboxView[]>(
      "GET",
      `/v1/sandboxes${query ? `?${query}` : ""}`,
    );
  }

  /** The sandbox a create request made, so a caller that lost a create's
   * answer can find it without creating one. */
  async lookupRequest(requestId: string): Promise<ComputeRequestLookup> {
    try {
      const sandbox = await this.request<ComputeSandboxView>(
        "GET",
        `/v1/requests/${encodeURIComponent(requestId)}`,
      );
      return { state: "live", sandbox };
    } catch (error) {
      if (error instanceof ComputeFabricError && error.kind === "not_found") {
        return { state: "none" };
      }
      if (error instanceof ComputeFabricError && error.kind === "request_gone") {
        return { state: "gone" };
      }
      throw error;
    }
  }

  /** Delete one sandbox. An already-gone sandbox is success. */
  async delete(sandboxId: string): Promise<void> {
    try {
      await this.request<unknown>("DELETE", `/v1/sandboxes/${encodeURIComponent(sandboxId)}`);
    } catch (error) {
      if (isComputeFabricGone(error)) return;
      throw error;
    }
  }

  /** Opengeni's team and the keys the fleet signs host tokens and sandbox
   * tickets with, the current one first. */
  async linkKeys(): Promise<ComputeLinkKeys> {
    return await this.request<ComputeLinkKeys>("GET", "/v1/link/keys");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: ComputeFabricError | undefined;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) await this.backoff(Math.min(8_000, 250 * 2 ** attempt));
      if (this.signal?.aborted) break;
      try {
        return await this.attempt<T>(method, path, body);
      } catch (error) {
        if (!(error instanceof ComputeFabricError) || !error.retryable) throw error;
        lastError = error;
      }
    }
    throw (
      lastError ??
      new ComputeFabricError({
        kind: "transport",
        status: null,
        message: `compute fabric ${method} ${path.split("?")[0]} was abandoned`,
      })
    );
  }

  /** Wait before a retry, ending early once the client's signal aborts. */
  private async backoff(ms: number): Promise<void> {
    const signal = this.signal;
    if (!signal) return await this.sleep(ms);
    if (signal.aborted) return;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(ms), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async attempt<T>(method: string, path: string, body?: unknown): Promise<T> {
    const route = path.split("?")[0];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const abandon = (): void => controller.abort();
    this.signal?.addEventListener("abort", abandon, { once: true });
    if (this.signal?.aborted) controller.abort();
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
      this.signal?.removeEventListener("abort", abandon);
    }
    if (!response.ok) {
      const { code, message } = await errorBody(response);
      throw new ComputeFabricError({
        kind: kindFor(response.status, code),
        status: response.status,
        message: `compute fabric ${method} ${route}: ${message}`,
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
