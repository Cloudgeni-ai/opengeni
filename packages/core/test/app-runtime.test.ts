import { describe, expect, test } from "bun:test";
import type { CanonicalToolDescriptor } from "@opengeni/contracts";
import {
  AppRuntimeCatalogDriftError,
  AppRuntimeToolUnavailableError,
  callAppRuntimeTool,
  projectAppRuntimeCatalog,
  type AppCurrentHumanAuthority,
  type AppRuntimePolicySnapshot,
  type AppRuntimeToolBinding,
} from "../src";

const appId = "11111111-1111-4111-8111-111111111111";
const releaseId = "22222222-2222-4222-8222-222222222222";
const policyId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const digest = "a".repeat(64);

const authority: AppCurrentHumanAuthority = {
  accountId: "55555555-5555-4555-8555-555555555555",
  workspaceId: "66666666-6666-4666-8666-666666666666",
  subjectId: "user:current",
  principalKind: "human_session",
  canonicalManagedHumanSession: true,
  canonicalLocalHumanSession: false,
  permissions: ["apps:read", "apps:run"],
  sourceSessionId: null,
  sourceTurnId: null,
  sourceAttemptId: null,
  sourceExecutionGeneration: null,
  managedActorEpoch: "7",
  managedSessionSetAuthorityHash: "b".repeat(64),
  currentHuman: true,
};

function descriptor(
  serverId: string,
  toolName: string,
  overrides: Partial<CanonicalToolDescriptor> = {},
): CanonicalToolDescriptor {
  return {
    identity: { serverId, toolName },
    modelName: `${serverId}__${toolName}`,
    programmaticPath: [serverId, toolName],
    description: `${serverId} ${toolName}`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    },
    source: "mcp",
    effect: "read",
    replaySafety: "safe",
    openWorld: false,
    approval: "none",
    supportedSurfaces: ["app"],
    requiredPermissions: ["apps:run"],
    ...overrides,
  };
}

function binding(tool: CanonicalToolDescriptor, calls: unknown[] = []): AppRuntimeToolBinding {
  return {
    descriptor: tool,
    invoke(argumentsValue, context) {
      calls.push({ argumentsValue, context });
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { value: 42 },
        isError: false,
      };
    },
  };
}

function policy(allowedTools: AppRuntimePolicySnapshot["allowedTools"]): AppRuntimePolicySnapshot {
  return {
    appId,
    releaseId,
    toolPolicyRevisionId: policyId,
    catalogDigest: digest,
    allowedTools,
  };
}

describe("Apps current-human canonical runtime", () => {
  test("projects only exact allowed canonical identities that pass every safe-read gate", async () => {
    const allowed = descriptor("status", "read");
    const write = descriptor("status", "update", { effect: "write" });
    const notAllowed = descriptor("incidents", "list");
    const result = await projectAppRuntimeCatalog({
      authority,
      policy: policy([allowed.identity, write.identity]),
      provider: {
        resolve: async () => ({
          catalogDigest: digest,
          bindings: [binding(notAllowed), binding(write), binding(allowed)],
        }),
      },
    });

    expect(result.tools.map((tool) => tool.identity)).toEqual([allowed.identity]);
    expect(result.catalogDigest).toBe(digest);
  });

  test("invokes by opaque identity and passes only current-human caller context", async () => {
    const calls: unknown[] = [];
    const tool = descriptor("status", "read");
    const result = await callAppRuntimeTool({
      authority,
      policy: policy([tool.identity]),
      request: {
        operationId,
        identity: tool.identity,
        input: { query: "healthy" },
        catalogDigest: digest,
      },
      provider: {
        resolve: async () => ({ catalogDigest: digest, bindings: [binding(tool, calls)] }),
      },
    });

    expect(result).toEqual({
      operationId,
      status: "succeeded",
      output: { value: 42 },
      error: null,
      replayed: false,
    });
    expect(calls).toEqual([
      {
        argumentsValue: { query: "healthy" },
        context: {
          operationId,
          caller: { authority, appId, releaseId },
          signal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  test("cannot substitute a display or programmatic name for authority identity", async () => {
    const tool = descriptor("status", "read", {
      modelName: "friendly_status",
      programmaticPath: ["friendly", "status"],
    });
    await expect(
      callAppRuntimeTool({
        authority,
        policy: policy([tool.identity]),
        request: {
          operationId,
          identity: { serverId: "friendly", toolName: "status" },
          input: { query: "healthy" },
          catalogDigest: digest,
        },
        provider: {
          resolve: async () => ({ catalogDigest: digest, bindings: [binding(tool)] }),
        },
      }),
    ).rejects.toBeInstanceOf(AppRuntimeToolUnavailableError);
  });

  test("fails closed on authoritative catalog drift before provider invocation", async () => {
    const tool = descriptor("status", "read");
    await expect(
      projectAppRuntimeCatalog({
        authority,
        policy: policy([tool.identity]),
        provider: {
          resolve: async () => ({ catalogDigest: "c".repeat(64), bindings: [binding(tool)] }),
        },
      }),
    ).rejects.toBeInstanceOf(AppRuntimeCatalogDriftError);
  });
});