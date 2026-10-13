import { describe, expect, test } from "bun:test";
import { ControlRequest, ControlResponse } from "@opengeni/agent-proto";
import { NatsControlRpc } from "../src/sandbox/selfhosted/control-rpc";
import { ControlReplyRecovery } from "../src/sandbox/selfhosted/control-replay";

const subject = "agent.workspace.machine.connection.process.rpc";
const mutation = ControlRequest.fromPartial({
  requestId: "original-request",
  op: { $case: "fsRemove", fsRemove: { path: "/tmp/synthetic", recursive: false } },
});
const result = ControlResponse.encode({ requestId: mutation.requestId }).finish();
const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });

describe("control reply recovery", () => {
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
