import { expect, test } from "bun:test";
import type { AttemptToolResult } from "@opengeni/contracts";
import { executeCommandReadWithRefresh } from "../src/command-read-refresh";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { PrefixedMcpServer } from "../src/index";
import type { MCPServer } from "@openai/agents";
import { ControlRequest, ErrorCode } from "@opengeni/agent-proto";
import {
  SelfhostedControlError,
  NatsControlRpc,
  agentErrorToControlError,
} from "../src/sandbox/selfhosted/control-rpc";
import { OpStreamUnavailableError } from "../src/sandbox/selfhosted/op-transport";

const commandId = "6cfa95ae-29cc-48cb-9ab1-2613d15f1dde";
const receipt = (terminal = false, chunks: unknown[] = []): AttemptToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ commandId, terminal, chunks }) }],
});

const snapshot = (result: AttemptToolResult) =>
  JSON.parse((result.content[0] as { text: string }).text);

test("temporary live transport failure preserves retained output after API reauthorization", async () => {
  for (const error of [
    new OpStreamUnavailableError("private transport detail"),
    new SelfhostedControlError({
      message: "offline",
      code: ErrorCode.ERROR_CODE_AGENT_OFFLINE,
      reason: "agent_offline",
      retryable: false,
      agentOffline: true,
    }),
    new SelfhostedControlError({
      message: "timeout",
      code: ErrorCode.ERROR_CODE_TIMEOUT,
      reason: "agent_reconnecting",
      retryable: true,
    }),
    new SelfhostedControlError({
      message: "busy",
      code: ErrorCode.ERROR_CODE_DRAINING,
      reason: null,
      retryable: true,
      draining: true,
    }),
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
  ]) {
    const calls: string[] = [];
    const args = { commandId, cursor: "unchanged", maxOutputBytes: 64, waitSeconds: 45 };
    const result = await executeCommandReadWithRefresh({
      toolName: "command_wait",
      args,
      call: async (readArgs) => {
        calls.push("api");
        expect(readArgs).toEqual({ ...args, waitSeconds: 0 });
        const value = receipt(false, [{ stream: "stdout", chunk: "already durable" }]);
        return { ...value, structuredContent: snapshot(value) };
      },
      refresh: async () => {
        calls.push("refresh");
        throw error;
      },
    });
    expect(calls).toEqual(["api", "refresh", "api"]);
    expect(snapshot(result)).toMatchObject({
      terminal: false,
      chunks: [{ stream: "stdout", chunk: "already durable" }],
      freshness: { status: "refresh_unavailable", retryable: true },
      timedOut: false,
    });
    expect(result.structuredContent).toEqual(snapshot(result));
    expect(JSON.stringify(result)).not.toContain(error.message);
  }
});

test("refresh fallback never hides revoked authorization or a failed API read", async () => {
  let reads = 0;
  const denied: AttemptToolResult = { content: [{ type: "text", text: "denied" }], isError: true };
  const result = await executeCommandReadWithRefresh({
    toolName: "command_read",
    args: { commandId },
    call: async () => (++reads === 1 ? receipt(false, ["sensitive retained output"]) : denied),
    refresh: async () => {
      throw new OpStreamUnavailableError("offline");
    },
  });
  expect(result).toBe(denied);
  reads = 0;
  const failure = new Error("API authority unavailable");
  await expect(
    executeCommandReadWithRefresh({
      toolName: "command_read",
      args: { commandId },
      call: async () => {
        if (++reads > 1) throw failure;
        return receipt();
      },
      refresh: async () => {
        throw new OpStreamUnavailableError("offline");
      },
    }),
  ).rejects.toBe(failure);
});

test("terminal API result after refresh failure stays authoritative without stale warning", async () => {
  let reads = 0;
  const result = await executeCommandReadWithRefresh({
    toolName: "command_read",
    args: { commandId },
    call: async () => receipt(++reads > 1, ["tail"]),
    refresh: async () => {
      throw new OpStreamUnavailableError("offline");
    },
  });
  expect(snapshot(result).terminal).toBe(true);
  expect(snapshot(result).freshness).toBeUndefined();
});

test("integrity, consent, fencing, unsupported and unknown refresh errors still fail closed", async () => {
  for (const error of [
    new Error("provider temporarily offline"),
    new OpStreamUnavailableError("unsupported", "runner"),
    new SelfhostedControlError({
      message: "bad digest",
      code: ErrorCode.ERROR_CODE_PROTOCOL,
      reason: null,
      retryable: false,
    }),
    new SelfhostedControlError({
      message: "fenced",
      code: ErrorCode.ERROR_CODE_FENCED,
      reason: null,
      retryable: true,
      fenced: true,
    }),
    new SelfhostedControlError({
      message: "consent",
      code: ErrorCode.ERROR_CODE_CONSENT_REQUIRED,
      reason: "consent_required",
      retryable: false,
    }),
  ]) {
    let reads = 0;
    await expect(
      executeCommandReadWithRefresh({
        toolName: "command_read",
        args: { commandId },
        call: async () => {
          reads++;
          return receipt(false, ["retained"]);
        },
        refresh: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(reads).toBe(1);
  }
});

test("real RPC decoder corruption remains a protocol failure, never a stale-output fallback", async () => {
  const rpc = new NatsControlRpc(async () => ({
    request: async () => ({ data: new Uint8Array([255]) }),
  }));
  const response = await rpc.request(
    "test-control",
    ControlRequest.fromPartial({ requestId: "corrupt" }),
    { timeoutMs: 100 },
  );
  expect(response.error?.code).toBe(ErrorCode.ERROR_CODE_PROTOCOL);
  expect(response.error?.retryable).toBe(false);
  const fault = agentErrorToControlError(response.error!);
  expect(fault.agentOffline).toBe(false);
  expect(fault.neverSent).toBe(false);
  let reads = 0;
  await expect(
    executeCommandReadWithRefresh({
      toolName: "command_read",
      args: { commandId },
      call: async () => {
        reads++;
        return receipt(false, ["retained"]);
      },
      refresh: async () => {
        throw fault;
      },
    }),
  ).rejects.toBe(fault);
  expect(reads).toBe(1);
});

test("NATS authorization failures during dial or request never become refresh outages", async () => {
  for (const code of [
    "PERMISSIONS_VIOLATION",
    "AUTHORIZATION_VIOLATION",
    "AUTHENTICATION_EXPIRED",
    "BAD_AUTHENTICATION",
  ]) {
    for (const phase of ["connect", "request"]) {
      const denied = Object.assign(new Error("private subject and credentials"), { code });
      const rpc = new NatsControlRpc(async () => {
        if (phase === "connect") throw denied;
        return {
          request: async () => {
            throw denied;
          },
        };
      });
      let reads = 0;
      const operation = executeCommandReadWithRefresh({
        toolName: "command_read",
        args: { commandId },
        call: async () => {
          reads++;
          return receipt(false, ["retained"]);
        },
        refresh: async () => {
          await rpc.request("test-control", ControlRequest.fromPartial({ requestId: "denied" }), {
            timeoutMs: 100,
          });
          return true;
        },
      });
      await expect(operation).rejects.toMatchObject({
        name: "SelfhostedControlError",
        code: ErrorCode.ERROR_CODE_PROTOCOL,
        retryable: false,
        agentOffline: false,
        message: "Control transport authorization failed.",
        detail: { transport_error_code: code },
      });
      expect(reads).toBe(1);
    }
  }
});

test("model and Codemode share the first-party catalog refresh executor", async () => {
  let refreshes = 0;
  let apiReads = 0;
  const inner: MCPServer = {
    name: "first-party-test",
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    listTools: async () => [],
    callTool: async () => {
      apiReads++;
      return receipt(apiReads % 2 === 0).content;
    },
  };
  const server = new PrefixedMcpServer(
    inner,
    "opengeni",
    ["command_read"],
    false,
    undefined,
    "opengeni",
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    async () => {
      refreshes++;
      return true;
    },
  );
  const environment = createAttemptToolEnvironment({
    scope: {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
    },
    generation: 1,
    definitions: [
      {
        identity: { serverId: "opengeni", toolName: "command_read" },
        modelName: "opengeni__command_read",
        codemodePath: ["opengeni", "command_read"],
        source: "opengeni",
        approval: "none",
        inputSchema: {
          type: "object",
          properties: { commandId: { type: "string" } },
          required: ["commandId"],
          additionalProperties: false,
        },
        execute: async (args) => await server.executeCatalogTool("command_read", args),
      },
    ],
  });
  await environment.callModel({
    modelName: "opengeni__command_read",
    arguments: { commandId },
    subjectId: "model:test",
  });
  await environment.call({
    operationId: crypto.randomUUID(),
    catalogDigest: environment.catalog.digest,
    identity: { serverId: "opengeni", toolName: "command_read" },
    arguments: { commandId },
    caller: { kind: "codemode", subjectId: "agent:test" },
  });
  expect(refreshes).toBe(2);
  expect(apiReads).toBe(4);
});

test("owner refresh persists before the API terminal read; never refreshes before authorization", async () => {
  const calls: string[] = [];
  let terminal = false;
  const result = await executeCommandReadWithRefresh({
    toolName: "command_read",
    args: { commandId },
    call: async () => {
      calls.push("api");
      return receipt(terminal, terminal ? ["tail"] : []);
    },
    refresh: async (id) => {
      expect(id).toBe(commandId);
      calls.push("control");
      terminal = true;
      return true;
    },
  });
  expect(calls).toEqual(["api", "control", "api"]);
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
    terminal: true,
    chunks: ["tail"],
  });
});

test("command_wait refreshes throughout the bounded API wait", async () => {
  let refreshes = 0;
  const waits: unknown[] = [];
  await executeCommandReadWithRefresh({
    toolName: "command_wait",
    args: { commandId, waitSeconds: 5 },
    call: async (args) => {
      waits.push(args.waitSeconds);
      return receipt(refreshes === 3);
    },
    refresh: async () => {
      refreshes++;
      return true;
    },
  });
  expect(refreshes).toBe(3);
  expect(waits).toEqual([0, 0, 1, 0, 1, 0]);
});

test("API rejection and malformed receipts cannot trigger provider reads", async () => {
  for (const result of [
    { content: [], isError: true },
    { content: [] },
  ] satisfies AttemptToolResult[]) {
    let refreshes = 0;
    expect(
      await executeCommandReadWithRefresh({
        toolName: "command_read",
        args: { commandId },
        call: async () => result,
        refresh: async () => {
          refreshes++;
          return true;
        },
      }),
    ).toBe(result);
    expect(refreshes).toBe(0);
  }
});

test("non-owning runtime preserves API-only waiting", async () => {
  const waits: unknown[] = [];
  await executeCommandReadWithRefresh({
    toolName: "command_wait",
    args: { commandId, waitSeconds: 8 },
    call: async (args) => {
      waits.push(args.waitSeconds);
      return receipt();
    },
    refresh: async () => false,
  });
  expect(waits).toEqual([0, 8]);
});
