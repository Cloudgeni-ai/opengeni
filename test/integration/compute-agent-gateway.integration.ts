// The compute AGENT GATEWAY over real wires: a real nats-server, the shared
// Postgres (sandbox enrollments, claims and epoch fences under RLS), a fake
// control service serving the link keys, the gateway booted exactly as the API boots
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
import {
  AgentEvent,
  AgentEventAck,
  ControlRequest,
  ControlResponse,
  ErrorCode,
  Hello,
  OpLostReason,
  OpState,
} from "@opengeni/agent-proto";
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
import {
  CONNECTED_COMMAND_CLAIM_TTL_MS,
  claimConnectedCommandOutputReleases,
  recordConnectedCommandOutputConsumption,
} from "@opengeni/db/session-background-commands";
import { connect, createNatsEventBus, type NatsConnection } from "@opengeni/events";
import { AGENT_UNANSWERED_HEADER, NatsControlRpc, NO_WAKE_HEADER } from "@opengeni/runtime/sandbox";
import {
  acquireSharedTestDatabase,
  freePort,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { releaseStoredConnectedCommandOutput } from "../../packages/core/src/sandbox/output-release";
import {
  ComputeAgentIncompatibleError,
  createComputeAgentPlane,
} from "../../packages/core/src/sandbox/compute-plane";
import { handleHelloPayload } from "../../apps/api/src/sandbox/metrics-ingestion";
import type { ApiWebSocketConnection } from "../../apps/api/src/api-websocket";
import {
  reconcileConnectedCommandOutputReleases,
  reconcileConnectedMachineBackgroundCommands,
  releaseClaimedConnectedCommandOutput,
} from "../../apps/worker/src/activities/sandbox-lease";
import type { GatewayFrame } from "../../apps/api/src/sandbox/compute-link-frames";
import { handleAgentEventPayload } from "../../apps/api/src/sandbox/metrics-ingestion";
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
const API_KEY = "control-test-key";
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
let control: ReturnType<typeof Bun.serve>;
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
 * control service create. */
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
  control = Bun.serve({
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
    computeApiUrl: `http://127.0.0.1:${control.port}`,
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
  control?.stop(true);
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

  async function handoff(replayVersion: 1 | 2) {
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
      const tokens = Array.from({ length: 64 }, () => crypto.randomUUID());
      const subscribe = (link: TestComputeHostLink, s: number) => {
        link.send({ t: "sub", s, sid: 1, subject: `${scope}.rpc` });
        link.send({ t: "sub", s, sid: 2, subject: `${scope}.rpc.>` });
      };
      const pong = (frame: Extract<GatewayFrame, { t: "msg" }>) => {
        const request = ControlRequest.decode(frame.payload);
        if (request.op?.$case !== "ping") throw new Error("expected a ping request");
        const ping = request.op.ping;
        return {
          payload: ControlResponse.encode(
            ControlResponse.fromPartial({
              requestId: request.requestId,
              result: {
                $case: "ping",
                ping: {
                  nonce: ping.nonce,
                  controlReplayTokens:
                    replayVersion === 2 && ping.controlReplayWindowMs !== "0" ? tokens : [],
                },
              },
            }),
          ).finish(),
          headers: [["Opengeni-Control-Replay", String(replayVersion)]] as Array<[string, string]>,
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
      const deliveredBeforeHandOff: Array<{ subject: string; payload: Uint8Array }> = [];
      stops.push(
        answerRequests(lost, 1, (frame) => {
          const request = ControlRequest.decode(frame.payload);
          // Both versions negotiate on the base subject; a v1 operation also
          // uses that subject, so distinguish the batch probe by its payload.
          if (request.op?.$case === "ping" && request.op.ping.controlReplayWindowMs !== "0")
            return pong(frame);
          deliveredBeforeHandOff.push({ subject: frame.subject, payload: frame.payload });
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
      if (replayVersion === 2) {
        expect(
          deliveredBeforeHandOff[0]!.subject.startsWith(`${scope}.rpc.replay.${tokens[0]}.`),
        ).toBe(true);
      } else {
        expect(deliveredBeforeHandOff[0]!.subject).toBe(`${scope}.rpc`);
      }

      // The sandbox is handed over to host h2 (a hand-off keeps its memory, so
      // its agent keeps its connection): the link to the first replica ends,
      // and h2 links to the second replica.
      lost.close();
      await lost.closed();
      const handedOver = await linkAs(
        "h2",
        `ws://127.0.0.1:${secondApi.port}/v1/compute/agent-link`,
      );
      const deliveredAfterHandOff: Array<{ subject: string; payload: Uint8Array }> = [];
      stops.push(
        answerRequests(handedOver, 1, (frame) => {
          deliveredAfterHandOff.push({ subject: frame.subject, payload: frame.payload });
          return pong(frame);
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
      if (replayVersion === 2) {
        expect(response.error).toBeUndefined();
        expect(response.result).toMatchObject({ $case: "ping", ping: { nonce: "1" } });
        // The same identity, timing and payload, so the journal joins a duplicate.
        expect(deliveredAfterHandOff).toEqual([deliveredBeforeHandOff[0]!]);
      } else {
        // An old-wire v1 peer is deliberately one-shot. Losing its link does
        // not prove non-execution, and must not cause another delivery.
        expect(response.error?.code).toBe(ErrorCode.ERROR_CODE_TIMEOUT);
        expect(response.error?.detail ?? {}).not.toHaveProperty("_never_sent");
        await Bun.sleep(300);
        expect(deliveredAfterHandOff).toEqual([]);
        expect(deliveredBeforeHandOff).toHaveLength(1);
      }
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      handedOver.close();
    } finally {
      for (const stop of stops) stop();
      await second.close().catch(() => undefined);
      secondApi.stop(true);
    }
  }

  test("a request whose host link ends is delivered again through the replica the agent returns on", async () => {
    await handoff(2);
  }, 60_000);

  test("a legacy v1 request whose host link ends is never redelivered after handoff", async () => {
    await handoff(1);
  }, 60_000);

  test("a finished command's output is released in one exchange through the link, housekeeping never reaches the sleeping sandbox, and the agent's own inventory recovers the rest", async () => {
    if (!available) return;
    // The release where the output is stored, housekeeping, and the agent's
    // inventory answered by the API's event ingestion, over the real NATS bus.
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

      // The host, as compute-link behaves: while the sandbox sleeps, it
      // answers a no-wake request itself ("asleep") and the agent never gets
      // it; any other request would wake the sandbox, and is recorded.
      let hostAsleep = false;
      const woke: string[] = [];
      // The agent: it keeps each op's output through its exit frame (seq 2)
      // until a release for exactly that frame, which it confirms in its
      // answer; a released op answers released from then on.
      const released = new Set<string>();
      const requests: string[] = [];
      stops.push(
        answerRequests(link, 1, (frame) => {
          if (frame.sid !== 7 && frame.sid !== 9) return null;
          if (hostAsleep) {
            if (frame.headers?.some(([name, value]) => name === NO_WAKE_HEADER && value === "1"))
              return { payload: new Uint8Array(0), headers: [[AGENT_UNANSWERED_HEADER, "asleep"]] };
            woke.push(frame.subject);
          }
          const request = ControlRequest.decode(frame.payload);
          // Deliberately a legacy v1 peer: output release stays one-shot.
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
          // This agent cannot replay output: any other request is refused.
          if (request.op?.$case !== "opRelease")
            return {
              payload: ControlResponse.encode(
                ControlResponse.fromPartial({
                  requestId: request.requestId,
                  result: {
                    $case: "error",
                    error: { code: ErrorCode.ERROR_CODE_OS, message: "refused", retryable: false },
                  },
                }),
              ).finish(),
            };
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
      const exited = async () => {
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
        return identity;
      };
      const store = async (identity: Awaited<ReturnType<typeof exited>>) =>
        await recordConnectedCommandOutputConsumption(db, {
          ...identity,
          receipt: { exitSeq: "2", attachGeneration: "1" },
          exitCode: 0,
        });
      const consumed = async () => {
        const identity = await exited();
        await store(identity);
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
        hostAsleep = state === "asleep";
        link.send({ t: "state", s: 1, state });
        const deadline = Date.now() + 5_000;
        while (((await asleepSince()) === null) !== (state === "awake")) {
          if (Date.now() > deadline) throw new Error(`the gateway did not record ${state}`);
          await Bun.sleep(20);
        }
      };
      const reaperSettings = {
        sandboxLeaseReaperPeriodMs: 30_000,
        sandboxSelfhostedControlTimeoutMs: 2_000,
      } as never;
      const reaperObservability = { incrementCounter: () => {}, warn: () => {} } as never;
      const reaper = () =>
        reconcileConnectedCommandOutputReleases(
          db,
          reaperSettings,
          reaperObservability,
          bus as never,
        );
      const commandReconciler = () =>
        reconcileConnectedMachineBackgroundCommands(
          db,
          reaperSettings,
          reaperObservability,
          bus as never,
        );
      const forwarded = (from: number) =>
        link.frames.slice(from).filter((frame) => frame.t === "msg" && frame.s === 1);
      const acks = () =>
        link.frames.filter((frame) => frame.t === "msg" && frame.s === 1 && frame.sid === 8);

      // The API's agent-event ingestion, answering on the op-stream
      // connection exactly as the API process does.
      const events = controlPlane.subscribe(`${scope}.events`);
      void (async () => {
        for await (const message of events)
          await handleAgentEventPayload(db, undefined, message.data, message.subject, bus);
      })();
      stops.push(() => events.unsubscribe());
      /** The agent reports completed ops (with how long ago they completed)
       * and reads the answer off its ack subscription. */
      let reportId = 0;
      const report = async (operations: string[]) => {
        reportId += 1;
        const answered = link.next(
          (frame) => frame.t === "msg" && frame.s === 1 && frame.sid === 8,
          5_000,
        );
        link.send({
          t: "pub",
          s: 1,
          subject: `${scope}.events`,
          payload: AgentEvent.encode({
            agentId: "",
            event: {
              $case: "operationInventory",
              operationInventory: {
                reportId: String(reportId),
                page: 0,
                pages: 1,
                operations: operations.map((opId) => ({
                  opId,
                  connectionGeneration: "1",
                  complete: true,
                })),
              },
            },
          }).finish(),
        });
        const frame = (await answered) as Extract<GatewayFrame, { t: "msg" }>;
        expect(frame.reply).toBeUndefined();
        const ack = AgentEventAck.decode(frame.payload).ack;
        if (ack?.$case !== "operationInventory") throw new Error("not an inventory answer");
        expect(ack.operationInventory.reportId).toBe(String(reportId));
        return ack.operationInventory.endOpIds;
      };
      const passesSendNothing = async () => {
        for (let pass = 0; pass < 3; pass++) {
          await due();
          const mark = link.frames.length;
          await reaper();
          await commandReconciler();
          await Bun.sleep(100);
          expect(forwarded(mark)).toEqual([]);
        }
      };

      // Where the output is stored, while the agent is live from the command:
      // one OpRelease, answered, and the release is settled from that answer.
      const live = await consumed();
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
      expect(settled.reconcile_claim_id).toBeNull();

      // A housekeeping pass claims an obligation, the storing process releases
      // it, the sandbox sleeps, and the pass goes on with its claim: it sends
      // nothing, as housekeeping never sends a compute sandbox anything.
      const raced = await consumed();
      await due();
      const reaperClaim = (
        await claimConnectedCommandOutputReleases(db, {
          claimId: crypto.randomUUID(),
          limit: 100,
          claimTtlMs: CONNECTED_COMMAND_CLAIM_TTL_MS,
        })
      ).find((claim) => claim.commandId === raced.commandId);
      expect(reaperClaim).toBeDefined();
      requests.length = 0;
      expect(
        await releaseStoredConnectedCommandOutput(db, {
          command: raced,
          exitSeq: "2",
          controlRpc: new NatsControlRpc(async () => bus.getRequestConnection()),
          controlTimeoutMs: 2_000,
        }),
      ).toBe("released");
      expect(requests).toEqual(["opRelease"]);
      await power("asleep");
      const mark = link.frames.length;
      await releaseClaimedConnectedCommandOutput(
        {
          db,
          settings: reaperSettings,
          observability: reaperObservability,
          bus: bus as never,
          controlRpc: new NatsControlRpc(async () => bus.getRequestConnection()),
        },
        reaperClaim!,
      );
      await Bun.sleep(100);
      expect(forwarded(mark)).toEqual([]);
      expect((await stored(raced.commandId)).output_release_observed_at).toBeInstanceOf(Date);

      // The sandbox fell asleep just as another output was stored. Its
      // release goes out without waking, over the real bus with its header:
      // the host answers it itself, the agent never gets it, and nothing is
      // recorded. The agent's own inventory releases it later.
      const dozed = await consumed();
      requests.length = 0;
      const dozedMark = link.frames.length;
      expect(
        await releaseStoredConnectedCommandOutput(db, {
          command: dozed,
          exitSeq: "2",
          controlRpc: new NatsControlRpc(async () => bus.getRequestConnection()),
          controlTimeoutMs: 2_000,
        }),
      ).toBe("not_answered");
      const dozedFrames = forwarded(dozedMark) as Array<Extract<GatewayFrame, { t: "msg" }>>;
      expect(dozedFrames).toHaveLength(1);
      expect(dozedFrames[0]!.headers).toContainEqual([NO_WAKE_HEADER, "1"]);
      expect(requests).toEqual([]);
      expect((await stored(dozed.commandId)).output_release_observed_at).toBeNull();

      // Its agent pushed a command's completion, and the process collecting
      // it died. Housekeeping recovers it once, without waking: the host
      // answers "asleep", nothing is recorded, and the command is left to
      // the agent, so later passes send nothing at all.
      const pushedId = crypto.randomUUID();
      const pushedOp = `op-${pushedId}`;
      await shared!
        .admin`insert into session_background_commands(id,account_id,workspace_id,session_id,provider,state,control_workspace_id,enrollment_id,connection_instance_id,op_id,reconcile_after,completion_notified_at)
        values (${pushedId},${accountId},${workspaceId!},${session.id},'connected_machine','running',${workspaceId!},${agent.agentId},${instance},${pushedOp},'2000-01-01T00:00:00Z'::timestamptz,now())`;
      const recoveryMark = link.frames.length;
      await commandReconciler();
      await Bun.sleep(100);
      const recovery = forwarded(recoveryMark) as Array<Extract<GatewayFrame, { t: "msg" }>>;
      expect(recovery).toHaveLength(1);
      expect(ControlRequest.decode(recovery[0]!.payload).op?.$case).toBe("opQuery");
      expect(recovery[0]!.headers).toContainEqual([NO_WAKE_HEADER, "1"]);
      expect(requests).toEqual([]);
      const leftToAgent = await stored(pushedId);
      expect(leftToAgent.state).toBe("running");
      expect(leftToAgent.last_reconcile_outcome).toBe("provider_unanswered");
      expect(leftToAgent.completion_notified_at).toBeNull();

      // One process died between storing an output and releasing it, another
      // between a command's exit and storing its output. While the sandbox
      // sleeps, housekeeping passes send it nothing at all.
      const orphan = await consumed();
      const unstored = await exited();
      requests.length = 0;
      await passesSendNothing();
      expect(requests).toEqual([]);
      expect((await stored(orphan.commandId)).output_release_observed_at).toBeNull();
      expect((await stored(unstored.commandId)).output_consumed_at).toBeNull();

      // The agent wakes for its own work and, holding completed output nobody
      // released for a while, reports its inventory again. In that same
      // exchange the answer ends the stored output (and the release is
      // recorded) and keeps the output Opengeni never stored, which it starts
      // collecting while the agent talks (this agent refuses to replay it).
      await power("awake");
      expect(await report([orphan.opId, dozed.opId, unstored.opId])).toEqual([
        orphan.opId,
        dozed.opId,
      ]);
      expect((await stored(dozed.commandId)).output_release_observed_at).toBeInstanceOf(Date);
      const recovered = await stored(orphan.commandId);
      expect(recovered.output_release_observed_at).toBeInstanceOf(Date);
      expect(recovered.output_unavailable_at).toBeNull();
      expect(recovered.last_reconcile_outcome).toBe("output_released");
      const collectDeadline = Date.now() + 10_000;
      while (
        requests.length === 0 ||
        (await stored(unstored.commandId)).reconcile_claim_id !== null
      ) {
        if (Date.now() > collectDeadline) throw new Error("the collection did not finish");
        await Bun.sleep(50);
      }
      expect(requests).not.toContain("opRelease");
      const kept = await stored(unstored.commandId);
      expect(kept.output_consumed_at).toBeNull();
      expect(kept.output_unavailable_at).toBeNull();
      expect(kept.output_release_observed_at).toBeNull();

      // Once that output is stored, the next report ends it too.
      await store(unstored);
      expect(await report([unstored.opId])).toEqual([unstored.opId]);
      expect((await stored(unstored.commandId)).output_release_observed_at).toBeInstanceOf(Date);

      // The agent's report of the pushed command takes over its recovery
      // while it talks: its exit is collected (this agent refuses to replay,
      // so the collection is only attempted), and the command stays running.
      requests.length = 0;
      expect(await report([pushedOp])).toEqual([]);
      const pushedDeadline = Date.now() + 10_000;
      while (!requests.includes("opAttach")) {
        if (Date.now() > pushedDeadline) throw new Error("the report did not collect");
        await Bun.sleep(50);
      }
      expect((await stored(pushedId)).state).toBe("running");
      await shared!.admin`delete from session_background_commands where id=${pushedId}`;

      // Nothing is left: later passes send nothing, awake or asleep, and
      // Opengeni never sent a final ACK (the agent's ack subscription carried
      // only the two inventory answers).
      requests.length = 0;
      await passesSendNothing();
      await power("asleep");
      await passesSendNothing();
      expect(requests).toEqual([]);
      expect(acks()).toHaveLength(3);
      // No request ever woke the sleeping sandbox.
      expect(woke).toEqual([]);
      link.close();
    } finally {
      for (const stop of stops) stop();
      await bus.close().catch(() => undefined);
    }
  }, 60_000);

  test("a compute agent without OpRelease is refused as an image built with an older agent", async () => {
    if (!available) return;
    const bus = await createNatsEventBus(nats.url);
    try {
      const agent = await sandboxAgent();
      const instance = crypto.randomUUID();
      const link = await linkAs("h1");
      expect(
        await link.open({
          s: 1,
          sandbox: agent.sandbox,
          ticket: await ticketFor(agent, { host: "h1", epoch: 1 }),
          connection: instance,
        }),
      ).toMatchObject({ t: "opened" });
      const subject = `agent.${agent.workspaceId}.${agent.agentId}.connection.${instance}.hello`;
      const hello = (opRelease: boolean) =>
        Hello.encode(
          Hello.fromPartial({
            agentId: agent.agentId,
            workspaceId: agent.workspaceId,
            agentVersion: "0.0.1",
            capabilities: { exec: true, opStream: true, opRelease },
          }),
        ).finish();
      const errors: string[] = [];
      const observability = {
        warn: () => {},
        error: (message: string) => errors.push(message),
      } as never;
      const plane = createComputeAgentPlane({
        db,
        bus,
        settings: { agentOpStreamEnabled: true },
      });
      const resolve = () =>
        plane.resolveConnection({ workspaceId: agent.workspaceId, enrollmentId: agent.agentId });
      // Before its Hello nothing is known, and nothing is refused.
      expect((await resolve())?.connectionInstanceId).toBe(instance);

      // An agent without OpRelease: a version error at its Hello, and the
      // sandbox is refused rather than released by polling.
      await handleHelloPayload(db, observability, hello(false), subject);
      expect(errors).toEqual([expect.stringContaining("capabilities.op_release")]);
      await expect(resolve()).rejects.toBeInstanceOf(ComputeAgentIncompatibleError);

      // An agent from this release is served.
      errors.length = 0;
      await handleHelloPayload(db, observability, hello(true), subject);
      expect(errors).toEqual([]);
      expect((await resolve())?.connectionInstanceId).toBe(instance);
      link.close();
    } finally {
      await bus.close().catch(() => undefined);
    }
  }, 30_000);

  test("a returning agent's operation inventory is answered through the link with what it should end, and the answer never wakes the sandbox", async () => {
    if (!available) return;
    // The API's agent-event ingestion over the real NATS bus, answering on
    // the op-stream connection exactly as the API process does.
    const bus = await createNatsEventBus(nats.url);
    const events = controlPlane.subscribe("agent.*.*.connection.*.events");
    const ingesting = (async () => {
      for await (const message of events) {
        await handleAgentEventPayload(db, undefined, message.data, message.subject, bus);
      }
    })();
    try {
      const agent = await sandboxAgent();
      const link = await linkAs("h1");
      const generation = async () =>
        (
          await shared!.admin<{ connection_generation: number }[]>`
            select connection_generation from enrollments where id = ${agent.agentId}`
        )[0]!.connection_generation;
      const open = async (s: number, connection: string) => {
        expect(
          await link.open({
            s,
            sandbox: agent.sandbox,
            ticket: await ticketFor(agent, { host: "h1", epoch: 1 }),
            connection,
          }),
        ).toMatchObject({ t: "opened" });
        const scope = `agent.${agent.workspaceId}.${agent.agentId}.connection.${connection}`;
        link.send({ t: "sub", s, sid: 8, subject: `${scope}.ack` });
        await Bun.sleep(100);
        return scope;
      };
      /** The agent reports one page and reads the answer off its ack sid. */
      const report = async (
        s: number,
        scope: string,
        reportId: string,
        operations: Array<[opId: string, startedOn: number]>,
      ) => {
        const answered = link.next(
          (frame) => frame.t === "msg" && frame.s === s && frame.sid === 8,
          5_000,
        );
        link.send({
          t: "pub",
          s,
          subject: `${scope}.events`,
          payload: AgentEvent.encode({
            agentId: "",
            event: {
              $case: "operationInventory",
              operationInventory: {
                reportId,
                page: 0,
                pages: 1,
                operations: operations.map(([opId, startedOn]) => ({
                  opId,
                  connectionGeneration: String(startedOn),
                  complete: false,
                })),
              },
            },
          }).finish(),
        });
        const frame = (await answered) as Extract<GatewayFrame, { t: "msg" }>;
        // A plain message, never a request: the host delivers it when the
        // agent next runs and never wakes a sleeping sandbox for it.
        expect(frame.reply).toBeUndefined();
        expect(frame.subject).toBe(`${scope}.ack`);
        const ack = AgentEventAck.decode(frame.payload).ack;
        if (ack?.$case !== "operationInventory") throw new Error("not an inventory answer");
        return ack.operationInventory;
      };

      // old: the agent's first connection (generation 1).
      const oldInstance = crypto.randomUUID();
      const oldScope = await open(1, oldInstance);
      expect(await generation()).toBe(1);
      // Each op carries the generation its OpStart was dispatched under.
      expect(await report(1, oldScope, "1", [["old-op", 1]])).toEqual({
        reportId: "1",
        page: 0,
        endOpIds: [],
      });

      // new: another process holds the sandbox's connection (generation 2).
      link.send({ t: "close", s: 1 });
      const newInstance = crypto.randomUUID();
      const newScope = await open(2, newInstance);
      expect(await generation()).toBe(2);
      expect((await report(2, newScope, "1", [["new-op", 2]])).endOpIds).toEqual([]);

      // old again (generation 3): what it started on generation 1 is ended;
      // what it started now, or what an older Opengeni started, is kept.
      link.send({ t: "close", s: 2 });
      const returned = await open(3, oldInstance);
      expect(await generation()).toBe(3);
      expect(
        await report(3, returned, "2", [
          ["old-op", 1],
          ["current-op", 3],
          ["older-opengeni-op", 0],
        ]),
      ).toEqual({ reportId: "2", page: 0, endOpIds: ["old-op"] });

      // The sandbox falls asleep right after reporting: the answer still
      // reaches the host as a plain message, and no request is ever sent.
      link.send({ t: "state", s: 3, state: "asleep" });
      await Bun.sleep(100);
      expect((await report(3, returned, "3", [["old-op", 1]])).endOpIds).toEqual(["old-op"]);
      expect(link.frames.filter((frame) => frame.t === "msg" && frame.reply !== undefined)).toEqual(
        [],
      );
      link.close();
    } finally {
      events.unsubscribe();
      await ingesting.catch(() => undefined);
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
