// Unit tests for the compute agent gateway's frames, token verification and
// timers, with fake sockets, a fake claim store and an in-memory NATS. The
// real-wire proof is test/integration/compute-agent-gateway.integration.ts.

import { describe, expect, test } from "bun:test";
import type { AgentLinkNats, AgentLinkNatsMessage } from "@opengeni/events";
import { AGENT_LINK_LOST_HEADER } from "@opengeni/runtime/sandbox";
import { testSettings } from "@opengeni/testing";
import type { ApiWebSocketConnection, ApiWebSocketLike } from "../src/api-websocket";
import { startComputeAgentGateway } from "../src/sandbox/compute-gateway-boot";
import {
  ComputeAgentGateway,
  type ComputeAgentLinkClaim,
  type ComputeAgentLinkStore,
} from "../src/sandbox/compute-gateway";
import {
  AgentLinkProtocolError,
  decodeGatewayFrame,
  decodeHostFrame,
  encodeFrame,
  mayPublish,
  mayReplyTo,
  maySubscribe,
  validSubject,
  type GatewayFrame,
  type HostFrame,
} from "../src/sandbox/compute-link-frames";
import {
  ComputeLinkKeysUnavailableError,
  ComputeLinkTokenError,
  ComputeLinkVerifier,
  type ComputeLinkKeySet,
} from "../src/sandbox/compute-link-tokens";
import {
  generateTestLinkKey,
  hostToken,
  sandboxTicket,
  signTestLinkToken,
} from "../../../test/integration/helpers/compute-link-host";

const AUDIENCE = "wss://gateway.test/v1/compute/agent-link";
const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTANCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SCOPE = `agent.${WS}.${AGENT}.connection.${INSTANCE}`;

describe("agent link frames", () => {
  test("a frame is a JSON header, a newline, then the payload", () => {
    const bytes = encodeFrame({
      t: "pub",
      s: 1,
      subject: `${SCOPE}.events`,
      payload: new Uint8Array([10, 0, 255]),
    });
    const newline = bytes.indexOf(0x0a);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline)))).toEqual({
      t: "pub",
      s: 1,
      subject: `${SCOPE}.events`,
    });
    expect([...bytes.subarray(newline + 1)]).toEqual([10, 0, 255]);
    const decoded = decodeHostFrame(bytes);
    expect(decoded).toMatchObject({ t: "pub", s: 1, subject: `${SCOPE}.events` });
    expect([...(decoded as Extract<HostFrame, { t: "pub" }>).payload]).toEqual([10, 0, 255]);
    const msg = decodeGatewayFrame(
      encodeFrame({ t: "msg", s: 2, sid: "x", subject: "a.b", payload: new Uint8Array([1]) }),
    );
    expect(msg).toMatchObject({ t: "msg", s: 2, sid: "x", subject: "a.b" });
  });

  test("anything not understood is a protocol error", () => {
    const bad = [
      "no newline",
      "not json\n",
      "[1]\n",
      '{"t":"open","s":1}\n',
      '{"t":"sub","s":-1,"sid":1,"subject":"a"}\n',
      '{"t":"close","s":1}\npayload',
      '{"t":"state","s":1,"state":"dozing"}\n',
      '{"t":"wat","s":1}\n',
      '{"t":"pub","s":1,"subject":"a","headers":[["bad name","v"]]}\n',
    ];
    for (const text of bad) {
      expect(() => decodeHostFrame(new TextEncoder().encode(text))).toThrow(AgentLinkProtocolError);
    }
  });

  test("permissions match the NATS callout's grant", () => {
    expect(maySubscribe(SCOPE, `${SCOPE}.rpc`)).toBe(true);
    expect(maySubscribe(SCOPE, `${SCOPE}.>`)).toBe(true);
    expect(maySubscribe(SCOPE, `${SCOPE}.*.x`)).toBe(true);
    expect(maySubscribe(SCOPE, SCOPE)).toBe(false);
    expect(maySubscribe(SCOPE, `agent.${WS}.>`)).toBe(false);
    expect(maySubscribe(SCOPE, `agent.${WS}.${AGENT}.connection.*.rpc`)).toBe(false);
    expect(maySubscribe(SCOPE, "_INBOX.>")).toBe(false);
    expect(maySubscribe(SCOPE, `${SCOPE}..x`)).toBe(false);
    expect(maySubscribe(SCOPE, `${SCOPE}.a b`)).toBe(false);
    expect(mayPublish(SCOPE, `${SCOPE}.events`)).toBe(true);
    expect(mayPublish(SCOPE, "_INBOX.abc.1")).toBe(true);
    expect(mayPublish(SCOPE, "_INBOX.*")).toBe(false);
    expect(mayPublish(SCOPE, `${SCOPE}.>`)).toBe(false);
    expect(mayPublish(SCOPE, "_INBOX")).toBe(false);
    expect(mayPublish(SCOPE, `agent.${WS}.other.connection.${INSTANCE}.rpc`)).toBe(false);
    expect(mayReplyTo(SCOPE, `${SCOPE}.reply.1`)).toBe(true);
    expect(mayReplyTo(SCOPE, "_INBOX.abc")).toBe(false);
    expect(validSubject("a.>.b", true)).toBe(false);
    expect(validSubject("a.b*", true)).toBe(false);
  });
});

describe("link token verification", () => {
  async function setup(now = () => Date.now()) {
    const key = await generateTestLinkKey("k1");
    let reads = 0;
    let keySet: ComputeLinkKeySet = { team: "t1", keys: [key.jwk] };
    let failing = false;
    const verifier = new ComputeLinkVerifier({
      audience: AUDIENCE,
      now,
      fetchKeys: async () => {
        reads += 1;
        if (failing) throw new Error("fabric down");
        return keySet;
      },
    });
    return {
      key,
      verifier,
      reads: () => reads,
      setKeys: (next: ComputeLinkKeySet) => (keySet = next),
      fail: (value: boolean) => (failing = value),
    };
  }

  test("a host token names its host; type, audience, signature and time are checked", async () => {
    const { key, verifier } = await setup();
    expect(
      await verifier.verifyHostToken(await hostToken(key, { audience: AUDIENCE, host: "h1" })),
    ).toMatchObject({ host: "h1" });
    const now = Math.floor(Date.now() / 1000);
    const rejects = [
      await hostToken(key, { audience: "wss://other/x", host: "h1" }),
      await hostToken(key, { audience: AUDIENCE, host: "h1", ttlSeconds: -61 }),
      await signTestLinkToken(key, {
        typ: "compute-sandbox",
        aud: AUDIENCE,
        sub: "h1",
        exp: now + 60,
      }),
      await signTestLinkToken(key, {
        typ: "compute-host",
        aud: AUDIENCE,
        sub: "h1",
        iat: now + 120,
        exp: now + 600,
      }),
      await signTestLinkToken(key, { typ: "compute-host", aud: AUDIENCE, sub: "h1" }),
    ];
    const good = await hostToken(key, { audience: AUDIENCE, host: "h1" });
    const [head, body] = good.split(".");
    rejects.push(`${head}.${body}.${"A".repeat(86)}`);
    rejects.push(`${Buffer.from('{"alg":"HS256","kid":"k1"}').toString("base64url")}.${body}.x`);
    for (const token of rejects) {
      await expect(verifier.verifyHostToken(token)).rejects.toBeInstanceOf(ComputeLinkTokenError);
    }
    // Within the 60 s skew an expired token still passes.
    expect(
      await verifier.verifyHostToken(
        await hostToken(key, { audience: AUDIENCE, host: "h1", ttlSeconds: -30 }),
      ),
    ).toMatchObject({ host: "h1" });
  });

  test("a ticket must match the link's host, the sandbox and Opengeni's team", async () => {
    const { key, verifier } = await setup();
    const claims = {
      audience: AUDIENCE,
      sandbox: "sbx-1",
      host: "h1",
      epoch: 4,
      team: "t1",
      workspaceId: WS,
      agentId: AGENT,
    };
    expect(
      await verifier.verifyTicket(await sandboxTicket(key, claims), {
        host: "h1",
        sandbox: "sbx-1",
      }),
    ).toEqual({
      sandbox: "sbx-1",
      host: "h1",
      epoch: 4,
      team: "t1",
      workspaceId: WS,
      agentId: AGENT,
    });
    for (const [override, expected] of [
      [{ host: "h2" }, { host: "h1", sandbox: "sbx-1" }],
      [{}, { host: "h1", sandbox: "sbx-2" }],
      [{ team: "t2" }, { host: "h1", sandbox: "sbx-1" }],
      [{ epoch: -1 }, { host: "h1", sandbox: "sbx-1" }],
      [{ audience: "wss://other/x" }, { host: "h1", sandbox: "sbx-1" }],
    ] as const) {
      await expect(
        verifier.verifyTicket(await sandboxTicket(key, { ...claims, ...override }), expected),
      ).rejects.toBeInstanceOf(ComputeLinkTokenError);
    }
  });

  test("keys are cached five minutes, read again for an unknown kid at most every ten seconds", async () => {
    let now = Date.now();
    const { key, verifier, reads, setKeys, fail } = await setup(() => now);
    const token = await hostToken(key, { audience: AUDIENCE, host: "h1", ttlSeconds: 10 ** 9 });
    await verifier.verifyHostToken(token);
    await verifier.verifyHostToken(token);
    expect(reads()).toBe(1);

    const rotated = await generateTestLinkKey("k2");
    const rotatedToken = await hostToken(rotated, {
      audience: AUDIENCE,
      host: "h1",
      ttlSeconds: 10 ** 9,
    });
    // Unknown kid within ten seconds of the last read: no new read.
    await expect(verifier.verifyHostToken(rotatedToken)).rejects.toThrow("token key is unknown");
    expect(reads()).toBe(1);
    now += 10_000;
    setKeys({ team: "t1", keys: [rotated.jwk, key.jwk] });
    expect(await verifier.verifyHostToken(rotatedToken)).toMatchObject({ host: "h1" });
    expect(reads()).toBe(2);

    // After five minutes the set is read again; a failed read keeps the last.
    now += 5 * 60_000;
    fail(true);
    expect(await verifier.verifyHostToken(rotatedToken)).toMatchObject({ host: "h1" });
    expect(reads()).toBe(3);
  });

  test("with no keys at all the gateway cannot judge a token yet", async () => {
    const { key, verifier, fail } = await setup();
    fail(true);
    await expect(
      verifier.verifyHostToken(await hostToken(key, { audience: AUDIENCE, host: "h1" })),
    ).rejects.toBeInstanceOf(ComputeLinkKeysUnavailableError);
  });
});

class FakeNats implements AgentLinkNats {
  readonly subscriptions = new Map<
    number,
    { subject: string; deliver: (m: AgentLinkNatsMessage) => void }
  >();
  readonly published: Array<{
    subject: string;
    data: Uint8Array;
    reply?: string;
    headers?: Array<[string, string]>;
  }> = [];
  private next = 0;
  maxPayload(): number {
    return 1024;
  }
  subscribe(
    subject: string,
    _queue: string | undefined,
    deliver: (m: AgentLinkNatsMessage) => void,
  ) {
    const id = this.next++;
    this.subscriptions.set(id, { subject, deliver });
    return () => void this.subscriptions.delete(id);
  }
  publish(
    subject: string,
    data: Uint8Array,
    options?: { reply?: string; headers?: Array<[string, string]> },
  ) {
    this.published.push({
      subject,
      data,
      ...(options?.reply ? { reply: options.reply } : {}),
      ...(options?.headers ? { headers: options.headers } : {}),
    });
  }
  async close() {}
}

class FakeStore implements ComputeAgentLinkStore {
  readonly leaseMs = 20_000;
  readonly calls: string[] = [];
  renewAnswer: Awaited<ReturnType<ComputeAgentLinkStore["renew"]>> = { renewed: true };
  renewThrows = false;
  /** An open for this epoch waits until the promise settles. */
  readonly openGates = new Map<number, Promise<void>>();
  private release_: (() => void) | null = null;
  async open(claim: ComputeAgentLinkClaim) {
    this.calls.push(`open:${claim.connectionInstanceId}:${claim.epoch}`);
    await this.openGates.get(claim.epoch);
    return { opened: true as const, superseded: false };
  }
  async renew(claim: ComputeAgentLinkClaim) {
    this.calls.push(`renew:${claim.connectionInstanceId}`);
    if (this.renewThrows) throw new Error("db down");
    return this.renewAnswer;
  }
  async release(claim: ComputeAgentLinkClaim) {
    this.calls.push(`release:${claim.connectionInstanceId}`);
    this.release_?.();
  }
  /** Power records wait on this (to prove they apply in order). */
  powerGate: Promise<void> = Promise.resolve();
  powerThrows = false;
  powerAccepted = true;
  async power(input: ComputeAgentLinkClaim & { sandboxId: string; asleep: boolean }) {
    await this.powerGate;
    this.calls.push(`power:${input.sandboxId}:${input.asleep ? "asleep" : "awake"}`);
    if (this.powerThrows) throw new Error("db down");
    return { accepted: this.powerAccepted };
  }
}

class FakeSocket {
  readonly frames: GatewayFrame[] = [];
  pings = 0;
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  constructor(readonly data: ApiWebSocketConnection) {}
  send(bytes: Uint8Array): number {
    this.frames.push(decodeGatewayFrame(bytes));
    return bytes.byteLength;
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
  ping(): number {
    this.pings += 1;
    return 1;
  }
}

async function gatewayWithLink(
  options: {
    now?: () => number;
    logger?: {
      debug(message: string, attributes?: object): void;
      info(message: string, attributes?: object): void;
      warn(): void;
    };
  } = {},
) {
  const nats = new FakeNats();
  const store = new FakeStore();
  let minted = 0;
  const gateway = new ComputeAgentGateway({
    linkUrl: AUDIENCE,
    nats,
    store,
    maxWebSocketMessageBytes: 8 * 1024 * 1024,
    verifier: {
      verifyHostToken: async () => ({ host: "h1", expiresAtMs: Date.now() + 3_600_000 }),
      // A ticket "e<n>" carries owner epoch n; any other is epoch 1.
      verifyTicket: async (ticket, expected) => ({
        sandbox: expected.sandbox,
        host: expected.host,
        epoch: /^e\d+$/u.test(ticket) ? Number(ticket.slice(1)) : 1,
        team: "t1",
        workspaceId: WS,
        agentId: AGENT,
      }),
    },
    relay: { url: "wss://relay.test/stream", mint: async () => `ogr_token_${++minted}` },
    ...(options.now ? { now: options.now } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  /** Another host link to the same gateway. */
  const connect = async () => {
    let socket: FakeSocket | undefined;
    const response = await gateway.upgrade(
      new Request(AUDIENCE.replace("wss:", "https:"), {
        headers: { authorization: "Bearer x", "sec-websocket-protocol": "opengeni.agent-link.v1" },
      }),
      {
        upgrade: (_request, upgradeOptions) => {
          socket = new FakeSocket(upgradeOptions.data);
          return true;
        },
      },
    );
    expect(response).toBeUndefined();
    socket!.data.attach(socket as unknown as ApiWebSocketLike);
    const send = (frame: HostFrame) => socket!.data.receive(encodeFrame(frame));
    return { socket: socket!, send };
  };
  const { socket, send } = await connect();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { gateway, nats, store, socket, send, settle, connect };
}

describe("agent gateway sessions", () => {
  test("the upgrade needs the agent-link protocol and a bearer", async () => {
    const { gateway } = await gatewayWithLink();
    const server = { upgrade: () => true };
    const url = AUDIENCE.replace("wss:", "https:");
    expect((await gateway.upgrade(new Request(url), server))?.status).toBe(426);
    expect(
      (
        await gateway.upgrade(
          new Request(url, { headers: { "sec-websocket-protocol": "opengeni.agent-link.v1" } }),
          server,
        )
      )?.status,
    ).toBe(401);
    expect((await gateway.upgrade(new Request(url, { method: "POST" }), server))?.status).toBe(405);
    expect(gateway.handles(new Request("https://gateway.test/v1/compute/agent-link"))).toBe(true);
    expect(gateway.handles(new Request("https://gateway.test/v1/other"))).toBe(false);
  });

  test("frames are handled in order: a close releases before the next open", async () => {
    const { socket, send, settle, store } = await gatewayWithLink();
    expect(socket.frames[0]).toEqual({ t: "hello", version: 1, max_payload: 1024 });
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    // Sent before the open finished; handled after it, in order.
    send({ t: "sub", s: 1, sid: 1, subject: `${SCOPE}.rpc` });
    send({ t: "close", s: 1 });
    send({ t: "open", s: 2, sandbox: "sbx", ticket: "t", connection: INSTANCE.toUpperCase() });
    await settle();
    expect(store.calls).toEqual([
      `open:${INSTANCE}:1`,
      `release:${INSTANCE}`,
      `open:${INSTANCE}:1`,
    ]);
    expect(socket.frames.map((frame) => `${frame.t}:${"s" in frame ? frame.s : ""}`)).toEqual([
      "hello:",
      "opened:1",
      "opened:2",
    ]);
  });

  test("messages flow both ways; frames for an ended session are dropped", async () => {
    const { socket, send, settle, nats } = await gatewayWithLink();
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    send({ t: "sub", s: 1, sid: "r", subject: `${SCOPE}.rpc` });
    await settle();
    const [subscription] = [...nats.subscriptions.values()];
    subscription!.deliver({
      subject: `${SCOPE}.rpc`,
      reply: "_INBOX.1",
      data: new Uint8Array([7]),
    });
    expect(socket.frames.at(-1)).toMatchObject({ t: "msg", s: 1, sid: "r", reply: "_INBOX.1" });
    send({ t: "pub", s: 1, subject: "_INBOX.1", payload: new Uint8Array([8]) });
    await settle();
    expect(nats.published).toHaveLength(1);
    send({ t: "unsub", s: 1, sid: "r" });
    await settle();
    expect(nats.subscriptions.size).toBe(0);
    send({ t: "close", s: 1 });
    send({ t: "pub", s: 1, subject: "_INBOX.1", payload: new Uint8Array([8]) });
    await settle();
    expect(nats.published).toHaveLength(1);
  });

  test("renewals keep the session; a lost claim ends it; failures retry", async () => {
    const { gateway, socket, send, settle, store, nats } = await gatewayWithLink();
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    send({ t: "sub", s: 1, sid: 1, subject: `${SCOPE}.rpc` });
    await settle();
    await gateway.tick();
    expect(store.calls.filter((call) => call.startsWith("renew"))).toHaveLength(1);
    store.renewThrows = true;
    await gateway.tick();
    expect(socket.frames.some((frame) => frame.t === "closed")).toBe(false);
    store.renewThrows = false;
    store.renewAnswer = { renewed: false, code: "lost" };
    await gateway.tick();
    expect(socket.frames.at(-1)).toMatchObject({ t: "closed", s: 1, code: "lost" });
    expect(nats.subscriptions.size).toBe(0);
    // A session the gateway ended is not released: another instance holds it.
    expect(store.calls.some((call) => call.startsWith("release"))).toBe(false);
  });

  test("a session whose renewals keep failing loses its authority at the lease deadline", async () => {
    let now = 1_000_000;
    const { gateway, socket, send, settle, store, nats } = await gatewayWithLink({
      now: () => now,
    });
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    send({ t: "sub", s: 1, sid: 1, subject: `${SCOPE}.rpc` });
    await settle();
    store.renewThrows = true;
    // Within the last confirmed lease (20 s, less the clock allowance) the
    // session still forwards.
    now += 10_000;
    socket.data.heard?.();
    await gateway.tick();
    send({ t: "pub", s: 1, subject: "_INBOX.1", payload: new Uint8Array([1]) });
    await settle();
    expect(nats.published).toHaveLength(1);
    // Past it, the session ends as lost before anything else is forwarded,
    // and its subscriptions go with it.
    now += 8_000;
    send({ t: "pub", s: 1, subject: "_INBOX.1", payload: new Uint8Array([2]) });
    await settle();
    expect(nats.published).toHaveLength(1);
    expect(socket.frames.at(-1)).toMatchObject({ t: "closed", s: 1, code: "lost" });
    expect(nats.subscriptions.size).toBe(0);
    // An hour later no relay credential has been minted for it.
    now += 3_600_000;
    socket.data.heard?.();
    await gateway.tick();
    expect(socket.frames.filter((frame) => frame.t === "relay")).toHaveLength(0);
  });

  test("an inbound message after the lease deadline is not forwarded", async () => {
    let now = 1_000_000;
    const { socket, send, settle, store, nats } = await gatewayWithLink({
      now: () => now,
    });
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    send({ t: "sub", s: 1, sid: "r", subject: `${SCOPE}.rpc` });
    await settle();
    const [subscription] = [...nats.subscriptions.values()];
    store.renewThrows = true;
    now += 25_000;
    subscription!.deliver({ subject: `${SCOPE}.rpc`, data: new Uint8Array([7]) });
    expect(socket.frames.some((frame) => frame.t === "msg")).toBe(false);
    expect(socket.frames.at(-1)).toMatchObject({ t: "closed", s: 1, code: "lost" });
  });

  test("an older epoch's open that finishes last never evicts the newer session", async () => {
    const { store, socket, send, settle, connect } = await gatewayWithLink();
    let releaseEpoch1!: () => void;
    store.openGates.set(1, new Promise<void>((resolve) => (releaseEpoch1 = resolve)));
    const older = INSTANCE;
    const newer = crypto.randomUUID();
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "e1", connection: older });
    await settle();
    const second = await connect();
    second.send({ t: "open", s: 1, sandbox: "sbx", ticket: "e2", connection: newer });
    await settle();
    expect(second.socket.frames.at(-1)).toMatchObject({ t: "opened", s: 1 });
    releaseEpoch1();
    await settle();
    expect(socket.frames.at(-1)).toMatchObject({ t: "refused", s: 1, code: "stale_epoch" });
    expect(second.socket.frames.some((frame) => frame.t === "closed")).toBe(false);
    // Only the stale open's own claim is released.
    expect(store.calls).toContain(`release:${older}`);
    expect(store.calls).not.toContain(`release:${newer}`);
  });

  test("sleep and wake are recorded once per change, one write at a time, for the ticket's sandbox", async () => {
    const { send, settle, store } = await gatewayWithLink();
    const powerCalls = () => store.calls.filter((call) => call.startsWith("power:"));
    let openGate!: () => void;
    store.powerGate = new Promise((resolve) => (openGate = resolve));
    send({ t: "open", s: 1, sandbox: "sbx-1", ticket: "t", connection: INSTANCE });
    send({ t: "state", s: 1, state: "awake" });
    await settle();
    // The first write is in flight; later reports wait for it.
    send({ t: "state", s: 1, state: "asleep" });
    send({ t: "state", s: 1, state: "asleep" });
    await settle();
    expect(powerCalls()).toEqual([]);
    openGate();
    await settle();
    expect(powerCalls()).toEqual(["power:sbx-1:awake", "power:sbx-1:asleep"]);
    send({ t: "state", s: 1, state: "asleep" });
    send({ t: "state", s: 1, state: "awake" });
    await settle();
    expect(powerCalls()).toEqual(["power:sbx-1:awake", "power:sbx-1:asleep", "power:sbx-1:awake"]);
  });

  test("a request to a sleeping sandbox is logged as its waker; a plain message is not", async () => {
    const logged: { level: string; message: string; attributes: unknown }[] = [];
    const { send, settle, nats } = await gatewayWithLink({
      logger: {
        debug: (message, attributes) => logged.push({ level: "debug", message, attributes }),
        info: (message, attributes) => {
          if (message.includes("sleeping sandbox"))
            logged.push({ level: "info", message, attributes });
        },
        warn: () => {},
      },
    });
    send({ t: "open", s: 1, sandbox: "sbx-1", ticket: "t", connection: INSTANCE });
    send({ t: "sub", s: 1, sid: "r", subject: `${SCOPE}.rpc` });
    send({ t: "state", s: 1, state: "awake" });
    await settle();
    const [subscription] = [...nats.subscriptions.values()];
    subscription!.deliver({
      subject: `${SCOPE}.rpc`,
      reply: "_INBOX.1",
      data: new Uint8Array([1]),
    });
    expect(logged).toEqual([]);
    send({ t: "state", s: 1, state: "asleep" });
    await settle();
    // A plain publish (an ack, say) waits at the host: debug only.
    subscription!.deliver({ subject: `${SCOPE}.rpc`, data: new Uint8Array([2]) });
    // A request wakes the sandbox: named at info, with its reply subject.
    subscription!.deliver({
      subject: `${SCOPE}.rpc`,
      reply: "_INBOX.2",
      data: new Uint8Array([3]),
    });
    const attributes = { agentId: AGENT, sandboxId: "sbx-1", subject: `${SCOPE}.rpc` };
    expect(logged).toEqual([
      {
        level: "debug",
        message: "compute gateway: a message reaches a sleeping sandbox when it wakes",
        attributes,
      },
      {
        level: "info",
        message: "compute gateway: a request wakes a sleeping sandbox",
        attributes: { ...attributes, reply: "_INBOX.2" },
      },
    ]);
  });

  test("a power write that failed is written again on the next tick, without messaging the agent", async () => {
    const { gateway, nats, send, settle, store } = await gatewayWithLink();
    const powerCalls = () => store.calls.filter((call) => call.startsWith("power:"));
    send({ t: "open", s: 1, sandbox: "sbx-1", ticket: "t", connection: INSTANCE });
    store.powerThrows = true;
    send({ t: "state", s: 1, state: "asleep" });
    await settle();
    expect(powerCalls()).toEqual(["power:sbx-1:asleep"]);
    // A duplicate report retries too, but a failed store keeps failing.
    send({ t: "state", s: 1, state: "asleep" });
    await settle();
    expect(powerCalls()).toEqual(["power:sbx-1:asleep", "power:sbx-1:asleep"]);
    store.powerThrows = false;
    const published = nats.published.length;
    await gateway.tick();
    await settle();
    expect(powerCalls()).toEqual([
      "power:sbx-1:asleep",
      "power:sbx-1:asleep",
      "power:sbx-1:asleep",
    ]);
    // Committed now: later ticks write nothing, and nothing went to the agent.
    await gateway.tick();
    await settle();
    expect(powerCalls()).toHaveLength(3);
    expect(nats.published.length).toBe(published);
  });

  test("a claim the store no longer accepts stops writing power state", async () => {
    const { gateway, send, settle, store } = await gatewayWithLink();
    const powerCalls = () => store.calls.filter((call) => call.startsWith("power:"));
    send({ t: "open", s: 1, sandbox: "sbx-1", ticket: "t", connection: INSTANCE });
    store.powerAccepted = false;
    send({ t: "state", s: 1, state: "asleep" });
    await settle();
    await gateway.tick();
    await settle();
    expect(powerCalls()).toEqual(["power:sbx-1:asleep"]);
  });

  test("a session past its lease deadline records no power state", async () => {
    let now = 1_000_000;
    const { send, settle, store } = await gatewayWithLink({ now: () => now });
    send({ t: "open", s: 1, sandbox: "sbx-1", ticket: "t", connection: INSTANCE });
    await settle();
    now += 60_000;
    send({ t: "state", s: 1, state: "asleep" });
    await settle();
    expect(store.calls.some((call) => call.startsWith("power:"))).toBe(false);
  });

  test("the relay credential is refreshed before it expires", async () => {
    let now = 1_000_000;
    const { gateway, socket, send, settle } = await gatewayWithLink({ now: () => now });
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    await settle();
    const opened = socket.frames.at(-1) as Extract<GatewayFrame, { t: "opened" }>;
    expect(opened.relay).toEqual({
      url: "wss://relay.test/stream",
      token: "ogr_token_1",
      expires_at_ms: now + 3_600_000,
    });
    now += 49 * 60_000;
    socket.data.heard?.();
    await gateway.tick();
    expect(socket.frames.at(-1)?.t).toBe("opened");
    now += 2 * 60_000;
    socket.data.heard?.();
    await gateway.tick();
    expect(socket.frames.at(-1)).toEqual({
      t: "relay",
      s: 1,
      url: "wss://relay.test/stream",
      token: "ogr_token_2",
      expires_at_ms: now + 3_600_000,
    });
  });

  test("the gateway pings a quiet link and closes a silent one, releasing its claims", async () => {
    let now = 1_000_000;
    const { gateway, socket, send, settle, store } = await gatewayWithLink({ now: () => now });
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    await settle();
    now += 20_000;
    await gateway.tick();
    expect(socket.pings).toBe(1);
    socket.data.heard?.();
    now += 59_000;
    await gateway.tick();
    expect(socket.closedWith).toBeNull();
    now += 1_000;
    await gateway.tick();
    expect(socket.closedWith).toEqual({ code: 4408, reason: "link silent" });
    await settle();
    expect(store.calls.at(-1)).toBe(`release:${INSTANCE}`);
  });

  test("requests the agent has not answered when its session ends are told the link was lost", async () => {
    const { socket, send, settle, nats } = await gatewayWithLink();
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    send({ t: "sub", s: 1, sid: "r", subject: `${SCOPE}.rpc` });
    await settle();
    const [subscription] = [...nats.subscriptions.values()];
    for (const reply of ["_INBOX.answered", "_INBOX.pending"]) {
      subscription!.deliver({ subject: `${SCOPE}.rpc`, reply, data: new Uint8Array([1]) });
    }
    // A plain message has no requester to tell.
    subscription!.deliver({ subject: `${SCOPE}.rpc`, data: new Uint8Array([2]) });
    send({ t: "pub", s: 1, subject: "_INBOX.answered", payload: new Uint8Array([3]) });
    await settle();
    expect(nats.published.map((message) => message.subject)).toEqual(["_INBOX.answered"]);
    // The host's link ends (its machine is gone).
    socket.data.transportClosed();
    await settle();
    expect(nats.published.slice(1)).toEqual([
      {
        subject: "_INBOX.pending",
        data: new Uint8Array(0),
        headers: [[AGENT_LINK_LOST_HEADER, "1"]],
      },
    ]);
  });

  test("an agent cannot say its own link was lost", async () => {
    const { send, settle, nats } = await gatewayWithLink();
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    await settle();
    send({
      t: "pub",
      s: 1,
      subject: "_INBOX.forged",
      payload: new Uint8Array(0),
      headers: [
        [AGENT_LINK_LOST_HEADER.toLowerCase(), "1"],
        ["Opengeni-Replay", "1"],
      ],
    });
    send({
      t: "pub",
      s: 1,
      subject: "_INBOX.plain",
      payload: new Uint8Array(0),
      headers: [[AGENT_LINK_LOST_HEADER, "1"]],
    });
    await settle();
    expect(nats.published).toEqual([
      { subject: "_INBOX.forged", data: new Uint8Array(0), headers: [["Opengeni-Replay", "1"]] },
      { subject: "_INBOX.plain", data: new Uint8Array(0) },
    ]);
  });

  test("a session remembers a bounded number of unanswered requests, oldest forgotten first", async () => {
    const { socket, send, settle, nats } = await gatewayWithLink();
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    send({ t: "sub", s: 1, sid: "r", subject: `${SCOPE}.rpc` });
    await settle();
    const [subscription] = [...nats.subscriptions.values()];
    for (let index = 0; index <= 4096; index += 1) {
      subscription!.deliver({
        subject: `${SCOPE}.rpc`,
        reply: `_INBOX.${index}`,
        data: new Uint8Array([1]),
      });
    }
    socket.data.transportClosed();
    await settle();
    const told = nats.published.map((message) => message.subject);
    expect(told).toHaveLength(4096);
    expect(told[0]).toBe("_INBOX.1");
    expect(told.at(-1)).toBe("_INBOX.4096");
  });

  test("a session the gateway ends tells its unanswered requesters too", async () => {
    const { gateway, send, settle, store, nats } = await gatewayWithLink();
    send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    send({ t: "sub", s: 1, sid: "r", subject: `${SCOPE}.rpc` });
    await settle();
    const [subscription] = [...nats.subscriptions.values()];
    subscription!.deliver({
      subject: `${SCOPE}.rpc`,
      reply: "_INBOX.1",
      data: new Uint8Array([1]),
    });
    store.renewAnswer = { renewed: false, code: "lost" };
    await gateway.tick();
    await settle();
    expect(nats.published).toEqual([
      { subject: "_INBOX.1", data: new Uint8Array(0), headers: [[AGENT_LINK_LOST_HEADER, "1"]] },
    ]);
  });

  test("a later local session for the same agent supersedes the earlier", async () => {
    const first = await gatewayWithLink();
    first.send({ t: "open", s: 1, sandbox: "sbx", ticket: "t", connection: INSTANCE });
    await first.settle();
    // Same agent opened again on the same link (another instance): the older
    // local session ends as lost at once.
    first.send({ t: "open", s: 2, sandbox: "sbx", ticket: "t", connection: crypto.randomUUID() });
    await first.settle();
    expect(first.socket.frames).toContainEqual(
      expect.objectContaining({ t: "closed", s: 1, code: "lost" }),
    );
  });
});

describe("gateway boot", () => {
  test("stays off unless compute is configured, and refuses a half configuration", async () => {
    let connects = 0;
    const connectNats = async () => {
      connects += 1;
      return new FakeNats();
    };
    const base = {
      db: {} as never,
      natsAuth: undefined,
      maxWebSocketMessageBytes: 1 << 20,
      connectNats,
    };
    expect(await startComputeAgentGateway({ ...base, settings: testSettings() })).toBeUndefined();
    const warnings: string[] = [];
    const observability = {
      info: () => undefined,
      warn: (message: string) => void warnings.push(message),
    } as never;
    expect(
      await startComputeAgentGateway({
        ...base,
        observability,
        settings: testSettings({
          computeApiUrl: "https://fabric.test",
          computeApiKey: "k",
          computeLinkUrl: "http://not-a-websocket.test/link",
        }),
      }),
    ).toBeUndefined();
    expect(warnings).toEqual(["Opengeni compute agent gateway is not started"]);
    expect(connects).toBe(0);
  });
});
