import { expect, test } from "bun:test";
import {
  captureMcpOperationDispatch,
  runRecoverableMcpOperation,
  type McpOperationPersistence,
} from "../src/mcp-operation-dispatch";

const operation = {
  operationId: "11111111-1111-4111-8111-111111111111",
  sourceCallId: "call-original",
  serverId: "synthetic",
  originalTool: "commit_value",
  observerTool: "observe_operation",
  destinationDigest: "a".repeat(64),
  argumentDigest: "b".repeat(64),
};
const authorityDigest = "c".repeat(64);
const terminal = { content: [{ type: "text" as const, text: "done" }] };

function fixture() {
  const captures: unknown[] = [];
  const outcomes: unknown[] = [];
  let effects = 0;
  const persistence: McpOperationPersistence = {
    capture: async (input) => {
      captures.push(input);
      return "created";
    },
    settleOriginal: async (input) => {
      outcomes.push(input);
    },
  };
  const dispatch = async () => {
    await captureMcpOperationDispatch({
      operationId: operation.operationId,
      serverId: operation.serverId,
      toolName: operation.originalTool,
      destinationDigest: operation.destinationDigest,
      authorityDigest,
    });
    effects++;
    return terminal;
  };
  return { captures, outcomes, persistence, dispatch, effects: () => effects };
}

test("persists the exact authorized dispatch before its effect", async () => {
  const f = fixture();
  expect(await runRecoverableMcpOperation(operation, f.persistence, f.dispatch)).toEqual(terminal);
  expect(f.captures).toEqual([{ ...operation, authorityDigest }]);
  expect(f.outcomes).toEqual([
    { operationId: operation.operationId, outcome: "completed", result: terminal },
  ]);
  expect(f.effects()).toBe(1);
});

test("a lost capture acknowledgment prevents mutation dispatch", async () => {
  const f = fixture();
  const lostAck = new Error("capture acknowledgment lost");
  f.persistence.capture = async () => {
    throw lostAck;
  };
  await expect(runRecoverableMcpOperation(operation, f.persistence, f.dispatch)).rejects.toBe(
    lostAck,
  );
  expect(f.effects()).toBe(0);
  expect(f.outcomes).toHaveLength(0);
});

test("an existing dispatch identity never replays the mutation", async () => {
  const f = fixture();
  f.persistence.capture = async () => "existing";
  await expect(runRecoverableMcpOperation(operation, f.persistence, f.dispatch)).rejects.toThrow(
    "already",
  );
  expect(f.effects()).toBe(0);
});

test("post-dispatch timeout retains the original recovery handle", async () => {
  const f = fixture();
  await expect(
    runRecoverableMcpOperation(operation, f.persistence, async () => {
      await f.dispatch();
      throw new Error("caller timed out");
    }),
  ).rejects.toMatchObject({
    code: "mcp_operation_outcome_unknown",
    operationId: operation.operationId,
  });
  expect(f.effects()).toBe(1);
  expect(f.outcomes).toEqual([{ operationId: operation.operationId, outcome: "outcome_unknown" }]);
});

test("a mismatched physical destination is rejected before effect", async () => {
  const f = fixture();
  await expect(
    runRecoverableMcpOperation(operation, f.persistence, async () => {
      await captureMcpOperationDispatch({
        operationId: operation.operationId,
        serverId: operation.serverId,
        toolName: operation.originalTool,
        authorityDigest,
        destinationDigest: "d".repeat(64),
      });
      return terminal;
    }),
  ).rejects.toThrow("identity");
  expect(f.captures).toHaveLength(0);
});

test("a configured recoverable call cannot silently skip durable capture", async () => {
  const f = fixture();
  await expect(
    runRecoverableMcpOperation(operation, f.persistence, async () => terminal),
  ).rejects.toThrow("capture");
  expect(f.outcomes).toHaveLength(0);
});

test("settlement failure never causes another physical dispatch", async () => {
  const f = fixture();
  f.persistence.settleOriginal = async () => {
    throw new Error("database unavailable");
  };
  await expect(
    runRecoverableMcpOperation(operation, f.persistence, f.dispatch),
  ).rejects.toMatchObject({
    operationId: operation.operationId,
    code: "mcp_operation_outcome_unknown",
  });
  expect(f.effects()).toBe(1);
});

test("timeout during database capture prevents a late physical dispatch", async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capturing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.persistence.capture = async () => {
    entered();
    await gate;
    return "created";
  };
  let lateDispatch!: Promise<unknown>;
  await expect(
    runRecoverableMcpOperation(operation, f.persistence, async () => {
      lateDispatch = f.dispatch().catch((error: unknown) => error);
      await capturing;
      throw new Error("SDK timeout before capture acknowledged");
    }),
  ).rejects.toThrow("SDK timeout");
  release();
  expect(await lateDispatch).toBeInstanceOf(Error);
  expect(f.effects()).toBe(0);
  expect(f.outcomes).toHaveLength(0);
});

test("second physical dispatch in one invocation is never treated as safe replay", async () => {
  const f = fixture();
  await expect(
    runRecoverableMcpOperation(operation, f.persistence, async () => {
      await f.dispatch();
      return await f.dispatch();
    }),
  ).rejects.toMatchObject({ code: "mcp_operation_outcome_unknown" });
  expect(f.effects()).toBe(1);
  expect(f.captures).toHaveLength(1);
});

test("parallel invocation contexts retain distinct durable identities", async () => {
  const captured: string[] = [];
  const execute = async (operationId: string) => {
    const f = fixture();
    f.persistence.capture = async (value) => {
      captured.push(value.operationId);
      return "created";
    };
    return await runRecoverableMcpOperation(
      { ...operation, operationId },
      f.persistence,
      async () => {
        await Promise.resolve();
        await captureMcpOperationDispatch({
          operationId,
          serverId: operation.serverId,
          toolName: operation.originalTool,
          destinationDigest: operation.destinationDigest,
          authorityDigest,
        });
        return terminal;
      },
    );
  };
  const other = "22222222-2222-4222-8222-222222222222";
  await Promise.all([execute(operation.operationId), execute(other)]);
  expect(captured.sort()).toEqual([operation.operationId, other].sort());
});
