// Mocked-NATS integration (dossier §16): a `MockAgentResponder` standing in for
// a real enrolled agent over NATS drives an exec + an fs write→read round-trip
// through a `SelfhostedSession` built by the registry-shaped `SelfhostedSandboxClient`
// — end-to-end, no live broker (the real NATS transport is M4). It exercises the
// FULL path a resume would take: build the client → resume({agentId}) → drive the
// structural surface → serialize back.

import { describe, expect, test } from "bun:test";
import {
  type ControlRpc,
  MockAgentResponder,
  SandboxChannelAService,
  SelfhostedSandboxClient,
  negotiateSelfhostedCapabilities,
} from "../src/sandbox";

const WS = "22222222-2222-2222-2222-222222222222";
const AGENT = "agent-int";
const RELAY = { host: "relay.test", port: 443, tls: true } as const;

function buildClient(rpc: ControlRpc): SelfhostedSandboxClient {
  return new SelfhostedSandboxClient({
    workspaceId: WS,
    relay: RELAY,
    controlRpcFactory: () => rpc,
  });
}

describe("selfhosted mocked-NATS integration — exec + fs round-trip through a resumed session", () => {
  test("resume({agentId}) then exec + fs write→read land on the (mock) machine", async () => {
    const mock = new MockAgentResponder({ hostname: "integration-vm" });
    const client = buildClient(mock);

    // The resume path: the lease's envelope carries {agentId}; resume re-addresses
    // the subject (no provider state, no cold create).
    const session = await client.resume({ agentId: AGENT });
    expect(session.agentId).toBe(AGENT);

    // exec lands on the machine.
    const hostExec = await session.exec({ cmd: "echo $HOSTNAME" });
    expect(hostExec.stdout.trim()).toBe("integration-vm");

    // fs write → read round-trips byte-identically.
    await session.writeFile({ path: "/tmp/marker", content: "byo-compute" });
    const bytes = await session.readFile({ path: "/tmp/marker" });
    expect(new TextDecoder().decode(bytes)).toBe("byo-compute");

    // The mock observed the request fan-out addressed to the agent subject.
    const subjects = new Set(mock.requests.map((r) => r.subject));
    expect([...subjects]).toEqual([`agent.${WS}.${AGENT}.rpc`]);

    // Serialize back to the persistable envelope — {agentId} ONLY.
    expect(await session.serializeSessionState()).toEqual({ agentId: AGENT });
  });

  test("SandboxChannelAService consumes the SelfhostedSession's structural exec/readFile unchanged", async () => {
    // The selfhosted session must satisfy the SAME structural surface Channel-A
    // consumes for Modal — exec({cmd}) → {output/stdout/exitCode}, readFile({path}).
    // We drive readFile directly through the service to prove the duck-typing holds
    // (no selfhosted branching in Channel-A).
    //
    // The mock models the MACHINE's filesystem — there is no literal "/workspace"
    // on a real machine; the agent stores files relative to its real
    // workspace_root. Channel-A here is rooted at the SDK's virtual "/workspace"
    // root, and the SelfhostedSession is the SOLE adapter that strips that prefix
    // to the machine frame ("/workspace/app.txt" → "app.txt"). So we seed the mock
    // at the machine-relative path and assert the full virtual→machine round-trip.
    const mock = new MockAgentResponder({ files: { "app.txt": "from-the-machine" } });
    const session = await buildClient(mock).resume({ agentId: AGENT });

    const service = new SandboxChannelAService({
      session: {
        exec: (args) => session.exec(args),
        readFile: (args) => session.readFile(args),
      },
      workspaceRoot: "/workspace",
    });

    const read = await service.fsRead({ path: "app.txt", maxBytes: 4096, encoding: "utf8" });
    // The Channel-A service returns the file content read off the machine, with
    // ZERO selfhosted-specific branching — the structural duck-typing holds.
    expect(read.encoding).toBe("utf8");
    expect(read.content).toBe("from-the-machine");
  });

  test("an offline machine fails the round-trip with agent_offline, never cold-recreating", async () => {
    const mock = new MockAgentResponder({ online: false });
    const session = await buildClient(mock).resume({ agentId: AGENT });
    let err: unknown;
    try {
      await session.exec({ cmd: "true" });
    } catch (e) {
      err = e;
    }
    expect((err as { reason?: string }).reason).toBe("agent_offline");
  });

  test("the negotiated capability surface reflects the same live mock probe", async () => {
    const mock = new MockAgentResponder();
    const session = await buildClient(mock).resume({ agentId: AGENT });
    const caps = await negotiateSelfhostedCapabilities({
      sessionId: "33333333-3333-3333-3333-333333333333",
      leaseEpoch: 4,
      enrollment: { status: "active", exposure: "whole-machine", allowScreenControl: true, hasDisplay: true, lastSeenAt: new Date().toISOString() },
      session,
    });
    expect(caps.FileSystem.available).toBe(true);
    expect(caps.DesktopStream.transport).toBe("vnc-ws");

    // Flip offline → the surface degrades to agent_offline on the same session.
    mock.setOnline(false);
    const offline = await negotiateSelfhostedCapabilities({
      sessionId: "33333333-3333-3333-3333-333333333333",
      leaseEpoch: 4,
      enrollment: { status: "active", exposure: "whole-machine", allowScreenControl: true, hasDisplay: true, lastSeenAt: new Date(Date.now() - 600_000).toISOString() },
      session,
    });
    expect(offline.FileSystem.reason).toBe("agent_offline");
  });
});
