import { describe, expect, test } from "bun:test";
import { ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import {
  connectionReplacedAgentError,
  NatsControlRpc,
  timeoutAgentError,
} from "../src/sandbox/selfhosted/control-rpc";
import {
  AGENT_LINK_LOST_HEADER,
  ControlReplyRecovery,
} from "../src/sandbox/selfhosted/control-replay";

const subject = "agent.workspace.machine.connection.process.rpc";
const mutation = ControlRequest.fromPartial({
  requestId: "original-request",
  op: { $case: "fsRemove", fsRemove: { path: "/tmp/synthetic", recursive: false } },
});
const result = ControlResponse.encode({ requestId: mutation.requestId }).finish();
const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });

describe("control reply recovery", () => {
  test("only safe probes and journaled deliveries opt into exact-process recovery", async () => {
    for (const journaled of [false, true]) {
      const calls: Array<{ target: string; resendOn?: string }> = [];
      const rpc = new NatsControlRpc(async () => ({
        supportsHeaders: true,
        async request(target, _payload, options) {
          calls.push({ target, resendOn: options.resendOn });
          return { data: result, headers: { get: () => (journaled ? "1" : "") } };
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
            if (target === subject) return { data: result, headers: { get: () => "1" } };
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
              if (target === subject) return { data: result, headers: { get: () => "1" } };
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
        if (target === subject) return { data: result, headers: { get: () => "1" } };
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
            if (target === subject) return { data: result, headers: { get: () => "1" } };
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

  test("new calls wait through probe reconnect and concurrent calls share negotiation", async () => {
    let probes = 0;
    const deliveries: string[] = [];
    const recovery = new ControlReplyRecovery(100, 1);
    const connection = {
      supportsHeaders: true,
      async request(target: string) {
        if (target === subject) {
          probes += 1;
          if (probes === 1) throw Object.assign(new Error("disconnected"), { code: "503" });
          return { data: result, headers: { get: () => "1" } };
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
          return { data: result, headers: { get: () => "1" } };
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
          return { data: result, headers: { get: () => "1" } };
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
  const replayHeaders = { get: (name: string) => (name === "Opengeni-Control-Replay" ? "1" : "") };
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
          return { data: result, headers: replayHeaders };
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
          return { data: result, headers: replayHeaders };
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
