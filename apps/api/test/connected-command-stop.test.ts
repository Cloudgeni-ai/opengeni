import { describe, expect, test } from "bun:test";
import { ControlResponse, OpState, OpStatus, type ControlRequest } from "@opengeni/agent-proto";
import { subjectFor, type ControlRpc } from "@opengeni/runtime/sandbox";
import { deliverConnectedCommandStop } from "../src/sandbox/command-completion";

const target = {
  controlWorkspaceId: crypto.randomUUID(),
  enrollmentId: crypto.randomUUID(),
  connectionInstanceId: "launch",
  opId: crypto.randomUUID(),
};

function rpc(
  answer: (subject: string, request: ControlRequest) => ControlResponse | Promise<never>,
): ControlRpc & { calls: Array<{ subject: string; request: ControlRequest; timeoutMs: number }> } {
  const calls: Array<{ subject: string; request: ControlRequest; timeoutMs: number }> = [];
  return {
    calls,
    async request(subject, request, opts) {
      calls.push({ subject, request, timeoutMs: opts.timeoutMs });
      return await answer(subject, request);
    },
  };
}

describe("immediate background command stop", () => {
  test("cancels the exact operation at its frozen locator", async () => {
    const control = rpc((_subject, request) =>
      ControlResponse.fromPartial({
        requestId: request.requestId,
        result: {
          $case: "opStatus",
          opStatus: OpStatus.fromPartial({ opId: target.opId, state: OpState.OP_STATE_RUNNING }),
        },
      }),
    );
    expect(await deliverConnectedCommandStop(control, target, 5_000)).toEqual({ delivered: true });
    expect(control.calls).toHaveLength(1);
    const [call] = control.calls;
    expect(call!.subject).toBe(
      subjectFor(target.controlWorkspaceId, target.enrollmentId, target.connectionInstanceId),
    );
    expect(call!.timeoutMs).toBe(5_000);
    expect(call!.request.epoch).toBe(0);
    expect(call!.request.op).toEqual({ $case: "opCancel", opCancel: { opId: target.opId } });
  });

  test("a failed delivery is reported, not thrown, so the reconciler can deliver it", async () => {
    const control = rpc(async () => {
      throw new Error("no responders");
    });
    expect(await deliverConnectedCommandStop(control, target, 5_000)).toEqual({
      delivered: false,
      error: "no responders",
    });
  });
});
