import { describe, expect, test } from "bun:test";
import {
  OpLostReason,
  OpState,
  type ControlRequest,
  type ControlResponse,
  type OpStatus,
} from "@opengeni/agent-proto";
import type {
  ConnectedMachineBackgroundCommandClaim,
  ConnectedMachineBackgroundCommandProof,
} from "@opengeni/db/session-background-commands";
import type { ControlRpc } from "@opengeni/runtime/sandbox";
import {
  connectedCommandProofFromStatus,
  probeConnectedMachineBackgroundCommand,
} from "../src/activities/sandbox-lease";

function claim(state: "running" | "stopping"): ConnectedMachineBackgroundCommandClaim {
  return {
    commandId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    sessionId: "44444444-4444-4444-8444-444444444444",
    claimId: "55555555-5555-4555-8555-555555555555",
    state,
    controlWorkspaceId: "66666666-6666-4666-8666-666666666666",
    enrollmentId: "77777777-7777-4777-8777-777777777777",
    connectionInstanceId: "launch-instance",
    opId: "durable-op",
    reconcileAttempts: 1,
    proof: null,
  };
}

function status(state: OpState, overrides: Partial<OpStatus> = {}): OpStatus {
  return {
    opId: "durable-op",
    state,
    nextSeq: "1",
    exit: undefined,
    lostReason: OpLostReason.OP_LOST_REASON_UNSPECIFIED,
    ...overrides,
  };
}

function rpc(answer: OpStatus) {
  const requests: Array<{ subject: string; request: ControlRequest; timeoutMs: number }> = [];
  const controlRpc: ControlRpc = {
    request: async (subject, request, opts): Promise<ControlResponse> => {
      requests.push({ subject, request, timeoutMs: opts.timeoutMs });
      return {
        requestId: request.requestId,
        error: undefined,
        result: { $case: "opStatus", opStatus: answer },
      };
    },
  };
  return { controlRpc, requests };
}

describe("Connected Machine background-command reconciliation", () => {
  test("running commands query only the immutable launch subject with epoch zero", async () => {
    const { controlRpc, requests } = rpc(status(OpState.OP_STATE_RUNNING));

    expect(await probeConnectedMachineBackgroundCommand(claim("running"), controlRpc, 4_000)).toBe(
      null,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      subject:
        "agent.66666666-6666-4666-8666-666666666666.77777777-7777-4777-8777-777777777777.connection.launch-instance.rpc",
      timeoutMs: 4_000,
      request: {
        epoch: 0,
        op: { $case: "opQuery", opQuery: { opId: "durable-op" } },
      },
    });
  });

  test("stopping commands issue exact idempotent OpCancel and classify its terminal exit", async () => {
    const observedAt = new Date("2026-08-23T00:00:00.000Z");
    const { controlRpc, requests } = rpc(
      status(OpState.OP_STATE_COMPLETE, {
        exit: {
          exitCode: -1,
          timedOut: false,
          cancelled: true,
          durationMs: "25",
          digests: {},
          totals: {},
          failureCode: "",
          failureDetail: {},
        },
      }),
    );

    expect(
      await probeConnectedMachineBackgroundCommand(
        claim("stopping"),
        controlRpc,
        5_000,
        observedAt,
      ),
    ).toEqual({
      outcome: "exited",
      exitCode: -1,
      reason: "op_cancelled",
      observedAt,
    } satisfies ConnectedMachineBackgroundCommandProof);
    expect(requests[0]?.request).toMatchObject({
      epoch: 0,
      op: { $case: "opCancel", opCancel: { opId: "durable-op" } },
    });
  });

  test("typed runner loss remains loss proof instead of being rebound or replayed", () => {
    const observedAt = new Date("2026-08-23T00:00:00.000Z");
    expect(
      connectedCommandProofFromStatus(
        status(OpState.OP_STATE_LOST, {
          lostReason: OpLostReason.OP_LOST_REASON_AGENT_RESTARTED,
        }),
        observedAt,
      ),
    ).toEqual({
      outcome: "lost",
      exitCode: null,
      reason: "op_lost_agent_restarted",
      observedAt,
    });
  });

  test("a malformed complete status is never accepted as physical proof", () => {
    expect(() =>
      connectedCommandProofFromStatus(status(OpState.OP_STATE_COMPLETE), new Date()),
    ).toThrow("completed without an exit record");
  });
});
