import { expect, test } from "bun:test";
import {
  readMcpOperation,
  type McpOperationReadRecord,
} from "../src/activities/mcp-operation-reader";

const operation: McpOperationReadRecord = {
  operationId: "11111111-1111-4111-8111-111111111111",
  sourceTurnId: "22222222-2222-4222-8222-222222222222",
  sourceCallId: "call-original",
  serverId: "synthetic",
  originalTool: "commit_value",
  observerTool: "observe_operation",
  argumentDigest: "a".repeat(64),
  destinationDigest: "b".repeat(64),
  authorityDigest: "c".repeat(64),
  originalOutcome: "outcome_unknown",
  originalResult: null,
  receipt: null,
};
const receipt = {
  version: 1 as const,
  operationRef: operation.operationId,
  fingerprint: {
    version: 1 as const,
    algorithm: "sha256" as const,
    value: operation.argumentDigest,
  },
  status: "completed" as const,
  receiptRevision: "commit-1",
  result: { content: [{ type: "text" as const, text: "late result" }] },
};

function fixture() {
  let record = structuredClone(operation);
  const effects = { observations: 0, settlements: 0, releases: 0 };
  const deps = {
    load: async () => structuredClone(record),
    claim: async () => "claim-1" as string | null,
    release: async () => {
      effects.releases++;
    },
    settle: async (_id: string, _claim: string, value: typeof receipt) => {
      effects.settlements++;
      record = { ...record, receipt: value };
      return structuredClone(record);
    },
    resolveObserver: async () => ({
      status: "ready" as const,
      authorize: async () => true,
      callObserver: async () => {
        effects.observations++;
        return { content: [], structuredContent: receipt };
      },
    }),
  };
  return { deps, effects, readRecord: () => record };
}

test("late receipt is stored separately and repeated reads do not call provider again", async () => {
  const f = fixture();
  const first = await readMcpOperation({ operationId: operation.operationId }, f.deps);
  const second = await readMcpOperation({ operationId: operation.operationId }, f.deps);
  expect(first).toEqual(second);
  expect(f.readRecord().originalOutcome).toBe("outcome_unknown");
  expect(f.effects.observations).toBe(1);
  expect(f.effects.settlements).toBe(1);
});

test("unauthorized or missing operation does not contact provider", async () => {
  const f = fixture();
  await expect(
    readMcpOperation({ operationId: operation.operationId }, { ...f.deps, load: async () => null }),
  ).rejects.toThrow("unavailable");
  expect(f.effects.observations).toBe(0);
});

test("lost receipt settlement acknowledgment is recovered without another provider call", async () => {
  const f = fixture();
  await expect(
    readMcpOperation(
      { operationId: operation.operationId },
      {
        ...f.deps,
        settle: async (...args: Parameters<typeof f.deps.settle>) => {
          await f.deps.settle(...args);
          throw new Error("synthetic lost acknowledgment");
        },
      },
    ),
  ).rejects.toThrow("lost acknowledgment");
  const recovered = await readMcpOperation({ operationId: operation.operationId }, f.deps);
  expect(recovered.observation).toEqual(receipt);
  expect(f.effects.observations).toBe(1);
  expect(f.effects.settlements).toBe(1);
  expect(f.readRecord().originalOutcome).toBe("outcome_unknown");
});

test("unknown provider receipt releases the read claim without settling an outcome", async () => {
  const f = fixture();
  const unknown = {
    version: receipt.version,
    operationRef: receipt.operationRef,
    fingerprint: receipt.fingerprint,
    status: "unknown",
  };
  const result = await readMcpOperation(
    { operationId: operation.operationId },
    {
      ...f.deps,
      resolveObserver: async () => ({
        status: "ready",
        authorize: async () => true,
        callObserver: async () => ({ content: [], structuredContent: unknown }),
      }),
    },
  );
  expect(result.observation).toEqual(unknown);
  expect(f.effects.releases).toBe(1);
  expect(f.effects.settlements).toBe(0);
  expect(f.readRecord().receipt).toBeNull();
});

test("unsupported provider is explicit and does not claim or replay a mutation", async () => {
  const f = fixture();
  const result = await readMcpOperation(
    { operationId: operation.operationId },
    {
      ...f.deps,
      resolveObserver: async () => ({ status: "unsupported" as const }),
    },
  );
  expect(result.observation).toEqual({ status: "unsupported" });
  expect(f.effects.observations).toBe(0);
  expect(f.effects.settlements).toBe(0);
});

test("revocation during observation withholds the receipt and releases the read claim", async () => {
  const f = fixture();
  const observer = await f.deps.resolveObserver();
  await expect(
    readMcpOperation(
      { operationId: operation.operationId },
      {
        ...f.deps,
        resolveObserver: async () => ({
          ...observer,
          authorize: async (phase: string) => phase === "before_request",
        }),
      },
    ),
  ).rejects.toThrow("authorized");
  expect(f.effects.settlements).toBe(0);
  expect(f.effects.releases).toBe(1);
});

test("busy observation claim does not report the remote mutation as pending", async () => {
  const f = fixture();
  const result = await readMcpOperation(
    { operationId: operation.operationId },
    { ...f.deps, claim: async () => null },
  );
  expect(result.observation).toEqual({ status: "observation_in_progress" });
  expect(f.effects.observations).toBe(0);
});

test("record disclosure omits private authority and destination digests", async () => {
  const f = fixture();
  const result = await readMcpOperation({ operationId: operation.operationId }, f.deps);
  expect(JSON.stringify(result)).not.toContain(operation.authorityDigest);
  expect(JSON.stringify(result)).not.toContain(operation.destinationDigest);
});

test("capture alone does not claim that the provider received the mutation", async () => {
  const f = fixture();
  const result = await readMcpOperation(
    { operationId: operation.operationId },
    {
      ...f.deps,
      load: async () => ({ ...operation, originalOutcome: "captured" as const }),
      resolveObserver: async () => ({ status: "unsupported" as const }),
    },
  );
  expect(result.invocationOutcome).toBe("outcome_unknown");
  expect(f.effects.observations).toBe(0);
});
