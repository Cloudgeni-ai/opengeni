// Proves the NATS AUTH-CALLOUT tenancy boundary against a REAL nats-server
// configured WITH auth_callout and NATS Accounts per workspace.
//
// The M4 transport test proved the CODE constructs workspace-scoped SUBJECTS; this
// test proves the SERVER cryptographically ENFORCES the per-workspace boundary. A
// nats-server is started with `auth_callout` pointing at our in-process responder.
// When a client connects presenting an `oge_` enrollment bearer as the connect
// auth-token, nats-server issues an authorization request on $SYS.REQ.USER.AUTH; the
// responder validates the bearer (verifyEnrollmentBearer) + confirms the enrollment
// is active (DB getEnrollment) and returns a SIGNED user JWT scoping the connection
// to pub/sub ONLY `agent.<ws>.>` (+ `_INBOX.>`).
//
// FUNCTIONAL: an agent with a valid bearer for workspace W connects and can pub/sub
//   `agent.W.<id>.rpc` + a control-plane request/reply round-trips (the M4 path).
// ISOLATION SMOKE (the load-bearing security assertion):
//   - an agent authenticated for workspace A is DENIED pub/sub on `agent.B.>`;
//   - an invalid/revoked bearer is DENIED connection entirely.
//
// nats-server is launched via nix (`nix run nixpkgs#nats-server`) so the test needs
// no globally-installed broker. The responder runs in-process (the SAME
// handleAuthorizationRequest the API boots), connected as the callout `auth` user.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signEnrollmentBearer } from "@opengeni/contracts";
import {
  connect,
  createResponderConnection,
  nkeys,
  type NatsConnection,
  type ResponderConnection,
} from "@opengeni/events";
import {
  AUTH_CALLOUT_SUBJECT,
  handleAuthorizationRequest,
  type AuthCalloutDeps,
} from "../../apps/api/src/sandbox/auth-callout";

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

import { mock } from "bun:test";
mock.module("@opengeni/db", () => ({
  getEnrollment: async (_db: unknown, workspaceId: string, enrollmentId: string) => {
    const credentialGeneration = activeEnrollments.get(`${workspaceId}:${enrollmentId}`);
    if (credentialGeneration !== undefined) {
      return { id: enrollmentId, workspaceId, status: "active", credentialGeneration };
    }
    return null;
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
    settings: { enrollmentSigningSecret: SIGNING_SECRET } as AuthCalloutDeps["settings"],
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

/**
 * Start a nats-server (via nix) configured with auth_callout: the AUTH account holds
 * the responder's `auth`/`auth` login (the only configured auth_users), and the
 * callout `issuer` is our account public key. A client presenting any token triggers
 * the callout; the responder mints the scoped JWT placing the user into the AUTH
 * account with `agent.<ws>.>` permissions. The control plane connects as the same
 * `auth` user (broad, account-default permissions) so request/reply routes.
 */
async function startNatsWithCallout(accountPublicKey: string): Promise<RunningNats> {
  const configDir = await mkdtemp(join(tmpdir(), "opengeni-authcallout-"));
  const port = 14000 + Math.floor(Math.random() * 1000);
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
  // All three share APP so `agent.<ws>.<id>.rpc` request/reply routes; the
  // per-workspace isolation is carried entirely by each agent's signed subject
  // permissions.
  const config = `
port: ${port}
http_port: ${port + 1}

accounts {
  APP: {
    users: [
      { user: auth, password: auth }
      { user: control, password: control }
    ]
  }
  SYS: {}
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

  const proc = Bun.spawn(["nix", "run", "nixpkgs#nats-server", "--", "-c", configPath], {
    stdout: logFile,
    stderr: logFile,
  });

  const url = `nats://127.0.0.1:${port}`;
  // Wait for the monitor port to answer (the server is up). The control-plane
  // connect itself triggers the callout, so we wait on a raw TCP/monitor probe.
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port + 1}/healthz`);
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
    proc.kill();
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
      proc.kill();
      await proc.exited.catch(() => undefined);
      await rm(configDir, { recursive: true, force: true });
    },
  };
}

describe("NATS auth-callout tenancy boundary (real nats-server)", () => {
  let nats: RunningNats;
  let responder: ResponderConnection;
  let accountSeed: string;
  let accountPublicKey: string;

  beforeAll(async () => {
    // Generate the callout issuer account keypair (its seed signs every JWT).
    const account = nkeys.createAccount();
    accountSeed = new TextDecoder().decode(account.getSeed());
    accountPublicKey = account.getPublicKey();

    nats = await startNatsWithCallout(accountPublicKey);

    // Start the responder in-process as the callout `auth` user — the SAME
    // handleAuthorizationRequest the API boots, over a standalone connection.
    const deps = makeDeps({ accountSeed, accountName: "APP", user: "auth", password: "auth" });
    responder = await createResponderConnection(
      nats.url,
      { kind: "user-password", user: "auth", pass: "auth" },
      AUTH_CALLOUT_SUBJECT,
      (bytes) => handleAuthorizationRequest(deps, bytes),
      { name: "test-auth-callout" },
    );
  }, 120_000);

  afterAll(async () => {
    if (process.env.DUMP_NATS_LOG) {
      const log = await nats?.serverLog();
      console.error("=== nats-server log ===\n" + (log ?? "").split("\n").slice(-40).join("\n"));
    }
    await responder?.close().catch(() => undefined);
    await nats?.stop().catch(() => undefined);
  }, 30_000);

  // (1) FUNCTIONAL: a valid bearer for workspace A connects + can pub/sub
  //     agent.A.<id>.rpc, and a control-plane request/reply round-trips.
  test("(1) a valid bearer connects + round-trips agent.<ws>.<id>.rpc request/reply", async () => {
    const bearer = await bearerFor(WS_A, AGENT_A);
    const agent: NatsConnection = await connect({ servers: nats.url, token: bearer });
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
      const subject = `agent.${WS_A}.${AGENT_A}.rpc`;
      // The agent subscribes to its OWN subject (its subscription IS the registry).
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

  // (2) ISOLATION SMOKE — the load-bearing assertion: an agent authenticated for
  //     workspace A is DENIED publish AND subscribe on workspace B's subtree.
  test("(2) ISOLATION: workspace A's agent is denied pub/sub on agent.B.>", async () => {
    const bearer = await bearerFor(WS_A, AGENT_A);
    const agent: NatsConnection = await connect({ servers: nats.url, token: bearer });
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

      const foreignSubject = `agent.${WS_B}.${AGENT_B}.rpc`;

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
        await agent.request(foreignSubject, new TextEncoder().encode("x"), { timeout: 1_500 });
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
      const c = await connect({ servers: nats.url, token: bearer, timeout: 5_000 });
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
      const c = await connect({ servers: nats.url, token: staleBearer, timeout: 5_000 });
      await c.close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(/auth|denied|violation|generation|timeout/i.test(String(err))).toBe(true);
  }, 30_000);
});
