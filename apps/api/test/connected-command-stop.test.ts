import { describe, expect, test } from "bun:test";
import { ControlRequest, ControlResponse, OpState, OpStatus } from "@opengeni/agent-proto";
import type { Database } from "@opengeni/db";
import { subjectFor, type ControlRpc, type NatsRequestConnection } from "@opengeni/runtime/sandbox";
import {
  connectedCommandStopRpc,
  deliverConnectedCommandStop,
} from "../src/sandbox/command-completion";

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

const rpcSubject = subjectFor(
  target.controlWorkspaceId,
  target.enrollmentId,
  target.connectionInstanceId,
);

function noResponders(): Error {
  return Object.assign(new Error("503"), { code: "503" });
}

/** An agent that answers once `serving()` is true; nobody receives the
 * request before. It negotiates replayable control like a current agent. */
function agentConnection(serving: () => boolean) {
  const subjects: string[] = [];
  const connection: NatsRequestConnection = {
    supportsHeaders: true,
    async request(subject, payload) {
      subjects.push(subject);
      if (!serving()) throw noResponders();
      const request = ControlRequest.decode(payload);
      const result =
        request.op?.$case === "ping"
          ? { $case: "ping" as const, ping: { nonce: request.op.ping.nonce } }
          : {
              $case: "opStatus" as const,
              opStatus: OpStatus.fromPartial({
                opId: target.opId,
                state: OpState.OP_STATE_RUNNING,
              }),
            };
      return {
        data: ControlResponse.encode(
          ControlResponse.fromPartial({ requestId: request.requestId, result }),
        ).finish(),
        headers: { get: (name: string) => (name === "Opengeni-Control-Replay" ? "1" : "") },
      };
    },
  };
  return { connection, subjects };
}

const noCompute = { computeApiUrl: undefined, computeApiKey: undefined };
const unusedDb = {} as Database;

describe("the immediate stop's budget", () => {
  test("answers within its budget whatever the transport does", async () => {
    const hung: ControlRpc = { request: () => new Promise(() => {}) };
    const startedAt = performance.now();
    expect(await deliverConnectedCommandStop(hung, target, 100)).toEqual({
      delivered: false,
      error: "not delivered within 100 ms",
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("one budget covers negotiation, retries and the cancel; nothing runs past it", async () => {
    const agent = agentConnection(() => false);
    const startedAt = performance.now();
    const delivery = await deliverConnectedCommandStop(
      connectedCommandStopRpc({
        db: unusedDb,
        settings: noCompute,
        connect: async () => agent.connection,
        budgetMs: 300,
      }),
      target,
      300,
    );
    expect(delivery.delivered).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    // The transport itself stopped at the budget: no retry follows the answer.
    const attempts = agent.subjects.length;
    expect(attempts).toBeGreaterThan(0);
    await Bun.sleep(600);
    expect(agent.subjects.length).toBe(attempts);
    expect(agent.subjects.every((subject) => subject === rpcSubject)).toBe(true);
  });

  test("a stop no host receives wakes the compute sandbox and reaches the same locator", async () => {
    let woken = false;
    const wakes: string[] = [];
    const lookups: Array<{ workspaceId: string; enrollmentId: string }> = [];
    const agent = agentConnection(() => woken);
    const delivery = await deliverConnectedCommandStop(
      connectedCommandStopRpc({
        db: unusedDb,
        settings: noCompute,
        connect: async () => agent.connection,
        budgetMs: 3_000,
        compute: {
          fabric: {
            wake: async (sandboxId) => {
              wakes.push(sandboxId);
              woken = true;
              return {} as never;
            },
          },
          sandboxOf: async (agentId) => {
            lookups.push(agentId);
            return "box-1";
          },
        },
      }),
      target,
      3_000,
    );
    expect(delivery).toEqual({ delivered: true });
    expect(wakes).toEqual(["box-1"]);
    expect(lookups).toEqual([
      { workspaceId: target.controlWorkspaceId, enrollmentId: target.enrollmentId },
    ]);
    // Negotiated, then delivered once, at the exact locator only.
    expect(agent.subjects[0]).toBe(rpcSubject);
    expect(agent.subjects.at(-1)!.startsWith(`${rpcSubject}.replay.`)).toBe(true);
  });

  test("a Connected Machine is not woken; its stop falls to the reconciler", async () => {
    const wakes: string[] = [];
    const agent = agentConnection(() => false);
    const delivery = await deliverConnectedCommandStop(
      connectedCommandStopRpc({
        db: unusedDb,
        settings: noCompute,
        connect: async () => agent.connection,
        budgetMs: 300,
        compute: {
          fabric: {
            wake: async (sandboxId) => {
              wakes.push(sandboxId);
              return {} as never;
            },
          },
          sandboxOf: async () => null,
        },
      }),
      target,
      300,
    );
    expect(delivery.delivered).toBe(false);
    expect(wakes).toEqual([]);
  });
});
