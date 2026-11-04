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

/**
 * How the harness authenticates. An API key bills chats as API use (paid
 * from credits only). A signed-in person bills them as app use (plan credit
 * first), the same as chatting in the web app.
 */
export type EvalAuth = { apiKey: string } | { email: string; password: string };

export function authFromEnv(env: Record<string, string | undefined> = process.env): EvalAuth {
  if (env.OPENGENI_EVAL_LOGIN_EMAIL && env.OPENGENI_EVAL_LOGIN_PASSWORD) {
    return { email: env.OPENGENI_EVAL_LOGIN_EMAIL, password: env.OPENGENI_EVAL_LOGIN_PASSWORD };
  }
  if (env.OPENGENI_EVAL_API_KEY) return { apiKey: env.OPENGENI_EVAL_API_KEY };
  throw new Error(
    "set OPENGENI_EVAL_API_KEY, or OPENGENI_EVAL_LOGIN_EMAIL and OPENGENI_EVAL_LOGIN_PASSWORD",
  );
}

export class OpengeniApi {
  private contract = "";
  private cookies = new Map<string, string>();
  clientConfig: Record<string, unknown> = {};
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly auth: EvalAuth,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async init(): Promise<this> {
    const { body } = await this.call("GET", "/v1/config/client");
    this.clientConfig = (body ?? {}) as Record<string, unknown>;
    this.contract = String(this.clientConfig.apiContractRevision ?? "");
    if ("email" in this.auth) await this.signIn();
    return this;
  }

  /** Email and password sign-in; keeps the session cookies for later calls. */
  private async signIn(): Promise<void> {
    if (!("email" in this.auth)) return;
    const response = await fetch(`${this.baseUrl}/v1/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.baseUrl },
      body: JSON.stringify({ email: this.auth.email, password: this.auth.password }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new HttpFailure(
        "POST",
        "/v1/auth/sign-in/email",
        response.status,
        await response.text(),
      );
    }
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator > 0)
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
    if (this.cookies.size === 0) throw new Error("sign-in returned no session cookie");
  }

  private authHeaders(): Record<string, string> {
    if ("apiKey" in this.auth) return { authorization: `Bearer ${this.auth.apiKey}` };
    if (this.cookies.size === 0) return {};
    return {
      cookie: [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
      origin: this.baseUrl,
    };
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    attempts = 5,
  ): Promise<{ body: unknown; headers: Headers }> {
    let lastError: unknown = null;
    let signedInAgain = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const headers: Record<string, string> = { accept: "application/json", ...this.authHeaders() };
      if (this.contract) headers["x-opengeni-api-contract"] = this.contract;
      if (body !== undefined) headers["content-type"] = "application/json";
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
        // A long grid can outlive a web session: sign in again once.
        if (response.status === 401 && "email" in this.auth && !signedInAgain) {
          signedInAgain = true;
          await this.signIn();
          continue;
        }
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

  /**
   * Forensic events after `after`, following the has-more headers. `complete`
   * is false when paging stopped before the end; grading such a history could
   * miss outputs. `exact` is false when the server trimmed some payloads.
   */
  async events(
    workspaceId: string,
    sessionId: string,
    after = 0,
  ): Promise<{ events: SessionEvent[]; cursor: number; complete: boolean; exact: boolean }> {
    const out: SessionEvent[] = [];
    let cursor = after;
    let complete = false;
    let exact = true;
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
      if (headers.get("x-opengeni-forensic-exact") === "false") exact = false;
      if (headers.get("x-opengeni-has-more") !== "true") {
        complete = true;
        break;
      }
    }
    return { events: out, cursor, complete, exact };
  }

  /** Stop a chat and its queued work (used at the run deadline). */
  cancelSession(workspaceId: string, sessionId: string, reason: string) {
    return this.post(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/control`, {
      action: "cancel",
      clientEventId: `eval-cancel-${sessionId}`,
      reason,
    });
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
