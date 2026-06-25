// M4 — the selfhosted CONTROL TRANSPORT proven against a REAL local NATS.
//
// M3 designed the `ControlRpc` seam and unit/integration-tested the SESSION
// surface + the AgentError→reason mapping with an IN-PROCESS `MockAgentResponder`
// (no broker). M4 fills the seam with the real NATS request/reply transport — and
// THIS test is the thing M3's mock could not cover: a `ControlRequest` actually
// travels `nc.request("agent.<ws>.<id>.rpc", …)` over a live NATS connection to a
// real subscriber, and the `ControlResponse` travels back, with the load-bearing
// safety mapping (no-responder → agent_offline, NEVER a NotFound) proven on the
// wire.
//
// The transport rides the SAME managed connection the event bus already owns: the
// requester is `NatsControlRpc(() => bus.getRequestConnection())` and the
// responder is `bus.subscribeRequests(subject, …)` — one NATS connection, both
// pub/sub (unchanged) and request/reply (the new M4 usage).
//
// The "agent" stand-in is the M3 `MockAgentResponder` (the full op table over an
// in-memory FS), bridged onto NATS by decoding the request bytes and encoding its
// `ControlResponse` — so we prove the TRANSPORT, reusing the already-tested op
// semantics rather than re-implementing them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import { createNatsEventBus, type EventBus, type RequestHandler } from "@opengeni/events";
import {
  MockAgentResponder,
  NatsControlRpc,
  SelfhostedSandboxClient,
  subjectFor,
  type SelfhostedRelayConfig,
} from "@opengeni/runtime/sandbox";
import { startTestServices, waitFor, type TestServices } from "@opengeni/testing";

const RELAY: SelfhostedRelayConfig = { host: "relay.test", port: 443, tls: true };

/** Bridge a `MockAgentResponder` (the agent's op semantics) onto NATS: decode the
 *  request bytes, run the mock, encode its `ControlResponse`. This is the "enrolled
 *  agent" answering on its subject — exactly what the Rust agent does in M6. */
function responderFor(mock: MockAgentResponder): RequestHandler {
  return async (bytes, subject) => {
    const req = ControlRequest.decode(bytes);
    const res = await mock.request(subject, req, { timeoutMs: 0 });
    return ControlResponse.encode(res).finish();
  };
}

/** A registry-shaped selfhosted client whose `ControlRpc` is the REAL
 *  `NatsControlRpc` over the bus's managed connection. */
function buildClient(bus: EventBus, workspaceId: string): SelfhostedSandboxClient {
  return new SelfhostedSandboxClient({
    workspaceId,
    relay: RELAY,
    // The control transport over the SAME connection the bus owns — no second dial.
    controlRpcFactory: () => new NatsControlRpc(async () => bus.getRequestConnection()),
    timeoutMs: 2_000,
  });
}

describe("selfhosted control transport over a REAL local NATS", () => {
  let services: TestServices;
  let bus: EventBus;
  const WS_A = "11111111-1111-4111-8111-111111111111";
  const WS_B = "22222222-2222-4222-8222-222222222222";
  const AGENT = "agent-real-nats";

  beforeAll(async () => {
    // A real nats-server via the repo's existing test mechanism (docker-compose,
    // the SAME one the NATS pub/sub integration uses) — no ad-hoc broker.
    services = await startTestServices({ temporal: false });
    bus = await createNatsEventBus(services.natsUrl);
  }, 180_000);

  afterAll(async () => {
    await bus?.close();
    await services?.down();
  }, 60_000);

  // (a) ROUND-TRIP: a subscriber answering on `agent.<ws>.<id>.rpc` round-trips a
  //     ControlRequest → ControlResponse through `NatsControlRpc` (real exec + fs).
  test("(a) a subscriber on agent.<ws>.<id>.rpc round-trips exec + fs through NatsControlRpc", async () => {
    const mock = new MockAgentResponder({ hostname: "real-nats-vm" });
    const subject = subjectFor(WS_A, AGENT);
    const unsub = bus.subscribeRequests(subject, responderFor(mock));
    try {
      const session = await buildClient(bus, WS_A).resume({ agentId: AGENT });

      // exec travels over the wire and the VM hostname comes back.
      const hostExec = await session.exec({ cmd: "echo $HOSTNAME" });
      expect(hostExec.stdout.trim()).toBe("real-nats-vm");

      // fs write → read round-trips byte-identically across the broker.
      await session.writeFile({ path: "/tmp/marker", content: "byo-over-nats" });
      const bytes = await session.readFile({ path: "/tmp/marker" });
      expect(new TextDecoder().decode(bytes)).toBe("byo-over-nats");

      // The responder actually observed the requests on its own subject.
      expect(new Set(mock.requests.map((r) => r.subject))).toEqual(new Set([subject]));
    } finally {
      unsub();
    }
  }, 30_000);

  // (b) NO RESPONDER → request times out at the broker (NATS 503 no-responders) →
  //     mapped to agent_offline (the load-bearing safety path), NEVER a NotFound.
  test("(b) no responder on the subject → agent_offline (never NotFound)", async () => {
    // No subscribeRequests for this agent: the broker has no responder.
    const session = await buildClient(bus, WS_A).resume({ agentId: "no-such-agent" });
    let err: { reason?: string; agentOffline?: boolean; osNotFound?: boolean } | undefined;
    try {
      await session.exec({ cmd: "true" });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err?.reason).toBe("agent_offline");
    expect(err?.agentOffline).toBe(true);
    // THE invariant: agent-offline is NEVER an OS/provider NotFound (no cold rival).
    expect(err?.osNotFound).toBe(false);
  }, 30_000);

  // (c) RECONNECT: bounce the responder mid-flight; the transport surfaces the
  //     blip (offline while the subject has no subscriber) then resumes once the
  //     responder re-subscribes — the SAME minted session, same connection.
  test("(c) bouncing the responder mid-session: blip → recover on the SAME connection", async () => {
    const mock = new MockAgentResponder({ hostname: "reconnect-vm" });
    const subject = subjectFor(WS_A, AGENT);
    let unsub = bus.subscribeRequests(subject, responderFor(mock));
    const session = await buildClient(bus, WS_A).resume({ agentId: AGENT });

    // Healthy before the bounce.
    expect((await session.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("reconnect-vm");

    // Bounce: the responder goes away (a transient connection blip on the agent).
    unsub();
    // Allow the unsubscribe to propagate to the server so a request sees 503.
    await waitFor(async () => {
      try {
        await session.exec({ cmd: "true" });
        return false;
      } catch (e) {
        // While the subject has no subscriber the op surfaces agent_offline (the
        // turn would pause + retry against the re-resolved active sandbox).
        return (e as { agentOffline?: boolean }).agentOffline === true;
      }
    }, { timeoutMs: 5_000, intervalMs: 100 });

    // Recover: the agent re-subscribes (reconnect) on the SAME bus connection.
    unsub = bus.subscribeRequests(subject, responderFor(mock));
    try {
      // The transport resumes with NO new session + NO new connection — the next
      // op lands on the re-elected responder.
      await waitFor(async () => {
        try {
          return (await session.exec({ cmd: "echo $HOSTNAME" })).stdout.trim() === "reconnect-vm";
        } catch {
          return false;
        }
      }, { timeoutMs: 5_000, intervalMs: 100 });
    } finally {
      unsub();
    }
  }, 30_000);

  // (d) CROSS-WORKSPACE SUBJECT ISOLATION (code level): a responder on workspace
  //     A's subject is NOT reachable via workspace B's subject. The subject builder
  //     is workspace-scoped (`agent.<ws>.…`); a B-scoped client addresses a B
  //     subject that has no responder → agent_offline, even though A's agent (same
  //     agentId) is live. (Full NATS Account export/import is cluster IaC; this
  //     proves the CODE constructs correctly-scoped, isolated subjects.)
  test("(d) cross-workspace subject isolation: B cannot reach A's responder", async () => {
    const mock = new MockAgentResponder({ hostname: "workspace-a-vm" });
    // Responder lives ONLY on workspace A's subject.
    const unsub = bus.subscribeRequests(subjectFor(WS_A, AGENT), responderFor(mock));
    try {
      // Same agentId, but a workspace-B-scoped client → a DIFFERENT subject.
      expect(subjectFor(WS_B, AGENT)).not.toBe(subjectFor(WS_A, AGENT));

      const sessionB = await buildClient(bus, WS_B).resume({ agentId: AGENT });
      let err: { reason?: string; agentOffline?: boolean } | undefined;
      try {
        await sessionB.exec({ cmd: "true" });
      } catch (e) {
        err = e as typeof err;
      }
      // B's subject has no responder → offline. A's machine is NOT addressable
      // cross-workspace at the code level.
      expect(err?.reason).toBe("agent_offline");

      // Sanity: A's own client DOES reach the responder (so the offline above is
      // genuinely the isolation boundary, not a broken responder).
      const sessionA = await buildClient(bus, WS_A).resume({ agentId: AGENT });
      expect((await sessionA.exec({ cmd: "echo $HOSTNAME" })).stdout.trim()).toBe("workspace-a-vm");
      expect(mock.requests.every((r) => r.subject === subjectFor(WS_A, AGENT))).toBe(true);
    } finally {
      unsub();
    }
  }, 30_000);
});
