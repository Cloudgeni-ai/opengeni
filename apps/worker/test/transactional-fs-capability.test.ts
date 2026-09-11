import { expect, test } from "bun:test";
import type { EnrollmentRecord } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { MockAgentResponder, SelfhostedSession } from "@opengeni/runtime/sandbox";
import { applyDiff } from "@openai/agents";
import { setSelfhostedApplyDiff } from "../../../packages/runtime/src/sandbox/selfhosted/session";
import { connectionBindingFor } from "../src/sandbox-routing";

test("live admission projection never retains a prior transactional write advertisement", () => {
  const services = { db: null as never, settings: testSettings() };
  const enrollment = {
    workspaceId: "workspace",
    connectionInstanceId: "runner-a",
    workspaceRoot: "/workspace",
    opStream: false,
    agentCapabilities: { transactionalFsWrite: true },
  } as unknown as EnrollmentRecord;
  expect(connectionBindingFor(services, enrollment)?.transactionalFsWriteSupported).toBe(true);
  enrollment.agentCapabilities = { transactionalFsWrite: false };
  expect(connectionBindingFor(services, enrollment)?.transactionalFsWriteSupported).toBe(false);
  enrollment.agentCapabilities = {};
  enrollment.connectionInstanceId = "runner-b";
  expect(connectionBindingFor(services, enrollment)).toMatchObject({
    connectionInstanceId: "runner-b",
    transactionalFsWriteSupported: false,
  });
  expect(connectionBindingFor(services, null)).toBeNull();
});

test("a real session does not start transactional writes after live capability revocation", async () => {
  setSelfhostedApplyDiff(applyDiff);
  const services = { db: null as never, settings: testSettings() };
  const enrollment = {
    workspaceId: "workspace",
    connectionInstanceId: "runner-a",
    workspaceRoot: "/workspace",
    opStream: false,
    agentCapabilities: { transactionalFsWrite: true },
  } as unknown as EnrollmentRecord;
  const agent = new MockAgentResponder();
  const operations: string[] = [];
  let admissions = 0;
  const session = new SelfhostedSession({
    workspaceId: "workspace",
    agentId: "agent",
    connectionInstanceId: "runner-a",
    workspaceRoot: "/workspace",
    epoch: 1,
    relay: { host: "relay.test", port: 443, tls: true },
    transactionalFsWriteSupported: true,
    controlRpc: {
      request: async (subject, request, options) => {
        operations.push(request.op?.$case ?? "missing");
        return agent.request(subject, request, options);
      },
    },
    resolveOperationAdmission: async () => {
      admissions++;
      return connectionBindingFor(services, enrollment);
    },
  });
  for (const capabilities of [{ transactionalFsWrite: false }, {}]) {
    enrollment.agentCapabilities = capabilities;
    await session.createEditor().createFile({
      path: `/workspace/large-${operations.length}.txt`,
      diff: "+" + "x".repeat(2 * 1024 * 1024),
    });
  }
  expect(admissions).toBeGreaterThanOrEqual(2);
  expect(operations.filter((op) => op === "fsWrite")).toHaveLength(2);
  expect(operations).not.toContain("opStart");
});
