/**
 * Minimal public-API client for the integration eval. Every request carries a
 * bearer API key and the API contract revision from `GET /v1/config/client`.
 * Transient failures (network errors, 429, 5xx) are retried with backoff so a
 * long grid survives a deploy or a brief outage.
 */

export class HttpFailure extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 500)}`);
  }
}

export type SessionEvent = {
  sequence: number;
  type: string;
  payload?: unknown;
  turnId?: string | null;
  createdAt?: string;
};

export type SessionSnapshot = {
  id: string;
  status: string;
  activeTurnId?: string | null;
  lastSequence?: number;
  [key: string]: unknown;
};

export type HumanInputRequest = { id: string; status: string; allowSkip?: boolean };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpengeniApi {
  private contract = "";
  clientConfig: Record<string, unknown> = {};

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async init(): Promise<this> {
    const { body } = await this.call("GET", "/v1/config/client");
    this.clientConfig = (body ?? {}) as Record<string, unknown>;
    this.contract = String(this.clientConfig.apiContractRevision ?? "");
    return this;
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    attempts = 5,
  ): Promise<{ body: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
    if (this.contract) headers["x-opengeni-api-contract"] = this.contract;
    if (body !== undefined) headers["content-type"] = "application/json";
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(this.baseUrl + path, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(90_000),
        });
        const raw = await response.text();
        if (response.ok) {
          return { body: raw ? JSON.parse(raw) : null, headers: response.headers };
        }
        const failure = new HttpFailure(method, path, response.status, raw);
        // POSTs here are idempotent (create keys, approval ids), so they retry too.
        if (response.status === 429 || response.status >= 500) {
          lastError = failure;
          await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
          continue;
        }
        throw failure;
      } catch (error) {
        if (error instanceof HttpFailure) throw error;
        lastError = error;
        await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async get<T = unknown>(path: string): Promise<T> {
    return (await this.call("GET", path)).body as T;
  }

  async post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    return (await this.call("POST", path, body)).body as T;
  }

  createSession(
    workspaceId: string,
    input: {
      initialMessage: string;
      model: string;
      reasoningEffort: string;
      title: string;
      idempotencyKey: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SessionSnapshot> {
    return this.post<SessionSnapshot>(`/v1/workspaces/${workspaceId}/sessions`, {
      initialMessage: input.initialMessage,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      idempotencyKey: input.idempotencyKey,
      profile: { title: input.title },
      metadata: input.metadata ?? {},
    });
  }

  session(workspaceId: string, sessionId: string): Promise<SessionSnapshot> {
    return this.get<SessionSnapshot>(`/v1/workspaces/${workspaceId}/sessions/${sessionId}`);
  }

  /** Forensic events after `after`, following the has-more headers. */
  async events(
    workspaceId: string,
    sessionId: string,
    after = 0,
  ): Promise<{ events: SessionEvent[]; cursor: number }> {
    const out: SessionEvent[] = [];
    let cursor = after;
    for (let page = 0; page < 100; page += 1) {
      const { body, headers } = await this.call(
        "GET",
        `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?after=${cursor}&limit=1000&mode=forensic&payloadMode=full`,
      );
      const batch = (
        Array.isArray(body) ? body : ((body as { events?: SessionEvent[] })?.events ?? [])
      ) as SessionEvent[];
      out.push(...batch);
      const next = Number(headers.get("x-opengeni-next-after") ?? cursor);
      cursor = Math.max(cursor, next, ...batch.map((event) => event.sequence));
      if (headers.get("x-opengeni-has-more") !== "true") break;
    }
    return { events: out, cursor };
  }

  decideApproval(
    workspaceId: string,
    sessionId: string,
    approvalId: string,
    decision: "approve" | "reject",
  ) {
    return this.post(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`, {
      type: "user.approvalDecision",
      clientEventId: `approval-${approvalId}`.slice(0, 120),
      payload: { approvalId, decision },
    });
  }

  async pendingHumanInput(workspaceId: string, sessionId: string): Promise<HumanInputRequest[]> {
    const body = await this.get<unknown>(
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/human-input-requests`,
    );
    const list = (
      Array.isArray(body)
        ? body
        : ((body as { requests?: unknown[]; items?: unknown[] })?.requests ??
          (body as { items?: unknown[] })?.items ??
          [])
    ) as HumanInputRequest[];
    return list.filter((request) => request.status === "pending");
  }

  /** Let the agent decide, the same as a person pressing "you decide". */
  skipHumanInput(workspaceId: string, sessionId: string, requestId: string) {
    return this.post(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`, {
      type: "user.humanInputResponse",
      clientEventId: `hir-${requestId}`,
      payload: { requestId, response: { outcome: "skipped", agentDecides: true } },
    });
  }
}
