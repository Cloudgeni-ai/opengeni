import { describe, expect, test } from "bun:test";
import {
  CreateEventSourceRequest,
  CreateScheduledTaskRequest,
  SetSessionUsageLimitRequest,
} from "../src/index";

const generated = {
  name: "Managed check",
  schedule: { type: "manual" },
  runMode: "new_session_per_run",
  overlapPolicy: "skip",
};

describe("scheduled task chat settings and creator lock", () => {
  test("a generated-chat task takes session chat settings and a lock", () => {
    const parsed = CreateScheduledTaskRequest.parse({
      ...generated,
      creatorLocked: true,
      agentConfig: {
        prompt: "Check",
        mcpServers: [{ id: "product", url: "https://product.example/mcp" }],
        skills: [],
        memoryScope: "off",
        agentAccess: "session",
      },
    });
    expect(parsed).toMatchObject({
      creatorLocked: true,
      agentConfig: {
        mcpServers: [{ id: "product", url: "https://product.example/mcp" }],
        memoryScope: "off",
        agentAccess: "session",
      },
    });
  });

  test.each([
    ["a lock that is not a boolean", { creatorLocked: "yes" }],
    [
      "static server headers",
      {
        agentConfig: {
          prompt: "Check",
          mcpServers: [{ id: "product", url: "https://product.example/mcp", headers: { a: "b" } }],
        },
      },
    ],
    [
      "chat settings on an existing-chat task",
      {
        runMode: "existing_session",
        targetSessionId: "11111111-2222-4333-8444-555555555555",
        agentConfig: { prompt: "Check", memoryScope: "off" },
      },
    ],
  ])("rejects %s", (_label, override) => {
    expect(
      CreateScheduledTaskRequest.safeParse({
        ...generated,
        agentConfig: { prompt: "Check" },
        ...override,
      }).success,
    ).toBe(false);
  });
});

describe("usage limit daily window", () => {
  test("accepts a daily window in an IANA zone and null to clear it", () => {
    const base = { limitMicros: 25_000_000, expectedVersion: 0, operationId: "op-window" };
    expect(
      SetSessionUsageLimitRequest.parse({
        ...base,
        window: { period: "day", timeZone: "Europe/Oslo" },
      }).window,
    ).toEqual({ period: "day", timeZone: "Europe/Oslo" });
    expect(SetSessionUsageLimitRequest.parse({ ...base, window: null }).window).toBeNull();
    expect(
      SetSessionUsageLimitRequest.safeParse({
        ...base,
        window: { period: "day", timeZone: "Not/AZone" },
      }).success,
    ).toBe(false);
    expect(
      SetSessionUsageLimitRequest.safeParse({
        ...base,
        window: { period: "week", timeZone: "UTC" },
      }).success,
    ).toBe(false);
  });
});

describe("workspace MCP event source by URL", () => {
  test("takes an https url, never with a connection", () => {
    expect(
      CreateEventSourceRequest.parse({
        kind: "mcp",
        serverId: "product",
        url: "https://product.example/mcp",
      }),
    ).toMatchObject({ url: "https://product.example/mcp" });
    expect(
      CreateEventSourceRequest.safeParse({
        kind: "mcp",
        serverId: "product",
        url: "http://product.example/mcp",
      }).success,
    ).toBe(false);
    expect(
      CreateEventSourceRequest.safeParse({
        kind: "mcp",
        serverId: "product",
        url: "https://product.example/mcp",
        connectionId: "11111111-2222-4333-8444-555555555555",
      }).success,
    ).toBe(false);
  });
});
