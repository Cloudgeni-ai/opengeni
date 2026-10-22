import { describe, expect, spyOn, test } from "bun:test";
import { ControlRequest, ControlResponse, ErrorCode } from "@opengeni/agent-proto";
import {
  agentErrorToControlError,
  connectionReplacedAgentError,
  NatsControlRpc,
  RESPONDER_WAIT_EXHAUSTED_DETAIL_KEY,
  timeoutAgentError,
} from "../src/sandbox/selfhosted/control-rpc";
import {
  AGENT_LINK_LOST_HEADER,
  ControlReplyRecovery,
} from "../src/sandbox/selfhosted/control-replay";
import { decideSelfhostedRetry } from "../src/sandbox/selfhosted/retry-policy";

const subject = "agent.workspace.machine.connection.process.rpc";
const mutation = ControlRequest.fromPartial({
  requestId: "original-request",
  op: { $case: "fsRemove", fsRemove: { path: "/tmp/synthetic", recursive: false } },
});
const result = ControlResponse.encode({ requestId: mutation.requestId }).finish();
const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
function leaseReply() {
  return {
    data: ControlResponse.encode(
      ControlResponse.fromPartial({
        requestId: "probe",
        result: {
          $case: "ping",
          ping: { controlReplayTokens: Array.from({ length: 64 }, () => crypto.randomUUID()) },
        },
      }),
    ).finish(),
    headers: { get: () => "2" },
  };
}

describe("control reply recovery", () => {
  test("warm calls have no negotiation round trip and replenish without blocking", async () => {
    let probes = 0;
    let releaseRefill: (() => void) | undefined;
    const deliveries: string[] = [];
    const connection = {
      supportsHeaders: true,
      async request(target: string) {
        if (target.endsWith(".rpc")) {
          probes++;
          if (probes === 2)
            await new Promise<void>((resolve) => {
              releaseRefill = resolve;
            });
          return leaseReply();
        }
        deliveries.push(target);
        return { data: result };
      },
    };
    const recovery = new ControlReplyRecovery();
    for (let index = 0; index < 60; index++) {
      await recovery.request(connection, subject, new Uint8Array(), 100);
    }
    expect(probes).toBe(2);
    expect(deliveries).toHaveLength(60);
    expect(
      new Set(deliveries.map((target) => target.split(".replay.")[1]?.split(".")[0])).size,
    ).toBe(60);
    for (let index = 60; index < 64; index++) {
      await recovery.request(connection, subject, new Uint8Array(), 100);
    }
    const exhausted = recovery.request(connection, subject, new Uint8Array(), 100);
    await Promise.resolve();
    expect(deliveries).toHaveLength(64);
    expect(probes).toBe(2); // Exhaustion joins the one refill already in flight.
    releaseRefill!();
    await exhausted;
    expect(deliveries).toHaveLength(65);
    // run_on creates a fresh RPC facade; it still shares the bus-scoped pool.
    await new ControlReplyRecovery().request(connection, subject, new Uint8Array(), 100);
    // A replacement process must not inherit another process's token pool.
    await recovery.request(
      connection,
      subject.replace("process", "successor"),
      new Uint8Array(),
      100,
    );
    expect(probes).toBe(3);
  });

  test("an exhausted pool shares the refill, and a longer budget obtains fresh tokens", async () => {
    let probes = 0;
    const connection = {
      supportsHeaders: true,
      async request(target: string) {
        if (target === subject) {
          probes++;
          return leaseReply();
        }
        return { data: result };
      },
    };
    const recovery = new ControlReplyRecovery(10);
    await Promise.all(
      Array.from({ length: 100 }, () =>
        recovery.request(connection, subject, new Uint8Array(), 1_000),
      ),
    );
    expect(probes).toBe(2);
    await recovery.request(connection, subject, new Uint8Array(), 10_000);
    expect(probes).toBe(3);
  });

  test("wall-clock jumps and correction do not change lease identity or the retry budget", async () => {
    const realNow = Date.now();
    const wall = spyOn(Date, "now");
    try {
      for (const offset of [7 * 3600_000, -7 * 3600_000, 0]) {
        wall.mockReturnValue(realNow + offset);
        const deliveries: string[] = [];
        let probes = 0;
        const rpc = new NatsControlRpc(async () => ({
          supportsHeaders: true,
          async request(target, payload) {
            if (target === subject) {
              probes++;
              const ping = ControlRequest.decode(payload).op;
              expect(ping?.$case).toBe("ping");
              if (ping?.$case === "ping") expect(ping.ping.controlReplayWindowMs).toBe("240200");
              return leaseReply();
            }
            deliveries.push(target);
            if (deliveries.length === 1) {
              wall.mockReturnValue(realNow + 24 * 3600_000);
              throw timeout();
            }
            wall.mockReturnValue(realNow);
            return { data: result };
          },
        }));
        expect((await rpc.request(subject, mutation, { timeoutMs: 100 })).error).toBeUndefined();
        expect(probes).toBe(1);
        expect(deliveries).toHaveLength(2);
        expect(deliveries[0]).toBe(deliveries[1]);
        expect(deliveries[0]).toMatch(/\.replay\.[0-9a-f-]{36}\.\d+\.120100$/);
      }
    } finally {
      wall.mockRestore();
    }
  });

  test("expired receipt replies stop promptly without erasing a prior uncertain execution", async () => {
    let probes = 0;
    let deliveries = 0;
    const refusal = ControlResponse.fromPartial({
      requestId: mutation.requestId,
      error: {
        code: ErrorCode.ERROR_CODE_PROTOCOL,
        message: "receipt expired; earlier execution may have occurred",
        retryable: false,
        detail: { failure_code: "control_delivery_expired", outcome_unknown: "true" },
      },
    });
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request(target) {
        if (target === subject) {
          probes++;
          return leaseReply();
        }
        deliveries++;
        if (deliveries === 1) throw timeout();
        return { data: ControlResponse.encode(refusal).finish() };
      },
    }));
    expect(await rpc.request(subject, mutation, { timeoutMs: 100 })).toEqual(refusal);
    expect(deliveries).toBe(2);
    expect(probes).toBe(1); // Never mint a new identity to retry the mutation.
    expect(refusal.error?.detail.never_sent).toBeUndefined();
  });

  test("a successor process that never issued the token gets the call again with a fresh one", async () => {
    // An agent self-update hands the same subject to a new process. Tokens the
    // old process issued are unknown to it, and it refuses them before running
    // anything, so a call whose only transmission was refused is sent again.
    let probes = 0;
    const deliveries: string[] = [];
    const refusal = ControlResponse.fromPartial({
      requestId: mutation.requestId,
      error: {
        code: ErrorCode.ERROR_CODE_PROTOCOL,
        message: "receipt expired or unknown",
        retryable: false,
        detail: { failure_code: "control_delivery_expired", outcome_unknown: "true" },
      },
    });
    let successorTokens = new Set<string>();
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request(target) {
        if (target === subject) {
          probes++;
          const reply = leaseReply();
          if (probes > 1) {
            const ping = ControlResponse.decode(reply.data).result;
            if (ping?.$case === "ping") successorTokens = new Set(ping.ping.controlReplayTokens);
          }
          return reply;
        }
        deliveries.push(target);
        const token = target.split(".replay.")[1]?.split(".")[0] ?? "";
        if (!successorTokens.has(token)) return { data: ControlResponse.encode(refusal).finish() };
        return { data: result };
      },
    }));
    // The first call draws a token from the predecessor's batch.
    expect((await rpc.request(subject, mutation, { timeoutMs: 100 })).error).toBeUndefined();
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).not.toBe(deliveries[1]);
    expect(probes).toBe(2);
    // Later calls use the successor's tokens directly.
    expect((await rpc.request(subject, mutation, { timeoutMs: 100 })).error).toBeUndefined();
    expect(deliveries).toHaveLength(3);
  });

  test("a v2 peer that omits its lease fails before publishing the mutation", async () => {
    let calls = 0;
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request() {
        calls++;
        return { data: result, headers: { get: () => "2" } };
      },
    }));
    expect((await rpc.request(subject, mutation, { timeoutMs: 100 })).error).toMatchObject({
      code: ErrorCode.ERROR_CODE_PROTOCOL,
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  test("a corrupt lease response remains a protocol error, never an offline retry", async () => {
    let calls = 0;
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request() {
        calls++;
        return { data: new Uint8Array([0xff]), headers: { get: () => "2" } };
      },
    }));
    expect((await rpc.request(subject, mutation, { timeoutMs: 100 })).error).toMatchObject({
      code: ErrorCode.ERROR_CODE_PROTOCOL,
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  test("a process that never answers within the recovery window is not waited for again", async () => {
    const rpc = new NatsControlRpc(
      async () => ({
        supportsHeaders: true,
        async request() {
          throw Object.assign(new Error("no responders"), { code: "503" });
        },
      }),
      { recoveryMs: 5 },
    );
    const response = await rpc.request(subject, mutation, { timeoutMs: 1 });
    expect(response.error?.detail[RESPONDER_WAIT_EXHAUSTED_DETAIL_KEY]).toBe("1");
    const error = agentErrorToControlError(response.error!, mutation.requestId);
    // Still provably never sent, but re-issuing would only wait the same window.
    expect(error.neverSent).toBe(true);
    expect(
      decideSelfhostedRetry({
        opKind: "browserControlEnsure",
        error,
        drainingRetries: 0,
        timeoutRetries: 0,
        neverSentRetries: 0,
        jitter: 0,
      }),
    ).toEqual({ action: "fail" });
  });

  test("a wake hook that outlasts the recovery window still spends it", async () => {
    let hooks = 0;
    const rpc = new NatsControlRpc(
      async () => ({
        supportsHeaders: true,
        async request() {
          throw Object.assign(new Error("no responders"), { code: "503" });
        },
      }),
      {
        // Room for one wake before the 250 ms retry delay, but the wake
        // itself spends the rest.
        recoveryMs: 300,
        onNoResponders: async () => {
          hooks += 1;
          await new Promise((resolve) => setTimeout(resolve, 120));
          return false;
        },
      },
    );
    const response = await rpc.request(subject, mutation, { timeoutMs: 1 });
    expect(hooks).toBe(1);
    expect(response.error?.detail[RESPONDER_WAIT_EXHAUSTED_DETAIL_KEY]).toBe("1");
    expect(
      decideSelfhostedRetry({
        opKind: "browserControlEnsure",
        error: agentErrorToControlError(response.error!, mutation.requestId),
        drainingRetries: 0,
        timeoutRetries: 0,
        neverSentRetries: 0,
        jitter: 0,
      }),
    ).toEqual({ action: "fail" });
  });

  test("an early refusal by the wake hook leaves the request to be sent again", async () => {
    const rpc = new NatsControlRpc(
      async () => ({
        supportsHeaders: true,
        async request() {
          throw Object.assign(new Error("no responders"), { code: "503" });
        },
      }),
      { recoveryMs: 10_000, onNoResponders: async () => false },
    );
    const startedAt = Date.now();
    const response = await rpc.request(subject, mutation, { timeoutMs: 1_000 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(response.error?.detail[RESPONDER_WAIT_EXHAUSTED_DETAIL_KEY]).toBeUndefined();
    expect(agentErrorToControlError(response.error!, mutation.requestId).neverSent).toBe(true);
  });

  test("a responder without reply recovery that vanishes is still retried", async () => {
    // The probe answers without the replay header, so the operation is sent once
    // directly; its no-responder did not wait out any recovery window.
    let probes = 0;
    const rpc = new NatsControlRpc(
      async () => ({
        supportsHeaders: true,
        async request() {
          if (probes++ === 0) return { data: result, headers: { get: () => "" } };
          throw Object.assign(new Error("no responders"), { code: "503" });
        },
      }),
      { recoveryMs: 10_000 },
    );
    const startedAt = Date.now();
    const response = await rpc.request(subject, mutation, { timeoutMs: 1_000 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(response.error?.detail[RESPONDER_WAIT_EXHAUSTED_DETAIL_KEY]).toBeUndefined();
    expect(
      decideSelfhostedRetry({
        opKind: "browserControlEnsure",
        error: agentErrorToControlError(response.error!, mutation.requestId),
        drainingRetries: 0,
        timeoutRetries: 0,
        neverSentRetries: 0,
        jitter: 0,
      }).action,
    ).toBe("retry");
  });

  test("a connection without reply recovery still retries a missing responder", async () => {
    const rpc = new NatsControlRpc(async () => ({
      async request() {
        throw Object.assign(new Error("no responders"), { code: "503" });
      },
    }));
    const response = await rpc.request(subject, mutation, { timeoutMs: 1 });
    expect(response.error?.detail[RESPONDER_WAIT_EXHAUSTED_DETAIL_KEY]).toBeUndefined();
    expect(
      decideSelfhostedRetry({
        opKind: "browserControlEnsure",
        error: agentErrorToControlError(response.error!, mutation.requestId),
        drainingRetries: 0,
        timeoutRetries: 0,
        neverSentRetries: 0,
        jitter: 0,
      }).action,
    ).toBe("retry");
  });

  test("only safe probes and journaled deliveries opt into exact-process recovery", async () => {
    for (const journaled of [false, true]) {
      const calls: Array<{ target: string; resendOn?: string }> = [];
      const rpc = new NatsControlRpc(async () => ({
        supportsHeaders: true,
        async request(target, _payload, options) {
          calls.push({ target, resendOn: options.resendOn });
          return journaled ? leaseReply() : { data: result, headers: { get: () => "1" } };
        },
      }));
      await rpc.request(subject, mutation, { timeoutMs: 60_000 });
      expect(calls[0]?.resendOn).toBe(subject.replace(/\.rpc$/, ".hello"));
      expect(calls[1]?.resendOn).toBe(journaled ? calls[0]?.resendOn : undefined);
    }
  });

  test("permanent failures underneath a transport resend stop without erasing uncertainty", async () => {
    let deliveries = 0;
    const recovery = new ControlReplyRecovery(100, 1);
    await expect(
      recovery.request(
        {
          supportsHeaders: true,
          async request(target) {
            if (target === subject) return leaseReply();
            deliveries += 1;
            throw Object.assign(timeout(), { cause: { code: "PERMISSIONS_VIOLATION" } });
          },
        },
        subject,
        new Uint8Array(),
        100,
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(deliveries).toBe(1);
  });
  for (const code of ["MAX_PAYLOAD_EXCEEDED", "PERMISSIONS_VIOLATION"]) {
    test(`a later ${code} refusal cannot rewrite an earlier unknown outcome`, async () => {
      let deliveries = 0;
      const recovery = new ControlReplyRecovery(100, 1);
      await expect(
        recovery.request(
          {
            supportsHeaders: true,
            async request(target: string) {
              if (target === subject) return leaseReply();
              deliveries += 1;
              if (deliveries === 1) throw timeout();
              throw Object.assign(new Error(code), { code });
            },
          },
          subject,
          new Uint8Array(),
          1,
        ),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(deliveries).toBe(2);
    });
  }

  test("a later no-responder cannot erase an earlier unknown mutation outcome", async () => {
    let deliveries = 0;
    const recovery = new ControlReplyRecovery(15, 1);
    const connection = {
      supportsHeaders: true,
      async request(target: string) {
        if (target === subject) return leaseReply();
        deliveries += 1;
        if (deliveries === 1) throw timeout();
        throw Object.assign(new Error("no responders"), { code: "503" });
      },
    };
    await expect(recovery.request(connection, subject, new Uint8Array(), 1)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(deliveries).toBeGreaterThan(1);
  });

  test("permission denial never becomes a retryable outage", async () => {
    let deliveries = 0;
    const recovery = new ControlReplyRecovery(15, 1);
    await expect(
      recovery.request(
        {
          supportsHeaders: true,
          async request(target: string) {
            if (target === subject) return leaseReply();
            deliveries += 1;
            throw Object.assign(new Error("denied"), { code: "PERMISSIONS_VIOLATION" });
          },
        },
        subject,
        new Uint8Array(),
        1,
      ),
    ).rejects.toMatchObject({ code: "PERMISSIONS_VIOLATION" });
    expect(deliveries).toBe(1);
  });

  test("concurrent calls recover safe probes but receive independent leases", async () => {
    let probes = 0;
    const deliveries: string[] = [];
    const recovery = new ControlReplyRecovery(100, 1);
    const connection = {
      supportsHeaders: true,
      async request(target: string) {
        if (target === subject) {
          probes += 1;
          if (probes === 1) throw Object.assign(new Error("disconnected"), { code: "503" });
          return leaseReply();
        }
        deliveries.push(target);
        return { data: result };
      },
    };
    await Promise.all([
      recovery.request(connection, subject, new Uint8Array(), 10),
      recovery.request(connection, subject, new Uint8Array(), 10),
    ]);
    expect(probes).toBe(2);
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries).size).toBe(2);
    expect(deliveries.every((target) => target.startsWith(`${subject}.replay.`))).toBe(true);
  });

  test("lost mutation reply is recovered with the same delivery, never a second execution", async () => {
    const deliveries: string[] = [];
    let executions = 0;
    const receipts = new Map<string, Uint8Array>();
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request(target: string, payload: Uint8Array) {
        const request = ControlRequest.decode(payload);
        if (request.op?.$case === "ping") {
          return leaseReply();
        }
        deliveries.push(target);
        const receipt = receipts.get(target);
        if (receipt) return { data: receipt };
        executions += 1;
        receipts.set(target, result);
        throw timeout(); // Side effect committed; old socket lost only the reply.
      },
    }));
    const response = await rpc.request(subject, mutation, { timeoutMs: 100 });
    expect(response.error).toBeUndefined();
    expect(response.requestId).toBe(mutation.requestId);
    expect(executions).toBe(1);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toStartWith(`${subject}.replay.`);
    expect(deliveries[1]).toBe(deliveries[0]);
  });

  test("an older responder never receives an ambiguous mutation twice", async () => {
    let executions = 0;
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request(_target: string, payload: Uint8Array) {
        if (ControlRequest.decode(payload).op?.$case === "ping") return { data: result };
        executions += 1;
        throw timeout();
      },
    }));
    expect((await rpc.request(subject, mutation, { timeoutMs: 100 })).error).toBeDefined();
    expect(executions).toBe(1);
  });

  test("a real tool failure is returned unchanged, not retried", async () => {
    const failure = ControlResponse.fromPartial({
      requestId: mutation.requestId,
      error: { code: 1, message: "synthetic tool failure", retryable: false },
    });
    let executions = 0;
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request(_target: string, payload: Uint8Array) {
        if (ControlRequest.decode(payload).op?.$case === "ping") {
          return leaseReply();
        }
        executions += 1;
        return { data: ControlResponse.encode(failure).finish() };
      },
    }));
    expect(await rpc.request(subject, mutation, { timeoutMs: 100 })).toEqual(failure);
    expect(executions).toBe(1);
  });
});

describe("a request whose agent link ends before the answer", () => {
  const linkLost = {
    data: new Uint8Array(0),
    headers: { get: (name: string) => (name === AGENT_LINK_LOST_HEADER ? "1" : "") },
  };

  test("is delivered again at once under the same delivery, not after its timeout", async () => {
    const deliveries: string[] = [];
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request(target: string, payload: Uint8Array) {
        if (ControlRequest.decode(payload).op?.$case === "ping") {
          return leaseReply();
        }
        deliveries.push(target);
        // The gateway that held the link answers for it as the link ends.
        if (deliveries.length === 1) return linkLost;
        return { data: result };
      },
    }));
    const startedAt = Date.now();
    const response = await rpc.request(subject, mutation, { timeoutMs: 30_000 });
    expect(response.error).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toBe(deliveries[0]);
  });

  test("is never sent to another connection instance: once replaced, its outcome is unknown", async () => {
    const deliveries: string[] = [];
    let replaced = false;
    const rpc = new NatsControlRpc(async () => ({
      supportsHeaders: true,
      async request(target: string, payload: Uint8Array) {
        if (ControlRequest.decode(payload).op?.$case === "ping") {
          return leaseReply();
        }
        deliveries.push(target);
        // The link ends, and the sandbox comes back as a new agent process.
        replaced = true;
        return linkLost;
      },
    }));
    const response = await rpc.request(subject, mutation, {
      timeoutMs: 30_000,
      connectionCurrent: async () => !replaced,
    });
    expect(response.error).toEqual(connectionReplacedAgentError(false));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.startsWith(`${subject}.`)).toBe(true);
  });

  test("a one-shot request ends as the ambiguous timeout it is, never as never-sent", async () => {
    const rpc = new NatsControlRpc(async () => ({
      async request() {
        return linkLost;
      },
    }));
    const response = await rpc.request(subject, mutation, { timeoutMs: 30_000 });
    expect(response.error?.code).toBe(timeoutAgentError().code);
    expect(response.error?.detail ?? {}).not.toHaveProperty("_never_sent");
  });

  test("an agent's own reply is never mistaken for the link's end", async () => {
    const recovery = new ControlReplyRecovery(100, 1);
    const reply = await recovery.request(
      {
        async request() {
          return { data: result, headers: { get: () => "1" } };
        },
      },
      subject,
      new Uint8Array(),
      10,
    );
    expect(reply.data).toEqual(result);
  });
});
