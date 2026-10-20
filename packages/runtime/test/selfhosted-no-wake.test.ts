// A housekeeping request never wakes a sleeping sandbox: one attempt with the
// no-wake header, no replay negotiation, no redelivery, and nothing done on
// "no responders". Whatever keeps the agent from answering is a typed "not
// answered", which records nothing.

import { describe, expect, test } from "bun:test";
import { ControlRequest, ControlResponse, OpLostReason, OpState } from "@opengeni/agent-proto";
import {
  NatsControlRpc,
  requestWithoutWaking,
  type ControlRpc,
  type NatsRequestConnection,
} from "../src/sandbox/selfhosted/control-rpc";
import {
  AGENT_LINK_LOST_HEADER,
  AGENT_UNANSWERED_HEADER,
  NO_WAKE_HEADER,
} from "../src/sandbox/selfhosted/control-replay";
import { releaseSelfhostedOpOutput } from "../src/sandbox/selfhosted/op-stream";

const subject = "agent.workspace.machine.connection.process.rpc";
const query = ControlRequest.fromPartial({
  requestId: "housekeeping",
  op: { $case: "opQuery", opQuery: { opId: "op-1" } },
});
const answer = ControlResponse.fromPartial({
  requestId: query.requestId,
  result: {
    $case: "opStatus",
    opStatus: {
      opId: "op-1",
      state: OpState.OP_STATE_LOST,
      lostReason: OpLostReason.OP_LOST_REASON_RELEASED,
    },
  },
});
const headerOf = (name: string, value: string) => ({
  get: (header: string) => (header === name ? value : ""),
});

type Sent = { subject: string; resendOn?: string; headers?: Record<string, string>; op?: string };

/** A transport that records every request and answers it with `reply`. */
function transport(
  reply: () => Promise<{ data: Uint8Array; headers?: { get(name: string): string } }>,
) {
  const sent: Sent[] = [];
  const woken: string[] = [];
  const connection: NatsRequestConnection = {
    supportsHeaders: true,
    async request(target, payload, options) {
      sent.push({
        subject: target,
        ...(options.resendOn ? { resendOn: options.resendOn } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        op: ControlRequest.decode(payload).op?.$case ?? "none",
      });
      return await reply();
    },
  };
  const rpc = new NatsControlRpc(async () => connection, {
    recoveryMs: 1_000,
    onNoResponders: async (target) => {
      woken.push(target);
      return false;
    },
  });
  return { rpc, sent, woken };
}

const noResponders = () => Object.assign(new Error("503 no responders"), { code: "503" });
const timedOut = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });

describe("a no-wake request", () => {
  test("is one plain attempt carrying the no-wake header, with no replay probe or redelivery", async () => {
    const { rpc, sent, woken } = transport(async () => ({
      data: ControlResponse.encode(answer).finish(),
    }));
    const reply = await requestWithoutWaking(rpc, subject, query, { timeoutMs: 1_000 });
    expect(reply).toEqual({ answered: true, response: answer });
    expect(sent).toEqual([{ subject, headers: { [NO_WAKE_HEADER]: "1" }, op: "opQuery" }]);
    expect(woken).toEqual([]);
  });

  for (const reason of ["asleep", "away", "busy"]) {
    test(`the host's "${reason}" is not answered, with its reason`, async () => {
      const { rpc, sent, woken } = transport(async () => ({
        data: new Uint8Array(0),
        headers: headerOf(AGENT_UNANSWERED_HEADER, reason),
      }));
      expect(await requestWithoutWaking(rpc, subject, query, { timeoutMs: 1_000 })).toEqual({
        answered: false,
        reason,
      });
      expect(sent).toHaveLength(1);
      expect(woken).toEqual([]);
    });
  }

  test("no responders, a lost link and a timeout are not answered, and nothing is woken or retried", async () => {
    const cases: Array<
      [string, () => Promise<{ data: Uint8Array; headers?: { get(name: string): string } }>]
    > = [
      ["no_responders", async () => Promise.reject(noResponders())],
      [
        "link_lost",
        async () => ({ data: new Uint8Array(0), headers: headerOf(AGENT_LINK_LOST_HEADER, "1") }),
      ],
      ["timeout", async () => Promise.reject(timedOut())],
    ];
    for (const [reason, reply] of cases) {
      const { rpc, sent, woken } = transport(reply);
      expect(await requestWithoutWaking(rpc, subject, query, { timeoutMs: 1_000 })).toEqual({
        answered: false,
        reason,
      });
      expect(sent).toHaveLength(1);
      expect(woken).toEqual([]);
    }
    // No transport at all.
    const offline = new NatsControlRpc(async () => null);
    expect(await requestWithoutWaking(offline, subject, query, { timeoutMs: 1_000 })).toEqual({
      answered: false,
      reason: "offline",
    });
  });

  test("an agent's own reply is its answer even if it names the unanswered header", async () => {
    const { rpc } = transport(async () => ({
      data: ControlResponse.encode(answer).finish(),
      headers: headerOf(AGENT_UNANSWERED_HEADER, "asleep"),
    }));
    expect(await requestWithoutWaking(rpc, subject, query, { timeoutMs: 1_000 })).toEqual({
      answered: true,
      response: answer,
    });
  });

  test("negative control: the same request sent the waking way negotiates replay and asks to wake on no responders", async () => {
    const { rpc, sent, woken } = transport(async () => Promise.reject(noResponders()));
    await rpc.request(subject, query, { timeoutMs: 200 });
    expect(sent[0]?.op).toBe("ping");
    expect(sent.every((request) => request.headers === undefined)).toBe(true);
    expect(woken).toEqual([subject]);
  });
});

describe("an output release", () => {
  test("is sent without waking, and an unanswered one is reported as such", async () => {
    const seen: Array<boolean | undefined> = [];
    const rpc = (reply: ControlResponse): ControlRpc => ({
      request: async (_subject, request, opts) => {
        seen.push(opts.noWake);
        return { ...reply, requestId: request.requestId };
      },
    });
    const input = { rpcSubject: subject, opId: "op-1", exitSeq: "2", controlTimeoutMs: 1_000 };
    expect(await releaseSelfhostedOpOutput({ ...input, controlRpc: rpc(answer) })).toBe("released");
    const { rpc: asleep } = transport(async () => ({
      data: new Uint8Array(0),
      headers: headerOf(AGENT_UNANSWERED_HEADER, "asleep"),
    }));
    expect(await releaseSelfhostedOpOutput({ ...input, controlRpc: asleep })).toBe("not_answered");
    expect(seen).toEqual([true]);
  });
});
