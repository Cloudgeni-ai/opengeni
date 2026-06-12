import { OpenGeniApiError } from "./errors";
import { streamSessionEvents, type SessionEventStreamTransport, type StreamSessionEventsOptions } from "./stream";
import type {
  ClientSessionEventInput,
  CreateSessionRequest,
  ReasoningEffort,
  ResourceRef,
  ScheduledTask,
  Session,
  SessionEvent,
  SessionTurn,
  ToolRef,
} from "./types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OpenGeniClientOptions = {
  /** Base URL of the OpenGeni API, e.g. `https://api.example.com`. */
  baseUrl: string;
  /** OpenGeni API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Extra headers (static or computed per request) merged into every call. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
};

export type SendMessageInput = {
  text: string;
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  clientEventId?: string;
};

/**
 * Typed client for the OpenGeni public API. Framework-agnostic: only needs
 * WHATWG `fetch` + streams, so it runs in Node 18+, Bun, Deno, browsers, and
 * edge runtimes.
 */
export class OpenGeniClient {
  private readonly baseUrl: string;
  private readonly options: OpenGeniClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenGeniClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.options = options;
    // Bind lazily so environments that polyfill fetch after module load work.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  // --- Session lifecycle ---------------------------------------------------

  async createSession(workspaceId: string, request: CreateSessionRequest): Promise<Session> {
    return await this.requestJson<Session>("POST", `/v1/workspaces/${workspaceId}/sessions`, request);
  }

  async getSession(workspaceId: string, sessionId: string): Promise<Session> {
    return await this.requestJson<Session>("GET", `/v1/workspaces/${workspaceId}/sessions/${sessionId}`);
  }

  async listSessions(workspaceId: string, options: { limit?: number } = {}): Promise<Session[]> {
    return await this.requestJson<Session[]>("GET", `/v1/workspaces/${workspaceId}/sessions`, undefined, {
      ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
    });
  }

  async listTurns(workspaceId: string, sessionId: string, options: { limit?: number } = {}): Promise<SessionTurn[]> {
    return await this.requestJson<SessionTurn[]>("GET", `/v1/workspaces/${workspaceId}/sessions/${sessionId}/turns`, undefined, {
      ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
    });
  }

  // --- Scheduled tasks -------------------------------------------------------

  async listScheduledTasks(workspaceId: string, options: { limit?: number } = {}): Promise<ScheduledTask[]> {
    return await this.requestJson<ScheduledTask[]>("GET", `/v1/workspaces/${workspaceId}/scheduled-tasks`, undefined, {
      ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
    });
  }

  async getScheduledTask(workspaceId: string, taskId: string): Promise<ScheduledTask> {
    return await this.requestJson<ScheduledTask>("GET", `/v1/workspaces/${workspaceId}/scheduled-tasks/${taskId}`);
  }

  // --- Events: replay, send, stream ----------------------------------------

  /** Replay durable events by sequence: events with `sequence > after`, ascending. */
  async listEvents(
    workspaceId: string,
    sessionId: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<SessionEvent[]> {
    return await this.requestJson<SessionEvent[]>("GET", `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`, undefined, {
      ...(options.after !== undefined ? { after: String(options.after) } : {}),
      ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
    });
  }

  /** POST a user/control event to the session. Returns the accepted event. */
  async sendEvent(workspaceId: string, sessionId: string, event: ClientSessionEventInput): Promise<SessionEvent> {
    return await this.requestJson<SessionEvent>("POST", `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`, event);
  }

  async sendMessage(workspaceId: string, sessionId: string, message: string | SendMessageInput): Promise<SessionEvent> {
    const input = typeof message === "string" ? { text: message } : message;
    const { clientEventId, ...payload } = input;
    return await this.sendEvent(workspaceId, sessionId, {
      type: "user.message",
      ...(clientEventId !== undefined ? { clientEventId } : {}),
      payload,
    });
  }

  async interrupt(
    workspaceId: string,
    sessionId: string,
    options: { reason?: string; clientEventId?: string } = {},
  ): Promise<SessionEvent> {
    return await this.sendEvent(workspaceId, sessionId, {
      type: "user.interrupt",
      ...(options.clientEventId !== undefined ? { clientEventId: options.clientEventId } : {}),
      payload: options.reason !== undefined ? { reason: options.reason } : {},
    });
  }

  async sendApprovalDecision(
    workspaceId: string,
    sessionId: string,
    decision: { approvalId: string; decision: "approve" | "reject"; message?: string; clientEventId?: string },
  ): Promise<SessionEvent> {
    const { clientEventId, ...payload } = decision;
    return await this.sendEvent(workspaceId, sessionId, {
      type: "user.approvalDecision",
      ...(clientEventId !== undefined ? { clientEventId } : {}),
      payload,
    });
  }

  /**
   * Live-stream a session's events with automatic reconnect, resume from the
   * last seen sequence, gap backfill, and duplicate suppression. See
   * {@link streamSessionEvents} for the delivery guarantees.
   */
  streamEvents(
    workspaceId: string,
    sessionId: string,
    options: StreamSessionEventsOptions = {},
  ): AsyncGenerator<SessionEvent, void, void> {
    return streamSessionEvents(this.eventStreamTransport(workspaceId, sessionId), options);
  }

  /** The transport `streamEvents` runs on; useful for custom streaming layers. */
  eventStreamTransport(workspaceId: string, sessionId: string): SessionEventStreamTransport {
    return {
      openStream: async (after, signal) => await this.openEventStream(workspaceId, sessionId, { after, ...(signal ? { signal } : {}) }),
      listEvents: async (after, limit) => await this.listEvents(workspaceId, sessionId, { after, limit }),
    };
  }

  /** Open one raw SSE connection (no reconnect). Most callers want `streamEvents`. */
  async openEventStream(
    workspaceId: string,
    sessionId: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.url(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/events/stream`, {
      after: String(options.after ?? 0),
    });
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.headers(), Accept: "text/event-stream" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      throw new OpenGeniApiError(response.status, await safeText(response));
    }
    if (!response.body) {
      throw new OpenGeniApiError(response.status, "SSE response did not include a readable body");
    }
    return response.body;
  }

  // --- Internals -------------------------------------------------------------

  private headers(): Record<string, string> {
    const extra = typeof this.options.headers === "function" ? this.options.headers() : this.options.headers;
    return {
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...extra,
    };
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams(query).toString();
    return `${this.baseUrl}${path}${params ? `?${params}` : ""}`;
  }

  private async requestJson<T>(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
    const response = await this.fetchImpl(this.url(path, query), {
      method,
      headers: {
        ...this.headers(),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new OpenGeniApiError(response.status, await safeText(response));
    }
    return (await response.json()) as T;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
