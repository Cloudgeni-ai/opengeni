// The per-op observation seam (out-of-band telemetry). One observation fires per
// completed control op at the `SelfhostedSession.call` exit points, carrying the
// op-shaped fields the metrics + machine.* sinks (and the future op-stream client)
// consume: op / outcome / healed / retries / code / reason / neverSent / replyBytes.

import { describe, expect, test } from "bun:test";
import { type ControlRequest, type ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  type ControlRpc,
  type SelfhostedOpObservation,
  type SelfhostedRetryClock,
  SelfhostedSession,
  offlineControlResponse,
} from "../src/sandbox";

const WS = "11111111-1111-1111-1111-111111111111";
const AGENT = "agent-abc";
const RELAY = { host: "relay.test", port: 443, tls: true } as const;
const encoder = new TextEncoder();

type Step = (req: ControlRequest) => ControlResponse;
class ScriptedRpc implements ControlRpc {
  readonly requests: ControlRequest[] = [];
  constructor(private readonly steps: Step[]) {}
  async request(_s: string, req: ControlRequest): Promise<ControlResponse> {
    this.requests.push(req);
    return this.steps[Math.min(this.requests.length - 1, this.steps.length - 1)]!(req);
  }
}
const fakeClock: SelfhostedRetryClock = { sleep: async () => {}, jitter: () => 0 };

function execOk(req: ControlRequest): ControlResponse {
  return {
    requestId: req.requestId,
    error: undefined,
    result: {
      $case: "exec",
      exec: {
        exitCode: 0,
        stdout: encoder.encode("ok\n"),
        stderr: new Uint8Array(0),
        timedOut: false,
        durationMs: "1",
      },
    },
  };
}
function drainingStep(req: ControlRequest): ControlResponse {
  return {
    requestId: req.requestId,
    error: { code: ErrorCode.ERROR_CODE_DRAINING, message: "full", retryable: true, detail: {} },
    result: undefined,
  };
}
function payloadStep(req: ControlRequest): ControlResponse {
  return {
    requestId: req.requestId,
    error: {
      code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
      message: "too big",
      retryable: false,
      detail: { encoded_bytes: "1500000", max_payload: "1048576" },
    },
    result: undefined,
  };
}

function sessionWith(
  rpc: ControlRpc,
  onOp: (o: SelfhostedOpObservation) => void,
): SelfhostedSession {
  return new SelfhostedSession({
    workspaceId: WS,
    agentId: AGENT,
    controlRpc: rpc,
    relay: RELAY,
    retryClock: fakeClock,
    onOp,
  });
}

describe("SelfhostedOpObserver — one observation per completed op", () => {
  test("a clean success: outcome ok, not healed, zero retries", async () => {
    const seen: SelfhostedOpObservation[] = [];
    await sessionWith(new ScriptedRpc([execOk]), (o) => seen.push(o)).exec({ cmd: "true" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: "exec", outcome: "ok", healed: false, retries: 0 });
    expect(seen[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a success after a retry is marked healed with the retry count", async () => {
    const seen: SelfhostedOpObservation[] = [];
    await sessionWith(new ScriptedRpc([drainingStep, drainingStep, execOk]), (o) =>
      seen.push(o),
    ).exec({ cmd: "true" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      op: "exec",
      outcome: "ok",
      healed: true,
      retries: 2,
      // A healed op's class is whichever budget it recovered from (draining here).
      faultClass: "draining",
      machineId: AGENT,
    });
  });

  test("a terminal fault: outcome failed with the typed code + reason + neverSent", async () => {
    const seen: SelfhostedOpObservation[] = [];
    // A never-sent offline fault (pre-send): retried the never-sent budget, then fails.
    const rpc = new ScriptedRpc([(req) => offlineControlResponse(req.requestId, true)]);
    let threw = false;
    try {
      await sessionWith(rpc, (o) => seen.push(o)).exec({ cmd: "true" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      op: "exec",
      outcome: "failed",
      healed: false,
      code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
      reason: "agent_offline",
      neverSent: true,
      faultClass: "offline",
      machineId: AGENT,
    });
    expect(seen[0]!.retries).toBeGreaterThan(0);
  });

  test("a PAYLOAD_TOO_LARGE fault carries replyBytes from the agent detail", async () => {
    const seen: SelfhostedOpObservation[] = [];
    let threw = false;
    try {
      await sessionWith(new ScriptedRpc([payloadStep]), (o) => seen.push(o)).exec({
        cmd: "cat big",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(seen[0]).toMatchObject({
      outcome: "failed",
      code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
      replyBytes: 1_500_000,
    });
  });

  test("a fs op reports its own op kind", async () => {
    const seen: SelfhostedOpObservation[] = [];
    const rpc = new ScriptedRpc([
      (req) => ({
        requestId: req.requestId,
        error: undefined,
        result: { $case: "fsStat", fsStat: { exists: true, entry: undefined } },
      }),
    ]);
    await sessionWith(rpc, (o) => seen.push(o)).statFile({ path: "/x" });
    expect(seen[0]).toMatchObject({ op: "fsStat", outcome: "ok" });
  });

  test("a throwing observer never breaks the op", async () => {
    const res = await sessionWith(new ScriptedRpc([execOk]), () => {
      throw new Error("sink blew up");
    }).exec({ cmd: "true" });
    expect(res.exitCode).toBe(0);
  });

  test("no observer wired is a clean no-op", async () => {
    const session = new SelfhostedSession({
      workspaceId: WS,
      agentId: AGENT,
      controlRpc: new ScriptedRpc([execOk]),
      relay: RELAY,
      retryClock: fakeClock,
    });
    expect((await session.exec({ cmd: "true" })).exitCode).toBe(0);
  });
});
