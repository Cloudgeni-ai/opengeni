import { expect, test } from "bun:test";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import { testSettings } from "@opengeni/testing";
import { digestCanonicalJson } from "@opengeni/tool-gateway";
import { assertMcpOperationObservationAuthority } from "@opengeni/runtime";
import { createMcpOperationObserverResolver } from "../src/activities/mcp-operation-observer";
import type { McpOperationReadRecord } from "../src/activities/mcp-operation-reader";

const id = "11111111-1111-4111-8111-111111111111";
const url = "https://synthetic.invalid/mcp";
const digest = "a".repeat(64);
const record: McpOperationReadRecord = {
  operationId: id,
  sourceTurnId: id,
  sourceCallId: "call-original",
  serverId: "synthetic",
  originalTool: "write",
  observerTool: "lookup",
  argumentDigest: "b".repeat(64),
  destinationDigest: digestCanonicalJson(url),
  authorityDigest: digest,
  originalOutcome: "outcome_unknown",
  originalResult: null,
  receipt: null,
};

function fixture() {
  const settings = testSettings({
    mcpServers: [
      {
        id: "synthetic",
        url,
        connectionRef: { connectionId: id, providerDomain: "synthetic.invalid", kind: "oauth2" },
        operationRecovery: { write: { observerTool: "lookup" } },
      },
    ],
  });
  let actualDigest = digest;
  let requests = 0;
  let resolutions = 0;
  const environment = createAttemptToolEnvironment({
    scope: {
      accountId: id,
      workspaceId: id,
      sessionId: id,
      turnId: id,
      attemptId: id,
      executionGeneration: 1,
    },
    generation: 1,
    definitions: [
      {
        identity: { serverId: "synthetic", toolName: "lookup" },
        modelName: "synthetic__lookup",
        inputSchema: { type: "object", additionalProperties: true },
        source: "mcp",
        approval: "none",
        execute: async () => {
          assertMcpOperationObservationAuthority({
            serverId: "synthetic",
            toolName: "lookup",
            destinationDigest: digestCanonicalJson(url),
            authorityDigest: actualDigest,
          });
          requests++;
          return { content: [] };
        },
      },
    ],
  });
  const input = {
    settings,
    workspaceId: id,
    assertAttempt: async () => {},
    getEnvironment: async () => environment,
    resolveCredential: async () => {
      resolutions++;
      return {
        status: "ok" as const,
        headers: { Authorization: "synthetic-secret-never-persist" },
        connectionId: id,
        operationAuthorityDigest: actualDigest,
      };
    },
  };
  return {
    input,
    state: () => ({ requests, resolutions }),
    changeAuthority: () => {
      actualDigest = "c".repeat(64);
    },
  };
}

test("observer resolver uses exact selected gateway tool and current authority", async () => {
  const f = fixture();
  const observer = await createMcpOperationObserverResolver(f.input)(record);
  if (observer.status !== "ready") throw new Error("observer not ready");
  await observer.callObserver("lookup", {});
  expect(f.state().requests).toBe(1);
});

test("changed provider authority cannot retrieve original operation", async () => {
  const f = fixture();
  f.changeAuthority();
  expect(await createMcpOperationObserverResolver(f.input)(record)).toEqual({
    status: "auth_needed",
  });
  expect(f.state().requests).toBe(0);
});

test("changed configured destination is rejected before credential resolution", async () => {
  const f = fixture();
  f.input.settings.mcpServers[0]!.url = "https://other.invalid/mcp";
  expect(await createMcpOperationObserverResolver(f.input)(record)).toEqual({
    status: "binding_changed",
  });
  expect(f.state()).toEqual({ requests: 0, resolutions: 0 });
});

test("changed observer binding cannot select another tool", async () => {
  const f = fixture();
  f.input.settings.mcpServers[0]!.operationRecovery = { write: { observerTool: "other" } };
  expect(await createMcpOperationObserverResolver(f.input)(record)).toEqual({
    status: "binding_changed",
  });
  expect(f.state().requests).toBe(0);
});

test("missing exact current catalog cannot be bypassed by trusted configuration", async () => {
  const f = fixture();
  expect(
    await createMcpOperationObserverResolver({ ...f.input, getEnvironment: async () => null })(
      record,
    ),
  ).toEqual({ status: "unsupported" });
  expect(f.state().resolutions).toBe(0);
});

test("actual gateway request is fenced when authority changes after resolver precheck", async () => {
  const f = fixture();
  const observer = await createMcpOperationObserverResolver(f.input)(record);
  if (observer.status !== "ready") throw new Error("observer not ready");
  f.changeAuthority();
  await expect(observer.callObserver("lookup", {})).rejects.toThrow("authority changed");
  expect(f.state().requests).toBe(0);
});

test("inline credentials cannot acquire recovery authority from a matching URL", async () => {
  const f = fixture();
  delete f.input.settings.mcpServers[0]!.connectionRef;
  expect(await createMcpOperationObserverResolver(f.input)(record)).toEqual({
    status: "unsupported",
  });
});
