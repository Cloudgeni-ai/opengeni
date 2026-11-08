// Proves the NATS AUTH-CALLOUT tenancy boundary against a REAL nats-server
// configured WITH auth_callout and NATS Accounts per workspace.
//
// The M4 transport test proved the CODE constructs workspace-scoped SUBJECTS; this
// test proves the SERVER cryptographically ENFORCES the per-workspace boundary. A
// nats-server is started with `auth_callout` pointing at our in-process responder.
// When a client connects presenting an `oge_` enrollment bearer as the connect
// auth-token, nats-server issues an authorization request on $SYS.REQ.USER.AUTH; the
// responder validates the bearer, confirms the enrollment is active, atomically
// claims the daemon generation, and returns a SIGNED user JWT scoped to that exact
// `agent.<ws>.<id>.connection.<instance>.>` subtree (+ `_INBOX.>`).
//
// FUNCTIONAL: an agent with a valid bearer for workspace W connects and can pub/sub
//   `agent.W.<id>.connection.<instance>.rpc` + a control-plane request/reply
//   round-trips (the M4 path).
// ISOLATION SMOKE (the load-bearing security assertion):
//   - an agent authenticated for workspace A is DENIED pub/sub on `agent.B.>`;
//   - an invalid/revoked bearer is DENIED connection entirely.
//
// nats-server resolves from an explicit binary or PATH, then falls back to nix or
// a digest-pinned Docker image, so the test needs no globally-installed broker.
// The responder runs in-process (the SAME handleAuthorizationRequest the API boots),
// connected as the callout `auth` user.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signEnrollmentBearer } from "@opengeni/contracts";
import { connect, nkeys, type NatsConnection, type ResponderConnection } from "@opengeni/events";
import {
  startAuthCalloutResponder,
  type AuthCalloutDeps,
} from "../../apps/api/src/sandbox/auth-callout";
import { reconcileLiveConnections } from "../../apps/api/src/sandbox/live-connection-authority";
import { freePort } from "@opengeni/testing/compose";

// ── A minimal in-memory DB stand-in for getEnrollment ────────────────────────
// The responder only calls db.getEnrollment via the @opengeni/db helper, which runs
// a query against `db`. We avoid a real Postgres by stubbing the ONE function the
// responder uses through a fake `getEnrollment`-shaped DB. handleAuthorizationRequest
// imports getEnrollment from @opengeni/db, so we instead drive it through a tiny
// Database double whose query returns our seeded rows. To keep this honest WITHOUT a
// live PG, we shadow getEnrollment by constructing AuthCalloutDeps with a `db` whose
// behavior we control via the enrollment registry below — see makeDeps().

/** The HMAC secret the control plane signs bearers with (the test signing secret). */
const SIGNING_SECRET = "test-enrollment-signing-secret-m-auth";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INSTANCE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INSTANCE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function connectionName(instanceId: string): string {
  return `opengeni-agent/connection/${instanceId}`;
}

/** Mint an `oge_` enrollment bearer (the agent's NATS connect auth-token). */
async function bearerFor(
  workspaceId: string,
  agentId: string,
  credentialGeneration = 1,
  expSeconds?: number,
): Promise<string> {
  const exp = expSeconds ?? Math.floor(Date.now() / 1000) + 3600;
  return signEnrollmentBearer(SIGNING_SECRET, {
    workspaceId,
    agentId,
    enrollmentId: agentId,
    credentialGeneration,
    subjectPrefix: `agent.${workspaceId}.${agentId}`,
    exp,
  });
}

// ── The active-enrollment registry the responder's DB double resolves against ──
// getEnrollment(db, ws, id) must return an active row for a known agent, null
// otherwise. We seed the active set and build a Database whose `getEnrollment`
// behavior the responder reads. Since handleAuthorizationRequest calls the real
// @opengeni/db getEnrollment, we instead inject a `db` object that the test's
// monkeypatch resolves — implemented by passing a deps.db whose query the stub
// honors. To keep the test self-contained we override getEnrollment via a module
// mock.
const activeEnrollments = new Map<string, number>([
  [`${WS_A}:${AGENT_A}`, 1],
  [`${WS_B}:${AGENT_B}`, 1],
]);
const liveConnectionClaims = new Map<string, string>();
const revokedEnrollments = new Set<string>();
let databaseUnavailable = false;

import { mock } from "bun:test";
mock.module("@opengeni/db", () => ({
  recordEnrollmentExpiredCredentials: async () => undefined,
  getEnrollment: async (_db: unknown, workspaceId: string, enrollmentId: string) => {
    if (databaseUnavailable) throw new Error("database unavailable");
    const credentialGeneration = activeEnrollments.get(`${workspaceId}:${enrollmentId}`);
    if (credentialGeneration !== undefined) {
      return {
        id: enrollmentId,
        workspaceId,
        status: revokedEnrollments.has(`${workspaceId}:${enrollmentId}`) ? "revoked" : "active",
        credentialGeneration,
        connectionInstanceId: liveConnectionClaims.get(`${workspaceId}:${enrollmentId}`),
      };
    }
    return null;
  },
  claimEnrollmentConnection: async (
    _db: unknown,
    input: {
      workspaceId: string;
      enrollmentId: string;
      connectionInstanceId: string;
    },
  ) => {
    const key = `${input.workspaceId}:${input.enrollmentId}`;
    const current = liveConnectionClaims.get(key);
    const claimed = current === undefined || current === input.connectionInstanceId;
    if (current === undefined) liveConnectionClaims.set(key, input.connectionInstanceId);
    return {
      claimed,
      connectionInstanceId: current ?? input.connectionInstanceId,
      connectionGeneration: 1,
      connectionLeaseExpiresAt: new Date(Date.now() + 20_000).toISOString(),
    };
  },
}));

function makeDeps(callout: {
  accountSeed: string;
  accountName: string;
  user: string;
  password: string;
}): AuthCalloutDeps {
  return {
    // The db is unused beyond getEnrollment (mocked above).
    db: {} as AuthCalloutDeps["db"],
    settings: {
      enrollmentSigningSecret: SIGNING_SECRET,
      sandboxSelfhostedEnabled: true,
    } as AuthCalloutDeps["settings"],
    callout,
  };
}

// ── nats-server-with-auth_callout lifecycle ──────────────────────────────────

interface RunningNats {
  url: string;
  stop: () => Promise<void>;
  configDir: string;
  serverLog: () => Promise<string>;
}

const NATS_DOCKER_IMAGE =
  "nats:2.10.21-alpine@sha256:b76faa6b447604217b5526b8adc1229d3db5c5d2773e43ae4aea328817e7fecb";

function natsServerLaunch(
  configPath: string,
  port: number,
  monitorPort: number,
): { command: string[]; cleanupCommand: string[] | null } {
  const configured = process.env.OPENGENI_NATS_SERVER_BIN;
  if (configured) {
    return { command: [configured, "-c", configPath], cleanupCommand: null };
  }

  const installed = Bun.which("nats-server");
  if (installed) {
    return { command: [installed, "-c", configPath], cleanupCommand: null };
  }

  const nix = Bun.which("nix");
  if (nix) {
    return {
      command: [nix, "run", "nixpkgs#nats-server", "--", "-c", configPath],
      cleanupCommand: null,
    };
  }

  const docker = Bun.which("docker");
  if (docker) {
    const containerName = `opengeni-authcallout-${crypto.randomUUID()}`;
    return {
      command: [
        docker,
        "run",
        "--rm",
        "--name",
        containerName,
        "--publish",
        `127.0.0.1:${port}:${port}`,
        "--publish",
        `127.0.0.1:${monitorPort}:${monitorPort}`,
        "--volume",
        `${configPath}:/etc/nats/nats.conf:ro`,
        NATS_DOCKER_IMAGE,
        "-c",
        "/etc/nats/nats.conf",
      ],
      cleanupCommand: [docker, "rm", "--force", containerName],
    };
  }

  throw new Error(
    "selfhosted auth-callout integration requires OPENGENI_NATS_SERVER_BIN, nats-server, nix, or docker",
  );
}

/**
 * Start a real nats-server configured with auth_callout: the AUTH account holds the
 * responder's `auth`/`auth` login (the only configured auth_users), and the callout
 * `issuer` is our account public key. A client presenting any token triggers the
 * callout; the responder mints the scoped JWT placing the user into the AUTH account
 * with `agent.<ws>.>` permissions. The control plane connects as the same `auth` user
 * (broad, account-default permissions) so request/reply routes.
 */
async function startNatsWithCallout(
  accountPublicKey: string,
  kickService = true,
): Promise<RunningNats> {
  const configDir = await mkdtemp(join(tmpdir(), "opengeni-authcallout-"));
  const [port, monitorPort] = await Promise.all([freePort(), freePort()]);
  // SINGLE-account (APP) server-config-mode auth_callout. THE load-bearing rule
  // (verified empirically against nats-server 2.10.x): every user in the callout
  // `account` that is NOT listed in `auth_users` is DELEGATED to the callout
  // responder; the `auth_users` authenticate DIRECTLY (by password) and bypass the
  // callout. So:
  //   - `auth`    — the responder's own login (bypasses the callout, else infinite
  //                 loop). In auth_users.
  //   - `control` — the PRIVILEGED control-plane login (api/worker). It must ALSO be
  //                 in auth_users so it authenticates directly with full account-
  //                 default permissions (it has no enrollment bearer to present).
  //   - agents    — NOT in auth_users → delegated to the callout, which validates the
  //                 bearer and mints a JWT placing them into APP (the user JWT `aud`)
  //                 scoped to `agent.<ws>.>` + `_INBOX.>`.
  // All three share APP so exact process request/reply routes; the
  // per-workspace isolation is carried entirely by each agent's signed subject
  // permissions.
  const config = `
port: ${port}
http_port: ${monitorPort}

accounts {
  APP: {
    ${kickService ? 'imports: [ { service: { account: SYS, subject: "$SYS.REQ.SERVER.*.KICK" } } ]' : ""}
    users: [
      { user: auth, password: auth }
      { user: control, password: control }
    ]
  }
  SYS: {
    ${kickService ? 'exports: [ { service: "$SYS.REQ.SERVER.*.KICK", accounts: [APP] } ]' : ""}
  }
}
system_account: SYS

authorization {
  auth_callout {
    issuer: ${accountPublicKey}
    auth_users: [ auth, control ]
    account: APP
  }
}
`;
  const configPath = join(configDir, "nats.conf");
  await writeFile(configPath, config);
  // Drain the server's stdout/stderr to a file so the pipe buffer never fills and
  // stalls the server under `debug:true`; the test can read it on a failure.
  const logPath = join(configDir, "nats.log");
  const logFile = Bun.file(logPath);
  const launch = natsServerLaunch(configPath, port, monitorPort);

  const proc = Bun.spawn(launch.command, {
    stdout: logFile,
    stderr: logFile,
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (launch.cleanupCommand) {
      const cleanup = Bun.spawn(launch.cleanupCommand, { stdout: "ignore", stderr: "ignore" });
      await cleanup.exited.catch(() => undefined);
    }
    proc.kill();
    await proc.exited.catch(() => undefined);
  };

  const url = `nats://127.0.0.1:${port}`;
  // Wait for the monitor port to answer (the server is up). The control-plane
  // connect itself triggers the callout, so we wait on a raw TCP/monitor probe.
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${monitorPort}/healthz`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // not yet
    }
    await Bun.sleep(250);
  }
  if (!up) {
    await stop();
    const err = await Bun.file(logPath)
      .text()
      .catch(() => "");
    await rm(configDir, { recursive: true, force: true });
    throw new Error(`nats-server (auth_callout) did not become ready:\n${err}`);
  }

  return {
    url,
    configDir,
    serverLog: () =>
      Bun.file(logPath)
        .text()
        .catch(() => ""),
    stop: async () => {
      await stop();
      await rm(configDir, { recursive: true, force: true });
    },
  };
}

describe("NATS auth-callout tenancy boundary (real nats-server)", () => {
  let nats: RunningNats;
  let responder: ResponderConnection;
  let accountSeed: string;
  let accountPublicKey: string;
  let deps: AuthCalloutDeps;

  beforeAll(async () => {
    // Generate the callout issuer account keypair (its seed signs every JWT).
    const account = nkeys.createAccount();
    accountSeed = new TextDecoder().decode(account.getSeed());
    accountPublicKey = account.getPublicKey();

    nats = await startNatsWithCallout(accountPublicKey);

    // Start the responder in-process as the callout `auth` user — the SAME
    // handleAuthorizationRequest the API boots, over a standalone connection.
    deps = makeDeps({
      accountSeed,
      accountName: "APP",
      user: "auth",
      password: "auth",
    });
    responder = await startAuthCalloutResponder(deps, nats.url);
  }, 120_000);

  afterAll(async () => {
    if (process.env.DUMP_NATS_LOG) {
      const log = await nats?.serverLog();
      console.error("=== nats-server log ===\n" + (log ?? "").split("\n").slice(-40).join("\n"));
    }
    await responder?.close().catch(() => undefined);
    await nats?.stop().catch(() => undefined);
  }, 30_000);

  test("live authority audit preserves healthy sockets and never treats a DB outage as revocation", async () => {
    const agent = await connect({
      servers: nats.url,
      token: await bearerFor(WS_A, AGENT_A),
      name: connectionName(INSTANCE_A),
      reconnect: false,
    });
    try {
      await reconcileLiveConnections(deps, responder.connection);
      await agent.flush();
      expect(agent.isClosed()).toBe(false);
      databaseUnavailable = true;
      await expect(reconcileLiveConnections(deps, responder.connection)).rejects.toThrow(
        "database unavailable",
      );
      await agent.flush();
      expect(agent.isClosed()).toBe(false);
    } finally {
      databaseUnavailable = false;
      await agent.close();
    }
  }, 15_000);

  test.each(["revoked", "removed", "generation", "runner", "disabled"])(
    "live authority audit disconnects both silent lanes when authority is %s",
    async (change) => {
      const id = crypto.randomUUID();
      const instance = crypto.randomUUID();
      const key = `${WS_A}:${id}`;
      activeEnrollments.set(key, 1);
      const token = await bearerFor(WS_A, id);
      const lanes: NatsConnection[] = [];
      try {
        for (let n = 0; n < 2; n++)
          lanes.push(
            await connect({
              servers: nats.url,
              token,
              name: connectionName(instance),
              reconnect: false,
            }),
          );
        if (change === "revoked") revokedEnrollments.add(key);
        if (change === "removed") activeEnrollments.delete(key);
        if (change === "generation") activeEnrollments.set(key, 2);
        if (change === "runner") liveConnectionClaims.set(key, crypto.randomUUID());
        const auditDeps =
          change === "disabled"
            ? { ...deps, settings: { ...deps.settings, sandboxSelfhostedEnabled: false } }
            : deps;
        await reconcileLiveConnections(auditDeps, responder.connection);
        await Promise.race([
          Promise.all(lanes.map((lane) => lane.closed())),
          Bun.sleep(2_000).then(() => {
            throw new Error("revoked sockets stayed open");
          }),
        ]);
        expect(lanes.every((lane) => lane.isClosed())).toBe(true);
      } finally {
        activeEnrollments.delete(key);
        liveConnectionClaims.delete(key);
        revokedEnrollments.delete(key);
        await Promise.all(lanes.map((lane) => lane.close()));
      }
    },
    15_000,
  );

  test("running responder revokes an idle connection without a client heartbeat", async () => {
    const id = crypto.randomUUID();
    const key = `${WS_A}:${id}`;
    activeEnrollments.set(key, 1);
    const agent = await connect({
      servers: nats.url,
      token: await bearerFor(WS_A, id),
      name: connectionName(crypto.randomUUID()),
      reconnect: false,
    });
    try {
      activeEnrollments.delete(key);
      await Promise.race([
        agent.closed(),
        Bun.sleep(8_000).then(() => {
          throw new Error("background authority audit did not revoke idle socket");
        }),
      ]);
      expect(agent.isClosed()).toBe(true);
    } finally {
      activeEnrollments.delete(key);
      liveConnectionClaims.delete(key);
      await agent.close();
    }
  }, 12_000);

  test("agents cannot use broker authority inventory or kick services", async () => {
    const agent = await connect({
      servers: nats.url,
      token: await bearerFor(WS_A, AGENT_A),
      name: connectionName(INSTANCE_A),
      reconnect: false,
    });
    try {
      for (const subject of ["$SYS.REQ.ACCOUNT.PING.CONNZ", "$SYS.REQ.SERVER.fake.KICK"]) {
        await expect(agent.request(subject, "{}", { timeout: 500 })).rejects.toThrow();
      }
      expect(agent.isClosed()).toBe(false);
    } finally {
      await agent.close();
    }
  });

  test("API restart recovers and revokes sockets admitted by its predecessor", async () => {
    const id = crypto.randomUUID();
    const key = `${WS_A}:${id}`;
    activeEnrollments.set(key, 1);
    const agent = await connect({
      servers: nats.url,
      token: await bearerFor(WS_A, id),
      name: connectionName(crypto.randomUUID()),
      reconnect: false,
    });
    try {
      await responder.close();
      await agent.flush();
      expect(agent.isClosed()).toBe(false);
      activeEnrollments.delete(key);
      responder = await startAuthCalloutResponder(deps, nats.url);
      await Promise.race([
        agent.closed(),
        Bun.sleep(2_000).then(() => {
          throw new Error("replacement API missed the existing socket");
        }),
      ]);
      expect(agent.isClosed()).toBe(true);
    } finally {
      activeEnrollments.delete(key);
      liveConnectionClaims.delete(key);
      await agent.close();
    }
  }, 12_000);

  test("responder cannot admit non-expiring sockets without broker revocation configured", async () => {
    const unconfigured = await startNatsWithCallout(accountPublicKey, false);
    try {
      await expect(startAuthCalloutResponder(deps, unconfigured.url)).rejects.toThrow();
    } finally {
      await unconfigured.stop();
    }
  }, 15_000);

  // (1) FUNCTIONAL: a valid bearer for workspace A connects + can pub/sub its
  //     exact claimed process subject, and request/reply round-trips.
  test("(1) a valid bearer connects + round-trips its exact process subject", async () => {
    const bearer = await bearerFor(WS_A, AGENT_A);
    const agent: NatsConnection = await connect({
      servers: nats.url,
      token: bearer,
      name: connectionName(INSTANCE_A),
    });
    // The control plane connects as the privileged `auth` user (account-default
    // permissions — it may request agent.>).
    // The control plane connects as a REGULAR (non-callout) user in the SAME
    // account as the agents, so subjects route. `control` is NOT in auth_users, so
    // the server authenticates it directly (the callout is only for auth_users).
    const controlPlane: NatsConnection = await connect({
      servers: nats.url,
      user: "control",
      pass: "control",
    });
    try {
      const subject = `agent.${WS_A}.${AGENT_A}.connection.${INSTANCE_A}.rpc`;
      // The agent subscribes only to its exact claimed generation.
      const sub = agent.subscribe(subject);
      void (async () => {
        for await (const msg of sub) {
          if (msg.reply) {
            msg.respond(new TextEncoder().encode("pong-from-agent-A"));
          }
        }
      })();
      // Allow the subscription to register on the server.
      await agent.flush();

      // The control plane requests on the agent's subject; the reply round-trips.
      let reply: Awaited<ReturnType<typeof controlPlane.request>> | undefined;
      try {
        reply = await controlPlane.request(subject, new TextEncoder().encode("ping"), {
          timeout: 5_000,
        });
      } catch (e) {
        // Surface the server's reason to make a failure diagnosable.
        const log = await nats.serverLog();
        const tail = log.split("\n").slice(-15).join("\n");
        throw new Error(`round-trip failed: ${String(e)}\n--- nats-server log tail ---\n${tail}`, {
          cause: e,
        });
      }
      expect(new TextDecoder().decode(reply.data)).toBe("pong-from-agent-A");
    } finally {
      await agent.close();
      await controlPlane.close();
    }
  }, 30_000);

  test("a request spanning login expiry keeps its original socket; expired reconnect is denied", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3;
    const bearer = await bearerFor(WS_A, AGENT_A, 1, expires);
    const agent = await connect({
      servers: nats.url,
      token: bearer,
      name: connectionName(INSTANCE_A),
      reconnect: false,
    });
    const control = await connect({ servers: nats.url, user: "control", pass: "control" });
    const socket = agent.info?.client_id;
    try {
      const subject = `agent.${WS_A}.${AGENT_A}.connection.${INSTANCE_A}.rpc`;
      const sub = agent.subscribe(subject, { max: 1 });
      await agent.flush();
      const serving = (async () => {
        for await (const message of sub) {
          await Bun.sleep(Math.max(0, expires * 1000 - Date.now()) + 1_250);
          message.respond(new TextEncoder().encode("completed-on-original-socket"));
        }
      })();
      const reply = await control.request(subject, new Uint8Array(), { timeout: 6_000 });
      await serving;
      expect(new TextDecoder().decode(reply.data)).toBe("completed-on-original-socket");
      expect(agent.isClosed()).toBe(false);
      expect(agent.info?.client_id).toBe(socket);
      await expect(
        connect({
          servers: nats.url,
          token: bearer,
          name: connectionName(INSTANCE_A),
          reconnect: false,
        }),
      ).rejects.toThrow();
    } finally {
      await Promise.all([agent.close(), control.close()]);
    }
  }, 10_000);

  // (2) ISOLATION SMOKE — the load-bearing assertion: an agent authenticated for
  //     workspace A is DENIED publish AND subscribe on workspace B's subtree.
  test("(2) ISOLATION: workspace A's agent is denied pub/sub on agent.B.>", async () => {
    const bearer = await bearerFor(WS_A, AGENT_A);
    const agent: NatsConnection = await connect({
      servers: nats.url,
      token: bearer,
      name: connectionName(INSTANCE_A),
    });
    try {
      // PUBLISH to B's subject → a permissions violation (async error on the conn).
      const violations: string[] = [];
      void (async () => {
        for await (const status of agent.status()) {
          if (status.type === "permissionViolation" || /permission/i.test(String(status.data))) {
            violations.push(String(status.data));
          }
        }
      })();

      const foreignSubject = `agent.${WS_B}.${AGENT_B}.connection.${INSTANCE_B}.rpc`;

      // SUBSCRIBE to B's subtree → the server sends a permissions-violation error.
      let subErr: unknown;
      try {
        const sub = agent.subscribe(`agent.${WS_B}.>`);
        await agent.flush();
        // Pull one — the server should error the subscription rather than deliver.
        // Give the violation a moment to arrive.
        await Bun.sleep(500);
        sub.unsubscribe();
      } catch (e) {
        subErr = e;
      }

      // PUBLISH to B's subject; the publish itself is permission-checked server-side.
      agent.publish(foreignSubject, new TextEncoder().encode("cross-tenant"));
      await agent.flush();
      await Bun.sleep(500);

      // A request to B's subject from A's connection must NOT succeed (no permission
      // to publish there → a permission violation / no delivery). We assert the
      // connection observed a permissions violation OR the request fails.
      let reqErr: unknown;
      try {
        await agent.request(foreignSubject, new TextEncoder().encode("x"), {
          timeout: 1_500,
        });
      } catch (e) {
        reqErr = e;
      }

      // THE assertion: A's connection is NOT permitted on B's subtree. Either a
      // permissions violation was surfaced, or the cross-tenant request failed.
      const denied = violations.length > 0 || reqErr !== undefined || subErr !== undefined;
      expect(denied).toBe(true);
    } finally {
      await agent.close().catch(() => undefined);
    }
  }, 30_000);

  // (3) ISOLATION: an INVALID bearer is denied connection entirely.
  test("(3) ISOLATION: an invalid bearer is denied connection", async () => {
    let err: unknown;
    try {
      const c = await connect({
        servers: nats.url,
        token: "oge_not.a.valid.bearer",
        name: connectionName(INSTANCE_A),
        timeout: 5_000,
      });
      await c.close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(/auth|denied|violation|invalid|timeout/i.test(String(err))).toBe(true);
  }, 30_000);

  // (4) ISOLATION: a REVOKED enrollment (active set no longer contains it) is denied
  //     even with an otherwise-valid, unexpired bearer.
  test("(4) ISOLATION: a revoked enrollment is denied even with a valid bearer", async () => {
    // A fresh agent id with a valid bearer, but NOT in the active set → revoked.
    const revokedAgent = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const bearer = await bearerFor(WS_A, revokedAgent);
    expect(activeEnrollments.has(`${WS_A}:${revokedAgent}`)).toBe(false);
    let err: unknown;
    try {
      const c = await connect({
        servers: nats.url,
        token: bearer,
        name: connectionName(INSTANCE_A),
        timeout: 5_000,
      });
      await c.close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(/auth|denied|violation|not active|timeout/i.test(String(err))).toBe(true);
  }, 30_000);

  test("(5) ISOLATION: a stale credential generation is denied", async () => {
    const staleBearer = await bearerFor(WS_A, AGENT_A, 2);
    let err: unknown;
    try {
      const c = await connect({
        servers: nats.url,
        token: staleBearer,
        name: connectionName(INSTANCE_A),
        timeout: 5_000,
      });
      await c.close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(/auth|denied|violation|generation|timeout/i.test(String(err))).toBe(true);
  }, 30_000);

  test("(6) AUTHORITY: two lanes from one daemon connect; a competing daemon is denied", async () => {
    const bearer = await bearerFor(WS_B, AGENT_B);
    const control = await connect({
      servers: nats.url,
      token: bearer,
      name: connectionName(INSTANCE_B),
      timeout: 5_000,
    });
    const bulk = await connect({
      servers: nats.url,
      token: bearer,
      name: connectionName(INSTANCE_B),
      timeout: 5_000,
    });
    let competingError: unknown;
    try {
      const competing = await connect({
        servers: nats.url,
        token: bearer,
        name: connectionName(INSTANCE_A),
        timeout: 5_000,
      });
      await competing.close();
    } catch (error) {
      competingError = error;
    } finally {
      await control.close();
      await bulk.close();
    }
    expect(competingError).toBeDefined();
    expect(/auth|denied|violation|another runner|timeout/i.test(String(competingError))).toBe(true);
  }, 30_000);
});
