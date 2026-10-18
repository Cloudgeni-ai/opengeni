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
import { verifyRelayToken } from "@opengeni/contracts";
import {
  createDb,
  createSandboxEnrollment,
  getLiveEnrollmentConnection,
  revokeSandboxEnrollment,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { connect, type NatsConnection } from "@opengeni/events";
import {
  acquireSharedTestDatabase,
  freePort,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiWebSocketConnection } from "../../apps/api/src/api-websocket";
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

async function linkAs(host: string): Promise<TestComputeHostLink> {
  return await TestComputeHostLink.connect(
    linkUrl,
    await hostToken(key, { audience: linkUrl, host }),
  );
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
  const routes = [handle.gateway];
  api = Bun.serve<ApiWebSocketConnection>({
    hostname: "127.0.0.1",
    port: apiPort,
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
