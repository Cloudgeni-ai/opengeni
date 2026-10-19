/**
 * THE COMPUTE AGENT GATEWAY (ADR 21 in compute/docs, the server side of
 * compute/docs/agent-link.md). The Connected Machine agent inside a compute
 * sandbox holds no credential and never dials Opengeni: it speaks NATS to its
 * host, and each host keeps ONE WebSocket link to this gateway carrying one
 * session per sandbox. The gateway checks the fleet-signed host token on the
 * upgrade and each session's ticket, fences sessions by the fabric's owner
 * epoch, claims the agent's connection instance as the NATS auth callout does
 * for a Connected Machine, and bridges the session's subscriptions and
 * publishes through Opengeni's own NATS connection with exactly the subject
 * permissions the callout would grant. While a session is open, asleep or
 * not, it renews the claim's lease, so a sleeping sandbox stays routable and a
 * message to it wakes it at its host.
 */

import type { AgentLinkNats } from "@opengeni/events";
import { AGENT_LINK_LOST_HEADER } from "@opengeni/runtime/sandbox";
import type { ApiWebSocketConnection, ApiWebSocketLike } from "../api-websocket";
import {
  AGENT_LINK_PROTOCOL,
  AGENT_LINK_VERSION,
  AgentLinkProtocolError,
  decodeHostFrame,
  encodeFrame,
  mayPublish,
  mayReplyTo,
  maySubscribe,
  type AgentLinkSid,
  type ClosedCode,
  type GatewayFrame,
  type HostFrame,
  type RefusedCode,
} from "./compute-link-frames";
import {
  ComputeLinkKeysUnavailableError,
  ComputeLinkTokenError,
  type ComputeHostClaims,
  type ComputeTicketClaims,
} from "./compute-link-tokens";

/** The claim store the gateway opens, renews and releases sessions with
 * (`@opengeni/db` openSandboxAgentLink and friends in production). */
export type ComputeAgentLinkStore = {
  /** How long an open or a renewal keeps the claim, from the moment the call
   * starts at the latest. */
  readonly leaseMs: number;
  open(input: ComputeAgentLinkClaim): Promise<
    | { opened: true; superseded: boolean }
    | {
        opened: false;
        code: "unknown_agent" | "revoked" | "stale_epoch" | "duplicate";
      }
  >;
  renew(
    input: ComputeAgentLinkClaim,
  ): Promise<{ renewed: true } | { renewed: false; code: ClosedCode }>;
  release(input: ComputeAgentLinkClaim): Promise<void>;
  /** Record that the session's sandbox fell asleep or woke, for metering its
   * awake time. Never decides delivery. `accepted: false` means the claim is
   * no longer the agent's current one, so it never speaks for the sandbox
   * again. */
  power(
    input: ComputeAgentLinkClaim & { sandboxId: string; asleep: boolean },
  ): Promise<{ accepted: boolean }>;
};

export type ComputeAgentLinkClaim = {
  workspaceId: string;
  agentId: string;
  epoch: number;
  connectionInstanceId: string;
};

export type ComputeAgentLinkVerifier = {
  verifyHostToken(token: string): Promise<ComputeHostClaims>;
  verifyTicket(
    token: string,
    expected: { host: string; sandbox: string },
  ): Promise<ComputeTicketClaims>;
};

/** Mints the relay producer credential an agent streams terminals, desktop
 * frames and ports with; the gateway hands it over in `opened` and `relay`. */
export type ComputeAgentRelayMinter = {
  url: string;
  mint(input: { workspaceId: string; agentId: string; expiresAtMs: number }): Promise<string>;
};

type GatewayLogger = {
  debug?(message: string, attributes?: Record<string, string | number | boolean>): void;
  info(message: string, attributes?: Record<string, string | number | boolean>): void;
  warn(message: string, attributes?: Record<string, string | number | boolean>): void;
};

export type ComputeAgentGatewayOptions = {
  /** OPENGENI_COMPUTE_LINK_URL: the gateway's own URL, every token's `aud`;
   * the gateway serves its path. */
  linkUrl: string;
  verifier: ComputeAgentLinkVerifier;
  nats: AgentLinkNats;
  store: ComputeAgentLinkStore;
  relay: ComputeAgentRelayMinter;
  /** The largest WebSocket message the server accepts. */
  maxWebSocketMessageBytes: number;
  logger?: GatewayLogger;
  now?: () => number;
  /** Timings, overridable for tests. */
  renewIntervalMs?: number;
  pingIntervalMs?: number;
  silenceLimitMs?: number;
  relayTtlMs?: number;
  relayRefreshBeforeMs?: number;
};

const RENEW_INTERVAL_MS = 5_000;
const PING_INTERVAL_MS = 20_000;
const SILENCE_LIMIT_MS = 60_000;
const RELAY_TTL_MS = 60 * 60_000;
const RELAY_REFRESH_BEFORE_MS = 10 * 60_000;
/** The claim's lease runs on the database clock; a session's authority ends
 * this much before the lease would by the gateway's own clock. */
const LEASE_CLOCK_ALLOWANCE_MS = 2_000;
/** Renewals run this many at a time, so a large fleet spreads its database
 * load instead of opening every transaction at once. */
const RENEW_CONCURRENCY = 16;
/** Room for a frame's JSON header inside one WebSocket message. */
const FRAME_HEADER_ALLOWANCE = 64 * 1024;
const MAX_SUBSCRIPTIONS_PER_SESSION = 1024;
/** Unanswered requests one session remembers. A request past it is not
 * forwarded: its requester is told the link was lost and delivers it again. */
const MAX_UNANSWERED_REQUESTS_PER_SESSION = 4096;
/** Frames waiting behind an open or a close on one link; a host that floods
 * past this is cut off (it dials again and reopens its sessions). */
const MAX_PENDING_FRAMES = 4096;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CASELESS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const QUEUE_GROUP = /^[^\s]{1,256}$/u;

/** WebSocket close codes the gateway uses (4000-4999 are the application's). */
const CLOSE_PROTOCOL = 4400;
const CLOSE_SILENT = 4408;
const CLOSE_SHUTDOWN = 1001;

type Session = {
  link: AgentLink;
  s: number;
  state: "open" | "ended";
  claim: ComputeAgentLinkClaim;
  scope: string;
  subscriptions: Map<string, { sid: AgentLinkSid; unsubscribe: () => void }>;
  /** Reply subjects of the requests forwarded to the agent that it has not
   * answered yet. When the session ends each gets an empty reply marked
   * AGENT_LINK_LOST_HEADER, so no requester waits on a link that is gone. */
  unanswered: Set<string>;
  relayExpiresAtMs: number;
  /** When the last confirmed open or renewal stops covering this session.
   * Past it nothing is forwarded and no credential is minted: another
   * replica may hold the agent by then. */
  leaseDeadlineMs: number;
  renewing: boolean;
  /** The sandbox the ticket names. */
  sandboxId: string;
  /** The last state the host reported, null before its first `state`. */
  reportedAsleep: boolean | null;
  /** The last state the store committed for this session. A write that
   * failed leaves it behind `reportedAsleep`, and the next renewal tick
   * writes again, without any message to the agent. */
  committedAsleep: boolean | null;
  powerSyncing: boolean;
};

function agentKey(claim: ComputeAgentLinkClaim): string {
  return `${claim.workspaceId}/${claim.agentId}`;
}

export class ComputeAgentGateway {
  readonly path: string;
  private readonly links = new Set<AgentLink>();
  /** The open session for each agent in this process. A later epoch's open
   * ends the older one here at once; sessions on other replicas end on their
   * next renewal. */
  private readonly agents = new Map<string, Session>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private closed = false;
  readonly maxPayload: number;
  readonly timings: {
    renewIntervalMs: number;
    pingIntervalMs: number;
    silenceLimitMs: number;
    relayTtlMs: number;
    relayRefreshBeforeMs: number;
  };

  constructor(readonly options: ComputeAgentGatewayOptions) {
    this.path = new URL(options.linkUrl).pathname;
    this.now = options.now ?? Date.now;
    this.maxPayload = Math.max(
      1,
      Math.min(
        options.nats.maxPayload(),
        options.maxWebSocketMessageBytes - FRAME_HEADER_ALLOWANCE,
      ),
    );
    this.timings = {
      renewIntervalMs: options.renewIntervalMs ?? RENEW_INTERVAL_MS,
      pingIntervalMs: options.pingIntervalMs ?? PING_INTERVAL_MS,
      silenceLimitMs: options.silenceLimitMs ?? SILENCE_LIMIT_MS,
      relayTtlMs: options.relayTtlMs ?? RELAY_TTL_MS,
      relayRefreshBeforeMs: options.relayRefreshBeforeMs ?? RELAY_REFRESH_BEFORE_MS,
    };
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.tick(), this.timings.renewIntervalMs);
  }

  /** Close every link and stop; their hosts dial again, to this or another
   * replica, and reopen their sessions. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const link of [...this.links]) link.shutdown(CLOSE_SHUTDOWN, "gateway shutting down");
  }

  handles(request: Request): boolean {
    return new URL(request.url).pathname === this.path;
  }

  async upgrade(
    request: Request,
    server: {
      upgrade(
        request: Request,
        options: { data: ApiWebSocketConnection; headers: HeadersInit },
      ): boolean;
    },
  ): Promise<Response | undefined> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
    }
    if (this.closed) return new Response("Service Unavailable", { status: 503 });
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim());
    if (!offered.includes(AGENT_LINK_PROTOCOL)) {
      return new Response("Agent link protocol required", { status: 426 });
    }
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/iu.exec(authorization);
    if (!match) return new Response("Unauthorized", { status: 401 });
    let host: ComputeHostClaims;
    try {
      host = await this.options.verifier.verifyHostToken(match[1]!);
    } catch (error) {
      if (error instanceof ComputeLinkKeysUnavailableError) {
        this.options.logger?.warn("compute gateway: link keys unavailable", {
          errorCode: "compute_link_keys_unavailable",
        });
        return new Response("Service Unavailable", { status: 503 });
      }
      this.options.logger?.warn("compute gateway: refused a host token", {
        errorCode: "compute_host_token_invalid",
        reason: error instanceof ComputeLinkTokenError ? error.message : "invalid",
      });
      return new Response("Unauthorized", { status: 401 });
    }
    const link = new AgentLink(this, host.host);
    const upgraded = server.upgrade(request, {
      data: link,
      headers: { "sec-websocket-protocol": AGENT_LINK_PROTOCOL },
    });
    return upgraded ? undefined : new Response("Bad Request", { status: 400 });
  }

  /** @internal */
  register(link: AgentLink): void {
    if (this.closed) {
      link.shutdown(CLOSE_SHUTDOWN, "gateway shutting down");
      return;
    }
    this.links.add(link);
    this.options.logger?.info("compute gateway: host linked", { host: link.host });
  }

  /** @internal */
  unregister(link: AgentLink): void {
    if (this.links.delete(link)) {
      this.options.logger?.info("compute gateway: host unlinked", { host: link.host });
    }
  }

  /** @internal Make `session` its agent's session here, ending any other.
   * An open that a later epoch overtook while it was set up is not adopted
   * (false): the newer session stays. */
  adopt(session: Session): boolean {
    const key = agentKey(session.claim);
    const previous = this.agents.get(key);
    if (previous && previous !== session) {
      if (previous.claim.epoch > session.claim.epoch) return false;
      previous.link.end(
        previous,
        previous.claim.epoch < session.claim.epoch ? "superseded" : "lost",
        "the agent opened another session",
      );
    }
    this.agents.set(key, session);
    return true;
  }

  /** @internal The deadline a claim confirmed by a call started at
   * `startedAtMs` gives. */
  leaseDeadline(startedAtMs: number): number {
    return startedAtMs + this.options.store.leaseMs - LEASE_CLOCK_ALLOWANCE_MS;
  }

  /** @internal Whether `session` may still act for its agent. A session
   * whose lease went unconfirmed past its deadline ends here as `lost`; its
   * host opens it again. */
  authorized(session: Session): boolean {
    if (session.state !== "open") return false;
    if (this.now() < session.leaseDeadlineMs) return true;
    this.options.logger?.warn("compute gateway: a session's claim lapsed", {
      errorCode: "compute_link_claim_lapsed",
      workspaceId: session.claim.workspaceId,
      agentId: session.claim.agentId,
    });
    session.link.end(session, "lost", "the gateway could not renew the agent's claim");
    return false;
  }

  /** @internal */
  forget(session: Session): void {
    const key = agentKey(session.claim);
    if (this.agents.get(key) === session) this.agents.delete(key);
  }

  /** @internal */
  nowMs(): number {
    return this.now();
  }

  /** Renew every open session's claim, refresh relay credentials, and keep
   * links alive. Runs every renew interval; never overlaps itself. */
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const now = this.now();
      const sessions: Session[] = [];
      for (const link of this.links) {
        link.keepAlive(now);
        sessions.push(...link.openSessions());
      }
      let next = 0;
      const worker = async () => {
        while (next < sessions.length) {
          const session = sessions[next++]!;
          await this.renew(session);
          await this.refreshRelay(session);
          await this.syncPower(session);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(RENEW_CONCURRENCY, sessions.length) }, worker),
      );
    } finally {
      this.ticking = false;
    }
  }

  private async renew(session: Session): Promise<void> {
    if (session.state !== "open" || session.renewing) return;
    session.renewing = true;
    const startedAtMs = this.now();
    try {
      const result = await this.options.store.renew(session.claim);
      if (!result.renewed) {
        if (session.state === "open") {
          session.link.end(session, result.code, closedMessage(result.code));
        }
        return;
      }
      session.leaseDeadlineMs = Math.max(session.leaseDeadlineMs, this.leaseDeadline(startedAtMs));
    } catch {
      // The lease outlives several missed renewals and the next tick retries;
      // once the last confirmed lease runs out the session ends.
      this.options.logger?.warn("compute gateway: a session renewal failed", {
        errorCode: "compute_link_renew_failed",
        workspaceId: session.claim.workspaceId,
        agentId: session.claim.agentId,
      });
      this.authorized(session);
    } finally {
      session.renewing = false;
    }
  }

  /** @internal Commit the host's latest reported power state for `session`,
   * one write at a time. A failure is retried by the next tick. */
  async syncPower(session: Session): Promise<void> {
    if (session.powerSyncing) return;
    session.powerSyncing = true;
    try {
      while (
        session.reportedAsleep !== null &&
        session.reportedAsleep !== session.committedAsleep &&
        this.authorized(session)
      ) {
        const asleep = session.reportedAsleep;
        const result = await this.options.store.power({
          ...session.claim,
          sandboxId: session.sandboxId,
          asleep,
        });
        // A refused claim never speaks for the sandbox again; its renewal
        // ends the session.
        session.committedAsleep = asleep;
        if (!result.accepted) return;
      }
    } catch (error) {
      this.options.logger?.warn("compute gateway: power state not recorded", {
        errorCode: "compute_link_power_failed",
        workspaceId: session.claim.workspaceId,
        agentId: session.claim.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      session.powerSyncing = false;
    }
  }

  private async refreshRelay(session: Session): Promise<void> {
    if (!this.authorized(session)) return;
    if (session.relayExpiresAtMs - this.now() > this.timings.relayRefreshBeforeMs) return;
    const relay = await this.mintRelay(session.claim);
    if (!this.authorized(session)) return;
    session.relayExpiresAtMs = relay.expires_at_ms;
    session.link.send({ t: "relay", s: session.s, ...relay });
  }

  /** @internal */
  async mintRelay(
    claim: ComputeAgentLinkClaim,
  ): Promise<{ url: string; token: string; expires_at_ms: number }> {
    const expiresAtMs = this.now() + this.timings.relayTtlMs;
    const token = await this.options.relay.mint({
      workspaceId: claim.workspaceId,
      agentId: claim.agentId,
      expiresAtMs,
    });
    return { url: this.options.relay.url, token, expires_at_ms: expiresAtMs };
  }
}

function closedMessage(code: ClosedCode): string {
  if (code === "revoked") return "the sandbox's enrollment was revoked";
  if (code === "superseded") return "a later owner epoch opened the agent";
  return "another instance holds the agent";
}

function refusedMessage(code: RefusedCode): string {
  switch (code) {
    case "invalid_ticket":
      return "the ticket is invalid";
    case "stale_epoch":
      return "a later owner epoch holds the agent";
    case "unknown_agent":
      return "no sandbox agent matches the ticket";
    case "revoked":
      return "the sandbox's enrollment was revoked";
    case "duplicate":
      return "another live instance holds the agent";
    case "unavailable":
      return "the gateway cannot open the session now";
  }
}

/**
 * One host's link: its sessions, keyed by the host's session number. Its
 * frames are handled strictly in order: an `open` or a `close` finishes
 * (claim taken or released) before the next frame is looked at, so a host
 * that closes an agent's old session and opens its new one, in that order,
 * is never refused as a duplicate of itself.
 */
class AgentLink implements ApiWebSocketConnection {
  private socket: ApiWebSocketLike | null = null;
  private readonly sessions = new Map<number, Session>();
  private terminal = false;
  private lastHeardMs: number;
  private lastPingMs: number;
  private readonly pending: HostFrame[] = [];
  private pendingBytes = 0;
  private draining = false;

  constructor(
    private readonly gateway: ComputeAgentGateway,
    readonly host: string,
  ) {
    this.lastHeardMs = gateway.nowMs();
    this.lastPingMs = this.lastHeardMs;
  }

  attach(socket: ApiWebSocketLike): void {
    if (this.socket || this.terminal) {
      socket.close(CLOSE_PROTOCOL, "invalid connection state");
      return;
    }
    this.socket = socket;
    this.gateway.register(this);
    if (this.terminal) return;
    this.send({ t: "hello", version: AGENT_LINK_VERSION, max_payload: this.gateway.maxPayload });
  }

  heard(): void {
    this.lastHeardMs = this.gateway.nowMs();
  }

  receive(message: string | Uint8Array | ArrayBuffer): void {
    if (this.terminal) return;
    this.heard();
    if (typeof message === "string") {
      this.shutdown(CLOSE_PROTOCOL, "text frames are not allowed");
      return;
    }
    let frame: HostFrame;
    try {
      frame = decodeHostFrame(message instanceof Uint8Array ? message : new Uint8Array(message));
    } catch (error) {
      this.shutdown(
        CLOSE_PROTOCOL,
        error instanceof AgentLinkProtocolError ? error.message : "invalid frame",
      );
      return;
    }
    if (frame.t === "pub") {
      // The payload is a view of the socket's buffer; keep a copy past this call.
      frame = { ...frame, payload: Uint8Array.from(frame.payload) };
      this.pendingBytes += frame.payload.byteLength;
    }
    this.pending.push(frame);
    if (this.pending.length > MAX_PENDING_FRAMES || this.pendingBytes > MAX_PENDING_BYTES) {
      this.shutdown(CLOSE_PROTOCOL, "too many frames pending");
      return;
    }
    void this.drain();
  }

  transportClosed(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.endAll();
  }

  /** Close the link and end its sessions. */
  shutdown(code: number, reason: string): void {
    if (this.terminal) return;
    this.terminal = true;
    this.endAll();
    this.socket?.close(code, reason);
  }

  keepAlive(now: number): void {
    if (this.terminal || !this.socket) return;
    if (now - this.lastHeardMs >= this.gateway.timings.silenceLimitMs) {
      this.shutdown(CLOSE_SILENT, "link silent");
      return;
    }
    if (now - this.lastPingMs >= this.gateway.timings.pingIntervalMs) {
      this.lastPingMs = now;
      this.socket.ping?.();
    }
  }

  openSessions(): Session[] {
    return [...this.sessions.values()].filter((session) => session.state === "open");
  }

  send(frame: GatewayFrame): void {
    if (this.terminal || !this.socket) return;
    // 0 means Bun dropped the message: the link can no longer be trusted to
    // carry its sessions' traffic in order.
    if (this.socket.send(encodeFrame(frame), false) === 0) {
      this.shutdown(1011, "link overloaded");
    }
  }

  /** End a session from the gateway's side, telling the host why. */
  end(session: Session, code: ClosedCode, message: string): void {
    if (session.state === "ended") return;
    this.teardown(session);
    this.send({ t: "closed", s: session.s, code, message });
  }

  /** Handle pending frames in order; only `open` and `close` wait. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.terminal && this.pending.length > 0) {
        const frame = this.pending.shift()!;
        if (frame.t === "pub") this.pendingBytes -= frame.payload.byteLength;
        if (frame.t === "open") {
          await this.open(frame);
        } else if (frame.t === "close") {
          await this.close(frame.s);
        } else {
          const session = this.sessions.get(frame.s);
          // A frame for a session the gateway ended crossed its `closed`.
          if (session && this.gateway.authorized(session)) this.apply(session, frame);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async open(frame: Extract<HostFrame, { t: "open" }>): Promise<void> {
    if (this.sessions.has(frame.s)) {
      this.shutdown(CLOSE_PROTOCOL, "session number reused");
      return;
    }
    let ticket: ComputeTicketClaims;
    try {
      ticket = await this.gateway.options.verifier.verifyTicket(frame.ticket, {
        host: this.host,
        sandbox: frame.sandbox,
      });
    } catch (error) {
      this.refuse(
        frame.s,
        error instanceof ComputeLinkKeysUnavailableError ? "unavailable" : "invalid_ticket",
      );
      return;
    }
    if (!CASELESS_UUID.test(frame.connection)) {
      this.refuse(frame.s, "invalid_ticket", "the connection instance is not valid");
      return;
    }
    if (!UUID.test(ticket.workspaceId) || !UUID.test(ticket.agentId)) {
      this.refuse(frame.s, "unknown_agent");
      return;
    }
    const claim: ComputeAgentLinkClaim = {
      workspaceId: ticket.workspaceId,
      agentId: ticket.agentId,
      epoch: ticket.epoch,
      connectionInstanceId: frame.connection.toLowerCase(),
    };
    // Mint first: once the claim is taken nothing asynchronous may come
    // between it and adoption, or a later epoch could open meanwhile. The
    // credential is only handed over if the open succeeds.
    let relay: { url: string; token: string; expires_at_ms: number };
    try {
      relay = await this.gateway.mintRelay(claim);
    } catch {
      this.refuse(frame.s, "unavailable");
      return;
    }
    const startedAtMs = this.gateway.nowMs();
    let result: Awaited<ReturnType<ComputeAgentLinkStore["open"]>>;
    try {
      result = await this.gateway.options.store.open(claim);
    } catch {
      this.refuse(frame.s, "unavailable");
      return;
    }
    if (!result.opened) {
      this.refuse(frame.s, result.code);
      return;
    }
    if (this.terminal) {
      // The link went while the session opened.
      await this.release(claim);
      return;
    }
    const session: Session = {
      link: this,
      s: frame.s,
      state: "open",
      claim,
      scope: `agent.${claim.workspaceId}.${claim.agentId}.connection.${claim.connectionInstanceId}`,
      subscriptions: new Map(),
      unanswered: new Set(),
      relayExpiresAtMs: relay.expires_at_ms,
      leaseDeadlineMs: this.gateway.leaseDeadline(startedAtMs),
      renewing: false,
      sandboxId: ticket.sandbox,
      reportedAsleep: null,
      committedAsleep: null,
      powerSyncing: false,
    };
    if (!this.gateway.adopt(session)) {
      // A later epoch opened the agent here while this open was in flight.
      await this.release(claim);
      this.refuse(frame.s, "stale_epoch");
      return;
    }
    this.sessions.set(frame.s, session);
    this.gateway.options.logger?.info("compute gateway: session opened", {
      host: this.host,
      workspaceId: claim.workspaceId,
      agentId: claim.agentId,
      epoch: claim.epoch,
      superseded: result.superseded,
    });
    this.send({ t: "opened", s: session.s, scope: session.scope, relay });
  }

  /** The host ended a session: drop it and release its claim before the
   * link's next frame, so the agent's next instance can open at once. */
  private async close(s: number): Promise<void> {
    const session = this.sessions.get(s);
    if (!session || session.state !== "open") return;
    this.teardown(session);
    await this.release(session.claim);
  }

  private refuse(s: number, code: RefusedCode, message?: string): void {
    this.gateway.options.logger?.info("compute gateway: session refused", {
      host: this.host,
      code,
    });
    this.send({ t: "refused", s, code, message: message ?? refusedMessage(code) });
  }

  private async release(claim: ComputeAgentLinkClaim): Promise<void> {
    try {
      await this.gateway.options.store.release(claim);
    } catch {
      // The claim's lease then lapses on its own.
      this.gateway.options.logger?.warn("compute gateway: a claim release failed", {
        errorCode: "compute_link_release_failed",
        workspaceId: claim.workspaceId,
        agentId: claim.agentId,
      });
    }
  }

  private apply(session: Session, frame: Exclude<HostFrame, { t: "open" | "close" }>): void {
    const scope = session.scope;
    switch (frame.t) {
      case "sub": {
        if (
          !maySubscribe(scope, frame.subject) ||
          (frame.queue !== undefined && !QUEUE_GROUP.test(frame.queue))
        ) {
          this.send({
            t: "error",
            s: session.s,
            code: "permission",
            message: `Permissions Violation for Subscription to "${frame.subject}"`,
            sid: frame.sid,
          });
          return;
        }
        const key = String(frame.sid);
        const existing = session.subscriptions.get(key);
        if (!existing && session.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SESSION) {
          this.send({
            t: "error",
            s: session.s,
            code: "too_large",
            message: "too many subscriptions",
            sid: frame.sid,
          });
          return;
        }
        existing?.unsubscribe();
        const sid = frame.sid;
        const unsubscribe = this.gateway.options.nats.subscribe(
          frame.subject,
          frame.queue,
          (message) => {
            if (!this.gateway.authorized(session)) {
              // The session has ended: nothing reaches the agent through it.
              if (message.reply) this.tellLinkLost(message.reply);
              return;
            }
            // Only a request (a message with a reply subject) wakes a sleeping
            // sandbox at its host; any other message waits there until the
            // agent next runs. Name each waker: an idle sandbox should get none.
            if (session.reportedAsleep === true) {
              const attributes = {
                agentId: session.claim.agentId,
                sandboxId: session.sandboxId,
                subject: message.subject,
              };
              if (message.reply) {
                this.gateway.options.logger?.info(
                  "compute gateway: a request wakes a sleeping sandbox",
                  {
                    ...attributes,
                    reply: message.reply,
                  },
                );
              } else {
                this.gateway.options.logger?.debug?.(
                  "compute gateway: a message reaches a sleeping sandbox when it wakes",
                  attributes,
                );
              }
            }
            if (message.reply) {
              if (session.unanswered.size >= MAX_UNANSWERED_REQUESTS_PER_SESSION) {
                this.tellLinkLost(message.reply);
                return;
              }
              // Recorded before it is forwarded: a forward that fails ends the
              // session, and its teardown must tell this requester too.
              session.unanswered.add(message.reply);
            }
            this.send({
              t: "msg",
              s: session.s,
              sid,
              subject: message.subject,
              ...(message.reply ? { reply: message.reply } : {}),
              ...(message.headers ? { headers: message.headers } : {}),
              payload: message.data,
            });
          },
        );
        session.subscriptions.set(key, { sid, unsubscribe });
        return;
      }
      case "unsub": {
        const key = String(frame.sid);
        session.subscriptions.get(key)?.unsubscribe();
        session.subscriptions.delete(key);
        return;
      }
      case "pub": {
        if (frame.payload.byteLength > this.gateway.maxPayload) {
          this.send({
            t: "error",
            s: session.s,
            code: "too_large",
            message: "Maximum Payload Violation",
          });
          return;
        }
        if (
          !mayPublish(scope, frame.subject) ||
          (frame.reply !== undefined && !mayReplyTo(scope, frame.reply))
        ) {
          this.send({
            t: "error",
            s: session.s,
            code: "permission",
            message: `Permissions Violation for Publish to "${frame.subject}"`,
          });
          return;
        }
        session.unanswered.delete(frame.subject);
        // Only the gateway says a link was lost: an agent's own marker is
        // dropped, so its reply reads as the reply it is.
        const headers = frame.headers?.filter(
          ([name]) => name.toLowerCase() !== AGENT_LINK_LOST_HEADER.toLowerCase(),
        );
        try {
          this.gateway.options.nats.publish(frame.subject, frame.payload, {
            ...(frame.reply ? { reply: frame.reply } : {}),
            ...(headers?.length ? { headers } : {}),
          });
        } catch {
          // NATS publishes are fire-and-forget; a closed connection drops it.
        }
        return;
      }
      case "state": {
        session.reportedAsleep = frame.state === "asleep";
        void this.gateway.syncPower(session);
        return;
      }
    }
  }

  private teardown(session: Session): void {
    if (session.state === "ended") return;
    session.state = "ended";
    for (const subscription of session.subscriptions.values()) subscription.unsubscribe();
    session.subscriptions.clear();
    // The agent can no longer answer these through this session. Tell each
    // requester at once, from whichever replica held the link: a replayable
    // request is delivered again, to wherever the agent is now.
    const unanswered = [...session.unanswered];
    session.unanswered.clear();
    for (const reply of unanswered) this.tellLinkLost(reply);
    if (this.sessions.get(session.s) === session) this.sessions.delete(session.s);
    this.gateway.forget(session);
  }

  /** Tell a requester that the link that was to carry its request to the
   * agent is gone (AGENT_LINK_LOST_HEADER); it may have been delivered. */
  private tellLinkLost(reply: string): void {
    try {
      this.gateway.options.nats.publish(reply, new Uint8Array(0), {
        headers: [[AGENT_LINK_LOST_HEADER, "1"]],
      });
    } catch {
      // A closed connection drops it; the requester's own timeout ends it.
    }
  }

  /** The link ended: drop its sessions and release their claims, so a host
   * that dials again (here or at another replica) gets back in at once. */
  private endAll(): void {
    this.pending.length = 0;
    this.pendingBytes = 0;
    const claims: ComputeAgentLinkClaim[] = [];
    for (const session of [...this.sessions.values()]) {
      if (session.state === "open") claims.push(session.claim);
      this.teardown(session);
    }
    this.gateway.unregister(this);
    for (const claim of claims) void this.release(claim);
  }
}
