import { describe, expect, test } from "bun:test";
import {
  AttemptToolCatalog,
  AttemptToolResult,
  CanonicalToolDescriptor,
  CanonicalToolResult,
  type AttemptToolCatalogEntry,
} from "../src";

const ids = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
};

function entry(overrides: Partial<AttemptToolCatalogEntry> = {}): AttemptToolCatalogEntry {
  return {
    identity: { serverId: "slack", toolName: "search" },
    modelName: "slack__search",
    codemodePath: ["slack", "search"],
    description: "Search Slack",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    source: "mcp",
    approval: "policy",
    ...overrides,
  };
}

function catalog(entries: AttemptToolCatalogEntry[]) {
  return {
    version: 1 as const,
    ...ids,
    executionGeneration: 1,
    generation: 1,
    digest: "a".repeat(64),
    createdAt: "2026-08-09T12:00:00.000Z",
    entries,
  };
}

describe("AttemptToolCatalog", () => {
  test("retains opaque authority identity separately from model and Codemode projections", () => {
    expect(AttemptToolCatalog.parse(catalog([entry()])).entries[0]).toMatchObject({
      identity: { serverId: "slack", toolName: "search" },
      modelName: "slack__search",
      codemodePath: ["slack", "search"],
      inputSchema: { required: ["query"] },
    });
  });

  test("rejects collisions in every executable projection", () => {
    expect(
      AttemptToolCatalog.safeParse(
        catalog([
          entry(),
          entry({ modelName: "slack__search_2", codemodePath: ["slack", "search2"] }),
        ]),
      ).success,
    ).toBe(false);
    expect(
      AttemptToolCatalog.safeParse(
        catalog([
          entry(),
          entry({
            identity: { serverId: "other", toolName: "search" },
            codemodePath: ["other", "search"],
          }),
        ]),
      ).success,
    ).toBe(false);
    expect(
      AttemptToolCatalog.safeParse(
        catalog([
          entry(),
          entry({
            identity: { serverId: "other", toolName: "search" },
            modelName: "other__search",
          }),
        ]),
      ).success,
    ).toBe(false);
  });
});

describe("AttemptToolResult", () => {
  test("preserves all MCP content kinds and optional structured output", () => {
    const parsed = AttemptToolResult.parse({
      content: [
        { type: "text", text: "done" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
        { type: "resource_link", name: "report", uri: "file:///report.json" },
        {
          type: "resource",
          resource: { uri: "memory://result", mimeType: "application/json", text: "{}" },
        },
      ],
      structuredContent: { ok: true },
      isError: false,
    });
    expect(parsed.content.map((item) => item.type)).toEqual([
      "text",
      "image",
      "audio",
      "resource_link",
      "resource",
    ]);
    expect(parsed.structuredContent).toEqual({ ok: true });
  });
});

describe("caller-neutral canonical tool contracts", () => {
  test("retains canonical metadata without changing Attempt compatibility names", () => {
    const descriptor = CanonicalToolDescriptor.parse({
      identity: { serverId: "docs", toolName: "search" },
      modelName: "docs__search",
      programmaticPath: ["docs", "search"],
      description: "Search documents",
      inputSchema: { type: "object", additionalProperties: false },
      source: "docs",
      effect: "read",
      replaySafety: "safe",
      openWorld: false,
      approval: "none",
      supportedSurfaces: ["model", "codemode", "app"],
      requiredPermissions: ["artifacts:read"],
    });
    expect(descriptor.programmaticPath).toEqual(["docs", "search"]);
    expect(descriptor.supportedSurfaces).toContain("app");
    expect(CanonicalToolResult).toBe(AttemptToolResult);
  });

  test("defaults missing authoritative open-world metadata closed", () => {
    const descriptor = CanonicalToolDescriptor.parse({
      identity: { serverId: "docs", toolName: "search" },
      modelName: "docs__search",
      programmaticPath: ["docs", "search"],
      inputSchema: { type: "object" },
      source: "docs",
      effect: "read",
      replaySafety: "safe",
      approval: "none",
      supportedSurfaces: ["app"],
      requiredPermissions: [],
    });
    expect(descriptor.openWorld).toBe(true);
  });

  test("rejects duplicate caller surfaces and required permissions", () => {
    const descriptor = {
      identity: { serverId: "docs", toolName: "search" },
      modelName: "docs__search",
      programmaticPath: ["docs", "search"],
      inputSchema: { type: "object" },
      source: "docs",
      effect: "read",
      replaySafety: "safe",
      openWorld: false,
      approval: "none",
      supportedSurfaces: ["app", "app"],
      requiredPermissions: ["artifacts:read", "artifacts:read"],
    };
    expect(CanonicalToolDescriptor.safeParse(descriptor).success).toBe(false);
  });
});
