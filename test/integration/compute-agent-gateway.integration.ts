// The compute AGENT GATEWAY over real wires: a real nats-server, the shared
// Postgres (sandbox enrollments, claims and epoch fences under RLS), a fake
// fabric serving the link keys, the gateway booted exactly as the API boots
// it, and a TypeScript host that speaks the host side of the agent link
// (compute/docs/agent-link.md). It proves that a worker's request over NATS
// reaches the sandbox's agent through its host's link and the answer comes
// back, that the gateway enforces the callout's subject permissions, fences
// sessions by owner epoch, refuses duplicates and bad tokens, ends a revoked
// sandbox's session, and releases claims when a session or link ends.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlRequest, ControlResponse, OpLostReason, OpState } from "@opengeni/agent-proto";
import { verifyRelayToken } from "@opengeni/contracts";
import {
  acquireLease,
  bootstrapWorkspace,
  commitWarmingToWarm,
  createDb,
  createSandboxEnrollment,
  createSession,
  settleConnectedMachineSessionBackgroundCommand,
  getLiveEnrollmentConnection,
  revokeSandboxEnrollment,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { recordConnectedCommandOutputConsumption } from "@opengeni/db/session-background-commands";
import { connect, createNatsEventBus, type NatsConnection } from "@opengeni/events";
import { NatsControlRpc } from "@opengeni/runtime/sandbox";
import {
  acquireSharedTestDatabase,
  freePort,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { releaseStoredConnectedCommandOutput } from "../../packages/core/src/sandbox/output-release";
import type { ApiWebSocketConnection } from "../../apps/api/src/api-websocket";
import { reconcileConnectedCommandOutputReleases } from "../../apps/worker/src/activities/sandbox-lease";
import type { GatewayFrame } from "../../apps/api/src/sandbox/compute-link-frames";
import { dispatchApiWebSocketUpgrade } from "../../apps/api/src/http/websocket-upgrade-dispatch";
import {
  startComputeAgentGateway,
  type ComputeGatewayHandle,
} from "../../apps/api/src/sandbox/compute-gateway-boot";
import {
  dialRefused,
  generateTestLinkKey,
  hostToken,
  sandboxTicket,
  TestComputeHostLink,
  type TestLinkKey,
} from "./helpers/compute-link-host";

const TEAM = "team-opengeni";
const API_KEY = "fabric-test-key";
const RELAY_SECRET = "compute-gateway-relay-secret";
const MAX_WS_MESSAGE = 8 * 1024 * 1024 + 64 * 1024;

type RunningNats = { url: string; stop: () => Promise<void> };

async function startPlainNats(): Promise<RunningNats> {
  const port = await freePort();
  const monitorPort = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "compute-gateway-nats-"));
  const configured = process.env.OPENGENI_NATS_SERVER_BIN ?? Bun.which("nats-server");
  const docker = Bun.which("docker");
  const containerName = `opengeni-compute-gateway-${crypto.randomUUID()}`;
  let command: string[];
  if (configured) {
    command = [configured, "-a", "127.0.0.1", "-p", String(port), "-m", String(monitorPort)];
  } else if (docker) {
    command = [
      docker,
      "run",
      "--rm",
      "--name",
      containerName,
      "--publish",
      `127.0.0.1:${port}:4222`,
      "--publish",
      `127.0.0.1:${monitorPort}:8222`,
      "nats:2.10.21-alpine",
      "-m",
      "8222",
    ];
  } else {
    throw new Error("the compute gateway integration needs nats-server or docker");
  }
  const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  const stop = async () => {
    if (!configured && docker) {
      await Bun.spawn([docker, "rm", "--force", containerName], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited.catch(() => undefined);
    }
    proc.kill();
    await proc.exited.catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${monitorPort}/healthz`);
      if (response.ok) return { url: `nats://127.0.0.1:${port}`, stop };
    } catch {
      // not up yet
    }
    await Bun.sleep(100);
  }
  await stop();
  throw new Error("nats-server did not become ready");
}

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let db: Database;
let nats: RunningNats;
let controlPlane: NatsConnection;
let key: TestLinkKey;
let fabric: ReturnType<typeof Bun.serve>;
let api: ReturnType<typeof Bun.serve<ApiWebSocketConnection>>;
let handle: ComputeGatewayHandle;
let linkUrl: string;
let keyReads = 0;
let gatewaySettings: ReturnType<typeof testSettings>;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

/** A compute sandbox's enrollment, as the provider creates it before the
 * fabric create. */
async function sandboxAgent() {
  const workspace = await freshWorkspace();
  const agentId = crypto.randomUUID();
  await createSandboxEnrollment(db, {
    ...workspace,
    enrollmentId: agentId,
    sandboxGroupId: crypto.randomUUID(),
    hasDisplay: false,
    workspaceRoot: "/workspace",
  });
  return { ...workspace, agentId, sandbox: `sbx-${agentId.slice(0, 8)}` };
}

async function linkAs(host: string, url = linkUrl): Promise<TestComputeHostLink> {
  // Every replica serves the one public link URL, the tokens' audience.
  return await TestComputeHostLink.connect(url, await hostToken(key, { audience: linkUrl, host }));
}

/** Serve an API replica: its own gateway and listener on the shared NATS and
 * database, as another API pod does. */
function serveGateway(routes: ComputeGatewayHandle["gateway"][], port = 0) {
  return Bun.serve<ApiWebSocketConnection>({
    hostname: "127.0.0.1",
    port,
    fetch: (request, server) => {
      const upgrade = dispatchApiWebSocketUpgrade(request, server, routes, null);
      if (upgrade.handled) return upgrade.response;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_WS_MESSAGE,
      open: (socket) => socket.data.attach(socket),
      message: (socket, message) => socket.data.receive(message),
      close: (socket) => socket.data.transportClosed(),
      ping: (socket) => socket.data.heard?.(),
      pong: (socket) => socket.data.heard?.(),
    },
  });
}

/** The agent side of a session: answer each request the host is handed
 * (null leaves it unanswered). */
function answerRequests(
  link: TestComputeHostLink,
  s: number,
  answer: (
    frame: Extract<GatewayFrame, { t: "msg" }>,
  ) => { payload: Uint8Array; headers?: Array<[string, string]> } | null,
): () => void {
  let index = 0;
  const timer = setInterval(() => {
    while (index < link.frames.length) {
      const frame = link.frames[index++]!;
      if (frame.t !== "msg" || frame.s !== s || !frame.reply) continue;
      const reply = answer(frame);
      if (reply) link.send({ t: "pub", s, subject: frame.reply, ...reply });
    }
  }, 5);
  return () => clearInterval(timer);
}

async function ticketFor(
  agent: { workspaceId: string; agentId: string; sandbox: string },
  input: { host: string; epoch: number; team?: string; audience?: string },
): Promise<string> {
  return await sandboxTicket(key, {
    audience: input.audience ?? linkUrl,
    sandbox: agent.sandbox,
    host: input.host,
    epoch: input.epoch,
    team: input.team ?? TEAM,
    workspaceId: agent.workspaceId,
    agentId: agent.agentId,
  });
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("compute-agent-gateway");
  if (!shared) {
    available = false;
    console.warn("[compute-agent-gateway] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
  nats = await startPlainNats();
  controlPlane = await connect({ servers: nats.url, name: "test-control-plane" });
  key = await generateTestLinkKey("k1");
  fabric = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (request.headers.get("x-api-key") !== API_KEY) {
        return Response.json({ code: "unauthorized", message: "bad key" }, { status: 401 });
      }
      if (new URL(request.url).pathname === "/v1/link/keys") {
        keyReads += 1;
        return Response.json({ team: TEAM, keys: [key.jwk] });
      }
      return Response.json({ code: "not_found", message: "no route" }, { status: 404 });
    },
  });
  const apiPort = await freePort();
  linkUrl = `ws://127.0.0.1:${apiPort}/v1/compute/agent-link`;
  const settings = testSettings({
    natsUrl: nats.url,
    computeApiUrl: `http://127.0.0.1:${fabric.port}`,
    computeApiKey: API_KEY,
    computeLinkUrl: linkUrl,
    selfhostedRelayUrl: "wss://relay.test/stream",
    selfhostedRelayTokenSecret: RELAY_SECRET,
    agentOpStreamEnabled: true,
  });
  const started = await startComputeAgentGateway({
    db,
    settings,
    natsAuth: undefined,
    maxWebSocketMessageBytes: MAX_WS_MESSAGE,
  });
  if (!started) throw new Error("the compute gateway did not start");
  handle = started;
  gatewaySettings = settings;
  api = serveGateway([handle.gateway], apiPort);
}, 180_000);

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  api?.stop(true);
  fabric?.stop(true);
  await controlPlane?.close().catch(() => undefined);
  await nats?.stop().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("compute agent gateway (real NATS, Postgres and WebSocket)", () => {
  test("a host link needs a valid host token for this gateway", async () => {
    if (!available) return;
    expect(await dialRefused(linkUrl, null)).toBe(true);
    expect(await dialRefused(linkUrl, "not-a-jwt")).toBe(true);
    const otherGateway = await hostToken(key, {
      audience: "wss://elsewhere.example/v1/compute/agent-link",
      host: "h1",
    });
    expect(await dialRefused(linkUrl, otherGateway)).toBe(true);
    const expired = await hostToken(key, { audience: linkUrl, host: "h1", ttlSeconds: -120 });
    expect(await dialRefused(linkUrl, expired)).toBe(true);
    const stranger = await generateTestLinkKey("unknown-kid");
    expect(
      await dialRefused(linkUrl, await hostToken(stranger, { audience: linkUrl, host: "h1" })),
    ).toBe(true);

    const link = await linkAs("h1");
    expect(link.protocol).toBe("opengeni.agent-link.v1");
    const hello = link.frames[0];
    expect(hello).toEqual({ t: "hello", version: 1, max_payload: expect.any(Number) });
    link.close();
  }, 30_000);

  test("a worker's request reaches the agent through the link and the answer comes back", async () => {
    if (!available) return;
    const agent = await sandboxAgent();
    const instance = crypto.randomUUID();
    const link = await linkAs("h1");
    const opened = await link.open({
      s: 1,
      sandbox: agent.sandbox,
      ticket: await ticketFor(agent, { host: "h1", epoch: 1 }),
      connection: instance,
    });
    const scope = `agent.${agent.workspaceId}.${agent.agentId}.connection.${instance}`;
    expect(opened).toMatchObject({ t: "opened", s: 1, scope });
    if (opened.t !== "opened") throw new Error("not opened");
    expect(opened.relay.url).toBe("wss://relay.test/stream");
    const relayClaims = await verifyRelayToken(RELAY_SECRET, opened.relay.token);
    expect(relayClaims).toMatchObject({ workspaceId: agent.workspaceId, agentId: agent.agentId });
    expect(opened.relay.expires_at_ms).toBeGreaterThan(Date.now() + 50 * 60_000);

    // The claim is live, so the control plane resolves the agent's instance.
    const live = await getLiveEnrollmentConnection(db, agent.workspaceId, agent.agentId);
    expect(live?.connectionInstanceId).toBe(instance);

    // The agent subscribes to its RPC subject; the host forwards that.
    link.send({ t: "sub", s: 1, sid: 7, subject: `${scope}.rpc` });
    // Let the subscription reach the server before the request.
    await Bun.sleep(100);
    const request = controlPlane.request(`${scope}.rpc`, new TextEncoder().encode("ping"), {
      timeout: 5_000,
    });
    const msg = await link.next((frame) => frame.t === "msg" && frame.s === 1);
    if (msg.t !== "msg") throw new Error("not a msg");
    expect(msg.sid).toBe(7);
    expect(msg.subject).toBe(`${scope}.rpc`);
    expect(new TextDecoder().decode(msg.payload)).toBe("ping");
    expect(msg.reply?.startsWith("_INBOX.")).toBe(true);
    link.send({
      t: "pub",
      s: 1,
      subject: msg.reply!,
      headers: [["Opengeni-Test", "yes"]],
      payload: new TextEncoder().encode("pong"),
    });
    const answer = await request;
    expect(new TextDecoder().decode(answer.data)).toBe("pong");
    expect(answer.headers?.get("Opengeni-Test")).toBe("yes");

    // Events the agent publishes within its scope reach the control plane.
    const events = controlPlane.subscribe(`${scope}.events`, { max: 1 });
    await controlPlane.flush();
    link.send({ t: "pub", s: 1, subject: `${scope}.events`, payload: new Uint8Array([1, 2]) });
    for await (const event of events) {
      expect([...event.data]).toEqual([1, 2]);
    }

    // Sleep is the host's business: a sleeping sandbox's session stays open.
    link.send({ t: "state", s: 1, state: "asleep" });
    await handle.gateway.tick();
    expect(await getLiveEnrollmentConnection(db, agent.workspaceId, agent.agentId)).not.toBeNull();

    // The host closes the session: its claim is released at once.
    link.send({ t: "close", s: 1 });
    await Bun.sleep(200);
    expect(await getLiveEnrollmentConnection(db, agent.workspaceId, agent.agentId)).toBeNull();
    link.close();
  }, 30_000);

  test("the gateway enforces the agent's subject permissions", async () => {
    if (!available) return;
    const agent = await sandboxAgent();
    const other = await sandboxAgent();
    const instance = crypto.randomUUID();
    const link = await linkAs("h1");
    await link.open({
      s: 1,
      sandbox: agent.sandbox,
      ticket: await ticketFor(agent, { host: "h1", epoch: 1 }),
      connection: instance,
    });
    const scope = `agent.${agent.workspaceId}.${agent.agentId}.connection.${instance}`;
    const otherScope = `agent.${other.workspaceId}.${other.agentId}.connection.${instance}`;
    const denied = [
      { t: "sub" as const, s: 1, sid: "a", subject: `${otherScope}.rpc` },
      { t: "sub" as const, s: 1, sid: "b", subject: "agent.>" },
      { t: "sub" as const, s: 1, sid: "c", subject: "_INBOX.>" },
      { t: "sub" as const, s: 1, sid: "d", subject: scope },
    ];
    for (const frame of denied) {
      link.send(frame);
      const error = await link.next((f) => f.t === "error" && f.sid === frame.sid);
      expect(error).toMatchObject({ t: "error", s: 1, code: "permission" });
    }
    const watcher = controlPlane.subscribe(`${otherScope}.events`);
    await controlPlane.flush();
    const before = link.frames.length;
    link.send({ t: "pub", s: 1, subject: `${otherScope}.events`, payload: new Uint8Array([9]) });
    await link.next((f) => f.t === "error" && f.code === "permission", 5_000, before);
    link.send({
      t: "pub",
      s: 1,
      subject: `${scope}.events`,
      reply: `${otherScope}.rpc`,
      payload: new Uint8Array([9]),
    });
    await link.next((f) => f.t === "error" && f.code === "permission", 5_000, before + 1);
    const big = new Uint8Array(handle.gateway.maxPayload + 1);
    link.send({ t: "pub", s: 1, subject: `${scope}.events`, payload: big });
    await link.next((f) => f.t === "error" && f.code === "too_large");
    await controlPlane.flush();
    expect(watcher.getProcessed()).toBe(0);
    watcher.unsubscribe();
    link.close();
  }, 30_000);

  test("owner epochs fence sessions: later supersedes, earlier is stale", async () => {
    if (!available) return;
    const agent = await sandboxAgent();
    const instance = crypto.randomUUID();
    const first = await linkAs("h1");
    expect(
      await first.open({
        s: 1,
        sandbox: agent.sandbox,
        ticket: await ticketFor(agent, { host: "h1", epoch: 3 }),
        connection: instance,
      }),
    ).toMatchObject({ t: "opened" });

    // The sandbox moved to h2 two epochs on; its agent kept its instance
    // across the memory restore.
    const second = await linkAs("h2");
    const closed = first.next((frame) => frame.t === "closed" && frame.s === 1);
    expect(
      await second.open({
        s: 1,
        sandbox: agent.sandbox,
        ticket: await ticketFor(agent, { host: "h2", epoch: 5 }),
        connection: instance,
      }),
    ).toMatchObject({ t: "opened" });
    expect(await closed).toMatchObject({ t: "closed", s: 1, code: "superseded" });
    const [row] = await shared!.admin<{ link_epoch: string }[]>`
      select link_epoch::text from enrollments where id = ${agent.agentId}`;
    expect(row?.link_epoch).toBe("5");

    // The old host, still holding epoch 3, cannot come back.
    expect(
      await first.open({
        s: 2,
        sandbox: agent.sandbox,
        ticket: await ticketFor(agent, { host: "h1", epoch: 3 }),
        connection: instance,
      }),
    ).toMatchObject({ t: "refused", code: "stale_epoch" });
    first.close();
    second.close();
  }, 30_000);

  test("a second live instance is a duplicate until the host closes the first", async () => {
    if (!available) return;
    const agent = await sandboxAgent();
    const link = await linkAs("h1");
    const ticket = await ticketFor(agent, { host: "h1", epoch: 1 });
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(
      await link.open({ s: 1, sandbox: agent.sandbox, ticket, connection: first }),
    ).toMatchObject({ t: "opened" });
    expect(
      await link.open({ s: 2, sandbox: agent.sandbox, ticket, connection: second }),
    ).toMatchObject({ t: "refused", code: "duplicate" });

    // The agent restarted: the host closes the old session, then opens the
    // new one, back to back on the same link. Frames are handled in order, so
    // the claim is released before the open.
    link.send({ t: "close", s: 1 });
    expect(
      await link.open({ s: 3, sandbox: agent.sandbox, ticket, connection: second }),
    ).toMatchObject({ t: "opened" });
    expect(
      (await getLiveEnrollmentConnection(db, agent.workspaceId, agent.agentId))
        ?.connectionInstanceId,
    ).toBe(second);
    link.close();
  }, 30_000);

  test("tickets must be for this gateway, host and team, and name a live agent", async () => {
    if (!available) return;
    const agent = await sandboxAgent();
    const link = await linkAs("h1");
    const connection = crypto.randomUUID();
    const cases: Array<[string, string]> = [
      [await ticketFor(agent, { host: "h2", epoch: 1 }), "invalid_ticket"],
      [await ticketFor(agent, { host: "h1", epoch: 1, team: "someone-else" }), "invalid_ticket"],
      [
        await ticketFor(agent, { host: "h1", epoch: 1, audience: "wss://elsewhere.example/x" }),
        "invalid_ticket",
      ],
      [
        await ticketFor({ ...agent, agentId: crypto.randomUUID() }, { host: "h1", epoch: 1 }),
        "unknown_agent",
      ],
    ];
    let s = 10;
    for (const [ticket, code] of cases) {
      s += 1;
      expect(await link.open({ s, sandbox: agent.sandbox, ticket, connection })).toMatchObject({
        t: "refused",
        s,
        code,
      });
    }
    // A ticket for one sandbox does not open another.
    expect(
      await link.open({
        s: 20,
        sandbox: "sbx-other",
        ticket: await ticketFor(agent, { host: "h1", epoch: 1 }),
        connection,
      }),
    ).toMatchObject({ t: "refused", code: "invalid_ticket" });
    // An unknown key id reads the keys again, rate-limited.
    const reads = keyReads;
    const stranger = await generateTestLinkKey("rotated-later");
    const strangerTicket = await sandboxTicket(stranger, {
      audience: linkUrl,
      sandbox: agent.sandbox,
      host: "h1",
      epoch: 1,
      team: TEAM,
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
    });
    expect(
      await link.open({ s: 21, sandbox: agent.sandbox, ticket: strangerTicket, connection }),
    ).toMatchObject({ t: "refused", code: "invalid_ticket" });
    expect(keyReads - reads).toBeLessThanOrEqual(1);
    link.close();
  }, 30_000);

  test("revoking the enrollment ends the session; a link's end releases its claims", async () => {
    if (!available) return;
    const revoked = await sandboxAgent();
    const kept = await sandboxAgent();
    const link = await linkAs("h1");
    for (const [s, agent] of [
      [1, revoked],
      [2, kept],
    ] as const) {
      expect(
        await link.open({
          s,
          sandbox: agent.sandbox,
          ticket: await ticketFor(agent, { host: "h1", epoch: 1 }),
          connection: crypto.randomUUID(),
        }),
      ).toMatchObject({ t: "opened" });
    }
    await revokeSandboxEnrollment(db, {
      workspaceId: revoked.workspaceId,
      enrollmentId: revoked.agentId,
    });
    const closed = link.next((frame) => frame.t === "closed" && frame.s === 1);
    await handle.gateway.tick();
    expect(await closed).toMatchObject({ code: "revoked" });
    expect(link.frames.some((frame) => frame.t === "closed" && frame.s === 2)).toBe(false);

    expect(await getLiveEnrollmentConnection(db, kept.workspaceId, kept.agentId)).not.toBeNull();
    link.close();
    await link.closed();
    await Bun.sleep(200);
    expect(await getLiveEnrollmentConnection(db, kept.workspaceId, kept.agentId)).toBeNull();
  }, 30_000);

  test("a request whose host link ends is delivered again through the replica the agent returns on", async () => {
    if (!available) return;
    // A second API replica on the same NATS and database.
    const second = await startComputeAgentGateway({
      db,
      settings: gatewaySettings,
      natsAuth: undefined,
      maxWebSocketMessageBytes: MAX_WS_MESSAGE,
    });
    if (!second) throw new Error("the second gateway did not start");
    const secondApi = serveGateway([second.gateway]);
    const stops: Array<() => void> = [];
    try {
      const agent = await sandboxAgent();
      const instance = crypto.randomUUID();
      const scope = `agent.${agent.workspaceId}.${agent.agentId}.connection.${instance}`;
      const subscribe = (link: TestComputeHostLink, s: number) => {
        link.send({ t: "sub", s, sid: 1, subject: `${scope}.rpc` });
        link.send({ t: "sub", s, sid: 2, subject: `${scope}.rpc.>` });
      };
      const pong = (frame: Extract<GatewayFrame, { t: "msg" }>, replay: boolean) => {
        const request = ControlRequest.decode(frame.payload);
        return {
          payload: ControlResponse.encode(
            ControlResponse.fromPartial({
              requestId: request.requestId,
              result: { $case: "ping", ping: {} },
            }),
          ).finish(),
          ...(replay
            ? { headers: [["Opengeni-Control-Replay", "1"]] as Array<[string, string]> }
            : {}),
        };
      };

      // The sandbox runs on host h1, linked to the first replica.
      const lost = await linkAs("h1");
      expect(
        await lost.open({
          s: 1,
          sandbox: agent.sandbox,
          ticket: await ticketFor(agent, { host: "h1", epoch: 1 }),
          connection: instance,
        }),
      ).toMatchObject({ t: "opened" });
      subscribe(lost, 1);
      // The agent answers the transport's capability probe; the request then
      // reaches the host, and the link ends before the agent answers it.
      const deliveredBeforeHandOff: string[] = [];
      stops.push(
        answerRequests(lost, 1, (frame) => {
          if (frame.subject === `${scope}.rpc`) return pong(frame, true);
          deliveredBeforeHandOff.push(frame.subject);
          return null;
        }),
      );
      await Bun.sleep(100);

      const rpc = new NatsControlRpc(async () => ({
        supportsHeaders: true,
        request: async (subject, payload, options) => {
          const message = await controlPlane.request(subject, payload, {
            timeout: options.timeout,
          });
          return { data: message.data, ...(message.headers ? { headers: message.headers } : {}) };
        },
      }));
      const startedAt = Date.now();
      // Far longer than the test: only the link's end can cut this short.
      const request = rpc.request(
        `${scope}.rpc`,
        ControlRequest.fromPartial({
          requestId: crypto.randomUUID(),
          op: { $case: "ping", ping: { nonce: "1" } },
        }),
        { timeoutMs: 60_000 },
      );
      const deadline = Date.now() + 5_000;
      while (deliveredBeforeHandOff.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(deliveredBeforeHandOff).toHaveLength(1);

      // The sandbox is handed over to host h2 (a hand-off keeps its memory, so
      // its agent keeps its connection): the link to the first replica ends,
      // and h2 links to the second replica.
      lost.close();
      await lost.closed();
      const handedOver = await linkAs(
        "h2",
        `ws://127.0.0.1:${secondApi.port}/v1/compute/agent-link`,
      );
      const deliveredAfterHandOff: string[] = [];
      stops.push(
        answerRequests(handedOver, 1, (frame) => {
          deliveredAfterHandOff.push(frame.subject);
          return pong(frame, frame.subject === `${scope}.rpc`);
        }),
      );
      expect(
        await handedOver.open({
          s: 1,
          sandbox: agent.sandbox,
          ticket: await ticketFor(agent, { host: "h2", epoch: 2 }),
          connection: instance,
        }),
      ).toMatchObject({ t: "opened" });
      subscribe(handedOver, 1);

      const response = await request;
      expect(response.error).toBeUndefined();
      expect(response.result?.$case).toBe("ping");
      // The same delivery, so the agent's journal would join a duplicate.
      expect(deliveredAfterHandOff).toEqual([deliveredBeforeHandOff[0]]);
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      handedOver.close();
    } finally {
      for (const stop of stops) stop();
      await second.close().catch(() => undefined);
      secondApi.stop(true);
    }
  }, 60_000);

  test("a finished command's output is released in one exchange through the link, and housekeeping never reaches the sleeping sandbox", async () => {
    if (!available) return;
    // The release where the output is stored, and the reaper's recovery, over
    // the real NATS bus.
    const bus = await createNatsEventBus(nats.url);
    const stops: Array<() => void> = [];
    try {
      const id = crypto.randomUUID();
      const access = await bootstrapWorkspace(db, {
        accountExternalSource: "test",
        accountExternalId: id,
        accountName: "Release",
        workspaceExternalSource: "test",
        workspaceExternalId: id,
        workspaceName: "Release",
        subjectId: `subject-${id}`,
      });
      const { accountId, workspaceId } = access.workspaceGrants[0]!;
      const session = await createSession(db, {
        accountId,
        workspaceId: workspaceId!,
        initialMessage: "Release",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "compute",
      });
      const agent = {
        workspaceId: workspaceId!,
        agentId: crypto.randomUUID(),
        sandbox: `sbx-${id.slice(0, 8)}`,
      };
      const group = {
        accountId,
        workspaceId: workspaceId!,
        sandboxGroupId: session.sandboxGroupId,
      };
      await acquireLease(db, {
        ...group,
        kind: "turn",
        holderId: `turn-${id}`,
        backend: "compute",
        leaseTtlMs: 45_000,
      });
      await commitWarmingToWarm(db, {
        ...group,
        expectedEpoch: 0,
        instanceId: agent.sandbox,
        leaseTtlMs: 45_000,
      });
      await createSandboxEnrollment(db, {
        accountId,
        workspaceId: workspaceId!,
        enrollmentId: agent.agentId,
        sandboxGroupId: session.sandboxGroupId,
        hasDisplay: false,
        workspaceRoot: "/workspace",
      });
      const instance = crypto.randomUUID();
      const scope = `agent.${agent.workspaceId}.${agent.agentId}.connection.${instance}`;
      const link = await linkAs("h1");
      expect(
        await link.open({
          s: 1,
          sandbox: agent.sandbox,
          ticket: await ticketFor(agent, { host: "h1", epoch: 1 }),
          connection: instance,
        }),
      ).toMatchObject({ t: "opened" });
      expect(
        (await getLiveEnrollmentConnection(db, agent.workspaceId, agent.agentId))
          ?.connectionInstanceId,
      ).toBe(instance);
      // The agent's Hello advertised OpRelease.
      await shared!
        .admin`update enrollments set agent_capabilities=${JSON.stringify({ opRelease: true })}::jsonb where id=${agent.agentId}`;
      // The runner's subscriptions: its RPC subject, replayable deliveries under
      // it, and final ACKs.
      link.send({ t: "sub", s: 1, sid: 7, subject: `${scope}.rpc` });
      link.send({ t: "sub", s: 1, sid: 8, subject: `${scope}.ack` });
      link.send({ t: "sub", s: 1, sid: 9, subject: `${scope}.rpc.>` });
      await Bun.sleep(100);

      // The agent: it keeps each op's output through its exit frame (seq 2)
      // until a release for exactly that frame, which it confirms in its
      // answer; a released op answers released from then on.
      const released = new Set<string>();
      const requests: string[] = [];
      stops.push(
        answerRequests(link, 1, (frame) => {
          if (frame.sid !== 7 && frame.sid !== 9) return null;
          const request = ControlRequest.decode(frame.payload);
          // The transport's replay negotiation.
          if (request.op?.$case === "ping")
            return {
              payload: ControlResponse.encode(
                ControlResponse.fromPartial({
                  requestId: request.requestId,
                  result: { $case: "ping", ping: {} },
                }),
              ).finish(),
              headers: [["Opengeni-Control-Replay", "1"]],
            };
          requests.push(request.op?.$case ?? "none");
          if (request.op?.$case !== "opRelease") return null;
          const { opId, exitSeq } = request.op.opRelease;
          if (exitSeq === "2") released.add(opId);
          return {
            payload: ControlResponse.encode(
              ControlResponse.fromPartial({
                requestId: request.requestId,
                result: {
                  $case: "opStatus",
                  opStatus: released.has(opId)
                    ? {
                        opId,
                        state: OpState.OP_STATE_LOST,
                        lostReason: OpLostReason.OP_LOST_REASON_RELEASED,
                      }
                    : {
                        opId,
                        state: OpState.OP_STATE_COMPLETE,
                        nextSeq: "3",
                        exit: { exitCode: 0, durationMs: "5", digests: {}, totals: {} },
                      },
                },
              }),
            ).finish(),
          };
        }),
      );

      // Background commands that exited, their output durably stored.
      const stored = async (commandId: string) =>
        (await shared!.admin`select * from session_background_commands where id=${commandId}`)[0]!;
      const consumed = async () => {
        const commandId = crypto.randomUUID();
        const identity = {
          accountId,
          workspaceId: workspaceId!,
          sessionId: session.id,
          commandId,
          controlWorkspaceId: workspaceId!,
          enrollmentId: agent.agentId,
          connectionInstanceId: instance,
          opId: `op-${commandId}`,
        };
        await shared!
          .admin`insert into session_background_commands(id,account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id,reconcile_after)
          values (${commandId},${accountId},${workspaceId!},${session.id},'connected_machine','running',${workspaceId!},${agent.agentId},${instance},${identity.opId},'2000-01-01T00:00:00Z'::timestamptz)`;
        await settleConnectedMachineSessionBackgroundCommand(db, {
          ...identity,
          outcome: "exited",
          exitCode: 0,
          reason: "op_exit",
        });
        await recordConnectedCommandOutputConsumption(db, {
          ...identity,
          receipt: { exitSeq: "2", attachGeneration: "1" },
          exitCode: 0,
        });
        return identity;
      };
      const due = async () =>
        shared!
          .admin`update session_background_commands set reconcile_after='2000-01-01T00:00:00Z'::timestamptz,reconcile_claim_id=null,reconcile_claimed_at=null where session_id=${session.id}`;
      const asleepSince = async () =>
        (
          await shared!.admin<{ compute_asleep_since: Date | null }[]>`
            select compute_asleep_since from sandbox_leases
            where workspace_id=${workspaceId!} and sandbox_group_id=${session.sandboxGroupId}`
        )[0]!.compute_asleep_since;
      const power = async (state: "asleep" | "awake") => {
        link.send({ t: "state", s: 1, state });
        const deadline = Date.now() + 5_000;
        while (((await asleepSince()) === null) !== (state === "awake")) {
          if (Date.now() > deadline) throw new Error(`the gateway did not record ${state}`);
          await Bun.sleep(20);
        }
      };
      const reaper = () =>
        reconcileConnectedCommandOutputReleases(
          db,
          { sandboxLeaseReaperPeriodMs: 30_000, sandboxSelfhostedControlTimeoutMs: 2_000 } as never,
          { incrementCounter: () => {}, warn: () => {} } as never,
          bus as never,
        );
      const forwarded = (from: number) =>
        link.frames.slice(from).filter((frame) => frame.t === "msg" && frame.s === 1);
      const acks = () =>
        link.frames.filter((frame) => frame.t === "msg" && frame.s === 1 && frame.sid === 8);

      // Where the output is stored, while the agent is live from the command:
      // one OpRelease, answered, and the release is settled from that answer.
      const live = await consumed();
      let mark = link.frames.length;
      expect(
        await releaseStoredConnectedCommandOutput(db, {
          command: live,
          exitSeq: "2",
          controlRpc: new NatsControlRpc(async () => bus.getRequestConnection()),
          controlTimeoutMs: 2_000,
        }),
      ).toBe("released");
      expect(requests).toEqual(["opRelease"]);
      const settled = await stored(live.commandId);
      expect(settled.output_release_observed_at).toBeInstanceOf(Date);
      expect(settled.last_reconcile_outcome).toBe("output_released");
      expect(settled.reconcile_attempts).toBe(0);

      // The sandbox sleeps: housekeeping passes send it nothing at all.
      await power("asleep");
      for (let pass = 0; pass < 3; pass++) {
        await due();
        mark = link.frames.length;
        await reaper();
        await Bun.sleep(100);
        expect(forwarded(mark)).toEqual([]);
      }
      expect((await stored(live.commandId)).reconcile_attempts).toBe(0);

      // A process died between storing an output and releasing it: the reaper
      // recovers that release once. Reaching the sleeping sandbox is real work
      // (one wake), and the answer settles it in that one exchange.
      const orphan = await consumed();
      requests.length = 0;
      mark = link.frames.length;
      await reaper();
      expect(requests).toEqual(["opRelease"]);
      const recovered = await stored(orphan.commandId);
      expect(recovered.output_release_observed_at).toBeInstanceOf(Date);
      expect(recovered.output_unavailable_at).toBeNull();
      expect(recovered.last_reconcile_outcome).toBe("output_released");
      expect(recovered.reconcile_attempts).toBe(1);

      // Nothing is left to poll: later passes send nothing.
      for (let pass = 0; pass < 3; pass++) {
        await due();
        mark = link.frames.length;
        await reaper();
        await Bun.sleep(100);
        expect(forwarded(mark)).toEqual([]);
      }
      // No final ACK was ever sent: the release needs none.
      expect(acks()).toEqual([]);
      link.close();
    } finally {
      for (const stop of stops) stop();
      await bus.close().catch(() => undefined);
    }
  }, 60_000);

  test("a text frame or a malformed frame ends the link", async () => {
    if (!available) return;
    const link = await linkAs("h1");
    link.sendRaw("hello");
    expect((await link.closed()).code).toBe(4400);
    const second = await linkAs("h1");
    second.sendRaw(new TextEncoder().encode('{"t":"nonsense","s":1}\n'));
    expect((await second.closed()).code).toBe(4400);
  }, 30_000);
});
