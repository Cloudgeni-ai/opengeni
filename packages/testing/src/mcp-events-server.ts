import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createMcpHandler,
  McpServer,
  ProtocolError,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * A scriptable MCP server that offers the Events extension (SEP-3415) over
 * Streamable HTTP, for testing clients end to end: poll and webhook delivery,
 * cursors and replay, duplicates, retention gaps, `maxAgeMs`, injected
 * errors, webhook verification, gap and termination envelopes, and a record
 * of every request with its `Mcp-Name` header.
 *
 * The `chatgpt` profile behaves like a server built for ChatGPT, which follows
 * the extension's earlier design sketch: it advertises `capabilities.events`,
 * numbers its errors -32011 to -32015, and sends each event with its
 * `eventId` as the `webhook-id`.
 */

export const MCP_EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";

export type FakeMcpEventsProfile = "sep-3415" | "chatgpt";

/** Error codes by name, in each profile's numbering. */
const ERROR_CODES: Record<
  FakeMcpEventsProfile,
  Record<"NotFound" | "Forbidden" | "Unsupported" | "CallbackEndpointError", number>
> = {
  "sep-3415": {
    NotFound: -32_023,
    Forbidden: -32_024,
    Unsupported: -32_026,
    CallbackEndpointError: -32_027,
  },
  chatgpt: {
    NotFound: -32_011,
    Forbidden: -32_012,
    Unsupported: -32_014,
    CallbackEndpointError: -32_015,
  },
};

export type FakeMcpEventType = {
  name: string;
  description?: string;
  delivery: Array<"poll" | "push" | "webhook">;
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
  /** False: no replay, every cursor is null (an emit-only type). */
  replay?: boolean;
};

export type FakeMcpEventsRequest = {
  method: string;
  params: Record<string, unknown>;
  /** The `Mcp-Name` header as sent, or null. */
  mcpName: string | null;
  authorization: string | null;
};

export type FakeMcpWebhookSubscription = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  refreshBefore: Date;
  /** Events at or below this position were delivered (or are not owed). */
  position: number;
  refreshes: number;
};

export type FakeMcpWebhookPost = {
  url: string;
  webhookId: string;
  subscriptionId: string;
  body: string;
  status: number;
  responseText: string;
};

type StoredEvent = {
  position: number;
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
};

type InjectedError = { code: number; message: string; data?: unknown };

export type FakeMcpEventsServerOptions = {
  eventTypes: FakeMcpEventType[];
  /** Which revision of the extension to speak (default `sep-3415`). */
  profile?: FakeMcpEventsProfile;
  /** Offer events at all (default true); false is an ordinary server without them. */
  advertiseEvents?: boolean;
  /** The `nextPollMs` every poll answers with. */
  nextPollMs?: number;
  /** The longest webhook lifetime the server grants. */
  maxTtlMs?: number;
  /** Sends webhook POSTs; tests route them into the app under test. */
  webhookFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** When set, requests without `Authorization: Bearer <token>` get HTTP 401. */
  bearerToken?: string;
  now?: () => Date;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Standard Webhooks HMAC signature of one message. */
export function signFakeMcpWebhook(
  secret: string,
  webhookId: string,
  timestampSeconds: number,
  body: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/u, ""), "base64");
  const mac = createHmac("sha256", key)
    .update(`${webhookId}.${timestampSeconds}.${body}`)
    .digest("base64");
  return `v1,${mac}`;
}

const AnyParams = z.looseObject({});

export class FakeMcpEventsServer {
  readonly requests: FakeMcpEventsRequest[] = [];
  readonly posts: FakeMcpWebhookPost[] = [];
  readonly subscriptions = new Map<string, FakeMcpWebhookSubscription>();
  private readonly log: StoredEvent[] = [];
  private position = 0;
  /** Events at or below this position are past the upstream's retention. */
  private retainedAfter = 0;
  private readonly injected = new Map<string, InjectedError[]>();
  private readonly verified = new Set<string>();
  private types: FakeMcpEventType[];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly options: FakeMcpEventsServerOptions;

  constructor(options: FakeMcpEventsServerOptions) {
    this.options = options;
    this.types = options.eventTypes;
  }

  get url(): string {
    if (!this.server) throw new Error("fake MCP events server is not started");
    return `http://127.0.0.1:${this.server.port}/mcp`;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get profile(): FakeMcpEventsProfile {
    return this.options.profile ?? "sep-3415";
  }

  /** An error code by name, in this server's numbering. */
  errorCode(name: keyof (typeof ERROR_CODES)["sep-3415"]): number {
    return ERROR_CODES[this.profile][name];
  }

  start(): this {
    const handler = createMcpHandler(() => this.createMcp());
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (
          this.options.bearerToken &&
          request.headers.get("authorization") !== `Bearer ${this.options.bearerToken}`
        ) {
          return new Response("unauthorized", { status: 401 });
        }
        if (request.method === "POST") {
          const body = (await request
            .clone()
            .json()
            .catch(() => null)) as { method?: unknown; params?: unknown } | null;
          if (typeof body?.method === "string") {
            this.requests.push({
              method: body.method,
              params:
                body.params && typeof body.params === "object"
                  ? (body.params as Record<string, unknown>)
                  : {},
              mcpName: request.headers.get("mcp-name"),
              authorization: request.headers.get("authorization"),
            });
          }
        }
        return await handler.fetch(request);
      },
    });
    return this;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /** Requests for one method, in order. */
  requestsFor(method: string): FakeMcpEventsRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  /** Replace the offered event types (for example to remove one). */
  setEventTypes(types: FakeMcpEventType[]): void {
    this.types = types;
  }

  /** The next call to `method` fails with this JSON-RPC error. */
  failNext(method: string, error: InjectedError): void {
    const queue = this.injected.get(method) ?? [];
    queue.push(error);
    this.injected.set(method, queue);
  }

  /** Forget events at or before the current head, as an upstream with short retention would. */
  expireHistory(): void {
    this.retainedAfter = this.position;
  }

  /**
   * Something happened upstream. Webhook subscriptions that match get a
   * signed POST at once; pollers see it on their next poll. Emitting the
   * same `eventId` twice is how a test sends a duplicate.
   */
  async emit(
    name: string,
    data: Record<string, unknown>,
    options: { eventId?: string; timestamp?: Date } = {},
  ): Promise<StoredEvent> {
    this.position += 1;
    const event: StoredEvent = {
      position: this.position,
      eventId: options.eventId ?? `evt_${this.position}_${randomUUID().slice(0, 8)}`,
      name,
      timestamp: (options.timestamp ?? this.now()).toISOString(),
      data,
    };
    this.log.push(event);
    for (const subscription of this.subscriptions.values()) {
      if (subscription.name !== name || !this.matches(subscription.arguments, data)) continue;
      await this.deliver(subscription, this.occurrence(event, subscription.position));
    }
    return event;
  }

  /** POST a webhook body again with the same `webhook-id`, as a server retry does. */
  async redeliver(post: FakeMcpWebhookPost): Promise<FakeMcpWebhookPost> {
    const subscription = this.subscriptions.get(post.subscriptionId);
    if (!subscription) throw new Error("no such subscription");
    return await this.post(subscription, post.body, post.webhookId);
  }

  /** Tell a webhook subscription that events were skipped. */
  async sendGap(subscriptionId: string): Promise<FakeMcpWebhookPost> {
    const subscription = this.requireSubscription(subscriptionId);
    return await this.post(
      subscription,
      JSON.stringify({ type: "gap", cursor: this.cursorFor(subscription.name, this.position) }),
      `msg_gap_${randomUUID().replaceAll("-", "")}`,
    );
  }

  /** End a webhook subscription with an error, as when access is revoked. */
  async terminate(subscriptionId: string, error: InjectedError): Promise<FakeMcpWebhookPost> {
    const subscription = this.requireSubscription(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    return await this.post(
      subscription,
      JSON.stringify({ type: "terminated", error }),
      `msg_terminated_${randomUUID().replaceAll("-", "")}`,
    );
  }

  private requireSubscription(id: string): FakeMcpWebhookSubscription {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new Error(`no subscription ${id}`);
    return subscription;
  }

  private type(name: string): FakeMcpEventType | undefined {
    return this.types.find((type) => type.name === name);
  }

  private replays(name: string): boolean {
    return this.type(name)?.replay !== false;
  }

  private cursorFor(name: string, position: number): string | null {
    return this.replays(name) ? `c${position}` : null;
  }

  private occurrence(event: StoredEvent, watermark: number) {
    return {
      eventId: event.eventId,
      name: event.name,
      timestamp: event.timestamp,
      data: event.data,
      cursor: this.cursorFor(event.name, Math.max(watermark, event.position)),
    };
  }

  /** Arguments filter on equal data fields; arguments the data lacks are ignored. */
  private matches(args: Record<string, unknown>, data: Record<string, unknown>): boolean {
    return Object.entries(args).every(
      ([key, value]) => !(key in data) || stableJson(data[key]) === stableJson(value),
    );
  }

  private takeInjected(method: string): void {
    const queue = this.injected.get(method);
    const error = queue?.shift();
    if (error) throw new ProtocolError(error.code, error.message, error.data);
  }

  private requireType(name: unknown, mode: "poll" | "webhook"): FakeMcpEventType {
    const type = typeof name === "string" ? this.type(name) : undefined;
    if (!type) {
      throw new ProtocolError(this.errorCode("NotFound"), "Event type not found", {
        kind: "event",
      });
    }
    if (!type.delivery.includes(mode)) {
      throw new ProtocolError(this.errorCode("Unsupported"), "Delivery mode not supported", {
        feature: "deliveryMode",
        value: mode,
      });
    }
    return type;
  }

  /** Where delivery starts for a cursor; `truncated` when history before it is gone. */
  private startFrom(
    name: string,
    cursor: unknown,
    maxAgeMs: unknown,
  ): { after: number; truncated: boolean } {
    if (typeof cursor !== "string" || !this.replays(name)) {
      return { after: this.position, truncated: false };
    }
    const match = /^c(\d+)$/u.exec(cursor);
    if (!match) throw new ProtocolError(-32_602, "Invalid cursor");
    let after = Number(match[1]);
    let truncated = false;
    if (after < this.retainedAfter) {
      after = this.retainedAfter;
      truncated = true;
    }
    if (typeof maxAgeMs === "number") {
      const floor = this.now().getTime() - maxAgeMs;
      const tooOld = this.log.filter(
        (event) => event.position > after && Date.parse(event.timestamp) < floor,
      );
      if (tooOld.length > 0) {
        after = Math.max(...tooOld.map((event) => event.position));
        truncated = true;
      }
    }
    return { after, truncated };
  }

  private createMcp(): McpServer {
    // ChatGPT's sketch puts `events` beside `tools`, a key the SDK's
    // capability type does not know (it still sends it).
    const chatgptCapabilities = { events: {} } as ServerCapabilities;
    const mcp = new McpServer(
      { name: "fake-mcp-events", version: "1.0.0" },
      {
        capabilities:
          this.options.advertiseEvents === false
            ? {}
            : this.profile === "chatgpt"
              ? chatgptCapabilities
              : { extensions: { [MCP_EVENTS_EXTENSION_ID]: {} } },
      },
    );
    // A tool, so the server is an ordinary one as well.
    mcp.registerTool("ping", { description: "Ping." }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const server = mcp.server;
    if (this.options.advertiseEvents === false) return mcp;
    server.setRequestHandler("events/list", { params: AnyParams }, async () => {
      this.takeInjected("events/list");
      return {
        resultType: "complete",
        events: this.types.map((type) => ({
          name: type.name,
          ...(type.description ? { description: type.description } : {}),
          delivery: type.delivery,
          inputSchema: type.inputSchema ?? { type: "object" },
          payloadSchema: type.payloadSchema ?? { type: "object" },
        })),
      };
    });
    server.setRequestHandler("events/poll", { params: AnyParams }, async (params) => {
      this.takeInjected("events/poll");
      const type = this.requireType(params.name, "poll");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const maxEvents = typeof params.maxEvents === "number" ? params.maxEvents : 100;
      const { after, truncated } = this.startFrom(type.name, params.cursor, params.maxAgeMs);
      if (params.cursor === null || params.cursor === undefined || !this.replays(type.name)) {
        return {
          resultType: "complete",
          events: [],
          cursor: this.cursorFor(type.name, this.position),
          truncated: false,
          hasMore: false,
          nextPollMs: this.options.nextPollMs ?? 30_000,
        };
      }
      const pending = this.log.filter(
        (event) =>
          event.position > after && event.name === type.name && this.matches(args, event.data),
      );
      const page = pending.slice(0, maxEvents);
      const last = page.length < pending.length ? page[page.length - 1]!.position : this.position;
      return {
        resultType: "complete",
        events: page.map((event) => {
          const { cursor: _cursor, ...occurrence } = this.occurrence(event, event.position);
          return occurrence;
        }),
        cursor: this.cursorFor(type.name, last),
        truncated,
        hasMore: page.length < pending.length,
        nextPollMs: this.options.nextPollMs ?? 30_000,
      };
    });
    server.setRequestHandler("events/subscribe", { params: AnyParams }, async (params) => {
      this.takeInjected("events/subscribe");
      const type = this.requireType(params.name, "webhook");
      const delivery = (params.delivery ?? {}) as { url?: unknown; secret?: unknown };
      if (typeof delivery.url !== "string" || !delivery.url.startsWith("https://")) {
        throw new ProtocolError(-32_602, "delivery.url must be https");
      }
      if (
        typeof delivery.secret !== "string" ||
        !/^whsec_[A-Za-z0-9+/=]+$/u.test(delivery.secret)
      ) {
        throw new ProtocolError(-32_602, "delivery.secret must be a whsec_ secret");
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const id = `sub_${createHash("sha256")
        .update(stableJson(["principal", delivery.url, type.name, args]))
        .digest("hex")
        .slice(0, 16)}`;
      const existing = this.subscriptions.get(id);
      const ttlMs = typeof params.ttlMs === "number" ? params.ttlMs : 3_600_000;
      const granted = Math.min(ttlMs, this.options.maxTtlMs ?? ttlMs);
      const { after, truncated } = existing
        ? { after: existing.position, truncated: false }
        : this.startFrom(type.name, params.cursor, params.maxAgeMs);
      const subscription: FakeMcpWebhookSubscription = {
        id,
        name: type.name,
        arguments: args,
        url: delivery.url,
        secret: delivery.secret,
        refreshBefore: new Date(this.now().getTime() + granted),
        position: after,
        refreshes: (existing?.refreshes ?? -1) + 1,
      };
      const verifyKey = stableJson(["principal", delivery.url]);
      if (!this.verified.has(verifyKey)) {
        const challenge = randomBytes(16).toString("hex");
        const post = await this.post(
          subscription,
          JSON.stringify({ type: "verification", challenge }),
          `msg_verification_${randomUUID().replaceAll("-", "")}`,
        );
        let echoed: unknown = null;
        try {
          echoed = (JSON.parse(post.responseText) as { challenge?: unknown }).challenge;
        } catch {
          echoed = null;
        }
        if (post.status < 200 || post.status >= 300) {
          throw new ProtocolError(
            this.errorCode("CallbackEndpointError"),
            "Callback endpoint error",
            {
              reason: post.status >= 500 ? "http_5xx" : "http_4xx",
            },
          );
        }
        if (echoed !== challenge) {
          throw new ProtocolError(
            this.errorCode("CallbackEndpointError"),
            "Callback endpoint error",
            {
              reason: "challenge_failed",
            },
          );
        }
        this.verified.add(verifyKey);
      }
      this.subscriptions.set(id, subscription);
      // Replay what the cursor missed, then deliver new events as they come.
      const missed = this.log.filter(
        (event) =>
          event.position > after && event.name === type.name && this.matches(args, event.data),
      );
      for (const event of missed) {
        await this.deliver(subscription, this.occurrence(event, subscription.position));
      }
      return {
        resultType: "complete",
        id,
        refreshBefore: subscription.refreshBefore.toISOString(),
        cursor: this.cursorFor(type.name, Math.max(subscription.position, this.position)),
        truncated,
      };
    });
    server.setRequestHandler("events/unsubscribe", { params: AnyParams }, async (params) => {
      this.takeInjected("events/unsubscribe");
      const delivery = (params.delivery ?? {}) as { url?: unknown };
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const id = `sub_${createHash("sha256")
        .update(stableJson(["principal", delivery.url, params.name, args]))
        .digest("hex")
        .slice(0, 16)}`;
      if (!this.subscriptions.delete(id)) {
        throw new ProtocolError(this.errorCode("NotFound"), "Subscription not found", {
          kind: "subscription",
        });
      }
      return { resultType: "complete" };
    });
    return mcp;
  }

  private async deliver(
    subscription: FakeMcpWebhookSubscription,
    occurrence: Record<string, unknown>,
  ): Promise<void> {
    const post = await this.post(
      subscription,
      JSON.stringify(occurrence),
      this.profile === "chatgpt"
        ? String(occurrence.eventId)
        : `msg_${randomUUID().replaceAll("-", "")}`,
    );
    if (post.status >= 200 && post.status < 300) {
      const position = /^c(\d+)$/u.exec(String(occurrence.cursor ?? ""))?.[1];
      if (position) subscription.position = Math.max(subscription.position, Number(position));
    }
  }

  private async post(
    subscription: FakeMcpWebhookSubscription,
    body: string,
    webhookId: string,
  ): Promise<FakeMcpWebhookPost> {
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const send = this.options.webhookFetch ?? fetch;
    const response = await send(subscription.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signFakeMcpWebhook(subscription.secret, webhookId, timestamp, body),
        "x-mcp-subscription-id": subscription.id,
      },
      body,
    });
    const post: FakeMcpWebhookPost = {
      url: subscription.url,
      webhookId,
      subscriptionId: subscription.id,
      body,
      status: response.status,
      responseText: await response.text(),
    };
    this.posts.push(post);
    return post;
  }
}

export function startFakeMcpEventsServer(options: FakeMcpEventsServerOptions): FakeMcpEventsServer {
  return new FakeMcpEventsServer(options).start();
}
