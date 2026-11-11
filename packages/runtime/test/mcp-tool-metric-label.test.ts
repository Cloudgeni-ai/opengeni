import { afterEach, describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import {
  MCP_TOOL_METRIC_EXTERNAL_LABEL,
  PrefixedMcpServer,
  configureRuntimeMetricsHooks,
  isMcpToolMetricLabel,
  mcpToolMetricLabel,
  type RuntimeMetricsHooks,
} from "../src/index";

type ToolCallObservation = Parameters<NonNullable<RuntimeMetricsHooks["onMcpToolCall"]>>[0];

function stubServer(name: string): MCPServer {
  return {
    name,
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async listTools() {
      return [];
    },
    async callTool() {
      return [{ type: "text" as const, text: "ok" }];
    },
    async callToolResult() {
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    },
    async invalidateToolsCache() {},
  } as MCPServer;
}

function prefixed(registryId: string, firstPartyCatalog: boolean): PrefixedMcpServer {
  return new PrefixedMcpServer(
    stubServer(registryId),
    registryId,
    undefined,
    false,
    undefined,
    registryId,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    firstPartyCatalog,
  );
}

afterEach(() => configureRuntimeMetricsHooks(null));

describe("MCP tool metric label", () => {
  test("keeps only first-party catalog names from a verified first-party server", () => {
    expect(mcpToolMetricLabel({ firstParty: true, toolName: "session_create" })).toBe(
      "session_create",
    );
    expect(mcpToolMetricLabel({ firstParty: true, toolName: "files_get_download_url" })).toBe(
      "files_get_download_url",
    );
    expect(mcpToolMetricLabel({ firstParty: true, toolName: "my_custom_tool" })).toBe(
      MCP_TOOL_METRIC_EXTERNAL_LABEL,
    );
    // A user server may reuse a first-party name; it must not borrow that label.
    expect(mcpToolMetricLabel({ firstParty: false, toolName: "session_create" })).toBe(
      MCP_TOOL_METRIC_EXTERNAL_LABEL,
    );
    expect(isMcpToolMetricLabel("session_create")).toBe(true);
    expect(isMcpToolMetricLabel(MCP_TOOL_METRIC_EXTERNAL_LABEL)).toBe(true);
    expect(isMcpToolMetricLabel("acme_internal_lookup")).toBe(false);
    expect(isMcpToolMetricLabel(undefined)).toBe(false);
  });

  test("physical tool calls report the bounded label", async () => {
    const observations: ToolCallObservation[] = [];
    configureRuntimeMetricsHooks({ onMcpToolCall: (input) => observations.push(input) });

    await prefixed("opengeni", true).executeCatalogTool("session_create", {});
    await prefixed("opengeni", true).executeCatalogTool("not_in_catalog", {});
    await prefixed("acme", false).executeCatalogTool("session_create", {});
    await prefixed("acme", false).executeCatalogTool("acme_internal_lookup", {});

    expect(observations.map(({ outcome, tool }) => ({ outcome, tool }))).toEqual([
      { outcome: "success", tool: "session_create" },
      { outcome: "success", tool: MCP_TOOL_METRIC_EXTERNAL_LABEL },
      { outcome: "success", tool: MCP_TOOL_METRIC_EXTERNAL_LABEL },
      { outcome: "success", tool: MCP_TOOL_METRIC_EXTERNAL_LABEL },
    ]);
  });
});
