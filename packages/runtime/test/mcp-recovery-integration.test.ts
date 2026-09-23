import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { testSettings } from "@opengeni/testing";
import { digestCanonicalJson } from "@opengeni/tool-gateway";
import { McpOperationRecoverySchema } from "@opengeni/config";
import { z } from "zod";
import {
  prepareAgentTools,
  runMcpOperationObservationWithAuthority,
  type PrepareToolsOptions,
} from "../src/index";
import type { CapturedMcpOperation, McpOperationPersistence } from "../src/mcp-operation-dispatch";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};
const authorityDigest = "a".repeat(64);
const policy = { mutate: { observerTool: "observe" } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  input: {
    configured?: boolean;
    persistence?: boolean;
    authorityDigest?: string | null;
    authorize?: boolean;
    brokered?: boolean;
    local?: boolean;
    timeoutMs?: number;
    capture?: McpOperationPersistence["capture"];
    effectGate?: Promise<void>;
  } = {},
) {
  const phases: string[] = [];
  const captures: CapturedMcpOperation[] = [];
  const settlements: Parameters<McpOperationPersistence["settleOriginal"]>[0][] = [];
  let effects = 0;
  let observations = 0;
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const server = new McpServer({ name: "recovery-integration", version: "1.0.0" });
      server.registerTool(
        "mutate",
        {
          inputSchema: { value: z.string() },
          annotations: { idempotentHint: true },
        },
        async ({ value }) => {
          phases.push("effect");
          effects++;
          await input.effectGate;
          return { content: [{ type: "text" as const, text: value }] };
        },
      );
      server.registerTool("observe", { inputSchema: {} }, async () => {
        observations++;
        return { content: [] };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transports.push(transport);
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  const url = `http://127.0.0.1:${provider.port}/mcp`;
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [
      {
        id: "recovery",
        url,
        cacheToolsList: false,
        timeoutMs: input.timeoutMs ?? 1000,
        ...(input.configured === false ? {} : { operationRecovery: policy }),
        ...(input.brokered === false
          ? {}
          : {
              connectionRef: {
                connectionId: "connection-recovery",
                providerDomain: "example.test",
              },
            }),
      },
    ],
  });
  const persistence: McpOperationPersistence = {
    capture: async (operation) => {
      phases.push("capture");
      captures.push(operation);
      return input.capture ? await input.capture(operation) : "created";
    },
    settleOriginal: async (settlement) => {
      settlements.push(settlement);
    },
  };
  const options: PrepareToolsOptions = {
    ...scope,
    ...(input.persistence === false ? {} : { mcpOperationPersistence: persistence }),
    workspaceToolGateway: {},
    ...(input.local
      ? {
          localMcpServers: [
            {
              id: "recovery",
              server: {
                name: "local-recovery",
                cacheToolsList: false,
                connect: async () => {},
                close: async () => {},
                invalidateToolsCache: async () => {},
                listTools: async () => [
                  {
                    name: "mutate",
                    inputSchema: {
                      type: "object" as const,
                      properties: { value: { type: "string" } },
                    },
                  },
                ],
                callTool: async () => {
                  effects++;
                  return [];
                },
              },
            },
          ],
        }
      : {}),
    connectorActionPolicy: {
      prepare: async () => ({ managed: false, decision: "unmanaged" }),
      begin: async () => ({ allowed: true, managed: false }),
      complete: async () => {},
    },
    resolveCredential: async (request) => {
      if (request.toolName) phases.push("credential");
      return {
        status: "ok",
        connectionId: "connection-recovery",
        headers: {},
        ...(input.authorityDigest === null
          ? {}
          : {
              operationAuthorityDigest: input.authorityDigest ?? authorityDigest,
            }),
        authorizeProviderRequest: async () => {
          if (request.toolName) phases.push("authorize");
          return !request.toolName || input.authorize !== false;
        },
      };
    },
  };
  let prepared: Awaited<ReturnType<typeof prepareAgentTools>>;
  try {
    prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "recovery" }], options);
  } catch (error) {
    provider.stop(true);
    throw error;
  }
  return {
    prepared,
    phases,
    captures,
    settlements,
    url,
    effects: () => effects,
    observations: () => observations,
    invoke: () =>
      prepared.attemptToolEnvironment!.callModel({
        modelName: "recovery__mutate",
        arguments: { value: "payload" },
        subjectId: "worker:mcp-model",
        sourceCallId: "call-original",
      }),
    async close() {
      await prepared.close();
      for (const transport of transports) await transport.close();
      provider.stop(true);
    },
  };
}

test("real transport captures authorized immutable identity before mutation", async () => {
  const f = await fixture();
  try {
    await f.invoke();
    expect(f.captures).toHaveLength(1);
    expect(f.captures[0]).toEqual({
      operationId: expect.any(String),
      sourceCallId: "call-original",
      serverId: "recovery",
      originalTool: "mutate",
      observerTool: "observe",
      authorityDigest,
      argumentDigest: digestCanonicalJson({ value: "payload" }),
      destinationDigest: digestCanonicalJson(new URL(f.url).toString()),
    });
    expect(f.phases).toEqual(["credential", "authorize", "capture", "effect"]);
    expect(f.effects()).toBe(1);
    expect(f.settlements).toEqual([
      {
        operationId: f.captures[0]!.operationId,
        outcome: "completed",
        result: expect.any(Object),
      },
    ]);
  } finally {
    await f.close();
  }
});

for (const failure of ["ack_lost", "existing", "missing_authority", "invalid_authority"] as const) {
  test(`${failure}: never dispatches a mutation`, async () => {
    const f = await fixture({
      ...(failure === "ack_lost"
        ? {
            capture: async () => {
              throw new Error("ack lost");
            },
          }
        : {}),
      ...(failure === "existing" ? { capture: async () => "existing" as const } : {}),
      ...(failure === "missing_authority" ? { authorityDigest: null } : {}),
      ...(failure === "invalid_authority" ? { authorityDigest: "invalid" } : {}),
    });
    try {
      await expect(f.invoke()).rejects.toBeInstanceOf(Error);
      expect(f.effects()).toBe(0);
      expect(f.settlements).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
}

test("a timed-out dispatched mutation retains its exact recovery locator without replay", async () => {
  const gate = deferred();
  const f = await fixture({ effectGate: gate.promise, timeoutMs: 100 });
  try {
    await expect(f.invoke()).rejects.toMatchObject({
      code: "mcp_operation_outcome_unknown",
      operationId: expect.any(String),
    });
    expect(f.effects()).toBe(1);
    expect(f.captures).toHaveLength(1);
    expect(f.settlements).toEqual([
      {
        operationId: f.captures[0]!.operationId,
        outcome: "outcome_unknown",
      },
    ]);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("timeout while capture is pending prevents late physical dispatch", async () => {
  const gate = deferred();
  const entered = deferred();
  const f = await fixture({
    timeoutMs: 100,
    capture: async () => {
      entered.resolve();
      await gate.promise;
      return "created";
    },
  });
  try {
    const invocation = f.invoke();
    const rejected = expect(invocation).rejects.toBeInstanceOf(Error);
    await entered.promise;
    await rejected;
    gate.resolve();
    await Bun.sleep(20);
    expect(f.effects()).toBe(0);
    expect(f.settlements).toHaveLength(0);
  } finally {
    gate.resolve();
    await f.close();
  }
});

for (const absent of ["configuration", "persistence"] as const) {
  test(`${absent} absent preserves ordinary execution despite tool annotations`, async () => {
    const f = await fixture({
      configured: absent !== "configuration",
      persistence: absent !== "persistence",
    });
    try {
      await f.invoke();
      expect(f.effects()).toBe(1);
      expect(f.captures).toHaveLength(0);
      expect(f.settlements).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
}

test("inline credentials cannot silently claim recoverable dispatch", async () => {
  const f = await fixture({ brokered: false });
  try {
    await expect(f.invoke()).rejects.toThrow(/recover/i);
    expect(f.effects()).toBe(0);
  } finally {
    await f.close();
  }
});

test("current-human gateway cannot silently claim attempt-owned recovery", async () => {
  const f = await fixture();
  try {
    await expect(
      f.prepared.toolGateway!.call({
        operationId: crypto.randomUUID(),
        catalogDigest: f.prepared.toolGatewayCatalog!.digest,
        identity: { serverId: "recovery", toolName: "mutate" },
        arguments: { value: "payload" },
        caller: { kind: "http", subjectId: "human" },
      }),
    ).rejects.toThrow(/recover/i);
    expect(f.effects()).toBe(0);
  } finally {
    await f.close();
  }
});

test("local adapters reject recovery opt-in before their executor", async () => {
  const f = await fixture({ local: true });
  try {
    await expect(f.invoke()).rejects.toThrow(/recover/i);
    expect(f.effects()).toBe(0);
    expect(f.captures).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("provider authorization denial precedes capture and effect", async () => {
  const f = await fixture({ authorize: false });
  try {
    await expect(f.invoke()).rejects.toBeInstanceOf(Error);
    expect(f.phases).toEqual(["credential", "authorize"]);
    expect(f.effects()).toBe(0);
    expect(f.captures).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("recovery configuration accepts only explicit distinct observer bindings", () => {
  expect(McpOperationRecoverySchema.parse(policy)).toEqual(policy);
  for (const invalid of [
    { mutate: { observerTool: "mutate" } },
    { mutate: { observerTool: "" } },
    { "": { observerTool: "observe" } },
    { mutate: { observerTool: "observe", idempotentHint: true } },
    { mutate: "observe" },
    { mutate: { observerTool: "observe tool" } },
  ])
    expect(() => McpOperationRecoverySchema.parse(invalid)).toThrow();
});

for (const actual of [authorityDigest, "b".repeat(64), null]) {
  test(`actual observer dispatch fences ${actual === authorityDigest ? "unchanged" : actual === null ? "missing" : "changed"} credential authority`, async () => {
    const credential: { authorityDigest: string | null } = { authorityDigest };
    const f = await fixture(credential);
    try {
      // The coordinator's earlier lookup accepted A. The actual broker must
      // resolve again and refuse B (or missing metadata), not merely trust A.
      credential.authorityDigest = actual;
      const result = await runMcpOperationObservationWithAuthority(
        {
          serverId: "recovery",
          observerTool: "observe",
          destinationDigest: digestCanonicalJson(new URL(f.url).toString()),
          authorityDigest,
        },
        async () =>
          await f.prepared.attemptToolEnvironment!.callModel({
            modelName: "recovery__observe",
            arguments: {},
            subjectId: "worker:mcp-model",
          }),
      );
      expect(f.observations()).toBe(actual === authorityDigest ? 1 : 0);
      expect(result.isError === true).toBe(actual !== authorityDigest);
      expect(f.effects()).toBe(0);
      expect(f.captures).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
}
