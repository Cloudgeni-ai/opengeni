// The per-op observation seam (out-of-band telemetry). One observation fires per
// completed control op at the `SelfhostedSession.call` exit points, carrying the
// op-shaped fields the metrics + machine.* sinks (and the future op-stream client)
// consume: op / outcome / healed / retries / code / reason / neverSent / replyBytes.

import { describe, expect, test } from "bun:test";
import { type ControlRequest, type ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  type ControlRpc,
  FakeOpRunner,
  type FakeOpScript,
  InMemoryOpStreamTransport,
  type SelfhostedOpObservation,
  type SelfhostedRetryClock,
  SelfhostedSession,
  offlineAgentError,
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

function opStreamSessionWith(
  script: FakeOpScript,
  onOp?: (o: SelfhostedOpObservation) => void,
): SelfhostedSession {
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    transport,
    workspaceId: WS,
    agentId: AGENT,
    defaultScript: () => script,
  });
  return new SelfhostedSession({
    workspaceId: WS,
    agentId: AGENT,
    controlRpc: runner,
    opStream: { transport },
    relay: RELAY,
    retryClock: fakeClock,
    ...(onOp ? { onOp } : {}),
  });
}

describe("SelfhostedOpObserver — one observation per completed op", () => {
  test("a clean success: outcome ok, not healed, zero retries", async () => {
    const seen: SelfhostedOpObservation[] = [];
    await opStreamSessionWith({ frames: [{ channel: "stdout", bytes: "ok\n" }] }, (o) =>
      seen.push(o),
    ).exec({ cmd: "true" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: "exec", outcome: "ok", healed: false, retries: 0 });
    expect(seen[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a success after a retry is marked healed with the retry count", async () => {
    const seen: SelfhostedOpObservation[] = [];
    await opStreamSessionWith(
      { frames: [{ channel: "stdout", bytes: "ok\n" }], drainingStarts: 2 },
      (o) => seen.push(o),
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
    let threw = false;
    try {
      await opStreamSessionWith(
        { frames: [], startError: offlineAgentError(undefined, true) },
        (o) => seen.push(o),
      ).exec({ cmd: "true" });
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
    // Failed starts carry the typed terminal fault; retry counts are reported on
    // healed outcomes, while this terminal observation remains unhealed.
    expect(seen[0]!.retries).toBe(0);
  });

  test("a PAYLOAD_TOO_LARGE start refusal carries the typed payload fault", async () => {
    const seen: SelfhostedOpObservation[] = [];
    let threw = false;
    try {
      await opStreamSessionWith(
        {
          frames: [],
          startError: {
            code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
            message: "too big",
            retryable: false,
            detail: { encoded_bytes: "1500000", max_payload: "1048576" },
          },
        },
        (o) => seen.push(o),
      ).exec({ cmd: "cat big" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(seen[0]).toMatchObject({
      outcome: "failed",
      code: ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE,
      faultClass: "payload_too_large",
    });
    expect(seen[0]!.replyBytes).toBeUndefined();
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
    const session = new SelfhostedSession({
      workspaceId: WS,
      agentId: AGENT,
      controlRpc: rpc,
      relay: RELAY,
      retryClock: fakeClock,
      onOp: (o) => seen.push(o),
    });
    await session.statFile({ path: "/x" });
    expect(seen[0]).toMatchObject({ op: "fsStat", outcome: "ok" });
  });

  test("a throwing observer never breaks the op", async () => {
    const res = await opStreamSessionWith(
      { frames: [{ channel: "stdout", bytes: "ok\n" }] },
      () => {
        throw new Error("sink blew up");
      },
    ).exec({ cmd: "true" });
    expect(res.exitCode).toBe(0);
  });

  test("no observer wired is a clean no-op", async () => {
    const session = opStreamSessionWith({
      frames: [{ channel: "stdout", bytes: "ok\n" }],
    });
    expect((await session.exec({ cmd: "true" })).exitCode).toBe(0);
  });
});
