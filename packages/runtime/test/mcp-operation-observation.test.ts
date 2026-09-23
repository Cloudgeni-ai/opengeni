import { expect, test } from "bun:test";
import {
  observeMcpOperation,
  assertMcpOperationObservationAuthority,
  runMcpOperationObservationWithAuthority,
} from "../src/mcp-operation-observation";

const binding = {
  operationId: "11111111-1111-4111-8111-111111111111",
  serverId: "synthetic-provider",
  originalTool: "commit_value",
  observerTool: "observe_operation",
  argumentDigest: "a".repeat(64),
} as const;

function receipt(status: "unknown" | "pending" | "completed" = "completed") {
  return {
    version: 1,
    operationRef: binding.operationId,
    fingerprint: { version: 1, algorithm: "sha256", value: binding.argumentDigest },
    status,
    ...(status === "pending" ? { evidenceRevision: "claimed-1" } : {}),
    ...(status === "completed"
      ? {
          receiptRevision: "committed-1",
          result: { content: [{ type: "text", text: "committed" }], isError: false },
        }
      : {}),
  };
}

function fixture(response: unknown = receipt()) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const phases: string[] = [];
  return {
    calls,
    phases,
    input: {
      binding,
      authorize: async (phase: "before_request" | "before_delivery") => {
        phases.push(phase);
        return true;
      },
      callObserver: async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return { content: [], structuredContent: response };
      },
    },
  };
}

test("observes the exact operation without calling the mutation", async () => {
  const f = fixture();
  const result = await observeMcpOperation(f.input);
  expect(result).toEqual(receipt());
  expect(f.calls).toEqual([
    {
      tool: binding.observerTool,
      args: {
        version: 1,
        operationRef: binding.operationId,
        originalTool: binding.originalTool,
        fingerprint: { version: 1, algorithm: "sha256", value: binding.argumentDigest },
      },
    },
  ]);
  expect(f.phases).toEqual(["before_request", "before_delivery"]);
});

test("absent receipt remains unknown and does not cause any replay", async () => {
  const f = fixture(receipt("unknown"));
  expect((await observeMcpOperation(f.input)).status).toBe("unknown");
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.tool).toBe(binding.observerTool);
});

test("positive pending evidence is required", async () => {
  const f = fixture({ ...receipt("unknown"), status: "pending" });
  await expect(observeMcpOperation(f.input)).rejects.toThrow();
});

test("terminal revision accepts the database byte boundary", async () => {
  const f = fixture({ ...receipt(), receiptRevision: "é".repeat(512) });
  expect((await observeMcpOperation(f.input)).status).toBe("completed");
});

test.each(["x".repeat(1025), "é".repeat(513)])(
  "terminal revision rejects values that cannot be retained by the ledger (%#)",
  async (receiptRevision) => {
    const f = fixture({ ...receipt(), receiptRevision });
    await expect(observeMcpOperation(f.input)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  },
);

for (const changed of [
  { operationRef: "22222222-2222-4222-8222-222222222222" },
  { fingerprint: { version: 1, algorithm: "sha256", value: "b".repeat(64) } },
]) {
  test(`rejects mismatched receipt ${Object.keys(changed)[0]}`, async () => {
    const f = fixture({ ...receipt(), ...changed });
    await expect(observeMcpOperation(f.input)).rejects.toThrow("identity");
  });
}

test("preserves a committed domain failure rather than treating it as transport failure", async () => {
  const response = {
    ...receipt(),
    result: { content: [{ type: "text", text: "domain rejected" }], isError: true },
  };
  const f = fixture(response);
  expect(await observeMcpOperation(f.input)).toEqual(response);
});

test("revocation before request prevents all provider calls", async () => {
  const f = fixture();
  await expect(observeMcpOperation({ ...f.input, authorize: async () => false })).rejects.toThrow(
    "authorized",
  );
  expect(f.calls).toHaveLength(0);
});

test("revocation during request prevents result delivery", async () => {
  const f = fixture();
  await expect(
    observeMcpOperation({
      ...f.input,
      authorize: async (phase) => phase === "before_request",
    }),
  ).rejects.toThrow("authorized");
  expect(f.calls).toHaveLength(1);
});

test("observation transport failure never retries or calls the mutation", async () => {
  const f = fixture();
  let attempts = 0;
  const timeout = new Error("observer timeout");
  await expect(
    observeMcpOperation({
      ...f.input,
      callObserver: async () => {
        attempts++;
        throw timeout;
      },
    }),
  ).rejects.toBe(timeout);
  expect(attempts).toBe(1);
});

test("outer MCP error cannot masquerade as a verified terminal receipt", async () => {
  const f = fixture();
  await expect(
    observeMcpOperation({
      ...f.input,
      callObserver: async () => ({ content: [], structuredContent: receipt(), isError: true }),
    }),
  ).rejects.toThrow();
});

test("rejects a binding that names the original mutation as its observer", async () => {
  const f = fixture();
  await expect(
    observeMcpOperation({
      ...f.input,
      binding: { ...binding, observerTool: binding.originalTool },
    }),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("physical observer request cannot switch credential authority after preflight", async () => {
  const expected = {
    serverId: binding.serverId,
    observerTool: binding.observerTool,
    destinationDigest: "a".repeat(64),
    authorityDigest: "b".repeat(64),
  };
  let requests = 0;
  await expect(
    runMcpOperationObservationWithAuthority(expected, async () => {
      assertMcpOperationObservationAuthority({
        serverId: expected.serverId,
        toolName: expected.observerTool,
        destinationDigest: expected.destinationDigest,
        authorityDigest: "c".repeat(64),
      });
      requests++;
    }),
  ).rejects.toThrow("authority changed");
  expect(requests).toBe(0);
});

test("physical observer cannot change into a mutation on the same connection", async () => {
  const expected = {
    serverId: binding.serverId,
    observerTool: binding.observerTool,
    destinationDigest: "a".repeat(64),
    authorityDigest: "b".repeat(64),
  };
  await expect(
    runMcpOperationObservationWithAuthority(expected, async () => {
      assertMcpOperationObservationAuthority({
        serverId: expected.serverId,
        toolName: binding.originalTool,
        destinationDigest: expected.destinationDigest,
        authorityDigest: expected.authorityDigest,
      });
    }),
  ).rejects.toThrow("authority changed");
});

test("ordinary calls outside an observation context retain existing behavior", () => {
  expect(() =>
    assertMcpOperationObservationAuthority({
      serverId: "ordinary",
      toolName: "ordinary",
      destinationDigest: "a".repeat(64),
    }),
  ).not.toThrow();
});
