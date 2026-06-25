import { describe, expect, test } from "bun:test";
import {
  AgentError,
  ControlRequest,
  ControlResponse,
  ErrorCode,
} from "@opengeni/agent-proto";
import {
  type ControlRpc,
  MockAgentResponder,
  SelfhostedControlError,
  SelfhostedSandboxClient,
  SelfhostedSession,
  agentErrorToControlError,
  isProviderSandboxNotFoundError,
  isSelfhostedProviderNotFoundError,
  offlineControlResponse,
  subjectFor,
  timeoutControlResponse,
} from "../src/sandbox";

const RELAY = { host: "relay.test", port: 443, tls: true } as const;
const WS = "11111111-1111-1111-1111-111111111111";
const AGENT = "agent-abc";

function sessionWith(rpc: ControlRpc, epoch = 0): SelfhostedSession {
  return new SelfhostedSession({ workspaceId: WS, agentId: AGENT, controlRpc: rpc, relay: RELAY, epoch });
}

describe("SelfhostedSession — structural surface over a ControlRpc (mock)", () => {
  test("subject is agent.<ws>.<id>.rpc", () => {
    expect(subjectFor(WS, AGENT)).toBe(`agent.${WS}.${AGENT}.rpc`);
  });

  test("exec runs through the agent and returns stdout/exitCode", async () => {
    const mock = new MockAgentResponder({ hostname: "vm-1" });
    const session = sessionWith(mock);
    const res = await session.exec({ cmd: "echo hi" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("echo hi");
    // The request was addressed to the agent subject.
    expect(mock.requests[0]?.subject).toBe(subjectFor(WS, AGENT));
    expect(mock.requests[0]?.req.op?.$case).toBe("exec");
  });

  test("exec surfaces $HOSTNAME from the machine", async () => {
    const mock = new MockAgentResponder({ hostname: "the-vm" });
    const res = await sessionWith(mock).exec({ cmd: "echo $HOSTNAME" });
    expect(res.stdout.trim()).toBe("the-vm");
  });

  test("writeFile then readFile round-trips through the mock (binary-safe)", async () => {
    const mock = new MockAgentResponder();
    const session = sessionWith(mock);
    const wrote = await session.writeFile({ path: "/tmp/marker", content: "hello machine" });
    expect(wrote).toBe("hello machine".length);
    const bytes = await session.readFile({ path: "/tmp/marker" });
    expect(new TextDecoder().decode(bytes)).toBe("hello machine");
    // And the mock observed the bytes.
    expect(mock.fileText("/tmp/marker")).toBe("hello machine");
  });

  test("readFile of a missing path surfaces an OS NotFound (not a box-gone NotFound)", async () => {
    const mock = new MockAgentResponder();
    const session = sessionWith(mock);
    let err: unknown;
    try {
      await session.readFile({ path: "/tmp/does-not-exist" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SelfhostedControlError);
    expect((err as SelfhostedControlError).code).toBe(ErrorCode.ERROR_CODE_NOT_FOUND);
    expect((err as SelfhostedControlError).osNotFound).toBe(true);
    // crucially: an OS NotFound does NOT flip the provider-NotFound discriminator.
    expect(isSelfhostedProviderNotFoundError(err)).toBe(false);
  });

  test("resolveExposedPort returns the relay URL shape", async () => {
    const mock = new MockAgentResponder();
    const endpoint = await sessionWith(mock).resolveExposedPort(6080);
    expect(endpoint.host).toBe("relay.test");
    expect(endpoint.port).toBe(443);
    expect(endpoint.tls).toBe(true);
    expect(endpoint.query).toContain("channel=");
  });

  test("ping returns true against a live responder, false when offline", async () => {
    const mock = new MockAgentResponder();
    expect(await sessionWith(mock).ping()).toBe(true);
    mock.setOnline(false);
    expect(await sessionWith(mock).ping()).toBe(false);
  });

  test("the ControlRequest carries the session epoch (the fence)", async () => {
    const mock = new MockAgentResponder();
    const session = sessionWith(mock, 7);
    await session.exec({ cmd: "true" });
    expect(mock.requests[0]?.req.epoch).toBe(7);
  });
});

describe("AgentError → runtime reason mapping (the M3 ruling)", () => {
  const err = (code: ErrorCode, retryable = false): AgentError => ({ code, message: `e${code}`, retryable, detail: {} });

  test("AGENT_OFFLINE → agent_offline, NOT a NotFound", () => {
    const mapped = agentErrorToControlError(err(ErrorCode.ERROR_CODE_AGENT_OFFLINE));
    expect(mapped.reason).toBe("agent_offline");
    expect(mapped.agentOffline).toBe(true);
    expect(mapped.osNotFound).toBe(false);
    expect(isProviderSandboxNotFoundError("selfhosted", mapped)).toBe(false);
  });

  test("TIMEOUT → agent_reconnecting + retryable (the turn pauses + retries)", () => {
    const mapped = agentErrorToControlError(err(ErrorCode.ERROR_CODE_TIMEOUT, true));
    expect(mapped.reason).toBe("agent_reconnecting");
    expect(mapped.retryable).toBe(true);
  });

  test("CONSENT_REQUIRED → consent_required", () => {
    expect(agentErrorToControlError(err(ErrorCode.ERROR_CODE_CONSENT_REQUIRED)).reason).toBe("consent_required");
  });

  test("DRAINING → no capability reason, retryable + draining", () => {
    const mapped = agentErrorToControlError(err(ErrorCode.ERROR_CODE_DRAINING));
    expect(mapped.reason).toBeNull();
    expect(mapped.retryable).toBe(true);
    expect(mapped.draining).toBe(true);
  });

  test("FENCED → no capability reason, retryable + fenced (epoch re-resolve)", () => {
    const mapped = agentErrorToControlError(err(ErrorCode.ERROR_CODE_FENCED));
    expect(mapped.reason).toBeNull();
    expect(mapped.retryable).toBe(true);
    expect(mapped.fenced).toBe(true);
  });

  test("NOT_FOUND → osNotFound, no machine-liveness reason", () => {
    const mapped = agentErrorToControlError(err(ErrorCode.ERROR_CODE_NOT_FOUND));
    expect(mapped.reason).toBeNull();
    expect(mapped.osNotFound).toBe(true);
  });

  test("a no-responder ControlResponse maps to agent_offline", () => {
    const res = offlineControlResponse("req-1");
    expect(res.error?.code).toBe(ErrorCode.ERROR_CODE_AGENT_OFFLINE);
    expect(agentErrorToControlError(res.error!).reason).toBe("agent_offline");
  });

  test("a request-timeout ControlResponse maps to agent_reconnecting", () => {
    const res = timeoutControlResponse("req-1");
    expect(res.error?.code).toBe(ErrorCode.ERROR_CODE_TIMEOUT);
    expect(agentErrorToControlError(res.error!).reason).toBe("agent_reconnecting");
  });

  test("an offline mock surfaces agent_offline on exec (never a NotFound)", async () => {
    const mock = new MockAgentResponder({ online: false });
    let err: unknown;
    try {
      await sessionWith(mock).exec({ cmd: "true" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SelfhostedControlError);
    expect((err as SelfhostedControlError).reason).toBe("agent_offline");
    expect(isProviderSandboxNotFoundError("selfhosted", err)).toBe(false);
  });
});

describe("isProviderSandboxNotFoundError — selfhosted ALWAYS false (no rival cold-create)", () => {
  test("returns false for every selfhosted error shape (offline / 404 / terminated text)", () => {
    // Even a literal '404'/'not found'/'terminated' that flips Modal stays FALSE
    // for selfhosted — the machine is not recreatable.
    for (const e of [
      { status: 404 },
      new Error("sandbox not found"),
      new Error("box no longer running"),
      new Error("has been terminated"),
      { code: "AGENT_OFFLINE", message: "no responders" },
      undefined,
    ]) {
      expect(isProviderSandboxNotFoundError("selfhosted", e)).toBe(false);
    }
  });

  test("Modal's discriminator is unaffected (404 still true for modal)", () => {
    expect(isProviderSandboxNotFoundError("modal", { status: 404 })).toBe(true);
    expect(isProviderSandboxNotFoundError("modal", new Error("sandbox not found"))).toBe(true);
  });
});

describe("SelfhostedSandboxClient — create/resume bind + serialize round-trips {agentId}", () => {
  function client(agentId?: string): SelfhostedSandboxClient {
    const rpc: ControlRpc = new MockAgentResponder();
    return new SelfhostedSandboxClient({
      workspaceId: WS,
      relay: RELAY,
      controlRpcFactory: () => rpc,
      ...(agentId ? { agentId } : {}),
    });
  }

  test("backendId is selfhosted (the resume fence + registry invariant)", () => {
    expect(client(AGENT).backendId).toBe("selfhosted");
  });

  test("create() binds a session to the live subject", async () => {
    const session = await client(AGENT).create();
    expect(session).toBeInstanceOf(SelfhostedSession);
    expect(session.agentId).toBe(AGENT);
  });

  test("resume(state) re-addresses the subject from {agentId} (no provider state)", async () => {
    const session = await client().resume({ agentId: "agent-from-state" });
    expect(session.agentId).toBe("agent-from-state");
  });

  test("serializeSessionState → {agentId} ONLY; deserialize round-trips it", async () => {
    const c = client(AGENT);
    const serialized = await c.serializeSessionState({ agentId: AGENT });
    expect(serialized).toEqual({ agentId: AGENT });
    const back = await c.deserializeSessionState(serialized as unknown as Record<string, unknown>);
    expect(back).toEqual({ agentId: AGENT });
  });

  test("deserialize reads agentId nested under providerState (envelope shape)", async () => {
    const back = await client().deserializeSessionState({ providerState: { agentId: "nested" } });
    expect(back).toEqual({ agentId: "nested" });
  });

  test("selfhosted is not persistable (no owned state to snapshot)", async () => {
    expect(await client(AGENT).canPersistOwnedSessionState()).toBe(false);
  });

  test("a live SelfhostedSession serializes its own state to {agentId}", async () => {
    const session = sessionWith(new MockAgentResponder());
    expect(await session.serializeSessionState()).toEqual({ agentId: AGENT });
  });
});

describe("NatsControlRpc — offline-until-NATS (boot never requires a live NATS)", () => {
  test("a null connection factory surfaces agent_offline (never throws)", async () => {
    // Build a session whose client uses the default registry factory shape: a
    // NatsControlRpc with a null connection → offline.
    const { NatsControlRpc } = await import("../src/sandbox");
    const rpc = new NatsControlRpc(async () => null);
    const session = sessionWith(rpc);
    let err: unknown;
    try {
      await session.exec({ cmd: "true" });
    } catch (e) {
      err = e;
    }
    expect((err as SelfhostedControlError).reason).toBe("agent_offline");
  });

  test("a no-responders transport error maps to agent_offline (never NotFound)", async () => {
    const { NatsControlRpc } = await import("../src/sandbox");
    const rpc = new NatsControlRpc(async () => ({
      request: async () => {
        const e = new Error("503 no responders");
        (e as { code?: string }).code = "503";
        throw e;
      },
    }));
    const res = await rpc.request("agent.x.y.rpc", { requestId: "r", epoch: 0, op: { $case: "ping", ping: { nonce: "1" } } } as ControlRequest, { timeoutMs: 10 });
    expect(res.error?.code).toBe(ErrorCode.ERROR_CODE_AGENT_OFFLINE);
  });

  test("a request-timeout transport error maps to agent_reconnecting", async () => {
    const { NatsControlRpc } = await import("../src/sandbox");
    const rpc = new NatsControlRpc(async () => ({
      request: async () => {
        const e = new Error("TIMEOUT");
        (e as { code?: string }).code = "TIMEOUT";
        throw e;
      },
    }));
    const res = await rpc.request("agent.x.y.rpc", { requestId: "r", epoch: 0, op: { $case: "ping", ping: { nonce: "1" } } } as ControlRequest, { timeoutMs: 10 });
    expect(res.error?.code).toBe(ErrorCode.ERROR_CODE_TIMEOUT);
  });

  test("a live connection round-trips an encoded ControlRequest/Response", async () => {
    const { NatsControlRpc } = await import("../src/sandbox");
    // A fake NATS connection that decodes the request, answers a ping, re-encodes.
    const rpc = new NatsControlRpc(async () => ({
      request: async (_subject: string, payload: Uint8Array) => {
        const req = ControlRequest.decode(payload);
        const res: ControlResponse = {
          requestId: req.requestId,
          error: undefined,
          result: { $case: "ping", ping: { nonce: req.op?.$case === "ping" ? req.op.ping.nonce : "", agentMonotonicMs: "1" } },
        };
        return { data: ControlResponse.encode(res).finish() };
      },
    }));
    const session = sessionWith(rpc);
    expect(await session.ping("42")).toBe(true);
  });
});
