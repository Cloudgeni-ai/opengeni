import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

function grant(metadata: Record<string, unknown>): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "session:durable-wait-test",
    permissions: ["workspace:read"],
    metadata: { sessionId, ...metadata },
  };
}

function toolNames(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  ).sort();
}

async function invoke(server: unknown, name: string, args: Record<string, unknown>) {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (input: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`missing tool: ${name}`);
  return await tool.handler(args, {});
}

describe("durable wait MCP tools", () => {
  test("a session-scoped read-only grant sees the four built-in primitives", () => {
    const server = buildOpenGeniMcpServer(deps(), grant({}));
    expect(toolNames(server)).toEqual(
      expect.arrayContaining(["ask_user", "start_background_job", "wait_for_event", "wait_until"]),
    );
  });

  test("every primitive rejects missing signed attempt claims before DB access", async () => {
    const server = buildOpenGeniMcpServer(deps(), grant({}));
    await expect(
      invoke(server, "ask_user", {
        requestKey: "choice",
        questions: [{ id: "q", type: "text", prompt: "Choose" }],
      }),
    ).rejects.toThrow("caller_attempt_claims_missing");
    await expect(
      invoke(server, "wait_until", {
        requestKey: "later",
        until: "2026-07-12T00:00:00.000Z",
      }),
    ).rejects.toThrow("caller_attempt_claims_missing");
    await expect(
      invoke(server, "wait_for_event", {
        requestKey: "event",
        type: "build.finished",
        correlationKey: "build-42",
      }),
    ).rejects.toThrow("caller_attempt_claims_missing");
    await expect(
      invoke(server, "start_background_job", {
        requestKey: "build",
        command: "/bin/sh",
        args: ["-lc", "echo done"],
      }),
    ).rejects.toThrow("caller_attempt_claims_missing");
  });
});

function deps() {
  return {
    settings: { sandboxSelfhostedEnabled: false },
  } as never;
}
